import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { ShipmentController } from '../shipments/shipment.controller';
import { AgentDeliveryProofController, uploadDeliveryProof } from '../shipments/agent-delivery-proof.controller';
import { AgentCodController } from '../cod/controllers/agent-cod.controller';
import { AgentOfferController } from '../shipment-assignment/controllers/agent-offer.controller';
import { AgentNotificationController } from './controllers/agent-notification.controller';
import { DeviceTokenController } from '../notifications/controllers/device-token.controller';

/**
 * Agent work routes — mounted at /api/agent alongside the agent domain's own
 * router (see api/index.ts).
 *
 * Scope: an agent's WORK (shipments, cash, and the notifications about them).
 * The agent's own record — profile, onboarding, availability, device
 * capabilities, preferences, settings, agency memberships and invites — lives in
 * `modules/agents` and is mounted separately on the same prefix. Nothing here
 * touches the agent aggregate.
 *
 * Notifications sit here rather than there on purpose: they are about the
 * agent's work and money (see agent-notification.model.ts), and they hang off
 * their own models, not the agent aggregate. `notification-preferences` is
 * likewise a separate model — distinct from the agent's own `/preferences`,
 * which the agent domain owns.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agent']));

// ─── Shipments (agent work queue) ─────────────────────────────────────────────

// ─── Assignment offers (agent-acceptance workflow) ────────────────────────────

/**
 * GET /api/agent/offers
 * Assignment offers for this agent, pending first. Query: status?, page?, limit?
 * An offer is the agency (or the system) asking this agent to take a shipment;
 * it must be accepted before the shipment is theirs, and it expires on timeout.
 */
router.get('/offers', AgentOfferController.list);

/** GET /api/agent/offers/:id — one offer's detail (pickup, COD amount, expiry). */
router.get('/offers/:id', AgentOfferController.get);

/**
 * POST /api/agent/offers/:id/accept
 * Take the job: binds this agent to the shipment, opens live tracking, and (for
 * COD) issues the customer's delivery code. Fails if the offer expired or the
 * agent is no longer eligible / is at capacity.
 */
router.post('/offers/:id/accept', AgentOfferController.accept);

/**
 * POST /api/agent/offers/:id/reject
 * Decline the job. Body: { reason? }. An auto-assignment then tries the next
 * ranked agent; a manual offer returns the shipment to the agency queue.
 */
router.post('/offers/:id/reject', AgentOfferController.reject);

// ─── Shipments (agent work queue) ─────────────────────────────────────────────

/**
 * GET /api/agent/shipments
 * Shipments assigned to this agent, newest first. Query: status?, scope?, q?, page?, limit?
 * `scope=active|past` splits the queue into what is still theirs to finish
 * (ACTIVE_SHIPMENT_STATUSES, `failed` included — the parcel is still in the van)
 * and what is over. `status` alongside it wins, being the more specific filter.
 * An agent may hold several at once — this list is routinely plural.
 * `q` searches the customer's name/phone, the product titles, the order number
 * and the tracking number (min 2 chars). Each row carries the pickup and
 * drop-off addresses and the agent's estimated earning.
 */
router.get('/shipments', ShipmentController.listForAgent);

/**
 * GET /api/agent/shipments/:id
 * Full detail: items, pickup locations, customer + delivery address, the order
 * value and this agent's estimated earning, and (COD) the cash to collect. The
 * customer's delivery code is never included.
 */
router.get('/shipments/:id', ShipmentController.getDetailForAgent);

/**
 * GET /api/agent/shipments/:id/route
 * The pickup → drop-off line, for drawing the delivery on a map. Road-network
 * geometry when geo-tracker is reachable, straight line otherwise; never errors
 * on a geo-tracker problem.
 *
 * Declared BEFORE '/shipments/:id' would otherwise be ambiguous — Express
 * matches in order and ':id' does not swallow a second path segment, so the
 * position here is for readability, not correctness.
 */
router.get('/shipments/:id/route', ShipmentController.getRouteForAgent);

// NOTE: PATCH /shipments/:id/tracking-number is GONE. A shipment's tracking
// number is generated when the shipment is created and is read-only — it is
// returned on every shipment payload (`trackingNumber`) and never accepted on
// one. See TrackingNumberGenerator.

/**
 * POST /api/agent/shipments/:id/status
 * Advance this agent's own shipment: picked_up, in_transit, agent_delivered, or
 * a failed/returned outcome.
 * Body: { status, reason?, note? }  — reason/note are accepted ONLY on 'failed'
 * and 'returned' (note required when reason='other'), and are appended to the
 * shipment's delivery_failures log.
 *
 * Validated against TRIGGERABLE_TRANSITIONS — the SAME map the agency endpoint
 * uses, including `handing_over → picked_up|returned`, so an agent who accepted
 * a reassigned shipment drives it exactly like a first-assigned one. COD still
 * reaches 'delivered' only via the delivery code. Guarded by a from-status
 * compare-and-set: 409 SHIPMENT_STATUS_CONFLICT if the agency (or another
 * request) moved the shipment first.
 */
router.post('/shipments/:id/status', ShipmentController.updateStatusByAgent);

/**
 * POST /api/agent/shipments/:id/cancel
 * The assigned agent cancels this shipment mid-delivery. Body: { reason, note? }.
 * Releases the agent (capacity + tracking) and resumes auto-assignment from where
 * it had reached — the shipment is re-offered to the next candidate automatically.
 * Body: { reason: <enum>, note?: string(<=200) }  (note required when reason='other')
 */
router.post('/shipments/:id/cancel', AgentOfferController.cancelShipment);

// ─── Delivery proof (optional single image, charged to the AGENCY's storage) ──

/**
 * POST /api/agent/shipments/:id/delivery-proof
 * Attach/replace ONE optional image as proof of delivery. Allowed only at/after
 * the delivery outcome (agent_delivered / delivered / failed). The image is
 * uploaded and owned by the shipment's AGENCY (counts against the agency's media
 * storage), not the agent. Multipart, field `file` (jpeg/png/webp, ≤10 MB).
 */
router.post('/shipments/:id/delivery-proof', uploadDeliveryProof, AgentDeliveryProofController.upload);

/** GET /api/agent/shipments/:id/delivery-proof — the current proof's metadata, or null. */
router.get('/shipments/:id/delivery-proof', AgentDeliveryProofController.get);

/**
 * GET /api/agent/shipments/:id/delivery-proof/file — the image BYTES.
 *
 * ⚠ Declared BEFORE nothing that could shadow it, but note the ordering rule anyway: a
 * literal segment under a `:id` param is fine, a second `:param` at this depth would not be.
 *
 * This is the authorized door that replaced the public URL (ADR-A01 D-2) —
 * `storage/shipments/` is off `express.static`, so a proof photo is no longer fetchable by
 * anyone who has ever seen its address. `FileDetail.url` is `null` for these files and
 * `access` is `authorized`; this route is where the bytes come from.
 */
router.get('/shipments/:id/delivery-proof/file', AgentDeliveryProofController.download);

/** DELETE /api/agent/shipments/:id/delivery-proof — remove the proof. */
router.delete('/shipments/:id/delivery-proof', AgentDeliveryProofController.remove);

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

/**
 * GET /api/agent/cod/allocation — how the agent's one COD pool is sub-allocated
 * across the agencies they serve, plus the unallocated headroom.
 */
router.get('/cod/allocation', AgentCodController.getAllocation);

/**
 * PUT /api/agent/cod/pool
 * Body: { maxThreshold: number | null } — carry LESS than the ceiling (`null` = the
 * whole ceiling again). The ceiling is the agent's plan once their KYC is verified,
 * an administrator's pin, or 0 while unverified; the agent can never raise past it.
 * Answers the same body as GET /cod/allocation.
 */
router.put('/cod/pool', AgentCodController.setPool);

/** GET /api/agent/cod/ledger — append-only history of this agent's cash movements. */
router.get('/cod/ledger', AgentCodController.getLedger);

/** GET /api/agent/cod/deposits — this agent's cash hand-overs. Query: status?, page?, limit? */
router.get('/cod/deposits', AgentCodController.listDeposits);

/**
 * POST /api/agent/cod/deposits
 * Declare cash handed back — to the agency, or straight to the platform
 * (`recipient: 'platform'`, which needs a transfer `reference`). Moves no money;
 * the receiving party confirms. Body: { agencyId, amount, recipient?, reference?, note? }
 */
router.post('/cod/deposits', AgentCodController.declareDeposit);

/**
 * POST /api/agent/cod/discrepancies
 * Report a cash problem with an agency (e.g. they recorded less than was handed
 * over). Body: { agencyId, amount?, depositId?, note }
 */
router.post('/cod/discrepancies', AgentCodController.raiseDiscrepancy);

// ─── Notifications (multi-channel; see agent-notification.model.ts) ──────────

/** GET /api/agent/notifications */
router.get('/notifications', AgentNotificationController.listNotifications);

/** PATCH /api/agent/notifications/:id/read */
router.patch('/notifications/:id/read', AgentNotificationController.markAsRead);

/** POST /api/agent/notifications/read-all */
router.post('/notifications/read-all', AgentNotificationController.markAllAsRead);

/**
 * GET /api/agent/notification-preferences
 * NOT the same thing as the agent domain's `/api/agent/preferences` — this is
 * notification channels; that is the agent's own record.
 */
router.get('/notification-preferences', AgentNotificationController.getPreferences);

/** PATCH /api/agent/notification-preferences */
router.patch('/notification-preferences', AgentNotificationController.updatePreferences);

/**
 * FCM device registration — same shape as `/api/agency/devices` and
 * `/api/vendor/devices`, reusing the role-agnostic DeviceTokenController.
 *
 * ⚠️ NOT `/api/agent/device` (singular), which the agent domain owns and which
 * means something completely different: the agent's device CAPABILITIES and
 * location permission, an input to assignment eligibility. This one is an FCM
 * push token and nothing else. Without it push cannot reach an agent at all —
 * FcmPushService resolves tokens by user, and agents had no way to register one.
 */
router.post('/devices', DeviceTokenController.register);
router.delete('/devices', DeviceTokenController.unregister);

export default router;
