import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AgencyProfileController, uploadAgencyPolicyDocuments } from './controllers/agency-profile.controller';
import { AgencyNetworkController } from './controllers/agency-network.controller';
import { AgencyNotificationController } from './controllers/agency-notification.controller';
import { ShipmentController } from '../shipments/shipment.controller';
import { AgencyDeliveryProofController } from '../shipments/agent-delivery-proof.controller';
import { AgencyAssignmentController } from '../shipment-assignment/controllers/agency-assignment.controller';
import { AgencyCodController } from '../cod/controllers/agency-cod.controller';
import { TrackingController } from '../tracking-integration/controllers/tracking.controller';
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

/**
 * PATCH /api/agency/assignment-settings
 * Toggle auto-assignment: when on, a shipment handed to this agency is
 * auto-offered to the top-ranked eligible agent. Body: { autoAssignEnabled: boolean }
 */
router.patch('/assignment-settings', AgencyAssignmentController.updateSettings);

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
 * Step 3 (Optional/Skippable): { skip?: boolean, logo_file_id?, timezone? }
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
 * Roster management (/api/agency/agents/**) moved to the agent domain —
 * see modules/agents/routes/agency-roster.routes.ts, mounted in api/index.ts.
 *
 * It grew well past "invite and unlink": approval of join requests, suspension
 * and reinstatement, employment terms, per-membership COD caps, eligibility
 * diagnostics and history. Those are agent-domain concerns, and an agent may
 * now serve several agencies, so the roster is a membership collection rather
 * than a foreign key on the agent.
 */

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
 * GET /api/agency/shipments/:id/delivery-proof/file
 *
 * The proof image's BYTES, scoped by the SAME `findByIdAndAgency` predicate the detail above
 * uses — the authorization is the shipment's, re-used rather than re-derived. This is the
 * authorized door that replaced the public URL (ADR-A01 D-2): `storage/shipments/` is off
 * `express.static`, so the photo is no longer fetchable by anyone holding its address, and
 * `FileDetail.url` on the detail response is now `null` with `access: 'authorized'`.
 *
 * There is no agency upload/delete twin, deliberately — the proof is the AGENT's record of
 * what they did. The agency reads it; it does not author it.
 */
router.get('/shipments/:id/delivery-proof/file', AgencyDeliveryProofController.download);

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
 * Offer this shipment to one of the agency's agents (agent-acceptance workflow).
 * No longer a direct assignment: it creates an OFFER the agent must accept
 * (unless the agent has auto-accept enabled). Body: { agentId: string }
 */
router.patch('/shipments/:id/assign-agent', AgencyAssignmentController.offerAgent);

/**
 * POST /api/agency/shipments/:id/auto-assign
 * Let the system pick: rank eligible agents (closest to pickup, free capacity,
 * trust, COD-clearable) and offer the top one now.
 */
router.post('/shipments/:id/auto-assign', AgencyAssignmentController.autoAssign);

/**
 * GET /api/agency/shipments/:id/assignment-candidates
 * Preview the ranked candidate agents for this shipment (with score breakdown).
 */
router.get('/shipments/:id/assignment-candidates', AgencyAssignmentController.previewCandidates);

/**
 * POST /api/agency/shipments/:id/offer/cancel
 * Withdraw the shipment's live offer, returning it to the agency queue.
 */
router.post('/shipments/:id/offer/cancel', AgencyAssignmentController.cancelOffer);

/**
 * POST /api/agency/shipments/:id/reassign
 * Change agents: detach the current agent (releasing their tracking session) and
 * offer the shipment to a replacement, who must accept before their tracking
 * starts. Body: { agentId?, reason }. `agentId` is required once the parcel has
 * been picked up (manual only — the shipment enters `handing_over` until the new
 * agent picks it up); omit it pre-pickup to auto-assign. `reason` is mandatory.
 */
router.post('/shipments/:id/reassign', AgencyAssignmentController.reassign);

// NOTE: PATCH /shipments/:id/tracking-number is GONE. A shipment's tracking
// number is generated when the shipment is created and is read-only — it is
// returned on every shipment payload (`trackingNumber`) and never accepted on
// one. See TrackingNumberGenerator.

// ─── Live tracking ──────────────────────────────────────────────────────────

/**
 * GET /api/agency/tracking/board
 * The live-tracking map's one load: every agent this agency may currently watch
 * and each of their active shipments, with the pickup and drop-off pins that
 * draw the delivery.
 *
 * Positions are NOT here — live movement comes from geo-tracker's WebSocket
 * (`subscribe {agentId}` → `location_broadcast`). The agent set is exactly the
 * one GET /api/tracking/visible-agents grants, which is what geo-tracker gates
 * that subscription on. See api-doc/agency/live-tracking.md.
 */
router.get('/tracking/board', TrackingController.getAgencyBoard);

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

/**
 * GET /api/agency/cod/deposits — deposit history.
 * Query: agentId?, status?, page?, limit? — `?status=declared` is the inbox of
 * hand-overs agents have declared and this agency has not yet answered.
 */
router.get('/cod/deposits', AgencyCodController.listDeposits);

/**
 * POST /api/agency/cod/deposits/:id/confirm
 * Confirm a hand-over an agent declared. This is where the money moves.
 */
router.post('/cod/deposits/:id/confirm', AgencyCodController.confirmDeposit);

/**
 * POST /api/agency/cod/deposits/:id/reject
 * Reject a declared hand-over (nothing arrived / not that much). Body: { reason }
 */
router.post('/cod/deposits/:id/reject', AgencyCodController.rejectDeposit);

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
