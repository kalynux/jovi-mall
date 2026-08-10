import { IBooking } from '../models/booking.model';
import { BookingCalendarSyncService } from './booking-calendar-sync.service';
import { PaymentOrchestratorService } from '../../payments/services/payment-orchestrator.service';
import { earningsRefundService } from '../../earnings/services/earnings-refund.service';
import { ticketService } from '../../tickets/services/ticket.service';
import { TicketType, EntityType, TicketImportance } from '../../tickets/types/ticket.types';
import { AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/** What happened to the money when a paid booking was cancelled. */
export type BookingRefundOutcome =
  | { status: 'not_applicable'; reason: string }
  | { status: 'refunded'; refundId: string; amount: number; currency: string }
  | { status: 'refund_pending'; reason: string };

/**
 * BookingRefundService — returns a cancelled booking's money.
 *
 * WHY THIS EXISTS: cancelling a paid booking previously refunded nothing at all.
 * The plumbing was there — `RefundTransaction` even carries a `bookingId` — but
 * the only thing that ever reached it was a Stripe chargeback. A customer who
 * cancelled inside the vendor's own cancellation window simply lost their money.
 *
 * Layered above `PaymentOrchestratorService` exactly as `VendorRefundService` is:
 * eligibility and the fallback policy live here, the money invariants live there.
 *
 * ── Auto where possible, ticket otherwise ───────────────────────────────────
 *
 * Only Stripe has a real `refundPayment` implementation today; NotchPay's and
 * MyCoolPay's are explicitly marked PLACEHOLDER, and cash has no gateway at all.
 * Rather than pretend, an un-refundable payment is marked `refund_pending` and a
 * HIGH-importance ticket is raised so a human completes the payout. The customer's
 * escrowed earnings are reversed either way, so the vendor is never paid for a
 * service that was cancelled.
 *
 * ── Never blocks the cancellation ───────────────────────────────────────────
 *
 * Every path here is best-effort. A refund that cannot be issued must not leave
 * the appointment on the books: releasing the slot is the more urgent of the two,
 * and money owed is recoverable from the ticket. Callers invoke this AFTER the
 * cancellation has committed.
 */
export class BookingRefundService {
  private orchestrator?: PaymentOrchestratorService;
  private readonly calendarSync: BookingCalendarSyncService;

  constructor(
    orchestrator?: PaymentOrchestratorService,
    calendarSync: BookingCalendarSyncService = new BookingCalendarSyncService()
  ) {
    this.orchestrator = orchestrator;
    this.calendarSync = calendarSync;
  }

  /**
   * The orchestrator is built on FIRST USE, not at module load.
   *
   * This module is reached from `BookingService`, and the orchestrator reaches
   * back into the booking models and calendar sync. Constructing it while this
   * module is still initialising is how a require cycle turns into a boot-time
   * "X is not a constructor" — the same failure the agents barrel documents.
   */
  private getOrchestrator(): PaymentOrchestratorService {
    if (!this.orchestrator) {
      this.orchestrator = new PaymentOrchestratorService();
    }
    return this.orchestrator;
  }

  /**
   * Refunds a cancelled booking, if there is anything to refund.
   *
   * @param booking The already-cancelled booking.
   * @param initiatedBy The acting user's id.
   * @param initiatedByRole Who cancelled — drives the RefundTransaction audit trail.
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

    // Cash never went through a gateway, so there is nothing to reverse
    // electronically — the vendor holds the notes and hands them back.
    if (booking.paymentMethod === 'cash') {
      return this.markPendingManualRefund(
        booking,
        'Cash payment — refund must be handed back by the vendor',
        reason
      );
    }

    try {
      const result = await this.getOrchestrator().refundPayment({
        source: { kind: 'booking', bookingId },
        vendorId: booking.vendorId.toString(),
        initiatedBy,
        initiatedByRole,
        amount: booking.priceSnapshot,
        reason: reason || 'Booking cancelled',
      });

      // The orchestrator has already flipped paymentStatus and reversed earnings on
      // a full refund; refresh the calendar event's colour to match.
      await this.syncCalendar(booking);

      return {
        status: 'refunded',
        refundId: result.refundId,
        amount: result.amount,
        currency: result.currency,
      };
    } catch (error) {
      // A gateway that cannot refund is an EXPECTED outcome here, not a failure —
      // it is the normal path for mobile money today.
      const code = error instanceof AppError ? error.code : undefined;
      const recoverable =
        code === ERROR_CODES.REFUND_GATEWAY_NOT_SUPPORTED ||
        code === ERROR_CODES.REFUND_GATEWAY_FAILED ||
        code === ERROR_CODES.REFUND_PAYMENT_NOT_FOUND;

      if (!recoverable) {
        console.error('[BookingRefundService] Unexpected refund failure:', error);
      }

      return this.markPendingManualRefund(
        booking,
        recoverable
          ? `Gateway could not process the refund automatically (${code})`
          : `Refund failed unexpectedly (${code ?? 'unknown'})`,
        reason
      );
    }
  }

  /**
   * Flags the booking as owing a refund, reverses the vendor's escrowed earnings,
   * and raises a ticket for a human to complete the payout.
   *
   * Earnings are reversed even though the customer has not been paid yet: the
   * service was cancelled, so the vendor must not keep the money either. The
   * platform now holds it, which is exactly what the ticket is about.
   */
  private async markPendingManualRefund(
    booking: IBooking,
    cause: string,
    reason?: string
  ): Promise<BookingRefundOutcome> {
    const bookingId = booking._id.toString();

    try {
      booking.paymentStatus = 'refund_pending';
      await booking.save();
    } catch (error) {
      console.error('[BookingRefundService] Failed to flag booking refund_pending:', error);
    }

    try {
      await earningsRefundService.onRefund('booking', bookingId);
    } catch (error) {
      console.error('[BookingRefundService] Failed to reverse booking earnings:', error);
    }

    await this.syncCalendar(booking);

    try {
      await ticketService.createSystemTicket({
        type: TicketType.PAYMENT_ISSUE,
        entityType: EntityType.BOOKING,
        entityId: bookingId,
        subject: `Manual refund required for booking ${bookingId}`,
        description:
          `Booking ${bookingId} was cancelled after payment and needs a manual refund.\n` +
          `Amount: ${booking.priceSnapshot} ${booking.currency}\n` +
          `Payment method: ${booking.paymentMethod ?? 'unknown'}\n` +
          `Cause: ${cause}\n` +
          `Cancellation reason: ${reason ?? 'not given'}\n\n` +
          `Vendor earnings have been reversed; the customer has NOT yet been paid.`,
        importance: TicketImportance.HIGH,
      });
    } catch (error) {
      console.error('[BookingRefundService] Failed to open manual-refund ticket:', error);
    }

    return { status: 'refund_pending', reason: cause };
  }

  /** Calendar colour/title follow payment status. Never fatal. */
  private async syncCalendar(booking: IBooking): Promise<void> {
    try {
      await this.calendarSync.syncBookingPaymentStatus(booking);
    } catch (error) {
      console.error('[BookingRefundService] Calendar sync failed after refund:', error);
    }
  }
}

export const bookingRefundService = new BookingRefundService();
