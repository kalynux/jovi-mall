/**
 * Refund legs — which succeeded payments an ORDER refund is taken from (ADR-A11). Pure.
 *
 * Until ADR-A11 an order was paid by exactly one transaction (its own, or its checkout group's),
 * and `refundPayment` found it with a `findOne`. A customer-approved delivery-fee increase adds a
 * second one — `purpose: 'order_delivery_topup'` — so an order can hold money in TWO succeeded
 * transactions, and a `findOne` picks one of them arbitrarily: a refund above that one's balance
 * was refused although the order held the money, and a vendor refunding "the order" could not
 * return the top-up at all. A gateway refunds against one charge at a time, so the refund is
 * spread over the legs here.
 */

export type RefundLegPurpose = 'primary' | 'order_delivery_topup';

export interface RefundLeg {
  id: string;
  purpose: RefundLegPurpose;
  /** What this payment can still return FOR THIS ORDER. */
  remaining: number;
}

const nonNeg = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/**
 * `prefer`:
 *  - `primary_first` — an ordinary refund (vendor, administrator): the checkout charge first.
 *  - `topup_first`   — a delivery-fee refund: the most recent delivery money first, so a top-up
 *                      a later decrease made unnecessary is the charge that is returned.
 *
 * Returns null when the legs cannot cover `amount` (the caller's ceiling check is the authority;
 * this is the belt).
 */
export function planRefundLegs(
  legs: RefundLeg[],
  amount: number,
  prefer: 'primary_first' | 'topup_first' = 'primary_first'
): Array<{ id: string; amount: number }> | null {
  const want = nonNeg(amount);
  if (want === 0) return [];
  const rank = (l: RefundLeg) => (l.purpose === 'primary' ? 0 : 1);
  const ordered = [...legs].sort((a, b) => (prefer === 'primary_first' ? rank(a) - rank(b) : rank(b) - rank(a)));
  const out: Array<{ id: string; amount: number }> = [];
  let left = want;
  for (const leg of ordered) {
    if (left === 0) break;
    const take = Math.min(left, nonNeg(leg.remaining));
    if (take > 0) {
      out.push({ id: leg.id, amount: take });
      left -= take;
    }
  }
  return left === 0 ? out : null;
}

/**
 * What the PRIMARY payment can still return for one order of a group payment: the order's share
 * of it is its total minus the top-ups it was later paid (those sit in their own transactions).
 */
export function primaryLegRemaining(input: {
  orderTotal: number;
  topupsPaid: number;
  refundedFromThisLegForOrder: number;
  paymentRemaining: number;
}): number {
  const share = nonNeg(input.orderTotal - input.topupsPaid);
  return Math.min(nonNeg(share - input.refundedFromThisLegForOrder), nonNeg(input.paymentRemaining));
}
