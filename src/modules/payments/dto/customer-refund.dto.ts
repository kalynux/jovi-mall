import type { IRefundRequest } from '../models/refund-request.model';
import type { RefundRequestStatus } from '../domain/refund-status';
import { maskRefundPhone } from '../domain/refund-destination';

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
  /** The transfer fee kept (R-3: 2% by default; 0 for a card refund). */
  feeAmount: number;
  /** The fee rate in percent (e.g. 2), so a screen can say "minus a 2% transfer fee". 0 for a card. */
  feePercent: number;
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
>;

export function toCustomerRefundBlock(row: CustomerRefundSourceRow | null | undefined): CustomerRefundBlock | null {
  if (!row) return null;
  const status = toCustomerRefundStatus(row.status);
  return {
    status,
    grossAmount: row.gross_amount,
    feeAmount: row.fee_amount,
    feePercent: row.fee_rate ?? 0,
    netAmount: row.net_amount,
    currency: row.currency,
    channel: row.channel ?? null,
    destinationMasked: maskRefundPhone(row.destination?.phone ?? null),
    waitingForCash: row.status === 'waiting_for_cash',
    completedAt: row.status === 'completed' && row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}
