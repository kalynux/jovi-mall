import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { refundRequestService } from '../services/refund-request.service';

/**
 * RefundCashRecheckWorker — the nightly backstop for COD refunds waiting on cash
 * (REFUND-FLOW-PLAN § 5.2, R-4 / R-5).
 *
 * A COD refund sits in `waiting_for_cash` until every collection it needs has fully reached the
 * platform. The fast path is the `cod.collections.settled` event (`initializeRefundDomain()`
 * subscribes it); the bus is in-process, unpersisted and swallows handler errors, so an event
 * lost to a restart or a failed handler would leave a covered refund waiting forever with no
 * symptom. This sweep re-asks `RefundRequestService.recheckWaitingForCash` once a night, which
 * moves every covered request to `approved` and sends it — the same code the event runs.
 *
 * Idempotent by construction: the move is a compare-and-set on `waiting_for_cash`, so a request
 * the event already released is skipped, and an uncovered one simply keeps waiting.
 *
 * A SECOND step rides the same pass (no new worker): `settleUnsettledCompleted` re-runs the
 * post-completion step of completed refunds whose `earnings_settled_at` / `billing_reversed_at`
 * is still null — the earnings recovery is otherwise fire-and-forget after commit.
 *
 * ⚠ The cadence is hardcoded (`hardcoded` in the schedule's `source`), like `PlanExpiryWorker`:
 * a backstop for a lost event needs no tuning knob, and an env variable would be one more name
 * for `test:env` to keep honest.
 */
export class RefundCashRecheckWorker implements ObservableWorker {
  /** The one place this cadence is written — `start()` schedules with it, `schedules` reports it. */
  static readonly CRON = '40 4 * * *';
  /** Requests re-checked per pass. A backlog larger than this drains over consecutive nights. */
  static readonly BATCH = 200;

  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;

  get schedules(): WorkerSchedule[] {
    return [{ kind: 'cron', expression: RefundCashRecheckWorker.CRON, source: 'hardcoded' }];
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

  start(): void {
    if (this.task) {
      console.log('[RefundCashRecheckWorker] Already started');
      return;
    }
    this.task = cron.schedule(RefundCashRecheckWorker.CRON, () => {
      if (maintenanceBlocksWorkers()) return;
      void this.runSweep();
    });
    console.log(`[RefundCashRecheckWorker] Scheduled nightly COD refund re-check (${RefundCashRecheckWorker.CRON})`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /**
   * One pass. Returns how many waiting refunds were released (moved to `approved` and sent), or
   * `null` when the overlap lock refused the pass — a different statement from `0` ("none was
   * covered yet").
   */
  async runSweep(): Promise<number | null> {
    const outcome = await withWorkerLock('refund-cash-recheck', async () => {
      this.sweeping = true;
      try {
        const released = await refundRequestService.recheckWaitingForCash(RefundCashRecheckWorker.BATCH);
        if (released > 0) {
          console.log(`[RefundCashRecheckWorker] Released ${released} COD refund(s) whose cash is now covered`);
        }
        // Step 2 (review findings 2 and 6): completed refunds whose post-completion step — the
        // earnings recovery + pause close, or the billing reversal — never finished. Each step is
        // idempotent, and the request's own marker (`earnings_settled_at` / `billing_reversed_at`)
        // says what is left, so a refund whose in-scope rows were all zero is not re-run forever.
        const settled = await refundRequestService.settleUnsettledCompleted(RefundCashRecheckWorker.BATCH);
        if (settled > 0) {
          console.log(`[RefundCashRecheckWorker] Settled ${settled} completed refund(s) whose earnings recovery or billing reversal was missing`);
        }
        return released;
      } finally {
        this.sweeping = false;
      }
    });
    return outcome === SWEEP_SKIPPED ? null : outcome;
  }
}

export const refundCashRecheckWorker = new RefundCashRecheckWorker();
