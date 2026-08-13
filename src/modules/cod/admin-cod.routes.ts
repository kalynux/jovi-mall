import { RequestHandler, Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AdminCodController } from './controllers/admin-cod.controller';

/**
 * Admin COD Routes — platform oversight of the cash-on-delivery chain.
 *
 * Mounted TWICE, at two paths, behind two different guards:
 *
 *   /api/admin/cod            requireAuth + requireRole(['admin'])   the dashboard, today
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

/** The public mount — unchanged behaviour, same guards and same paths as before. */
const router = buildAdminCodRouter([requireAuth, requireRole(['admin'])]);

export default router;
