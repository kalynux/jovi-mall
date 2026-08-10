import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { CustomerBookingController } from '../controllers/customer-booking.controller';

const router = Router();

// Every route below is the customer's own booking record.
router.use(requireAuth);
router.use(requireRole(['customer']));

/**
 * GET /api/customer/bookings
 * The customer's own bookings.
 * Query: status, paymentStatus, startDate, endDate, page, limit.
 */
router.get('/', CustomerBookingController.listBookings);

/**
 * GET /api/customer/bookings/:id
 * One booking. Another customer's id returns 404, never 403.
 *
 * NOTE: no literal path may be added below this line — declare it ABOVE, or
 * Express will match it as an `:id`. See the /bookings/calendar precedent in
 * vendor-booking.routes.ts.
 */
router.get('/:id', CustomerBookingController.getBooking);

/**
 * POST /api/customer/bookings/:id/cancel
 * Cancel, subject to the vendor's cancellation policy.
 * Body: { reason?: string }
 * 422 CANCELLATION_NOT_ALLOWED when the policy window has passed.
 * A paid booking is refunded, or flagged refund_pending with a ticket raised.
 */
router.post('/:id/cancel', CustomerBookingController.cancelBooking);

/**
 * PATCH /api/customer/bookings/:id/reschedule
 * Move to another slot the customer already holds.
 * Body: { newSlotId: string }
 * Eligibility: pending or confirmed bookings only.
 */
router.patch('/:id/reschedule', CustomerBookingController.rescheduleBooking);

/**
 * GET /api/customer/bookings/:id/balance
 * What is still owed on a completed booking (and what was overpaid).
 */
router.get('/:id/balance', CustomerBookingController.getBalance);

/**
 * POST /api/customer/bookings/:id/pay-balance
 * Pay the outstanding balance after a service ran longer than booked.
 * Body: { gateway, channel } — the same shape as POST /api/bookings/:id/pay.
 * 409 BOOKING_NOT_COMPLETED · 400 BOOKING_NO_BALANCE_DUE ·
 * 409 BOOKING_BALANCE_ALREADY_SETTLED
 */
router.post('/:id/pay-balance', CustomerBookingController.payBalance);

export default router;
