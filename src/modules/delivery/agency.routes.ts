import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AgencyProfileController, uploadAgencyPolicyDocuments } from './controllers/agency-profile.controller';
import { AgencyNetworkController } from './controllers/agency-network.controller';
import { AgencyAgentsController } from './controllers/agency-agents.controller';
import { AgencyNotificationController } from './controllers/agency-notification.controller';
import { ShipmentController } from '../shipments/shipment.controller';
import { AgencyCodController } from '../cod/controllers/agency-cod.controller';
import { DeviceTokenController } from '../notifications/controllers/device-token.controller';

const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

// ─── Agency Creation ──────────────────────────────────────────────────────────

/**
 * POST /api/agency
 * Initialize agency onboarding (sets agency_name on existing doc).
 * Body: { agency_name: string }
 */
router.post('/', AgencyProfileController.createAgency);

// ─── Profile ──────────────────────────────────────────────────────────────────

/** GET /api/agency/profile */
router.get('/profile', AgencyProfileController.getProfile);

/** PATCH /api/agency/profile */
router.patch('/profile', AgencyProfileController.updateProfile);

// ─── Onboarding ───────────────────────────────────────────────────────────────

/**
 * GET /api/agency/onboarding/status
 * Full onboarding state: current step, progress %, completed/missing fields, warnings
 */
router.get('/onboarding/status', AgencyProfileController.getOnboardingStatus);

/**
 * PUT /api/agency/onboarding/logistics
 * Step 1 (Required): coverage_areas (min 1), headquarters_addresses (min 1; first = primary)
 * Optional: { version } for optimistic concurrency
 */
router.put('/onboarding/logistics', AgencyProfileController.completeLogisticsSetup);

/**
 * PUT /api/agency/onboarding/payout
 * Step 2 (Required): payout_details
 * Optional: { version } for optimistic concurrency
 */
router.put('/onboarding/payout', AgencyProfileController.completePayoutSetup);

/**
 * PUT /api/agency/onboarding/branding
 * Step 3 (Optional/Skippable): { skip?: boolean, logo_url?, timezone? }
 * Optional: { version } for optimistic concurrency
 */
router.put('/onboarding/branding', AgencyProfileController.completeBrandingSetup);

/**
 * PUT /api/agency/onboarding/policies
 * Step 4 (Required): { policies: { pricing, returns, damage } }
 * Optional: { version } for optimistic concurrency
 */
router.put('/onboarding/policies', AgencyProfileController.completePolicySetup);

/**
 * POST /api/agency/profile/policy-documents
 * Upload 1-2 supporting PDF documents (max 5MB each, field name "documents").
 * Standalone upload path, unrelated to the product/ticket media pipeline.
 * Returns public URLs to submit via `policies.documents` on the policy-setup
 * or profile-update endpoints.
 */
router.post('/profile/policy-documents', uploadAgencyPolicyDocuments, AgencyProfileController.uploadPolicyDocuments);

// ─── Agents (roster & invites) ──────────────────────────────────────────────

/**
 * POST /api/agency/agents/invites
 * Invite a delivery agent to join this agency's roster, by email.
 * Body: { email: string }
 */
router.post('/agents/invites', AgencyAgentsController.invite);

/**
 * GET /api/agency/agents/invites
 * This agency's invites. Query: status? ('pending' | 'accepted' | 'declined' | 'revoked')
 */
router.get('/agents/invites', AgencyAgentsController.listInvites);

/** DELETE /api/agency/agents/invites/:id — revoke a pending invite. */
router.delete('/agents/invites/:id', AgencyAgentsController.revokeInvite);

/** GET /api/agency/agents — the agency's agent roster. */
router.get('/agents', AgencyAgentsController.listAgents);

/**
 * DELETE /api/agency/agents/:id
 * Unlink an agent from the roster. Blocked while the agent has shipments in
 * flight or undeposited COD cash.
 */
router.delete('/agents/:id', AgencyAgentsController.unlinkAgent);

/**
 * PATCH /api/agency/agents/:id/cod-limit
 * Cap this agent's COD cash exposure (null = platform default).
 * Body: { maxExposureOverride: number | null }
 */
router.patch('/agents/:id/cod-limit', AgencyAgentsController.setCodLimit);

// ─── Shipments ──────────────────────────────────────────────────────────────

/**
 * GET /api/agency/shipments
 * Shipments assigned to this agency (requirement #1). Query: status?, page?, limit?
 */
router.get('/shipments', ShipmentController.listForAgency);

/**
 * GET /api/agency/shipments/:id
 * Full detail: items, vendor (#4), customer + delivery address (#5), pickup
 * location (#3), assigned agent, status history, and the order's merged
 * multi-agency timeline.
 */
router.get('/shipments/:id', ShipmentController.getDetailForAgency);

/**
 * PATCH /api/agency/shipments/:id/status
 * Agency-driven status transition (requirement #10).
 * Body: { status: 'picked_up' | 'in_transit' | 'agent_delivered' | 'failed' | 'returned' }
 */
router.patch('/shipments/:id/status', ShipmentController.updateStatus);

/**
 * POST /api/agency/shipments/:id/reject
 * Reject an assigned (not yet picked up) shipment with a scoped reason (requirement #2).
 * Body: { reason: 'out_of_coverage_area' | 'capacity_exceeded' | 'invalid_address' | 'vendor_item_not_ready' | 'other' }
 */
router.post('/shipments/:id/reject', ShipmentController.reject);

/**
 * PATCH /api/agency/shipments/:id/assign-agent
 * Assign one of this agency's own agents to a shipment (requirement #6).
 * Body: { agentId: string }
 */
router.patch('/shipments/:id/assign-agent', ShipmentController.assignAgent);

/**
 * PATCH /api/agency/shipments/:id/tracking-number
 * Record/replace the carrier tracking number on a shipment this agency handles.
 * Body: { trackingNumber: string }
 */
router.patch('/shipments/:id/tracking-number', ShipmentController.setTrackingNumber);

// ─── COD (cash management) ────────────────────────────────────────────────────

/**
 * GET /api/agency/cod/summary
 * The agency's cash position: liability to the platform, cash out with each
 * agent, and collected cash not yet covered by a confirmed remittance.
 */
router.get('/cod/summary', AgencyCodController.summary);

/**
 * POST /api/agency/cod/deposits
 * Record cash physically received from one of this agency's agents.
 * Body: { agentId, amount, note? }
 */
router.post('/cod/deposits', AgencyCodController.recordDeposit);

/** GET /api/agency/cod/deposits — deposit history. Query: agentId?, page?, limit? */
router.get('/cod/deposits', AgencyCodController.listDeposits);

/**
 * POST /api/agency/cod/remittances
 * Declare a cash transfer to the platform (admin confirms receipt).
 * Body: { amount, reference, note? }
 */
router.post('/cod/remittances', AgencyCodController.declareRemittance);

/** GET /api/agency/cod/remittances — remittance history. Query: status?, page?, limit? */
router.get('/cod/remittances', AgencyCodController.listRemittances);

/**
 * POST /api/agency/cod/discrepancies
 * Flag a cash problem with one of this agency's agents (applies trust penalty).
 * Body: { agentId, type: 'cash_shortfall' | 'other', amount?, note }
 */
router.post('/cod/discrepancies', AgencyCodController.raiseDiscrepancy);

/** GET /api/agency/cod/discrepancies — this agency's flags. Query: status?, agentId?, page?, limit? */
router.get('/cod/discrepancies', AgencyCodController.listDiscrepancies);

// ─── Notifications (multi-channel; see agency-notification.model.ts) ─────────

/** GET /api/agency/notifications */
router.get('/notifications', AgencyNotificationController.listNotifications);

/** PATCH /api/agency/notifications/:id/read */
router.patch('/notifications/:id/read', AgencyNotificationController.markAsRead);

/** POST /api/agency/notifications/read-all */
router.post('/notifications/read-all', AgencyNotificationController.markAllAsRead);

/** GET /api/agency/notification-preferences */
router.get('/notification-preferences', AgencyNotificationController.getPreferences);

/** PATCH /api/agency/notification-preferences */
router.patch('/notification-preferences', AgencyNotificationController.updatePreferences);

/**
 * POST /api/agency/devices — register/refresh an FCM device token.
 * DELETE /api/agency/devices — unregister a device token (e.g. on logout).
 * Reuses the existing, already role-agnostic DeviceTokenController as-is.
 */
router.post('/devices', DeviceTokenController.register);
router.delete('/devices', DeviceTokenController.unregister);

// ─── Legacy / Backward Compatibility ──────────────────────────────────────────

/** GET /api/agency/profile/completion-status (kept for backward compat) */
router.get('/profile/completion-status', AgencyProfileController.getCompletionStatus);

/**
 * GET /api/agency/vendors (legacy — narrower than the connections view)
 * Vendors who set this agency as their default delivery agency. Read-only —
 * the agency cannot change this from its side. Still correct post-connections
 * (default_delivery_agency_id can now only point at an actively-connected
 * agency), but a vendor connected to this agency ONLY via a per-product
 * override never appears here. See GET /api/agency/vendor-connections?status=active
 * for the full "who's connected to me" view.
 */
router.get('/vendors', AgencyNetworkController.listVendors);

/**
 * GET /api/agency/products (legacy)
 * Products this agency is set up to deliver: explicit per-product override to
 * this agency OR inherited via a vendor's default. Read-only.
 */
router.get('/products', AgencyNetworkController.listProducts);

export default router;
