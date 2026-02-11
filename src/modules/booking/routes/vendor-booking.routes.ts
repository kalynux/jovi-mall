import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { VendorBookingController } from '../controllers/vendor-booking.controller';
import { VendorAvailabilityController } from '../controllers/vendor-availability.controller';

const router = Router();

// Apply authentication
router.use(requireAuth);
router.use(requireRole(['vendor']));

/**
 * BOOKING MANAGEMENT
 */

/**
 * GET /api/vendor/bookings
 * List all bookings for vendor
 */
router.get('/bookings', VendorBookingController.listBookings);

/**
 * GET /api/vendor/bookings/:id  
 * Get a single booking
 */
router.get('/bookings/:id', VendorBookingController.getBooking);

/**
 * PATCH /api/vendor/bookings/:id/status
 * Update booking status (with state machine validation)
 */
router.patch('/bookings/:id/status', VendorBookingController.updateBookingStatus);

/**
 * AVAILABILITY RULES
 */

// Note: Availability routes are organized by product
// See vendor-products.routes.ts for product-specific availability routes

export default router;
