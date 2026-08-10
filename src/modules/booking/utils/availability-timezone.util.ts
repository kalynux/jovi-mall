import { fromZonedTime, toZonedTime } from 'date-fns-tz';

/**
 * Timezone helpers for availability windows and peak-hour pricing.
 *
 * WHY THIS EXISTS: availability rules store an IANA timezone and a wall-clock
 * `HH:mm` ("Monday 09:00"). Turning that pair into an absolute instant requires
 * the zone — `new Date().setHours(9)` resolves it against the *server's* clock,
 * which silently shifts every vendor's working day whenever the server moves.
 *
 * All functions here are PURE (no I/O, no DB) so they can be covered by the
 * DB-free test script, which is where the whole class of bug lived.
 *
 * Terminology used throughout: a **wall-clock day** is a calendar date as seen
 * in the target zone (`2026-08-08`), never a UTC date.
 */

/** A wall-clock day in a specific zone, decomposed. */
export interface ZonedDay {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  /** Day of week in the target zone, 0 (Sunday) - 6 (Saturday). */
  dayOfWeek: number;
}

/**
 * Parses an `HH:mm` string into minutes-from-midnight.
 * @throws RangeError on a malformed value — callers validate on write, so a bad
 *   value here means corrupt data rather than bad input.
 */
export function parseHhMm(hhmm: string): number {
  const match = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.exec(hhmm);
  if (!match) {
    throw new RangeError(`Invalid HH:mm time: '${hhmm}'`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Describes the wall-clock day that `instant` falls on in `timezone`.
 *
 * `toZonedTime` returns a Date whose *local* getters read as the target zone's
 * wall clock, which is exactly what we need to read the date parts off.
 */
export function zonedDayOf(instant: Date, timezone: string): ZonedDay {
  const zoned = toZonedTime(instant, timezone);
  return {
    year: zoned.getFullYear(),
    month: zoned.getMonth() + 1,
    day: zoned.getDate(),
    dayOfWeek: zoned.getDay(),
  };
}

/**
 * Converts a wall-clock day + minutes-from-midnight in `timezone` into the
 * absolute instant it names.
 *
 * Minutes beyond 1440 roll into the following day, so an end time of `24:00`
 * (stored as `00:00` with a rollover) and DST-shifted days both resolve
 * correctly — `fromZonedTime` applies the offset in effect on that date.
 */
export function zonedWallClockToInstant(
  day: Pick<ZonedDay, 'year' | 'month' | 'day'>,
  minutesFromMidnight: number,
  timezone: string
): Date {
  const dayOffset = Math.floor(minutesFromMidnight / (24 * 60));
  const withinDay = minutesFromMidnight - dayOffset * 24 * 60;
  const hours = Math.floor(withinDay / 60);
  const minutes = withinDay % 60;

  // Build a naive "local" timestamp for the target date, then let date-fns-tz
  // reinterpret it as wall-clock time in `timezone`.
  const naive = new Date(
    day.year,
    day.month - 1,
    day.day + dayOffset,
    hours,
    minutes,
    0,
    0
  );
  return fromZonedTime(naive, timezone);
}

/**
 * Lists every wall-clock day in `timezone` that the interval [from, to] touches,
 * inclusive at both ends.
 *
 * Iterating wall-clock days (rather than adding 24h to a UTC instant) is what
 * keeps a DST transition from skipping or duplicating a day.
 *
 * @param maxDays Safety bound so a malformed range cannot spin. Ranges are
 *   already capped by the callers' validators; this is belt-and-braces.
 */
export function eachZonedDay(
  from: Date,
  to: Date,
  timezone: string,
  maxDays = 400
): ZonedDay[] {
  if (!(from.getTime() <= to.getTime())) return [];

  const days: ZonedDay[] = [];
  let cursor = zonedDayOf(from, timezone);
  const last = zonedDayOf(to, timezone);

  const key = (d: ZonedDay): number => d.year * 10000 + d.month * 100 + d.day;
  const lastKey = key(last);

  for (let guard = 0; guard < maxDays; guard++) {
    days.push(cursor);
    if (key(cursor) >= lastKey) break;

    // Step to the next wall-clock day by landing at midday (safely clear of any
    // DST edge) and re-reading the zone's date parts.
    const midday = zonedWallClockToInstant(cursor, 12 * 60, timezone);
    cursor = zonedDayOf(new Date(midday.getTime() + 24 * 60 * 60 * 1000), timezone);
  }

  return days;
}

/**
 * Counts the minutes of [start, end) whose wall-clock time in `timezone` falls
 * inside a peak window, on one of `daysOfWeek` (empty means every day).
 *
 * Walks minute by minute so multi-day intervals, day boundaries and DST shifts
 * are all handled without special cases. Intervals here are single appointments,
 * so the iteration count is small and bounded by `maxMinutes`.
 */
export function peakOverlapMinutes(
  start: Date,
  end: Date,
  peak: { daysOfWeek: number[]; startTime: string; endTime: string },
  timezone: string,
  maxMinutes = 60 * 24 * 31
): number {
  const windowStart = parseHhMm(peak.startTime);
  const windowEnd = parseHhMm(peak.endTime);
  const days = new Set(peak.daysOfWeek);
  const everyDay = days.size === 0;

  let count = 0;
  let steps = 0;
  for (let t = start.getTime(); t < end.getTime() && steps < maxMinutes; t += 60_000, steps++) {
    const zoned = toZonedTime(new Date(t), timezone);
    if (!everyDay && !days.has(zoned.getDay())) continue;
    const minuteOfDay = zoned.getHours() * 60 + zoned.getMinutes();
    if (minuteOfDay >= windowStart && minuteOfDay < windowEnd) count++;
  }
  return count;
}
