import { eventBus } from '../../../core/events/event-bus';
import { IShipment } from '../../shipments/shipment.model';

/**
 * AgentAssignmentAuditService — the audit seam for offer responses.
 *
 * ── Where the durable audit actually lives ──────────────────────────────────
 *
 * The shipment_assignment_offers collection IS the audit of record: one
 * append-only row per (shipment, agent) attempt, each carrying its origin
 * (manual/auto), score + breakdown, candidate pool, and terminal transition
 * (accepted/rejected/expired/cancelled) with `responded_at` and the reason.
 * Reading a shipment's offers in order reconstructs exactly who it was offered
 * to and what they did — nothing here is needed for that.
 *
 * ── Why this is jovi-mall-only, not the geo-tracker agent.action audit ──────
 *
 * The Phase-6 `agent.action` audit (AgentActionAuditService) captures the
 * agent's GPS via geo-tracker, but its action kinds are a cross-service
 * contract fixed to pickup/delivery/return/cancel. Accept/reject are not among
 * them, and adding them would be an event-shape change that must land in both
 * repos together. So this service stays in jovi-mall: it publishes a business
 * audit event for any in-process consumer and leaves geo-tracker's contract
 * untouched. Best-effort and fire-and-forget — an audit hiccup never disturbs
 * the assignment.
 */
export type AssignmentAuditAction = 'accept' | 'reject';
export type AssignmentAuditOutcome = 'success' | 'failure';

export class AgentAssignmentAuditService {
  async emitOfferResponse(
    shipment: IShipment,
    agentId: string,
    action: AssignmentAuditAction,
    outcome: AssignmentAuditOutcome,
    reason: string | null = null
  ): Promise<void> {
    await this.publish({
      agentId,
      shipmentId: (shipment._id as any).toString(),
      agencyId: shipment.agency_id.toString(),
      orderId: shipment.order_id.toString(),
      action,
      outcome,
      reason,
    });
  }

  async emitOfferResponseById(
    shipmentId: string,
    agentId: string,
    action: AssignmentAuditAction,
    outcome: AssignmentAuditOutcome,
    reason: string | null = null
  ): Promise<void> {
    await this.publish({ agentId, shipmentId, action, outcome, reason });
  }

  private async publish(payload: Record<string, unknown>): Promise<void> {
    await eventBus.publish('agent.assignment_action', {
      eventType: 'agent.assignment_action',
      aggregateId: String(payload.shipmentId ?? ''),
      occurredAt: new Date(),
      payload,
    });
  }
}

export const agentAssignmentAuditService = new AgentAssignmentAuditService();
