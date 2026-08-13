import { RequestHandler, Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AdminBillingController } from '../controllers/admin-billing.controller';

/**
 * Admin billing routes — the pricing-plan catalog, and assigning a plan to an owner.
 *
 * Mounted TWICE, behind two different guard chains (the `buildAdminCodRouter` pattern,
 * see `modules/cod/admin-cod.routes.ts` for why the guards are a parameter rather than
 * two `router.use` lines):
 *
 *   /api/admin                    requireAuth + requireRole(['admin'])   the dashboard, today
 *   /api/internal/admin/billing   requireAdminCaller                     the wi-admin service
 *
 * ── One asymmetry between the two mounts, and it is in the paths ──────────────
 * The public mount is at the bare `/api/admin` prefix, so these paths carry their own
 * first segment: `/plans`, and `/vendors/:vendorId/plan`. The internal mount is at
 * `/api/internal/admin/billing`, which means wi-admin reaches them as
 * `/billing/plans` and `/billing/vendors/:vendorId/plan`. Public URLs are byte-identical
 * to before; if you change a path here, check both mounts.
 *
 * ── The three assign routes are one capability ────────────────────────────────
 * `/vendors/:id/plan`, `/agencies/:id/plan` and `/agents/:id/plan` differ only in which
 * owner type they name. They are kept as three paths because the public mount's URLs are
 * live; wi-admin collapses them into one `POST /billing/subscriptions/:ownerType/:ownerId`
 * and picks the path in its gateway. Assigning a plan emits `plan.activated`, which
 * resizes an agent's capacity in-process — which is exactly why this is delegated rather
 * than written from there.
 */
function attachRoutes(router: Router): Router {
    /** GET /plans — the catalog for every role. Query: role? */
    router.get('/plans', AdminBillingController.listPlans);

    /** POST /plans — create a plan. Its `commission_percent` prices every future order. */
    router.post('/plans', AdminBillingController.createPlan);

    /** PATCH /plans/:id — edit a plan. Entitlement reads pick this up on the next check. */
    router.patch('/plans/:id', AdminBillingController.updatePlan);

    /** DELETE /plans/:id — soft delete (`deletedAt`); existing subscribers are untouched. */
    router.delete('/plans/:id', AdminBillingController.deletePlan);

    /**
     * GET /entitlements/:ownerType/:ownerId — the limits this owner's plan grants.
     *
     * Declared above the assign routes because its first segment is a literal that no
     * `:param` route here shadows. Read-only: it does NOT lazily create the free tier
     * the way the owner-facing plan read does — see `getAdminEntitlements`.
     */
    router.get('/entitlements/:ownerType/:ownerId', AdminBillingController.getEntitlements);

    /** POST /vendors/:vendorId/plan — assign, after confirming payment out of band. */
    router.post('/vendors/:vendorId/plan', AdminBillingController.assignPlanToVendor);

    /** POST /agencies/:agencyId/plan */
    router.post('/agencies/:agencyId/plan', AdminBillingController.assignPlanToAgency);

    /** POST /agents/:agentId/plan */
    router.post('/agents/:agentId/plan', AdminBillingController.assignPlanToAgent);

    return router;
}

/** Build the billing admin surface behind an arbitrary guard chain. */
export function buildAdminBillingRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}

/** The public mount — unchanged behaviour, same guards and same paths as before. */
const router = buildAdminBillingRouter([requireAuth, requireRole(['admin'])]);

export default router;
