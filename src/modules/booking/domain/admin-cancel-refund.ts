import type { BookingRefundOutcome } from '../services/booking-refund.service';

/**
 * What an administrator's cancel did about the money, in one word (BR-033 § 4, 2026-10-28).
 *
 * The cancellation commits FIRST and the refund runs after it, best-effort, so a cancel answers
 * 200 whatever the refund did. Before this the outcome was logged and dropped, and the dashboard
 * had to infer it from the booking it re-read — which it cannot do when that re-read misses.
 *
 * - `none`      — nothing was owed (free, unpaid, never collected);
 * - `requested` — a refund request is open, new or already there: the refund queue has it;
 * - `refunded`  — the money is already back;
 * - `manual`    — no request could be opened (always, for cash): a HIGH ticket was raised and the
 *                 booking's earnings are paused until a person settles it;
 * - `failed`    — the refund step threw before it could record anything. The booking is cancelled
 *                 and nothing says a refund is owed — the one outcome nobody else will notice.
 */
export const ADMIN_CANCEL_REFUND_OUTCOMES = ['none', 'requested', 'refunded', 'manual', 'failed'] as const;
export type AdminCancelRefund = (typeof ADMIN_CANCEL_REFUND_OUTCOMES)[number];

/** `null` is how `refundIfPaid` reports that `refundCancelledBooking` threw. */
export function adminCancelRefundOf(outcome: BookingRefundOutcome | null): AdminCancelRefund {
  if (!outcome) return 'failed';
  switch (outcome.status) {
    case 'not_applicable':
      return 'none';
    case 'refund_requested':
    case 'refund_already_open':
      return 'requested';
    case 'refunded':
      return 'refunded';
    case 'refund_pending':
      return 'manual';
  }
}
