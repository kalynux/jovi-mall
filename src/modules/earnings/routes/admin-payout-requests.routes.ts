import { RequestHandler, Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AdminPayoutRequestsController } from '../controllers/admin-payout-requests.controller';

/**
 * Admin payout-request routes — the queue where money leaves the platform.
 *
 * Mounted TWICE, behind two different guard chains (see `modules/cod/admin-cod.routes.ts`
 * for why the guards are a parameter):
 *
 *   /api/admin                            requireAuth + requireRole(['admin'])
 *   /api/internal/admin/payout-requests   requireAdminCaller
 *
 * ── The paths here are RELATIVE ──────────────────────────────────────────────
 * They used to read `/payout-requests/:id/…`, because the only mount was the bare
 * `/api/admin` prefix. Mounting the same factory at `/api/internal/admin/payout-requests`
 * produced the segment twice, so the routes dropped it and `api/index.ts` absorbs it
 * (`router.use('/admin/payout-requests', …)`) — the same move `buildAdminAgencyRouter`
 * made at Phase 9. Public URLs are unchanged; if you edit a path here, check that mount.
 *
 * ── Every response here is masked ─────────────────────────────────────────────
 * All four go through `toAdminPayoutRequestDto`, which renders the destination to its
 * last four digits. The full account number is NOT reachable from this router at all —
 * wi-admin serves it from its own endpoint, behind its own permission and written to its
 * audit trail on every read. See the controller header.
 *
 * ── The resolver is an actor, not an id ───────────────────────────────────────
 * `mark-paid` and `reject` stamp `resolved_by` together with `resolved_by_source` and a
 * `resolved_by_name` snapshot, because over the internal mount the resolver is a wi-admin
 * administrator whose id resolves in no collection in this database.
 */
function attachRoutes(router: Router): Router {
    /** GET /payout-requests — the queue. Query: status?, ownerType?, page?, limit? */
    router.get('/', AdminPayoutRequestsController.list);

    /** GET /payout-requests/:id — one request, destination masked. */
    router.get('/:id', AdminPayoutRequestsController.getById);

    /**
     * POST /payout-requests/:id/mark-paid
     * Records that money has left the platform: debits `requested_balance`, resolves the
     * linked ticket and emits `payout.paid`. Body: { reference? }
     */
    router.post('/:id/mark-paid', AdminPayoutRequestsController.markPaid);

    /**
     * POST /payout-requests/:id/reject
     * Returns the money to `available_balance` in the same transaction. Body: { reason }
     */
    router.post('/:id/reject', AdminPayoutRequestsController.reject);

    return router;
}

/** Build the payout-request admin surface behind an arbitrary guard chain. */
export function buildAdminPayoutRequestsRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}

/** The public mount — unchanged behaviour, same guards and same paths as before. */
const router = buildAdminPayoutRequestsRouter([requireAuth, requireRole(['admin'])]);

export default router;
