import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { VendorProfileController } from './controller/vendor-profile.controller';
import { VendorCalendarController } from './controller/vendor-calendar.controller';
import { VendorOrderController } from './controller/vendor-order.controller';
import { VendorNotificationController } from './controller/vendor-notification.controller';

const router = Router();

/**
 * Vendor Profile Routes
 * 
 * All routes require authentication and vendor role.
 * Vendor can only access/modify their own profile.
 */

// Apply authentication to all routes
router.use(requireAuth);
router.use(requireRole(['vendor']));

/**
 * GET /api/vendor/profile
 * 
 * Get authenticated vendor's profile
 */
router.get('/profile', VendorProfileController.getProfile);

/**
 * PATCH /api/vendor/profile
 * 
 * Update authenticated vendor's profile
 * 
 * Body: { displayName?, email?, phone?, notificationPreferences?, version }
 */
router.patch('/profile', VendorProfileController.updateProfile);

/**
 * PATCH /api/vendor/profile/password
 * 
 * Change authenticated vendor's password
 * 
 * Body: { oldPassword, newPassword }
 */
router.patch('/profile/password', VendorProfileController.updatePassword);

/**
 * ==========================================
 * CALENDAR INTEGRATION
 * ==========================================
 */

/**
 * GET /api/vendor/calendar/status
 * Get calendar connection status for the vendor
 */
router.get('/calendar/status', VendorCalendarController.getStatus);

/**
 * POST /api/vendor/calendar/connect
 * Initiate OAuth flow for connecting Google Calendar
 */
router.post('/calendar/connect', VendorCalendarController.initiateConnect);

/**
 * POST /api/vendor/calendar/disconnect
 * Disconnect Google Calendar
 */
router.post('/calendar/disconnect', VendorCalendarController.disconnect);

/**
 * ==========================================
 * ORDER MANAGEMENT
 * ==========================================
 */

/**
 * GET /api/vendor/orders
 * List vendor orders with filters and pagination
 */
router.get('/orders', VendorOrderController.listOrders);

/**
 * GET /api/vendor/orders/:id
 * Get order details
 */
router.get('/orders/:id', VendorOrderController.getOrderDetails);

/**
 * PATCH /api/vendor/orders/:id/status
 * Update fulfillment status
 */
router.patch('/orders/:id/status', VendorOrderController.updateFulfillmentStatus);

/**
 * GET /api/vendor/orders/:id/timeline
 * Get order timeline (audit trail)
 */
router.get('/orders/:id/timeline', VendorOrderController.getTimeline);

/**
 * POST /api/vendor/orders/:id/notes
 * Add vendor-internal note
 */
router.post('/orders/:id/notes', VendorOrderController.addNote);

/**
 * GET /api/vendor/orders/:id/notes
 * Get vendor-internal notes
 */
router.get('/orders/:id/notes', VendorOrderController.getNotes);

/**
 * ==========================================
 * NOTIFICATIONS & PREFERENCES
 * ==========================================
 */

/**
 * GET /api/vendor/notifications
 * List vendor notifications with filters and pagination
 */
router.get('/notifications', VendorNotificationController.listNotifications);

/**
 * PATCH /api/vendor/notifications/:id/read
 * Mark single notification as read
 */
router.patch('/notifications/:id/read', VendorNotificationController.markAsRead);

/**
 * POST /api/vendor/notifications/read-all
 * Bulk mark all notifications as read
 */
router.post('/notifications/read-all', VendorNotificationController.markAllAsRead);

/**
 * GET /api/vendor/notification-preferences
 * Get vendor notification preferences
 */
router.get('/notification-preferences', VendorNotificationController.getPreferences);

/**
 * PATCH /api/vendor/notification-preferences
 * Update vendor notification preferences
 */
router.patch('/notification-preferences', VendorNotificationController.updatePreferences);

/**
 * ==========================================
 * ANALYTICS
 * ==========================================
 */

import { vendorAnalyticsRouter } from '../vendors/routes/vendor-analytics.routes';
router.use('/analytics', vendorAnalyticsRouter);

export default router;
