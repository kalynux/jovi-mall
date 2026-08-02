import { EARNINGS_CONFIG } from '../config/earnings.config';
import { IOrder, IOrderItem } from '../../orders/order.model';
import { IShipment } from '../../shipments/shipment.model';
import { IAgencyPolicies } from '../../delivery/delivery-agency.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../agents/repositories/agent-contract.repository';
import { IContractFeeSplit } from '../../agents/models/agent-agency-membership.model';

/**
 * Why an agent's earning is unavailable, when it is.
 *
 * Both remaining reasons are configuration gaps rather than policy: without an
 * agency policy there is no delivery fee to divide, and without a live contract
 * there is no `fee_split` saying how to divide it.
 *
 * `'prepaid'` used to be the third — prepaid orders paid the agent nothing, so
 * quoting a figure would have promised money nobody pays. That is no longer
 * true: `EarningsSplitService.splitShipmentDelivery` pays the agent on an
 * online-paid delivery exactly as `splitCodCollection` does on a cash one, so
 * the quote is now answerable for every physical shipment.
 */
export type EarningUnavailableReason = 'no_contract' | 'no_agency_policy';

/**
 * What an agent can expect to earn for one shipment.
 *
 * ⚠️ An ESTIMATE, never a promise. The contract's `fee_split` is read live again
 * at split time, so an agency editing it between the offer and the delivery
 * silently changes what is actually paid. The delivery fee it is a share OF is
 * firmer than it was — a prepaid shipment carries `delivery_fee_snapshot` from
 * payment time and the split divides exactly that — but a COD shipment's fee is
 * still computed from live `policies.pricing` at collection. Hence
 * `estimated: true`; do not present it to an agent as a guaranteed amount.
 */
export interface AgentEarningQuote {
  /** The agent's cut, in minor currency units. Legitimately 0 — see the class docs. */
  amount: number;
  currency: string;
  estimated: true;
  /** The whole delivery fee this cut is carved out of, for transparency. */
  deliveryFee: number;
  basis: 'contract_percentage' | 'contract_flat';
}

export interface AgentEarningQuoteResult {
  earning: AgentEarningQuote | null;
  earningUnavailable: EarningUnavailableReason | null;
}

/** Absence helper — keeps the two mutually-exclusive fields consistent. */
function unavailable(reason: EarningUnavailableReason): AgentEarningQuoteResult {
  return { earning: null, earningUnavailable: reason };
}

/**
 * Apply a contract's `fee_split` to a delivery fee — THE agent-cut arithmetic,
 * pure and DB-free so both the single and batch paths share one definition
 * (and so it can be unit-tested without Mongo).
 *
 * Clamped to `[0, deliveryFee]`: an agent can never be owed more than the fee
 * their cut comes out of. `onOverflow` reports a contract that tried.
 *
 * Both `fee_split` amounts default to null on a fresh contract, so an
 * unconfigured split yields 0. That is the truthful answer, not an error.
 */
export function applyFeeSplit(
  split: IContractFeeSplit | null | undefined,
  deliveryFee: number,
  onOverflow?: (raw: number) => void
): number {
  if (deliveryFee <= 0) return 0;

  const raw =
    split?.model === 'flat'
      ? (split.agent_flat_fee ?? 0)
      : Math.floor((deliveryFee * (split?.agent_share_percent ?? 0)) / 100);

  if (raw > deliveryFee) onOverflow?.(raw);
  return Math.max(0, Math.min(raw, deliveryFee));
}

/** The wire-level name for a contract's split model. */
function basisOf(split: IContractFeeSplit | null | undefined): AgentEarningQuote['basis'] {
  return split?.model === 'flat' ? 'contract_flat' : 'contract_percentage';
}

/**
 * EarningsQuoteService — the delivery-fee and agent-cut arithmetic, and the
 * read-only "what will I earn?" quote built on top of it.
 *
 * These two computations were private to `EarningsSplitService`, reachable only
 * once COD cash had been collected. They are pure functions of
 * `(shipment.items, agency.policies.pricing, contract.fee_split)` — nothing that
 * depends on the cash actually moving — so they are equally valid at OFFER time,
 * which is exactly when an agent needs them to decide whether to accept.
 *
 * `EarningsSplitService` now delegates here rather than keeping its own copy:
 * the offer-time estimate and the delivery-time actual must be the same
 * arithmetic, and the only way to guarantee that is one definition.
 *
 * All amounts are integers in minor currency units.
 */
export class EarningsQuoteService {
  constructor(
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly contracts: AgentContractRepository = agentContractRepository
  ) {}

  /**
   * ONE shipment's delivery fee from its agency's `policies.pricing` — the
   * MINIMAL formula shared by the prepaid per-order split (summed per agency),
   * the COD per-collection split, and the agent's offer-time quote.
   */
  computeShipmentDeliveryFee(
    shipment: IShipment,
    policies: IAgencyPolicies | null,
    orderItemsById: Map<string, IOrderItem>,
    orderId: string
  ): number {
    if (!policies) {
      // Defensive fallback, not expected in practice: AgencyOnboardingStep
      // POLICY_SETUP (step 4) is a REQUIRED onboarding step for agencies
      // (core/constants/onboarding-steps.ts), and only fully-onboarded
      // (onboarding_step: 0) agencies are selectable by vendors
      // (DeliveryAgencyRepository.findAvailableForVendors). So an agency
      // reachable by a dispatched shipment should always have `policies`
      // set. Charge the safe fallback constant (0 by default) rather than
      // a fabricated number, and log loudly so a real occurrence gets
      // investigated.
      console.error(
        `[EarningsQuoteService] Agency ${shipment.agency_id.toString()} has no policies configured — ` +
          `falling back to EARNINGS_CONFIG.DELIVERY_FLAT_FEE for shipment ` +
          `${(shipment._id as any).toString()} (order ${orderId}).`
      );
      return EARNINGS_CONFIG.DELIVERY_FLAT_FEE;
    }

    let hasPickupBased = false;
    let hasStorageBased = false;
    for (const item of shipment.items) {
      const orderItem = orderItemsById.get(item.order_item_id.toString());
      const source = orderItem?.delivery?.pickup_location?.source;
      if (source === 'vendor_address') hasPickupBased = true;
      if (source === 'agency_storage') hasStorageBased = true;
      // else: no matching order item, or a legacy item with
      // pickup_location: null (predates this feature) — can't classify;
      // contributes no fee component.
    }

    let shipmentFee = 0;
    // A shipment mixing both fulfillment modes (each product
    // independently configured — see ShipmentService.getDetailForAgency)
    // is charged BOTH components: real distinct fulfillment work happens
    // for each class.
    if (hasPickupBased) {
      shipmentFee += policies.pricing.pickup_based.base_rate_first_kg;
      // TODO(earnings): additional_per_kg — deferred. Needs a weight
      // snapshot that doesn't exist on IOrderItem; weight only lives on
      // ProductVariant today. Add `+ additional_per_kg * extraKg` here
      // once order items snapshot a weight at checkout.
      // TODO(earnings): out_of_region_surcharge — deferred. No
      // region-matching concept (customer delivery region vs the vendor
      // pickup address / agency coverage_areas) exists anywhere yet.
    }
    if (hasStorageBased) {
      shipmentFee +=
        policies.pricing.storage_based.local_delivery_fee +
        policies.pricing.storage_based.pick_pack_fee_per_order;
      // TODO(earnings): out_of_region_delivery_fee — deferred, same
      // reason as pickup_based.out_of_region_surcharge above.
      // TODO(earnings): monthly_storage_fee_per_sku — intentionally
      // EXCLUDED from this per-order split. It's a recurring rent-style
      // charge (per SKU stored, per month), not tied to any single
      // order. Future work: bill it on its own recurring cadence
      // (separate job/module), not here.
    }

    // TODO(earnings): free_delivery — IOrderItem.delivery.free_delivery
    // is a per-item flag; this per-shipment computation doesn't consult
    // it, so a shipment carrying a free-delivery item is still charged
    // its flat component(s) in full. Revisit once fee calc needs
    // item-level granularity below the two shipment-level flat
    // components above.

    return shipmentFee;
  }

  /**
   * The agent's share of `deliveryFee` under their live contract with this
   * agency, clamped to the fee. Returns 0 when there is no live contract.
   *
   * Note this resolves the contract with `findLive`, which INCLUDES `pending`
   * contracts, whereas assignment gating uses `findActive`. That asymmetry is
   * pre-existing and deliberate to preserve here — the quote must report the
   * same number the split will actually pay, whatever that number is.
   */
  async computeAgentCut(agentId: string, agencyId: string, deliveryFee: number): Promise<number> {
    if (deliveryFee <= 0) return 0;

    const contract = await this.contracts.findLive(agentId, agencyId);
    if (!contract) {
      console.error(
        `[EarningsQuoteService] No live contract for agent ${agentId} at agency ${agencyId} — ` +
          `no agent cut taken; the full delivery fee stays with the agency.`
      );
      return 0;
    }

    return applyFeeSplit(contract.fee_split, deliveryFee, (raw) => {
      console.error(
        `[EarningsQuoteService] Contract ${contract._id.toString()} owes agent ${agentId} ` +
          `${raw} but the delivery fee is only ${deliveryFee}; clamping.`
      );
    });
  }

  /**
   * The delivery fee to quote a cut of: the snapshot the shipment was actually
   * charged at when one exists, else a live computation.
   *
   * Preferring the snapshot matters because it is precisely what the split will
   * divide (see `IShipment.delivery_fee_snapshot` and
   * `EarningsSplitService.splitShipmentDelivery`). A PREPAID shipment already
   * carries one by offer time — its order was split at payment — so the quote
   * is exact rather than merely indicative. A COD shipment gets its snapshot at
   * collection, i.e. after the delivery, so it necessarily falls back to the
   * live computation here.
   */
  private resolveDeliveryFee(
    shipment: IShipment,
    policies: IAgencyPolicies | null,
    orderItemsById: Map<string, IOrderItem>,
    orderId: string
  ): number {
    return (
      shipment.delivery_fee_snapshot ??
      this.computeShipmentDeliveryFee(shipment, policies, orderItemsById, orderId)
    );
  }

  /**
   * Quote what `agentId` would earn for `shipment` — safe to call before the
   * agent has accepted (nothing here reads `shipment.agent_id`).
   *
   * Answerable for COD and prepaid alike: both now pay the agent a cut of the
   * same delivery fee, just at different moments (`splitCodCollection` at the
   * cash handoff, `splitShipmentDelivery` at `agent_delivered`).
   *
   * A quote of `amount: 0` is a real answer, not an error — a contract whose
   * `fee_split` was never configured (the default is
   * `{ model: 'percentage', agent_share_percent: null }`) genuinely pays
   * nothing, and the agent is better served seeing that than seeing a blank.
   */
  async quoteForShipment(
    shipment: IShipment,
    order: Pick<IOrder, 'items' | 'payment_method' | 'currency'> & { _id: unknown },
    agentId: string
  ): Promise<AgentEarningQuoteResult> {
    const agencyId = shipment.agency_id.toString();
    const agency = await this.agencyRepo.findById(agencyId);
    const policies = agency?.policies ?? null;
    if (!policies) return unavailable('no_agency_policy');

    const contract = await this.contracts.findLive(agentId, agencyId);
    if (!contract) return unavailable('no_contract');

    const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
    const deliveryFee = this.resolveDeliveryFee(shipment, policies, orderItemsById, String(order._id));
    const amount = await this.computeAgentCut(agentId, agencyId, deliveryFee);

    return {
      earning: {
        amount,
        currency: contract.fee_split?.currency ?? order.currency ?? EARNINGS_CONFIG.DEFAULT_CURRENCY,
        estimated: true,
        deliveryFee,
        basis: basisOf(contract.fee_split),
      },
      earningUnavailable: null,
    };
  }

  /**
   * Batch variant for list/offer pages, keyed by shipment id.
   *
   * Resolves each distinct agency's policy and each (agent, agency) contract
   * ONCE rather than per row — an agent's page of 20 shipments is typically
   * one or two agencies, so this is ~2 extra queries instead of ~40.
   */
  async quoteForShipments(
    shipments: IShipment[],
    ordersById: Map<string, Pick<IOrder, 'items' | 'payment_method' | 'currency'> & { _id: unknown }>,
    agentId: string
  ): Promise<Map<string, AgentEarningQuoteResult>> {
    const results = new Map<string, AgentEarningQuoteResult>();
    if (shipments.length === 0) return results;

    const agencyIds = [...new Set(shipments.map((s) => s.agency_id.toString()))];
    const agencies = await this.agencyRepo.findByIds(agencyIds);
    const policyByAgency = new Map(agencies.map((a) => [(a._id as any).toString(), a.policies]));

    const contractByAgency = new Map(
      await Promise.all(
        agencyIds.map(
          async (agencyId) => [agencyId, await this.contracts.findLive(agentId, agencyId)] as const
        )
      )
    );

    for (const shipment of shipments) {
      const shipmentId = (shipment._id as any).toString();
      const order = ordersById.get(shipment.order_id.toString());

      // No order resolved → nothing to quote against. Reported as a missing
      // policy rather than guessed at; a quote must never be invented.
      if (!order) {
        results.set(shipmentId, unavailable('no_agency_policy'));
        continue;
      }

      const agencyId = shipment.agency_id.toString();
      const policies = policyByAgency.get(agencyId) ?? null;
      if (!policies) {
        results.set(shipmentId, unavailable('no_agency_policy'));
        continue;
      }

      const contract = contractByAgency.get(agencyId);
      if (!contract) {
        results.set(shipmentId, unavailable('no_contract'));
        continue;
      }

      const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
      const deliveryFee = this.resolveDeliveryFee(shipment, policies, orderItemsById, String(order._id));

      // Same arithmetic as computeAgentCut, but against the already-resolved
      // contract — re-fetching per row is what this batch path exists to avoid.
      const split = contract.fee_split;
      results.set(shipmentId, {
        earning: {
          amount: applyFeeSplit(split, deliveryFee),
          currency: split?.currency ?? order.currency ?? EARNINGS_CONFIG.DEFAULT_CURRENCY,
          estimated: true,
          deliveryFee,
          basis: basisOf(split),
        },
        earningUnavailable: null,
      });
    }

    return results;
  }
}

export const earningsQuoteService = new EarningsQuoteService();
