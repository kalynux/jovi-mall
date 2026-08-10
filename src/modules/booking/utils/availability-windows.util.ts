import { TimeWindow } from '../types/booking.types';
import { eachZonedDay, parseHhMm, zonedWallClockToInstant } from './availability-timezone.util';

/**
 * Pure window arithmetic for availability.
 *
 * These were private methods on `AvailabilityService`, which also does DB and
 * Google Calendar I/O — so none of them could be tested without a database and a
 * connected calendar. Every availability bug found in review lived in this
 * arithmetic, so it is extracted here and covered by `test:booking-availability`.
 *
 * Convention: a window is the half-open interval [start, end).
 */

/** The shape of an availability rule this module needs. Deliberately structural. */
export interface AvailabilityRuleLike {
  dayOfWeek: number;   // 0 (Sunday) - 6 (Saturday), in the rule's own timezone
  startTime: string;   // 'HH:mm' wall-clock
  endTime: string;     // 'HH:mm' wall-clock
  timezone?: string | null;
}

/** A booked interval and how many active bookings occupy it. */
export interface BookedWindow extends TimeWindow {
  count: number;
}

/** Whether two half-open intervals share any time at all. */
export function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.start.getTime() < b.end.getTime() && a.end.getTime() > b.start.getTime();
}

/** Whether two windows describe exactly the same interval. */
export function windowsEqual(a: TimeWindow, b: TimeWindow): boolean {
  return a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}

/**
 * Trims a window to the query range, or returns null when nothing is left.
 *
 * THE BUG THIS FIXES: the previous code kept a window only when it sat *entirely*
 * inside [from, to] (`start >= from && end <= to`). Asking "what is free between
 * now and tonight" therefore discarded today's whole 09:00–17:00 block, because
 * it began before "now" — which a client cannot distinguish from a fully booked
 * day. Clipping returns the genuinely remaining part instead.
 */
export function clipWindow(window: TimeWindow, from: Date, to: Date): TimeWindow | null {
  const start = Math.max(window.start.getTime(), from.getTime());
  const end = Math.min(window.end.getTime(), to.getTime());
  if (end <= start) return null;
  return { start: new Date(start), end: new Date(end) };
}

/**
 * Expands recurring weekly rules into concrete windows across [from, to],
 * resolving each rule's wall-clock times in its own timezone and clipping the
 * result to the query range.
 *
 * @param resolveTimezone Fallback zone for a rule that carries none (the
 *   vendor's `timezone`). Passed in rather than read here so this stays pure.
 */
export function buildTheoreticalWindows(
  rules: AvailabilityRuleLike[],
  from: Date,
  to: Date,
  resolveTimezone: string
): TimeWindow[] {
  const windows: TimeWindow[] = [];

  for (const rule of rules) {
    const timezone = rule.timezone || resolveTimezone;
    const startMinutes = parseHhMm(rule.startTime);
    // An end at or before the start means the window runs past midnight; carry
    // it into the next day rather than producing an empty window.
    const rawEnd = parseHhMm(rule.endTime);
    const endMinutes = rawEnd > startMinutes ? rawEnd : rawEnd + 24 * 60;

    for (const day of eachZonedDay(from, to, timezone)) {
      if (day.dayOfWeek !== rule.dayOfWeek) continue;

      const window: TimeWindow = {
        start: zonedWallClockToInstant(day, startMinutes, timezone),
        end: zonedWallClockToInstant(day, endMinutes, timezone),
      };

      const clipped = clipWindow(window, from, to);
      if (clipped) windows.push(clipped);
    }
  }

  return sortWindows(windows);
}

/** Sorts windows by start, then end. Returns a new array. */
export function sortWindows(windows: TimeWindow[]): TimeWindow[] {
  return [...windows].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime()
  );
}

/**
 * Merges a set of possibly-overlapping windows into the minimal set covering the
 * same time. Used to union the two busy-time sources (persisted external blocks
 * and a live calendar query) instead of choosing one of them.
 */
export function unionWindows(windows: TimeWindow[]): TimeWindow[] {
  const sorted = sortWindows(windows);
  const merged: TimeWindow[] = [];

  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start.getTime() <= last.end.getTime()) {
      if (window.end.getTime() > last.end.getTime()) last.end = new Date(window.end.getTime());
      continue;
    }
    merged.push({ start: new Date(window.start.getTime()), end: new Date(window.end.getTime()) });
  }

  return merged;
}

/**
 * Splits a window around one busy interval, padding the busy interval by the
 * configured buffers first. Returns 0, 1 or 2 remaining pieces.
 */
export function splitWindow(
  window: TimeWindow,
  busy: TimeWindow,
  bufferBeforeMinutes: number,
  bufferAfterMinutes: number
): TimeWindow[] {
  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();

  const busyStart = busy.start.getTime() - bufferBeforeMinutes * 60_000;
  const busyEnd = busy.end.getTime() + bufferAfterMinutes * 60_000;

  // No overlap once padded — the window survives whole.
  if (busyEnd <= windowStart || busyStart >= windowEnd) return [window];

  // The padded busy interval swallows the window.
  if (busyStart <= windowStart && busyEnd >= windowEnd) return [];

  const result: TimeWindow[] = [];
  if (windowStart < busyStart) {
    result.push({ start: new Date(windowStart), end: new Date(Math.min(busyStart, windowEnd)) });
  }
  if (windowEnd > busyEnd) {
    result.push({ start: new Date(Math.max(busyEnd, windowStart)), end: new Date(windowEnd) });
  }
  return result;
}

/**
 * Subtracts every busy interval from every window, applying buffers.
 */
export function subtractBusyWindows(
  windows: TimeWindow[],
  busy: TimeWindow[],
  bufferBeforeMinutes = 0,
  bufferAfterMinutes = 0
): TimeWindow[] {
  const free: TimeWindow[] = [];

  for (const window of windows) {
    let current: TimeWindow[] = [window];

    for (const busySlot of busy) {
      const next: TimeWindow[] = [];
      for (const candidate of current) {
        next.push(...splitWindow(candidate, busySlot, bufferBeforeMinutes, bufferAfterMinutes));
      }
      current = next;
      if (current.length === 0) break;
    }

    free.push(...current);
  }

  return free;
}

/**
 * Selects the booked windows that are FULL, i.e. genuinely unavailable.
 *
 * This is what makes the platform's own booking records — not Google Calendar —
 * the authority on whether a slot is taken. A single-occupancy service has
 * `seats = 1`, so any active booking fills its window. A capacity service stays
 * bookable until `count` reaches `seats`.
 */
export function fullWindows(booked: BookedWindow[], seats: number): TimeWindow[] {
  const limit = Math.max(1, seats);
  return booked
    .filter((window) => window.count >= limit)
    .map((window) => ({ start: window.start, end: window.end }));
}

/**
 * Seats still free in the booked window matching `slot` exactly, out of `seats`.
 * Exact matching is correct here: capacity seats are counted per generated slot
 * window, and a booking always originates from one.
 */
export function spotsRemainingFor(
  slot: TimeWindow,
  booked: BookedWindow[],
  seats: number
): number {
  const match = booked.find((window) => windowsEqual(window, slot));
  return Math.max(0, seats - (match?.count ?? 0));
}
