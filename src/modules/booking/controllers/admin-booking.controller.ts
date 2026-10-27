import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { adminCallerActor } from '../../../api/middlewares/admin-caller.middleware';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { currentRequestContext } from '../../../core/logging/request-context';
import { IBooking } from '../models/booking.model';
import { adminBookingService } from '../services/admin-booking.service';

/**
 * Booking administration — the write surface wi-admin delegates to (`/api/internal/admin/bookings`,
 * ADMIN-BOOKINGS-PLAN § 4). Every handler is a thin wrapper: the rules live in `BookingService` and
 * `AdminBookingService`, which the customer and vendor paths share.
 *
 * ── Every answer is a THIN acknowledgement ────────────────────────────────────
 * Never the booking document: it carries the customer's address, the meeting link and the raw
 * metadata, and wi-admin re-reads its own projection after each write anyway (the order module's
 * `readOrderDetail` lesson, DATA-EXPOSURE-REGISTER § 6).
 */

const ReasonSchema = z.string().trim().min(3).max(500);
const FaultSchema = z.enum(['vendor', 'customer']);

const CancelSchema = z.object({ reason: ReasonSchema, fault: FaultSchema }).strict();
const CompleteSchema = z.object({ reason: ReasonSchema }).strict();
const OptionalReasonSchema = z.object({ reason: ReasonSchema.optional() }).strict();
const SessionCancelSchema = z.object({
  startAt: z.coerce.date(),
  reason: ReasonSchema,
  fault: FaultSchema,
}).strict();
const AvailabilityQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
}).refine((q) => q.to.getTime() > q.from.getTime(), { message: '`to` must be after `from`', path: ['to'] })
  .refine((q) => q.to.getTime() - q.from.getTime() <= 31 * 24 * 3_600_000, {
    message: 'At most 31 days at a time',
    path: ['to'],
  });

/** What changed, and how to recognise the booking — nothing else. */
function ack(booking: IBooking) {
  return {
    id: booking._id.toString(),
    bookingNumber: booking.bookingNumber ?? null,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    rescheduleProposalStatus: booking.rescheduleProposal?.status ?? null,
  };
}

/** The acting administrator's id. wi-admin always sends it; a call without one is refused. */
function adminIdOf(req: Request): string {
  const actor = adminCallerActor(req);
  if (!actor) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'X-Actor-Id is required on booking administration');
  }
  return actor.id;
}

export class AdminBookingController {
  /** POST /:bookingId/cancel — `{ reason, fault }`. The customer is refunded through the ordinary cancellation refund. */
  static cancel = asyncHandler(async (req: Request, res: Response) => {
    const { reason, fault } = CancelSchema.parse(req.body ?? {});
    const booking = await adminBookingService.cancel(req.params.bookingId, adminIdOf(req), reason, fault);
    sendSuccess(res, ack(booking), { message: 'Booking cancelled' });
  });

  /** POST /:bookingId/complete — `{ reason }`. The vendor is paid once the ordinary hold ends. */
  static complete = asyncHandler(async (req: Request, res: Response) => {
    const { reason } = CompleteSchema.parse(req.body ?? {});
    const booking = await adminBookingService.complete(req.params.bookingId, adminIdOf(req), reason);
    sendSuccess(res, ack(booking), { message: 'Booking completed' });
  });

  /** POST /:bookingId/payment/recheck — ask the provider about a payment stuck at `pending`. */
  static recheckPayment = asyncHandler(async (req: Request, res: Response) => {
    OptionalReasonSchema.parse(req.body ?? {});
    const result = await adminBookingService.recheckPayment(req.params.bookingId);
    sendSuccess(res, result, { message: `Payment re-checked: ${result.outcome}` });
  });

  /** POST /:bookingId/payment/cash — record that the customer paid the vendor in cash. */
  static markCashPaid = asyncHandler(async (req: Request, res: Response) => {
    OptionalReasonSchema.parse(req.body ?? {});
    const booking = await adminBookingService.markCashPaid(req.params.bookingId);
    sendSuccess(res, ack(booking), { message: 'Cash payment recorded' });
  });

  /** POST /:bookingId/proposal/withdraw — withdraw the open proposal of a new time, either side's. */
  static withdrawProposal = asyncHandler(async (req: Request, res: Response) => {
    OptionalReasonSchema.parse(req.body ?? {});
    const booking = await adminBookingService.withdrawProposal(req.params.bookingId);
    sendSuccess(res, ack(booking), { message: 'Proposal withdrawn — the original time stands' });
  });

  /** POST /:bookingId/reminder — send the customer the appointment reminder again. */
  static resendReminder = asyncHandler(async (req: Request, res: Response) => {
    OptionalReasonSchema.parse(req.body ?? {});
    const result = await adminBookingService.resendReminder(req.params.bookingId, currentRequestContext()?.requestId ?? String(Date.now()));
    sendSuccess(res, result, {
      message: result.sent ? 'Reminder sent' : 'Nothing sent — this booking has no customer profile to notify',
    });
  });

  /** GET /:bookingId/access-state — can the customer see the link yet, and why not. Never the link itself. */
  static accessState = asyncHandler(async (req: Request, res: Response) => {
    const verdict = await adminBookingService.accessState(req.params.bookingId);
    sendSuccess(res, verdict);
  });

  /** GET /services/:productId/availability?from&to — the times a customer would be offered. */
  static availability = asyncHandler(async (req: Request, res: Response) => {
    const { from, to } = AvailabilityQuerySchema.parse(req.query);
    const slots = await adminBookingService.availability(req.params.productId, from, to);
    sendSuccess(res, { productId: req.params.productId, from, to, slots });
  });

  /** POST /services/:productId/sessions/cancel — `{ startAt, reason, fault }`. Every live seat of one class. */
  static cancelSession = asyncHandler(async (req: Request, res: Response) => {
    const { startAt, reason, fault } = SessionCancelSchema.parse(req.body ?? {});
    const result = await adminBookingService.cancelSession(req.params.productId, startAt, adminIdOf(req), reason, fault);
    sendSuccess(res, result, {
      message: result.failed.length === 0
        ? `Cancelled ${result.cancelled.length} booking(s)`
        : `Cancelled ${result.cancelled.length} booking(s); ${result.failed.length} could not be cancelled`,
    });
  });
}
