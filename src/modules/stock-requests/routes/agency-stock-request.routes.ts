import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { buildStockRequestController } from '../controllers/stock-request.controller';

const router = Router();
const controller = buildStockRequestController('agency');

/**
 * Agency-side stock-adjustment requests — `/api/agency/stock-requests`.
 *
 * The mirror of the vendor router; see that file for why the verbs are identical.
 * Identity flows token → agency, and every query is scoped to the caller: another
 * agency's request 404s rather than 403s.
 */
router.use(requireAuth);
router.use(requireRole(['agency']));

/**
 * POST /api/agency/stock-requests
 *
 * Body: `{ productId, variantId, quantity, isInfiniteStock?, note? }`. Only for a
 * product this agency actually warehouses — anything else is
 * `404 INVENTORY_PRODUCT_NOT_STORED_HERE`.
 */
router.post('/', controller.create);

/** GET /api/agency/stock-requests — every status by default. */
router.get('/', controller.list);

/** GET /api/agency/stock-requests/:id */
router.get('/:id', controller.getById);

/** POST /api/agency/stock-requests/:id/approve — only if the VENDOR raised it. */
router.post('/:id/approve', controller.approve);

/** POST /api/agency/stock-requests/:id/reject — only if the VENDOR raised it. */
router.post('/:id/reject', controller.reject);

/** POST /api/agency/stock-requests/:id/withdraw — only if the AGENCY raised it. */
router.post('/:id/withdraw', controller.withdraw);

export default router;
