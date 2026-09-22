import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { AgentCodPoolService, agentCodPoolService } from '../domain/services/agent-cod-pool.service';

/**
 * AgentCodPoolReconcileWorker — nightly convergence of every agent's COD pool onto
 * the rule in `agent-cod-pool.ts` (KYC verdict → administrator pin → plan).
 *
 * The pool is normally kept in step immediately: a KYC verdict syncs it in-line,
 * `plan.activated` and `pricing_plan.updated` sync it through
 * `AgentCodPoolConsumer`. This is the durability half, for the three ways those
 * miss:
 *
 *   1. a lost event — the in-memory bus is lossy (R-2), and a crash between a plan
 *      commit and its post-commit publish drops it outright;
 *   2. a sync that failed or lost every compare-and-set, which is logged and left
 *      here rather than retried in a request;
 *   3. agents written before the rule existed (their provenance fields are absent),
 *      which is how a deploy converges an existing roster with no data migration —
 *      and why an operator may want to TRIGGER it once after deploying rather than
 *      wait for the night (it is triggerable from the dev-tools worker console).
 *
 * Idempotent: an agent already in step is read and not written.
 */
export class AgentCodPoolReconcileWorker implements ObservableWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;
  private readonly schedule = process.env.AGENT_COD_POOL_RECONCILE_CRON || '30 4 * * *';

  get schedules(): WorkerSchedule[] {
    return [{ kind: 'cron', expression: this.schedule, source: 'AGENT_COD_POOL_RECONCILE_CRON' }];
  }

  get scheduled(): boolean {
    return this.task !== null;
  }

  get executing(): boolean {
    return this.sweeping;
  }

  get enabled(): boolean {
    return true;
  }

  constructor(private readonly pools: AgentCodPoolService = agentCodPoolService) {}

  start(): void {
    if (this.task) {
      console.log('[AgentCodPoolReconcileWorker] Already started');
      return;
    }
    this.task = cron.schedule(this.schedule, () => {
      if (maintenanceBlocksWorkers()) return;
      void this.runSweep();
    });
    console.log(`[AgentCodPoolReconcileWorker] Scheduled daily COD-pool reconcile (${this.schedule})`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /**
   * Run once. Safe to call manually (ops/tests), and refuses rather than queues a
   * concurrent second run. The lock is a courtesy here rather than a correctness
   * requirement — every write is a compare-and-set — but two replicas sweeping the
   * same roster at 04:30 is work for nothing.
   */
  async runSweep(): Promise<boolean> {
    const outcome = await withWorkerLock('agent-cod-pool-reconcile', async () => {
      this.sweeping = true;
      try {
        const { checked, changed, failed } = await this.pools.syncAll('reconcile');
        console.log(
          `[AgentCodPoolReconcileWorker] Checked ${checked} agent(s), changed ${changed}, failed ${failed}`
        );
      } catch (error) {
        console.error('[AgentCodPoolReconcileWorker] Sweep failed:', error);
      } finally {
        this.sweeping = false;
      }
    });
    return outcome !== SWEEP_SKIPPED;
  }
}

export const agentCodPoolReconcileWorker = new AgentCodPoolReconcileWorker();
