import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AgentSelfController } from '../controllers/agent-self.controller';

/**
 * Agent self-service routes — mounted at /api/agent.
 *
 * Shipment and COD routes for agents live in their own modules and are mounted
 * on the same prefix separately; this router owns the agent's own record.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agent']));

// ─── Agency directory ────────────────────────────────────────────────────────

/**
 * GET /api/agent/agencies/browse?search=&region=&hq_city=&page=&limit=
 *
 * Agencies open for business, each annotated with `contract` — this agent's
 * standing with them, or null. The counterpart of
 * GET /api/agency/agents/browse.
 */
router.get('/agencies/browse', AgentSelfController.browseAgencies);

// ─── Profile & onboarding ────────────────────────────────────────────────────

/** GET /api/agent/profile */
router.get('/profile', AgentSelfController.getProfile);

/** PATCH /api/agent/profile */
router.patch('/profile', AgentSelfController.updateProfile);

/** GET /api/agent/profile/completion-status */
router.get('/profile/completion-status', AgentSelfController.getCompletionStatus);

/**
 * PATCH /api/agent/onboarding/step
 * Body: { step: 1 | 2, ...stepFields }
 *   Step 1: { vehicle_info: { vehicle_type, color, plate_number? } }
 *   Step 2: { skip?: boolean, avatar_url?, timezone? }
 */
router.patch('/onboarding/step', AgentSelfController.completeOnboardingStep);

// ─── Preferences & settings ──────────────────────────────────────────────────

/**
 * PATCH /api/agent/preferences — client-side choices (navigation app).
 * NOT notification delivery: that is PATCH /api/agent/notification-preferences,
 * owned by the notifications module.
 */
router.patch('/preferences', AgentSelfController.updatePreferences);

/**
 * GET|PATCH /api/agent/dispatch-settings — dispatch behaviour (auto-accept),
 * plus the read-only capacity block.
 *
 * NOT `/settings`: the billing router owns that path on this same prefix (see
 * the mount comment in src/api/index.ts). The concurrency ceiling is not
 * settable here — it comes from the agent's plan.
 */
router.get('/dispatch-settings', AgentSelfController.getDispatchSettings);
router.patch('/dispatch-settings', AgentSelfController.updateDispatchSettings);

// ─── Availability & working state ────────────────────────────────────────────

/** GET /api/agent/availability — declared availability + derived load. */
router.get('/availability', AgentSelfController.getAvailability);

/**
 * PUT /api/agent/availability
 * Body: { state: 'online' | 'offline' | 'on_break', reason?: string }
 * Going offline with shipments in flight is allowed — it stops NEW work only.
 */
router.put('/availability', AgentSelfController.setAvailability);

// ─── Device capabilities ─────────────────────────────────────────────────────

/** GET /api/agent/device */
router.get('/device', AgentSelfController.getDevice);

/**
 * PUT /api/agent/device — the app self-reporting capabilities.
 * Every field is tri-state: omit = unchanged, null = unknown, false = disabled.
 */
router.put('/device', AgentSelfController.reportDevice);

// ─── Payout destination ──────────────────────────────────────────────────────

/** GET /api/agent/payout-methods — masked; account numbers are never echoed. */
router.get('/payout-methods', AgentSelfController.getPayoutMethods);

/**
 * PUT /api/agent/payout-methods
 * Body: { payout_details: [{ method: 'mobile_money' | 'bank', ... }] }
 * Ordered, 1–3 entries; the FIRST is the one payouts use. Replaced wholesale.
 * Required before POST /api/agent/earnings/payout will succeed.
 */
router.put('/payout-methods', AgentSelfController.setPayoutMethods);

// ─── Agency memberships (multi-agency portfolio) ─────────────────────────────

/** GET /api/agent/memberships?status= — the agencies this agent serves. */
router.get('/memberships', AgentSelfController.listMemberships);

/** GET /api/agent/memberships/history — this agent's full membership trail. */
router.get('/memberships/history', AgentSelfController.getHistory);

/**
 * POST /api/agent/memberships/requests — apply to join an agency.
 * Body: { agencyId }
 * Creates a `pending` membership the agency must approve.
 */
router.post('/memberships/requests', AgentSelfController.requestToJoin);

/**
 * Responding to a request an AGENCY raised. There is no separate invite object
 * any more — an agency's request is a `pending` contract, so it arrives through
 * `GET /memberships?status=pending` like everything else, and `initiatedBy`
 * tells the client which of these three buttons to show.
 *
 * approve/reject apply when the AGENCY raised it; withdraw when this agent did.
 * Asking for the wrong one 403s rather than doing something surprising.
 *
 * The verbs match the agency's side and the vendor↔agency flow exactly — the
 * same four words mean the same four things everywhere.
 */

/** POST /api/agent/memberships/:membershipId/approve */
router.post('/memberships/:membershipId/approve', AgentSelfController.approveRequest);

/** POST /api/agent/memberships/:membershipId/reject — Body: { reason? } */
router.post('/memberships/:membershipId/reject', AgentSelfController.rejectRequest);

/** POST /api/agent/memberships/:membershipId/withdraw — Body: { reason? } */
router.post('/memberships/:membershipId/withdraw', AgentSelfController.withdrawRequest);

/**
 * POST /api/agent/memberships/:membershipId/terminate — Body: { reason? }
 * Ends an established contract. Needs the agency's agreement and a clear
 * balance, so the contract comes back null until they resolve it.
 */
router.post('/memberships/:membershipId/terminate', AgentSelfController.terminate);

/**
 * GET /api/agent/memberships/status-requests — contract transitions an agency
 * has raised that need this agent's consent (a removal, most often).
 *
 * Deliberately NOT `/memberships/requests`: that path already means "apply to
 * join an agency" above, which is the opposite direction.
 */
router.get('/memberships/status-requests', AgentSelfController.listStatusRequests);

/**
 * POST /api/agent/memberships/status-requests/:requestId/resolve
 * Body: { decision: 'approve' | 'reject', note? }
 * Refused if this agent raised the request themselves.
 */
router.post(
  '/memberships/status-requests/:requestId/resolve',
  AgentSelfController.resolveStatusRequest
);

/**
 * GET /api/agent/memberships/:membershipId — one contract, with the agency's
 * business name resolved. Declared after every literal path above, or Express
 * would match "history"/"requests"/"status-requests" as an id.
 */
router.get('/memberships/:membershipId', AgentSelfController.getMembership);

/** PUT /api/agent/memberships/:membershipId/primary — set default agency. */
router.put('/memberships/:membershipId/primary', AgentSelfController.setPrimary);

/**
 * GET /api/agent/memberships/:membershipId/settlements?page=&limit=
 * Cash and wages outstanding with THIS agency — the per-contract view that
 * decides whether a removal can complete.
 */
router.get('/memberships/:membershipId/settlements', AgentSelfController.listSettlements);

/**
 * POST /api/agent/memberships/:membershipId/transitions
 * Body: { transition: 'pause' | 'reactivate', reason? }
 *
 * The two lifecycle changes with no named endpoint. Both need the agency's
 * agreement, so the contract comes back null until they resolve it. Ending a
 * contract is `/terminate` above, not a transition here.
 */
router.post('/memberships/:membershipId/transitions', AgentSelfController.requestTransition);

export default router;
