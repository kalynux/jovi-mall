import type { IRefundRequest } from '../models/refund-request.model';
import type { RefundRequestStatus } from '../domain/refund-status';
import { maskRefundPhone } from '../domain/refund-destination';
import { customerRefundLines, CustomerRefundLine } from '../domain/refund-fees';

/**
 * The refund block a CUSTOMER sees on an order or a booking (REFUND-FLOW-PLAN § 8, R9).
 *
 * One projection, read by every customer surface: the storefront's order and booking pages,
 * the bot's order card and booking reads, and the notification copy. It is the LATEST
 * `refund_requests` row for the source, or `null` when none was ever opened.
 *
 * ── The status collapse ─────────────────────────────────────────────────────
 * Seven internal statuses become six plain ones. The collapse is the point of this file:
 *
 * | internal            | customer           | why                                                    |
 * |---------------------|--------------------|--------------------------------------------------------|
 * | `awaiting_approval` | `requested`        | a person still has to look at it                       |
 * | `approved`          | `requested`        | approved but not sent yet (a short float, payouts off) |
 * | `waiting_for_cash`  | `waiting_for_cash` | COD: the courier has not handed the cash over yet      |
 * | `sending`           | `sending`          | the transfer is in flight                              |
 * | `failed`            | `in_progress`      | ⛔ a customer never sees `failed` as final — Support retries or settles it by hand |
 * | `completed`         | `completed`        | the money arrived (or was paid outside the platform)  |
 * | `rejected`          | `declined`         | the request was turned down                            |
 *
 * ⚠ **`failed` is not shown, on purpose.** A failed transfer is the platform's problem, not the
 * customer's: an administrator retries it or pays it by hand, and either way the customer is
 * still owed the money. "Failed" on a customer screen reads as "you will not be refunded".
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 *  - the full destination number (masked, last three digits only — `maskRefundPhone`);
 *  - the rejection reason (internal free text written for administrators, the same rule the
 *    notification catalog applies to a delivery agent's `failureNote`);
 *  - who requested, approved or rejected it, the transfer references, the gateway and the
 *    proof files — none of it answers a question a customer has.
 *
 * Pure: type-only imports plus the masking helper, so any suite can import it under bare
 * `ts-node`.
 */

export type CustomerRefundStatus =
  | 'requested'
  | 'waiting_for_cash'
  | 'sending'
  | 'in_progress'
  | 'completed'
  | 'declined';

export const CUSTOMER_REFUND_STATUSES: readonly CustomerRefundStatus[] = Object.freeze([
  'requested',
  'waiting_for_cash',
  'sending',
  'in_progress',
  'completed',
  'declined',
] as CustomerRefundStatus[]);

/** Total over the internal union: a new internal status is a compile error here. */
export const CUSTOMER_REFUND_STATUS_OF: Readonly<Record<RefundRequestStatus, CustomerRefundStatus>> = Object.freeze({
  awaiting_approval: 'requested',
  approved: 'requested',
  waiting_for_cash: 'waiting_for_cash',
  sending: 'sending',
  failed: 'in_progress',
  completed: 'completed',
  rejected: 'declined',
});

export function toCustomerRefundStatus(status: RefundRequestStatus | string): CustomerRefundStatus {
  // An unknown value (a status added later and read by an old process) is "in progress" —
  // never echoed raw, never guessed as completed.
  return CUSTOMER_REFUND_STATUS_OF[status as RefundRequestStatus] ?? 'in_progress';
}

export interface CustomerRefundBlock {
  status: CustomerRefundStatus;
  /** What the refund is worth — what the order or booking loses. */
  grossAmount: number;
  /**
   * Everything deducted from what the customer receives: the payment provider fee kept when they
   * paid plus the transfer fee (2026-10-22). 0 when the seller pays the fees.
   */
  feeAmount: number;
  /** The TRANSFER fee rate in percent (e.g. 2). 0 for a card refund (no transfer). */
  feePercent: number;
  /** The payment provider fee kept when the customer paid (2026-10-22). 0 for cash on delivery. */
  paymentFee: number;
  paymentFeePercent: number;
  /** The transfer fee to send the money back. 0 for a card refund. */
  transferFee: number;
  /** `seller` when the seller cancelled after payment: the customer receives everything they paid. */
  feesPaidBy: 'customer' | 'seller';
  /**
   * The refund line by line, ready to show — "Refund 10,000 · Payment provider fee −200 · Transfer
   * fee −196 · You receive 9,604". Switch on `code` to render another language.
   */
  lines: CustomerRefundLine[];
  /** What the customer receives: `grossAmount − feeAmount`. */
  netAmount: number;
  currency: string;
  /**
   * How the money leaves: `card_refund` (back to the card, full amount), `payout` (a mobile-money
   * transfer), `external` (paid outside the platform by the team), or `null` while undecided.
   */
  channel: 'card_refund' | 'payout' | 'external' | null;
  /** The number the money goes to, masked (`+•••••••••512`). `null` for a card refund, or before a number is known. */
  destinationMasked: string | null;
  /** COD: approved, but the courier has not yet handed the cash over to the platform (R-4). */
  waitingForCash: boolean;
  /** ISO instant the money arrived; `null` until `completed`. */
  completedAt: string | null;
}

/** The fields of a `refund_requests` row the block reads. */
export type CustomerRefundSourceRow = Pick<
  IRefundRequest,
  'status' | 'gross_amount' | 'fee_amount' | 'fee_rate' | 'net_amount' | 'currency' | 'channel' | 'destination' | 'completed_at'
> & Partial<Pick<IRefundRequest, 'fees'>>;

export function toCustomerRefundBlock(row: CustomerRefundSourceRow | null | undefined): CustomerRefundBlock | null {
  if (!row) return null;
  const status = toCustomerRefundStatus(row.status);
  // A request created before 2026-10-22 has no breakdown: its whole fee was the transfer fee.
  const fees = row.fees
    ? {
        paidBy: row.fees.paid_by,
        payinRate: row.fees.payin_rate,
        payinAmount: row.fees.payin_amount,
        payoutRate: row.fees.payout_rate,
        payoutAmount: row.fees.payout_amount,
        net: row.net_amount,
      }
    : { paidBy: 'customer' as const, payinRate: 0, payinAmount: 0, payoutRate: row.fee_rate ?? 0, payoutAmount: row.fee_amount, net: row.net_amount };
  return {
    status,
    grossAmount: row.gross_amount,
    feeAmount: row.fee_amount,
    feePercent: fees.payoutRate,
    paymentFee: fees.payinAmount,
    paymentFeePercent: fees.payinRate,
    transferFee: fees.payoutAmount,
    feesPaidBy: fees.paidBy === 'vendor' ? 'seller' : 'customer',
    lines: customerRefundLines(fees, row.gross_amount),
    netAmount: row.net_amount,
    currency: row.currency,
    channel: row.channel ?? null,
    destinationMasked: maskRefundPhone(row.destination?.phone ?? null),
    waitingForCash: row.status === 'waiting_for_cash',
    completedAt: row.status === 'completed' && row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}
