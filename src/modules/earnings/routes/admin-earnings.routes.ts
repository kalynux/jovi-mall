import { RequestHandler, Router } from 'express';
import { AdminEarningsController } from '../controllers/admin-earnings.controller';

/**
 * Admin earnings routes — the platform's own commission account, and the per-owner
 * balances wi-admin's account surface is built on.
 *
 * Mounted TWICE, behind two different guard chains (see `modules/cod/admin-cod.routes.ts`
 * for why the guards are a parameter):
 *
 *   (none — the public mount was deleted at the Phase 5 cutover)
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

/**
 * ── There is NO public mount any more (Phase 5 Part E) ──────────────────────
 *
 * `const router = buildAdminEarningsRouter([requireAuth, requireRole(['admin'])]);`
 * and its default export stood here, serving the earnings admin surface to any platform
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
