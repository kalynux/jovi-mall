/**
 * Partial payment: part of an order online now, the rest in cash at the door (owner, 2026-11-01,
 * `PRODUCTION-READINESS/PARTIAL-PAYMENT-PLAN.md`).
 *
 * PURE: types only, no Mongoose, no I/O. Quote, checkout, the charge, the collection and the
 * refund all read these rules, so "how much is due where" has one answer.
 *
 * ── The shape ────────────────────────────────────────────────────────────────
 * A partial order IS a cash-on-delivery order with a prepaid part: `payment_method` stays
 * `cash_on_delivery`, and `order.prepayment` is what makes it partial. Delivery codes, cash limits,
 * remittance, coverage and `delivered ⟺ cash collected` therefore keep working untouched. A third
 * payment method would have to be taught to every `payment_method` reader, and any
 * `!== 'cash_on_delivery'` left behind would treat the order as prepaid in silence.
 *
 * All amounts are integers in minor currency units.
 */

/** The lowest and highest minimum a vendor may set (D-9). */
export const PARTIAL_PAYMENT_VENDOR_MIN_PERCENT = 10;
export const PARTIAL_PAYMENT_VENDOR_MAX_PERCENT = 90;
/**
 * The most a customer may pay online (D-9). A customer who wants to pay everything chooses a fully
 * online or a fully cash order: a parcel must leave real cash for the agent, because a collection
 * is never minted for 0 and `delivered` needs a collection.
 */
export const PARTIAL_PAYMENT_CUSTOMER_MAX_PERCENT = 90;

export interface VendorPartialPaymentTerms {
  enabled: boolean;
  /** The vendor's minimum online share, `null` when never set. */
  minPercent: number | null;
}

/** Stored terms with the default applied: off (D-5, a vendor opts in). */
export function vendorPartialPaymentTermsOf(
  stored: { enabled?: boolean | null; min_percent?: number | null } | null | undefined,
): VendorPartialPaymentTerms {
  const minPercent = typeof stored?.min_percent === 'number' ? stored.min_percent : null;
  return { enabled: stored?.enabled === true && minPercent !== null, minPercent };
}

/** Rounded up: a 30% minimum on 101 is 31, never below what the vendor asked. */
export function minimumPrepaymentOf(total: number, minPercent: number): number {
  return Math.ceil((total * minPercent) / 100);
}

/**
 * The most that may be paid online: 90%, rounded up so a vendor's 90% minimum always has a valid
 * amount, and always leaving at least 1 of cash per parcel.
 */
export function maximumPrepaymentOf(total: number, parcelCount: number): number {
  const ninety = Math.ceil((total * PARTIAL_PAYMENT_CUSTOMER_MAX_PERCENT) / 100);
  return Math.max(0, Math.min(ninety, total - Math.max(1, parcelCount)));
}

export interface PrepaymentLimits {
  minimumAmount: number;
  maximumAmount: number;
}

/** The limits for one order, or `null` when it is too small to leave cash on every parcel. */
export function prepaymentLimitsOf(total: number, minPercent: number, parcelCount: number): PrepaymentLimits | null {
  const minimumAmount = minimumPrepaymentOf(total, minPercent);
  const maximumAmount = maximumPrepaymentOf(total, parcelCount);
  if (total <= 0 || minimumAmount <= 0 || minimumAmount > maximumAmount) return null;
  return { minimumAmount, maximumAmount };
}

interface ShareRow {
  id: string;
  /** How much of the amount this row attracts. */
  weight: number;
  /** The most this row may receive. */
  cap: number;
}

/**
 * Divide `amount` by weight, never past a row's cap. What a capped row cannot take goes round
 * again to the rows that still can, and rounding units go to the largest weight (ties by id, so a
 * retry shares identically). Returns what could not be placed anywhere.
 */
export function shareByWeight(amount: number, rows: ShareRow[]): { shares: Map<string, number>; unplaced: number } {
  const shares = new Map<string, number>(rows.map((r) => [r.id, 0]));
  const ordered = [...rows].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  let remaining = Math.max(0, amount);

  while (remaining > 0) {
    const open = ordered.filter((r) => r.cap - shares.get(r.id)! > 0);
    if (open.length === 0) break;
    const totalWeight = open.reduce((sum, r) => sum + Math.max(0, r.weight), 0);

    let placed = 0;
    if (totalWeight > 0) {
      for (const row of open) {
        const room = row.cap - shares.get(row.id)!;
        const give = Math.min(room, remaining - placed, Math.floor(remaining * (Math.max(0, row.weight) / totalWeight)));
        if (give > 0) {
          shares.set(row.id, shares.get(row.id)! + give);
          placed += give;
        }
      }
    }
    if (placed === 0) {
      // Too little left to divide: one unit each, largest first.
      for (const row of open) {
        if (placed === remaining) break;
        shares.set(row.id, shares.get(row.id)! + 1);
        placed += 1;
      }
    }
    remaining -= placed;
  }
  return { shares, unplaced: remaining };
}

export interface OrderPrepaymentInput {
  orderId: string;
  total: number;
  minimumAmount: number;
  maximumAmount: number;
}

/** A whole checkout's limits: the sum of its orders'. */
export function groupPrepaymentLimitsOf(orders: OrderPrepaymentInput[]): PrepaymentLimits {
  return {
    minimumAmount: orders.reduce((sum, o) => sum + o.minimumAmount, 0),
    maximumAmount: orders.reduce((sum, o) => sum + o.maximumAmount, 0),
  };
}

/**
 * One amount for the whole checkout (D-8): every order takes its minimum, and the extra is shared
 * in proportion to what is left to pay on each. The caller has checked the amount is within the
 * group's limits, so nothing is ever left over.
 */
export function allocatePrepaymentAcrossOrders(
  amount: number,
  orders: OrderPrepaymentInput[],
): Array<{ orderId: string; amount: number }> {
  const extra = amount - orders.reduce((sum, o) => sum + o.minimumAmount, 0);
  const { shares } = shareByWeight(
    extra,
    orders.map((o) => ({ id: o.orderId, weight: o.total - o.minimumAmount, cap: o.maximumAmount - o.minimumAmount })),
  );
  return orders.map((o) => ({ orderId: o.orderId, amount: o.minimumAmount + (shares.get(o.orderId) ?? 0) }));
}

export interface ParcelValue {
  parcelId: string;
  /** Goods + the delivery fee the customer pays on this parcel. */
  value: number;
}

/**
 * An order's online part across its parcels, by value. Every parcel keeps at least 1 of cash.
 * `surplus` is non-zero only after parcels lost value following the payment (items moved, a fee
 * lowered); it is the customer's, and the caller records it as owed back.
 */
export function allocatePrepaymentAcrossParcels(
  amount: number,
  parcels: ParcelValue[],
): { byParcel: Map<string, number>; surplus: number } {
  const { shares, unplaced } = shareByWeight(
    amount,
    parcels.map((p) => ({ id: p.parcelId, weight: p.value, cap: Math.max(0, p.value - 1) })),
  );
  return { byParcel: shares, surplus: unplaced };
}

/** Whom a returned parcel's cost falls on (D-2, D-12). */
export type PartialReturnFault = 'customer' | 'vendor' | 'agency';
export const PARTIAL_RETURN_FAULTS: readonly PartialReturnFault[] = Object.freeze(['customer', 'vendor', 'agency']) as readonly PartialReturnFault[];

/** The agent's reasons that PROPOSE the customer's fault (D-10). An administrator decides (D-11). */
export const CUSTOMER_FAULT_FAILURE_REASONS: readonly string[] = Object.freeze([
  'customer_refused',
  'payment_refused',
  'customer_absent',
  'customer_unreachable',
]);

/** The fault a reason proposes, or `null` when it is left for an administrator to judge. */
export function proposedFaultOf(reason: string | null | undefined): PartialReturnFault | null {
  return reason && CUSTOMER_FAULT_FAILURE_REASONS.includes(reason) ? 'customer' : null;
}

export interface ParcelReturnPlan {
  /** Taken from the customer's online part to pay the agency and agent for the run. */
  keptFromCustomer: number;
  /** Returned to the customer, BEFORE any refund fee the customer bears. */
  refundGross: number;
  /** Who pays the refund's fees. */
  feesPaidBy: PartialReturnFault;
  /** The return fee the agency and agent are paid. */
  agencyFeePaid: number;
  /** What the at-fault vendor is charged for that return fee (D-12). */
  vendorChargedReturnFee: number;
}

/**
 * What a returned parcel's prepaid part becomes (D-2, D-12):
 *  - customer at fault: the return fee is kept (never more than was prepaid), the rest is refunded;
 *  - vendor at fault: refunded whole, and the vendor pays the agency's return fee;
 *  - agency at fault: refunded whole, and the agency earns nothing for the trip.
 */
export function parcelReturnPlanOf(input: { prepaid: number; returnFee: number; fault: PartialReturnFault }): ParcelReturnPlan {
  const prepaid = Math.max(0, input.prepaid);
  const returnFee = Math.max(0, input.returnFee);
  if (input.fault === 'customer') {
    const kept = Math.min(prepaid, returnFee);
    return { keptFromCustomer: kept, refundGross: prepaid - kept, feesPaidBy: 'customer', agencyFeePaid: kept, vendorChargedReturnFee: 0 };
  }
  if (input.fault === 'vendor') {
    return { keptFromCustomer: 0, refundGross: prepaid, feesPaidBy: 'vendor', agencyFeePaid: returnFee, vendorChargedReturnFee: returnFee };
  }
  return { keptFromCustomer: 0, refundGross: prepaid, feesPaidBy: 'agency', agencyFeePaid: 0, vendorChargedReturnFee: 0 };
}

/** The base of the COD handling fee on a parcel (D-7): the cash carried, never the delivery fee. */
export function codHandlingFeeBaseOf(goods: number, cash: number): number {
  return Math.max(0, Math.min(goods, cash));
}

/** The order's prepayment as readers need it. A missing block means "not a partial order". */
export interface PrepaymentCarrier {
  prepayment?: { amount?: number | null; paid_at?: Date | null } | null;
}

export function isPartialOrder(order: PrepaymentCarrier | null | undefined): boolean {
  return Boolean(order?.prepayment);
}

/** Partial, and its online part has not been paid: not dispatchable, cancellable by the sweep. */
export function prepaymentIsDue(order: PrepaymentCarrier | null | undefined): boolean {
  return Boolean(order?.prepayment) && !order?.prepayment?.paid_at;
}

/** The cash still due at delivery across a checkout's orders, once `paidOnline` of it is paid. */
export function cashDueAtDeliveryOf(orders: ReadonlyArray<{ total_amount: number }>, paidOnline: number): number {
  return orders.reduce((sum, order) => sum + order.total_amount, 0) - paidOnline;
}

/** What was paid online. 0 on any other order. */
export function amountPaidOnlineOf(order: PrepaymentCarrier | null | undefined): number {
  return order?.prepayment?.paid_at ? Math.max(0, order.prepayment.amount ?? 0) : 0;
}
