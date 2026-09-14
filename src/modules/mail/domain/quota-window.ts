import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { MailQuotaPeriod } from '../mail.config';

/**
 * When a provider's sending allowance next rolls over.
 *
 * PURE — no I/O, no ambient clock, no config read. `now` and the zone are both parameters, which
 * is what lets `test:mail-chain` assert the month-end and year-end cases without waiting for
 * December. Same discipline as `booking/utils/availability-windows.util.ts`, and for the same
 * reason: every bug this file could have is an off-by-one in calendar arithmetic, and those are
 * only findable when the clock is an argument.
 */

/**
 * The next `period` boundary strictly after `now`, in `timezone`.
 *
 * ── Why a boundary rather than "now + 24h" ───────────────────────────────────
 * A provider's daily allowance is not a rolling window, it is a calendar one: Brevo's 300/day
 * refills at its own midnight, not 24 hours after you exhausted it. Latching for a fixed
 * duration therefore holds the primary provider out for most of the following day too — an
 * account exhausted at 23:50 would stay latched until 23:50 the next day, wasting almost a full
 * allowance. The boundary is the only form that releases at the moment the allowance actually
 * returns.
 *
 * ⚠ **Read `MailLatchConfig.quotaResetTimezone` before changing the default.** The zone being
 * modelled is the PROVIDER's accounting day (both reckon in UTC), not the platform's market.
 *
 * The `<= now` guard at the end is not reachable through ordinary arithmetic; it exists because
 * a DST transition can make a zone's midnight ambiguous or non-existent, and a latch that
 * resolves to the past is a latch that does nothing at all — the failure mode that looks like
 * the feature working.
 */
export function nextQuotaResetAt(now: Date, period: MailQuotaPeriod, timezone: string): Date {
    const zoned = toZonedTime(now, timezone);

    // `new Date(y, m, d)` normalises overflow, so `d + 1` on the 31st and `m + 1` on December
    // both roll the year correctly without a special case.
    const wallClockBoundary = period === 'daily'
        ? new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate() + 1, 0, 0, 0, 0)
        : new Date(zoned.getFullYear(), zoned.getMonth() + 1, 1, 0, 0, 0, 0);

    // `fromZonedTime` reads the Date's LOCAL fields as a wall clock in `timezone` and returns the
    // instant that names. Constructing the boundary with local getters above is what makes that
    // round trip correct — the same idiom `zonedDayToInstant` uses in the booking utils.
    const instant = fromZonedTime(wallClockBoundary, timezone);

    if (instant.getTime() <= now.getTime()) {
        return new Date(now.getTime() + 60 * 60 * 1000);
    }
    return instant;
}
