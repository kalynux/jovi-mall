import { RequestHandler, Router } from 'express';
import { AdminVendorController } from './admin-vendor.controller';

/**
 * Vendor administration — the write surface wi-admin delegates to.
 *
 * ── Mounted ONCE, internal only ───────────────────────────────────────────────
 * The same call `buildAdminUserRouter` makes, for the same reason: there is no
 * `/api/admin/vendors` dashboard consumer to keep alive until cutover, so a public mount
 * would create surface whose only future is the deletion list.
 *
 * Note what that does NOT mean. The vendor domain *does* already have one public admin
 * endpoint — `POST /api/admin/vendors/:vendorId/plan`, which assigns a pricing plan and
 * therefore sets the vendor's commission. It lives in the billing module and stays there.
 * Nothing here duplicates it, and per-vendor commission is deliberately absent from the
 * settings PATCH below for exactly that reason.
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * `/:vendorId/products/:productId/…` and `/:vendorId/kyc/…` are distinct path segments at
 * distinct depths, so Express matches them without ambiguity against each other. A future
 * literal sibling of `/:vendorId` MUST be declared above these.
 */
function attachRoutes(router: Router): Router {
    /**
     * POST /:vendorId/suspend
     * Body: `{ reason }`. Takes the vendor's whole catalogue off sale in the same
     * transaction and blocks their next authenticated request. 409 when already suspended.
     */
    router.post('/:vendorId/suspend', AdminVendorController.suspend);

    /**
     * POST /:vendorId/restore
     * Lifts the suspension and puts back the listings THIS cascade took down — re-running
     * the activation gate on each, so a listing that went stale meanwhile stays suspended.
     * 409 when the vendor is not suspended.
     */
    router.post('/:vendorId/restore', AdminVendorController.restore);

    /** POST /:vendorId/kyc/approve — body `{ note? }`. 409 if already verified. */
    router.post('/:vendorId/kyc/approve', AdminVendorController.approveKyc);

    /**
     * POST /:vendorId/kyc/reject
     * Body: `{ reason }` — required, and stored on the vendor rather than only in
     * wi-admin's audit trail, because this service cannot read that database and the
     * vendor has to be able to be told why.
     */
    router.post('/:vendorId/kyc/reject', AdminVendorController.rejectKyc);

    /**
     * GET /:vendorId/products/:productId
     *
     * The one read on this router. Everything else about a vendor is queryable straight
     * out of the shared database by the caller; this is not, because it resolves file ids
     * to URLs and quotes the agency's storage rate — see the controller's header.
     */
    router.get('/:vendorId/products/:productId', AdminVendorController.getProduct);

    /**
     * POST /:vendorId/products/:productId/suspend
     * Body: `{ note }`. Platform oversight on ONE listing — its own suspension reason, so
     * reinstating the vendor can never republish it.
     */
    router.post('/:vendorId/products/:productId/suspend', AdminVendorController.suspendProduct);

    /**
     * POST /:vendorId/products/:productId/restore
     * Refuses a product suspended for any other reason: one an agency took down over
     * unpaid storage is that agency's to release.
     */
    router.post('/:vendorId/products/:productId/restore', AdminVendorController.restoreProduct);

    /**
     * PATCH /:vendorId/settings
     * The platform-governed fields only — auto-cancel and auto-redirect. Naming any other
     * settings field is a 400, not a silent no-op.
     */
    router.patch('/:vendorId/settings', AdminVendorController.updateSettings);

    return router;
}

/** Build the vendor admin surface behind an arbitrary guard chain. */
export function buildAdminVendorRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}
