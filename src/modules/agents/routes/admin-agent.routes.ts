import { RequestHandler, Router } from 'express';
import { AdminAgentController } from '../controllers/admin-agent.controller';

/**
 * Admin agent administration.
 *
 * Mounted ONCE. It used to be mounted twice, at two paths behind two different guards:
 *
 *   (none — the public mount was deleted at the Phase 5 cutover)
 *   /api/internal/admin/agents   requireAdminCaller                     the wi-admin service
 *
 * The factory shape and the reason for it are `admin-cod.routes.ts`'s: both surfaces run at
 * once until cutover, and mounting a single Router instance twice re-runs the guards it
 * already carries — so the guards have to be a parameter. Change the routes in
 * `attachRoutes`, never in a second copy.
 *
 * ── What wi-admin calls, and what it does not ─────────────────────────────────
 * wi-admin reads the `delivery_agents` collection DIRECTLY (ADR-008 D-1: a record is read
 * directly, a verdict is delegated), so `GET /:agentId` and `GET /:agentId/history` are not
 * on its path even though they are mounted here. What it does call is the three reads whose
 * answer is a VERDICT the platform acts on — `tracking-policy`, `cod-allocation`,
 * `eligibility` — plus every write. Those are the ones a second implementation would drift
 * on: eligibility reports every failed rule at once, and a copy loses that property first.
 */
function attachRoutes(router: Router): Router {
    /**
     * POST /transfer
     * Body: { agentId, fromAgencyId, toAgencyId, reason? }
     *
     * Admin-only: an agency must not be able to pull an agent off a rival's
     * roster. Declared before /:agentId so "transfer" is not read as an id.
     */
    router.post('/transfer', AdminAgentController.transfer);

    /**
     * POST /contracts/:contractId/{suspend,reinstate,deactivate}
     *
     * Administrative intervention on ONE agent↔agency contract. Declared before
     * `/:agentId` so "contracts" is not read as an agent id.
     *
     * ── The line these three sit on ─────────────────────────────────────────────
     * An administrator may FREEZE or END a relationship. They may not APPROVE a pending
     * one or REWRITE its terms — a `terms_proposed_by: null` contract exists precisely
     * because nobody has stated terms, and approving it would bind an agent to a default
     * that pays zero. Those two stay refused; see `AgentContractService.adminSuspend`'s
     * header for the full argument, and note that `deactivate` still requires the
     * counterparty and the §4 cash conditions — there is no override.
     */
    router.post('/contracts/:contractId/suspend', AdminAgentController.suspendContract);
    router.post('/contracts/:contractId/reinstate', AdminAgentController.reinstateContract);
    router.post('/contracts/:contractId/deactivate', AdminAgentController.deactivateContract);

    /** GET /:agentId — profile + every membership. */
    router.get('/:agentId', AdminAgentController.getAgent);

    /**
     * PATCH /:agentId/status
     * Body: { status, reason? } — reason required when suspending.
     * Memberships are intentionally left intact so reinstatement restores them.
     */
    router.patch('/:agentId/status', AdminAgentController.setStatus);

    /**
     * PUT /:agentId/tracking-allow
     * Body: { allowed: boolean, reason? } — reason required when disabling.
     *
     * jovi-mall owns this flag; geo-tracker enforces it. Since Phase 9 the decision is
     * also PUSHED to geo-tracker (an `agent.tracking_allow_changed` outbox row), which
     * suppresses the live position. Before that it was inert across the boundary: the
     * flag stopped new dispatch and nothing else.
     */
    router.put('/:agentId/tracking-allow', AdminAgentController.setTrackingAllowed);

    /** GET /:agentId/tracking-policy — what geo-tracker would see. */
    router.get('/:agentId/tracking-policy', AdminAgentController.getTrackingPolicy);

    /**
     * PUT /:agentId/kyc
     * Body: { status, reference?, rejectionReason? } — reason required on reject.
     * Eligibility passes only on `verified`, so this is what lets an agent work.
     */
    router.put('/:agentId/kyc', AdminAgentController.setKyc);

    /**
     * PUT /:agentId/ban
     * Body: { banned: boolean, reason? } — reason required when banning.
     * An override consulted by every gate, not a cascade over contracts.
     *
     * wi-admin splits this into `POST /ban` and `POST /unban` on its own surface, because
     * a boolean standing in for a state collapses two opposite acts under one audit label.
     * Both map onto this one endpoint with different bodies — the split is in the API
     * contract, not in the mechanism.
     */
    router.put('/:agentId/ban', AdminAgentController.setBan);

    /**
     * PUT /:agentId/cod-threshold
     * Body: { maxThreshold } — the agent's whole COD pool, which every contract
     * sub-allocates from. Lowering below what is already allocated is rejected.
     */
    router.put('/:agentId/cod-threshold', AdminAgentController.setCodThreshold);

    /** GET /:agentId/cod-allocation — pool, slices, headroom. */
    router.get('/:agentId/cod-allocation', AdminAgentController.getCodAllocation);

    /** GET /:agentId/history */
    router.get('/:agentId/history', AdminAgentController.getHistory);

    /** GET /:agentId/eligibility?agencyId= */
    router.get('/:agentId/eligibility', AdminAgentController.getEligibility);

    return router;
}

/** Build the agent admin surface behind an arbitrary guard chain. */
export function buildAdminAgentRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}

/**
 * ── There is NO public mount any more (Phase 5 Part E) ──────────────────────
 *
 * `const router = buildAdminAgentRouter([requireAuth, requireRole(['admin'])]);`
 * and its default export stood here, serving the agent admin surface to any platform
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
