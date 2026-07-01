import { Router } from 'express';
import { VendorAnalyticsController } from '../controllers/vendor-analytics.controller';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';

/**
 * Vendor Analytics Routes
 *
 * All routes require vendor authentication and use vendor-scoped data
 */

const router = Router();
const controller = new VendorAnalyticsController();

// All routes require authentication and the vendor role. The role guard is
// declared locally (not only inherited from the parent vendor router) so these
// endpoints stay vendor-only regardless of where the router is mounted.
router.use(requireAuth);
router.use(requireRole(['vendor']));

/**
 * GET /api/vendor/analytics/dashboard
 * Query params: from, to, timezone?, fiscalCalendar?
 */
router.get('/dashboard', controller.getDashboard);

/**
 * GET /api/vendor/analytics/sales
 * Query params: from, to, timezone?, fiscalCalendar?, breakdown?
 */
router.get('/sales', controller.getSales);

/**
 * GET /api/vendor/analytics/products
 * Query params: from, to, timezone?, fiscalCalendar?, limit?
 */
router.get('/products', controller.getProducts);

/**
 * GET /api/vendor/analytics/customers
 * Query params: from, to, timezone?, fiscalCalendar?
 */
router.get('/customers', controller.getCustomers);

export const vendorAnalyticsRouter = router;
