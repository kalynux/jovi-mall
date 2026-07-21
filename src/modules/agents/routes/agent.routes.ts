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

// ─── Agency invites ──────────────────────────────────────────────────────────

/** GET /api/agent/invites — pending agency invites addressed to this agent's email. */
router.get('/invites', AgentSelfController.listInvites);

/** POST /api/agent/invites/:id/accept — join the inviting agency. */
router.post('/invites/:id/accept', AgentSelfController.acceptInvite);

/** POST /api/agent/invites/:id/decline */
router.post('/invites/:id/decline', AgentSelfController.declineInvite);

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

/** PATCH /api/agent/preferences — notification/navigation choices. */
router.patch('/preferences', AgentSelfController.updatePreferences);

/**
 * PATCH /api/agent/settings — operational config that affects dispatch
 * (max_concurrent_shipments is bounded by the platform ceiling).
 */
router.patch('/settings', AgentSelfController.updateSettings);

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

/** PUT /api/agent/memberships/:membershipId/primary — set default agency. */
router.put('/memberships/:membershipId/primary', AgentSelfController.setPrimary);

export default router;
