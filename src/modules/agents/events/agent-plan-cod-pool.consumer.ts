import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { logger } from '../../../core/logging';
import { AgentCodPoolService, agentCodPoolService } from '../domain/services/agent-cod-pool.service';

/**
 * Keeps an agent's COD pool in step with their plan — the fast path.
 *
 * Billing owns plan policy and must not import the agents module, so it announces
 * and this module reacts, exactly as `AgentPlanCapacityConsumer` does for the
 * shipment cap. Two events:
 *
 *   `plan.activated`        an agent's active plan changed (purchase, admin
 *                           assignment, expiry downgrade, lazy free-tier creation)
 *                           → re-sync THAT agent.
 *   `pricing_plan.updated`  an administrator edited an agent plan's `max_cod_pool`
 *                           in place. No owner changed plan, so `plan.activated`
 *                           never fires for it → re-sync EVERY agent. The agent
 *                           population is small, the sync is idempotent and writes
 *                           nothing for an agent already in step, and filtering to
 *                           "agents on that plan" would have to reproduce the rule
 *                           that a plan-less agent reads the free tier.
 *
 * Neither handler reads the plan value off the payload. The pool depends on the
 * agent's KYC verdict and any administrator pin as well, so the sync re-resolves
 * everything from source; the payload only says WHO to look at.
 *
 * ⚠ The bus is lossy (R-2). `AgentCodPoolReconcileWorker` is the durability half —
 * dropping either registration leaves a real hole, the same argument
 * `registerPlanQuotaConsumer` + `planQuotaReconcileWorker` make in `lifecycle.ts`.
 */
export function registerAgentCodPoolConsumer(
  pools: AgentCodPoolService = agentCodPoolService
): void {
  eventBus.subscribe(
    'plan.activated',
    async (event: DomainEvent) => {
      if (event.payload.ownerType !== 'agent') return;
      const agentId = event.payload.ownerId as string;
      const result = await pools.sync(agentId, 'plan_activated');
      if (result?.changed) {
        logger().info(
          { agentId, from: result.from, to: result.to, planCode: result.ceiling.planCode, source: result.ceiling.source },
          'agent COD pool: synced to plan'
        );
      }
    },
    'AgentCodPoolConsumer.onPlanActivated',
  );

  eventBus.subscribe(
    'pricing_plan.updated',
    async (event: DomainEvent) => {
      if (event.payload.role !== 'agent') return;
      const changed = (event.payload.changed as string[] | undefined) ?? [];
      if (!changed.includes('max_cod_pool')) return;
      const summary = await pools.syncAll('plan_edited');
      logger().info(
        { planCode: event.payload.code, ...summary },
        'agent COD pool: re-synced every agent after an in-place plan edit'
      );
    },
    'AgentCodPoolConsumer.onPricingPlanUpdated',
  );

  logger().info('agent COD-pool sync consumer registered');
}
