import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { AGENT_CONFIG } from '../config/agent.config';
import { AgentTrustService, agentTrustService } from '../domain/services/agent-trust.service';
import { AgentRepository, agentRepository } from '../repositories/agent.repository';

/**
 * AgentTrustRecomputeWorker — the nightly composite trust recompute.
 *
 * Recompute is **batch-only by product decision** (`AGENT-CONTRACT-REFACTOR.md`,
 * "Decisions locked"), with one exception the same document asked for and never
 * got: a COD-negative event recomputes that agent immediately, because waiting
 * until 03:00 to throttle the cash limit of an agent who just came up short is a
 * safety regression against the delta model it replaces. That immediate path is
 * `recomputeOne` below, called from the COD discrepancy flow — not from here.
 *
 * ── ⚠ THIS WORKER DOES NOT WRITE THE LIVE SCORE ──────────────────────────────
 * It writes `trust_signals.composite_score` through `setTrustSignalsShadow`.
 * `cod.trust_score` — the number `CodExposureService` turns into an agent's cash
 * limit — is still written only by `CodTrustService.applyEvent`. Phase 6 D-2, and
 * `test:agent-trust` asserts it by source scan. The flip is Step 11 and it is a
 * one-line change here: `setTrustSignalsShadow` → `setTrustScore`.
 *
 * ── ⚠ AND IT NEVER TOUCHES `cod.trust_override` ──────────────────────────────
 * An administrator's pinned score (O-7) is a separate field, and NOTHING here
 * writes it — not `setTrustSignalsShadow`, not `setTrustScore` after the flip.
 * That is the property the whole override design rests on: an override a nightly
 * sweep could overwrite is not persistent, and the cutover would then depend on
 * somebody remembering to exclude it.
 *
 * The consequence worth stating: after the flip this worker will happily compute
 * 100 for an agent an administrator has pinned at 35, and write it — correctly.
 * The computed score is what the platform thinks; the override is what a human
 * decided; `resolveEffectiveTrustScore` is where the two meet, and it is the
 * override that wins. `test:agent-trust` scans for both halves.
 *
 * Daily node-cron, mirroring the other maintenance sweeps.
 */
export class AgentTrustRecomputeWorker implements ObservableWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;
  private readonly schedule = AGENT_CONFIG.TRUST_RECOMPUTE_CRON;

  get schedules(): WorkerSchedule[] {
    return [{ kind: 'cron', expression: this.schedule, source: 'AGENT_TRUST_RECOMPUTE_CRON' }];
  }

  get scheduled(): boolean {
    return this.task !== null;
  }

  get executing(): boolean {
    return this.sweeping;
  }

  get enabled(): boolean {
    return AGENT_CONFIG.TRUST_RECOMPUTE_ENABLED;
  }

  constructor(
    private readonly trust: AgentTrustService = agentTrustService,
    private readonly agents: AgentRepository = agentRepository
  ) {}

  start(): void {
    if (this.task) {
      console.log('[AgentTrustRecomputeWorker] Already started');
      return;
    }
    if (!this.enabled) {
      console.log('[AgentTrustRecomputeWorker] Disabled by AGENT_TRUST_RECOMPUTE_ENABLED');
      return;
    }
    this.task = cron.schedule(this.schedule, () => {
      if (maintenanceBlocksWorkers()) return;
      void this.runSweep();
    });
    console.log(`[AgentTrustRecomputeWorker] Scheduled nightly trust recompute (${this.schedule})`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /**
   * Recompute one agent, now. The immediate path for COD-negative events.
   *
   * Deliberately **not** behind the sweep lock: it is a single-document write for
   * one agent, and blocking it behind a 40-minute batch would reintroduce exactly
   * the delay it exists to remove. A collision with the sweep costs one redundant
   * recompute of the same agent from the same inputs, which is idempotent.
   */
  async recomputeOne(agentId: string): Promise<number | null> {
    try {
      const { signals, composite } = await this.trust.recompute(agentId);
      await this.agents.setTrustSignalsShadow(agentId, composite.score, signals);
      return composite.score;
    } catch (error) {
      // Best-effort by design: a trust recompute must never fail the COD write
      // that triggered it. The nightly sweep is the backstop.
      console.error(`[AgentTrustRecomputeWorker] Immediate recompute failed for ${agentId}:`, error);
      return null;
    }
  }

  /**
   * Run once over every agent. Safe to call manually (ops/tests), and safe to call
   * CONCURRENTLY — a second caller is refused rather than queued (F-19).
   */
  async runSweep(): Promise<boolean> {
    const outcome = await withWorkerLock('agent-trust-recompute', async () => {
      this.sweeping = true;
      try {
        const ids = await this.agents.listAllIds();
        let recomputed = 0;
        let failed = 0;

        for (const id of ids) {
          try {
            const { signals, composite } = await this.trust.recompute(id);
            await this.agents.setTrustSignalsShadow(id, composite.score, signals);
            recomputed++;
          } catch (error) {
            // One agent's bad data must not cost every later agent their recompute.
            failed++;
            console.error(`[AgentTrustRecomputeWorker] Recompute failed for ${id}:`, error);
          }
        }

        console.log(
          `[AgentTrustRecomputeWorker] Recomputed ${recomputed}/${ids.length} agent(s)` +
            (failed > 0 ? `, ${failed} failed` : '') +
            ' (shadow — cod.trust_score unchanged)'
        );
      } catch (error) {
        console.error('[AgentTrustRecomputeWorker] Sweep failed:', error);
      } finally {
        this.sweeping = false;
      }
    });
    return outcome !== SWEEP_SKIPPED;
  }
}

export const agentTrustRecomputeWorker = new AgentTrustRecomputeWorker();
