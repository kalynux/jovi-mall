import { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { agentAssignabilityService } from './domain/services/agent-assignability.service';

const ObjectIdSchema = z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id');

const AgentIdParamSchema = z.object({ agentId: ObjectIdSchema });

/**
 * `shipmentId` is optional and that is the whole point of the endpoint's shape.
 *
 * Support usually reaches this having been told "I can't assign my agent", with
 * an agency and an agent and no shipment id at all. Requiring one would make the
 * diagnostic unreachable at exactly the moment it is wanted.
 */
const AssignabilityQuerySchema = z.object({
  agencyId: ObjectIdSchema,
  shipmentId: ObjectIdSchema.optional(),
});

/**
 * Admin assignability diagnostic — "why can this agent not take this work?".
 *
 * ── Why this is a SECOND router mounted at `/agents` ─────────────────────────
 *
 * The subject is an agent, so the path belongs under `/agents` beside
 * `/eligibility` and `/cod-allocation`. The handler, however, lives in
 * shipment-assignment: it composes `AgentEligibilityService` with
 * `ContractPolicyService`, and the latter reaches into cod/ and orders/.
 *
 * Putting the route in `agents/routes/admin-agent.routes.ts` would make the
 * agents module import shipment-assignment, which already imports agents —
 * a cycle whose failure mode is a singleton that is `undefined` at module-init
 * time, i.e. a crash at boot or, worse, at first request. Mounting a second
 * router at the same prefix costs nothing: Express tries them in order, and
 * `/:agentId/assignability` is two segments, so the first router's `/:agentId`
 * never matches it.
 *
 * ── Read-only, admin-only, unaudited ────────────────────────────────────────
 *
 * A GET that mutates nothing. It is NOT audited, matching every other route on
 * `/api/internal/admin/system/*` and the sibling verdict reads: the two audited
 * GETs in this platform are audited because they disclose a person's live
 * COORDINATES, which this does not.
 *
 * It does disclose an agent's cash position across EVERY agency they serve —
 * which is what the gate compares against, and is why this is admin-only and
 * was not also given to the agency asking the question.
 */
function attachRoutes(router: Router): Router {
    /**
     * GET /:agentId/assignability?agencyId=&shipmentId=
     *
     * Every gate on giving this agent work from this agency, each with what the
     * rule saw, an English line, and — where one exists — what would fix it.
     *
     * With `shipmentId`: the full question, including the two shipment-scoped
     * gates (coverage region, per-shipment value ceiling) and the cash gate run
     * with that shipment's value added.
     *
     * Without it: those two report `skipped`, and the cash gate answers "is this
     * agent already at their limit for this agency", which is the question asked
     * before a shipment id is to hand.
     */
    router.get(
        '/:agentId/assignability',
        asyncHandler(async (req: Request, res: Response) => {
            const { agentId } = AgentIdParamSchema.parse(req.params);
            const { agencyId, shipmentId } = AssignabilityQuerySchema.parse(req.query);

            const result = await agentAssignabilityService.evaluate(agentId, agencyId, shipmentId ?? null);

            res.json({ success: true, data: result });
        })
    );

    return router;
}

/**
 * Build the assignability surface behind an arbitrary guard chain.
 *
 * The factory shape is `admin-agent.routes.ts`'s and exists for the same reason
 * stated there — the guards must be a parameter rather than baked in.
 *
 * ⚠ There is deliberately NO public instantiation. This reports one agent's cash
 * exposure across every agency they serve; an agency-facing mount would show one
 * agency what its agent is carrying for a competitor.
 */
export function buildAdminAssignabilityRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}
