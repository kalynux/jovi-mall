import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { startOfDay, endOfDay } from 'date-fns';

/**
 * Timezone utilities using date-fns-tz
 * 
 * CRITICAL: All date boundaries must be calculated in vendor's timezone
 * to ensure accurate day-by-day aggregation
 */

/**
 * Get start and end of day in vendor's timezone
 * 
 * Example:
 * - Vendor timezone: 'Africa/Douala'  (UTC+1)
 * - Date: 2026-02-10
 * - Returns: {
 *     start: 2026-02-09T23:00:00.000Z (midnight in vendor TZ, 11PM UTC day before),
 *     end: 2026-02-10T22:59:59.999Z (end of day in vendor TZ, 10:59PM UTC)
 *   }
 */
export function getDateBoundaries(date: Date, timezone: string): { start: Date; end: Date } {
    // Convert to vendor timezone
    const zonedDate = toZonedTime(date, timezone);

    // Get start/end of day in vendor timezone
    const startOfDayZoned = startOfDay(zonedDate);
    const endOfDayZoned = endOfDay(zonedDate);

    // Convert back to UTC for DB queries
    return {
        start: fromZonedTime(startOfDayZoned, timezone),
        end: fromZonedTime(endOfDayZoned, timezone)
    };
}

/**
 * Validate an IANA timezone name (e.g. 'Africa/Douala').
 *
 * Uses `Intl.DateTimeFormat`, which throws a RangeError on an unknown zone — the
 * only reliable check available without shipping a zone database.
 *
 * NOTE: this previously probed `fromZonedTime`, which does **not** throw on a bad
 * zone; it returns an Invalid Date. The try/catch therefore never fired and the
 * function returned `true` for literally any string, including ''. Callers
 * (the analytics validators, and now the availability-rule validator) were
 * validating nothing.
 */
export function validateTimezone(timezone: string): boolean {
    if (!timezone) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}
