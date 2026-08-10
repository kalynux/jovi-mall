import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { buildStockRequestController } from '../controllers/stock-request.controller';

const router = Router();
const controller = buildStockRequestController('vendor');

/**
 * Vendor-side stock-adjustment requests — `/api/vendor/stock-requests`.
 *
 * An **endpoint-for-endpoint mirror** of the agency router. The four verbs mean the
 * same thing on both sides (`approve` / `reject` / `withdraw`, plus a POST to raise
 * one), matching `agency-connections` and the agent contract flow. Do not
 * reintroduce role-specific spellings like `accept` / `decline` / `cancel`: the FSM
 * and the HTTP surface saying different words is a drift that buys nothing.
 *
 * Identity flows token → vendor. There is no vendorId in any path.
 */
router.use(requireAuth);
router.use(requireRole(['vendor']));

/**
 * POST /api/vendor/stock-requests
 *
 * Body: `{ productId, variantId, quantity, isInfiniteStock?, note? }`.
 * `quantity` is the ABSOLUTE target, never a delta.
 */
router.post('/', controller.create);

/**
 * GET /api/vendor/stock-requests
 *
 * Every status by default, terminal rows included — the list is the only place a
 * vendor learns the id of a request it raised itself. Filters: status, productId,
 * variantId, direction (`raised_by_me` | `awaiting_me`).
 */
router.get('/', controller.list);

/** GET /api/vendor/stock-requests/:id */
router.get('/:id', controller.getById);

/** POST /api/vendor/stock-requests/:id/approve — only if the AGENCY raised it. */
router.post('/:id/approve', controller.approve);

/** POST /api/vendor/stock-requests/:id/reject — only if the AGENCY raised it. */
router.post('/:id/reject', controller.reject);

/** POST /api/vendor/stock-requests/:id/withdraw — only if the VENDOR raised it. */
router.post('/:id/withdraw', controller.withdraw);

export default router;
