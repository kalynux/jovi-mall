import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { BookingService } from '../services/booking.service';
import { BookingStatus } from '../types/booking.types';
import { PaymentOrchestratorService } from '../../payments/services/payment-orchestrator.service';
import { InitiateBookingPaymentSchema } from '../../payments/validators/payment.validators';

const bookingService = new BookingService();
const paymentOrchestrator = new PaymentOrchestratorService();

// ─── Validation Schemas ────────────────────────────────────────────────────────

const BOOKING_STATUSES = [
    BookingStatus.PENDING,
    BookingStatus.CONFIRMED,
    BookingStatus.COMPLETED,
    BookingStatus.NO_SHOW,
    BookingStatus.CANCELLED,
] as const;

const PAYMENT_STATUSES = [
    'unpaid',
    'pending',
    'paid',
    'disputed',
    'failed',
    'refunded',
    'refund_pending',
] as const;

const ListBookingsSchema = z
    .object({
        status: z.enum(BOOKING_STATUSES).optional(),
        paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
        startDate: z.string().datetime({ offset: true }).optional(),
        endDate: z.string().datetime({ offset: true }).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .refine(
        (d) => !(d.startDate && d.endDate && new Date(d.startDate) > new Date(d.endDate)),
        { message: 'startDate must be before or equal to endDate', path: ['startDate'] }
    );

const CancelBookingSchema = z.object({
    reason: z.string().max(500).optional(),
});

const RescheduleBookingSchema = z.object({
    newSlotId: z.string().min(1, 'newSlotId is required'),
});

// ─── Controller ────────────────────────────────────────────────────────────────

/**
 * CustomerBookingController — the customer's own view of their appointments.
 *
 * WHY THIS EXISTS: before it, a customer could create and pay for a booking and
 * then do nothing else. There was no way to list their bookings, open one, move
 * one, or cancel one — `BookingService.cancelBooking` was fully written, complete
 * with the vendor's cancellation-policy check, and simply had no route pointing at
 * it. The policy was therefore enforced nowhere: the vendor path skips it by
 * design, and the customer path was unreachable.
 *
 * Every handler is scoped to `req.auth.user` inside the query, so another
 * customer's booking id is a 404 rather than a 403.
 */
export class CustomerBookingController {
    /**
     * GET /api/customer/bookings
     * The customer's own bookings, filtered and paged.
     */
    static listBookings = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const userId = req.auth!.user._id.toString();
        const query = ListBookingsSchema.parse(req.query);

        const { data, total, page, limit } = await bookingService.getUserBookings(userId, {
            status: query.status,
            paymentStatus: query.paymentStatus,
            startDate: query.startDate ? new Date(query.startDate) : undefined,
            endDate: query.endDate ? new Date(query.endDate) : undefined,
            page: query.page,
            limit: query.limit,
        });

        res.json({
            success: true,
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    });

    /**
     * GET /api/customer/bookings/:id
     * One of the customer's own bookings.
     */
    static getBooking = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const userId = req.auth!.user._id.toString();
        const booking = await bookingService.getUserBooking(req.params.id, userId);

        res.json({ success: true, data: booking });
    });

    /**
     * POST /api/customer/bookings/:id/cancel
     *
     * Cancels the customer's own booking, subject to the vendor's cancellation
     * policy (422 CANCELLATION_NOT_ALLOWED when the window has passed). A paid
     * booking is refunded — automatically where the gateway supports it, otherwise
     * flagged `refund_pending` with a support ticket raised for manual payout.
     */
    static cancelBooking = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const userId = req.auth!.user._id.toString();
        const { reason } = CancelBookingSchema.parse(req.body);

        const booking = await bookingService.cancelBooking(req.params.id, userId, reason);

        res.json({
            success: true,
            data: booking,
            message: 'Booking cancelled',
        });
    });

    /**
     * PATCH /api/customer/bookings/:id/reschedule
     *
     * Moves the booking to another slot. The customer must already hold that slot
     * (`POST /api/products/:productId/slots/:slotId/lock`) — the same rule the
     * vendor endpoint follows, and what stops a reschedule racing a fresh booking.
     */
    static rescheduleBooking = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const userId = req.auth!.user._id.toString();
        const { newSlotId } = RescheduleBookingSchema.parse(req.body);

        const booking = await bookingService.rescheduleBooking(
            req.params.id,
            newSlotId,
            userId, // the customer holds the slot in their own name
            { role: 'customer', id: userId }
        );

        res.json({
            success: true,
            data: booking,
            message: 'Booking rescheduled',
        });
    });

    /**
     * POST /api/customer/bookings/:id/pay-balance
     *
     * Pay the outstanding balance on a completed booking — what a service that
     * ran longer (or cost more) than quoted actually came to.
     *
     * This is a SECOND payment against the same booking. It is never charged
     * automatically: the customer agreed to the quoted price, not to whatever the
     * vendor settles at afterwards, so paying it is their action.
     */
    static payBalance = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const userId = req.auth!.user._id.toString();
        const { gateway, channel } = InitiateBookingPaymentSchema.parse(req.body);

        // Ownership first — this throws 404 for anyone else's booking.
        await bookingService.getUserBooking(req.params.id, userId);

        const result = await paymentOrchestrator.initiateBookingBalancePayment(
            req.params.id,
            gateway,
            channel
        );

        res.json({ success: true, data: result });
    });

    /**
     * GET /api/customer/bookings/:id/balance
     *
     * What (if anything) is still owed on a completed booking, and what was
     * overpaid. Separate from the booking detail so a client can poll it cheaply
     * while a balance payment settles.
     */
    static getBalance = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const userId = req.auth!.user._id.toString();
        const booking = await bookingService.getUserBooking(req.params.id, userId);
        const settlement = booking.settlement;

        res.json({
            success: true,
            data: {
                bookingId: booking._id,
                currency: booking.currency,
                quotedPrice: booking.priceSnapshot,
                finalPrice: settlement?.finalPrice ?? null,
                balanceDue: settlement?.balanceDue ?? 0,
                balancePaid: settlement?.balancePaid ?? 0,
                outstanding: Math.max(
                    0,
                    (settlement?.balanceDue ?? 0) - (settlement?.balancePaid ?? 0)
                ),
                balancePaymentMethod: settlement?.balancePaymentMethod ?? null,
                // Recorded, never auto-refunded — see the booking model.
                creditDue: settlement?.creditDue ?? 0,
                settledAt: settlement?.settledAt ?? null,
            },
        });
    });
}
