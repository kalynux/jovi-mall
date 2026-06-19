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

const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'failed', 'refunded'] as const;

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

const CancelBookingSchema = z.object({
    reason: z.string().max(500).optional(),
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

        const booking = await Booking.findOne({
            _id: id,
            vendorId: new Types.ObjectId(vendorId),
            deletedAt: null,
        }).populate('productId customerId');

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
     * PATCH /api/vendor/bookings/:id/reschedule
     *
     * Reschedule a booking to a new slot. Uses existing slot-lock mechanism.
     * The vendor must have locked the new slot before calling this endpoint.
     * Eligibility: booking must be pending or confirmed.
     */
    static rescheduleBooking = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;

        const { newSlotId } = RescheduleBookingSchema.parse(req.body);

        // Guard: only pending/confirmed can be rescheduled
        const booking = await Booking.findOne({
            _id: id,
            vendorId: new Types.ObjectId(vendorId),
            deletedAt: null,
        });

        if (!booking) {
            throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
        }

        const reschedulableStatuses: string[] = [BookingStatus.PENDING, BookingStatus.CONFIRMED];
        if (!reschedulableStatuses.includes(booking.status)) {
            throw createAppError(
                ERROR_CODES.BOOKING_NOT_RESCHEDULABLE,
                409,
                `Cannot reschedule a booking with status '${booking.status}'. Only pending or confirmed bookings can be rescheduled.`,
            );
        }

        // The service uses vendorId as the lockOwnerId — vendors lock slots on their behalf
        const updatedBooking = await bookingService.rescheduleBooking(id, newSlotId, vendorId);

        res.json({
            success: true,
            data: updatedBooking,
            message: 'Booking rescheduled',
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
     */
    static getCalendarView = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { startDate, endDate } = CalendarViewSchema.parse(req.query);

        const groups = await bookingService.getCalendarView(
            vendorId,
            new Date(startDate),
            new Date(endDate),
        );

        res.json({ success: true, data: groups });
    });
}
