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
 * The counted-stock verbs (Step 14, D-6). Keyed on the ROW, unlike the three product-level
 * actions above — a receipt is a physical event at one shelf, and two variants of one
 * product can arrive on different days.
 *
 * All four are declared BEFORE `/:id`. They are two-segment paths and Express matches in
 * declaration order, so the bare `/:id` GET above would not shadow them — but `/:id` is a
 * literals-last convention here and breaking it once is how the next route gets swallowed.
 *
 * ⚠ **Nothing here writes `ProductVariant.stock`.** The catalogue number is the vendor's,
 * changed only through the two-sided stock-request flow; these move the AGENCY's count of
 * what is physically on its shelf. The two are allowed to disagree — that disagreement is
 * exactly what `POST /:id/count` exists to settle.
 */

/**
 * POST /api/agency/inventory/:id/receipts
 *
 * Body: `{ quantity, note? }`. Goods arrived. The first receipt on a row flips it from
 * `derived` to `counted`, after which order movements are projected onto it and the
 * storage invoice bills against it.
 */
router.post('/:id/receipts', AgencyInventoryController.recordReceipt);

/** POST /api/agency/inventory/:id/returns — `{ quantity, reason? }`, goods back to the vendor. */
router.post('/:id/returns', AgencyInventoryController.recordReturnToVendor);

/**
 * POST /api/agency/inventory/:id/count
 *
 * Body: `{ countedQuantity, reason }` — what you COUNTED, not a difference. The reason is
 * required because this is the one verb that moves stock with no physical event behind it.
 */
router.post('/:id/count', AgencyInventoryController.recordCount);

/**
 * POST /api/agency/inventory/:id/transfers
 *
 * Body: `{ toLocationId, quantity, reason? }` — `null` for your primary depot. Two movements
 * in one transaction, so units are never in both buildings or neither. Moves STOCK, not the
 * arrangement: the product still names the depot its vendor chose.
 */
router.post('/:id/transfers', AgencyInventoryController.transfer);

/** GET /api/agency/inventory/:id/movements — the shelf's ledger, newest first. */
router.get('/:id/movements', AgencyInventoryController.listMovements);
/**
 * GET /api/agency/inventory/:id
 *
 * `:id` is the stock-level ROW id, not a variant — the same SKU at two depots is
 * two rows. Adds the depot's full address and the full image gallery.
 */
router.get('/:id', AgencyInventoryController.getById);

export default router;
