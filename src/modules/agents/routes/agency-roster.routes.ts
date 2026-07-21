import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AgencyRosterController } from '../controllers/agency-roster.controller';

/**
 * Agency roster routes — mounted at /api/agency/agents.
 *
 * Route ordering matters here: the literal segments (`/eligible`, `/history`)
 * are declared before the `:membershipId` / `:agentId` patterns, or Express
 * would match "eligible" as an id and every request would 400 on validation.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

// ─── Literal paths first (see note above) ────────────────────────────────────

/** GET /api/agency/agents/eligible — agents dispatchable right now. */
router.get('/eligible', AgencyRosterController.listEligible);

/** GET /api/agency/agents/history — membership trail across the whole roster. */
router.get('/history', AgencyRosterController.getRosterHistory);

// ─── Invites ─────────────────────────────────────────────────────────────────

/** POST /api/agency/agents/invites — Body: { email } */
router.post('/invites', AgencyRosterController.invite);

/** GET /api/agency/agents/invites?status= */
router.get('/invites', AgencyRosterController.listInvites);

/** DELETE /api/agency/agents/invites/:id */
router.delete('/invites/:id', AgencyRosterController.revokeInvite);

// ─── Roster ──────────────────────────────────────────────────────────────────

/** GET /api/agency/agents?status=pending|approved|suspended|removed */
router.get('/', AgencyRosterController.listAgents);

/** GET /api/agency/agents/:membershipId */
router.get('/:membershipId', AgencyRosterController.getAgent);

// ─── Approval (join requests) ────────────────────────────────────────────────

/** POST /api/agency/agents/:membershipId/approve */
router.post('/:membershipId/approve', AgencyRosterController.approve);

/** POST /api/agency/agents/:membershipId/decline — Body: { reason? } */
router.post('/:membershipId/decline', AgencyRosterController.decline);

// ─── Suspension ──────────────────────────────────────────────────────────────

/**
 * POST /api/agency/agents/:membershipId/suspend — Body: { reason }
 * Stops new assignments; in-flight shipments are untouched by design.
 */
router.post('/:membershipId/suspend', AgencyRosterController.suspend);

/** POST /api/agency/agents/:membershipId/reinstate */
router.post('/:membershipId/reinstate', AgencyRosterController.reinstate);

// ─── Removal ─────────────────────────────────────────────────────────────────

/**
 * DELETE /api/agency/agents/:membershipId — Body: { reason? }
 * Blocked while the agent has this agency's shipments in flight or holds
 * undeposited COD cash.
 */
router.delete('/:membershipId', AgencyRosterController.remove);

// ─── Agency-scoped agent config ──────────────────────────────────────────────

/** PATCH /api/agency/agents/:membershipId/employment */
router.patch('/:membershipId/employment', AgencyRosterController.updateEmployment);

/**
 * PATCH /api/agency/agents/:membershipId/cod-limit
 * Body: { maxExposureOverride: number | null }
 */
router.patch('/:membershipId/cod-limit', AgencyRosterController.setCodLimit);

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/** GET /api/agency/agents/:agentId/eligibility — every blocker at once. */
router.get('/:agentId/eligibility', AgencyRosterController.getEligibility);

/** GET /api/agency/agents/:agentId/history */
router.get('/:agentId/history', AgencyRosterController.getAgentHistory);

export default router;
