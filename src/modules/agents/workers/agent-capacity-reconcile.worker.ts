import cron from 'node-cron';
import { AgentCapacityService, agentCapacityService } from '../domain/services/agent-capacity.service';

/**
 * AgentCapacityReconcileWorker — nightly correction of the admission-control
 * counter (`capacity.active_shipment_count`) from live shipment counts.
 *
 * The counter is authoritative for admission control (assignment reserves a slot
 * atomically on acceptance and releases it when the shipment leaves the agent's
 * active set), but a crash between the shipment write and the release, or a
 * removal path that forgets to release, leaves it drifted. This is the backstop
 * `AgentCapacityService.reconcile()` was built for: it recounts and corrects, so
 * a leaked slot self-heals within a day rather than silently starving an agent
 * of work.
 *
 * Daily node-cron, mirroring the other maintenance sweeps.
 */
export class AgentCapacityReconcileWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private readonly schedule = process.env.AGENT_CAPACITY_RECONCILE_CRON || '0 4 * * *';

  constructor(private readonly capacity: AgentCapacityService = agentCapacityService) {}

  start(): void {
    if (this.task) {
      console.log('[AgentCapacityReconcileWorker] Already started');
      return;
    }
    this.task = cron.schedule(this.schedule, () => {
      void this.runSweep();
    });
    console.log(`[AgentCapacityReconcileWorker] Scheduled daily capacity reconcile (${this.schedule})`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run once. Safe to call manually (ops/tests). */
  async runSweep(): Promise<void> {
    try {
      const { checked, corrected } = await this.capacity.reconcileAll();
      console.log(`[AgentCapacityReconcileWorker] Reconciled ${checked} agent(s), corrected ${corrected}`);
    } catch (error) {
      console.error('[AgentCapacityReconcileWorker] Sweep failed:', error);
    }
  }
}

export const agentCapacityReconcileWorker = new AgentCapacityReconcileWorker();
