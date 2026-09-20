import { Request, Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { Booking } from '../models/booking.model';
import { BookingService } from '../services/booking.service';
import { BookingStatus } from '../types/booking.types';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../catalog/repositories/mongo/variant.repository.mongo';
import { BookingPriceResolver } from '../../catalog/domain/services/booking/BookingPriceResolver';
import { CompletionPricingService } from '../../catalog/domain/services/booking/CompletionPricingService';

const bookingService = new BookingService();
const completionPricingService = new CompletionPricingService(
    new ProductRepositoryMongo(),
    new BookingPriceResolver(new VariantRepositoryMongo()),
    bookingService,
);

// ─── Validation Schemas ────────────────────────────────────────────────────────

/** All valid booking statuses as a const tuple for Zod */
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
    'refund_pending',
    'refunded',
] as const;

const ListBookingsSchema = z
    .object({
        status: z.enum(BOOKING_STATUSES).optional(),
        paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
        productId: z.string().optional(),
        startDate: z.string().datetime({ offset: true }).optional(),
        endDate: z.string().datetime({ offset: true }).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .refine(
        (d) => !(d.startDate && d.endDate && new Date(d.startDate) > new Date(d.endDate)),
        { message: 'startDate must be before or equal to endDate', path: ['startDate'] }
    );

const UpdateBookingStatusSchema = z.object({
    status: z.enum(BOOKING_STATUSES),
});

const RescheduleBookingSchema = z.object({
    newSlotId: z.string().min(1, 'newSlotId is required'),
});

/**
 * ⚠ **`slotId`, not `newSlotId`.** The hold names the time being taken; the reschedule names the
 * time being moved TO. Two names for two calls is worth the asymmetry — a dashboard that sends
 * `newSlotId` here gets a validation error naming the field, rather than a hold on `undefined`.
 */
const HoldSlotSchema = z.object({
    slotId: z.string().min(1, 'slotId is required'),
});

const CancelBookingSchema = z.object({
    reason: z.string().max(500).optional(),
});

// Omitted amount means "the whole outstanding balance", which is the common case.
// A partial is allowed for a customer who paid some of it now and some later.
const SettleBalanceSchema = z.object({
    amount: z.number().positive().optional(),
});

// Completion settlement input. At most one pricing mode: a flat fixedPrice, OR a
// duration-based recompute via actualEndAt / additionalMinutes. None ⇒ settle at the
// originally booked duration.
const CompleteBookingSchema = z.object({
    actualEndAt: z.string().datetime({ offset: true }).optional(),
    additionalMinutes: z.number().int().min(1).optional(),
    fixedPrice: z.number().min(0).optional(),
})
    .refine((d) => !(d.fixedPrice !== undefined && (d.actualEndAt !== undefined || d.additionalMinutes !== undefined)), {
        message: 'fixedPrice cannot be combined with actualEndAt or additionalMinutes',
        path: ['fixedPrice'],
    })
    .refine((d) => !(d.actualEndAt !== undefined && d.additionalMinutes !== undefined), {
        message: 'Provide either actualEndAt or additionalMinutes, not both',
        path: ['additionalMinutes'],
    });

const CalendarViewSchema = z
    .object({
        startDate: z.string().datetime({ offset: true }),
        endDate: z.string().datetime({ offset: true }),
    })
    .refine(
        (d) => new Date(d.startDate) <= new Date(d.endDate),
        { message: 'startDate must be before or equal to endDate', path: ['startDate'] }
    )
    .refine(
        (d) => {
            const diffMs = new Date(d.endDate).getTime() - new Date(d.startDate).getTime();
            const diffDays = diffMs / (1000 * 60 * 60 * 24);
            return diffDays <= 90;
        },
        { message: 'Date range cannot exceed 90 days', path: ['endDate'] }
    );

// ─── Controller ────────────────────────────────────────────────────────────────

/**
 * VendorBookingController
 *
 * Manages bookings for vendors with calendar sync and state machine enforcement.
 * All handlers are thin: parsing/validation happens here, logic lives in BookingService.
 *
 * Errors are raised with createAppError and propagated to the global error handler
 * via asyncHandler — never written inline.
 */
export class VendorBookingController {
    /**
     * GET /api/vendor/bookings
     *
     * List vendor bookings with filtering and pagination.
     * Supported filters: status, paymentStatus, productId, startDate, endDate, page, limit.
     */
    static listBookings = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const query = ListBookingsSchema.parse(req.query);

        const filter: Record<string, any> = {
            vendorId: new Types.ObjectId(vendorId),
            deletedAt: null,
        };

        if (query.status) filter.status = query.status;
        if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
        if (query.productId) filter.productId = new Types.ObjectId(query.productId);

        if (query.startDate || query.endDate) {
            filter.startAt = {};
            if (query.startDate) filter.startAt.$gte = new Date(query.startDate);
            if (query.endDate) filter.startAt.$lte = new Date(query.endDate);
        }

        const { page, limit } = query;

        const [total, bookings] = await Promise.all([
            Booking.countDocuments(filter),
            Booking.find(filter)
                .sort({ startAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .populate('productId', 'title type')
                .populate('userId', 'login_email'),
        ]);

        res.json({
            success: true,
            data: bookings,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        });
    });

    /**
     * GET /api/vendor/bookings/:id
     * Retrieve a single booking by ID (must belong to vendor).
     */
    static getBooking = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;

        // NOTE: this used to populate 'productId customerId'. There is no
        // `customerId` on the booking — the customer is `userId` — and Mongoose 8
        // rejects unknown populate paths (`strictPopulate` defaults to true), so
        // this endpoint threw a 500 on every call. Do NOT "fix" that by disabling
        // strictPopulate: it is what surfaced the typo.
        const booking = await Booking.findOne({
            _id: id,
            vendorId: new Types.ObjectId(vendorId),
            deletedAt: null,
        })
            .populate('productId', 'title type')
            .populate('userId', 'login_email login_phone');

        if (!booking) {
            throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
        }

        res.json({ success: true, data: booking });
    });

    /**
     * PATCH /api/vendor/bookings/:id/status
     * Update booking status with state machine enforcement and calendar sync.
     */
    static updateBookingStatus = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;

        const { status } = UpdateBookingStatusSchema.parse(req.body);

        const updatedBooking = await bookingService.updateBookingStatus(
            id,
            vendorId,
            status as any,
        );

        res.json({
            success: true,
            data: updatedBooking,
            message: 'Booking status updated',
        });
    });

    /**
     * POST /api/vendor/bookings/:id/complete
     *
     * Mark a service appointment completed and settle its final price. The price is
     * recomputed from the actual elapsed duration (base price per configured unit,
     * prorated, plus any peak surcharge), or taken as a flat `fixedPrice`.
     *
     * Body (all optional): { actualEndAt?, additionalMinutes?, fixedPrice? }
     *
     * NOTE: when the final price exceeds the booked snapshot, the shortfall is returned
     * as `additionalAmountDue` and recorded on the booking, but the additional-payment
     * request to the customer is STUBBED (not yet created). See CompletionPricingService.
     */
    static completeBooking = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;

        const input = CompleteBookingSchema.parse(req.body);

        const result = await completionPricingService.completeBooking(id, vendorId, input);

        res.json({
            success: true,
            data: {
                booking: result.booking,
                priceSnapshot: result.priceSnapshot,
                finalPrice: result.finalPrice,
                additionalAmountDue: result.additionalAmountDue,
                // Say plainly that the shortfall is only RECORDED. A client that saw
                // `additionalAmountDue: 3000` and nothing else would reasonably render
                // "3000 charged" — nothing charges it. Collecting it needs a second
                // payment intent against an already-paid booking, which is a separate
                // build (see CompletionPricingService's TODO).
                additionalAmountCharged: false,
                additionalAmountNote:
                    result.additionalAmountDue > 0
                        ? 'Recorded only — not charged. Collect this from the customer directly.'
                        : null,
                breakdown: result.recalculated?.breakdown,
            },
            message: 'Booking completed',
        });
    });

    /**
     * PATCH /api/vendor/bookings/:id/payment-status
     *
     * Mark a cash booking as paid. Vendor-only.
     * Only valid when: paymentMethod is cash (or unset), booking is unpaid, requiresPayment is true.
     */
    static markAsPaid = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;

        const booking = await bookingService.markAsPaidByCash(id, vendorId);

        res.json({
            success: true,
            data: {
                bookingId: booking._id,
                paymentStatus: booking.paymentStatus,
                paymentMethod: booking.paymentMethod,
                paidAt: booking.paidAt,
            },
            message: 'Booking marked as paid',
        });
    });

    /**
     * POST /api/vendor/bookings/:id/settle-balance
     *
     * Record that the outstanding balance was paid in cash, on the day.
     * Body (optional): { amount?: number } — defaults to the whole balance.
     *
     * A service business usually collects an overrun at the counter rather than
     * chasing an online payment; without this the balance sits open forever on a
     * booking the vendor considers finished.
     */
    static settleBalanceByCash = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { amount } = SettleBalanceSchema.parse(req.body ?? {});

        const booking = await bookingService.settleBalanceByCash(req.params.id, vendorId, amount);

        res.json({
            success: true,
            data: {
                bookingId: booking._id,
                balanceDue: booking.settlement?.balanceDue ?? 0,
                balancePaid: booking.settlement?.balancePaid ?? 0,
                outstanding: Math.max(
                    0,
                    (booking.settlement?.balanceDue ?? 0) - (booking.settlement?.balancePaid ?? 0)
                ),
                balancePaymentMethod: booking.settlement?.balancePaymentMethod ?? null,
            },
            message: 'Balance settled in cash',
        });
    });

    /**
     * PATCH /api/vendor/bookings/:id/reschedule
     *
     * Reschedule a booking to a new slot. Uses existing slot-lock mechanism.
     * The vendor must have locked the new slot before calling this endpoint.
     * Eligibility: booking must be pending or confirmed.
     *
     * ⛔ **Two different ids, and swapping either one breaks the route for every shop.**
     * The HOLD is checked against the vendor's USER id, because that is the only id any hold is
     * ever written under: `POST /api/products/:productId/slots/:slotId/lock` takes the owner from
     * `req.auth.user`, whoever is signed in. The BOOKING is scoped by the VENDOR id (the role
     * entity), because that is what `booking.vendorId` holds. From 2026-02-23 until 2026-09-19
     * this passed the vendor id for both, so the hold the dashboard had just taken never matched:
     * a single-seat service answered 403 "locked by another user" (the other user was the shop
     * itself) and a group class 409 "not locked". No shop could move an appointment.
     * `test:booking-slot-offer` § 10 runs this handler and the lock route with one signed-in
     * vendor and pins that both name the same hold owner.
     */
    static rescheduleBooking = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const holdOwnerId = req.auth!.user._id.toString();
        const { id } = req.params;

        const { newSlotId } = RescheduleBookingSchema.parse(req.body);

        // Ownership scoping and the pending/confirmed eligibility check both live in
        // the service now, so the vendor and customer paths cannot drift apart.
        const updatedBooking = await bookingService.rescheduleBooking(
            id,
            newSlotId,
            holdOwnerId,
            { role: 'vendor', id: vendorId },
        );

        res.json({
            success: true,
            data: updatedBooking,
            message: 'Booking rescheduled',
        });
    });

    /**
     * POST /api/vendor/bookings/:id/slot-hold
     *
     * Hold any time the shop rule allows, so the appointment can then be moved onto it.
     *
     * ⚠ **This exists because the shop rule was unreachable.** A move needs a hold, and the only
     * route that takes one is the storefront's slot lock, which refuses anything outside the
     * shop's published hours. So "a shop may move an appointment outside its opening hours"
     * (owner, 2026-09-16) failed one step earlier, at the hold, for every shop.
     *
     * ⚠ **The same two ids as the reschedule above, for the same reason** — the hold under the
     * signed-in USER, the booking scoped by the VENDOR entity. The service applies the identical
     * rule the move will apply, so this door can never grant a time the next call refuses.
     */
    static holdSlot = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const holdOwnerId = req.auth!.user._id.toString();
        const { slotId } = HoldSlotSchema.parse(req.body ?? {});

        const hold = await bookingService.holdSlotForReschedule(
            req.params.id,
            slotId,
            holdOwnerId,
            { role: 'vendor', id: vendorId },
        );

        res.json({
            success: true,
            data: {
                held: true,
                slotId: hold.slotId,
                startAt: hold.start,
                endAt: hold.end,
                expiresAt: hold.expiresAt,
            },
            message: 'Slot held',
        });
    });

    /**
     * POST /api/vendor/bookings/:id/cancel
     *
     * Cancel a vendor's booking with an optional reason.
     * Returns 409 Conflict on double-cancel or if booking is in a terminal state.
     */
    static cancelBooking = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;

        const { reason } = CancelBookingSchema.parse(req.body);

        const booking = await bookingService.cancelVendorBooking(id, vendorId, reason);

        res.json({
            success: true,
            data: booking,
            message: 'Booking cancelled',
        });
    });

    /**
     * GET /api/vendor/bookings/calendar
     *
     * Returns bookings grouped by date (YYYY-MM-DD) for calendar display.
     * startDate and endDate are required. Max range: 90 days.
     *
     * `data` keeps its array shape. The zone the day keys were computed in goes in
     * `meta.timezone` (added 2026-09-09 with the grouping fix) — without it a client
     * cannot re-derive a key from `startAt` and agree with the server, which is what
     * the api-doc used to have to warn them about.
     */
    static getCalendarView = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { startDate, endDate } = CalendarViewSchema.parse(req.query);

        const { timezone, days } = await bookingService.getCalendarView(
            vendorId,
            new Date(startDate),
            new Date(endDate),
        );

        res.json({ success: true, data: days, meta: { timezone } });
    });
}
