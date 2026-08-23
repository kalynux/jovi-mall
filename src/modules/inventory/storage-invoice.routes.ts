import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { StorageInvoiceController } from './controllers/storage-invoice.controller';

/**
 * Storage statements — the monthly record of warehousing rent (Step 14, D-7).
 *
 * ⚠ **No money moves through any of these routes.** The platform does not collect this from
 * the vendor and does not pay it to the agency; the statement exists so both sides read one
 * durable number instead of an agency quoting a live figure off its own screen. `settle` is
 * the agency stating it was paid out of band.
 *
 * Two routers rather than one mounted twice: a single Router instance cannot be mounted
 * twice (its `router.use` guards would re-run), which is the same reason the admin routers
 * here are factories.
 */

export const agencyStorageInvoiceRoutes = Router();

agencyStorageInvoiceRoutes.use(requireAuth);
agencyStorageInvoiceRoutes.use(requireRole(['agency']));

/**
 * GET /api/agency/storage-invoices
 *
 * Query: page, limit, status (`open` | `settled` | `void`), periodKey (`YYYY-MM`), vendorId.
 * Newest period first. Lines are on the detail only.
 */
agencyStorageInvoiceRoutes.get('/', StorageInvoiceController.listForAgency);

/** GET /api/agency/storage-invoices/:id — with every line. */
agencyStorageInvoiceRoutes.get('/:id', StorageInvoiceController.getForAgency);

/**
 * POST /api/agency/storage-invoices/:id/settle
 *
 * Body: `{ note? }`. Compare-and-set from `open`; a statement already settled or voided
 * answers `409 STORAGE_INVOICE_NOT_OPEN`, never a 404 — it is right there, it is just not
 * in that state.
 */
agencyStorageInvoiceRoutes.post('/:id/settle', StorageInvoiceController.settle);

/**
 * POST /api/agency/storage-invoices/:id/void
 *
 * Body: `{ reason }` — required. The statement is kept, never deleted: a missing month is
 * indistinguishable from a month nobody billed, and this is the record that tells them apart.
 */
agencyStorageInvoiceRoutes.post('/:id/void', StorageInvoiceController.void);

export const vendorStorageInvoiceRoutes = Router();

vendorStorageInvoiceRoutes.use(requireAuth);
vendorStorageInvoiceRoutes.use(requireRole(['vendor']));

/**
 * GET /api/vendor/storage-invoices
 *
 * The same statements from the other side. **Read-only, and there is deliberately no dispute
 * verb**: the platform is not a party to this money, so a dispute it recorded would be a
 * state nobody here could resolve. A vendor who disagrees takes it up with the agency, which
 * is where the arrangement lives.
 */
vendorStorageInvoiceRoutes.get('/', StorageInvoiceController.listForVendor);

/** GET /api/vendor/storage-invoices/:id — with every line. */
vendorStorageInvoiceRoutes.get('/:id', StorageInvoiceController.getForVendor);
