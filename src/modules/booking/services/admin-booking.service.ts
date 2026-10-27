import { Types } from 'mongoose';
import { Booking, IBooking } from '../models/booking.model';
import { BookingStatus } from '../types/booking.types';
import { BookingService } from './booking.service';
import { BookingCalendarSyncService } from './booking-calendar-sync.service';
import { computeAppointmentAccess } from '../domain/appointment';
import { bookingReminderWorker } from '../workers/booking-reminder.worker';
import { PaymentTransactionModel, PaymentStatus } from '../../payments/models/payment-transaction.model';
import { PaymentOrchestratorService } from '../../payments/services/payment-orchestrator.service';
import { productBookingService } from '../../catalog/domain/services/booking/product-booking.instance';
import { ProductModel } from '../../catalog/models';
import { CustomerModel } from '../../customers/customer.model';
import { VendorRepository } from '../../vendors/vendor.repository';
import { getCustomerNotificationHandler } from '../../notifications/customer-notification-event-consumer';
import { resolveLanguage } from '../../notifications/catalog/notification-i18n';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * What an administrator may do to a booking besides cancel and complete it (ADMIN-BOOKINGS-PLAN
 * § 4) — each one a thin wrapper over a path that already exists:
 *
 * | Operation | The path it reuses |
 * |---|---|
 * | re-check a stuck payment | `PaymentOrchestratorService.verifyPayment` — the reconciliation sweep's own call |
 * | record a cash payment | `BookingService.markAsPaidByCash` — the vendor's own action |
 * | resend the reminder | the reminder sweep's `booking.reminder` notification |
 * | the access verdict | `computeAppointmentAccess` — what the customer's read applies |
 * | the slots a customer sees | `ProductBookingService.getAvailability` — the storefront's read |
 * | cancel a whole class | `BookingService.cancelAsAdmin`, once per seat |
 *
 * Authorization and the audit row are wi-admin's; this side holds the rules.
 */

/** Statuses the provider can still change. A transaction in one of these is worth asking about. */
const OPEN_PAYMENT: PaymentStatus[] = ['INITIATED', 'PENDING'];
const DEAD_PAYMENT: PaymentStatus[] = ['FAILED', 'CANCELLED'];

export type PaymentRecheckOutcome =
  /** The provider answered and the booking now says so (`paid` or `failed`). */
  | 'settled'
  /** The provider still has it in flight. Nothing changed; ask again later. */
  | 'still_pending'
  /** The last attempt had already failed and the booking was stuck: it now reads `failed`. */
  | 'released';

export interface PaymentRecheckResult {
  outcome: PaymentRecheckOutcome;
  paymentStatusBefore: string;
  paymentStatusAfter: string;
  transaction: { id: string; status: string; gateway: string } | null;
}

export interface SessionCancelResult {
  productId: string;
  startAt: Date;
  cancelled: Array<{ bookingId: string; bookingNumber: string | null }>;
  failed: Array<{ bookingId: string; bookingNumber: string | null; code: string }>;
}

export class AdminBookingService {
  private readonly bookings = new BookingService();
  private readonly orchestrator = new PaymentOrchestratorService();
  private readonly calendarSync = new BookingCalendarSyncService();
  private readonly vendorRepo = new VendorRepository();

  cancel(bookingId: string, adminId: string, reason: string, fault: 'vendor' | 'customer'): Promise<IBooking> {
    return this.bookings.cancelAsAdmin(bookingId, adminId, reason, fault);
  }

  complete(bookingId: string, adminId: string, reason: string): Promise<IBooking> {
    return this.bookings.completeAsAdmin(bookingId, adminId, reason);
  }

  withdrawProposal(bookingId: string): Promise<IBooking> {
    return this.bookings.withdrawProposalAsAdmin(bookingId);
  }

  /**
   * Ask the provider about a booking stuck at `paymentStatus: 'pending'`.
   *
   * Picks the newest PRIMARY attempt (a balance payment is a different charge). Three cases:
   * - still open at our end → `verifyPayment`, the reconciliation sweep's own call: a success runs
   *   the whole success path (booking `paid`, earnings split), a failure runs the failure path,
   *   which releases the booking to `failed`;
   * - already FAILED/CANCELLED and the booking never heard (the defect fixed on 2026-10-26 left
   *   such bookings stuck for good) → the same pending → failed compare-and-set the failure path
   *   now makes;
   * - SUCCEEDED while the booking still reads `pending` → refused with
   *   `BOOKING_PAYMENT_STATE_MISMATCH`: replaying a success path by hand is an engineer's job.
   */
  async recheckPayment(bookingId: string): Promise<PaymentRecheckResult> {
    const booking = await this.findOrThrow(bookingId);
    const before = booking.paymentStatus;
    if (before !== 'pending') {
      throw createAppError(ERROR_CODES.BOOKING_PAYMENT_NOT_PENDING, 409, undefined, { paymentStatus: before });
    }

    const attempts = await PaymentTransactionModel.find({
      bookingId: booking._id,
      purpose: { $nin: ['booking_balance'] },
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('_id status gateway');
    // An attempt still open anywhere wins over the newest row: it is the one the provider holds.
    const live = attempts.find((t) => OPEN_PAYMENT.includes(t.status));
    const latest = live ?? attempts[0] ?? null;
    const ref = (t: typeof latest) => (t ? { id: t._id.toString(), status: t.status as string, gateway: String(t.gateway) } : null);

    if (latest && latest.status === 'SUCCEEDED') {
      throw createAppError(ERROR_CODES.BOOKING_PAYMENT_STATE_MISMATCH, 409, undefined, {
        transactionId: latest._id.toString(),
        gateway: String(latest.gateway),
      });
    }

    if (latest && OPEN_PAYMENT.includes(latest.status)) {
      const verified = await this.orchestrator.verifyPayment(latest._id.toString());
      const after = (await Booking.findById(booking._id).select('paymentStatus'))?.paymentStatus ?? before;
      return {
        outcome: after === 'pending' ? 'still_pending' : 'settled',
        paymentStatusBefore: before,
        paymentStatusAfter: after,
        transaction: { ...ref(latest)!, status: verified.status },
      };
    }

    // No attempt at all, or every attempt is dead: nothing is in flight, so the booking is free to pay again.
    if (!latest || DEAD_PAYMENT.includes(latest.status)) {
      const released = await Booking.findOneAndUpdate(
        { _id: booking._id, paymentStatus: 'pending' },
        { $set: { paymentStatus: 'failed' } },
        { new: true }
      );
      if (released) {
        try {
          await this.calendarSync.syncBookingPaymentStatus(released);
        } catch (error) {
          console.error('[AdminBookingService] Calendar sync failed after releasing a stuck payment:', error);
        }
      }
      return {
        outcome: 'released',
        paymentStatusBefore: before,
        paymentStatusAfter: released?.paymentStatus ?? before,
        transaction: ref(latest),
      };
    }

    // REFUNDED with the booking at `pending` — the same "the record and the booking disagree" case.
    throw createAppError(ERROR_CODES.BOOKING_PAYMENT_STATE_MISMATCH, 409, undefined, {
      transactionId: latest._id.toString(),
      transactionStatus: latest.status,
    });
  }

  /** The vendor's own "the customer paid me in cash", recorded for them — every rule is theirs. */
  async markCashPaid(bookingId: string): Promise<IBooking> {
    const booking = await this.findOrThrow(bookingId);
    return this.bookings.markAsPaidByCash(bookingId, booking.vendorId.toString());
  }

  /**
   * Send the customer the appointment reminder again — the sweep's notification, under a fresh
   * idempotency key so it is not swallowed as a duplicate of the first. Only for a confirmed
   * booking that has not started: reminding someone of something unaccepted or over is worse
   * than silence (the sweep's own rule).
   *
   * The reminder carries no link — the link reaches the customer through their booking, behind
   * the time gate, which is what keeps Support from needing to see it (decision 2).
   */
  async resendReminder(bookingId: string, requestId: string): Promise<{ sent: boolean; reason: string | null }> {
    const booking = await this.findOrThrow(bookingId);
    if (booking.status !== BookingStatus.CONFIRMED || booking.startAt.getTime() <= Date.now()) {
      throw createAppError(ERROR_CODES.BOOKING_REMINDER_NOT_APPLICABLE, 409, undefined, {
        status: booking.status,
        startAt: booking.startAt,
      });
    }

    const customer = await CustomerModel.findOne({ user_id: booking.userId }).select('_id preferences timezone');
    if (!customer) return { sent: false, reason: 'no_customer_profile' };

    const lang = resolveLanguage(customer);
    const [product, vendor] = await Promise.all([
      ProductModel.findById(booking.productId).select('title').lean(),
      this.vendorRepo.findById(booking.vendorId.toString()).catch(() => null),
    ]);

    await getCustomerNotificationHandler().notify({
      situation: 'booking.reminder',
      customerId: customer._id.toString(),
      aggregateType: 'booking',
      aggregateId: booking._id.toString(),
      idempotencyKey: `customer.booking.reminder.resend:${booking._id}:${requestId}`,
      context: {
        bookingId: booking._id.toString(),
        serviceName: (product as { title?: string } | null)?.title ?? '',
        vendorName: vendor?.display_name ?? '',
        whenPhrase: bookingReminderWorker.whenPhrase(booking.startAt, lang),
        startAt: booking.startAt,
      },
    });
    return { sent: true, reason: null };
  }

  /**
   * Whether the customer can see the link and instructions right now, and why not — the verdict
   * `computeAppointmentAccess` gives the customer's own read, WITHOUT the link and instructions
   * themselves. wi-admin reads those from the booking it already holds, behind its own permission.
   */
  async accessState(bookingId: string): Promise<Record<string, unknown> | null> {
    const booking = await this.findOrThrow(bookingId);
    const view = computeAppointmentAccess(booking);
    if (!view) return null;
    const { instructions: _i, meetingUrl: _m, ...verdict } = view;
    return { ...verdict, revealMinutesBefore: booking.access?.revealMinutesBefore ?? null };
  }

  /**
   * The times a customer would be offered for a service, exactly as the storefront computes them.
   * Answers the storefront's own 404 for a service that is not bookable (draft, archived,
   * suspended) — which is itself the answer to "why can't I book this?".
   */
  availability(productId: string, from: Date, to: Date) {
    return productBookingService.getAvailability(productId, from, to);
  }

  /**
   * Cancel every live seat of one class (same service, same start) for the same party and reason.
   * One seat at a time through `cancelAsAdmin`, so each customer gets their own refund and their
   * own message. A seat that fails is reported, not fatal: the others are already cancelled, and a
   * retry picks up only what is still live.
   */
  async cancelSession(
    productId: string,
    startAt: Date,
    adminId: string,
    reason: string,
    fault: 'vendor' | 'customer'
  ): Promise<SessionCancelResult> {
    const seats = await this.bookings.findSessionSeats(productId, startAt);
    if (seats.length === 0) {
      throw createAppError(ERROR_CODES.BOOKING_SESSION_EMPTY, 404, undefined, { productId, startAt });
    }

    const result: SessionCancelResult = { productId, startAt, cancelled: [], failed: [] };
    for (const seat of seats) {
      const ref = { bookingId: seat._id.toString(), bookingNumber: seat.bookingNumber ?? null };
      try {
        await this.bookings.cancelAsAdmin(ref.bookingId, adminId, reason, fault);
        result.cancelled.push(ref);
      } catch (error) {
        const code = (error as { code?: string })?.code ?? 'UNEXPECTED';
        console.error(`[AdminBookingService] Could not cancel seat ${ref.bookingId}:`, error);
        result.failed.push({ ...ref, code });
      }
    }
    return result;
  }

  private async findOrThrow(bookingId: string): Promise<IBooking> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null });
    if (!booking) throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    return booking;
  }
}

export const adminBookingService = new AdminBookingService();
