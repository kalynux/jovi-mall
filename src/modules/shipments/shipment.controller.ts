import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { ShipmentService } from './shipment.service';
import { ShipmentStatus } from './shipment.model';
import { roleActorFromRequest } from '../../core/types/actor-source.types';
import {
    ListShipmentsQuerySchema,
    AgentListShipmentsQuerySchema,
    UpdateShipmentStatusSchema,
    AgentUpdateShipmentStatusSchema,
    RejectShipmentSchema,
} from './shipment.validator';
import {
    agentActionAuditService,
    outcomeFromError,
    shipmentStatusToAction,
} from '../tracking-integration/services/agent-action-audit.service';
import { AgentActionOutcome } from '../tracking-integration/models/tracking-outbox.model';

const shipmentService = new ShipmentService();

/**
 * ShipmentController
 *
 * Delivery-side shipment operations. Scoping (agency vs agent) is derived from
 * the authenticated role and enforced in the service. Errors propagate to the
 * global error handler via asyncHandler.
 */
export class ShipmentController {
    // NOTE: there is no setTrackingNumber handler. The tracking number is
    // generated when the shipment is created (see TrackingNumberGenerator) and
    // is read-only everywhere — it is returned on every shipment payload via
    // ShipmentService.toSummary.

    /**
     * GET /api/agency/shipments
     *
     * Shipments assigned to the authenticated agency, newest first.
     */
    static listForAgency = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agencyId = req.auth!.role_entity._id.toString();
        const { status, q, page, limit } = ListShipmentsQuerySchema.parse(req.query);

        const result = await shipmentService.listForAgency(agencyId, { status, q }, { page, limit });

        res.json({ success: true, data: result.data, meta: result.meta });
    });

    /**
     * GET /api/agency/shipments/:id
     *
     * Full detail for one of the agency's own shipments.
     */
    static getDetailForAgency = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agencyId = req.auth!.role_entity._id.toString();
        const shipmentId = req.params.id;

        const detail = await shipmentService.getDetailForAgency(agencyId, shipmentId);

        res.json({ success: true, data: detail });
    });

    /**
     * GET /api/agent/shipments
     *
     * Shipments assigned to the authenticated agent (their work queue).
     * Supports `?q=` free-text search over the customer's name/phone, the
     * product titles, the order number and the tracking number, and
     * `?scope=active|past` — the coarse "still mine to finish" split the app's
     * queue is tabbed on. A `status` alongside it wins, being more specific.
     */
    static listForAgent = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const { status, q, scope, page, limit } = AgentListShipmentsQuerySchema.parse(req.query);

        const result = await shipmentService.listForAgent(agentId, { status, q, scope }, { page, limit });

        res.json({ success: true, data: result.data, meta: result.meta });
    });

    /**
     * GET /api/agent/shipments/:id
     *
     * Full detail for a shipment assigned to the authenticated agent — items,
     * pickup locations, customer + delivery address, and (for COD) the cash to
     * collect. Never includes the customer's delivery code.
     */
    static getDetailForAgent = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const shipmentId = req.params.id;

        const detail = await shipmentService.getDetailForAgent(agentId, shipmentId);

        res.json({ success: true, data: detail });
    });

    /**
     * GET /api/agent/shipments/:id/route
     *
     * The pickup → drop-off line for one of the agent's own shipments, for
     * drawing the delivery on a map. Road-network geometry via geo-tracker when
     * it is reachable, a straight line otherwise — never an error, since
     * geo-tracker is off the critical path by contract.
     */
    static getRouteForAgent = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const shipmentId = req.params.id;

        const route = await shipmentService.getRouteForAgent(agentId, shipmentId);

        res.json({ success: true, data: route });
    });

    /**
     * PATCH /api/agency/shipments/:id/status
     *
     * Agency-driven status transition (picked_up, in_transit, agent_delivered,
     * or a failed retry).
     */
    static updateStatus = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agencyId = req.auth!.role_entity._id.toString();
        const actorUserId = req.auth!.user.id;
        const shipmentId = req.params.id;
        const { status } = UpdateShipmentStatusSchema.parse(req.body);

        const shipment = await shipmentService.updateStatus(agencyId, shipmentId, status, actorUserId);

        res.json({ success: true, data: shipment, message: 'Shipment status updated' });
    });

    /**
     * POST /api/agent/shipments/:id/status
     *
     * Agent-driven status transition on their OWN shipment (picked_up,
     * in_transit, agent_delivered, or a failed/returned outcome), with an
     * optional non-delivery reason + note on failed/returned.
     *
     * Instrumented for the Phase 6 agent-action audit the way
     * AgentCodController.collect is — attempt up front, the specific failure in
     * the catch — but deliberately NOT the success: ShipmentService already
     * emits that post-commit via emitShipmentTransition(updated, 'agent').
     * Emitting here too would double-count every pickup and delivery.
     */
    static updateStatusByAgent = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const actorUserId = req.auth!.user.id;
        const shipmentId = req.params.id;

        // The audited action kind depends on the requested status, so it is read
        // from the RAW body BEFORE validation — otherwise a malformed body would
        // produce no audit row at all, and `validation_failure` is exactly what
        // the outcome spectrum exists to record. Untrusted and used only to pick
        // a label; shipmentStatusToAction returns null for anything unrecognised.
        const requested = typeof (req.body as any)?.status === 'string'
            ? ((req.body as any).status as ShipmentStatus)
            : null;
        // null for in_transit (and for unknown input): there is no agent-action
        // kind for it, and geo-tracker rejects unknown kinds at its boundary. The
        // service's own emitShipmentTransition no-ops on it for the same reason.
        const action = requested ? shipmentStatusToAction(requested) : null;

        const audit = (outcome: AgentActionOutcome, reason?: string | null): void => {
            if (!action) return;
            void agentActionAuditService
                .emit({ action, outcome, agentId, shipmentId, actorRole: 'agent', reason })
                .catch((err) => console.error('[ShipmentController] agent-action audit emit failed:', err));
        };

        audit('attempt');
        try {
            const { status, reason, note } = AgentUpdateShipmentStatusSchema.parse(req.body);

            const shipment = await shipmentService.updateStatusByAgent(
                agentId,
                shipmentId,
                status,
                actorUserId,
                reason || note ? { reason: reason ?? null, note: note ?? null } : null
            );

            // No audit('success') here — the service emits it post-commit.
            res.json({ success: true, data: shipment, message: 'Shipment status updated' });
        } catch (err) {
            audit(outcomeFromError(err), err instanceof Error ? err.message : null);
            throw err;
        }
    });

    /**
     * POST /api/agency/shipments/:id/reject
     *
     * Reject an assigned (not yet picked up) shipment with a scoped reason.
     */
    static reject = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agencyId = req.auth!.role_entity._id.toString();
        const shipmentId = req.params.id;
        const { reason, note } = RejectShipmentSchema.parse(req.body);

        // `roleActorFromRequest` rather than a bare user id: the rejection now carries an
        // actor stamp, and deriving the source here — beside the id it describes — is what
        // stops a row claiming 'platform' next to an id from the other database.
        const shipment = await shipmentService.reject(
            agencyId, shipmentId, reason, note ?? null, roleActorFromRequest(req)
        );

        res.json({ success: true, data: shipment, message: 'Shipment rejected' });
    });

    // NOTE: agent assignment moved to the agent-acceptance workflow —
    // PATCH /api/agency/shipments/:id/assign-agent now creates an offer via
    // AgencyAssignmentController.offerAgent (modules/shipment-assignment), not a
    // direct assignment here.
}
