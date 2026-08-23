import { RequestHandler, Router } from 'express';
import { AdminCodController } from './controllers/admin-cod.controller';

/**
 * Admin COD Routes — platform oversight of the cash-on-delivery chain.
 *
 * Mounted ONCE. It used to be mounted twice, at two paths behind two different guards:
 *
 *   (none — the public mount was deleted at the Phase 5 cutover)
 *   /api/internal/admin/cod   requireAdminCaller                     the wi-admin service
 *
 * ── Why a factory rather than swapping the guards ─────────────────────────────
 * The migration plan described this as "swap the two `router.use` lines". That works for a
 * REPLACEMENT, but both surfaces have to run at once: the dashboard keeps calling
 * `/api/admin/*` until cutover while wi-admin ports endpoints one at a time. Mounting a
 * single Router instance at two paths re-runs whatever guards it already carries, so the
 * guards have to be a parameter.
 *
 * The routes, their order and their handlers are identical between the two mounts — only
 * who is let in differs. Preserve that when the remaining routers follow at Phase 5:
 * change the routes in `attachRoutes`, never in a second copy.
 */
function attachRoutes(router: Router): Router {
    /**
     * GET /overview
     * Platform-wide cash position: cash held by agents, agency liabilities,
     * unsettled collections.
     */
    router.get('/overview', AdminCodController.overview);

    /** GET /remittances — all agencies' remittances. Query: status?, agencyId?, page?, limit? */
    router.get('/remittances', AdminCodController.listRemittances);

    /**
     * POST /remittances/:id/confirm
     * Confirm cash receipt: lowers the agency's liability, FIFO-settles its
     * collections and unlocks the earnings those collections back.
     */
    router.post('/remittances/:id/confirm', AdminCodController.confirmRemittance);

    /**
     * POST /remittances/:id/reject
     * Reject a declared remittance (nothing arrived / mismatch). Body: { reason }
     */
    router.post('/remittances/:id/reject', AdminCodController.rejectRemittance);

    /**
     * GET /deposits — every agent hand-over.
     * Query: status?, recipient?, agencyId?, page?, limit?
     * `?status=declared&recipient=platform` is the platform's confirmation queue.
     */
    router.get('/deposits', AdminCodController.listDeposits);

    /**
     * POST /deposits
     * Record cash an agent paid the PLATFORM directly, bypassing the agency.
     * Clears the agent, the contract AND the agency, and settles the agency's
     * collections FIFO. Body: { agentId, agencyId, amount, reference, note? }
     */
    router.post('/deposits', AdminCodController.recordDirectDeposit);

    /** POST /deposits/:id/confirm — confirm an agent's declared direct payment. */
    router.post('/deposits/:id/confirm', AdminCodController.confirmDeposit);

    /** POST /deposits/:id/reject — reject one. Body: { reason } */
    router.post('/deposits/:id/reject', AdminCodController.rejectDeposit);

    /** GET /discrepancies — all flags. Query: status?, type?, agencyId?, agentId?, page?, limit? */
    router.get('/discrepancies', AdminCodController.listDiscrepancies);

    /**
     * POST /discrepancies/:id/resolve
     * Close a flag ('resolved' | 'written_off'); unblocks the agency's reserve
     * releases. Body: { resolution, note }
     */
    router.post('/discrepancies/:id/resolve', AdminCodController.resolveDiscrepancy);

    /** GET /agents — agents currently holding cash (+ trust context). */
    router.get('/agents', AdminCodController.listAgents);

    /**
     * POST /agents/:id/trust-adjustment
     * Manual trust-score correction. Body: { delta: -100..100, note }
     */
    router.post('/agents/:id/trust-adjustment', AdminCodController.adjustTrust);

    /**
     * PUT /agents/:id/trust-override
     * Pin a trust score that OUTRANKS the computed one, or release it with
     * `score: null`. Body: { score: 0..100 | null, reason }
     *
     * ⚠ Not the same thing as the adjustment above. That one nudges the COMPUTED
     * score and is consumed by the next recompute; this one replaces it and
     * survives every recompute — which is the point (O-7).
     */
    router.put('/agents/:id/trust-override', AdminCodController.setTrustOverride);

    /** GET /agencies — agencies currently owing the platform cash. */
    router.get('/agencies', AdminCodController.listAgencies);

    return router;
}

/** Build the COD admin surface behind an arbitrary guard chain. */
export function buildAdminCodRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}

/**
 * ── There is NO public mount any more (Phase 5 Part E) ──────────────────────
 *
 * `const router = buildAdminCodRouter([requireAuth, requireRole(['admin'])]);`
 * and its default export stood here, serving the COD admin surface to any platform
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
