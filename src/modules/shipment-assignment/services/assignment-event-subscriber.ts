import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { shipmentAssignmentService } from '../domain/services/shipment-assignment.service';

/**
 * Subscribes to `shipment.assigned` — the per-shipment event OrderService emits
 * when a shipment is handed off to its agency (auto-redirect or manual dispatch).
 *
 * If the agency has opted into auto-assignment, this immediately runs the
 * candidate ranking and offers the top agent. Otherwise it does nothing — the
 * agency will place a manual offer from its dashboard.
 *
 * Best-effort and fully decoupled: a failure here (or the agency simply not
 * opting in) never blocks dispatch. Assignment, like tracking, stays off the
 * critical path for the order flow.
 */
export class AssignmentEventSubscriber {
  constructor(private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository()) {}

  register(): void {
    eventBus.subscribe('shipment.assigned', (e) => this.onShipmentAssigned(e));
    console.log('[AssignmentEventSubscriber] Registered shipment.assigned handler (auto-assignment)');
  }

  private async onShipmentAssigned(event: DomainEvent): Promise<void> {
    try {
      const shipmentId = String(event.payload.shipmentId ?? '');
      const agencyId = String(event.payload.agencyId ?? '');
      if (!shipmentId || !agencyId) return;

      const agency = await this.agencies.findById(agencyId);
      if (!agency?.assignment_settings?.auto_assign_enabled) return;

      await shipmentAssignmentService.autoAssign(shipmentId, { role: 'system', userId: null });
    } catch (err) {
      console.error('[AssignmentEventSubscriber] auto-assignment failed:', err);
    }
  }
}

export const assignmentEventSubscriber = new AssignmentEventSubscriber();

export function registerAssignmentEventSubscriber(): void {
  assignmentEventSubscriber.register();
}
