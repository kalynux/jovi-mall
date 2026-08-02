import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AgencyRosterController } from '../controllers/agency-roster.controller';

/**
 * Agency roster routes — mounted at /api/agency/agents.
 *
 * Route ordering matters here: the literal segments (`/eligible`, `/history`,
 * `/browse`, `/requests`) are declared before the `:membershipId` / `:agentId`
 * patterns, or Express would match "eligible" as an id and every request would
 * 400 on validation.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

// ─── Literal paths first (see note above) ────────────────────────────────────

/** GET /api/agency/agents/eligible — agents dispatchable right now. */
router.get('/eligible', AgencyRosterController.listEligible);

/** GET /api/agency/agents/history — membership trail across the whole roster. */
router.get('/history', AgencyRosterController.getRosterHistory);

/**
 * GET /api/agency/agents/status-requests — transitions an agent has raised that
 * need this agency's consent.
 */
router.get('/status-requests', AgencyRosterController.listStatusRequests);

/**
 * POST /api/agency/agents/status-requests/:requestId/resolve
 * Body: { decision: 'approve' | 'reject', note? }
 * Refused if this agency raised the request itself.
 */
router.post('/status-requests/:requestId/resolve', AgencyRosterController.resolveStatusRequest);

// ─── Directory & requests ────────────────────────────────────────────────────

/**
 * GET /api/agency/agents/browse
 * ?search=&vehicle_type=&availability=&min_trust_score=&lng=&lat=&radius_km=
 * &sort=trust|name&page=&limit=
 *
 * The platform-wide agent directory. Only agents who could actually accept are
 * listed (active, KYC-verified, not banned, onboarded). Each row carries
 * `contract` — this agency's standing with that agent, or null.
 */
router.get('/browse', AgencyRosterController.browseAgents);

/**
 * POST /api/agency/agents/requests — Body: { agentId }
 * Asks a specific agent to contract. Lands `pending`; the AGENT accepts.
 */
router.post('/requests', AgencyRosterController.requestAgent);

// ─── Roster ──────────────────────────────────────────────────────────────────

/** GET /api/agency/agents?status=pending|approved|suspended|removed */
router.get('/', AgencyRosterController.listAgents);

/** GET /api/agency/agents/:membershipId */
router.get('/:membershipId', AgencyRosterController.getAgent);

// ─── The handshake ───────────────────────────────────────────────────────────
//
// approve/decline answer an agent's application; withdraw pulls back a request
// THIS agency raised. Which of the two applies is decided by who raised the
// contract, not by the caller — the initiator guard in AgentContractService
// 403s the wrong one.

/** POST /api/agency/agents/:membershipId/approve — accept an agent's application. */
router.post('/:membershipId/approve', AgencyRosterController.approve);

/** POST /api/agency/agents/:membershipId/reject — Body: { reason? } */
router.post('/:membershipId/reject', AgencyRosterController.reject);

/** POST /api/agency/agents/:membershipId/withdraw — Body: { reason? } */
router.post('/:membershipId/withdraw', AgencyRosterController.withdrawRequest);

// ─── Suspension ──────────────────────────────────────────────────────────────

/**
 * POST /api/agency/agents/:membershipId/suspend — Body: { reason }
 * Stops new assignments; in-flight shipments are untouched by design.
 */
router.post('/:membershipId/suspend', AgencyRosterController.suspend);

/**
 * POST /api/agency/agents/:membershipId/pause — Body: { reason? }
 * A mutual break rather than a sanction; reinstate returns from either.
 */
router.post('/:membershipId/pause', AgencyRosterController.pause);

/** POST /api/agency/agents/:membershipId/reinstate */
router.post('/:membershipId/reinstate', AgencyRosterController.reinstate);

// ─── Termination ─────────────────────────────────────────────────────────────

/**
 * POST /api/agency/agents/:membershipId/terminate — Body: { reason? }
 *
 * Proposes ending the contract. Needs the agent's consent, and is blocked while
 * they hold this agency's undeposited COD cash or are owed wages under it.
 *
 * `DELETE /:membershipId` is the same handler under its original spelling. The
 * POST form is the canonical one — it matches the agent's `/terminate` and the
 * vendor↔agency flow's verb.
 */
router.post('/:membershipId/terminate', AgencyRosterController.terminate);
router.delete('/:membershipId', AgencyRosterController.terminate);

// ─── Agency-scoped agent config ──────────────────────────────────────────────

/** PATCH /api/agency/agents/:membershipId/employment */
router.patch('/:membershipId/employment', AgencyRosterController.updateEmployment);

/**
 * PATCH /api/agency/agents/:membershipId/terms
 * Body: { employment?, remittance_terms?, coverage?, fee_split?, shipment_value_ceiling? }
 * Every negotiated term except the COD threshold, which is bounded by the
 * agent's shared pool and has its own endpoint below. `fee_split` is what the
 * earnings split divides by at delivery.
 */
router.patch('/:membershipId/terms', AgencyRosterController.updateTerms);

/**
 * PATCH /api/agency/agents/:membershipId/cod-limit
 * Body: { threshold: number } — this contract's slice of the agent's COD pool.
 */
router.patch('/:membershipId/cod-limit', AgencyRosterController.setCodLimit);

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * GET /api/agency/agents/:membershipId/settlements?page=&limit=
 * This contract's cash history plus what is still outstanding under it.
 */
router.get('/:membershipId/settlements', AgencyRosterController.listSettlements);

/** GET /api/agency/agents/:agentId/eligibility — every blocker at once. */
router.get('/:agentId/eligibility', AgencyRosterController.getEligibility);

/** GET /api/agency/agents/:agentId/history */
router.get('/:agentId/history', AgencyRosterController.getAgentHistory);

export default router;
