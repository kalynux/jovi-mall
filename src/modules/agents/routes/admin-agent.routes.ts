import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AdminAgentController } from '../controllers/admin-agent.controller';

/** Admin agent administration — mounted at /api/admin/agents. */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

/**
 * POST /api/admin/agents/transfer
 * Body: { agentId, fromAgencyId, toAgencyId, reason? }
 *
 * Admin-only: an agency must not be able to pull an agent off a rival's
 * roster. Declared before /:agentId so "transfer" is not read as an id.
 */
router.post('/transfer', AdminAgentController.transfer);

/** GET /api/admin/agents/:agentId — profile + every membership. */
router.get('/:agentId', AdminAgentController.getAgent);

/**
 * PATCH /api/admin/agents/:agentId/status
 * Body: { status, reason? } — reason required when suspending.
 * Memberships are intentionally left intact so reinstatement restores them.
 */
router.patch('/:agentId/status', AdminAgentController.setStatus);

/**
 * PUT /api/admin/agents/:agentId/tracking-allow
 * Body: { allowed: boolean, reason? } — reason required when disabling.
 * jovi-mall owns this flag; geo-tracker enforces it.
 */
router.put('/:agentId/tracking-allow', AdminAgentController.setTrackingAllowed);

/** GET /api/admin/agents/:agentId/tracking-policy — what geo-tracker would see. */
router.get('/:agentId/tracking-policy', AdminAgentController.getTrackingPolicy);

/** GET /api/admin/agents/:agentId/history */
router.get('/:agentId/history', AdminAgentController.getHistory);

/** GET /api/admin/agents/:agentId/eligibility?agencyId= */
router.get('/:agentId/eligibility', AdminAgentController.getEligibility);

export default router;
