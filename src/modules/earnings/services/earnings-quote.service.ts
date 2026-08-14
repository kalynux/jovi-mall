import { EARNINGS_CONFIG } from '../config/earnings.config';
import { IOrder, IOrderItem } from '../../orders/order.model';
import { IShipment } from '../../shipments/shipment.model';
import { IAgencyPolicies, ICodHandlingFee } from '../../delivery/delivery-agency.model';
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

/** How a shipment's delivery run ended, for the purposes of dividing its fee. */
export type ShipmentDeliveryOutcome = 'delivered' | 'returned';

/**
 * What a shipment's delivery run actually earned, out of the fee reserved for it
 * at payment.
 *
 * A completed delivery earns the whole reserved fee. A shipment that came back
 * earns the agency's own return-to-origin rate instead — real work was done, but
 * not the work that was quoted — clamped to the reserved fee, because the split
 * can only divide money that was actually charged. Whatever is left over is
 * returned to the vendor by the caller, so an order's gross always adds back up.
 *
 * Lives HERE rather than in `EarningsSplitService` (where it was defined) so the
 * quote can reach it: a shipment already sitting at `returned` must be quoted at
 * the RTO rate, not the full fee. The import can only run this way round —
 * `EarningsSplitService` already delegates its agent-cut to this service, so
 * importing back out of it would close a cycle.
 */
export function resolveEarnedFee(
  outcome: ShipmentDeliveryOutcome,
  reservedFee: number,
  policies: IAgencyPolicies | null
): number {
  if (reservedFee <= 0) return 0;
  if (outcome === 'delivered') return reservedFee;
  const rtoFee = policies?.pricing?.additional_fees?.rto_fee ?? 0;
  return Math.max(0, Math.min(rtoFee, reservedFee));
}

/**
 * The agency's COD handling fee on one collection — a percentage of the cash
 * collected, or a flat charge per collection.
 *
 * Charged to the VENDOR alongside the delivery fee (see `splitCodCollection`),
 * and unlike the delivery fee it is never shared with the agent.
 *
 * Pure and DB-free so the agency's estimate and the actual split share one
 * definition — same reason `applyFeeSplit` is extracted.
 */
export function computeCodHandlingFee(
  config: ICodHandlingFee | null | undefined,
  collectedAmount: number
): number {
  if (!config || collectedAmount <= 0) return 0;
  return config.type === 'percentage'
    ? Math.floor((collectedAmount * config.value) / 100)
    : config.value;
}

/**
 * The AGENCY's share of one delivery: what is left of the earned fee after the
 * agent's cut, plus the whole COD handling fee.
 *
 * The handling fee stays whole with the agency deliberately — `fee_split` is
 * defined as a share "of the delivery fee", and the agency is the party carrying
 * the cash-accountability. `codHandlingFee` is 0 on a prepaid delivery.
 *
 * The counterpart to `applyFeeSplit`: between them they name both sides of the
 * fee, so the agency's offer-time estimate and the delivery-time allocation
 * cannot drift.
 */
export function computeAgencyCut(
  earnedFee: number,
  agentCut: number,
  codHandlingFee = 0
): number {
  return earnedFee - agentCut + codHandlingFee;
}

/**
 * Why an AGENCY's earning is unavailable, when it is.
 *
 * Deliberately shorter than the agent's list: a missing live contract is NOT a
 * reason here. `applyFeeSplit` resolves an absent contract to a cut of 0, which
 * means the agency keeps the entire fee — a real answer, and exactly what the
 * split will do.
 *
 * `'no_agent'` has no agent-side equivalent: an agent asking "what does this
 * pay?" is always the agent in question, whereas an agency's shipment routinely
 * has no agent bound yet (the offer is still out). Quoting one then would show a
 * number that shrinks the moment somebody accepts.
 */
export type AgencyEarningUnavailableReason = 'no_agent' | 'no_agency_policy';

/**
 * What an AGENCY can expect to keep from one shipment, once the agent they are
 * paying has been taken out.
 *
 * ⚠️ An ESTIMATE, on the same terms as `AgentEarningQuote` — the contract's
 * `fee_split` is read live again at split time, and a COD shipment's delivery fee
 * is recomputed from live `policies.pricing` at collection.
 *
 * Itemised rather than a bare total because every component moves independently:
 * the agency renegotiates `fee_split` with the agent, edits `policies.pricing`
 * itself, and only sees `codHandlingFee` at all on cash deliveries.
 */
export interface AgencyEarningQuote {
  /** What the agency keeps: `earnedFee - agentCut + codHandlingFee`. */
  amount: number;
  currency: string;
  estimated: true;
  /** The gross delivery fee, before anything is carved out of it. */
  deliveryFee: number;
  /**
   * What this run earns out of `deliveryFee` — the same figure unless the
   * shipment has already come back, in which case it is the agency's `rto_fee`.
   */
  earnedFee: number;
  /** The bound agent's share. Legitimately 0 — an unconfigured or absent contract pays nothing. */
  agentCut: number;
  /** The COD handling fee, kept whole by the agency. 0 on a prepaid shipment. */
  codHandlingFee: number;
  basis: 'contract_percentage' | 'contract_flat';
}

export interface AgencyEarningQuoteResult {
  agencyEarning: AgencyEarningQuote | null;
  agencyEarningUnavailable: AgencyEarningUnavailableReason | null;
}

/** Absence helper — the agency-side counterpart of `unavailable`. */
function agencyUnavailable(reason: AgencyEarningUnavailableReason): AgencyEarningQuoteResult {
  return { agencyEarning: null, agencyEarningUnavailable: reason };
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
/**
 * Which fulfilment modes a delivery covers — the only thing the fee formula reads.
 *
 * A delivery may be both: each product configures its own pickup independently, so one
 * shipment can carry a vendor-collected item and a warehoused one.
 */
export interface PickupMix {
  hasPickupBased: boolean;
  hasStorageBased: boolean;
}

/**
 * The delivery-fee formula itself — pure, and the ONLY definition of it.
 *
 * Extracted from `computeShipmentDeliveryFee` so that the **cart quote**, which runs before
 * any shipment exists, divides by exactly the same arithmetic the split will later charge.
 * Everything shipment-shaped (looking up order items, classifying their pickup source) stays
 * in the caller; what is left here takes a policy and a mix and returns a number.
 *
 * That split is the same rule the rest of this file follows and says so in its header: one
 * definition, so a quote cannot drift from a charge. Add a fee component **here**, never at
 * a call site.
 */
export function deliveryFeeForPickupMix(policies: IAgencyPolicies, mix: PickupMix): number {
  let fee = 0;

  // A delivery mixing both fulfilment modes is charged BOTH components: real distinct
  // fulfilment work happens for each class.
  if (mix.hasPickupBased) {
    fee += policies.pricing.pickup_based.base_rate_first_kg;
    // TODO(earnings): additional_per_kg — deferred. Needs a weight snapshot that doesn't
    // exist on IOrderItem; weight only lives on ProductVariant today.
    // TODO(earnings): out_of_region_surcharge — deferred. No region-matching concept
    // (customer delivery region vs the vendor pickup address / agency coverage_areas)
    // exists anywhere yet.
  }
  if (mix.hasStorageBased) {
    fee +=
      policies.pricing.storage_based.local_delivery_fee +
      policies.pricing.storage_based.pick_pack_fee_per_order;
    // TODO(earnings): out_of_region_delivery_fee — deferred, same reason as above.
    // TODO(earnings): monthly_storage_fee_per_sku — intentionally EXCLUDED from any
    // per-order split. It is a recurring rent-style charge (per SKU stored, per month),
    // not tied to any single order.
  }

  // TODO(earnings): free_delivery — IOrderItem.delivery.free_delivery is a per-item flag;
  // this shipment-level computation doesn't consult it, so a delivery carrying a
  // free-delivery item is still charged its flat component(s) in full. Revisit once fee
  // calc needs item-level granularity below the two flat components above.

  return fee;
}

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

    // Classify this shipment's lines, then hand the mix to the shared formula.
    // The classification is shipment-shaped and stays here; the arithmetic is not
    // and lives in `deliveryFeeForPickupMix`, so the cart quote divides by the same
    // definition before any shipment exists.
    const mix: PickupMix = { hasPickupBased: false, hasStorageBased: false };
    for (const item of shipment.items) {
      const orderItem = orderItemsById.get(item.order_item_id.toString());
      const source = orderItem?.delivery?.pickup_location?.source;
      if (source === 'vendor_address') mix.hasPickupBased = true;
      if (source === 'agency_storage') mix.hasStorageBased = true;
      // else: no matching order item, or a legacy item with
      // pickup_location: null (predates this feature) — can't classify;
      // contributes no fee component.
    }

    return deliveryFeeForPickupMix(policies, mix);
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

  // ─── Agency side ────────────────────────────────────────────────────────────

  /**
   * The arithmetic behind an agency quote, with every lookup already done —
   * shared by the single and batch paths so they cannot diverge (the same reason
   * `applyFeeSplit` exists).
   *
   * `contract` may be null: `applyFeeSplit` then yields a cut of 0 and the agency
   * keeps the whole fee, which is precisely what `computeAgentCut` does at split
   * time. That is a real answer, not an error — see `AgencyEarningUnavailableReason`.
   */
  private buildAgencyQuote(
    shipment: IShipment,
    order: Pick<IOrder, 'items' | 'payment_method' | 'currency'> & { _id: unknown },
    policies: IAgencyPolicies,
    contract: { fee_split: IContractFeeSplit } | null,
    codGross: number
  ): AgencyEarningQuoteResult {
    const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
    const deliveryFee = this.resolveDeliveryFee(shipment, policies, orderItemsById, String(order._id));

    // A shipment that has already come back earns the RTO rate, not the full
    // fee — mirrors the outcome `ShipmentService` passes to
    // `splitShipmentDelivery`. Everything else is quoted as if it will succeed,
    // which is the question the agency is asking.
    const outcome: ShipmentDeliveryOutcome = shipment.status === 'returned' ? 'returned' : 'delivered';
    const earnedFee = resolveEarnedFee(outcome, deliveryFee, policies);

    const agentCut = applyFeeSplit(contract?.fee_split, earnedFee);
    const codHandlingFee =
      order.payment_method === 'cash_on_delivery'
        ? computeCodHandlingFee(policies.pricing?.additional_fees?.cod_handling_fee, codGross)
        : 0;

    return {
      agencyEarning: {
        amount: computeAgencyCut(earnedFee, agentCut, codHandlingFee),
        currency: contract?.fee_split?.currency ?? order.currency ?? EARNINGS_CONFIG.DEFAULT_CURRENCY,
        estimated: true,
        deliveryFee,
        earnedFee,
        agentCut,
        codHandlingFee,
        basis: basisOf(contract?.fee_split),
      },
      agencyEarningUnavailable: null,
    };
  }

  /**
   * Quote what the AGENCY keeps for `shipment`, after the agent's cut is taken
   * out — the agency's counterpart to `quoteForShipment`.
   *
   * Requires a bound agent (`shipment.agent_id`): without one there is no
   * `fee_split` to subtract, and quoting the gross fee would show a number that
   * drops the moment somebody accepts the offer.
   *
   * `codGross` is the cash this shipment collects, needed only for a percentage
   * `cod_handling_fee`. It is passed IN rather than computed here on purpose:
   * `CashCollectionService.computeExpectedAmount` owns that arithmetic, and the
   * cod module already calls `EarningsSplitService` — importing it back would
   * close a cycle.
   */
  async quoteAgencyForShipment(
    shipment: IShipment,
    order: Pick<IOrder, 'items' | 'payment_method' | 'currency'> & { _id: unknown },
    codGross = 0
  ): Promise<AgencyEarningQuoteResult> {
    const agentId = shipment.agent_id?.toString();
    if (!agentId) return agencyUnavailable('no_agent');

    const agencyId = shipment.agency_id.toString();
    const agency = await this.agencyRepo.findById(agencyId);
    const policies = agency?.policies ?? null;
    if (!policies) return agencyUnavailable('no_agency_policy');

    const contract = await this.contracts.findLive(agentId, agencyId);
    return this.buildAgencyQuote(shipment, order, policies, contract, codGross);
  }

  /**
   * Batch variant for the agency's shipment list, keyed by shipment id.
   *
   * The mirror image of `quoteForShipments`: that one is one agent across N
   * agencies, so it resolves a contract per agency; a page of an agency's
   * shipments is one agency across N agents, so it resolves the policy once and
   * a contract per distinct bound agent.
   */
  async quoteAgencyForShipments(
    shipments: IShipment[],
    ordersById: Map<string, Pick<IOrder, 'items' | 'payment_method' | 'currency'> & { _id: unknown }>,
    codGrossByShipment: Map<string, number> = new Map()
  ): Promise<Map<string, AgencyEarningQuoteResult>> {
    const results = new Map<string, AgencyEarningQuoteResult>();
    if (shipments.length === 0) return results;

    const agencyIds = [...new Set(shipments.map((s) => s.agency_id.toString()))];
    const agencies = await this.agencyRepo.findByIds(agencyIds);
    const policyByAgency = new Map(agencies.map((a) => [(a._id as any).toString(), a.policies]));

    // One contract per (bound agent, agency) pair actually present on the page.
    const pairs = [
      ...new Set(
        shipments
          .filter((s) => s.agent_id)
          .map((s) => `${s.agent_id!.toString()}:${s.agency_id.toString()}`)
      ),
    ];
    const contractByPair = new Map(
      await Promise.all(
        pairs.map(async (pair) => {
          const [agentId, agencyId] = pair.split(':');
          return [pair, await this.contracts.findLive(agentId, agencyId)] as const;
        })
      )
    );

    for (const shipment of shipments) {
      const shipmentId = (shipment._id as any).toString();
      const agentId = shipment.agent_id?.toString();
      if (!agentId) {
        results.set(shipmentId, agencyUnavailable('no_agent'));
        continue;
      }

      const order = ordersById.get(shipment.order_id.toString());
      const agencyId = shipment.agency_id.toString();
      const policies = policyByAgency.get(agencyId) ?? null;

      // No order resolved → nothing to quote against. Reported as a missing
      // policy rather than guessed at; a quote must never be invented.
      if (!order || !policies) {
        results.set(shipmentId, agencyUnavailable('no_agency_policy'));
        continue;
      }

      results.set(
        shipmentId,
        this.buildAgencyQuote(
          shipment,
          order,
          policies,
          contractByPair.get(`${agentId}:${agencyId}`) ?? null,
          codGrossByShipment.get(shipmentId) ?? 0
        )
      );
    }

    return results;
  }
}

export const earningsQuoteService = new EarningsQuoteService();
