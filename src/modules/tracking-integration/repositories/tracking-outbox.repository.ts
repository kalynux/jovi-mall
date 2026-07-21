import { randomUUID } from 'crypto';
import {
  AgentActionKind,
  AgentActionOutcome,
  ITrackingOutbox,
  ShipmentTerminalStatus,
  TrackingEventType,
  TrackingOutboxModel,
} from '../models/tracking-outbox.model';

export interface EnqueueInput {
  type: TrackingEventType;
  shipmentId?: string | null;
  agentId?: string | null;
  agencyId?: string | null;
  customerId?: string | null;
  // Per-shipment tracking-session signals: whether THIS shipment is trackable,
  // and its outcome if this change ended it. Together they open and close the
  // shipment's tracking session in geo-tracker.
  shipmentTrackable?: boolean | null;
  shipmentTerminal?: ShipmentTerminalStatus | null;
  // Aggregate backstop: whether the agent has ANY active shipment left.
  agentHasActiveShipment?: boolean | null;
  // Agent-action audit fields (Phase 6).
  action?: AgentActionKind | null;
  outcome?: AgentActionOutcome | null;
  actorRole?: string | null;
  reason?: string | null;
  occurredAt?: Date;
}

/**
 * Data access for the tracking outbox. Enqueue is called by the event
 * subscriber; the claim/mark methods are called by the dispatch worker.
 */
export class TrackingOutboxRepository {
  async enqueue(input: EnqueueInput): Promise<ITrackingOutbox> {
    return TrackingOutboxModel.create({
      event_id: randomUUID(),
      type: input.type,
      shipment_id: input.shipmentId ?? null,
      agent_id: input.agentId ?? null,
      agency_id: input.agencyId ?? null,
      customer_id: input.customerId ?? null,
      shipment_trackable: input.shipmentTrackable ?? null,
      shipment_terminal: input.shipmentTerminal ?? null,
      agent_has_active_shipment: input.agentHasActiveShipment ?? null,
      action: input.action ?? null,
      outcome: input.outcome ?? null,
      actor_role: input.actorRole ?? null,
      reason: input.reason ?? null,
      occurred_at: input.occurredAt ?? new Date(),
      status: 'pending',
      attempts: 0,
      last_error: null,
    });
  }

  /** Oldest pending rows first, bounded by limit. */
  async findPending(limit: number): Promise<ITrackingOutbox[]> {
    return TrackingOutboxModel.find({ status: 'pending' })
      .sort({ created_at: 1 })
      .limit(limit)
      .exec();
  }

  async markSent(id: string): Promise<void> {
    await TrackingOutboxModel.updateOne(
      { _id: id },
      { $set: { status: 'sent' } }
    ).exec();
  }

  /** Record a failed attempt; park the row as `failed` once attempts hit max. */
  async markAttemptFailed(id: string, attempts: number, error: string, maxAttempts: number): Promise<void> {
    await TrackingOutboxModel.updateOne(
      { _id: id },
      {
        $set: {
          attempts,
          last_error: error.slice(0, 500),
          status: attempts >= maxAttempts ? 'failed' : 'pending',
        },
      }
    ).exec();
  }
}
