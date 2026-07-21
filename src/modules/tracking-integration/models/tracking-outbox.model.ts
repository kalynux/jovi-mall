import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * TrackingOutbox — the durable buffer of lifecycle events destined for the
 * geo-tracker service. Events are written here (in the same request that
 * observed the shipment change) and drained asynchronously by
 * TrackingDispatchWorker, which POSTs each to geo-tracker's webhook. The
 * outbox gives crash-durability the in-memory event bus lacks: a process
 * restart never loses a pending revocation.
 */
export type TrackingOutboxStatus = 'pending' | 'sent' | 'failed';

export type TrackingEventType =
  | 'shipment.status_changed'
  | 'payment.received.full'
  | 'payment.received.partial'
  | 'cod.collection.recorded'
  | 'agent_agency.membership_changed'
  // Phase 6: an agent shipment action (pickup/delivery/return/cancel) and its
  // outcome. Routed to geo-tracker's agent-action audit endpoint, not the
  // tracking webhook — the dispatcher branches on this type.
  | 'agent.action';

/** Agent shipment action kind (Phase 6). */
export type AgentActionKind = 'pickup' | 'delivery' | 'return' | 'cancel';

/** Outcome of an agent shipment action (Phase 6). */
export type AgentActionOutcome =
  | 'attempt'
  | 'success'
  | 'failure'
  | 'validation_failure'
  | 'authorization_failure'
  | 'system_failure';

/**
 * The shipment-ending outcome geo-tracker stamps on the tracking session this
 * event closes. Mirrors ShipmentTerminal in visible-agents.service.
 */
export type ShipmentTerminalStatus = 'delivered' | 'returned' | 'cancelled' | 'failed';

export interface ITrackingOutbox extends Document {
  event_id: string; // stable UUID — geo-tracker dedups on this
  type: TrackingEventType;
  shipment_id: string | null;
  agent_id: string | null;
  agency_id: string | null;
  customer_id: string | null;

  // ─── the per-shipment tracking-session signals ─────────────────────────
  //
  // A geo-tracker tracking session spans exactly ONE shipment: it opens when
  // shipment_trackable turns true and closes when shipment_terminal is set (or
  // when shipment_trackable turns false without one — the shipment left this
  // agent). geo-tracker has no shipment model and cannot derive either; these
  // are computed here, in the source of truth, from TRACKABLE_SHIPMENT_STATUSES.
  //
  // Whether THIS shipment is in a trackable state, after this change. null when
  // not applicable (no shipment on the event).
  shipment_trackable: boolean | null;
  // The outcome, when this change ENDED the shipment; null otherwise. Note that
  // `rejected` / `pending_agency_reassignment` are NOT terminal — the shipment is
  // not over, it just left this agent, so it releases the session instead.
  shipment_terminal: ShipmentTerminalStatus | null;

  // Aggregate verdict, after this change, on whether the agent still has any
  // active (trackable) shipment. It names no shipment, so geo-tracker uses it
  // only as a BACKSTOP: false closes every session the agent has open (catching
  // a lost terminal event); it can never open one. null when not applicable (no
  // agent on the event).
  agent_has_active_shipment: boolean | null;
  // Agent-action audit fields (Phase 6). Populated only for `agent.action`
  // events; null otherwise.
  action: AgentActionKind | null;
  outcome: AgentActionOutcome | null;
  actor_role: string | null;
  reason: string | null;
  occurred_at: Date;
  status: TrackingOutboxStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const TrackingOutboxSchema = new Schema<ITrackingOutbox>(
  {
    event_id: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    shipment_id: { type: String, default: null },
    agent_id: { type: String, default: null },
    agency_id: { type: String, default: null },
    customer_id: { type: String, default: null },
    shipment_trackable: { type: Boolean, default: null },
    shipment_terminal: { type: String, default: null },
    agent_has_active_shipment: { type: Boolean, default: null },
    action: { type: String, default: null },
    outcome: { type: String, default: null },
    actor_role: { type: String, default: null },
    reason: { type: String, default: null },
    occurred_at: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    last_error: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Drain query: pending rows, oldest first.
TrackingOutboxSchema.index({ status: 1, created_at: 1 });

export const TrackingOutboxModel = mongoose.model<ITrackingOutbox>(
  MODELS.TRACKING_OUTBOX,
  TrackingOutboxSchema,
  COLLECTIONS.TRACKING_OUTBOX
);
