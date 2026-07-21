import { AppError } from '../../../core/errors';
import { ShipmentStatus, IShipment } from '../../shipments/shipment.model';
import { AgentActionKind, AgentActionOutcome } from '../models/tracking-outbox.model';
import { TrackingOutboxRepository } from '../repositories/tracking-outbox.repository';

/**
 * AgentActionAuditService — the jovi-mall emitter for the Phase 6 agent-action
 * audit. When an agent performs (or an agency drives, on the agent's shipment) a
 * shipment action, this enqueues an `agent.action` outbox row. geo-tracker
 * receives it, captures the agent's latest GPS, and writes the immutable audit.
 *
 * The BUSINESS event stays here (jovi-mall owns what happened and whether it
 * succeeded); geo-tracker owns only the SPATIAL audit (where the agent was).
 * Emission is post-commit and fire-and-forget at the call sites — an audit
 * hiccup must never disturb a delivery.
 */

/**
 * Maps a shipment status transition to the audited action kind it represents,
 * or null when the target status is not one of the four audited actions
 * (pending/assigned/in_transit/pending_agency_reassignment produce no audit).
 * Kept as a pure function so the mapping is unit-testable without a DB.
 */
const STATUS_ACTION: Partial<Record<ShipmentStatus, AgentActionKind>> = {
  picked_up: 'pickup',
  agent_delivered: 'delivery', // the agent's own "I'm at the door" delivery claim
  delivered: 'delivery',
  returned: 'return',
  failed: 'cancel',
  rejected: 'cancel',
};

export function shipmentStatusToAction(status: ShipmentStatus): AgentActionKind | null {
  return STATUS_ACTION[status] ?? null;
}

/**
 * Maps a thrown error to the failure outcome, for instrumenting an agent's own
 * action handler (COD collect). Zod validation → validation_failure; AppError by
 * HTTP status (401/403 → authorization, 400/422 → validation); anything else is
 * an unexpected system failure.
 */
export function outcomeFromError(err: unknown): AgentActionOutcome {
  if (err instanceof Error && err.name === 'ZodError') return 'validation_failure';
  if (err instanceof AppError) {
    if (err.statusCode === 401 || err.statusCode === 403) return 'authorization_failure';
    if (err.statusCode === 400 || err.statusCode === 422) return 'validation_failure';
    return 'system_failure';
  }
  return 'system_failure';
}

export interface AgentActionInput {
  action: AgentActionKind;
  outcome: AgentActionOutcome;
  agentId?: string | null;
  shipmentId?: string | null;
  actorRole: string;
  reason?: string | null;
  occurredAt?: Date;
}

export class AgentActionAuditService {
  constructor(private readonly outbox: TrackingOutboxRepository = new TrackingOutboxRepository()) {}

  /**
   * Enqueue one agent-action audit event. No-op when there is no agent — the
   * audit captures the AGENT's GPS, so an actionless-of-agent event has no
   * subject. Callers invoke this fire-and-forget (`void ...catch(log)`).
   */
  async emit(input: AgentActionInput): Promise<void> {
    if (!input.agentId) return;
    await this.outbox.enqueue({
      type: 'agent.action',
      agentId: input.agentId,
      shipmentId: input.shipmentId ?? null,
      action: input.action,
      outcome: input.outcome,
      actorRole: input.actorRole,
      reason: input.reason ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    });
  }

  /**
   * Emit the SUCCESS audit for a shipment that just transitioned, if the new
   * status is one of the four audited actions and the shipment has an agent.
   * Called post-commit from `ShipmentService` for agency-driven transitions.
   */
  async emitShipmentTransition(shipment: IShipment, actorRole: string): Promise<void> {
    const action = shipmentStatusToAction(shipment.status);
    if (!action) return;
    await this.emit({
      action,
      outcome: 'success',
      agentId: shipment.agent_id ? shipment.agent_id.toString() : null,
      shipmentId: shipment._id.toString(),
      actorRole,
    });
  }
}

export const agentActionAuditService = new AgentActionAuditService();
