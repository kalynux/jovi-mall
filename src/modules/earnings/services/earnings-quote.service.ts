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
import { EarningsAllocationModel } from '../models/earnings-allocation.model';
import {
  computeShipmentFee,
  isOutOfRegion,
  PickupMix,
  resolveItemWeightGrams,
  shipmentWeightGrams,
} from '../domain/delivery-pricing';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { paysDeliveryFeeInCash } from '../../orders/domain/delivery-payer';

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
  /**
   * `false` once the delivery has been SPLIT: `amount` is then the allocation actually
   * written, not a quote (2026-09-27 — before that a paid delivery went on showing a live
   * estimate that could disagree with what the agent was paid). See `overlayAgentActual`.
   */
  estimated: boolean;
  /** Present only when `estimated` is false: where the real money is. */
  allocationStatus?: 'held' | 'released' | 'reversed';
  /** The whole delivery fee this cut is carved out of, for transparency. */
  deliveryFee: number;
  basis: EarningBasis;
  /**
   * Present (non-null) only when `basis` is 'contract_salary': the monthly salary the
   * agency pays OFF-platform, so the agent app can explain why `amount` is 0. Never
   * paid, tracked or scheduled by the platform. Always set (null or an object) by
   * this service; optional in the type only for hand-built literals.
   */
  salary?: ContractSalaryInfo | null;
}

/** The wire-level name for a contract's pay model. */
export type EarningBasis = 'contract_percentage' | 'contract_flat' | 'contract_salary';

/** The agreed monthly salary, echoed on a quote under the 'monthly_salary' model. */
export interface ContractSalaryInfo {
  /** Minor units per month. */
  monthlyAmount: number;
  currency: string;
  /** Always 'agency_off_platform' — a literal so clients cannot mistake it for a platform payout. */
  paidBy: 'agency_off_platform';
}

export interface AgentEarningQuoteResult {
  earning: AgentEarningQuote | null;
  earningUnavailable: EarningUnavailableReason | null;
}

/** The drop-off region of an order-like value, for the formula's live path (unknown ⇒ null). */
function regionOf(order: unknown): string | null {
  return (order as { delivery_address?: { components?: { region?: string | null } | null } | null })
    ?.delivery_address?.components?.region ?? null;
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
 *
 * `monthly_salary` yields 0 BY DESIGN: the agency pays the agent a salary
 * off-platform, so the platform pays no per-delivery cut and the agency keeps
 * the whole fee (`computeAgencyCut`). `persist` skips zero-value rows, so no
 * agent allocation is written for such a delivery.
 */
export function applyFeeSplit(
  split: IContractFeeSplit | null | undefined,
  deliveryFee: number,
  onOverflow?: (raw: number) => void
): number {
  if (deliveryFee <= 0) return 0;
  if (split?.model === 'monthly_salary') return 0;

  const raw =
    split?.model === 'flat'
      ? (split.agent_flat_fee ?? 0)
      : Math.floor((deliveryFee * (split?.agent_share_percent ?? 0)) / 100);

  if (raw > deliveryFee) onOverflow?.(raw);
  return Math.max(0, Math.min(raw, deliveryFee));
}

/** The wire-level name for a contract's split model. */
export function basisOf(split: IContractFeeSplit | null | undefined): EarningBasis {
  if (split?.model === 'monthly_salary') return 'contract_salary';
  return split?.model === 'flat' ? 'contract_flat' : 'contract_percentage';
}

/** The salary echo for a quote — null unless the contract is on the salary model. */
export function salaryOf(split: IContractFeeSplit | null | undefined): ContractSalaryInfo | null {
  if (split?.model !== 'monthly_salary') return null;
  return {
    monthlyAmount: split.agent_monthly_salary ?? 0,
    currency: split.currency ?? EARNINGS_CONFIG.DEFAULT_CURRENCY,
    paidBy: 'agency_off_platform',
  };
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
  /** `false` once split — every figure is then read from the allocations. See `overlayAgencyActual`. */
  estimated: boolean;
  allocationStatus?: 'held' | 'released' | 'reversed';
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
  /** 'contract_salary' ⇒ `agentCut` is 0 and the agency keeps the whole earned fee. */
  basis: EarningBasis;
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
 * Which fulfilment modes a delivery covers — declared beside the formula in
 * `../domain/delivery-pricing.ts` and re-exported here so existing importers keep compiling.
 */
export type { PickupMix } from '../domain/delivery-pricing';

/**
 * The delivery fee for a pickup mix at ONE kilogram, in-region — a thin wrapper over
 * `computeShipmentFee` (`earnings/domain/delivery-pricing.ts`, ADR-A11), which is the only
 * definition of the formula (weight, region, the agency's `max_fee_per_shipment` ceiling).
 *
 * Kept so callers that do not yet know a shipment's weight or regions price it exactly as
 * before (base rate / local storage fees), plus the ceiling. Callers that do know them call
 * `computeShipmentFee` directly. Add a fee component THERE, never here or at a call site.
 */
export function deliveryFeeForPickupMix(policies: IAgencyPolicies, mix: PickupMix): number {
  return computeShipmentFee(policies, { mix, totalWeightGrams: 0, outOfRegion: false }).fee;
}

/**
 * The vendor-approved per-shipment fee, or null when none was approved
 * (`shipment.delivery_fee_override`, written only by `DeliveryFeeProposalService.approve`).
 * Pure, so the suites can pin that an override outranks the formula.
 */
export function approvedDeliveryFeeOf(
  shipment: Pick<IShipment, 'delivery_fee_override'>
): number | null {
  const amount = shipment.delivery_fee_override?.amount;
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * A COD shipment that came back earns NOTHING, for anybody.
 *
 * `splitShipmentDelivery` returns early for COD orders, and the shipment's cash collection is
 * cancelled on return — so no split ever runs: no `rto_fee`, no agent cut, no handling fee.
 * The quotes used to show the RTO fee plus a COD fee computed from the cancelled collection's
 * `expected_amount`: money promised that nobody pays (audit 2026-09-27).
 */
export function isReturnedCod(
  order: Pick<IOrder, 'payment_method'> & Partial<Pick<IOrder, 'delivery_fee_payment' | 'delivery_payer'>>,
  shipment: Pick<IShipment, 'status'> & Partial<Pick<IShipment, 'delivery_payer' | 'customer_delivery_fee'>>
): boolean {
  if (shipment.status !== 'returned') return false;
  // A cash-for-delivery shipment (W-F) that came back collected no fee either: same answer.
  return order.payment_method === 'cash_on_delivery' || paysDeliveryFeeInCash(order, shipment);
}

/** The fee a run earns, as the split will compute it — outcome-aware and COD-return-aware. */
export function earnedFeeFor(
  order: Pick<IOrder, 'payment_method'> & Partial<Pick<IOrder, 'delivery_fee_payment' | 'delivery_payer'>>,
  shipment: Pick<IShipment, 'status'> & Partial<Pick<IShipment, 'delivery_payer' | 'customer_delivery_fee'>>,
  deliveryFee: number,
  policies: IAgencyPolicies | null
): number {
  if (isReturnedCod(order, shipment)) return 0;
  return resolveEarnedFee(shipment.status === 'returned' ? 'returned' : 'delivered', deliveryFee, policies);
}

export interface ShipmentActuals {
  agencyAmount: number;
  agencyStatus: 'held' | 'released' | 'reversed';
  agentId: string | null;
  agentAmount: number;
  agentStatus: 'held' | 'released' | 'reversed' | null;
  cod: boolean;
}

/**
 * What was ACTUALLY allocated for each shipment that has been split, keyed by shipment id.
 *
 * A prepaid delivery is allocated on source `('shipment', shipmentId)`; a COD one on
 * `('cod_collection', collectionId)`. The agency always gets a row when a split ran (its cut
 * plus, on COD, the handling fee), so "an agency row exists" is the test for "this was split".
 */
async function loadActuals(shipmentIds: string[]): Promise<Map<string, ShipmentActuals>> {
  const actuals = new Map<string, ShipmentActuals>();
  if (shipmentIds.length === 0) return actuals;

  const collections = await CashCollectionModel.find({ shipment_id: { $in: shipmentIds } })
    .select('_id shipment_id')
    .lean<{ _id: unknown; shipment_id: unknown }[]>();
  const shipmentOfCollection = new Map(collections.map((c) => [String(c._id), String(c.shipment_id)]));

  const rows = await EarningsAllocationModel.find({
    beneficiary_type: { $in: ['agency', 'agent'] },
    $or: [
      { source_type: 'shipment', source_id: { $in: shipmentIds } },
      ...(collections.length
        ? [{ source_type: 'cod_collection', source_id: { $in: collections.map((c) => c._id) } }]
        : []),
    ],
  })
    .select('source_type source_id beneficiary_type beneficiary_id amount status')
    .lean<
      {
        source_type: string;
        source_id: unknown;
        beneficiary_type: string;
        beneficiary_id: unknown;
        amount: number;
        status: 'held' | 'released' | 'reversed';
      }[]
    >();

  for (const a of rows.filter((r) => r.beneficiary_type === 'agency')) {
    const cod = a.source_type === 'cod_collection';
    const shipmentId = cod ? shipmentOfCollection.get(String(a.source_id)) : String(a.source_id);
    if (!shipmentId) continue;
    const agent = rows.find(
      (r) =>
        r.beneficiary_type === 'agent' &&
        r.source_type === a.source_type &&
        String(r.source_id) === String(a.source_id)
    );
    actuals.set(shipmentId, {
      agencyAmount: a.amount,
      agencyStatus: a.status,
      agentId: agent ? String(agent.beneficiary_id) : null,
      agentAmount: agent?.amount ?? 0,
      agentStatus: agent?.status ?? null,
      cod,
    });
  }
  return actuals;
}

/**
 * Replace an agent's estimate with the allocation actually written, once the delivery was split.
 *
 * A split with no agent row for THIS agent (a zero cut is not persisted, or the shipment was
 * carried by someone else) is still a real answer: 0, not an estimate.
 */
export function overlayAgentActual(
  result: AgentEarningQuoteResult,
  actual: ShipmentActuals | undefined,
  agentId: string
): AgentEarningQuoteResult {
  if (!actual || !result.earning) return result;
  const mine = actual.agentId === agentId;
  return {
    earning: {
      ...result.earning,
      amount: mine ? actual.agentAmount : 0,
      estimated: false,
      allocationStatus: (mine ? actual.agentStatus : null) ?? actual.agencyStatus,
    },
    earningUnavailable: null,
  };
}

/**
 * Replace an agency's estimate with the allocations actually written.
 *
 * COD: the agency row is `deliveryFee − agentCut + codFee`, so the handling fee is the residual
 * against the shipment's `delivery_fee_snapshot` (written at collection). Prepaid: no handling
 * fee, and the earned fee is agency + agent.
 */
export function overlayAgencyActual(
  result: AgencyEarningQuoteResult,
  actual: ShipmentActuals | undefined,
  deliveryFeeSnapshot: number | null
): AgencyEarningQuoteResult {
  if (!actual || !result.agencyEarning) return result;
  const earnedBeforeCod = actual.agencyAmount + actual.agentAmount;
  let codHandlingFee = 0;
  if (actual.cod) {
    codHandlingFee =
      deliveryFeeSnapshot !== null && deliveryFeeSnapshot <= earnedBeforeCod
        ? earnedBeforeCod - deliveryFeeSnapshot
        : result.agencyEarning.codHandlingFee;
  }
  return {
    agencyEarning: {
      ...result.agencyEarning,
      amount: actual.agencyAmount,
      agentCut: actual.agentAmount,
      earnedFee: earnedBeforeCod - codHandlingFee,
      codHandlingFee,
      estimated: false,
      allocationStatus: actual.agencyStatus,
    },
    agencyEarningUnavailable: null,
  };
}

export class EarningsQuoteService {
  constructor(
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly contracts: AgentContractRepository = agentContractRepository
  ) {}

  /**
   * ONE shipment's delivery fee — shared by the prepaid per-order split (summed per agency),
   * the COD per-collection split, and the agent's and agency's quotes. ONE definition, in
   * this precedence (ADR-A11):
   *
   *   1. the vendor-approved override (`delivery_fee_override`);
   *   2. the CHECKOUT snapshot (`delivery_fee_snapshot`, written for every physical shipment
   *      since ADR-A11 — the posted price the payer was quoted);
   *   3. the live formula, `computeShipmentFee`, with the order items' snapshotted weights and
   *      the drop-off region against each vendor-address pickup's snapshotted region.
   *

   * ⚠ A VENDOR-APPROVED override wins over the formula (`shipment.delivery_fee_override`,
   * modules/delivery-fee-proposals). It is checked here — the one function every fee
   * consumer already calls — rather than at each call site, so the prepaid split, the COD
   * split, the agent's quote and the agency's quote cannot disagree about which number a
   * renegotiated shipment carries. It deliberately precedes the `!policies` fallback: an
   * approved fee is an agreement, not a derivation, and needs no policy to exist.
   */
  computeShipmentDeliveryFee(
    shipment: IShipment,
    policies: IAgencyPolicies | null,
    orderItemsById: Map<string, IOrderItem>,
    orderId: string,
    /** The order's drop-off region (`order.delivery_address.components.region`); unknown ⇒ in-region. */
    deliveryRegion: string | null = null
  ): number {
    const override = approvedDeliveryFeeOf(shipment);
    if (override !== null) return override;

    // ADR-A11: the posted price was snapshotted AT CHECKOUT for every physical shipment — that
    // is what the payer (vendor or customer) was quoted and what the agency is owed. Never
    // re-derive it from a policy the agency may have edited since.
    const snapshot = shipment.delivery_fee_snapshot;
    if (typeof snapshot === 'number' && Number.isFinite(snapshot) && snapshot >= 0) return snapshot;

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

    // No snapshot (a legacy shipment, or one created after checkout when an item moved to
    // another agency): price it live with THE formula. The classification is shipment-shaped
    // and stays here; the arithmetic is `computeShipmentFee`, the one definition the cart
    // quote and checkout price with too.
    const mix: PickupMix = { hasPickupBased: false, hasStorageBased: false };
    const weighed: Array<{ grams: number; quantity: number }> = [];
    let outOfRegion = false;
    for (const item of shipment.items) {
      const orderItem = orderItemsById.get(item.order_item_id.toString());
      const pickup = orderItem?.delivery?.pickup_location;
      const source = pickup?.source;
      if (source === 'vendor_address') mix.hasPickupBased = true;
      if (source === 'agency_storage') mix.hasStorageBased = true;
      // else: no matching order item, or a legacy item with
      // pickup_location: null (predates this feature) — can't classify;
      // contributes no fee component.
      // The weight the checkout snapshotted, else the D-4 fallback for this unit.
      const snapshotGrams = orderItem?.weight_grams;
      const grams =
        typeof snapshotGrams === 'number' && snapshotGrams > 0
          ? snapshotGrams
          : resolveItemWeightGrams({}).grams;
      weighed.push({ grams, quantity: item.quantity });
      // Only the vendor-address pickup carries a snapshotted region; a depot's is live and is
      // never guessed here (unknown ⇒ in-region, never against the payer).
      if (isOutOfRegion(deliveryRegion, pickup?.address_snapshot?.geo?.components?.region ?? null)) outOfRegion = true;
    }

    return computeShipmentFee(policies, { mix, totalWeightGrams: shipmentWeightGrams(weighed), outOfRegion }).fee;
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
    orderId: string,
    deliveryRegion: string | null = null
  ): number {
    return (
      shipment.delivery_fee_snapshot ??
      this.computeShipmentDeliveryFee(shipment, policies, orderItemsById, orderId, deliveryRegion)
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

    const contract = await this.contracts.findLiveOrLatest(agentId, agencyId);
    if (!contract) return unavailable('no_contract');

    const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
    const deliveryFee = this.resolveDeliveryFee(shipment, policies, orderItemsById, String(order._id), regionOf(order));
    // The agent's cut comes out of what the run EARNED — the RTO rate on a return, nothing on a
    // returned COD shipment — exactly as the split computes it. It used to be a cut of the full
    // fee, so the agent's figure and the agency's `agentCut` disagreed on the same shipment.
    const earnedFee = earnedFeeFor(order, shipment, deliveryFee, policies);

    const result: AgentEarningQuoteResult = {
      earning: {
        amount: applyFeeSplit(contract.fee_split, earnedFee),
        currency: order.currency ?? contract.fee_split?.currency ?? EARNINGS_CONFIG.DEFAULT_CURRENCY,
        estimated: true,
        deliveryFee,
        basis: basisOf(contract.fee_split),
        salary: salaryOf(contract.fee_split),
      },
      earningUnavailable: null,
    };
    const shipmentId = String((shipment as any)._id);
    const actuals = await loadActuals([shipmentId]);
    return overlayAgentActual(result, actuals.get(shipmentId), agentId);
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
          async (agencyId) => [agencyId, await this.contracts.findLiveOrLatest(agentId, agencyId)] as const
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
      const deliveryFee = this.resolveDeliveryFee(shipment, policies, orderItemsById, String(order._id), regionOf(order));

      // Same arithmetic as computeAgentCut, but against the already-resolved
      // contract — re-fetching per row is what this batch path exists to avoid.
      const split = contract.fee_split;
      const earnedFee = earnedFeeFor(order, shipment, deliveryFee, policies);
      results.set(shipmentId, {
        earning: {
          amount: applyFeeSplit(split, earnedFee),
          currency: order.currency ?? split?.currency ?? EARNINGS_CONFIG.DEFAULT_CURRENCY,
          estimated: true,
          deliveryFee,
          basis: basisOf(split),
          salary: salaryOf(split),
        },
        earningUnavailable: null,
      });
    }

    const actuals = await loadActuals([...results.keys()]);
    for (const [shipmentId, result] of results) {
      results.set(shipmentId, overlayAgentActual(result, actuals.get(shipmentId), agentId));
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
    const deliveryFee = this.resolveDeliveryFee(shipment, policies, orderItemsById, String(order._id), regionOf(order));

    // A shipment that has already come back earns the RTO rate, not the full
    // fee — mirrors the outcome `ShipmentService` passes to
    // `splitShipmentDelivery`. Everything else is quoted as if it will succeed,
    // which is the question the agency is asking.
    // A returned COD shipment earns 0 all round — see `isReturnedCod`.
    const earnedFee = earnedFeeFor(order, shipment, deliveryFee, policies);

    const agentCut = applyFeeSplit(contract?.fee_split, earnedFee);
    const codHandlingFee =
      order.payment_method === 'cash_on_delivery' && !isReturnedCod(order, shipment)
        ? computeCodHandlingFee(policies.pricing?.additional_fees?.cod_handling_fee, codGross)
        : 0;

    return {
      agencyEarning: {
        amount: computeAgencyCut(earnedFee, agentCut, codHandlingFee),
        currency: order.currency ?? contract?.fee_split?.currency ?? EARNINGS_CONFIG.DEFAULT_CURRENCY,
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
   * `codGross` is the GOODS this shipment's cash pays for (ADR-A11 D-5: the COD handling fee
   * is computed on the product price only, never on a customer-paid delivery fee), needed only
   * for a percentage `cod_handling_fee`. It is passed IN rather than computed here on purpose:
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

    const contract = await this.contracts.findLiveOrLatest(agentId, agencyId);
    const result = this.buildAgencyQuote(shipment, order, policies, contract, codGross);
    const shipmentId = String((shipment as any)._id);
    const actuals = await loadActuals([shipmentId]);
    return overlayAgencyActual(result, actuals.get(shipmentId), shipment.delivery_fee_snapshot ?? null);
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
          return [pair, await this.contracts.findLiveOrLatest(agentId, agencyId)] as const;
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

    const actuals = await loadActuals([...results.keys()]);
    const snapshotOf = new Map(shipments.map((s) => [String((s as any)._id), s.delivery_fee_snapshot ?? null]));
    for (const [shipmentId, result] of results) {
      results.set(
        shipmentId,
        overlayAgencyActual(result, actuals.get(shipmentId), snapshotOf.get(shipmentId) ?? null)
      );
    }
    return results;
  }
}

export const earningsQuoteService = new EarningsQuoteService();
