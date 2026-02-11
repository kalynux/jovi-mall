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
 * Validate timezone string (IANA timezone)
 * 
 * Returns true if timezone is valid, false otherwise
 */
export function validateTimezone(timezone: string): boolean {
    try {
        fromZonedTime(new Date(), timezone);
        return true;
    } catch {
        return false;
    }
}
