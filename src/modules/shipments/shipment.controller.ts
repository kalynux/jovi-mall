import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { ShipmentService } from './shipment.service';
import {
    SetTrackingNumberSchema,
    ListShipmentsQuerySchema,
    UpdateShipmentStatusSchema,
    RejectShipmentSchema,
    AssignAgentSchema,
} from './shipment.validator';

const shipmentService = new ShipmentService();

/**
 * ShipmentController
 *
 * Delivery-side shipment operations. Scoping (agency vs agent) is derived from
 * the authenticated role and enforced in the service. Errors propagate to the
 * global error handler via asyncHandler.
 */
export class ShipmentController {
    /**
     * PATCH /api/agency/shipments/:id/tracking-number
     * PATCH /api/agent/shipments/:id/tracking-number
     *
     * Record/replace the carrier tracking number on a shipment the actor handles.
     */
    static setTrackingNumber = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const role = req.auth!.role;
        const roleEntityId = req.auth!.role_entity._id.toString();
        const shipmentId = req.params.id;

        const { trackingNumber } = SetTrackingNumberSchema.parse(req.body);

        const shipment = await shipmentService.setTrackingNumber(
            role,
            roleEntityId,
            shipmentId,
            trackingNumber
        );

        res.json({
            success: true,
            data: shipment,
            message: 'Tracking number updated successfully'
        });
    });

    /**
     * GET /api/agency/shipments
     *
     * Shipments assigned to the authenticated agency, newest first.
     */
    static listForAgency = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agencyId = req.auth!.role_entity._id.toString();
        const { status, page, limit } = ListShipmentsQuerySchema.parse(req.query);

        const result = await shipmentService.listForAgency(agencyId, { status }, { page, limit });

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
     * POST /api/agency/shipments/:id/reject
     *
     * Reject an assigned (not yet picked up) shipment with a scoped reason.
     */
    static reject = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agencyId = req.auth!.role_entity._id.toString();
        const actorUserId = req.auth!.user.id;
        const shipmentId = req.params.id;
        const { reason } = RejectShipmentSchema.parse(req.body);

        const shipment = await shipmentService.reject(agencyId, shipmentId, reason, actorUserId);

        res.json({ success: true, data: shipment, message: 'Shipment rejected' });
    });

    /**
     * PATCH /api/agency/shipments/:id/assign-agent
     *
     * Assign one of the agency's own agents to handle this shipment.
     */
    static assignAgent = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agencyId = req.auth!.role_entity._id.toString();
        const shipmentId = req.params.id;
        const { agentId } = AssignAgentSchema.parse(req.body);

        const shipment = await shipmentService.assignAgent(agencyId, shipmentId, agentId);

        res.json({ success: true, data: shipment, message: 'Agent assigned' });
    });
}
