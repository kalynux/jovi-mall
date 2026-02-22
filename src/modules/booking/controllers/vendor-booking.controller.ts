import { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { Types } from 'mongoose';
import { AppError } from '../../../core/errors';
import { Booking } from '../models/booking.model';
import { BookingService } from '../services/booking.service';
import { BookingStatus } from '../types/booking.types';

const bookingService = new BookingService();

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
 */
export class VendorBookingController {
    /**
     * GET /api/vendor/bookings
     *
     * List vendor bookings with filtering and pagination.
     * Supported filters: status, paymentStatus, productId, startDate, endDate, page, limit.
     */
    static async listBookings(req: Request, res: Response): Promise<void> {
        try {
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
        } catch (error) {
            VendorBookingController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/bookings/:id
     * Retrieve a single booking by ID (must belong to vendor).
     */
    static async getBooking(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id } = req.params;

            const booking = await Booking.findOne({
                _id: id,
                vendorId: new Types.ObjectId(vendorId),
                deletedAt: null,
            }).populate('productId customerId');

            if (!booking) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Booking not found' },
                });
                return;
            }

            res.json({ success: true, data: booking });
        } catch (error) {
            VendorBookingController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/bookings/:id/status
     * Update booking status with state machine enforcement and calendar sync.
     */
    static async updateBookingStatus(req: Request, res: Response): Promise<void> {
        try {
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
        } catch (error) {
            VendorBookingController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/bookings/:id/payment-status
     *
     * Mark a cash booking as paid. Vendor-only.
     * Only valid when: paymentMethod is cash (or unset), booking is unpaid, requiresPayment is true.
     */
    static async markAsPaid(req: Request, res: Response): Promise<void> {
        try {
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
        } catch (error) {
            VendorBookingController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/bookings/:id/reschedule
     *
     * Reschedule a booking to a new slot. Uses existing slot-lock mechanism.
     * The vendor must have locked the new slot before calling this endpoint.
     * Eligibility: booking must be pending or confirmed.
     */
    static async rescheduleBooking(req: Request, res: Response): Promise<void> {
        try {
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
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Booking not found' },
                });
                return;
            }

            const reschedulableStatuses: string[] = [BookingStatus.PENDING, BookingStatus.CONFIRMED];
            if (!reschedulableStatuses.includes(booking.status)) {
                res.status(409).json({
                    success: false,
                    error: {
                        code: 'INVALID_STATE',
                        message: `Cannot reschedule a booking with status '${booking.status}'. Only pending or confirmed bookings can be rescheduled.`,
                    },
                });
                return;
            }

            // The service uses vendorId as the lockOwnerId — vendors lock slots on their behalf
            const updatedBooking = await bookingService.rescheduleBooking(id, newSlotId, vendorId);

            res.json({
                success: true,
                data: updatedBooking,
                message: 'Booking rescheduled',
            });
        } catch (error) {
            VendorBookingController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/bookings/:id/cancel
     *
     * Cancel a vendor's booking with an optional reason.
     * Returns 409 Conflict on double-cancel or if booking is in a terminal state.
     */
    static async cancelBooking(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id } = req.params;

            const { reason } = CancelBookingSchema.parse(req.body);

            const booking = await bookingService.cancelVendorBooking(id, vendorId, reason);

            res.json({
                success: true,
                data: booking,
                message: 'Booking cancelled',
            });
        } catch (error) {
            VendorBookingController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/bookings/calendar
     *
     * Returns bookings grouped by date (YYYY-MM-DD) for calendar display.
     * startDate and endDate are required. Max range: 90 days.
     */
    static async getCalendarView(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { startDate, endDate } = CalendarViewSchema.parse(req.query);

            const groups = await bookingService.getCalendarView(
                vendorId,
                new Date(startDate),
                new Date(endDate),
            );

            res.json({ success: true, data: groups });
        } catch (error) {
            VendorBookingController.handleError(error, res);
        }
    }

    // ─── Shared Error Handler ──────────────────────────────────────────────────

    private static handleError(error: unknown, res: Response): void {
        if (error instanceof ZodError) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: error.errors },
            });
            return;
        }
        if (error instanceof AppError) {
            res.status(error.statusCode).json({
                success: false,
                error: { code: error.code, message: error.message },
            });
            return;
        }
        console.error('[VendorBookingController]', error);
        res.status(500).json({
            success: false,
            error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' },
        });
    }
}
