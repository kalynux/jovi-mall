import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, DEFAULT_LOCK_TTL_MS } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { CalendarSyncConfig } from '../config/calendar-sync.config';
import { InboundCalendarSyncService } from '../services/inbound-calendar-sync.service';

/**
 * InboundCalendarSyncWorker - Periodic polling worker for calendar sync
 * 
 * TWO-TIER SYNC STRATEGY:
 * 1. Near-future (0-30 days): Every 10 minutes (high-priority booking window)
 * 2. Far-future (30-60 days): Daily (low-priority planning window)
 * 
 * This dramatically reduces API load while maintaining fresh data for immediate bookings.
 * 
 * LIFECYCLE:
 * - start(): Begins both sync loops
 * - stop(): Gracefully stops all intervals — awaited, because a sync pass may be in flight
 *
 * This worker used to register its OWN `process.on('SIGTERM'|'SIGINT')` inside `start()`,
 * back when it was the only one of fourteen that handled a signal at all. That is gone:
 * `lifecycle.ts` owns the ordered shutdown and `stopAllWorkers()` calls this `stop()` along
 * with the other thirteen. A private handler would have run concurrently WITH the drain
 * rather than in the drain's order — and registering a listener inside `start()` is also how
 * a process quietly accumulates them.
 */

export class InboundCalendarSyncWorker implements ObservableWorker {
    private nearFutureInterval: NodeJS.Timeout | null = null;
    private farFutureInterval: NodeJS.Timeout | null = null;
    private syncService: InboundCalendarSyncService;
    private isRunning = false;
    private nearSyncing = false;
    private farSyncing = false;

    /**
     * Two intervals — which is exactly why `schedules` is a list rather than one value.
     *
     * This worker is also the reason the inventory and the *triggerable* registry are separate
     * exports. Its work splits across two private methods with different horizons and it holds
     * per-instance state, so "run it once" has no single honest meaning and it stays out of
     * `WORKER_REGISTRY`. But an operator could previously not see that it EXISTS at all, which
     * is a different problem from not being able to trigger it — so it appears here.
     */
    get schedules(): WorkerSchedule[] {
        return [
            {
                kind: 'interval',
                everyMs: CalendarSyncConfig.nearFutureIntervalMs,
                source: 'CALENDAR_SYNC_NEAR_INTERVAL_MS',
            },
            {
                kind: 'interval',
                everyMs: CalendarSyncConfig.farFutureIntervalMs,
                source: 'CALENDAR_SYNC_FAR_INTERVAL_MS',
            },
        ];
    }

    get scheduled(): boolean {
        return this.nearFutureInterval !== null || this.farFutureInterval !== null;
    }

    get executing(): boolean {
        return this.nearSyncing || this.farSyncing;
    }

    get enabled(): boolean {
        return CalendarSyncConfig.enabled;
    }

    constructor() {
        this.syncService = new InboundCalendarSyncService();
    }

    /**
     * Starts the worker (both sync loops)
     */
    start(): void {
        if (!CalendarSyncConfig.enabled) {
            console.log('[InboundCalendarSyncWorker] Sync disabled via config, not starting');
            return;
        }

        if (this.isRunning) {
            console.log('[InboundCalendarSyncWorker] Already running');
            return;
        }

        this.isRunning = true;
        console.log('[InboundCalendarSyncWorker] Starting two-tier sync worker');

        // Near-future sync (high frequency)
        this.startNearFutureSync();

        // Far-future sync (low frequency)
        this.startFarFutureSync();
    }

    /**
     * Near-future sync loop (0-30 days, every 10 minutes)
     */
    private startNearFutureSync(): void {
        console.log(
            `[InboundCalendarSyncWorker] Starting near-future sync: 0-${CalendarSyncConfig.nearFutureWindowDays} days, every ${CalendarSyncConfig.nearFutureIntervalMs / 1000}s`
        );

        // Run immediately
        this.runNearFutureSync();

        // Then run on interval
        this.nearFutureInterval = setInterval(
            () => {
                if (maintenanceBlocksWorkers()) return;
                void this.runNearFutureSync();
            },
            CalendarSyncConfig.nearFutureIntervalMs
        );
    }

    /**
     * Far-future sync loop (30-60 days, daily)
     */
    private startFarFutureSync(): void {
        console.log(
            `[InboundCalendarSyncWorker] Starting far-future sync: ${CalendarSyncConfig.nearFutureWindowDays}-${CalendarSyncConfig.farFutureWindowDays} days, every ${CalendarSyncConfig.farFutureIntervalMs / 1000}s`
        );

        // Run immediately
        this.runFarFutureSync();

        // Then run on interval
        this.farFutureInterval = setInterval(
            () => {
                if (maintenanceBlocksWorkers()) return;
                void this.runFarFutureSync();
            },
            CalendarSyncConfig.farFutureIntervalMs
        );
    }

    /**
     * Execute near-future sync.
     *
     * ── F-19 note: this worker was NOT in the finding, and should have been ─────
     * The audit named "seven cron workers"; these two loops are on `setInterval` and were not
     * counted, but they had the same unguarded shape and the near-future one is the most likely
     * of the thirteen to actually overrun — it polls Google for EVERY vendor with a connected
     * calendar, on a ten-minute cadence, so the sweep's duration grows with the vendor roster
     * while the interval does not.
     *
     * ── Two lock keys, never one ───────────────────────────────────────────────
     * The near and far horizons are independent work. Sharing a key would let the ten-minute loop
     * starve the daily one out of its window every time it happened to be running, which is a new
     * bug in exchange for the old one.
     */
    private async runNearFutureSync(): Promise<void> {
        await withWorkerLock(
            'inbound-calendar-sync:near',
            () => this.syncWindow('near', 0, CalendarSyncConfig.nearFutureWindowDays),
            // Near the cadence: a lock stranded by a hard kill must not cost more than a
            // handful of ten-minute passes.
            { ttlMs: Math.max(CalendarSyncConfig.nearFutureIntervalMs * 3, 60_000) },
        );
    }

    private async syncWindow(horizon: 'near' | 'far', fromOffsetDays: number, toOffsetDays: number): Promise<void> {
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() + fromOffsetDays);
        const toDate = new Date();
        toDate.setDate(toDate.getDate() + toOffsetDays);

        const label = horizon === 'near' ? 'near-future' : 'far-future';
        console.log(`[InboundCalendarSyncWorker] Running ${label} sync: ${fromDate.toISOString()} → ${toDate.toISOString()}`);

        if (horizon === 'near') this.nearSyncing = true;
        else this.farSyncing = true;
        try {
            const report = await this.syncService.syncAllVendors(fromDate, toDate);

            console.log(`[InboundCalendarSyncWorker] ${label} sync complete:`, {
                vendors: report.vendorsProcessed,
                events: report.totalEventsFetched,
                upserted: report.totalBlocksUpserted,
                skipped: report.totalBlocksSkipped,
                softDeleted: report.totalBlocksSoftDeleted,
                failures: report.failures,
            });
        } catch (error: any) {
            console.error(`[InboundCalendarSyncWorker] ${label} sync failed:`, error);
        } finally {
            if (horizon === 'near') this.nearSyncing = false;
            else this.farSyncing = false;
        }
    }

    /**
     * Execute far-future sync. Its own lock key — see `runNearFutureSync`.
     */
    private async runFarFutureSync(): Promise<void> {
        await withWorkerLock(
            'inbound-calendar-sync:far',
            () => this.syncWindow(
                'far',
                CalendarSyncConfig.nearFutureWindowDays,
                CalendarSyncConfig.farFutureWindowDays,
            ),
            // Daily, and a full 30-60 day pull over every vendor. The default TTL is renewed
            // while it runs, so this only bounds how long a crashed pass blocks the next one.
            { ttlMs: DEFAULT_LOCK_TTL_MS },
        );
    }

    /**
     * Stops the worker gracefully
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        console.log('[InboundCalendarSyncWorker] Stopping worker...');

        if (this.nearFutureInterval) {
            clearInterval(this.nearFutureInterval);
            this.nearFutureInterval = null;
        }

        if (this.farFutureInterval) {
            clearInterval(this.farFutureInterval);
            this.farFutureInterval = null;
        }

        await this.syncService.shutdown();

        this.isRunning = false;
        console.log('[InboundCalendarSyncWorker] Stopped');
    }
}

/**
 * The instance the application runs.
 *
 * `server.ts` used to do `new InboundCalendarSyncWorker().start()` inline, which left the
 * running worker **unreachable by anything else** — so the operations surface could not report
 * on it even in principle, and `stop()` could never be called on the one that was actually
 * scheduled. A singleton is what makes `scheduled`/`executing` describe the real worker rather
 * than a second, idle copy.
 */
export const inboundCalendarSyncWorker = new InboundCalendarSyncWorker();
