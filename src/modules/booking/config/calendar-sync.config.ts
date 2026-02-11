/**
 * Calendar Sync Configuration
 * 
 * Two-tier sync strategy to balance API load vs data freshness:
 * - Near-future (0-30 days): High-frequency sync (10 min) for immediate booking window
 * - Far-future (30-60 days): Low-frequency sync (daily) for planning window
 */

export const CalendarSyncConfig = {
    // Master enable/disable
    enabled: process.env.CALENDAR_SYNC_ENABLED !== 'false',

    // Near-future sync (high priority: immediate booking window)
    nearFutureIntervalMs: parseInt(process.env.CALENDAR_SYNC_NEAR_INTERVAL_MS || '600000'), // 10 minutes
    nearFutureWindowDays: parseInt(process.env.CALENDAR_SYNC_NEAR_WINDOW_DAYS || '30'),

    // Far-future sync (low priority: planning window)
    farFutureIntervalMs: parseInt(process.env.CALENDAR_SYNC_FAR_INTERVAL_MS || '86400000'), // 24 hours
    farFutureWindowDays: parseInt(process.env.CALENDAR_SYNC_FAR_WINDOW_DAYS || '60'),

    // Batch processing
    batchSize: parseInt(process.env.CALENDAR_SYNC_BATCH_SIZE || '50'), // vendors per batch

    // Sync locking (prevents overlapping syncs in horizontal scaling)
    syncLockTtlMs: 300000, // 5 minutes
};
