import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AgentProfileController } from './controllers/agent-profile.controller';
import { AgentInvitesController } from './controllers/agent-invites.controller';
import { ShipmentController } from '../shipments/shipment.controller';

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

/**
 * PATCH /api/agent/shipments/:id/tracking-number
 * Record/replace the carrier tracking number on a shipment assigned to this agent.
 * Body: { trackingNumber: string }
 */
router.patch('/shipments/:id/tracking-number', ShipmentController.setTrackingNumber);

export default router;
