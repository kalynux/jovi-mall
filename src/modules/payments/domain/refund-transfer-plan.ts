import { planRefundLegs, RefundLeg } from './refund-legs';
import { normalizeRefundPhone } from './refund-destination';

/**
 * How a refund's money is split into TRANSFERS (REFUND-FLOW-PLAN § 3.2). Pure; pinned by
 * `test:refund-flow`.
 *
 * A payout is ONE transfer to ONE number. An order can hold money in two payments (a checkout
 * charge and a delivery top-up — `refund-legs.ts`):
 *   - both paid from the same number → ONE transfer for the total;
 *   - from different numbers         → one transfer PER NUMBER, split by the existing leg plan.
 * A typed destination is one number by definition → one transfer.
 *
 * The fee (`refund-fee.ts`) is computed ONCE on the whole gross, so the customer is charged the
 * same however many transfers it takes; it is then spread over the transfers by gross share with
 * the largest-remainder method, so the per-transfer nets add up EXACTLY to the request's net.
 */

export interface PaymentLegShare {
  /** `payment_transactions._id`, or null for COD / billing / a leg-less source. */
  paymentTransactionId: string | null;
  purpose: RefundLeg['purpose'] | 'booking_balance' | null;
  /** The GROSS this payment returns. */
  amount: number;
  /** `payer.phone` on that payment, as stored. */
  payerPhone: string | null;
}

export interface PlannedTransfer {
  phone: string;
  /** Gross refunded through this transfer. */
  gross: number;
  /** What is actually sent: gross − this transfer's share of the fee. */
  amount: number;
}

/** Spread the payment legs over the payment ledger (gross per payment), via `planRefundLegs`. */
export function planPaymentLegShares(
  legs: ReadonlyArray<RefundLeg & { payerPhone: string | null }>,
  amount: number,
  prefer: 'primary_first' | 'topup_first' = 'primary_first'
): PaymentLegShare[] | null {
  const plan = planRefundLegs(legs.map((l) => ({ id: l.id, purpose: l.purpose, remaining: l.remaining })), amount, prefer);
  if (!plan) return null;
  return plan.map((step) => {
    const leg = legs.find((l) => l.id === step.id)!;
    return { paymentTransactionId: leg.id, purpose: leg.purpose, amount: step.amount, payerPhone: leg.payerPhone };
  });
}

/**
 * Largest-remainder split of `total` in proportion to `weights` (integers summing exactly).
 * Ties go to the earlier index, so the result is deterministic.
 */
export function largestRemainderSplit(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (Math.max(0, w) * total) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let left = total - floors.reduce((s, f) => s + f, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

/**
 * Group the payment shares into transfers.
 *
 * `destinationPhone` set (a typed number, or a single-payer refund) → ONE transfer to it.
 * Otherwise one transfer per DISTINCT normalised payer number, in first-seen order. Returns null
 * when a share has no readable number and no destination was given — the caller refuses with
 * `REFUND_NO_DESTINATION`.
 */
export function planTransfers(
  shares: readonly PaymentLegShare[],
  feeAmount: number,
  destinationPhone: string | null
): PlannedTransfer[] | null {
  const groups: Array<{ phone: string; gross: number }> = [];
  if (destinationPhone) {
    groups.push({ phone: destinationPhone, gross: shares.reduce((s, l) => s + l.amount, 0) });
  } else {
    for (const share of shares) {
      const phone = normalizeRefundPhone(share.payerPhone);
      if (!phone) return null;
      const existing = groups.find((g) => g.phone === phone);
      if (existing) existing.gross += share.amount;
      else groups.push({ phone, gross: share.amount });
    }
  }
  const fees = largestRemainderSplit(feeAmount, groups.map((g) => g.gross));
  return groups
    .map((g, i) => ({ phone: g.phone, gross: g.gross, amount: g.gross - fees[i] }))
    .filter((t) => t.gross > 0);
}

// ── Settling by hand after a PART of the money already left (review finding 4) ─────────

export interface SettleRemainderInput {
  grossAmount: number;
  netAmount: number;
  feeAmount: number;
  /** `destination.source` — a typed number (or a leg-less source) is ONE transfer for everything. */
  destinationSource: 'payer' | 'typed' | null;
  paymentLegs: ReadonlyArray<{ amount: number; payerPhone: string | null; refunded: boolean }>;
  transferLegs: ReadonlyArray<{ phone: string; gross: number; amount: number; status: string }>;
}

export interface SettleRemainderPlan {
  /** Per payment leg, in order: how ITS money left, and its share of the fee. */
  legs: Array<{ channel: 'payout' | 'card_refund' | 'external'; fee: number }>;
  /** Already returned through the platform (succeeded transfers, card legs refunded). */
  paidGross: number;
  paidNet: number;
  /** What the administrator pays by hand — the only part `settle-external` records as external. */
  remainderGross: number;
  remainderNet: number;
}

/**
 * Split a request settled by hand into what the platform ALREADY sent and the remainder. Pure.
 *
 * A transfer leg covers whole payment legs (`planTransfers` groups them by payer number), so each
 * payment leg went out through exactly one channel: `payout` when its number's transfer
 * succeeded, `card_refund` when Stripe refunded it, otherwise `external`. A succeeded transfer
 * keeps the fee it was actually sent with (gross − amount), spread over its payment legs; the
 * remainder carries the rest of the request's fee, so every part's net is exact and they sum to
 * the request's net.
 */
export function planSettleRemainder(input: SettleRemainderInput): SettleRemainderPlan {
  const legs = input.paymentLegs.map(() => ({ channel: 'external' as SettleRemainderPlan['legs'][number]['channel'], fee: 0 }));
  const succeeded = input.transferLegs.filter((t) => t.status === 'succeeded');
  const single = input.destinationSource === 'typed' || input.transferLegs.length === 1;
  let paidFee = 0;

  input.paymentLegs.forEach((leg, i) => {
    if (leg.refunded) legs[i].channel = 'card_refund';
  });

  for (const transfer of succeeded) {
    const covered = input.paymentLegs
      .map((leg, i) => ({ leg, i }))
      .filter(({ leg, i }) =>
        legs[i].channel === 'external' && (single || normalizeRefundPhone(leg.payerPhone) === transfer.phone));
    const groupFee = Math.max(0, transfer.gross - transfer.amount);
    const fees = largestRemainderSplit(groupFee, covered.map(({ leg }) => leg.amount));
    covered.forEach(({ i }, k) => {
      legs[i].channel = 'payout';
      legs[i].fee = fees[k];
    });
    paidFee += covered.length > 0 ? groupFee : 0;
  }

  const paidGross = input.paymentLegs.reduce((s, leg, i) => s + (legs[i].channel === 'external' ? 0 : leg.amount), 0);
  const externalIdx = legs.map((l, i) => (l.channel === 'external' ? i : -1)).filter((i) => i >= 0);
  const remainderFee = Math.max(0, input.feeAmount - paidFee);
  const externalFees = largestRemainderSplit(remainderFee, externalIdx.map((i) => input.paymentLegs[i].amount));
  externalIdx.forEach((i, k) => { legs[i].fee = externalFees[k]; });

  // A leg-less source (COD, billing) has one transfer at most: paid entirely or not at all.
  if (input.paymentLegs.length === 0) {
    const sent = succeeded.reduce((s, t) => s + t.gross, 0) >= input.grossAmount && succeeded.length > 0;
    return sent
      ? { legs, paidGross: input.grossAmount, paidNet: input.netAmount, remainderGross: 0, remainderNet: 0 }
      : { legs, paidGross: 0, paidNet: 0, remainderGross: input.grossAmount, remainderNet: input.netAmount };
  }
  const paidNet = paidGross - paidFee;
  return {
    legs,
    paidGross,
    paidNet,
    remainderGross: input.grossAmount - paidGross,
    remainderNet: input.netAmount - paidNet,
  };
}
