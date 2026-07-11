import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { VendorProfileController, uploadVendorPolicyDocuments } from './controller/vendor-profile.controller';
import { VendorCalendarController } from './controller/vendor-calendar.controller';
import { VendorOrderController } from './controller/vendor-order.controller';
import { VendorNotificationController } from './controller/vendor-notification.controller';
import { DeviceTokenController } from '../notifications/controllers/device-token.controller';
import { VendorCustomerController } from './controller/vendor-customer.controller';

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

/**
 * GET /api/vendor/profile/default-delivery-agency
 *
 * Returns the vendor's currently-configured default delivery agency (or null).
 * Used by the frontend to show the agency in profile settings and preselect it
 * on the product editor.
 */
router.get('/profile/default-delivery-agency', VendorProfileController.getDefaultDeliveryAgency);

/**
 * PUT /api/vendor/profile/default-delivery-agency
 *
 * Set or change the vendor's default delivery agency outside the onboarding flow.
 * Vendors can only change their default, never clear it — the only way it becomes
 * unset is a system cascade when the underlying agency is deactivated by an admin.
 * Body: { agencyId: string }
 */
router.put('/profile/default-delivery-agency', VendorProfileController.setDefaultDeliveryAgency);

/**
 * GET /api/vendor/profile/auto-redirect-orders
 *
 * Returns whether paid physical orders auto-dispatch to the agency in charge,
 * plus the optional max-order-total cap.
 * Response: { autoRedirectOrdersToAgency: boolean, autoRedirectThresholdAmount: number | null }
 */
router.get('/profile/auto-redirect-orders', VendorProfileController.getAutoRedirectOrders);

/**
 * PUT /api/vendor/profile/auto-redirect-orders
 *
 * Enable/disable auto-dispatch of paid physical orders to their agency, and
 * optionally set the max order total above which auto-dispatch is skipped.
 * Body: { enabled: boolean, thresholdAmount?: number | null }
 */
router.put('/profile/auto-redirect-orders', VendorProfileController.setAutoRedirectOrders);

/**
 * GET /api/vendor/profile/auto-cancel-unpaid-days
 *
 * Returns the number of days an order may stay unpaid before auto-cancellation.
 * Response: { autoCancelUnpaidDays: number }
 */
router.get('/profile/auto-cancel-unpaid-days', VendorProfileController.getAutoCancelUnpaidDays);

/**
 * PUT /api/vendor/profile/auto-cancel-unpaid-days
 *
 * Set the days an order may stay unpaid before auto-cancellation (min 1, max 90).
 * Body: { days: number }
 */
router.put('/profile/auto-cancel-unpaid-days', VendorProfileController.setAutoCancelUnpaidDays);

// ─── Onboarding ───────────────────────────────────────────────────────────────

/**
 * GET /api/vendor/onboarding/status
 * Rich onboarding status: steps[], progressPercent, completedFields, warnings.
 * Frontend uses this to render the step indicator and route to the correct screen.
 */
router.get('/onboarding/status', VendorProfileController.getOnboardingStatus);

/**
 * PUT /api/vendor/onboarding/basic-setup
 * Step 1 (Required): country, timezone, payout_details
 * Optional: { version } for optimistic concurrency
 */
router.put('/onboarding/basic-setup', VendorProfileController.completeBasicSetup);

/**
 * PUT /api/vendor/onboarding/delivery-linking
 * Step 2 (Optional/Skippable): { skip?: boolean, default_delivery_agency_id? }
 * Optional: { version } for optimistic concurrency
 */
router.put('/onboarding/delivery-linking', VendorProfileController.completeDeliveryLinking);

/**
 * PUT /api/vendor/onboarding/branding
 * Step 3 (Optional/Skippable): { skip?: boolean, branding?, business_addresses? }
 * Optional: { version } for optimistic concurrency
 */
router.put('/onboarding/branding', VendorProfileController.completeBrandingSetup);

/**
 * PUT /api/vendor/onboarding/policy-setup
 * Step 4 (Optional/Skippable): { skip?: boolean, return_policy?, cancellation_policy?, support_policy? }
 * Optional: { version } for optimistic concurrency
 */
router.put('/onboarding/policy-setup', VendorProfileController.completePolicySetup);

/**
 * POST /api/vendor/profile/policy-documents
 * Upload 1-2 supporting PDF documents (max 5MB each, field name "documents").
 * Standalone upload path, unrelated to the product/ticket media pipeline.
 * Returns public URLs to submit via `policies.documents` on the policy-setup
 * or profile-update endpoints.
 */
router.post('/profile/policy-documents', uploadVendorPolicyDocuments, VendorProfileController.uploadPolicyDocuments);


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
 * POST /api/vendor/orders/bulk/status
 * Bulk-update fulfillment status for many orders at once. Each order is
 * validated independently — partial success is expected, see api-doc.
 *
 * NOTE: registered ABOVE the /orders/:id/... routes below. POST /orders/:id/dispatch
 * shares its path shape with POST /orders/bulk/dispatch — if the bulk routes were
 * registered after the :id routes, Express would match "bulk" as the :id value and
 * the bulk handler would never be reached.
 */
router.post('/orders/bulk/status', VendorOrderController.bulkUpdateFulfillmentStatus);

/**
 * POST /api/vendor/orders/bulk/dispatch
 * Bulk-dispatch many paid physical orders to their delivery agency/agencies.
 */
router.post('/orders/bulk/dispatch', VendorOrderController.bulkDispatchToAgency);

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
 * POST /api/vendor/orders/:id/dispatch
 * Explicitly dispatch a reviewed, paid order to its delivery agency (advances
 * pending shipments to assigned — the vendor's manual review/approval gate).
 */
router.post('/orders/:id/dispatch', VendorOrderController.dispatchToAgency);

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
 * GET /api/vendor/orders/:id/notes/:noteId
 * Get a single vendor-internal note by ID (useful when following a timeline noteId reference)
 */
router.get('/orders/:id/notes/:noteId', VendorOrderController.getNote);

/**
 * PATCH /api/vendor/orders/:id/delivery-agency
 * Update delivery agency for physical order (NEW: Phase 1)
 */
router.patch('/orders/:id/delivery-agency', VendorOrderController.updateDeliveryAgency);

/**
 * GET /api/vendor/orders/:id/refund-eligibility
 * Check whether the order can be refunded (vendor return policy + order state)
 */
router.get('/orders/:id/refund-eligibility', VendorOrderController.getRefundEligibility);

/**
 * POST /api/vendor/orders/:id/refund
 * Action a refund on a paid, refundable order.
 * Body: { amount?, reason? } — amount defaults to the policy-computed maximum.
 */
router.post('/orders/:id/refund', VendorOrderController.refundOrder);

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
 * CUSTOMER MANAGEMENT
 * ==========================================
 */

/**
 * Vendor-defined customer flags (customizable color-coded tags/groups).
 *
 * GET    /api/vendor/customer-flags        List flags
 * POST   /api/vendor/customer-flags        Create flag  { name, color, description? }
 * PATCH  /api/vendor/customer-flags/:id    Update flag  { name?, color?, description? }
 * DELETE /api/vendor/customer-flags/:id    Soft-delete flag (and detach from customers)
 */
router.get('/customer-flags', VendorCustomerController.listFlags);
router.post('/customer-flags', VendorCustomerController.createFlag);
router.patch('/customer-flags/:id', VendorCustomerController.updateFlag);
router.delete('/customer-flags/:id', VendorCustomerController.deleteFlag);

/**
 * Customers who have ordered from this vendor (derived from orders).
 *
 * GET   /api/vendor/customers              List customers  ?search=&flagId=&page=&limit=&sortBy=&sortOrder=
 * GET   /api/vendor/customers/:id          Customer detail (profile + stats + flags)
 * PATCH /api/vendor/customers/:id/name     Set/clear vendor-local name override  { displayName }
 * PUT   /api/vendor/customers/:id/flags    Replace the customer's assigned flags  { flagIds }
 *
 * To view a customer's orders, call GET /api/vendor/orders?customerId=:id
 */
router.get('/customers', VendorCustomerController.listCustomers);
router.get('/customers/:id', VendorCustomerController.getCustomerDetail);
router.patch('/customers/:id/name', VendorCustomerController.updateCustomerName);
router.put('/customers/:id/flags', VendorCustomerController.setCustomerFlags);

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
 * POST /api/vendor/devices
 * Register/refresh an FCM device token for push notifications
 */
router.post('/devices', DeviceTokenController.register);

/**
 * DELETE /api/vendor/devices
 * Unregister an FCM device token (e.g. on logout)
 */
router.delete('/devices', DeviceTokenController.unregister);

/**
 * ==========================================
 * ANALYTICS
 * ==========================================
 */

import { vendorAnalyticsRouter } from '../vendors/routes/vendor-analytics.routes';
router.use('/analytics', vendorAnalyticsRouter);

export default router;
