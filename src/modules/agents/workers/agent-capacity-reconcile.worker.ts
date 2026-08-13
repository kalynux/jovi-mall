import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
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
export class AgentCapacityReconcileWorker implements ObservableWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;
  private readonly schedule = process.env.AGENT_CAPACITY_RECONCILE_CRON || '0 4 * * *';

  get schedules(): WorkerSchedule[] {
    return [{ kind: 'cron', expression: this.schedule, source: 'AGENT_CAPACITY_RECONCILE_CRON' }];
  }

  get scheduled(): boolean {
    return this.task !== null;
  }

  /** Observation only — no overlap guard. See `ObservableWorker`. */
  get executing(): boolean {
    return this.sweeping;
  }

  get enabled(): boolean {
    return true;
  }

  constructor(private readonly capacity: AgentCapacityService = agentCapacityService) {}

  start(): void {
    if (this.task) {
      console.log('[AgentCapacityReconcileWorker] Already started');
      return;
    }
    this.task = cron.schedule(this.schedule, () => {
      if (maintenanceBlocksWorkers()) return;
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
    // Flag only — deliberately NOT an early return. See `ObservableWorker`.
    this.sweeping = true;
    try {
      const { checked, corrected } = await this.capacity.reconcileAll();
      console.log(`[AgentCapacityReconcileWorker] Reconciled ${checked} agent(s), corrected ${corrected}`);
    } catch (error) {
      console.error('[AgentCapacityReconcileWorker] Sweep failed:', error);
    } finally {
      this.sweeping = false;
    }
  }
}

export const agentCapacityReconcileWorker = new AgentCapacityReconcileWorker();
