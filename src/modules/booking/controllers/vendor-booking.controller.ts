import { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { Types } from 'mongoose';
import { AppError } from '../../../core/errors';
import { Booking } from '../models/booking.model';
import { BookingService } from '../services/booking.service';

const bookingService = new BookingService();

// Zod schema for status update
const UpdateBookingStatusSchema = z.object({
    status: z.enum(['pending', 'confirmed', 'completed', 'cancelled']),
});

/**
 * VendorBookingController
 * 
 * Manages bookings for vendors with calendar sync.
 * Enforces state machine rules.
 */
export class VendorBookingController {
    /**
     * GET /api/vendor/bookings
     * List all bookings for vendor
     */
    static async listBookings(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();

            // Parse query params
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
            const status = req.query.status as string;

            // Build filter
            const filter: any = { vendorId: new Types.ObjectId(vendorId), deletedAt: null };
            if (status) filter.status = status;

            const total = await Booking.countDocuments(filter);
            const bookings = await Booking.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .populate('productId', 'title type')
                .populate('customerId', 'email');

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
     * Get a single booking
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
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
                return;
            }

            res.json({ success: true, data: booking });
        } catch (error) {
            VendorBookingController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/bookings/:id/status
     * Update booking status with calendar sync
     */
    static async updateBookingStatus(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id } = req.params;

            const input = UpdateBookingStatusSchema.parse(req.body);

            // Delegate to service layer
            const updatedBooking = await bookingService.updateBookingStatus(
                id,
                vendorId,
                input.status as any
            );

            res.json({ success: true, data: updatedBooking, message: 'Booking status updated' });
        } catch (error) {
            VendorBookingController.handleError(error, res);
        }
    }

    private static handleError(error: any, res: Response): void {
        if (error instanceof ZodError) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: error.errors } });
            return;
        }
        if (error instanceof AppError) {
            res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
            return;
        }
        console.error('[VendorBookingController]', error);
        res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
    }
}
