import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import {
  IDeliveryAgent,
  AgentAvailabilityState,
  AgentWorkingState,
} from '../../models/agent.model';
import { AGENT_CONFIG, ACTIVE_SHIPMENT_STATUSES } from '../../config/agent.config';
import { ShipmentModel } from '../../../shipments/shipment.model';
import { eventBus } from '../../../../core/events/event-bus';

/**
 * AgentAvailabilityService — the agent's declared intent, and the system's
 * derived view of their load.
 *
 * These are two different things and are kept apart on purpose:
 *
 *   availability  — "I want work" / "I'm on break". The agent writes it.
 *                   Nobody else may, because it models a human decision.
 *   working_state — "he's holding 3 shipments, he's full". The system derives
 *                   it from shipment counts. The agent must not write it,
 *                   because it models a fact.
 *
 * The old `live_state.current_capacity_status` fused both into one enum
 * (available | busy | offline), which cannot express "online but full" versus
 * "offline and empty" — a distinction dispatch needs.
 */
export class AgentAvailabilityService {
  constructor(private readonly agents: AgentRepository = agentRepository) {}

  // ─── Availability (agent-written) ─────────────────────────────────────────

  /**
   * Set the agent's availability.
   *
   * Going offline with work in flight is permitted: the agent may be finishing
   * deliveries and simply not wanting NEW ones, which is exactly what offline
   * means here. Blocking it would push agents to lie about their state, and it
   * is the eligibility rules — not this field — that stop new assignments.
   */
  async setAvailability(
    agentId: string,
    state: AgentAvailabilityState,
    reason: string | null
  ): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    // A suspended/inactive account has no business declaring itself available;
    // the eligibility rules would reject it anyway, so fail loudly and early
    // rather than let the agent believe they are on shift.
    if (state === 'online' && agent.status !== 'active') {
      throw createAppError(ERROR_CODES.AGENT_NOT_ACTIVE, 422, undefined, { status: agent.status });
    }

    const previous = agent.availability?.state ?? 'offline';
    const updated = await this.agents.setAvailability(agentId, {
      state,
      changed_at: new Date(),
      reason,
    });
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    if (previous !== state) {
      void eventBus
        .publish('agent.availability_changed', {
          eventType: 'agent.availability_changed',
          aggregateId: agentId,
          occurredAt: new Date(),
          payload: { agentId, from: previous, to: state, reason },
        })
        .catch((err) => console.error('[AgentAvailabilityService] availability emit failed:', err));
    }

    return updated;
  }

  // ─── Working state (system-derived) ───────────────────────────────────────

  /**
   * Recompute an agent's working state from live shipment counts.
   *
   * Derived rather than incremented: a counter drifts the first time a shipment
   * is settled by a path that forgets to decrement it, and a wrong count here
   * silently blocks dispatch. Counting is cheap and always right.
   *
   * Call after any change to an agent's shipment set.
   */
  async recomputeWorkingState(agentId: string, session?: ClientSession): Promise<IDeliveryAgent | null> {
    const agent = await this.agents.findById(agentId, session);
    if (!agent) return null;

    const activeCount = await ShipmentModel.countDocuments({
      agent_id: agentId,
      status: { $in: ACTIVE_SHIPMENT_STATUSES },
    }).session(session ?? null);

    const state = this.deriveWorkingState(agent, activeCount);
    const previous = agent.working_state?.state ?? 'idle';

    const updated = await this.agents.setWorkingState(agentId, state, activeCount, session);

    if (previous !== state) {
      void eventBus
        .publish('agent.working_state_changed', {
          eventType: 'agent.working_state_changed',
          aggregateId: agentId,
          occurredAt: new Date(),
          payload: { agentId, from: previous, to: state, activeShipmentCount: activeCount },
        })
        .catch((err) => console.error('[AgentAvailabilityService] working state emit failed:', err));
    }

    return updated;
  }

  /** Pure derivation — unit-testable without a database. */
  deriveWorkingState(agent: IDeliveryAgent, activeShipmentCount: number): AgentWorkingState {
    const max = this.maxConcurrent(agent);
    if (activeShipmentCount <= 0) return 'idle';
    if (activeShipmentCount >= max) return 'at_capacity';
    return 'working';
  }

  /** The agent's effective concurrency ceiling, bounded by platform config. */
  maxConcurrent(agent: IDeliveryAgent): number {
    const configured =
      agent.capacity?.max_active_shipments ?? AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_DEFAULT;
    return Math.min(configured, AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MAX);
  }
}

export const agentAvailabilityService = new AgentAvailabilityService();
