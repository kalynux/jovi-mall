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
 * GET /api/agency/agents/status-requests — every PENDING contract transition on
 * this agency's roster, whoever raised it. Not only the agents': the query
 * filters on the agency and on `pending`, so requests this agency raised and
 * the agent has not answered appear here too. Read `requestedByRole` to tell
 * them apart — it decides which of the two verbs below applies.
 */
router.get('/status-requests', AgencyRosterController.listStatusRequests);

/**
 * POST /api/agency/agents/status-requests/:requestId/resolve
 * Body: { decision: 'approve' | 'reject', note? }
 * Answers a request the AGENT raised. Refused if this agency raised it.
 */
router.post('/status-requests/:requestId/resolve', AgencyRosterController.resolveStatusRequest);

/**
 * POST /api/agency/agents/status-requests/:requestId/cancel
 * Body: { note? }
 * Pulls back a request THIS AGENCY raised, while it is still pending — a
 * termination proposal thought better of, most often. The exact inverse of
 * `/resolve`: refused if the agent raised it. The contract does not move, so
 * `membership` is always null.
 */
router.post('/status-requests/:requestId/cancel', AgencyRosterController.cancelStatusRequest);

// ─── Terms proposals (LIVE contracts) ────────────────────────────────────────
//
// Declared here, above `/:membershipId`, for the same reason as the status
// requests above: Express matches in declaration order, and a `:membershipId`
// route declared first would swallow `/terms-proposals` as an id.
//
// A PENDING contract is not negotiated through these — it is countered in place
// via `/:membershipId/counter`. See ContractTermsProposal's header for why the
// two paths are deliberately different mechanisms.

/**
 * GET /api/agency/agents/terms-proposals
 * Every open terms proposal on this agency's contracts, in BOTH directions —
 * ones the agent raised that await an answer, and ones this agency raised that
 * await the agent's. `awaitingMyDecision` on each row tells them apart, and is
 * the correct predicate for a badge count.
 */
router.get('/terms-proposals', AgencyRosterController.listTermsProposals);

/**
 * POST /api/agency/agents/terms-proposals/:proposalId/resolve
 * Body: { decision: 'approve' | 'reject', note? }
 * Answers a proposal the AGENT raised. On approve the terms are applied in the
 * same transaction that resolves the proposal.
 */
router.post('/terms-proposals/:proposalId/resolve', AgencyRosterController.resolveTermsProposal);

/**
 * POST /api/agency/agents/terms-proposals/:proposalId/cancel — Body: { note? }
 * Pulls back a proposal THIS agency raised. The inverse of `/resolve`.
 */
router.post('/terms-proposals/:proposalId/cancel', AgencyRosterController.cancelTermsProposal);

/**
 * POST /api/agency/agents/terms-proposals/:proposalId/counter
 * Body: { terms, note? }
 * Supersedes the agent's open proposal with this agency's own, in one
 * transaction. Distinct from `/resolve` with 'reject': a counter keeps the
 * negotiation alive and records the chain via `supersedesId`.
 */
router.post('/terms-proposals/:proposalId/counter', AgencyRosterController.counterTermsProposal);

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
 * POST /api/agency/agents/requests — Body: { agentId, terms }
 * Asks a specific agent to contract ON STATED TERMS. Lands `pending`; the agent
 * accepts, rejects or counters. `terms.fee_split` is required — an invitation
 * with no numbers would land the agent on a default that pays them zero.
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

/**
 * POST /api/agency/agents/:membershipId/counter
 * Body: { remittance_terms?, coverage?, fee_split?, shipment_value_ceiling? }
 *
 * Counters the terms standing on a PENDING contract: overwrites them and moves
 * the right to approve to the agent. Refused if this agency's terms are already
 * the ones standing — that is a revision, and the way to retract an offer is
 * `/withdraw`.
 */
router.post('/:membershipId/counter', AgencyRosterController.counterTerms);

/**
 * POST /api/agency/agents/:membershipId/terms-proposals
 * Body: { terms, note? }
 *
 * Proposes a change to a LIVE contract. The contract is NOT modified — it keeps
 * pricing deliveries by its agreed terms until the agent accepts. At most one
 * proposal may be open per contract.
 */
router.post('/:membershipId/terms-proposals', AgencyRosterController.proposeTermsChange);

/** GET /api/agency/agents/:membershipId/terms-proposals — this contract's trail. */
router.get('/:membershipId/terms-proposals', AgencyRosterController.listContractProposals);

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
 * Body: { remittance_terms?, coverage?, fee_split?, shipment_value_ceiling? }
 *
 * **Status-aware.** On a PENDING contract this is the agency's counter and
 * behaves exactly like `/:membershipId/counter`. On a LIVE one it returns
 * **409 CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED** and points at
 * `/:membershipId/terms-proposals`: a live contract is pricing deliveries by
 * its agreed `fee_split` right now, and rewriting that under the agent is what
 * the negotiation exists to prevent.
 *
 * `employment` is NOT negotiated and keeps `/employment` above, which writes at
 * any status — it is the agency's own HR record, not a term of the bargain.
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
