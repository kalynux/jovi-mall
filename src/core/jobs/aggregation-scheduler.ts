import cron, { ScheduledTask } from 'node-cron';
import { Types } from 'mongoose';
import { VendorModel } from '../../modules/vendors/vendor.model';
import { VendorAnalyticsService, isEmptyDay } from '../../modules/vendors/services/vendor-analytics.service';
import { VendorMoneyDailyModel } from '../../modules/vendors/models/vendor-money-daily.model';
import { EarningsAllocationModel } from '../../modules/earnings/models/earnings-allocation.model';
import { RefundTransactionModel } from '../../modules/payments/models/refund-transaction.model';
import { addDays, daysOf, localDay, toAnalyticsPeriod } from '../../modules/vendors/analytics/net-revenue';
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
 * ── 2026-09-27: what it computes was replaced; the worker, its key and its schedule were not ─
 * It used to write `vendor_daily_metrics` from ORDERS (placement date, "paid at 02:00"), which
 * could never match the wallet. It now writes `vendor_money_daily` from the EARNINGS ALLOCATIONS
 * — the finished days the vendor dashboard reads so it computes only today live (owner decision:
 * keep the heavy work at night). Same worker key (`analytics-aggregation`), same
 * `ANALYTICS_AGGREGATION_CRON`, same maintenance guard and trigger. See
 * `modules/vendors/models/vendor-money-daily.model.ts` for why a finished day is safe to store.
 *
 * It is now an `ObservableWorker` like the rest: schedule derived from the value it schedules
 * with, three honest booleans, a real `stop()`, the maintenance guard at the tick site, and an
 * entry in the triggerable registry — `runOnce()` is one idempotent pass, so "run it once" has
 * a single honest meaning here, unlike `inbound-calendar-sync`.
 */

const DEFAULT_CRON = '0 2 * * *';
const DEFAULT_TIMEZONE = 'Africa/Douala';
/** How far back the job fills days nobody has covered yet — the analytics range cap. */
const COVERAGE_DAYS = 366;
/** Days recomputed every night regardless, as margin for writes that committed across midnight. */
const RECOMPUTE_DAYS = 2;

class AnalyticsAggregationWorker implements ObservableWorker {
    private task: ScheduledTask | null = null;
    private inFlight = false;
    private readonly analytics = new VendorAnalyticsService();

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
     * One idempotent pass: every finished day not yet covered (up to a year back), plus the last
     * two days again, for every vendor with money activity in them.
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
            const zones = new Set<string>([DEFAULT_TIMEZONE]);
            const vendorZones = await VendorModel.distinct('timezone');
            for (const z of vendorZones) if (typeof z === 'string' && z) zones.add(z);

            for (const timezone of zones) {
                const result = await this.aggregateZone(timezone);
                vendors += result.vendors;
                failures += result.failures;
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

    /**
     * One timezone: find the span to (re)compute, compute every vendor with activity in it,
     * store their non-empty days, then mark the span covered.
     *
     * ⚠ **The coverage markers are written only when EVERY vendor in the zone succeeded.** A
     * marker means "a missing row is a real zero"; writing it after a vendor failed would turn
     * that vendor's sales into zeros on the dashboard instead of letting the read compute them
     * live.
     */
    private async aggregateZone(timezone: string): Promise<{ vendors: number; failures: number }> {
        const today = localDay(new Date(), timezone);
        const yesterday = addDays(today, -1);
        const oldest = addDays(today, -COVERAGE_DAYS);

        const markers = await VendorMoneyDailyModel.find({
            vendor_id: null,
            timezone,
            day: { $gte: oldest, $lt: today },
        })
            .select('day')
            .lean<{ day: string }[]>();
        const covered = new Set(markers.map((m) => m.day));
        const firstUncovered = daysOf({ from: oldest, to: yesterday }).find((d) => !covered.has(d));
        const recomputeFrom = addDays(today, -RECOMPUTE_DAYS);
        const from = firstUncovered && firstUncovered < recomputeFrom ? firstUncovered : recomputeFrom;
        const period = toAnalyticsPeriod(from, yesterday, timezone);
        const window = { $gte: period.start, $lt: period.end };

        // Vendors with ANY money activity in the span. A vendor with none needs no row: the
        // coverage marker already makes their missing days read as zero.
        const [created, reversed, refunded] = await Promise.all([
            EarningsAllocationModel.distinct('beneficiary_id', { beneficiary_type: 'vendor', created_at: window }),
            EarningsAllocationModel.distinct('beneficiary_id', { beneficiary_type: 'vendor', reversed_at: window }),
            RefundTransactionModel.distinct('vendorId', { status: 'completed', completedAt: window }),
        ]);
        const active = [...new Set([...created, ...reversed, ...refunded].filter(Boolean).map(String))];
        const inZone = active.length
            ? await VendorModel.find({ _id: { $in: active } }).select('timezone').lean<{ _id: Types.ObjectId; timezone?: string }[]>()
            : [];
        const vendorIds = inZone
            .filter((v) => (v.timezone || DEFAULT_TIMEZONE) === timezone)
            .map((v) => v._id.toString());

        let failures = 0;
        for (const vendorId of vendorIds) {
            try {
                const facts = await this.analytics.computeFacts(vendorId, period);
                const now = new Date();
                const vendor = new Types.ObjectId(vendorId);
                const writes = facts.map((f) =>
                    isEmptyDay(f)
                        ? { deleteOne: { filter: { vendor_id: vendor, timezone, day: f.day } } }
                        : {
                              updateOne: {
                                  filter: { vendor_id: vendor, timezone, day: f.day },
                                  update: { $set: { ...f, vendor_id: vendor, timezone, computed_at: now } },
                                  upsert: true,
                              },
                          },
                );
                if (writes.length) await VendorMoneyDailyModel.bulkWrite(writes as never, { ordered: false });
            } catch (error) {
                failures += 1;
                // One vendor's bad data must not cost every other vendor their analytics.
                console.error(`[AnalyticsAggregation] vendor ${vendorId} (${timezone}) failed:`, error);
            }
        }

        if (failures === 0) {
            const now = new Date();
            await VendorMoneyDailyModel.bulkWrite(
                daysOf(period).map((day) => ({
                    updateOne: {
                        filter: { vendor_id: null, timezone, day },
                        update: { $set: { vendor_id: null, timezone, day, computed_at: now } },
                        upsert: true,
                    },
                })) as never,
                { ordered: false },
            );
        }
        return { vendors: vendorIds.length, failures };
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
