import { Router } from 'express';
import { requireServiceToken } from '../middlewares/service-token.middleware';
import { InternalAgentController } from '../controllers/internal-agent.controller';

/**
 * Internal agent API — mounted at /api/internal/agents.
 *
 * Consumed by geo-tracker only, authenticated by shared service token
 * (INTERNAL_SERVICE_TOKEN here === NODE_API_SERVICE_TOKEN there). No user
 * session is involved: geo-tracker is a service, not a person.
 *
 * Disabled entirely when the secret is unset — the guard fails closed, so an
 * unconfigured deploy exposes nothing.
 */
const router = Router();

router.use(requireServiceToken);

/**
 * POST /api/internal/agents/tracking-policies
 * Body: { agentIds: string[] }
 * Batch — declared before /:agentId so "tracking-policies" is not read as an id.
 */
router.post('/tracking-policies', InternalAgentController.resolveTrackingPolicies);

/** GET /api/internal/agents/:agentId/tracking-policy */
router.get('/:agentId/tracking-policy', InternalAgentController.getTrackingPolicy);

/**
 * POST /api/internal/agents/:agentId/tracking-state
 * Body: { status, position?, reportedAt?, locationServicesEnabled?, backgroundLocationEnabled? }
 *
 * geo-tracker reporting what it observed. Stored as a business mirror only —
 * jovi-mall never serves this back as a live position.
 */
router.post('/:agentId/tracking-state', InternalAgentController.reportTrackingState);

/** GET /api/internal/agents/:agentId/eligibility?agencyId= — diagnostics. */
router.get('/:agentId/eligibility', InternalAgentController.getEligibility);

export default router;
