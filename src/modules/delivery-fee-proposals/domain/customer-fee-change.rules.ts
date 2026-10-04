import type { ShipmentStatus } from '../../shipments/shipment.model';
import { DELIVERY_FEE_PROPOSAL_WINDOW } from './delivery-fee-proposal.rules';

/**
 * Delivery-fee changes AFTER checkout on a CUSTOMER-paid shipment (ADR-A11 § Fee changes after
 * checkout, owner decisions D-8 / D-9 / D-10) — the pure half. DB-free, so
 * `test:customer-fee-changes` runs every money decision with no connection.
 *
 * ── The three numbers every decision reads ───────────────────────────────────
 *
 *   fee           what the AGENCY is paid for the run — `delivery_fee_override` →
 *                 `delivery_fee_snapshot` (`computeShipmentDeliveryFee`).
 *   customerFee   `shipment.customer_delivery_fee`:
 *                   online — the money the customer has PAID for this run, gross: the checkout
 *                            charge plus every top-up. Never lowered: a refund is recorded beside
 *                            it (`delivery_fee_refunds`), never subtracted from it.
 *                   COD    — the cash the customer WILL hand the rider for the run. Moves both ways
 *                            (no money has changed hands yet).
 *   vendorBorne   max(0, fee − customerFee) — what the vendor pays out of its net. 0 in the normal
 *                 case; > 0 only after a change-agency difference the customer declined (D-10).
 *
 * Everything the customer paid above the fee (`max(0, customerFee − fee)`, online only) is owed
 * back to them: `shipment.customer_fee_refundable` holds it, `delivery_fee_refunds` records what
 * was actually returned. These are exactly the quantities `deliveryFeeShares` (W-C) divides at the
 * split, so the split, the refund and this file cannot disagree.
 *
 * ── The two rules, and why each is the way it is ─────────────────────────────
 *
 *  1. **An increase costs the customer exactly the delta** (`newFee − fee`). Not "the new fee
 *     minus what they hold": a vendor-borne share stays with the vendor (it was the vendor's
 *     answer to a difference the customer declined), and a refund still owed stays owed — the two
 *     ledgers never net against each other, so neither can be lost in the other.
 *  2. **A decrease reduces the vendor's share first.** On a run where the vendor bears part of the
 *     fee, a lower fee first gives the VENDOR back what it was carrying; only below that does the
 *     customer get money back. The customer never pays more than their own posted price, and the
 *     vendor stops carrying a difference that no longer exists.
 */

/**
 * How the customer pays THIS shipment's delivery fee:
 *  - `online`   — charged online with the goods (top-ups and refunds move money online);
 *  - `cod`      — a COD order: cash at the door with the goods;
 *  - `cash_fee` — an ONLINE order whose delivery fee is handed to the rider in cash (W-F, ADR-A11
 *                 § Cash for delivery). The FEE behaves like COD (no money has moved: the
 *                 fee-only collection is re-priced, no top-up, no refund), the VENDOR like online
 *                 (its share was split at payment, so a vendor-borne move adjusts its allocation).
 */
export type PaymentMode = 'online' | 'cod' | 'cash_fee';

/** True when the fee is cash the rider has not collected yet (COD, or cash for delivery). */
export function feeIsCash(mode: PaymentMode): boolean {
  return mode === 'cod' || mode === 'cash_fee';
}
export type FeeDirection = 'increase' | 'decrease';
/** Who must answer a proposal. `none` = applied on creation (a customer-paid decrease). */
export type ProposalApprover = 'vendor' | 'customer' | 'none';
/** Where a proposal came from. */
export type ProposalOrigin = 'agency' | 'change_agency' | 'combined_request';

export const PROPOSAL_APPROVERS: readonly ProposalApprover[] = ['vendor', 'customer', 'none'];
export const PROPOSAL_ORIGINS: readonly ProposalOrigin[] = ['agency', 'change_agency', 'combined_request'];

/**
 * The window a proposal of each origin may be raised and answered in. An agency proposal (and a
 * combined-request answer, which is one) is the ADR-A09 window — before pickup. A change-agency
 * difference is raised on the DESTINATION shipment, which is usually a fresh `pending` one the
 * new agency has not been handed yet; pickup is still blocked by the same pointer.
 */
export const CHANGE_AGENCY_WINDOW: readonly ShipmentStatus[] = ['pending', 'assigned', 'handing_over'];

export function windowFor(origin: ProposalOrigin | null | undefined): readonly ShipmentStatus[] {
  return origin === 'change_agency' ? CHANGE_AGENCY_WINDOW : DELIVERY_FEE_PROPOSAL_WINDOW;
}

const nonNeg = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

export function feeDirection(currentFee: number, proposedFee: number): FeeDirection {
  return proposedFee < currentFee ? 'decrease' : 'increase';
}

/**
 * Who answers a proposal: the vendor on a vendor-paid shipment (ADR-A09, unchanged); the customer
 * for an increase on a customer-paid one; nobody for a customer-paid decrease (D-8: "a decrease
 * applies directly").
 */
export function resolveApprover(payer: 'vendor' | 'customer', direction: FeeDirection): ProposalApprover {
  if (payer === 'vendor') return 'vendor';
  return direction === 'decrease' ? 'none' : 'customer';
}

export interface FeeState {
  mode: PaymentMode;
  /** The fee the agency is paid today. */
  fee: number;
  /** `customer_delivery_fee` today (see the header for its meaning per mode). */
  customerFee: number;
}

export function vendorBorneOf(fee: number, customerFee: number): number {
  return nonNeg(fee - customerFee);
}

/** Online only: what the customer paid above the fee — owed back (`customer_fee_refundable`). */
export function customerExcessOf(fee: number, customerFee: number): number {
  return nonNeg(customerFee - fee);
}

export interface FeeChangePlan {
  feeBefore: number;
  feeAfter: number;
  customerFeeBefore: number;
  customerFeeAfter: number;
  vendorBorneBefore: number;
  vendorBorneAfter: number;
  /** ONLINE: what the customer must pay before the change applies (0 = apply now). */
  topupDue: number;
  /** ONLINE: the value `customer_fee_refundable` takes (the excess at the new fee). */
  refundableAfter: number;
  /**
   * How much the order's customer delivery money moves (± ): `price_breakdown.delivery` / `.total`
   * / `total_amount` (online, COD) — or `price_breakdown.delivery_cash` alone on `cash_fee`, whose
   * `total_amount` is what was charged online and never holds the fee.
   */
  orderTotalDelta: number;
  /** COD / cash_fee: how much the pending cash collection's `delivery_fee_amount` / `expected_amount` move. */
  collectDelta: number;
  /**
   * By how much the vendor's held `('order', vendor)` allocation must move on an online order
   * that is already split: `vendorBorneBefore − vendorBorneAfter` (positive = the vendor gets
   * money back). Always 0 on COD (the collection split reads the shares itself).
   */
  vendorAllocationDelta: number;
}

/**
 * A DECREASE (applied directly — no approval). Vendor share first, then the customer.
 *
 *  - online: `customerFee` is money already paid and is not touched; the new excess becomes
 *    refundable and the refund service returns it. The order total is NOT lowered (it is what was
 *    charged; the refund is recorded beside it).
 *  - COD: `customerFee` drops only below the new fee (`min(customerFee, newFee)`); the order total
 *    and the pending collection drop with it.
 */
export function planDecrease(state: FeeState, newFee: number): FeeChangePlan {
  const fee = nonNeg(state.fee);
  const customerFee = nonNeg(state.customerFee);
  const after = nonNeg(newFee);
  const vendorBorneBefore = vendorBorneOf(fee, customerFee);
  if (feeIsCash(state.mode)) {
    const customerFeeAfter = Math.min(customerFee, after);
    const vendorBorneAfter = vendorBorneOf(after, customerFeeAfter);
    return {
      feeBefore: fee,
      feeAfter: after,
      customerFeeBefore: customerFee,
      customerFeeAfter,
      vendorBorneBefore,
      vendorBorneAfter,
      topupDue: 0,
      refundableAfter: 0,
      orderTotalDelta: customerFeeAfter - customerFee,
      collectDelta: customerFeeAfter - customerFee,
      // cash_fee: the vendor's share was split at PAYMENT (online), so a vendor-borne remainder
      // the lower fee removes goes back to it there. COD: the collection split reads it.
      vendorAllocationDelta: state.mode === 'cash_fee' ? vendorBorneBefore - vendorBorneAfter : 0,
    };
  }
  const vendorBorneAfter = vendorBorneOf(after, customerFee);
  return {
    feeBefore: fee,
    feeAfter: after,
    customerFeeBefore: customerFee,
    customerFeeAfter: customerFee,
    vendorBorneBefore,
    vendorBorneAfter,
    topupDue: 0,
    refundableAfter: customerExcessOf(after, customerFee),
    orderTotalDelta: 0,
    collectDelta: 0,
    vendorAllocationDelta: vendorBorneBefore - vendorBorneAfter,
  };
}

/**
 * An INCREASE the customer APPROVED. The customer covers exactly the delta (rule 1).
 *
 *  - online: `topupDue = newFee − fee`; nothing applies until it is paid (the shipment stays
 *    blocked for pickup). On payment `customerFee` and the order total grow by it.
 *  - COD: the cash to collect grows by the delta at once (no money moves until the door).
 */
export function planCustomerApprovedIncrease(state: FeeState, newFee: number): FeeChangePlan {
  const fee = nonNeg(state.fee);
  const customerFee = nonNeg(state.customerFee);
  const after = nonNeg(newFee);
  const delta = nonNeg(after - fee);
  const customerFeeAfter = customerFee + delta;
  const vendorBorne = vendorBorneOf(fee, customerFee);
  return {
    feeBefore: fee,
    feeAfter: after,
    customerFeeBefore: customerFee,
    customerFeeAfter,
    vendorBorneBefore: vendorBorne,
    vendorBorneAfter: vendorBorneOf(after, customerFeeAfter),
    topupDue: state.mode === 'online' ? delta : 0,
    refundableAfter: state.mode === 'online' ? customerExcessOf(after, customerFeeAfter) : 0,
    orderTotalDelta: delta,
    collectDelta: feeIsCash(state.mode) ? delta : 0,
    vendorAllocationDelta: 0,
  };
}

/**
 * An increase the VENDOR covers: the customer declined to pay a change-agency difference (D-10),
 * or the vendor chose to cover it. The agency is paid `newFee`; the customer pays nothing more;
 * the difference lands on the vendor's net.
 */
export function planVendorCoveredIncrease(state: FeeState, newFee: number): FeeChangePlan {
  const fee = nonNeg(state.fee);
  const customerFee = nonNeg(state.customerFee);
  const after = nonNeg(newFee);
  const vendorBorneBefore = vendorBorneOf(fee, customerFee);
  const vendorBorneAfter = vendorBorneOf(after, customerFee);
  return {
    feeBefore: fee,
    feeAfter: after,
    customerFeeBefore: customerFee,
    customerFeeAfter: customerFee,
    vendorBorneBefore,
    vendorBorneAfter,
    topupDue: 0,
    refundableAfter: state.mode === 'online' ? customerExcessOf(after, customerFee) : 0,
    orderTotalDelta: 0,
    collectDelta: 0,
    vendorAllocationDelta: state.mode === 'cod' ? 0 : vendorBorneBefore - vendorBorneAfter,
  };
}

// ── Editing a customer-approver proposal ─────────────────────────────────────

export type CustomerEditRefusal = { code: 'direction_changed' } | { code: 'customer_already_approved' };

/**
 * A pending customer-approver proposal is an INCREASE by construction (a decrease applies at
 * once). An edit that would make it a decrease is refused — withdraw it and propose the lower fee,
 * which then applies directly. An edit after the customer approved (they may be paying) is
 * refused too: the customer must never pay for a figure that changed under them.
 */
export function checkCustomerProposalEdit(input: {
  currentFee: number;
  newFee: number;
  customerApproved: boolean;
}): CustomerEditRefusal | null {
  if (input.customerApproved) return { code: 'customer_already_approved' };
  if (input.newFee < input.currentFee) return { code: 'direction_changed' };
  return null;
}

// ── Refunds: what is still owed to the customer on an order ──────────────────

export type DeliveryFeeRefundStatus = 'processing' | 'completed' | 'manual_required' | 'failed';
export const DELIVERY_FEE_REFUND_STATUSES: readonly DeliveryFeeRefundStatus[] = [
  'processing',
  'completed',
  'manual_required',
  'failed',
];
/**
 * Ledger statuses that CLAIM money: in flight, returned, or owed by hand. `failed` does not — a
 * failed row is an attempt that moved nothing (and is retried).
 */
export const CLAIMING_REFUND_STATUSES: readonly DeliveryFeeRefundStatus[] = ['processing', 'completed', 'manual_required'];

/**
 * What is still owed to the customer on ONE ORDER and not yet claimed by a refund row:
 * Σ `customer_fee_refundable` over the order's shipments − Σ claiming ledger rows.
 *
 * Measured per ORDER, never per shipment, on purpose: a change-agency move DELETES the source
 * shipment and carries its money to another one, so a per-shipment counter would forget a refund
 * already made against the deleted row and pay it twice. The ledger is keyed on the order, which
 * survives every move.
 */
export function outstandingCustomerRefund(input: {
  refundables: Array<number | null | undefined>;
  ledger: Array<{ status: DeliveryFeeRefundStatus; amount: number }>;
}): number {
  const owed = input.refundables.reduce<number>((s, v) => s + (typeof v === 'number' && v > 0 ? v : 0), 0);
  const claimed = input.ledger
    .filter((r) => CLAIMING_REFUND_STATUSES.includes(r.status))
    .reduce((s, r) => s + Math.max(0, r.amount), 0);
  return nonNeg(owed - claimed);
}

/**
 * Where ONE ORDER's delivery money owed back to the customer stands, from the CUSTOMER's side —
 * what `refunds` on the delivery-fee-changes read and `deliveryFeeRefund` on the order view say.
 *
 *  - `totalOwed`       Σ `customer_fee_refundable` — everything that ever became theirs;
 *  - `returned`        Σ `completed` rows — returned by the gateway, paid by hand (W-E2) or
 *                      covered by a wider refund of the order;
 *  - `owed`            `totalOwed − returned`: NOT YET in their hands, whatever its state — in
 *                      flight at the gateway, waiting for a person (`manual_required`), failed and
 *                      to be retried, or not attempted yet. A manual row claims the money on the
 *                      ledger (`outstandingCustomerRefund`) but is still owed to the customer:
 *                      only a settlement clears it.
 *  - `awaitingManual`  Σ `manual_required` rows — the part a person must pay by hand.
 *
 * Distinct from `outstandingCustomerRefund`, which answers "what may the SYSTEM still try to
 * refund" (a manual row is excluded there so nothing retries it on its own).
 */
export function customerRefundPosition(input: {
  refundables: Array<number | null | undefined>;
  ledger: Array<{ status: DeliveryFeeRefundStatus; amount: number }>;
}): { totalOwed: number; returned: number; owed: number; awaitingManual: number } {
  const totalOwed = input.refundables.reduce<number>((s, v) => s + (typeof v === 'number' && v > 0 ? v : 0), 0);
  const sumOf = (status: DeliveryFeeRefundStatus) =>
    input.ledger.filter((r) => r.status === status).reduce((s, r) => s + Math.max(0, r.amount), 0);
  const returned = sumOf('completed');
  return {
    totalOwed: nonNeg(totalOwed),
    returned: nonNeg(returned),
    owed: nonNeg(totalOwed - returned),
    awaitingManual: nonNeg(sumOf('manual_required')),
  };
}

// ── Settling a manual refund by hand (W-E2, owner decision D-12) ─────────────

/** How a person returned the money. Every one of these MOVED money to the customer. */
export const MANUAL_REFUND_PAYMENT_METHODS = ['mobile_money', 'cash', 'bank', 'other'] as const;
/**
 * No money moved by hand: a wider refund of the ORDER (a vendor's or administrator's gateway
 * refund of the whole charge) already returned this delivery money.
 */
export const MANUAL_REFUND_COVERED_METHOD = 'covered_by_order_refund' as const;
export const MANUAL_REFUND_SETTLEMENT_METHODS = [...MANUAL_REFUND_PAYMENT_METHODS, MANUAL_REFUND_COVERED_METHOD] as const;
export type ManualRefundSettlementMethod = (typeof MANUAL_REFUND_SETTLEMENT_METHODS)[number];

export type ManualSettlementRefusal =
  | { code: 'not_settleable'; status: DeliveryFeeRefundStatus }
  | { code: 'already_covered'; amount: number; stillReturnable: number }
  | { code: 'not_covered'; amount: number; stillReturnable: number | null };

export interface ManualSettlementPlan {
  /** The amount the settled row keeps (all of it, or the covered part). */
  settledAmount: number;
  /** Still owed after a PARTIAL cover — becomes a new `manual_required` row (0 = none). */
  remainderOwed: number;
  /** Money moved by hand (true) or covered by an order refund (false). */
  paidByHand: boolean;
}

/**
 * May this manual refund be marked settled with this method, and what does settling write?
 *
 * `stillReturnable` is what the ORDER's payments can still give back (online: `total_amount`
 * − Σ completed gateway refunds − Σ delivery refunds already paid by hand); `null` for COD,
 * where there was no charge to return and nothing else can have covered it.
 *
 *  - only a `manual_required` row settles (a compare-and-set enforces it again at write time);
 *  - a PAYING method is refused when the order's money no longer covers the row — a wider
 *    refund of the order already returned (part of) it, and paying again pays it twice. Mark it
 *    `covered_by_order_refund` first; any remainder stays owed as its own row and is then paid;
 *  - `covered_by_order_refund` is refused unless that is actually so (COD: never).
 */
export function planManualSettlement(input: {
  status: DeliveryFeeRefundStatus;
  amount: number;
  method: ManualRefundSettlementMethod;
  stillReturnable: number | null;
}): { ok: true; plan: ManualSettlementPlan } | { ok: false; refusal: ManualSettlementRefusal } {
  if (input.status !== 'manual_required') return { ok: false, refusal: { code: 'not_settleable', status: input.status } };
  const amount = nonNeg(input.amount);
  const returnable = input.stillReturnable === null ? null : nonNeg(input.stillReturnable);
  if (input.method === MANUAL_REFUND_COVERED_METHOD) {
    if (returnable === null || returnable >= amount) {
      return { ok: false, refusal: { code: 'not_covered', amount, stillReturnable: returnable } };
    }
    return { ok: true, plan: { settledAmount: amount - returnable, remainderOwed: returnable, paidByHand: false } };
  }
  if (returnable !== null && returnable < amount) {
    return { ok: false, refusal: { code: 'already_covered', amount, stillReturnable: returnable } };
  }
  return { ok: true, plan: { settledAmount: amount, remainderOwed: 0, paidByHand: true } };
}

// ── Refund legs ────────────────────────────────────────────────────────────────
// Pure and owned by payments (`payments/domain/refund-legs.ts`); re-exported here because the
// delivery-fee refund is its first caller and its suite pins it.
export { planRefundLegs, primaryLegRemaining } from '../../payments/domain/refund-legs';
export type { RefundLeg } from '../../payments/domain/refund-legs';

// ── Change-agency (D-10) ─────────────────────────────────────────────────────

export interface WholeMoveInput {
  mode: PaymentMode;
  /** The source shipment's effective fee and customer fee (the shipment that is going away). */
  source: { fee: number; customerFee: number; refundable: number };
  /** The destination BEFORE the move — null when the move creates it. */
  destination: { fee: number; customerFee: number; refundable: number } | null;
  /** The new agency's posted price for the destination as it will stand (formula, no snapshot). */
  newAgencyFee: number;
}

export type WholeMovePlan = {
  /** The destination's money right after the move, BEFORE the price difference is settled. */
  interimFee: number;
  carriedCustomerFee: number;
  carriedRefundable: number;
  /** What happens to the difference between the new agency's price and the interim fee. */
  difference:
    | { kind: 'none' }
    | { kind: 'decrease'; newFee: number }
    | { kind: 'increase'; newFee: number };
};

/**
 * A WHOLE customer-paid shipment moves to another agency (D-10).
 *
 * The move itself is MONEY-NEUTRAL: the destination takes over the source's fee and the customer's
 * money unchanged ("A — the customer keeps what they paid"), so nothing is lost when the source row
 * is deleted. Only then is the new agency's price compared with it, and the difference flows
 * through the ordinary proposal machinery:
 *   lower  → a decrease, applied directly (online: refunded; COD: less cash);
 *   higher → a customer-approval request; declined ⇒ the vendor covers the difference.
 */
export function planWholeMove(input: WholeMoveInput): WholeMovePlan {
  const interimFee = nonNeg(input.source.fee) + nonNeg(input.destination?.fee ?? 0);
  const carriedCustomerFee = nonNeg(input.source.customerFee) + nonNeg(input.destination?.customerFee ?? 0);
  const carriedRefundable = nonNeg(input.source.refundable) + nonNeg(input.destination?.refundable ?? 0);
  const target = nonNeg(input.newAgencyFee);
  const difference: WholeMovePlan['difference'] =
    target === interimFee
      ? { kind: 'none' }
      : target < interimFee
        ? { kind: 'decrease', newFee: target }
        : { kind: 'increase', newFee: target };
  return { interimFee, carriedCustomerFee, carriedRefundable, difference };
}

// ── The combined-price request (D-8) ─────────────────────────────────────────

export const COMBINED_REQUEST_MIN_SHIPMENTS = 2;
export const COMBINED_REQUEST_STATUSES = ['open', 'answered', 'declined', 'cancelled'] as const;
export type CombinedRequestStatus = (typeof COMBINED_REQUEST_STATUSES)[number];

export interface CombinedCandidate {
  shipmentId: string;
  agencyId: string;
  cartId: string;
  status: ShipmentStatus;
  payer: 'vendor' | 'customer';
  pendingProposal: boolean;
  /** Non-withdrawn proposals already on the shipment (the two-proposal cap). */
  countedProposals: number;
}

export type CombinedIneligibility = 'agency' | 'cart' | 'status' | 'payer' | 'pending' | 'limit';

export type CombinedRequestRefusal =
  | { code: 'too_few'; eligible: number; min: number }
  | { code: 'not_eligible'; shipmentId: string; reason: CombinedIneligibility };

/**
 * A customer may ask an agency for one price for several of their parcels when ≥ 2 shipments of
 * the SAME checkout (`cart_id`) are carried by the SAME agency, are customer-paid, have not been
 * picked up, and could still take a proposal (none pending, cap not reached).
 */
export function checkCombinedRequest(input: {
  agencyId: string;
  cartId: string;
  candidates: CombinedCandidate[];
  maxProposals: number;
}): CombinedRequestRefusal | null {
  for (const c of input.candidates) {
    const reason: CombinedIneligibility | null =
      c.agencyId !== input.agencyId
        ? 'agency'
        : c.cartId !== input.cartId
          ? 'cart'
          : !DELIVERY_FEE_PROPOSAL_WINDOW.includes(c.status)
            ? 'status'
            : c.payer !== 'customer'
              ? 'payer'
              : c.pendingProposal
                ? 'pending'
                : c.countedProposals >= input.maxProposals
                  ? 'limit'
                  : null;
    if (reason) return { code: 'not_eligible', shipmentId: c.shipmentId, reason };
  }
  if (input.candidates.length < COMBINED_REQUEST_MIN_SHIPMENTS) {
    return { code: 'too_few', eligible: input.candidates.length, min: COMBINED_REQUEST_MIN_SHIPMENTS };
  }
  return null;
}

export type CombinedResponseRefusal =
  | { code: 'empty' }
  | { code: 'unknown_shipment'; shipmentId: string }
  | { code: 'duplicate_shipment'; shipmentId: string }
  | { code: 'not_lower'; shipmentId: string; currentFee: number };

/**
 * The agency's answer: a LOWER fee for some (or all) of the request's shipments. Each becomes a
 * decrease proposal and applies directly. A fee at or above the current one is refused — the
 * request asks for a combined (lower) price; raising one is an ordinary proposal for the customer
 * to approve.
 */
export function checkCombinedResponse(input: {
  requestShipmentIds: string[];
  fees: Array<{ shipmentId: string; proposedFee: number }>;
  currentFees: Map<string, number>;
}): CombinedResponseRefusal | null {
  if (input.fees.length === 0) return { code: 'empty' };
  const seen = new Set<string>();
  for (const f of input.fees) {
    if (!input.requestShipmentIds.includes(f.shipmentId)) return { code: 'unknown_shipment', shipmentId: f.shipmentId };
    if (seen.has(f.shipmentId)) return { code: 'duplicate_shipment', shipmentId: f.shipmentId };
    seen.add(f.shipmentId);
    const current = input.currentFees.get(f.shipmentId) ?? 0;
    if (!Number.isInteger(f.proposedFee) || f.proposedFee < 0 || f.proposedFee >= current) {
      return { code: 'not_lower', shipmentId: f.shipmentId, currentFee: current };
    }
  }
  return null;
}

/** The customer's saving from an agency answer — Σ (current − proposed). */
export function combinedSaving(fees: Array<{ proposedFee: number; currentFee: number }>): number {
  return fees.reduce((s, f) => s + nonNeg(f.currentFee - f.proposedFee), 0);
}
