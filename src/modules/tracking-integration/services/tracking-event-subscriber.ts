import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { ShipmentStatus } from '../../shipments/shipment.model';
import { TrackingOutboxEmitter, trackingOutboxEmitter } from './tracking-outbox.emitter';

/**
 * Subscribes to the domain events that change a shipment's trackability and writes them to the
 * tracking outbox for delivery to geo-tracker.
 *
 * ⚠ ── THIS FILE IS A TRANSITIONAL SHIM AND IS DUE TO BE DELETED ────────────────────────────
 *
 * Plan step 3.A.1 (X-1) moves the outbox write **inside the transaction that made the change**,
 * because this route cannot be crash-durable: the event bus carries no Mongo session, so a row
 * reached here is necessarily written after the state change has already committed, and a crash
 * in that window loses the event permanently. `EventBus.publish` also swallows handler errors,
 * so the failure is silent.
 *
 * The verdict logic has therefore moved to {@link TrackingOutboxEmitter}, and every handler
 * below now delegates to it **with no session**, which is exactly the old behaviour. This shim
 * exists only so step 3.A.1a can land without a window in which nothing writes the outbox at
 * all; step 3.A.1b moves the five write sites onto the emitter directly and deletes this file
 * along with `registerTrackingEventSubscriber`.
 *
 * If you are reading this after step 3.A.1b landed, this file should not exist — say so.
 */
export class TrackingEventSubscriber {
  constructor(private readonly emitter: TrackingOutboxEmitter = trackingOutboxEmitter) {}

  register(): void {
    eventBus.subscribe('shipment.status_changed', (e) => this.onShipmentStatusChanged(e));
    eventBus.subscribe('cod.collection.recorded', (e) => this.onCodCollectionRecorded(e));
    eventBus.subscribe('shipment.agent_released', (e) => this.onShipmentAgentReleased(e));
    eventBus.subscribe('agent.tracking_allow_changed', (e) => this.onTrackingAllowChanged(e));
    console.log('[TrackingEventSubscriber] Registered tracking outbox handlers');
  }

  private async onShipmentStatusChanged(event: DomainEvent): Promise<void> {
    const p = event.payload;
    const shipmentId = str(p.shipmentId);
    if (!shipmentId) return;
    await this.emitter.emitShipmentStatusChanged({
      shipmentId,
      agentId: str(p.agentId),
      agencyId: str(p.agencyId),
      customerId: str(p.customerId),
      status: p.status as ShipmentStatus,
      occurredAt: event.occurredAt,
    });
  }

  private async onCodCollectionRecorded(event: DomainEvent): Promise<void> {
    const p = event.payload;
    const shipmentId = str(p.shipmentId);
    if (!shipmentId) return;
    await this.emitter.emitCodCollectionRecorded({
      shipmentId,
      agentId: str(p.agentId),
      agencyId: str(p.agencyId),
      customerId: str(p.customerId),
      occurredAt: event.occurredAt,
    });
  }

  private async onShipmentAgentReleased(event: DomainEvent): Promise<void> {
    const p = event.payload;
    const shipmentId = str(p.shipmentId);
    const agentId = str(p.agentId);
    if (!shipmentId || !agentId) return;
    await this.emitter.emitAgentReleased({
      shipmentId,
      agentId,
      agencyId: str(p.agencyId),
      customerId: str(p.customerId),
      occurredAt: event.occurredAt,
    });
  }

  private async onTrackingAllowChanged(event: DomainEvent): Promise<void> {
    const p = event.payload;
    const agentId = str(p.agentId);
    if (!agentId) return;
    await this.emitter.emitTrackingAllowChanged({
      agentId,
      allowed: p.to === true,
      reason: str(p.reason),
      actorRole: str(p.actorRole),
      occurredAt: event.occurredAt,
    });
  }
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

/** Wires the subscriber at startup (mirrors initializeX...Consumers). */
export function registerTrackingEventSubscriber(): void {
  new TrackingEventSubscriber().register();
}
