/**
 * Test: group ("capacity") service bookings — the seat model, the shared calendar
 * event, and the lock-key scoping that KI-1 got wrong.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free and Redis-free: the seat count and the mutex are injected, and the parts that
 * cannot be exercised without infrastructure are pinned by SOURCE SCAN instead — the same
 * technique `test:tracking-outbox` uses for `create([doc], { session })` and `test:system`
 * for worker schedules. A source scan is the only thing that can catch KI-1's shape, which
 * is not a wrong value but a MISSING ARGUMENT: `assertLocked(slot, owner)` and
 * `assertLocked(slot, owner, true)` both compile, both run, and address different Redis
 * keys.
 *
 * What each section pins:
 *   1. KI-1 — reschedule addresses the hold under the same key namespace lockSlot wrote it
 *   2. the shared `[x/N]` event is never deleted by one attendee cancelling
 *   3. exactly ONE definition of "is this a group service"
 *   4. the capacity mutex is always released, including when the body throws
 *   5. the checkout hold is released owner-scoped, including when the seat is refused
 *   6. seat arithmetic: a full class is refused, and a booking never rivals itself
 *
 * Run: npm run test:group-booking
 */
import fs from 'fs';
import path from 'path';
import { GroupBookingService } from '../../src/modules/booking/services/group-booking.service';
import { SlotLockService } from '../../src/modules/booking/services/slot-lock.service';
import { IBooking } from '../../src/modules/booking/models/booking.model';
import { ERROR_CODES } from '../../src/core/error-codes';

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

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
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

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * The body of one method, by brace counting from its signature.
 *
 * Deliberately not a regex over the whole file: `assertLocked(slotId, lockOwnerId)` is
 * CORRECT in `createBooking` (single occupancy, exclusive key) and WRONG in
 * `rescheduleBooking`. A scan that cannot tell the two apart would either pass on the bug
 * or fail on correct code.
 */
function methodBody(source: string, signature: string): string {
  const at = source.indexOf(signature);
  if (at === -1) throw new Error(`method not found: ${signature}`);

  // Skip the PARAMETER LIST before looking for the body. `rescheduleBooking`'s
  // `actor?: { role: 'vendor' | 'customer'; id: string }` puts a brace inside the
  // signature, and taking the first `{` after the name returns that object type as the
  // "body" — a scan that then finds no `assertLocked` call and reports the fix missing.
  const parenOpen = source.indexOf('(', at);
  if (parenOpen === -1) throw new Error(`no parameter list: ${signature}`);
  let parenDepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < source.length; i++) {
    if (source[i] === '(') parenDepth++;
    else if (source[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        parenClose = i;
        break;
      }
    }
  }
  if (parenClose === -1) throw new Error(`unbalanced parameter list: ${signature}`);

  const open = source.indexOf('{', parenClose);
  if (open === -1) throw new Error(`no body: ${signature}`);

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced body: ${signature}`);
}

/** Every `receiver.method(...)` call in `body`, as its raw argument list. */
function callArgs(body: string, call: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(call, from);
    if (at === -1) return out;

    const open = at + call.length - 1; // `call` ends with '('
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') {
        depth--;
        if (depth === 0) {
          out.push(body.slice(open + 1, i));
          from = i;
          break;
        }
      }
    }
    if (from <= at) return out;
  }
}

/** Top-level comma count + 1 — the arity of a raw argument list. */
function arity(args: string): number {
  if (args.trim() === '') return 0;
  let depth = 0;
  let n = 1;
  for (const ch of args) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) n++;
  }
  return n;
}

/** A SlotLockService stand-in that records what it was asked, and with which key scope. */
interface LockCall {
  method: string;
  slotId: string;
  ownerId: string;
  scopeToOwner: boolean;
}

function fakeLockService(opts: { mutexTokens?: (string | null)[] } = {}) {
  const calls: LockCall[] = [];
  const mutexTokens = opts.mutexTokens ?? ['token-1'];
  let mutexAttempt = 0;
  const releasedMutexes: string[] = [];

  const service = {
    async lock(slotId: string, ownerId: string, _ttl?: number, scopeToOwner = false) {
      calls.push({ method: 'lock', slotId, ownerId, scopeToOwner });
      return true;
    },
    async release(slotId: string, ownerId: string, scopeToOwner = false) {
      calls.push({ method: 'release', slotId, ownerId, scopeToOwner });
      return true;
    },
    async assertLocked(slotId: string, ownerId: string, scopeToOwner = false) {
      calls.push({ method: 'assertLocked', slotId, ownerId, scopeToOwner });
    },
    async acquireCapacityMutex(_slotId: string) {
      const token = mutexTokens[Math.min(mutexAttempt, mutexTokens.length - 1)];
      mutexAttempt++;
      return token;
    },
    async releaseCapacityMutex(slotId: string, token: string) {
      releasedMutexes.push(`${slotId}:${token}`);
    },
  };

  return {
    service: service as unknown as SlotLockService,
    calls,
    releasedMutexes,
    attempts: () => mutexAttempt,
  };
}

/** A booking document stand-in: only the fields the group path reads and writes. */
function fakeBooking(over: Partial<Record<string, unknown>> = {}) {
  const saves: number[] = [];
  return {
    _id: '64b000000000000000000001',
    productId: '64a000000000000000000001',
    vendorId: '64c000000000000000000001',
    startAt: new Date('2026-09-10T09:00:00Z'),
    endAt: new Date('2026-09-10T10:00:00Z'),
    externalCalendarEventId: 'evt_old_class',
    async save() {
      saves.push(Date.now());
      return this;
    },
    saves,
    ...over,
  } as unknown as IBooking & { saves: number[] };
}

const codeOf = (err: unknown): string | undefined =>
  (err as { code?: string; errorCode?: string })?.code ??
  (err as { errorCode?: string })?.errorCode;

async function main(): Promise<void> {
  console.log('\n=== Group (capacity) service bookings ===\n');

  // ── 1. KI-1: the reschedule path must address the hold under lockSlot's key ──────────
  console.log('1. KI-1 — reschedule uses the group service\'s lock key namespace');

  const bookingSrc = read('modules/booking/services/booking.service.ts');
  const reschedule = methodBody(bookingSrc, 'async rescheduleBooking(');

  assert('rescheduleBooking asks whether the product is a group service', () =>
    /groupBookingService\.resolveCapacity\(/.test(reschedule)
  );

  assert('assertLocked is called with a scope argument, never the 2-arg default', () => {
    const calls = callArgs(reschedule, 'slotLockService.assertLocked(');
    return calls.length === 1 && arity(calls[0]) === 3;
  });

  assert('release is called with a scope argument, never the 2-arg default', () => {
    const calls = callArgs(reschedule, 'slotLockService.release(');
    return calls.length === 1 && arity(calls[0]) === 3;
  });

  assert('both calls pass the SAME scope value — a hold read where it was written', () => {
    const asserted = callArgs(reschedule, 'slotLockService.assertLocked(')[0];
    const released = callArgs(reschedule, 'slotLockService.release(')[0];
    const scopeOf = (args: string) => args.split(',').pop()!.trim();
    return scopeOf(asserted) === scopeOf(released) && scopeOf(asserted) === 'scopeToOwner';
  });

  assert('a group move goes through moveIntoSlot, not the single-occupancy overlap check', () =>
    /groupBookingService\.moveIntoSlot\(/.test(reschedule)
  );

  assert('the single-occupancy overlap check is still there for non-group products', () =>
    /countOverlappingBookings\(/.test(reschedule) && /selfOverlaps/.test(reschedule)
  );

  // The create path is single-occupancy and MUST keep the exclusive key. Pinning this
  // stops a future "fix" from scope-creeping the wrong way and breaking calendar mode.
  assert('createBooking (single occupancy) still takes the exclusive, unscoped key', () => {
    const create = methodBody(bookingSrc, 'async createBooking(');
    const calls = callArgs(create, 'slotLockService.assertLocked(');
    return calls.length === 1 && arity(calls[0]) === 2;
  });

  // ── 2. The shared [x/N] event survives one attendee leaving ──────────────────────────
  console.log('\n2. A shared class event is never deleted by one seat');

  assert('no cancellation path calls deleteEvent directly', () => {
    for (const name of [
      'async cancelBooking(',
      'async updateBookingStatus(',
      'async cancelVendorBooking(',
    ]) {
      let body: string;
      try {
        body = methodBody(bookingSrc, name);
      } catch {
        continue; // renamed or absent — the whole-file scan below is the backstop
      }
      if (/calendarClient\.deleteEvent\(/.test(body)) return false;
    }
    return true;
  });

  assert('deleteEvent survives in exactly one place: the shared detach helper', () => {
    const helper = methodBody(bookingSrc, 'private async detachFromCalendarOnCancel(');
    const total = (bookingSrc.match(/calendarClient\.deleteEvent\(/g) ?? []).length;
    const inHelper = (helper.match(/calendarClient\.deleteEvent\(/g) ?? []).length;
    return inHelper === 1 && total === 1;
  });

  assert('the detach helper branches on group capacity before deleting anything', () => {
    const helper = methodBody(bookingSrc, 'private async detachFromCalendarOnCancel(');
    return (
      /resolveCapacity\(/.test(helper) &&
      helper.indexOf('resolveCapacity(') < helper.indexOf('deleteEvent(')
    );
  });

  assert('a group move re-renders BOTH classes rather than dragging one event', () =>
    /groupBookingService\.syncCalendarForMove\(/.test(reschedule)
  );

  // ── 3. One definition of "is this a group service" ───────────────────────────────────
  console.log('\n3. The capacity rule is defined once');

  const groupSrc = read('modules/booking/services/group-booking.service.ts');
  const productBookingSrc = read(
    'modules/catalog/domain/services/booking/ProductBookingService.ts'
  );

  // Scoped to `isCapacityProduct` on purpose. `bookingMode === 'capacity'` elsewhere in that
  // file answers a DIFFERENT question — which create path to take, and whether to annotate
  // slots with seat counts — off a variant it has already loaded. What must not be decided
  // twice is the LOCK-KEY NAMESPACE, because that is the one whose two answers must match.
  assert('isCapacityProduct no longer decides the lock-key namespace itself', () => {
    const body = methodBody(productBookingSrc, 'private async isCapacityProduct(');
    return !/bookingMode/.test(body) && !/getServiceVariant\(/.test(body);
  });

  assert('it delegates to the group service instead', () => {
    const body = methodBody(productBookingSrc, 'private async isCapacityProduct(');
    return /groupBookingService\.isGroupService\(/.test(body);
  });

  assert('the group service defines the rule exactly once', () => {
    const occurrences = (groupSrc.match(/bookingMode\s*!==\s*'capacity'/g) ?? []).length;
    return occurrences === 1;
  });

  // ── 4. The capacity mutex is always released ─────────────────────────────────────────
  console.log('\n4. The capacity mutex is always released');

  await assertAsync('withSlotMutex releases the token on success', async () => {
    const lock = fakeLockService();
    const svc = new GroupBookingService(lock.service);
    await svc.withSlotMutex('slot_1', async () => 'ok');
    return lock.releasedMutexes.length === 1 && lock.releasedMutexes[0] === 'slot_1:token-1';
  });

  await assertAsync('withSlotMutex releases the token when the body THROWS', async () => {
    const lock = fakeLockService();
    const svc = new GroupBookingService(lock.service);
    try {
      await svc.withSlotMutex('slot_1', async () => {
        throw new Error('boom');
      });
      return false;
    } catch {
      // A leaked mutex jams that slot for its whole TTL — every subsequent booking and
      // every reschedule into it fails with "slot is busy" until it expires.
      return lock.releasedMutexes.length === 1;
    }
  });

  await assertAsync('contention retries rather than failing on the first miss', async () => {
    const lock = fakeLockService({ mutexTokens: [null, null, 'token-late'] });
    const svc = new GroupBookingService(lock.service);
    const got = await svc.withSlotMutex('slot_1', async () => 'ok');
    return got === 'ok' && lock.attempts() === 3;
  });

  await assertAsync('a mutex that never frees is refused as BOOKING_SLOT_FULL', async () => {
    const lock = fakeLockService({ mutexTokens: [null] });
    const svc = new GroupBookingService(lock.service);
    try {
      await svc.withSlotMutex('slot_1', async () => 'ok');
      return false;
    } catch (err) {
      return codeOf(err) === ERROR_CODES.BOOKING_SLOT_FULL;
    }
  });

  // ── 5. The checkout hold is released owner-scoped ────────────────────────────────────
  console.log('\n5. The checkout hold is released under the owner-scoped key');

  await assertAsync('a refused seat still releases the hold, and scoped to the owner', async () => {
    const lock = fakeLockService();
    const svc = new GroupBookingService(lock.service);
    // Full class: every seat taken.
    svc.countSeatsTaken = async () => 8;

    try {
      await svc.createBooking(
        {
          slotId: 'slot_1757494800000_1757498400000_deadbeef',
          userId: '64d000000000000000000001',
          productId: '64a000000000000000000001',
          vendorId: '64c000000000000000000001',
          priceSnapshot: 5000,
        },
        8,
        '64d000000000000000000001',
        'Sunrise Yoga',
        'BK-TEST-0001'
      );
      return false;
    } catch (err) {
      const release = lock.calls.find((c) => c.method === 'release');
      // scopeToOwner MUST be true: an unscoped release deletes nothing, and the customer
      // is locked out of rebooking that class for the rest of the 15-minute TTL.
      return (
        codeOf(err) === ERROR_CODES.BOOKING_SLOT_FULL &&
        release !== undefined &&
        release.scopeToOwner === true
      );
    }
  });

  // ── 6. Seat arithmetic ───────────────────────────────────────────────────────────────
  console.log('\n6. Seat arithmetic');

  await assertAsync('moveIntoSlot refuses a full class', async () => {
    const lock = fakeLockService();
    const svc = new GroupBookingService(lock.service);
    svc.countSeatsTaken = async () => 8;
    const booking = fakeBooking();

    try {
      await svc.moveIntoSlot(
        booking,
        'slot_2',
        { start: new Date('2026-09-11T09:00:00Z'), end: new Date('2026-09-11T10:00:00Z') },
        8
      );
      return false;
    } catch (err) {
      return codeOf(err) === ERROR_CODES.BOOKING_SLOT_FULL && booking.saves.length === 0;
    }
  });

  await assertAsync('moveIntoSlot accepts a class with a seat free', async () => {
    const lock = fakeLockService();
    const svc = new GroupBookingService(lock.service);
    svc.countSeatsTaken = async () => 7;
    const booking = fakeBooking();
    const start = new Date('2026-09-11T09:00:00Z');
    const end = new Date('2026-09-11T10:00:00Z');

    await svc.moveIntoSlot(booking, 'slot_2', { start, end }, 8);
    return (
      booking.startAt.getTime() === start.getTime() &&
      booking.endAt.getTime() === end.getTime() &&
      booking.saves.length === 1
    );
  });

  await assertAsync('a move CLEARS the old class\'s shared event id', async () => {
    const lock = fakeLockService();
    const svc = new GroupBookingService(lock.service);
    svc.countSeatsTaken = async () => 0;
    const booking = fakeBooking();

    await svc.moveIntoSlot(
      booking,
      'slot_2',
      { start: new Date('2026-09-11T09:00:00Z'), end: new Date('2026-09-11T10:00:00Z') },
      8
    );
    // Keeping 'evt_old_class' here would point this booking at a class it has left; a
    // later cancel would then edit the wrong event.
    return booking.externalCalendarEventId === undefined;
  });

  await assertAsync('a booking does not count as a rival for its own seat', async () => {
    const lock = fakeLockService();
    const svc = new GroupBookingService(lock.service);
    let excluded: string | undefined;
    svc.countSeatsTaken = async (_p, _w, exclude) => {
      excluded = exclude?.toString();
      return 7;
    };
    const booking = fakeBooking();

    await svc.moveIntoSlot(
      booking,
      'slot_2',
      { start: new Date('2026-09-11T09:00:00Z'), end: new Date('2026-09-11T10:00:00Z') },
      8
    );
    // Without the exclusion, moving a booking WITHIN its own window (a no-op retry, or a
    // move onto an equal-length neighbouring slot) counts the booking against itself and
    // reports the last seat as taken.
    return excluded === booking._id.toString();
  });

  await assertAsync('spotsRemaining clamps at zero rather than going negative', async () => {
    const svc = new GroupBookingService(fakeLockService().service);
    svc.countSeatsTaken = async () => 10;
    const remaining = await svc.spotsRemaining(
      '64a000000000000000000001',
      { start: new Date('2026-09-11T09:00:00Z'), end: new Date('2026-09-11T10:00:00Z') },
      8
    );
    return remaining === 0;
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
