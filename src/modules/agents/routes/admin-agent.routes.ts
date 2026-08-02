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

/**
 * PUT /api/admin/agents/:agentId/kyc
 * Body: { status, reference?, rejectionReason? } — reason required on reject.
 * Eligibility passes only on `verified`, so this is what lets an agent work.
 */
router.put('/:agentId/kyc', AdminAgentController.setKyc);

/**
 * PUT /api/admin/agents/:agentId/ban
 * Body: { banned: boolean, reason? } — reason required when banning.
 * An override consulted by every gate, not a cascade over contracts.
 */
router.put('/:agentId/ban', AdminAgentController.setBan);

/**
 * PUT /api/admin/agents/:agentId/cod-threshold
 * Body: { maxThreshold } — the agent's whole COD pool, which every contract
 * sub-allocates from. Lowering below what is already allocated is rejected.
 */
router.put('/:agentId/cod-threshold', AdminAgentController.setCodThreshold);

/** GET /api/admin/agents/:agentId/cod-allocation — pool, slices, headroom. */
router.get('/:agentId/cod-allocation', AdminAgentController.getCodAllocation);

/** GET /api/admin/agents/:agentId/history */
router.get('/:agentId/history', AdminAgentController.getHistory);

/** GET /api/admin/agents/:agentId/eligibility?agencyId= */
router.get('/:agentId/eligibility', AdminAgentController.getEligibility);

export default router;
