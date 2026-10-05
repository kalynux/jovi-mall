import { Booking, IBooking } from '../models/booking.model';
import { BookingCalendarSyncService } from './booking-calendar-sync.service';
import type { RefundRequestService } from '../../payments/services/refund-request.service';
import { earningsPauseService, SYSTEM_PAUSE_ACTOR } from '../../earnings/services/earnings-pause.service';
import { ticketService } from '../../tickets/services/ticket.service';
import { TicketType, EntityType, TicketImportance } from '../../tickets/types/ticket.types';
import { AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/** What happened to the money when a paid booking was cancelled. */
export type BookingRefundOutcome =
  | { status: 'not_applicable'; reason: string }
  /** The money is already back (a card refund completes in the call). */
  | { status: 'refunded'; refundId: string; amount: number; currency: string }
  /**
   * A refund REQUEST is open and the booking reads `paymentStatus: 'refund_pending'`: a transfer
   * to the number that paid is in flight (`sending`), or it waits for an administrator
   * (`awaiting_approval` — no paying number on record; `failed` — the gateway refused it).
   */
  | { status: 'refund_requested'; refundRequestId: string; requestStatus: string; amount: number; currency: string }
  /** No request could be opened (cash, or no payment on record): a person refunds it from a ticket. */
  | { status: 'refund_pending'; reason: string };

/**
 * BookingRefundService — returns a cancelled booking's money (REFUND-FLOW-PLAN § 4, rewired
 * 2026-10-05).
 *
 * WHY THIS EXISTS: cancelling a paid booking previously refunded nothing at all; a customer who
 * cancelled inside the vendor's own cancellation window simply lost their money.
 *
 * ── A SYSTEM refund request, sent automatically (R-2) ──────────────────────────
 * It opens a refund request through `RefundRequestService` as `system`, for everything still
 * refundable on the booking — the primary charge AND a settled balance payment (§ 6.2) — and asks
 * for it to be approved and sent at once:
 *   - card                       → Stripe refunds it in the call → `refunded`;
 *   - mobile money with a number → a transfer to the number that paid (`sending`), fee taken (R-3);
 *   - mobile money with NO number on record → the request waits `awaiting_approval` in the
 *     refund queue for a typed number + proof + a second administrator (R-7).
 *
 * ── `paymentStatus: 'refund_pending'` now means "a refund request is OPEN" ─────
 * Not "a person is paying it by hand" any more. Set by a compare-and-set FROM `paid` only, so a
 * transfer callback that completed the request first (`refunded`) is never overwritten. The
 * request's completion sets `refunded` (full refund). The vocabulary itself is unchanged, so
 * every reader of the field keeps working.
 *
 * ── Earnings are PAUSED, never reversed, before the customer is paid (§ 6.5) ───
 * The request pauses the booking's earnings (`refund_in_progress`) when it opens and recovers
 * them only when the money ARRIVES. The old fallback reversed the vendor's earnings while the
 * customer was still waiting — so a transfer that then failed left nothing to undo and nobody
 * paid. The fallback below (no request possible) PAUSES too, with `booking_cancelled_unrefunded`.
 *
 * ── Never blocks the cancellation ───────────────────────────────────────────
 * Every path is best-effort; callers invoke this AFTER the cancellation committed. Releasing the
 * slot is the more urgent of the two, and money owed is recoverable from the queue or ticket.
 */
export class BookingRefundService {
  private refunds?: RefundRequestService;
  private readonly calendarSync: BookingCalendarSyncService;

  constructor(
    refunds?: RefundRequestService,
    calendarSync: BookingCalendarSyncService = new BookingCalendarSyncService()
  ) {
    this.refunds = refunds;
    this.calendarSync = calendarSync;
  }

  /**
   * The refund service is loaded on FIRST USE, not at module load: this module is reached from
   * `BookingService`, and the payments graph reaches back into the booking models and calendar
   * sync — constructing it while this module initialises is how a require cycle turns into a
   * boot-time "X is not a constructor".
   */
  private async getRefunds(): Promise<RefundRequestService> {
    if (!this.refunds) {
      const { refundRequestService } = await import('../../payments/services/refund-request.service');
      this.refunds = refundRequestService;
    }
    return this.refunds;
  }

  /**
   * Refunds a cancelled booking, if there is anything to refund.
   *
   * @param booking The already-cancelled booking.
   * @param initiatedBy The acting user's id.
   * @param initiatedByRole Who cancelled — recorded on the request's name for the audit trail.
   * @param reason Free-text reason carried onto the refund and any ticket.
   */
  async refundCancelledBooking(
    booking: IBooking,
    initiatedBy: string,
    initiatedByRole: 'customer' | 'vendor' | 'admin',
    reason?: string
  ): Promise<BookingRefundOutcome> {
    const bookingId = booking._id.toString();

    // Nothing was ever owed.
    if (!booking.requiresPayment) {
      return { status: 'not_applicable', reason: 'Booking does not require payment' };
    }

    // Nothing was ever collected. `unpaid`/`pending`/`failed` never took money;
    // `refunded`/`refund_pending` have already been through here (idempotence).
    if (booking.paymentStatus !== 'paid') {
      return {
        status: 'not_applicable',
        reason: `Booking payment status is '${booking.paymentStatus}', not 'paid'`,
      };
    }

    // Cash never went through a gateway: there is no payment to refund from and no number to
    // send to — the vendor holds the notes and hands them back.
    if (booking.paymentMethod === 'cash') {
      return this.markPendingManualRefund(booking, 'Cash payment — refund must be handed back by the vendor', reason);
    }

    let request;
    try {
      const refunds = await this.getRefunds();
      request = await refunds.create({
        source: { kind: 'booking', id: bookingId },
        // Absent: everything still refundable — the primary charge and a settled balance.
        reasonKind: 'cancellation',
        reason: reason || 'Booking cancelled',
        // A cancellation refund is the SYSTEM's (R-2: automatic, to the number that paid). The
        // person who cancelled is recorded, not made the requester: a customer may not approve.
        requestedBy: { id: initiatedBy || null, role: 'system', name: `booking cancelled by ${initiatedByRole}` },
        approveNow: true,
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : undefined;
      if (code === ERROR_CODES.REFUND_ALREADY_OPEN) {
        // Somebody already opened one (an administrator, a retry): that request is the refund.
        await this.flagRefundPending(bookingId);
        return { status: 'refund_pending', reason: 'A refund request is already open for this booking' };
      }
      const expected =
        code === ERROR_CODES.REFUND_PAYMENT_NOT_FOUND ||
        code === ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED ||
        code === ERROR_CODES.REFUND_ORDER_NOT_FOUND;
      if (!expected) console.error('[BookingRefundService] Could not open a refund request:', error);
      return this.markPendingManualRefund(
        booking,
        `A refund request could not be opened (${code ?? 'unexpected'})`,
        reason
      );
    }

    if (request.status === 'completed') {
      // The request's completion already set `refunded` (full) and recorded the ledger.
      await this.syncCalendar(booking);
      return {
        status: 'refunded',
        refundId: request.refund_transaction_ids[request.refund_transaction_ids.length - 1]?.toString() ?? request.id,
        amount: request.gross_amount,
        currency: request.currency,
      };
    }

    await this.flagRefundPending(bookingId);
    await this.syncCalendar(booking);
    return {
      status: 'refund_requested',
      refundRequestId: request.id,
      requestStatus: request.status,
      amount: request.gross_amount,
      currency: request.currency,
    };
  }

  /** `paid → refund_pending`, as a compare-and-set: a request already completed wins. */
  private async flagRefundPending(bookingId: string): Promise<void> {
    try {
      await Booking.updateOne({ _id: bookingId, paymentStatus: 'paid' }, { $set: { paymentStatus: 'refund_pending' } });
    } catch (error) {
      console.error('[BookingRefundService] Failed to flag booking refund_pending:', error);
    }
  }

  /**
   * No refund request is possible (cash, or no payment on record): flag the booking, PAUSE its
   * earnings — never reverse them before the customer is paid (§ 6.5) — and raise a ticket for a
   * person. The pause is `booking_cancelled_unrefunded`; refunding (or a refund request
   * completing later) closes it, an administrator resuming it means "no refund was owed".
   */
  private async markPendingManualRefund(
    booking: IBooking,
    cause: string,
    reason?: string
  ): Promise<BookingRefundOutcome> {
    const bookingId = booking._id.toString();

    await this.flagRefundPending(bookingId);

    try {
      await earningsPauseService.pause(
        { kind: 'booking', id: bookingId },
        'booking_cancelled_unrefunded',
        SYSTEM_PAUSE_ACTOR,
        `Cancelled after payment; refund owed (${cause})`
      );
    } catch (error) {
      console.error('[BookingRefundService] Failed to pause booking earnings:', error);
    }

    await this.syncCalendar(booking);

    try {
      await ticketService.createSystemTicket({
        type: TicketType.PAYMENT_ISSUE,
        entityType: EntityType.BOOKING,
        entityId: bookingId,
        subject: `Manual refund required for booking ${booking.bookingNumber ?? bookingId}`,
        description:
          `Booking ${booking.bookingNumber ?? bookingId} was cancelled after payment and needs a manual refund.\n` +
          `Amount: ${booking.priceSnapshot} ${booking.currency}\n` +
          `Payment method: ${booking.paymentMethod ?? 'unknown'}\n` +
          `Cause: ${cause}\n` +
          `Cancellation reason: ${reason ?? 'not given'}\n\n` +
          `Vendor earnings are PAUSED (not reversed); the customer has NOT yet been paid.`,
        importance: TicketImportance.HIGH,
      });
    } catch (error) {
      console.error('[BookingRefundService] Failed to open manual-refund ticket:', error);
    }

    return { status: 'refund_pending', reason: cause };
  }

  /**
   * Calendar colour/title follow payment status — read fresh, after the writes above. Also copies
   * the fresh status onto the CALLER's document: `BookingService` publishes `booking.cancelled`
   * from that object right after this returns, and the customer's notification says what
   * happened to the money from its `paymentStatus`. Never fatal.
   */
  private async syncCalendar(booking: IBooking): Promise<void> {
    try {
      const fresh = await Booking.findById(booking._id);
      if (!fresh) return;
      booking.paymentStatus = fresh.paymentStatus;
      await this.calendarSync.syncBookingPaymentStatus(fresh);
    } catch (error) {
      console.error('[BookingRefundService] Calendar sync failed after refund:', error);
    }
  }
}

export const bookingRefundService = new BookingRefundService();
