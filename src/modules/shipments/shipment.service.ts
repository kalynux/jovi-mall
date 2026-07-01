import { ShipmentRepository } from './shipment.repository';
import { IShipment } from './shipment.model';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

/**
 * Shipment Service
 *
 * Business logic for the delivery-side shipment operations.
 */
export class ShipmentService {
    private shipmentRepo: ShipmentRepository;

    constructor() {
        this.shipmentRepo = new ShipmentRepository();
    }

    /**
     * Set the carrier tracking number on a shipment.
     *
     * Ownership is enforced at the query level: an agency may only touch its own
     * shipments (`agency_id`), an agent only the ones assigned to them
     * (`agent_id`). A shipment that does not match the actor's scope is reported
     * as not found, so existence of other actors' shipments is never leaked.
     */
    async setTrackingNumber(
        role: string,
        roleEntityId: string,
        shipmentId: string,
        trackingNumber: string
    ): Promise<any> {
        const filter: Record<string, unknown> = { _id: shipmentId };

        if (role === 'agency') {
            filter.agency_id = roleEntityId;
        } else if (role === 'agent') {
            filter.agent_id = roleEntityId;
        } else {
            // Routes already restrict to agency/agent; defensive guard.
            throw createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403);
        }

        const shipment = await this.shipmentRepo.setTrackingNumber(filter, trackingNumber);

        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        return this.toSummary(shipment);
    }

    private toSummary(shipment: IShipment) {
        return {
            id: (shipment._id as any).toString(),
            orderId: shipment.order_id.toString(),
            agencyId: shipment.agency_id.toString(),
            agentId: shipment.agent_id ? shipment.agent_id.toString() : null,
            status: shipment.status,
            trackingNumber: shipment.tracking_number ?? null
        };
    }
}
