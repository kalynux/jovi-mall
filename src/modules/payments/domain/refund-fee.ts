/**
 * The refund fee (REFUND-FLOW-PLAN R-3, D-1, D-2, D-3). Pure; pinned by `test:refund-flow`.
 *
 * ── The rule ──────────────────────────────────────────────────────────────────
 *   fee = round_half_up(amount × rate / 100), in WHOLE XAF
 *   net = amount − fee
 *
 * 5000 at 2% → fee 100, the customer receives 4900.
 *
 * - **Applied to the amount the platform recorded as paid** (the gross), never to what the
 *   customer paid the gateway on top. The gateway's own transfer fee is not checked.
 * - **A card refund carries NO fee** (R-3): Stripe charges nothing to refund, and the customer
 *   gets the whole amount back on the card. Decided by the PAYMENT channel, never by how the
 *   money eventually leaves (D-1): a mobile-money refund settled externally still carries the
 *   fee — the customer is owed 4900 whichever way it is paid — and a card refund settled
 *   externally still carries none, so no two channels for one payment can disagree.
 * - **Integer arithmetic.** The rate is held in basis points (`2` → 200, `2.5` → 250), so
 *   `amount × bp` is an exact integer and the half-up step is `floor((n + 5000) / 10000)` —
 *   never `Math.round` on a float product, which rounds 0.5 the wrong way often enough to
 *   matter on a ledger.
 * - The fee is platform income on the refund record (`fee_amount`, D-2), not an earnings
 *   allocation. Earnings recovery uses the GROSS (§ 6.2): the platform paid out the net and
 *   kept the fee.
 */

export type RefundPaymentChannel = 'card' | 'mobile_money' | 'cod' | 'billing';

export interface RefundFeeBreakdown {
  /** Percent actually applied (0 for a card). */
  feeRate: number;
  feeAmount: number;
  netAmount: number;
}

const nonNegInt = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/** The rate in basis points, from a percent with at most two decimals that matter. */
export function rateToBasisPoints(ratePercent: number): number {
  if (!Number.isFinite(ratePercent) || ratePercent <= 0) return 0;
  return Math.round(ratePercent * 100);
}

/** `round_half_up(amount × rate / 100)` in whole units, by integer arithmetic. */
export function refundFeeFor(amount: number, ratePercent: number): number {
  const gross = nonNegInt(amount);
  const bp = rateToBasisPoints(ratePercent);
  if (gross === 0 || bp === 0) return 0;
  return Math.min(gross, Math.floor((gross * bp + 5000) / 10000));
}

/** Fee + net for a refund of `amount` paid through `paymentChannel` at `ratePercent`. */
export function computeRefundFee(
  amount: number,
  ratePercent: number,
  paymentChannel: RefundPaymentChannel
): RefundFeeBreakdown {
  const gross = nonNegInt(amount);
  if (paymentChannel === 'card') {
    return { feeRate: 0, feeAmount: 0, netAmount: gross };
  }
  const feeAmount = refundFeeFor(gross, ratePercent);
  return { feeRate: ratePercent > 0 ? ratePercent : 0, feeAmount, netAmount: gross - feeAmount };
}
