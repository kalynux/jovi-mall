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
 * GET /api/vendor/profile/completion-status
 *
 * Get onboarding step + missing fields for the authenticated vendor.
 * Frontend uses this to route to the correct onboarding screen.
 */
router.get('/profile/completion-status', VendorProfileController.getCompletionStatus);

/**
 * PATCH /api/vendor/profile
 *
 * Update authenticated vendor's profile (general, outside onboarding flow).
 * Body: { displayName?, businessDescription?, email?, phone?, branding?, socialLinks?, ... version }
 */
router.patch('/profile', VendorProfileController.updateProfile);

/**
 * PATCH /api/vendor/profile/password
 *
 * Change authenticated vendor's password.
 * Body: { oldPassword, newPassword }
 */
router.patch('/profile/password', VendorProfileController.updatePassword);

/**
 * GET /api/vendor/delivery-agencies
 *
 * List delivery agencies available for selection during onboarding or at any time.
 * Only returns agencies that are NOT inactive and have completed onboarding (step 0).
 *
 * Query params:
 *   page                    (integer, default 1)
 *   limit                   (integer, default 20, max 50)
 *   search                  (string)  — free-text: matches name, region, city, address
 *   region                  (string)  — filter by coverage area
 *   hq_city                 (string)  — filter by primary HQ city
 *   storage_based           ('true')  — only agencies with storage-based pricing enabled
 *   pickup_based            ('true')  — only agencies with pickup-based pricing enabled
 *   returns_payer           ('vendor'|'agency'|'customer') — filter by returns payer
 *   min_claim_deadline_days (integer) — minimum damage claim window in days
 */
router.get('/delivery-agencies', VendorProfileController.listDeliveryAgencies);

// ─── Onboarding ───────────────────────────────────────────────────────────────

/**
 * PUT /api/vendor/onboarding/basic-setup
 * Step 1 (Required): country, timezone, payout_details
 */
router.put('/onboarding/basic-setup', VendorProfileController.completeBasicSetup);

/**
 * PUT /api/vendor/onboarding/delivery-linking
 * Step 2 (Optional/Skippable): { skip?: boolean, default_delivery_agency_id? }
 */
router.put('/onboarding/delivery-linking', VendorProfileController.completeDeliveryLinking);

/**
 * PUT /api/vendor/onboarding/branding
 * Step 3 (Optional/Skippable): { skip?: boolean, branding?, business_addresses? }
 */
router.put('/onboarding/branding', VendorProfileController.completeBrandingSetup);


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
 * PATCH /api/vendor/orders/:id/delivery-agency
 * Update delivery agency for physical order (NEW: Phase 1)
 */
router.patch('/orders/:id/delivery-agency', VendorOrderController.updateDeliveryAgency);

/**
 * GET /api/vendor/orders/:id/entitlements
 * Get digital entitlements for order (NEW: Phase 2)
 */
router.get('/orders/:id/entitlements', VendorOrderController.getOrderEntitlements);

/**
 * POST /api/vendor/entitlements/:id/revoke
 * Revoke digital entitlement (NEW: Phase 2)
 */
router.post('/entitlements/:id/revoke', VendorOrderController.revokeEntitlement);

/**
 * POST /api/vendor/entitlements/:id/restore
 * Restore revoked digital entitlement (NEW: Phase 2)
 */
router.post('/entitlements/:id/restore', VendorOrderController.restoreEntitlement);

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
