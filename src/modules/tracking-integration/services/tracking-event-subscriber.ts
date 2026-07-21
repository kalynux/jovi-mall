import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { ShipmentStatus } from '../../shipments/shipment.model';
import { TrackingOutboxRepository } from '../repositories/tracking-outbox.repository';
import { visibleAgentsService } from './visible-agents.service';

/**
 * Subscribes to the domain events that change a shipment's trackability and
 * writes them to the tracking outbox for delivery to geo-tracker. Two signals
 * cover both payment models:
 *
 *   - `cod.collection.recorded` — a COD shipment reached `delivered` the moment
 *     cash was recorded (the COD "finish").
 *   - `shipment.status_changed` — every agency/customer-driven status change,
 *     including a digital order's `delivered` on customer confirmation and the
 *     terminal `failed`/`returned`/`rejected` states.
 *
 * Each event carries three tracking verdicts, computed here because geo-tracker
 * has no shipment model and must never grow one:
 *
 *   shipmentTrackable      — is THIS shipment being tracked? OPENS/CLOSES its
 *                            tracking session (one session per shipment).
 *   shipmentTerminal       — did THIS shipment end, and how? Closes its session
 *                            with the outcome stamped.
 *   agentHasActiveShipment — does the agent have ANY? A backstop that can close
 *                            everything but open nothing, since it names no
 *                            shipment.
 *
 * geo-tracker also re-evaluates each watcher on receipt and only drops those who
 * no longer qualify, so emitting on every status change is safe (and keeps
 * caches fresh) — the terminal states are what actually revoke access.
 */
export class TrackingEventSubscriber {
  constructor(private readonly outbox: TrackingOutboxRepository = new TrackingOutboxRepository()) {}

  register(): void {
    eventBus.subscribe('shipment.status_changed', (e) => this.onShipmentStatusChanged(e));
    eventBus.subscribe('cod.collection.recorded', (e) => this.onCodCollectionRecorded(e));
    eventBus.subscribe('shipment.agent_released', (e) => this.onShipmentAgentReleased(e));
    console.log('[TrackingEventSubscriber] Registered tracking outbox handlers');
  }

  private async onShipmentStatusChanged(event: DomainEvent): Promise<void> {
    const p = event.payload;
    const agentId = str(p.agentId);
    // The status the event was emitted FOR — not a re-read of the shipment. A
    // burst of transitions must produce one honest verdict each, or geo-tracker
    // would see (say) `assigned` reported as already delivered.
    const trackability = visibleAgentsService.shipmentTrackability(p.status as ShipmentStatus);
    await this.outbox.enqueue({
      type: 'shipment.status_changed',
      shipmentId: str(p.shipmentId),
      agentId,
      agencyId: str(p.agencyId),
      customerId: str(p.customerId),
      shipmentTrackable: trackability.trackable,
      shipmentTerminal: trackability.terminal,
      agentHasActiveShipment: await this.agentHasActiveShipment(agentId),
      occurredAt: event.occurredAt,
    });
  }

  private async onCodCollectionRecorded(event: DomainEvent): Promise<void> {
    const p = event.payload;
    const agentId = str(p.agentId);
    const shipmentId = str(p.shipmentId);
    // A COD collection event says cash was taken, not what that made the
    // shipment — so unlike the status-changed path there is no status on the
    // payload and it has to be read back. It is post-commit, so the read sees the
    // `delivered` this collection caused.
    const status = await visibleAgentsService.shipmentStatus(shipmentId);
    const trackability = visibleAgentsService.shipmentTrackability(status);
    await this.outbox.enqueue({
      type: 'cod.collection.recorded',
      shipmentId,
      agentId,
      agencyId: str(p.agencyId),
      customerId: str(p.customerId),
      shipmentTrackable: trackability.trackable,
      shipmentTerminal: trackability.terminal,
      agentHasActiveShipment: await this.agentHasActiveShipment(agentId),
      occurredAt: event.occurredAt,
    });
  }

  /**
   * An agent → agent reassignment released `agentId` from this shipment. It is a
   * per-shipment RELEASE, scoped to the OLD agent and independent of the shipment's
   * resulting status (which may be `handing_over` or a reset `assigned`, both
   * trackable in the abstract but not for this agent any more). So the verdict is
   * forced: `shipmentTrackable=false` (→ geo-tracker `ReleaseShipment(agent,
   * shipment)`), `shipmentTerminal=null` (a release, not a terminal — a fresh
   * session opens when the replacement agent accepts). The aggregate backstop is
   * still computed honestly for the released agent.
   */
  private async onShipmentAgentReleased(event: DomainEvent): Promise<void> {
    const p = event.payload;
    const agentId = str(p.agentId);
    await this.outbox.enqueue({
      type: 'shipment.status_changed',
      shipmentId: str(p.shipmentId),
      agentId,
      agencyId: str(p.agencyId),
      customerId: str(p.customerId),
      shipmentTrackable: false,
      shipmentTerminal: null,
      agentHasActiveShipment: await this.agentHasActiveShipment(agentId),
      occurredAt: event.occurredAt,
    });
  }

  /**
   * The agent's aggregate active-shipment verdict — geo-tracker's backstop
   * against a lost per-shipment terminal event. Computed from the same
   * trackable-status policy that drives agency visibility, so the rule lives
   * once, in the source of truth. null when the event has no agent — there is
   * nothing to attribute it to.
   */
  private async agentHasActiveShipment(agentId: string | null): Promise<boolean | null> {
    if (!agentId) return null;
    return visibleAgentsService.agentHasActiveShipment(agentId);
  }
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

/** Wires the subscriber at startup (mirrors initializeX...Consumers). */
export function registerTrackingEventSubscriber(): void {
  new TrackingEventSubscriber().register();
}
