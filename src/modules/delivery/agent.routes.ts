import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AgentProfileController } from './controllers/agent-profile.controller';
import { AgentInvitesController } from './controllers/agent-invites.controller';
import { ShipmentController } from '../shipments/shipment.controller';
import { AgentCodController } from '../cod/controllers/agent-cod.controller';

const router = Router();

router.use(requireAuth);
router.use(requireRole(['agent']));

// ─── Agency membership (invites) ─────────────────────────────────────────────

/** GET /api/agent/invites — pending agency invites addressed to this agent's email. */
router.get('/invites', AgentInvitesController.listInvites);

/** POST /api/agent/invites/:id/accept — join the inviting agency. */
router.post('/invites/:id/accept', AgentInvitesController.acceptInvite);

/** POST /api/agent/invites/:id/decline */
router.post('/invites/:id/decline', AgentInvitesController.declineInvite);

/** GET /api/agent/profile */
router.get('/profile', AgentProfileController.getProfile);

/** PATCH /api/agent/profile */
router.patch('/profile', AgentProfileController.updateProfile);

/** GET /api/agent/profile/completion-status */
router.get('/profile/completion-status', AgentProfileController.getCompletionStatus);

/**
 * PATCH /api/agent/onboarding/step
 * Body: { step: 1 | 2, ...stepFields }
 *   Step 1: { vehicle_info: { vehicle_type, color, plate_number? } }
 *   Step 2: { skip?: boolean, avatar_url?, timezone? }
 */
router.patch('/onboarding/step', AgentProfileController.completeOnboardingStep);

// ─── Shipments (agent work queue) ─────────────────────────────────────────────

/**
 * GET /api/agent/shipments
 * Shipments assigned to this agent, newest first. Query: status?, page?, limit?
 */
router.get('/shipments', ShipmentController.listForAgent);

/**
 * GET /api/agent/shipments/:id
 * Full detail: items, pickup locations, customer + delivery address, and (COD)
 * the cash to collect. The customer's delivery code is never included.
 */
router.get('/shipments/:id', ShipmentController.getDetailForAgent);

/**
 * PATCH /api/agent/shipments/:id/tracking-number
 * Record/replace the carrier tracking number on a shipment assigned to this agent.
 * Body: { trackingNumber: string }
 */
router.patch('/shipments/:id/tracking-number', ShipmentController.setTrackingNumber);

// ─── COD (cash on delivery) ───────────────────────────────────────────────────

/**
 * POST /api/agent/shipments/:id/cod/collect
 * Submit the customer's delivery code at handoff: records the cash collected
 * and marks the shipment delivered, atomically.
 * Body: { code: string, location?: { lat, lng }, deviceInfo?: string }
 */
router.post('/shipments/:id/cod/collect', AgentCodController.collect);

/**
 * POST /api/agent/shipments/:id/cod/resend-code
 * Send a FRESH delivery code to the customer (lost/locked code). Rate-limited.
 */
router.post('/shipments/:id/cod/resend-code', AgentCodController.resendCode);

/** GET /api/agent/cod/balance — cash this agent currently holds (owed to the agency). */
router.get('/cod/balance', AgentCodController.getBalance);

/** GET /api/agent/cod/ledger — append-only history of this agent's cash movements. */
router.get('/cod/ledger', AgentCodController.getLedger);

/** GET /api/agent/cod/deposits — this agent's recorded cash hand-overs to the agency. */
router.get('/cod/deposits', AgentCodController.listDeposits);

export default router;
