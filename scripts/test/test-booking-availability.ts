/**
 * Test: booking availability arithmetic — window expansion, timezone resolution,
 * busy-time subtraction and capacity seats.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free, and that is exactly the point: every availability bug found
 * in review lived in these pure helpers, which were previously private methods on
 * a class that also talks to Mongo and Google Calendar — so none of them could be
 * exercised without both. They were extracted for this reason.
 *
 * Each block below pins one defect that shipped:
 *   1. partial-day queries silently lost a whole day of availability
 *   2. wall-clock rule times resolved against the SERVER's clock, not the vendor's
 *   3. occupancy was read from Google Calendar only, so manual bookings never
 *      blocked their own slot
 *   4. `validateTimezone` returned true for literally any string
 *
 * Run: npm run test:booking-availability
 */
import {
  buildTheoreticalWindows,
  clipWindow,
  fullWindows,
  spotsRemainingFor,
  splitWindow,
  subtractBusyWindows,
  unionWindows,
  windowsOverlap,
  BookedWindow,
} from '../../src/modules/booking/utils/availability-windows.util';
import {
  eachZonedDay,
  parseHhMm,
  peakOverlapMinutes,
  zonedDayOf,
  zonedWallClockToInstant,
} from '../../src/modules/booking/utils/availability-timezone.util';
import { SlotGeneratorService } from '../../src/modules/booking/services/slot-generator.service';
import { validateTimezone } from '../../src/modules/vendors/utils/timezone.util';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const iso = (s: string): Date => new Date(s);
const w = (start: string, end: string) => ({ start: iso(start), end: iso(end) });
/** Render a window as 'ISO/ISO' so comparisons produce readable failures. */
const fmt = (x: { start: Date; end: Date }): string =>
  `${x.start.toISOString()}/${x.end.toISOString()}`;

const DOUALA = 'Africa/Douala'; // UTC+1, no DST
const NEW_YORK = 'America/New_York'; // UTC-5/-4, DST

function main(): void {
  console.log('\n── Timezone primitives ──');

  assert('parseHhMm reads minutes from midnight', () =>
    parseHhMm('00:00') === 0 && parseHhMm('09:30') === 570 && parseHhMm('23:59') === 1439);

  assert('parseHhMm rejects malformed input', () => {
    for (const bad of ['9:00', '24:00', '09:60', 'noon', '']) {
      try {
        parseHhMm(bad);
        return false;
      } catch {
        /* expected */
      }
    }
    return true;
  });

  assert('09:00 in Douala (UTC+1) is 08:00Z — NOT 09:00Z', () => {
    const at = zonedWallClockToInstant({ year: 2026, month: 8, day: 10 }, 9 * 60, DOUALA);
    return at.toISOString() === '2026-08-10T08:00:00.000Z';
  });

  assert('the same 09:00 rule resolves differently per zone', () => {
    const douala = zonedWallClockToInstant({ year: 2026, month: 8, day: 10 }, 9 * 60, DOUALA);
    const newYork = zonedWallClockToInstant({ year: 2026, month: 8, day: 10 }, 9 * 60, NEW_YORK);
    // Douala 09:00 = 08:00Z; New York 09:00 EDT = 13:00Z.
    return douala.toISOString() === '2026-08-10T08:00:00.000Z'
      && newYork.toISOString() === '2026-08-10T13:00:00.000Z';
  });

  assert('zonedDayOf reports the wall-clock day, not the UTC day', () => {
    // 23:30Z on the 9th is already the 10th in Douala (UTC+1).
    const day = zonedDayOf(iso('2026-08-09T23:30:00.000Z'), DOUALA);
    return day.year === 2026 && day.month === 8 && day.day === 10;
  });

  assert('eachZonedDay is inclusive at both ends', () => {
    // 12:00Z is 13:00 in Douala, safely inside the 12th.
    const days = eachZonedDay(iso('2026-08-10T00:00:00Z'), iso('2026-08-12T12:00:00Z'), DOUALA);
    return days.length === 3 && days[0].day === 10 && days[2].day === 12;
  });

  assert('eachZonedDay counts by WALL-CLOCK day, not UTC day', () => {
    // 23:00Z on the 12th is already 00:00 on the 13th in Douala (UTC+1), so the
    // range genuinely touches four local days. Counting UTC days would say three.
    const days = eachZonedDay(iso('2026-08-10T00:00:00Z'), iso('2026-08-12T23:00:00Z'), DOUALA);
    return days.length === 4 && days[3].day === 13;
  });

  assert('eachZonedDay crosses a DST spring-forward without skipping a day', () => {
    // US DST began 2026-03-08.
    const days = eachZonedDay(iso('2026-03-06T12:00:00Z'), iso('2026-03-10T12:00:00Z'), NEW_YORK);
    const nums = days.map((d) => d.day);
    return nums.length === 5 && nums.join(',') === '6,7,8,9,10';
  });

  assert('a DST-shifted day still resolves 09:00 local', () => {
    // 2026-03-08 is the spring-forward day; 09:00 EDT = 13:00Z (not 14:00Z).
    const at = zonedWallClockToInstant({ year: 2026, month: 3, day: 8 }, 9 * 60, NEW_YORK);
    return at.toISOString() === '2026-03-08T13:00:00.000Z';
  });

  console.log('\n── validateTimezone (was accepting anything) ──');

  assert('accepts real IANA zones', () =>
    validateTimezone(DOUALA) && validateTimezone('UTC') && validateTimezone(NEW_YORK));

  assert('REJECTS garbage — the old version returned true for all of these', () =>
    !validateTimezone('Not/AZone')
    && !validateTimezone('garbage')
    && !validateTimezone('')
    && !validateTimezone('Africa/Doualaa'));

  console.log('\n── clipWindow: the whole-day-loss bug ──');

  assert('a window fully inside the range survives unchanged', () => {
    const clipped = clipWindow(w('2026-08-10T09:00Z', '2026-08-10T17:00Z'),
      iso('2026-08-10T00:00Z'), iso('2026-08-10T23:59Z'));
    return clipped !== null && fmt(clipped) === fmt(w('2026-08-10T09:00Z', '2026-08-10T17:00Z'));
  });

  assert('a window starting BEFORE the range is clipped, not dropped', () => {
    // THE BUG: asking "what is free from 13:00 today?" used to discard the whole
    // 09:00-17:00 block because it began before 13:00 — the client saw an empty
    // day, indistinguishable from fully booked.
    const clipped = clipWindow(w('2026-08-10T09:00Z', '2026-08-10T17:00Z'),
      iso('2026-08-10T13:00Z'), iso('2026-08-10T23:59Z'));
    return clipped !== null && fmt(clipped) === fmt(w('2026-08-10T13:00Z', '2026-08-10T17:00Z'));
  });

  assert('a window ending after the range is clipped at the range end', () => {
    const clipped = clipWindow(w('2026-08-10T09:00Z', '2026-08-10T17:00Z'),
      iso('2026-08-10T00:00Z'), iso('2026-08-10T12:00Z'));
    return clipped !== null && fmt(clipped) === fmt(w('2026-08-10T09:00Z', '2026-08-10T12:00Z'));
  });

  assert('a window entirely outside the range returns null', () =>
    clipWindow(w('2026-08-11T09:00Z', '2026-08-11T17:00Z'),
      iso('2026-08-10T00:00Z'), iso('2026-08-10T23:00Z')) === null);

  assert('a zero-length overlap returns null, not an empty window', () =>
    clipWindow(w('2026-08-10T09:00Z', '2026-08-10T17:00Z'),
      iso('2026-08-10T17:00Z'), iso('2026-08-10T20:00Z')) === null);

  console.log('\n── buildTheoreticalWindows ──');

  // Monday 2026-08-10. dayOfWeek 1 = Monday.
  const mondayRule = { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' };

  assert('a weekly rule expands only onto its own weekday', () => {
    const windows = buildTheoreticalWindows(
      [mondayRule],
      iso('2026-08-09T00:00:00Z'), // Sunday
      iso('2026-08-16T00:00:00Z'), // next Sunday
      DOUALA
    );
    return windows.length === 1 && fmt(windows[0]) === fmt(w('2026-08-10T08:00Z', '2026-08-10T16:00Z'));
  });

  assert('rule hours land in the VENDOR timezone, not the server one', () => {
    const windows = buildTheoreticalWindows(
      [mondayRule], iso('2026-08-10T00:00:00Z'), iso('2026-08-11T00:00:00Z'), DOUALA
    );
    // 09:00-17:00 Douala == 08:00-16:00 UTC, regardless of where this test runs.
    return windows.length === 1
      && windows[0].start.toISOString() === '2026-08-10T08:00:00.000Z'
      && windows[0].end.toISOString() === '2026-08-10T16:00:00.000Z';
  });

  assert('a per-rule timezone overrides the vendor fallback', () => {
    const windows = buildTheoreticalWindows(
      [{ ...mondayRule, timezone: NEW_YORK }],
      iso('2026-08-10T00:00:00Z'), iso('2026-08-11T12:00:00Z'), DOUALA
    );
    return windows.length === 1 && windows[0].start.toISOString() === '2026-08-10T13:00:00.000Z';
  });

  assert('a mid-day range keeps the remainder of today', () => {
    const windows = buildTheoreticalWindows(
      [mondayRule],
      iso('2026-08-10T12:00:00Z'), // 13:00 Douala, mid-shift
      iso('2026-08-10T23:00:00Z'),
      DOUALA
    );
    return windows.length === 1 && fmt(windows[0]) === fmt(w('2026-08-10T12:00Z', '2026-08-10T16:00Z'));
  });

  assert('an overnight rule (22:00-02:00) rolls into the next day', () => {
    const windows = buildTheoreticalWindows(
      [{ dayOfWeek: 1, startTime: '22:00', endTime: '02:00' }],
      iso('2026-08-10T00:00:00Z'), iso('2026-08-12T00:00:00Z'), DOUALA
    );
    return windows.length === 1 && fmt(windows[0]) === fmt(w('2026-08-10T21:00Z', '2026-08-11T01:00Z'));
  });

  assert('no rules for the queried days yields no windows', () =>
    buildTheoreticalWindows([mondayRule], iso('2026-08-11T00:00Z'), iso('2026-08-12T00:00Z'), DOUALA)
      .length === 0);

  console.log('\n── Busy-time subtraction and buffers ──');

  assert('a busy block in the middle splits the window in two', () => {
    const free = subtractBusyWindows(
      [w('2026-08-10T08:00Z', '2026-08-10T16:00Z')],
      [w('2026-08-10T11:00Z', '2026-08-10T12:00Z')]
    );
    return free.length === 2
      && fmt(free[0]) === fmt(w('2026-08-10T08:00Z', '2026-08-10T11:00Z'))
      && fmt(free[1]) === fmt(w('2026-08-10T12:00Z', '2026-08-10T16:00Z'));
  });

  assert('buffers widen the busy block on both sides', () => {
    const free = subtractBusyWindows(
      [w('2026-08-10T08:00Z', '2026-08-10T16:00Z')],
      [w('2026-08-10T11:00Z', '2026-08-10T12:00Z')],
      30, // before
      15  // after
    );
    return free.length === 2
      && fmt(free[0]) === fmt(w('2026-08-10T08:00Z', '2026-08-10T10:30Z'))
      && fmt(free[1]) === fmt(w('2026-08-10T12:15Z', '2026-08-10T16:00Z'));
  });

  assert('a busy block covering the window leaves nothing', () =>
    subtractBusyWindows(
      [w('2026-08-10T08:00Z', '2026-08-10T16:00Z')],
      [w('2026-08-10T07:00Z', '2026-08-10T17:00Z')]
    ).length === 0);

  assert('a non-overlapping busy block leaves the window whole', () => {
    const free = subtractBusyWindows(
      [w('2026-08-10T08:00Z', '2026-08-10T16:00Z')],
      [w('2026-08-10T18:00Z', '2026-08-10T19:00Z')]
    );
    return free.length === 1 && fmt(free[0]) === fmt(w('2026-08-10T08:00Z', '2026-08-10T16:00Z'));
  });

  assert('subtracting the SAME interval twice is idempotent (union safety)', () => {
    // This is what lets availability union cached blocks with a live query rather
    // than choosing one of them.
    const once = subtractBusyWindows(
      [w('2026-08-10T08:00Z', '2026-08-10T16:00Z')],
      [w('2026-08-10T11:00Z', '2026-08-10T12:00Z')]
    );
    const twice = subtractBusyWindows(
      [w('2026-08-10T08:00Z', '2026-08-10T16:00Z')],
      [w('2026-08-10T11:00Z', '2026-08-10T12:00Z'), w('2026-08-10T11:00Z', '2026-08-10T12:00Z')]
    );
    return once.map(fmt).join('|') === twice.map(fmt).join('|');
  });

  assert('splitWindow returns one piece when the busy block hangs off an edge', () => {
    const pieces = splitWindow(
      w('2026-08-10T08:00Z', '2026-08-10T16:00Z'),
      w('2026-08-10T07:00Z', '2026-08-10T09:00Z'), 0, 0
    );
    return pieces.length === 1 && fmt(pieces[0]) === fmt(w('2026-08-10T09:00Z', '2026-08-10T16:00Z'));
  });

  console.log('\n── unionWindows ──');

  assert('overlapping windows merge', () => {
    const merged = unionWindows([
      w('2026-08-10T09:00Z', '2026-08-10T11:00Z'),
      w('2026-08-10T10:00Z', '2026-08-10T12:00Z'),
    ]);
    return merged.length === 1 && fmt(merged[0]) === fmt(w('2026-08-10T09:00Z', '2026-08-10T12:00Z'));
  });

  assert('touching windows merge', () => {
    const merged = unionWindows([
      w('2026-08-10T09:00Z', '2026-08-10T10:00Z'),
      w('2026-08-10T10:00Z', '2026-08-10T11:00Z'),
    ]);
    return merged.length === 1 && fmt(merged[0]) === fmt(w('2026-08-10T09:00Z', '2026-08-10T11:00Z'));
  });

  assert('disjoint windows stay separate and sorted', () => {
    const merged = unionWindows([
      w('2026-08-10T14:00Z', '2026-08-10T15:00Z'),
      w('2026-08-10T09:00Z', '2026-08-10T10:00Z'),
    ]);
    return merged.length === 2 && merged[0].start.toISOString() === '2026-08-10T09:00:00.000Z';
  });

  assert('a window nested inside another is absorbed', () => {
    const merged = unionWindows([
      w('2026-08-10T09:00Z', '2026-08-10T17:00Z'),
      w('2026-08-10T11:00Z', '2026-08-10T12:00Z'),
    ]);
    return merged.length === 1 && fmt(merged[0]) === fmt(w('2026-08-10T09:00Z', '2026-08-10T17:00Z'));
  });

  console.log('\n── Occupancy: seats, and the manual-mode double-booking bug ──');

  const booked: BookedWindow[] = [
    { ...w('2026-08-10T09:00Z', '2026-08-10T10:00Z'), count: 1 },
    { ...w('2026-08-10T10:00Z', '2026-08-10T11:00Z'), count: 3 },
  ];

  assert('single-occupancy: ONE booking fills its window', () => {
    // THE BUG: a `manual` booking writes no calendar event until the vendor
    // approves it, and occupancy was read from the calendar alone — so the same
    // hour could be sold to unlimited customers. One booking must block one slot.
    const full = fullWindows(booked, 1);
    return full.length === 2;
  });

  assert('capacity: a partially-filled window stays bookable', () => {
    const full = fullWindows(booked, 5);
    // 1/5 and 3/5 — neither is full.
    return full.length === 0;
  });

  assert('capacity: a window at the seat limit is full', () => {
    const full = fullWindows(booked, 3);
    return full.length === 1 && fmt(full[0]) === fmt(w('2026-08-10T10:00Z', '2026-08-10T11:00Z'));
  });

  assert('capacity: over-filled counts still register as full', () =>
    fullWindows([{ ...w('2026-08-10T10:00Z', '2026-08-10T11:00Z'), count: 9 }], 3).length === 1);

  assert('seats below 1 are floored to 1 rather than blocking nothing', () =>
    fullWindows(booked, 0).length === 2);

  assert('spotsRemainingFor counts down against the exact window', () =>
    spotsRemainingFor(w('2026-08-10T10:00Z', '2026-08-10T11:00Z'), booked, 5) === 2
    && spotsRemainingFor(w('2026-08-10T09:00Z', '2026-08-10T10:00Z'), booked, 5) === 4);

  assert('an unbooked window reports every seat free', () =>
    spotsRemainingFor(w('2026-08-10T14:00Z', '2026-08-10T15:00Z'), booked, 5) === 5);

  assert('spotsRemainingFor never goes negative', () =>
    spotsRemainingFor(w('2026-08-10T10:00Z', '2026-08-10T11:00Z'), booked, 2) === 0);

  console.log('\n── windowsOverlap (the query predicate) ──');

  assert('partial overlap counts', () =>
    windowsOverlap(w('2026-08-10T09:00Z', '2026-08-10T11:00Z'),
      w('2026-08-10T10:00Z', '2026-08-10T12:00Z')));

  assert('touching intervals do NOT overlap (half-open)', () =>
    !windowsOverlap(w('2026-08-10T09:00Z', '2026-08-10T10:00Z'),
      w('2026-08-10T10:00Z', '2026-08-10T11:00Z')));

  assert('containment counts as overlap', () =>
    windowsOverlap(w('2026-08-10T09:00Z', '2026-08-10T17:00Z'),
      w('2026-08-10T11:00Z', '2026-08-10T12:00Z')));

  console.log('\n── Slot generation ──');

  const slotGen = new SlotGeneratorService();

  assert('an 8h window yields 8 one-hour slots, back to back', () => {
    const slots = slotGen.generateSlots([w('2026-08-10T08:00Z', '2026-08-10T16:00Z')], 60);
    return slots.length === 8
      && slots[0].start.toISOString() === '2026-08-10T08:00:00.000Z'
      && slots[7].end.toISOString() === '2026-08-10T16:00:00.000Z';
  });

  assert('a trailing remainder shorter than the duration is dropped', () => {
    // 90 minutes cannot hold a second 60-minute slot.
    const slots = slotGen.generateSlots([w('2026-08-10T08:00Z', '2026-08-10T09:30Z')], 60);
    return slots.length === 1;
  });

  assert('a window shorter than one slot yields none', () =>
    slotGen.generateSlots([w('2026-08-10T08:00Z', '2026-08-10T08:30Z')], 60).length === 0);

  assert('slot ids round-trip through parseSlotId', () => {
    const [slot] = slotGen.generateSlots([w('2026-08-10T08:00Z', '2026-08-10T09:00Z')], 60);
    const parsed = slotGen.parseSlotId(slot.id);
    return parsed.start.getTime() === slot.start.getTime()
      && parsed.end.getTime() === slot.end.getTime();
  });

  assert('slot ids are deterministic for the same interval', () => {
    const a = slotGen.generateSlots([w('2026-08-10T08:00Z', '2026-08-10T09:00Z')], 60)[0];
    const b = slotGen.generateSlots([w('2026-08-10T08:00Z', '2026-08-10T09:00Z')], 60)[0];
    return a.id === b.id;
  });

  assert('parseSlotId rejects a malformed id', () => {
    for (const bad of ['nonsense', 'slot_abc_def_x', 'slot_123']) {
      try {
        slotGen.parseSlotId(bad);
        return false;
      } catch {
        /* expected */
      }
    }
    return true;
  });

  console.log('\n── Peak-hours surcharge window ──');

  const peak = { daysOfWeek: [1], startTime: '17:00', endTime: '20:00' };

  assert('peak minutes are counted in the vendor timezone', () => {
    // Monday 16:00-19:00 UTC == 17:00-20:00 Douala → entirely peak.
    const minutes = peakOverlapMinutes(
      iso('2026-08-10T16:00:00Z'), iso('2026-08-10T19:00:00Z'), peak, DOUALA
    );
    return minutes === 180;
  });

  assert('the same interval is NOT peak in a different zone', () => {
    // 16:00-19:00 UTC is 12:00-15:00 in New York — outside 17:00-20:00.
    const minutes = peakOverlapMinutes(
      iso('2026-08-10T16:00:00Z'), iso('2026-08-10T19:00:00Z'), peak, NEW_YORK
    );
    return minutes === 0;
  });

  assert('only the overlapping portion is charged', () => {
    // 15:00-18:00 UTC == 16:00-19:00 Douala → 2 of 3 hours are peak.
    const minutes = peakOverlapMinutes(
      iso('2026-08-10T15:00:00Z'), iso('2026-08-10T18:00:00Z'), peak, DOUALA
    );
    return minutes === 120;
  });

  assert('a non-selected weekday contributes nothing', () => {
    // 2026-08-11 is a Tuesday; the peak window is Monday-only.
    const minutes = peakOverlapMinutes(
      iso('2026-08-11T16:00:00Z'), iso('2026-08-11T19:00:00Z'), peak, DOUALA
    );
    return minutes === 0;
  });

  assert('an empty daysOfWeek means every day', () => {
    const minutes = peakOverlapMinutes(
      iso('2026-08-11T16:00:00Z'),
      iso('2026-08-11T19:00:00Z'),
      { ...peak, daysOfWeek: [] },
      DOUALA
    );
    return minutes === 180;
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
