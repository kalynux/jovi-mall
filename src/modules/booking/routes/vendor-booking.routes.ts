import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { VendorBookingController } from '../controllers/vendor-booking.controller';

const router = Router();

// Apply authentication & vendor role guard to all routes below
router.use(requireAuth);
router.use(requireRole(['vendor']));

/**
 * BOOKING LISTING & VIEWS
 *
 * IMPORTANT: /bookings/calendar MUST be declared before /bookings/:id
 * to prevent Express treating 'calendar' as a dynamic :id param.
 */

/**
 * GET /api/vendor/bookings/calendar
 * Calendar-grouped view of bookings for a date range.
 * Query: startDate (ISO, required), endDate (ISO, required). Max range: 90 days.
 */
router.get('/calendar', VendorBookingController.getCalendarView);

/**
 * GET /api/vendor/bookings
 * List vendor bookings with filtering and pagination.
 * Query: status, paymentStatus, productId, startDate, endDate, page, limit.
 */
router.get('/', VendorBookingController.listBookings);

/**
 * GET /api/vendor/bookings/:id
 * Get a single booking by ID.
 */
router.get('/:id', VendorBookingController.getBooking);

/**
 * BOOKING MUTATIONS
 */

/**
 * PATCH /api/vendor/bookings/:id/status
 * Transition booking status (state machine enforced, with calendar sync).
 * Body: { status: 'pending' | 'confirmed' | 'completed' | 'no-show' | 'cancelled' }
 */
router.patch('/:id/status', VendorBookingController.updateBookingStatus);

/**
 * POST /api/vendor/bookings/:id/complete
 * Mark a service appointment completed and settle its final price (recomputed from the
 * actual elapsed duration, or a flat fixedPrice).
 * Body (all optional): { actualEndAt?: ISO, additionalMinutes?: number, fixedPrice?: number }
 */
router.post('/:id/complete', VendorBookingController.completeBooking);

/**
 * PATCH /api/vendor/bookings/:id/payment-status
 * Mark a cash booking as paid.
 * Rules: paymentMethod must be 'cash' or unset, booking must be unpaid.
 */
router.patch('/:id/payment-status', VendorBookingController.markAsPaid);

/**
 * POST /api/vendor/bookings/:id/settle-balance
 * Record the completion balance as collected in cash.
 * Body (optional): { amount?: number } — defaults to the whole outstanding balance.
 * Distinct from /payment-status, which settles the ORIGINAL price.
 */
router.post('/:id/settle-balance', VendorBookingController.settleBalanceByCash);

/**
 * POST /api/vendor/bookings/:id/slot-hold
 * Hold any time this shop's own rule allows — same length as the appointment, in the future,
 * free — so it can then be rescheduled onto it. Published opening hours are NOT consulted; that
 * is what this door is for, and it is why the storefront's lock route cannot serve it.
 * Body: { slotId: string }
 */
router.post('/:id/slot-hold', VendorBookingController.holdSlot);

/**
 * PATCH /api/vendor/bookings/:id/reschedule
 * Reschedule to a new slot. The vendor must have locked the slot first — inside published hours
 * through the storefront's lock route, or anywhere the shop rule allows through /slot-hold above.
 * Body: { newSlotId: string }
 * Eligibility: pending or confirmed bookings only.
 */
router.patch('/:id/reschedule', VendorBookingController.rescheduleBooking);

/**
 * POST /api/vendor/bookings/:id/cancel
 * Cancel a booking with an optional reason.
 * Returns 409 on double-cancel or terminal state.
 * Body: { reason?: string }
 */
router.post('/:id/cancel', VendorBookingController.cancelBooking);

export default router;
