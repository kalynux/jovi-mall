import { RedisClientType } from 'redis';
import { getRedisClient } from '../../../infra/redis/redis.factory';
import { ConnectedCalendarAccount } from '../../integrations/calendar/google/connected-account.model';
import { CalendarClientFactory } from '../../integrations/calendar/calendar-client.factory';
import { CalendarEvent } from '../../integrations/calendar/interfaces/calendar-client.interface';
import {
    CalendarAuthExpiredError,
    CalendarPermissionError,
} from '../../integrations/calendar/errors/calendar.errors';
import { ExternalCalendarBlock, IExternalCalendarBlock } from '../models/external-calendar-block.model';
import { Booking } from '../models/booking.model';

/**
 * InboundCalendarSyncService - Syncs external Google Calendar events into platform
 * 
 * RESPONSIBILITIES:
 * - Fetch events from vendor Google Calendars
 * - Filter out platform-created events (bookings)
 * - Upsert into ExternalCalendarBlock (idempotent, skip unchanged)
 * - Soft-delete stale blocks
 * - Handle errors per vendor (isolation)
 * - Vendor sync locking for horizontal scaling
 * 
 * IMPORTANT:
 * - Uses listEvents() instead of getBusySlots() to access event metadata
 * - Compares externalUpdatedAt to skip unchanged events
 * - Soft-deletes (isActive: false) instead of hard delete
 */

export interface VendorSyncResult {
    vendorId: string;
    success: boolean;
    eventsFetched: number;
    blocksUpserted: number;
    blocksSkipped: number;
    blocksSoftDeleted: number;
    error?: string;
}

export interface SyncReport {
    vendorsProcessed: number;
    totalEventsFetched: number;
    totalBlocksUpserted: number;
    totalBlocksSkipped: number;
    totalBlocksSoftDeleted: number;
    failures: number;
    results: VendorSyncResult[];
}

export class InboundCalendarSyncService {
    private redisClient: RedisClientType | null = null;

    constructor() {
        // Redis client for sync locking (optional, graceful degradation if unavailable).
        //
        // Routed through the factory rather than `createClient` directly. It used to build its
        // own client, which made it invisible to `redisClientSnapshot()` — so `/system/cache`
        // and `/system/dependencies` would have under-reported this process's real connection
        // count without ever saying so. Safe to share: `closeRedisClients()` has no call sites,
        // so nothing can `quit()` it out from under a sync in flight.
        if (process.env.REDIS_URL) {
            getRedisClient(0)
                .then((client) => {
                    this.redisClient = client;
                })
                .catch((err) => {
                    console.error('[InboundCalendarSync] Redis connection failed, sync locking disabled:', err);
                    this.redisClient = null;
                });
        }
    }

    /**
     * Syncs all vendors with connected Google Calendars
     */
    async syncAllVendors(fromDate: Date, toDate: Date): Promise<SyncReport> {
        const report: SyncReport = {
            vendorsProcessed: 0,
            totalEventsFetched: 0,
            totalBlocksUpserted: 0,
            totalBlocksSkipped: 0,
            totalBlocksSoftDeleted: 0,
            failures: 0,
            results: [],
        };

        try {
            // Find all vendors with active Google Calendar connections
            const accounts = await ConnectedCalendarAccount.find({
                provider: 'google',
                vendorId: { $exists: true, $ne: null },
                requiresReauth: { $ne: true }, // Skip accounts needing re-auth
            });

            console.log(`[InboundCalendarSync] Found ${accounts.length} vendors with connected calendars`);

            // Process vendors sequentially to avoid overwhelming API
            for (const account of accounts) {
                const vendorId = account.vendorId!.toString();

                // Skip if another worker is syncing this vendor
                const lockAcquired = await this.acquireVendorSyncLock(vendorId, 300000); // 5 min TTL
                if (!lockAcquired) {
                    console.log(`[InboundCalendarSync] Vendor ${vendorId} already being synced, skipping`);
                    continue;
                }

                try {
                    const result = await this.syncVendor(vendorId, fromDate, toDate);
                    report.results.push(result);
                    report.vendorsProcessed++;

                    if (result.success) {
                        report.totalEventsFetched += result.eventsFetched;
                        report.totalBlocksUpserted += result.blocksUpserted;
                        report.totalBlocksSkipped += result.blocksSkipped;
                        report.totalBlocksSoftDeleted += result.blocksSoftDeleted;
                    } else {
                        report.failures++;
                    }
                } finally {
                    await this.releaseVendorSyncLock(vendorId);
                }
            }

            console.log(`[InboundCalendarSync] Sync complete:`, {
                vendors: report.vendorsProcessed,
                events: report.totalEventsFetched,
                upserted: report.totalBlocksUpserted,
                skipped: report.totalBlocksSkipped,
                softDeleted: report.totalBlocksSoftDeleted,
                failures: report.failures,
            });

            return report;
        } catch (error: any) {
            console.error('[InboundCalendarSync] Fatal error during sync:', error);
            throw error;
        }
    }

    /**
     * Syncs a single vendor's calendar
     */
    async syncVendor(vendorId: string, fromDate: Date, toDate: Date): Promise<VendorSyncResult> {
        const result: VendorSyncResult = {
            vendorId,
            success: false,
            eventsFetched: 0,
            blocksUpserted: 0,
            blocksSkipped: 0,
            blocksSoftDeleted: 0,
        };

        try {
            // Get calendar client
            const calendarClient = await CalendarClientFactory.forVendor(vendorId);

            // Fetch events (use listEvents for metadata, not just busy slots)
            const allEvents = await calendarClient.listEvents(fromDate, toDate);
            result.eventsFetched = allEvents.length;

            // Filter out platform-created events and cancelled events
            const externalEvents = await this.filterPlatformEvents(allEvents, vendorId);

            console.log(
                `[InboundCalendarSync] Vendor ${vendorId}: ${allEvents.length} total events, ${externalEvents.length} external`
            );

            // Upsert blocks (skip unchanged via externalUpdatedAt comparison)
            const upsertResult = await this.upsertBlocks(vendorId, externalEvents);
            result.blocksUpserted = upsertResult.upserted;
            result.blocksSkipped = upsertResult.skipped;

            // Soft-delete stale blocks (events that no longer exist)
            const validEventIds = externalEvents.map((e) => e.externalId);
            result.blocksSoftDeleted = await this.softDeleteStaleBlocks(vendorId, validEventIds);

            result.success = true;
        } catch (error: any) {
            result.error = error.message;

            // Handle specific error types
            if (error instanceof CalendarAuthExpiredError) {
                console.error(`[InboundCalendarSync] Vendor ${vendorId} auth expired, marking requiresReauth`);
                await ConnectedCalendarAccount.updateOne(
                    { vendorId },
                    { $set: { requiresReauth: true } }
                );
            } else if (error instanceof CalendarPermissionError) {
                console.error(`[InboundCalendarSync] Vendor ${vendorId} permission denied:`, error.message);
            } else {
                console.error(`[InboundCalendarSync] Vendor ${vendorId} sync failed:`, error);
            }
        }

        return result;
    }

    /**
   * Filters out events created by this platform to avoid circular blocking
   */
    private async filterPlatformEvents(
        events: CalendarEvent[],
        vendorId: string
    ): Promise<CalendarEvent[]> {
        // Get all booking event IDs for this vendor
        const bookings = await Booking.find({
            vendorId,
            externalCalendarEventId: { $exists: true, $ne: null },
        }).select('externalCalendarEventId');

        const platformEventIds = new Set(
            bookings.map((b) => b.externalCalendarEventId).filter(Boolean) as string[]
        );

        // Filter out platform events
        // Note: Cancelled events are typically not returned by listEvents with singleEvents: true
        return events.filter((event) => {
            // Skip platform-created events
            if (platformEventIds.has(event.externalId)) {
                return false;
            }

            return true;
        });
    }

    /**
     * Upserts blocks, skipping if externalUpdatedAt is unchanged
     */
    private async upsertBlocks(
        vendorId: string,
        events: CalendarEvent[]
    ): Promise<{ upserted: number; skipped: number }> {
        let upserted = 0;
        let skipped = 0;

        for (const event of events) {
            try {
                // Check if block exists and is unchanged
                const existingBlock = await ExternalCalendarBlock.findOne({
                    vendorId,
                    provider: 'google',
                    externalEventId: event.externalId,
                });

                // Use current time as default if metadata doesn't have updated timestamp
                // In practice, Google events always have an 'updated' field, but we handle gracefully
                const externalUpdatedAt = event.metadata?.updated
                    ? new Date(event.metadata.updated)
                    : new Date();

                // Skip if unchanged (optimization)
                if (existingBlock && existingBlock.externalUpdatedAt.getTime() === externalUpdatedAt.getTime()) {
                    skipped++;
                    continue;
                }

                // Extract timezone from metadata if available, otherwise default to UTC
                const timezone = event.metadata?.timeZone || 'UTC';

                // Upsert block
                await ExternalCalendarBlock.updateOne(
                    {
                        vendorId,
                        provider: 'google',
                        externalEventId: event.externalId,
                    },
                    {
                        $set: {
                            startTime: event.start,
                            endTime: event.end,
                            timezone,
                            sourceCalendarId: 'primary', // Assuming primary for now
                            externalUpdatedAt,
                            lastSyncedAt: new Date(),
                            isActive: true, // Re-activate if was soft-deleted
                        },
                    },
                    { upsert: true }
                );

                upserted++;
            } catch (error: any) {
                console.error(
                    `[InboundCalendarSync] Failed to upsert block for event ${event.externalId}:`,
                    error
                );
                // Continue processing other events
            }
        }

        return { upserted, skipped };
    }

    /**
     * Soft-deletes blocks that no longer exist in Google Calendar
     */
    private async softDeleteStaleBlocks(vendorId: string, validEventIds: string[]): Promise<number> {
        const result = await ExternalCalendarBlock.updateMany(
            {
                vendorId,
                provider: 'google',
                externalEventId: { $nin: validEventIds },
                isActive: true, // Only soft-delete currently active blocks
            },
            {
                $set: {
                    isActive: false,
                    lastSyncedAt: new Date(),
                },
            }
        );

        return result.modifiedCount || 0;
    }

    /**
     * Acquires a Redis lock for vendor sync (prevents concurrent syncs)
     */
    private async acquireVendorSyncLock(vendorId: string, ttlMs: number): Promise<boolean> {
        if (!this.redisClient) {
            // No Redis, allow sync (no locking)
            return true;
        }

        try {
            const lockKey = `calendar_sync_lock:${vendorId}`;
            const result = await this.redisClient.set(lockKey, '1', {
                PX: ttlMs,
                NX: true, // Only set if not exists
            });

            return result === 'OK';
        } catch (error) {
            console.error(`[InboundCalendarSync] Lock acquisition failed for ${vendorId}:`, error);
            // On error, allow sync (fail-open)
            return true;
        }
    }

    /**
     * Releases vendor sync lock
     */
    private async releaseVendorSyncLock(vendorId: string): Promise<void> {
        if (!this.redisClient) {
            return;
        }

        try {
            const lockKey = `calendar_sync_lock:${vendorId}`;
            await this.redisClient.del(lockKey);
        } catch (error) {
            console.error(`[InboundCalendarSync] Lock release failed for ${vendorId}:`, error);
            // Non-fatal, lock will expire
        }
    }

    /**
     * Cleanup on service shutdown
     */
    async shutdown(): Promise<void> {
        if (this.redisClient) {
            await this.redisClient.quit();
        }
    }
}
