import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { ShipmentService } from './shipment.service';
import { SetTrackingNumberSchema } from './shipment.validator';

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
}
