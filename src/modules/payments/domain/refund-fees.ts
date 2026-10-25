/**
 * The fees on a refund (owner decisions F-1…F-5, 2026-10-22). Pure; pinned by `test:refund-fees`.
 * Plan: PRODUCTION-READINESS/REFUND-FEES-AND-AGENCY-LIABILITY-PLAN.md.
 *
 * ── Two fees, one assumed rate each for EVERY aggregator (F-2) ──────────────────────────
 * Wi-Mall uses several aggregators and switches between them, and each really charges its own
 * price. A refund must not change with that, so the platform ASSUMES a flat rate per direction:
 *   - the PAY-IN fee (default 2%): kept by the aggregator when the customer paid. Wi-Mall never
 *     saw that money, so it does not give it back (F-1: Wi-Mall returns its commission MINUS it —
 *     7% → 5%, 6% → 4%, 4% → 2%);
 *   - the PAYOUT fee (default 2%, the existing `refund_fee_percent`): what the aggregator takes
 *     from Wi-Mall's account to send a transfer.
 *
 * ── Only the fee that happened (F-4) ─────────────────────────────────────────────────────
 *   mobile money → pay-in AND payout · card → pay-in only (refunded on the card, no transfer)
 *   cash on delivery → payout only (no aggregator when the customer paid) · billing → both.
 *
 * ── Who pays them ────────────────────────────────────────────────────────────────────────
 * The CUSTOMER, as a rule (F-3): the payout fee is 2% of what is owed AFTER the pay-in fee, and
 * the customer receives the rest — the owner's example: 2,500 owed → Wi-Mall requests 2,450.
 *   10,000 paid → pay-in 200 → 9,800 owed → payout 196 → the customer receives 9,604.
 * The SELLER, when the seller cancelled a paid order (F-5): the customer receives 100%, so the
 * payout fee is 2% of the whole amount sent, and both fees are charged to the seller.
 *
 * Integer arithmetic and half-up rounding come from `refundFeeFor` (refund-fee.ts), so every fee
 * in the platform rounds the same way.
 */

import { refundFeeFor, RefundPaymentChannel } from './refund-fee';

export type RefundFeesPaidBy = 'customer' | 'vendor';
export const REFUND_FEES_PAID_BY: readonly RefundFeesPaidBy[] = Object.freeze(['customer', 'vendor'] as RefundFeesPaidBy[]);

export interface RefundFeesInput {
  /** What the refund is worth (the gross the source loses). */
  gross: number;
  paymentChannel: RefundPaymentChannel;
  /** `payment_settings.payin_fee_percent`. */
  payinRatePercent: number;
  /** `payment_settings.refund_fee_percent`. */
  payoutRatePercent: number;
  paidBy: RefundFeesPaidBy;
}

export interface RefundFees {
  paidBy: RefundFeesPaidBy;
  /** Rates actually applied: 0 where the fee did not happen (F-4). */
  payinRate: number;
  payinAmount: number;
  payoutRate: number;
  payoutAmount: number;
  /** Deducted from what the CUSTOMER receives: both fees when they pay them, else 0. */
  customerFee: number;
  /** Charged to the SELLER on top of their share: both fees when they pay them, else 0. */
  vendorCharge: number;
  /** What the customer receives: `gross − customerFee`. */
  net: number;
}

const nonNegInt = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const rateOrZero = (r: number) => (Number.isFinite(r) && r > 0 ? r : 0);

/** Did the customer's money go through an aggregator when they PAID? */
export function payinFeeApplies(channel: RefundPaymentChannel): boolean {
  return channel === 'mobile_money' || channel === 'card' || channel === 'billing';
}

/** Does the refund leave by an aggregator TRANSFER? (A card refund goes back on the card.) */
export function payoutFeeApplies(channel: RefundPaymentChannel): boolean {
  return channel === 'mobile_money' || channel === 'cod' || channel === 'billing';
}

export function computeRefundFees(input: RefundFeesInput): RefundFees {
  const gross = nonNegInt(input.gross);
  const payinRate = payinFeeApplies(input.paymentChannel) ? rateOrZero(input.payinRatePercent) : 0;
  const payoutRate = payoutFeeApplies(input.paymentChannel) ? rateOrZero(input.payoutRatePercent) : 0;
  const payinAmount = refundFeeFor(gross, payinRate);

  if (input.paidBy === 'vendor') {
    // The customer receives everything; the transfer is of the whole gross.
    const payoutAmount = refundFeeFor(gross, payoutRate);
    return {
      paidBy: 'vendor',
      payinRate,
      payinAmount,
      payoutRate,
      payoutAmount,
      customerFee: 0,
      vendorCharge: payinAmount + payoutAmount,
      net: gross,
    };
  }

  const owed = gross - payinAmount;
  const payoutAmount = refundFeeFor(owed, payoutRate);
  return {
    paidBy: 'customer',
    payinRate,
    payinAmount,
    payoutRate,
    payoutAmount,
    customerFee: payinAmount + payoutAmount,
    vendorCharge: 0,
    net: owed - payoutAmount,
  };
}

/**
 * A lost card dispute (F-9): the bank returned the customer 100%, so the seller also carries the
 * pay-in fee Wi-Mall already lost. Stripe's own dispute fee is not here — it stays Wi-Mall's.
 */
export function disputeVendorCharge(disputedAmount: number, payinRatePercent: number): number {
  return refundFeeFor(nonNegInt(disputedAmount), rateOrZero(payinRatePercent));
}

export type CustomerRefundLineCode = 'refund_amount' | 'payment_fee' | 'transfer_fee' | 'fees_paid_by_seller' | 'you_receive';

export interface CustomerRefundLine {
  code: CustomerRefundLineCode;
  /** English label; a screen in another language switches on `code`. */
  label: string;
  /** Signed: a fee is negative; `fees_paid_by_seller` is 0 (a note, not money). */
  amount: number;
  /** The percent behind a fee line, else null. */
  percent: number | null;
}

/**
 * The lines a CUSTOMER sees under a refund — the owner's objective (2026-10-22): say plainly why
 * they receive less than they paid. Only the fees that happened; when the seller pays them, one
 * line says so instead.
 *   Refund 10,000 · Payment provider fee (2%) −200 · Transfer fee (2%) −196 · You receive 9,604
 */
export function customerRefundLines(fees: Pick<RefundFees, 'paidBy' | 'payinRate' | 'payinAmount' | 'payoutRate' | 'payoutAmount' | 'net'>, gross: number): CustomerRefundLine[] {
  const lines: CustomerRefundLine[] = [{ code: 'refund_amount', label: 'Refund', amount: gross, percent: null }];
  if (fees.paidBy === 'vendor') {
    if (fees.payinAmount + fees.payoutAmount > 0) {
      lines.push({ code: 'fees_paid_by_seller', label: 'Payment and transfer fees are paid by the seller', amount: 0, percent: null });
    }
  } else {
    if (fees.payinAmount > 0) {
      lines.push({ code: 'payment_fee', label: 'Payment provider fee, kept when you paid', amount: -fees.payinAmount, percent: fees.payinRate });
    }
    if (fees.payoutAmount > 0) {
      lines.push({ code: 'transfer_fee', label: 'Transfer fee to send the money back', amount: -fees.payoutAmount, percent: fees.payoutRate });
    }
  }
  lines.push({ code: 'you_receive', label: 'You receive', amount: fees.net, percent: null });
  return lines;
}
