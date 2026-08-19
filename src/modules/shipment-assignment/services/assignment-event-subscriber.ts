import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { logger } from '../../../core/logging';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { shipmentAssignmentService } from '../domain/services/shipment-assignment.service';

/**
 * A shipment status at which the temporary assignment ranking is DISPOSED OF —
 * the requirement's "delete only when the shipment is completed or permanently
 * cancelled". `delivered`/`returned` are terminal outcomes; `rejected` means the
 * shipment left this agency (its items are re-homed to a fresh shipment), so its
 * ranking is dead too. `failed` is deliberately absent — it can recover
 * (failed → in_transit / returned), so its ranking must survive for a resume.
 */
const SESSION_DISPOSE_STATUSES = ['delivered', 'returned', 'rejected'];

/**
 * Subscribes to two events:
 *
 * - `shipment.assigned` — emitted when a shipment is handed to its agency. If the
 *   agency has auto-assignment on, this runs the ranking and offers the top agent.
 * - `shipment.status_changed` — used only to DISPOSE the temporary ranking when
 *   the shipment reaches a terminal/permanent-cancel status (STEP 9), so rankings
 *   never outlive their shipment.
 *
 * Best-effort and fully decoupled: a failure here (or the agency not opting in)
 * never blocks dispatch. Assignment, like tracking, stays off the critical path.
 */
export class AssignmentEventSubscriber {
  constructor(private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository()) {}

  register(): void {
    // The third argument is this handler's identity in the bus's failure log. An inline arrow
    // carries no `name` of its own, so without it a throw here is reported as `anonymous#0`.
    eventBus.subscribe(
      'shipment.assigned',
      (e) => this.onShipmentAssigned(e),
      'AssignmentEventSubscriber.onShipmentAssigned',
    );
    eventBus.subscribe(
      'shipment.status_changed',
      (e) => this.onShipmentStatusChanged(e),
      'AssignmentEventSubscriber.onShipmentStatusChanged',
    );
    logger().info('assignment: shipment.assigned + status_changed handlers registered (auto-assignment)');
  }

  /** Dispose the ranking once its shipment is finished (or has left this agency). */
  private async onShipmentStatusChanged(event: DomainEvent): Promise<void> {
    try {
      const shipmentId = String(event.payload.shipmentId ?? '');
      const status = String(event.payload.status ?? '');
      if (!shipmentId || !SESSION_DISPOSE_STATUSES.includes(status)) return;
      await shipmentAssignmentService.disposeSessionForShipment(shipmentId);
    } catch (err) {
      console.error('[AssignmentEventSubscriber] session dispose failed:', err);
    }
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
