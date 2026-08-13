import { RequestHandler, Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AdminAgencyController } from './controllers/admin-agency.controller';

/**
 * Admin delivery agency management.
 *
 * Mounted TWICE, at two paths, behind two different guards:
 *
 *   /api/admin/delivery-agencies     requireAuth + requireRole(['admin'])   the dashboard
 *   /api/internal/admin/agencies     requireAdminCaller                     the wi-admin service
 *
 * The factory shape and the reason for it are `admin-cod.routes.ts`'s: both surfaces run at
 * once until cutover, and mounting a single Router instance twice re-runs the guards it
 * already carries. Change the routes in `attachRoutes`, never in a second copy.
 *
 * ── The paths moved, and the public URLs did not ──────────────────────────────
 * This router used to declare `/delivery-agencies/...` because it was mounted at the BARE
 * `/admin` prefix. Reused as-is internally that would produce
 * `/api/internal/admin/agencies/delivery-agencies/:id/deactivate`. So the declarations are
 * now relative and the public mount absorbs the segment — `router.use('/admin/delivery-agencies', …)`
 * in `api/index.ts`. Every public URL is byte-identical to before; if you change one of
 * these paths, check that mount.
 *
 * ── Why the reads are mounted internally too ──────────────────────────────────
 * wi-admin reads `delivery_agencies` DIRECTLY (ADR-008 D-1) and does not call them. They
 * are here anyway because splitting `attachRoutes` into a public half and an internal half
 * would put the routes in two places, which is the one thing the factory pattern exists to
 * prevent. Unused surface behind a token only wi-admin holds is cheaper than a second copy.
 *
 * Deactivating an agency suspends every vendor's physical products (any status) where that
 * agency is currently their default delivery agency, and holds their order items, in one
 * transaction; reactivating restores them. That cascade is why the writes are delegated
 * rather than reproduced. See AdminAgencyService.
 */
function attachRoutes(router: Router): Router {
    /** GET / — paginated. Query: status?, page?, limit? */
    router.get('/', AdminAgencyController.list);

    /** GET /:id — one agency plus its Magazin's business name and logo. */
    router.get('/:id', AdminAgencyController.getById);

    /**
     * POST /:id/verify — approve the agency's business verification.
     *
     * The exit from `pending_verification`, which had none until Phase 9. One
     * compare-and-set: `status` and both `legit_verified` mirrors move together or not at
     * all, and a losing administrator gets 409 rather than overwriting the winner.
     *
     * Deliberately NOT `reactivate`, which was being used for this and also runs the
     * product-restore cascade — a first approval has nothing to restore.
     */
    router.post('/:id/verify', AdminAgencyController.verify);

    /** PATCH /:id/deactivate — status → inactive, and the product cascade. */
    router.patch('/:id/deactivate', AdminAgencyController.deactivate);

    /** PATCH /:id/reactivate — the reverse of the above. */
    router.patch('/:id/reactivate', AdminAgencyController.reactivate);

    return router;
}

/** Build the delivery-agency admin surface behind an arbitrary guard chain. */
export function buildAdminAgencyRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}

/** The public mount — unchanged behaviour, same guards and same paths as before. */
const router = buildAdminAgencyRouter([requireAuth, requireRole(['admin'])]);

export default router;
