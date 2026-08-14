import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { recordWorkerRun } from '../../system/metrics/metrics';
import { shipmentAssignmentService } from '../domain/services/shipment-assignment.service';
import { ASSIGNMENT_CONFIG } from '../config/assignment.config';

/**
 * AssignmentSweepWorker — the polling engine behind the acceptance workflow's
 * time-driven behaviour. Each tick does two independent jobs:
 *
 *   1. ADVANCE due auto-assignment sessions — a session whose 2-minute frontier
 *      window has elapsed offers the next ranked candidate (or re-nudges an
 *      ignored one in round 2, or gives up after the last round). This is the
 *      "Ignore ⇒ offer the next agent" branch of the requirement.
 *   2. EXPIRE due MANUAL offers — a one-shot agency pick nobody answered returns
 *      the shipment to the agency queue. (Auto offers never expire on timeout —
 *      an ignored agent keeps an acceptable offer; the session drives them.)
 *
 * setInterval, not node-cron: a sub-minute cadence, like the tracking dispatcher.
 * Guarded so ticks never overlap ON THIS INSTANCE; across instances, session
 * advancement is a guarded compare-and-set and manual expiry a guarded
 * transition, so several instances running this sweep cannot double-offer or
 * double-expire.
 */
export class AssignmentSweepWorker implements ObservableWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  get schedules(): WorkerSchedule[] {
    return [{
      kind: 'interval',
      everyMs: ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_INTERVAL_MS,
      source: 'SHIPMENT_ASSIGNMENT_OFFER_EXPIRY_SWEEP_INTERVAL_MS',
    }];
  }

  get scheduled(): boolean {
    return this.timer !== null;
  }

  /** `running` means in-flight here, as in the tracking dispatcher. */
  get executing(): boolean {
    return this.running;
  }

  get enabled(): boolean {
    return true;
  }

  start(): void {
    if (this.timer) {
      console.log('[AssignmentSweepWorker] Already started');
      return;
    }
    this.timer = setInterval(() => {
      if (maintenanceBlocksWorkers()) return;
      void this.sweepOnce();
    }, ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_INTERVAL_MS);
    console.log(
      `[AssignmentSweepWorker] Started (every ${ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_INTERVAL_MS}ms; offer timeout ${ASSIGNMENT_CONFIG.OFFER_TIMEOUT_SECONDS}s, max ${ASSIGNMENT_CONFIG.MAX_ROUNDS} rounds)`
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One sweep: advance due sessions, then expire due manual offers.
   *
   * Already guarded in-process, which is why it was not in F-19; the shared lock adds the
   * cross-instance half. This is the one worker documented as multi-instance-safe on its own
   * (`advanceDueSessions` and `expireDueOffers` are guarded compare-and-sets), so the lock is a
   * narrowing rather than the thing keeping it correct — the CAS stays, and must.
   */
  async sweepOnce(): Promise<boolean> {
    const outcome = await withWorkerLock('assignment-sweep', () => this.sweep(), {
      // A stranded lock must not stall the only thing advancing auto-assignment sessions.
      ttlMs: Math.max(ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_INTERVAL_MS * 5, 120_000),
    });
    return outcome !== SWEEP_SKIPPED;
  }

  private async sweep(): Promise<void> {
    this.running = true;
    /**
     * Phase 15 instrumentation, and this is the worker ADR-014 D-6 singles out: it is the only
     * thing that advances an auto-assignment session and the only thing that expires a manual
     * offer, and if it stops **nothing throws and nothing logs** — shipments simply sit on offer
     * forever while agencies wonder why nobody picks anything up. A `last_success` timestamp is
     * the only signal that can catch that.
     */
    const startedAt = Date.now();
    let handled = 0;
    try {
      const advanced = await shipmentAssignmentService.advanceDueSessions();
      if (advanced > 0) console.log(`[AssignmentSweepWorker] Advanced ${advanced} assignment session(s)`);
      const expired = await shipmentAssignmentService.expireDueOffers();
      if (expired > 0) console.log(`[AssignmentSweepWorker] Expired ${expired} manual offer(s)`);
      handled = advanced + expired;
      recordWorkerRun('assignment-sweep', 'scheduled', 'success', (Date.now() - startedAt) / 1000, handled);
    } catch (error) {
      recordWorkerRun('assignment-sweep', 'scheduled', 'failure', (Date.now() - startedAt) / 1000, handled);
      console.error('[AssignmentSweepWorker] Sweep failed:', error);
    } finally {
      this.running = false;
    }
  }
}

export const assignmentSweepWorker = new AssignmentSweepWorker();

// Backwards-compatible aliases — the boot code imported `offerExpiryWorker`.
export const OfferExpiryWorker = AssignmentSweepWorker;
export const offerExpiryWorker = assignmentSweepWorker;
