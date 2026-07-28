import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { AgentRepository } from '../repositories/agent.repository';
import { AGENT_CONFIG } from '../config/agent.config';

/**
 * Syncs an agent's concurrency cap to their active pricing plan.
 *
 * Billing owns plan *policy* and must not import the agents module, so it emits
 * `plan.activated` (fired whenever a plan becomes an owner's active plan). This
 * consumer — living in the agents module — reacts for `agent` owners and writes
 * the plan's `maxUnterminatedShipments` onto `capacity.max_active_shipments`. The
 * existing atomic reserve/release on offer-accept then enforces the plan cap with
 * zero change to the accept path. A `null` (unlimited) plan cap maps to the
 * config ceiling.
 */
export function registerAgentPlanCapacityConsumer(
  agentRepo: AgentRepository = new AgentRepository()
): void {
  eventBus.subscribe('plan.activated', async (event: DomainEvent) => {
    const ownerType = event.payload.ownerType as string;
    if (ownerType !== 'agent') return;
    const ownerId = event.payload.ownerId as string;
    const cap = event.payload.maxUnterminatedShipments as number | null;
    const max = cap ?? AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MAX;
    await agentRepo.setMaxActiveShipments(ownerId, max);
    console.log(`[AgentPlanCapacity] Synced agent ${ownerId} max_active_shipments → ${max}`);
  });
  console.log('[AgentPlanCapacity] Agent plan-capacity sync consumer registered');
}
