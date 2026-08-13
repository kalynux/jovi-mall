import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
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
 * - stop(): Gracefully stops all intervals
 * - Handles SIGTERM for graceful shutdown
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

        // Graceful shutdown
        process.on('SIGTERM', () => this.stop());
        process.on('SIGINT', () => this.stop());
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
     * Execute near-future sync
     */
    private async runNearFutureSync(): Promise<void> {
        const fromDate = new Date();
        const toDate = new Date();
        toDate.setDate(toDate.getDate() + CalendarSyncConfig.nearFutureWindowDays);

        console.log(`[InboundCalendarSyncWorker] Running near-future sync: ${fromDate.toISOString()} → ${toDate.toISOString()}`);

        this.nearSyncing = true;
        try {
            const report = await this.syncService.syncAllVendors(fromDate, toDate);

            console.log('[InboundCalendarSyncWorker] Near-future sync complete:', {
                vendors: report.vendorsProcessed,
                events: report.totalEventsFetched,
                upserted: report.totalBlocksUpserted,
                skipped: report.totalBlocksSkipped,
                softDeleted: report.totalBlocksSoftDeleted,
                failures: report.failures,
            });
        } catch (error: any) {
            console.error('[InboundCalendarSyncWorker] Near-future sync failed:', error);
        } finally {
            this.nearSyncing = false;
        }
    }

    /**
     * Execute far-future sync
     */
    private async runFarFutureSync(): Promise<void> {
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() + CalendarSyncConfig.nearFutureWindowDays);

        const toDate = new Date();
        toDate.setDate(toDate.getDate() + CalendarSyncConfig.farFutureWindowDays);

        console.log(`[InboundCalendarSyncWorker] Running far-future sync: ${fromDate.toISOString()} → ${toDate.toISOString()}`);

        this.farSyncing = true;
        try {
            const report = await this.syncService.syncAllVendors(fromDate, toDate);

            console.log('[InboundCalendarSyncWorker] Far-future sync complete:', {
                vendors: report.vendorsProcessed,
                events: report.totalEventsFetched,
                upserted: report.totalBlocksUpserted,
                skipped: report.totalBlocksSkipped,
                softDeleted: report.totalBlocksSoftDeleted,
                failures: report.failures,
            });
        } catch (error: any) {
            console.error('[InboundCalendarSyncWorker] Far-future sync failed:', error);
        } finally {
            this.farSyncing = false;
        }
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
