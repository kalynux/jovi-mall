import { RequestHandler, Router } from 'express';
import { AdminAgencyController } from './controllers/admin-agency.controller';

/**
 * Admin delivery agency management.
 *
 * Mounted ONCE. It used to be mounted twice, at two paths behind two different guards:
 *
 *   (none — the public mount was deleted at the Phase 5 cutover)
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

/**
 * ── There is NO public mount any more (Phase 5 Part E) ──────────────────────
 *
 * `const router = buildAdminAgencyRouter([requireAuth, requireRole(['admin'])]);`
 * and its default export stood here, serving the delivery-agency admin surface to any platform
 * session whose `users` row carried `roles: ['admin']`. That was jovi-mall's second
 * authorization model, and the cutover retired it: a legacy `admin` holds no tier, no
 * permission set and no audit identity, so none of wi-admin's tier matrix, escalation rules,
 * dual-control queue or audit trail applied to a request that arrived this way.
 *
 * **The factory above is untouched, and it is the same code that serves the surface today** —
 * `internal-admin.routes.ts` instantiates it with `[requireAdminCaller]`. Only the guard
 * array and the mount prefix ever differed between the two, which is why this deletion is
 * subtractive rather than a migration.
 *
 * ⚠ Do not re-add a public instantiation. `requireRole(['admin'])` still exists and still
 * guards vendor, agency, agent and customer routes, so writing one would compile and work —
 * and would reopen the model this phase closed. The route it would serve belongs behind
 * `requireAdminCaller`, beside its siblings.
 */
