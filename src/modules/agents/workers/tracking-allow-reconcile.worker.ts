import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { recordWorkerRun } from '../../system/metrics/metrics';
import { trackingIntegrationEnabled } from '../../tracking-integration/config/tracking-integration.config';
import { trackingOutboxEmitter, TrackingOutboxEmitter } from '../../tracking-integration/services/tracking-outbox.emitter';
import { AgentRepository, agentRepository } from '../repositories/agent.repository';
import { AGENT_CONFIG } from '../config/agent.config';

/**
 * TrackingAllowReconcileWorker — the backstop for the one cross-service event that had no
 * recovery path of any kind (plan step 3.A.3; X-1's `agent.tracking_allow_changed` row).
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT REDUNDANT WITH THE TRANSACTIONAL WRITE ────────────
 * Step 3.A.1 put the outbox row in the same transaction as the flag, so the row can no longer
 * be lost between the write and the enqueue. That closes the *crash* window and nothing else.
 * Everything downstream of the enqueue can still fail for hours: the dispatcher retries with
 * backoff and then **parks the row as `failed` at `MAX_ATTEMPTS`**, after which nothing replays
 * it without an operator. For every other event type that is survivable — geo-tracker's
 * `agentHasActiveShipment` aggregate eventually closes a session the per-shipment verdict
 * missed. Tracking Allow has no aggregate, no sweep and no TTL:
 *
 *   - `visible-agents` does not consult the flag, so geo-tracker's revocation sweep keeps every
 *     watcher on re-check;
 *   - no shipment event carries `trackingAllowed`, so no later event corrects it;
 *   - the device half (`DeviceState.TrackingEnabled`) is the agent's own opt-in and says
 *     nothing about the administrator's decision.
 *
 * So an undelivered revocation is permanent, and its failure mode is the worst one in the
 * contract: an administrator pressed "disable tracking", was shown success, and the agent goes
 * on broadcasting a live position indefinitely. This sweep re-pushes it until it lands.
 *
 * ── ONLY REVOCATIONS, DELIBERATELY ───────────────────────────────────────────────────────
 * See `AgentRepository.listTrackingRevoked`. A lost *grant* fails in the safe direction and
 * self-heals the moment anyone looks; re-pushing every `true` would put the whole roster through
 * the dispatcher on a timer.
 *
 * ── IT IS A BACKSTOP, NOT A DELIVERY MECHANISM ───────────────────────────────────────────
 * The push in `AgentTrackingPolicyService.setTrackingAllowed` is the delivery mechanism and it
 * is transactional. This runs on a slow cadence and re-states a decision that has *already*
 * been made. It therefore breaks the rule the emitter's docstring states — "the write site
 * emits only on a real change" — **on purpose, and it is the only caller allowed to**: the
 * whole point is to re-deliver an unchanged value. geo-tracker's `SetTrackingAllow` is
 * idempotent, so a redundant push writes the same device state and drives no new transition.
 *
 * ⚠ **This corrects drift; it cannot report it.** Nothing here reads geo-tracker's device state,
 * so "how far apart were the two sides" has no answer. Closing that would mean a read endpoint
 * on geo-tracker — a two-repo change, deliberately deferred (see the plan's open risk 1).
 *
 * Inert when `GEO_TRACKER_BASE_URL` is unset, like the dispatcher it feeds: the rows would
 * accumulate and never drain, which is the intended local default rather than a backlog.
 */
export class TrackingAllowReconcileWorker implements ObservableWorker {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  private readonly intervalMs = AGENT_CONFIG.TRACKING_ALLOW_RECONCILE_INTERVAL_MS;
  private readonly batchSize = AGENT_CONFIG.TRACKING_ALLOW_RECONCILE_BATCH;

  get schedules(): WorkerSchedule[] {
    return [{
      kind: 'interval',
      everyMs: this.intervalMs,
      source: 'TRACKING_ALLOW_RECONCILE_INTERVAL_MS',
    }];
  }

  get scheduled(): boolean {
    return this.timer !== null;
  }

  get executing(): boolean {
    return this.sweeping;
  }

  /**
   * Reported rather than assumed, for the same reason the dispatcher reports it: without this an
   * operator reads "every 15 minutes" on a deploy where it has never once run.
   */
  get enabled(): boolean {
    return trackingIntegrationEnabled();
  }

  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly emitter: TrackingOutboxEmitter = trackingOutboxEmitter
  ) {}

  start(): void {
    if (this.timer) {
      console.log('[TrackingAllowReconcileWorker] Already started');
      return;
    }
    if (!trackingIntegrationEnabled()) {
      console.log('[TrackingAllowReconcileWorker] GEO_TRACKER_BASE_URL not set — reconcile inert');
      return;
    }
    this.timer = setInterval(() => {
      if (maintenanceBlocksWorkers()) return;
      void this.runSweep();
    }, this.intervalMs);
    console.log(
      `[TrackingAllowReconcileWorker] Started (every ${this.intervalMs}ms, up to ${this.batchSize} agent(s) per pass)`
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run one pass. Safe to call manually, and safe to call concurrently — a second caller is
   * refused rather than queued, so a trigger landing on a scheduled tick does not double-push.
   *
   * Returns false when the lock refused the pass, which is what `runOnce` reports as
   * `ran: false` rather than swallowing.
   */
  async runSweep(): Promise<boolean> {
    const outcome = await withWorkerLock('tracking-allow-reconcile', () => this.sweep());
    return outcome !== SWEEP_SKIPPED;
  }

  private async sweep(): Promise<void> {
    const startedAt = Date.now();

    /**
     * The inert guard is HERE, not only in `start()`, and that distinction was found by running
     * it: `start()` refusing to schedule leaves `runSweep()` reachable from the dev-tools
     * trigger, so an operator on a deploy with no geo-tracker would enqueue a re-push for every
     * revoked agent — rows that can never drain, on top of an outbox nothing is draining
     * either. "Inert when `GEO_TRACKER_BASE_URL` is unset" has to be true of every entry point
     * or it is not a property, just a scheduling detail.
     *
     * Recorded as `skipped` rather than `success`, so it does not advance
     * `worker_last_success_timestamp_seconds` — a worker that legitimately did nothing must not
     * look like one that ran.
     */
    if (!trackingIntegrationEnabled()) {
      recordWorkerRun('tracking-allow-reconcile', 'scheduled', 'skipped', (Date.now() - startedAt) / 1000);
      console.log('[TrackingAllowReconcileWorker] GEO_TRACKER_BASE_URL not set — nothing re-pushed');
      return;
    }

    this.sweeping = true;
    let pushed = 0;
    try {
      const revoked = await this.agents.listTrackingRevoked(this.batchSize);
      for (const agent of revoked) {
        // No session: a sweep is not a state change, so there is no transaction for the row to
        // join. That is the one case `enqueue`'s optional session parameter exists for — the
        // row is a re-statement of a decision that committed long ago.
        await this.emitter.emitTrackingAllowChanged({
          agentId: agent.id,
          allowed: false,
          reason: agent.reason,
          actorRole: 'system',
        });
        pushed += 1;
      }
      recordWorkerRun('tracking-allow-reconcile', 'scheduled', 'success', (Date.now() - startedAt) / 1000, pushed);
      if (pushed > 0) {
        console.log(`[TrackingAllowReconcileWorker] Re-pushed tracking revocation for ${pushed} agent(s)`);
      }
    } catch (error) {
      recordWorkerRun('tracking-allow-reconcile', 'scheduled', 'failure', (Date.now() - startedAt) / 1000, pushed);
      console.error('[TrackingAllowReconcileWorker] Sweep failed:', error);
    } finally {
      this.sweeping = false;
    }
  }
}

export const trackingAllowReconcileWorker = new TrackingAllowReconcileWorker();
