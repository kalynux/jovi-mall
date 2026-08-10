import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AgencyInventoryController } from './controllers/agency-inventory.controller';

const router = Router();

/**
 * Agency Inventory Routes — what this agency stores, per depot, per SKU.
 *
 * Identity flows token → agency; there is no agencyId in the paths and every
 * query is scoped to the caller.
 *
 * PHASE 1 CAVEAT, on the wire as `countsAreDerived` and per-row `source`: these
 * rows are derived from what vendors have CONFIGURED to be warehoused here
 * (`delivery.pickup_location.source === 'agency_storage'`). Quantities are zero
 * and are not counted — stock does not move on delivery yet.
 */
router.use(requireAuth);
router.use(requireRole(['agency']));

/**
 * GET /api/agency/inventory
 *
 * Query: page, limit, locationId (a depot id or the literal `unassigned`),
 * vendorId, search (SKU or product title), sortBy, sortDir.
 */
router.get('/', AgencyInventoryController.list);

/**
 * GET /api/agency/inventory/summary
 *
 * Whole-magazine roll-up for the screen header, over the same filters as the list.
 * MUST be declared before `/:id`, or Express matches `summary` as a row id.
 */
router.get('/summary', AgencyInventoryController.summary);

/**
 * The three product-level write actions.
 *
 * Keyed on the PRODUCT, not the stock row: the depot is named once on the product
 * and suspension is a product status, so both act on every row of that product.
 * Declared before `/:id` — the literals-before-params rule this codebase has been
 * bitten by before.
 */

/**
 * PATCH /api/agency/inventory/products/:productId/depot
 *
 * Body: `{ locationId: string | null }` — one of your own depots, or `null` for your
 * primary. Applies immediately (the depot is the agency's own record; that is why
 * checkout snapshots only the depot CHOICE for `agency_storage` and resolves the
 * address live). The vendor is notified.
 */
router.patch('/products/:productId/depot', AgencyInventoryController.changeDepot);

/**
 * POST /api/agency/inventory/products/:productId/suspend
 *
 * Body: `{ note?: string }`. Takes the product off the storefront. Manual only —
 * the platform does not track storage payment and never suspends on its own. Rows
 * for suspended products STAY on this screen; only the agency that suspended may
 * lift it.
 */
router.post('/products/:productId/suspend', AgencyInventoryController.suspend);

/**
 * POST /api/agency/inventory/products/:productId/unsuspend
 *
 * Re-runs the activation gate; a still-blocked product comes back as
 * `422 INVENTORY_PRODUCT_UNSUSPEND_BLOCKED` with `details.blockers`.
 */
router.post('/products/:productId/unsuspend', AgencyInventoryController.unsuspend);

/**
 * GET /api/agency/inventory/:id
 *
 * `:id` is the stock-level ROW id, not a variant — the same SKU at two depots is
 * two rows. Adds the depot's full address and the full image gallery.
 */
router.get('/:id', AgencyInventoryController.getById);

export default router;
