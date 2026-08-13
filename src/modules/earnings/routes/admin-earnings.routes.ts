import { RequestHandler, Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AdminEarningsController } from '../controllers/admin-earnings.controller';

/**
 * Admin earnings routes — the platform's own commission account, and the per-owner
 * balances wi-admin's account surface is built on.
 *
 * Mounted TWICE, behind two different guard chains (see `modules/cod/admin-cod.routes.ts`
 * for why the guards are a parameter):
 *
 *   /api/admin                     requireAuth + requireRole(['admin'])   the dashboard, today
 *   /api/internal/admin/earnings   requireAdminCaller                     the wi-admin service
 *
 * ── The paths here are RELATIVE, and that is a trap worth knowing ────────────
 * They used to read `/earnings/platform`, because the only mount was at the bare
 * `/api/admin` prefix. Mounting the same factory at `/api/internal/admin/earnings` then
 * produced `/earnings/earnings/platform` — the segment twice. So the routes dropped it
 * and `api/index.ts` absorbs it instead (`router.use('/admin/earnings', …)`), exactly as
 * `buildAdminAgencyRouter` was made to do at Phase 9.
 *
 * Public URLs are byte-identical to before. **If you change a path here, check that
 * mount** — the two halves of each URL now live in different files.
 *
 * ── Why the balance reads are here and not in wi-admin ────────────────────────
 * wi-admin reads the earnings LEDGER directly out of `jovi_mall` — append-only rows are
 * records, and a second reader of a record costs nothing. A BALANCE is not a record. It is
 * `getBalances` reconciling four sub-balances that only this service's transactions move,
 * and a second implementation of that arithmetic would be a second opinion about how much
 * money exists. So the derivation stays here and is asked for over HTTP. That is
 * ADR-009 D-1 — delegate a verdict, read a record — applied to money.
 */
function attachRoutes(router: Router): Router {
    /** GET /earnings/platform — the singleton platform commission account. */
    router.get('/platform', AdminEarningsController.getPlatformEarnings);

    /** GET /earnings/platform/ledger — its ledger. Query: page?, limit? */
    router.get('/platform/ledger', AdminEarningsController.getPlatformLedger);

    /**
     * GET /earnings/accounts — every owner's balances, ranked.
     *
     * Declared ABOVE `/earnings/balances/:ownerType/:ownerId` for clarity only; the two
     * differ in their second segment (`accounts` vs `balances`) so neither shadows the
     * other. Query: ownerType?, page?, limit?
     */
    router.get('/accounts', AdminEarningsController.listAccounts);

    /**
     * GET /earnings/balances/:ownerType/:ownerId — one owner's four balances.
     *
     * Net-new at Phase 11. `earningsAccountService.getBalances` was always generic over
     * the owner and had only ever been called with `'platform'`, so this endpoint is a
     * route onto logic that already existed rather than new arithmetic.
     */
    router.get('/balances/:ownerType/:ownerId', AdminEarningsController.getOwnerBalances);

    return router;
}

/** Build the earnings admin surface behind an arbitrary guard chain. */
export function buildAdminEarningsRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}

/** The public mount — unchanged behaviour, same guards and same paths as before. */
const router = buildAdminEarningsRouter([requireAuth, requireRole(['admin'])]);

export default router;
