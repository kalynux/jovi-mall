import cron, { ScheduledTask } from 'node-cron';
import { subDays } from 'date-fns';
import { VendorModel } from '../../modules/vendors/vendor.model';
import { VendorAnalyticsAggregationService } from '../../modules/vendors/services/vendor-analytics-aggregation.service';
import { maintenanceBlocksWorkers } from '../../modules/system/services/maintenance.service';
import { recordWorkerRun } from '../../modules/system/metrics/metrics';
import { ObservableWorker, WorkerSchedule } from './worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from './worker-lock';

/**
 * Daily vendor analytics aggregation.
 *
 * ── This was the platform's THIRTEENTH scheduled job, and nothing could see it ─
 * Until Phase 15 this file called `cron.schedule('0 2 * * *', …)` and **discarded the returned
 * task handle**. The consequences were all invisible by construction:
 *
 *  - it appeared in no inventory, so `GET /system/workers` and `GET /dev-tools/workers` both
 *    reported twelve workers while thirteen were running;
 *  - it had no `stop()`, so nothing could ever halt it;
 *  - its schedule was a hardcoded literal — the exact duplicated-fact defect ADR-014 D-8 fixed
 *    for the other ten;
 *  - and it did **not** check `maintenanceBlocksWorkers()`, so a full-table sweep over every
 *    active vendor ran happily in the middle of a `down` window, which is precisely what
 *    `pauseWorkers` exists to prevent.
 *
 * It is now an `ObservableWorker` like the rest: schedule derived from the value it schedules
 * with, three honest booleans, a real `stop()`, the maintenance guard at the tick site, and an
 * entry in the triggerable registry — `runOnce()` is one idempotent pass, so "run it once" has
 * a single honest meaning here, unlike `inbound-calendar-sync`.
 */

const DEFAULT_CRON = '0 2 * * *';

class AnalyticsAggregationWorker implements ObservableWorker {
    private task: ScheduledTask | null = null;
    private inFlight = false;
    private readonly aggregationService = new VendorAnalyticsAggregationService();

    /** Derived from the value handed to `cron.schedule`, never retyped. ADR-014 D-8. */
    get schedules(): WorkerSchedule[] {
        return [{
            kind: 'cron',
            expression: process.env.ANALYTICS_AGGREGATION_CRON || DEFAULT_CRON,
            source: 'ANALYTICS_AGGREGATION_CRON',
        }];
    }

    get scheduled(): boolean {
        return this.task !== null;
    }

    get executing(): boolean {
        return this.inFlight;
    }

    get enabled(): boolean {
        return true;
    }

    start(): void {
        if (this.task) return;

        const expression = process.env.ANALYTICS_AGGREGATION_CRON || DEFAULT_CRON;

        this.task = cron.schedule(expression, () => {
            /**
             * The guard sits HERE, at the tick site, and not inside `runOnce()`.
             *
             * ADR-014 D-4: an operator explicitly triggering a worker mid-window is a deliberate
             * act and the whole point of `POST /dev-tools/workers/:key/run`. Putting the guard
             * inside the body would break that on purpose-built tooling.
             */
            if (maintenanceBlocksWorkers()) return;
            void this.runOnce();
        });

        console.log(`[AnalyticsAggregation] scheduled (${expression})`);
    }

    stop(): void {
        this.task?.stop();
        this.task = null;
    }

    /**
     * One idempotent pass over every active vendor, for yesterday.
     *
     * ── F-19 note: this worker was NOT in the finding, and should have been ─────
     * The audit named "seven cron workers" from the `CLAUDE.md` line, which was written before
     * this file became an `ObservableWorker` — so the thirteenth worker was missing from the
     * defect for the same reason it was missing from every other surface. It is a cron worker
     * setting `inFlight = true` with no early return, exactly like the seven.
     *
     * `null` on a skip, NOT `{ vendors: 0, failures: 0 }` — the same distinction `runVoidSweep`
     * draws in the registry. Zero vendors aggregated is a different statement from "this pass did
     * not run", and the trigger endpoint renders them differently.
     */
    async runOnce(): Promise<{ vendors: number; failures: number } | null> {
        const outcome = await withWorkerLock('analytics-aggregation', () => this.aggregate());
        return outcome === SWEEP_SKIPPED ? null : outcome;
    }

    private async aggregate(): Promise<{ vendors: number; failures: number }> {
        this.inFlight = true;
        const startedAt = Date.now();
        let vendors = 0;
        let failures = 0;

        try {
            const active = await VendorModel.find({ status: 'active' });
            vendors = active.length;

            // Vendor-local yesterday: the service converts using each vendor's own timezone.
            const yesterday = subDays(new Date(), 1);

            for (const vendor of active) {
                try {
                    await this.aggregationService.aggregateDailyMetrics(
                        vendor._id.toString(),
                        yesterday,
                        vendor.timezone || 'Africa/Douala',
                    );
                } catch (error) {
                    failures += 1;
                    // One vendor's bad data must not cost every other vendor their analytics.
                    console.error(`[AnalyticsAggregation] vendor ${vendor._id} failed:`, error);
                }
            }

            /**
             * `success` means THE SWEEP COMPLETED, not that every vendor succeeded.
             *
             * That distinction is load-bearing for the alert this metric exists to feed
             * (`time() - worker_last_success > 86400`). If one vendor's bad data marked the whole
             * pass a failure, `workerLastSuccess` would stop advancing and the alert would fire
             * for a sweep that is running perfectly well — which is how an alert gets muted, and
             * a muted alert is worse than none. Per-vendor failures are counted and logged.
             */
            recordWorkerRun(
                'analytics-aggregation', 'scheduled', 'success', (Date.now() - startedAt) / 1000, vendors,
            );
            return { vendors, failures };
        } catch (error) {
            recordWorkerRun(
                'analytics-aggregation', 'scheduled', 'failure', (Date.now() - startedAt) / 1000, vendors,
            );
            console.error('[AnalyticsAggregation] sweep failed:', error);
            return { vendors, failures };
        } finally {
            this.inFlight = false;
        }
    }
}

/**
 * The singleton. `server.ts` starts THIS — never `new AnalyticsAggregationWorker()` inline.
 *
 * The rule CLAUDE.md already states for `InboundCalendarSyncWorker`, for the same reason: a
 * worker constructed at the call site is unreachable by the operations surface and by `stop()`,
 * which is how this one stayed invisible in the first place.
 */
export const analyticsAggregationWorker = new AnalyticsAggregationWorker();

/** Back-compatible name, so `server.ts`'s call site reads the same as the other twelve. */
export function initAggregationScheduler(): void {
    analyticsAggregationWorker.start();
}
