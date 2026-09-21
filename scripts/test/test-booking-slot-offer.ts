/**
 * Test: a booking can only be made, held or moved onto a slot the service really offers.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free and Redis-free: `ProductBookingService` is constructed with its real slot generator,
 * its real price resolver and a stand-in availability service built from the REAL window
 * helpers (`buildTheoreticalWindows`, `subtractBusyWindows`) — so the clipping that caused the
 * anchoring defect is the real clipping, not an imitation of it.
 *
 * ── ⛔ WHAT WAS WRONG, found 2026-09-16 ──────────────────────────────────────
 * A slot id is `slot_<startMs>_<endMs>` and is supplied by the caller. Every booking path checked
 * its FORMAT and nothing else, and the booking price is prorated from the interval. So any
 * signed-in customer could book a one-hour service as a one-minute slot and pay a sixtieth, book
 * at 3am or on a closed day or in the past, block a shop's whole day with one long slot, or move
 * an appointment onto any of those. The storefront's lock-then-book route, the bot's create and
 * reschedule, and the customer reschedule route all reached it.
 *
 * ── ⚠ AND WHY THE FIX HAD TO CHANGE AVAILABILITY FIRST ───────────────────────
 * "Only a slot the service offers" had no answer, because availability clipped every rule window
 * to the caller's `from` and laid slots out from the clipped start: asked at 09:37:12, a 09:00–17:00
 * service offered 09:37:12–10:37:12. The offered set depended on the clock of the person asking.
 * § 2 pins that it no longer does, and § 3 onwards could not be written without § 2.
 *
 * Run: npx ts-node scripts/test/test-booking-slot-offer.ts
 *      (npm binding requested from the switchboard: test:booking-slot-offer)
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { AppError } from '../../src/core/errors';
import { ProductBookingService, AVAILABILITY_LOOKBEHIND_MS } from '../../src/modules/catalog/domain/services/booking/ProductBookingService';
import { BookingPriceResolver } from '../../src/modules/catalog/domain/services/booking/BookingPriceResolver';
import { SlotGeneratorService } from '../../src/modules/booking/services/slot-generator.service';
import {
    AvailabilityRuleLike,
    BookedWindow,
    buildTheoreticalWindows,
    subtractBusyWindows,
    unionWindows,
} from '../../src/modules/booking/utils/availability-windows.util';
import { TimeWindow, BookingStatus } from '../../src/modules/booking/types/booking.types';
import { BookingService } from '../../src/modules/booking/services/booking.service';
import { referencedIdOf } from '../../src/modules/bot-surface/controllers/bot-booking.controller';
import * as redisFactory from '../../src/infra/redis/redis.factory';
import { SlotLockFacade } from '../../src/modules/catalog/domain/services/booking/SlotLockFacade';
import { productBookingService } from '../../src/modules/catalog/domain/services/booking/product-booking.instance';
import { productBookingRouter } from '../../src/modules/catalog/routes/product-booking.routes';
import vendorBookingRouter from '../../src/modules/booking/routes/vendor-booking.routes';
import { VendorBookingController } from '../../src/modules/booking/controllers/vendor-booking.controller';
import { Booking } from '../../src/modules/booking/models/booking.model';
import { ProductModel } from '../../src/modules/catalog/models';
import { UserModel } from '../../src/modules/users/user.model';

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
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

/** True when `run` rejects with this code and status (and reason, when given). */
async function refused(
    run: () => Promise<unknown>,
    code: string,
    status: number,
    reason?: string,
): Promise<boolean> {
    try {
        await run();
        return false;
    } catch (err) {
        if (!(err instanceof AppError)) return false;
        return err.code === code
            && err.statusCode === status
            && (reason === undefined || err.details?.reason === reason);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The world: one shop in Douala, Mondays 09:00–17:00, a one-hour service at 6 000 XAF
// ─────────────────────────────────────────────────────────────────────────────

const TZ = 'Africa/Douala'; // UTC+1, no daylight saving — so the arithmetic below is exact
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** 2030-01-07 is a Monday. `at(9)` is 09:00 in Douala, which is 08:00Z. */
const MONDAY = Date.UTC(2030, 0, 7);
const at = (hours: number, minutes = 0, seconds = 0, ms = 0): Date =>
    new Date(MONDAY + (hours - 1) * HOUR + minutes * MIN + seconds * 1000 + ms);
const slotId = (start: Date, end: Date): string => `slot_${start.getTime()}_${end.getTime()}_x`;

/** A clock set well before the Monday, for every test that is not about the past. */
const LAST_YEAR = new Date(Date.UTC(2029, 0, 1));

const RULES: AvailabilityRuleLike[] = [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00', timezone: TZ }];

interface World {
    service: ProductBookingService;
    bookings: BookedWindow[];
    priceCalls: number;
    created: Array<{ start: Date; end: Date; priceSnapshot: number }>;
    heldSlots: string[];
    mode: 'calendar' | 'capacity';
    seats: number;
    bufferAfter: number;
}

/**
 * @param overrides.realLocks Hold slots through the REAL `SlotLockFacade` → `SlotLockService`
 *   (on § 10's in-memory Redis) instead of the recording stand-in, so the key a hold is written
 *   under is the production key.
 */
function world(overrides: Partial<Pick<World, 'mode' | 'seats' | 'bufferAfter'>> & { realLocks?: boolean } = {}): World {
    const w: World = {
        service: null as unknown as ProductBookingService,
        bookings: [],
        priceCalls: 0,
        created: [],
        heldSlots: [],
        mode: overrides.mode ?? 'calendar',
        seats: overrides.seats ?? 1,
        bufferAfter: overrides.bufferAfter ?? 0,
    };

    const product = {
        id: 'p1', type: 'service', status: 'active', vendorId: 'v1', deletedAt: null, suspension: null,
    };
    const variant = {
        id: 'var1', productId: 'p1', status: 'active', optionSignature: 'default', price: 6000,
        serviceConfig: {
            durationMinutes: 60,
            bookingMode: w.mode,
            maxBookings: w.seats,
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: w.bufferAfter,
        },
    };
    const variantRepository = { findByProduct: async () => [variant] };

    /**
     * ⚠ **The availability stand-in reproduces the real service's arithmetic with the real
     * helpers**, calendar aside. `buildTheoreticalWindows` clips to [from, to] exactly as
     * production does — which is the whole point: § 2 fails against the OLD computation because
     * this clipping is real, not because the fake was written to make it fail.
     */
    const availabilityService = {
        getAvailability: async (
            _productId: string, _vendorId: string, from: Date, to: Date,
            options: { fullBookedWindows?: TimeWindow[]; bufferBeforeMinutes?: number; bufferAfterMinutes?: number },
        ): Promise<TimeWindow[]> => {
            const theoretical = buildTheoreticalWindows(RULES, from, to, TZ);
            const busy = unionWindows([...(options.fullBookedWindows ?? [])]);
            return subtractBusyWindows(theoretical, busy, options.bufferBeforeMinutes ?? 0, options.bufferAfterMinutes ?? 0);
        },
    };

    const bookingService = {
        findActiveBookingWindows: async (_p: string, from: Date, to: Date) =>
            w.bookings.filter((b) => b.start.getTime() < to.getTime() && b.end.getTime() > from.getTime()),
        createBooking: async (input: { slotId: string; priceSnapshot: number }) => {
            const [, s, e] = input.slotId.split('_');
            w.created.push({ start: new Date(Number(s)), end: new Date(Number(e)), priceSnapshot: input.priceSnapshot });
            return { _id: 'b-new' };
        },
        createCapacityBooking: async (input: { slotId: string; priceSnapshot: number }) => {
            const [, s, e] = input.slotId.split('_');
            w.created.push({ start: new Date(Number(s)), end: new Date(Number(e)), priceSnapshot: input.priceSnapshot });
            return { _id: 'b-new' };
        },
    };

    const realResolver = new BookingPriceResolver(variantRepository as never);
    const priceResolver = {
        resolvePrice: async (...args: Parameters<BookingPriceResolver['resolvePrice']>) => {
            w.priceCalls++;
            return realResolver.resolvePrice(...args);
        },
    };

    w.service = new ProductBookingService(
        { findByIdUnscoped: async () => product } as never,
        availabilityService as never,
        new SlotGeneratorService(),
        bookingService as never,
        priceResolver as never,
        variantRepository as never,
        overrides.realLocks
            ? new SlotLockFacade()
            : {
                lockSlot: async (id: string) => { w.heldSlots.push(id); return true; },
                releaseSlot: async () => true,
            } as never,
        { isGroupService: async () => w.mode === 'capacity' } as never,
    );
    return w;
}

/** A `now`-injectable call: the production signature defaults to the real clock. */
const offered = (w: World, start: Date, end: Date, now: Date = LAST_YEAR) =>
    w.service.assertOfferedSlot('p1', slotId(start, end), now);

/** Comments stripped, so a scan can neither be satisfied nor tripped by an explanation. */
const codeOf = (file: string): string =>
    fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');

/**
 * The body of one method, from its signature to the next member at the same indent.
 *
 * ⚠ **Modifiers are matched as a SEQUENCE.** The first version allowed one — and
 * `private async assertRescheduleTarget(` has two, so the body of `rescheduleBooking` ran on into
 * the next method and a "never re-parses the slot" scan read the shop branch's legitimate parse
 * as the offence. A boundary that silently fails widens every scan built on it.
 */
function methodBody(source: string, signature: RegExp): string | null {
    const m = source.match(signature);
    if (!m || m.index === undefined) return null;
    const rest = source.slice(m.index);
    const next = rest
        .slice(1)
        .search(/\n {2}(?:(?:async|private|protected|public|static|readonly)\s+)*[a-zA-Z]+\s*(?:=|\()/);
    return next === -1 ? rest : rest.slice(0, next + 1);
}

async function main(): Promise<void> {
    console.log('\n══ § 1 · In scope — nothing below may pass by having stopped checking ══');

    const PBS = codeOf('modules/catalog/domain/services/booking/ProductBookingService.ts');
    const BS = codeOf('modules/booking/services/booking.service.ts');
    const bookBody = methodBody(PBS, /async bookProduct\(/);
    const lockBody = methodBody(PBS, /async lockSlot\(/);
    const rescheduleBody = methodBody(BS, /async rescheduleBooking\(/);

    /**
     * ⚠ Each body must hold what it should AND stop where it should: a body that ran on into the
     * next method would satisfy "contains X" scans with somebody else's code.
     */
    await assert('the three chokepoints are found in source, each cut at its own end', () =>
        Boolean(bookBody && lockBody && rescheduleBody)
        && bookBody!.includes('createBooking') && !bookBody!.includes('async lockSlot(')
        && lockBody!.includes('slotLockFacade.lockSlot') && !lockBody!.includes('async unlockSlot(')
        && rescheduleBody!.includes('assertLocked') && !rescheduleBody!.includes('assertRescheduleTarget(\n')
        && !rescheduleBody!.includes('private async assertRescheduleTarget('));

    await assert('the service under test really is the production class', () =>
        typeof world().service.assertOfferedSlot === 'function'
        && AVAILABILITY_LOOKBEHIND_MS >= 48 * HOUR);

    console.log('\n══ § 2 · Offered slots no longer depend on the clock of whoever asks ══');

    /**
     * ⚠ **Proves the stand-in reproduces the defect before proving the fix.** Computing over
     * exactly [from, to] — what production did — anchors the first slot at 09:37:12.345. If this
     * assertion ever stops holding, the stand-in has drifted from the real clipping and § 2's
     * other assertions prove nothing.
     */
    await assert('the OLD computation over exactly [from, to] anchored at the caller\'s instant', async () => {
        const from = at(9, 37, 12, 345);
        const to = at(17);
        const windows = buildTheoreticalWindows(RULES, from, to, TZ);
        const slots = new SlotGeneratorService().generateSlots(windows, 60);
        return slots.length > 0 && slots[0].start.getTime() === from.getTime();
    });

    await assert('asked mid-window, the shop\'s own grid is offered: 10:00, 11:00 … 16:00', async () => {
        const slots = await world().service.getAvailability('p1', at(9, 37, 12, 345), at(17));
        return slots.length === 7
            && slots[0].start.getTime() === at(10).getTime()
            && slots.every((s) => (s.start.getTime() - at(9).getTime()) % HOUR === 0);
    });

    await assert('asking a few minutes apart offers exactly the same slots', async () => {
        const w = world();
        const a = await w.service.getAvailability('p1', at(9, 5), at(17));
        const b = await w.service.getAvailability('p1', at(9, 55), at(17));
        return JSON.stringify(a.map((s) => s.id)) === JSON.stringify(b.map((s) => s.id));
    });

    await assert('an appointment ending before `from` still anchors the slot after it', async () => {
        const w = world({ bufferAfter: 15 });
        w.bookings.push({ start: at(9), end: at(10), count: 1 });
        const slots = await w.service.getAvailability('p1', at(10, 30), at(17));
        // Busy 09:00–10:00 plus a 15-minute buffer → the next window opens at 10:15.
        return slots.length > 0 && slots[0].start.getTime() === at(11, 15).getTime();
    });

    console.log('\n══ § 3 · A real slot is accepted, and books exactly as before ══');

    await assert('a real generated slot is offered', async () => {
        const { start, end } = await offered(world(), at(10), at(11));
        return start.getTime() === at(10).getTime() && end.getTime() === at(11).getTime();
    });

    /**
     * ⚠ **Existing price behaviour must not change for a legitimate slot.** The real resolver
     * prorates `6000 / 60 min × 60 min` = 6 000, exactly what it charged before the check existed.
     * Peak surcharges and `CompletionPricingService`'s repricing from the ACTUAL elapsed interval
     * at completion are untouched by this change — neither reads a caller's slot id.
     */
    await assert('a real slot books at exactly the price it did before: 6 000 XAF', async () => {
        const w = world();
        await w.service.bookProduct('p1', slotId(at(10), at(11)), 'u1', 'u1');
        return w.created.length === 1
            && w.created[0].priceSnapshot === 6000
            && w.created[0].start.getTime() === at(10).getTime();
    });

    console.log('\n══ § 4 · ⛔ Every fabricated slot is refused, each by name ══');

    const UNAVAILABLE = 'BOOKING_SLOT_UNAVAILABLE';

    await assert('⛔ a ONE-MINUTE slot — the price-fraction attack', () =>
        refused(() => offered(world(), at(10), at(10, 1)), UNAVAILABLE, 409, 'not_offered'));

    await assert('⛔ an INVERTED slot', () =>
        refused(() => offered(world(), at(11), at(10)), UNAVAILABLE, 409, 'inverted'));

    await assert('⛔ a slot OUTSIDE opening hours — 03:00', () =>
        refused(() => offered(world(), at(3), at(4)), UNAVAILABLE, 409, 'not_offered'));

    await assert('⛔ a slot in the PAST', () =>
        refused(() => offered(world(), at(10), at(11), at(12)), UNAVAILABLE, 409, 'not_future'));

    await assert('⛔ a WHOLE-DAY slot — the day-blocking attack', () =>
        refused(() => offered(world(), at(9), at(17)), UNAVAILABLE, 409, 'not_offered'));

    await assert('⛔ a real slot SHIFTED BY ONE MINUTE', () =>
        refused(() => offered(world(), at(10, 1), at(11, 1)), UNAVAILABLE, 409, 'not_offered'));

    await assert('⛔ a slot already taken by another booking', async () => {
        const w = world();
        w.bookings.push({ start: at(10), end: at(11), count: 1 });
        return refused(() => offered(w, at(10), at(11)), UNAVAILABLE, 409, 'not_offered');
    });

    await assert('a malformed id is still the parser\'s own 400, not a 409', () =>
        refused(() => world().service.assertOfferedSlot('p1', 'slot_banana_x', LAST_YEAR), 'BOOKING_INVALID_SLOT_ID', 400));

    console.log('\n══ § 5 · ⛔ Nothing is priced, booked or held before the check ══');

    await assert('⛔ a one-minute booking is refused before ANY price is computed, and nothing is written', async () => {
        const w = world();
        const wasRefused = await refused(
            () => w.service.bookProduct('p1', slotId(at(10), at(10, 1)), 'u1', 'u1'),
            UNAVAILABLE, 409,
        );
        return wasRefused && w.priceCalls === 0 && w.created.length === 0;
    });

    /**
     * ⚠ The behavioural test above proves today's order; this pins it against a refactor that
     * moves the price up. In-scope first: both calls must be present in the body, or the ordering
     * comparison would pass on an index of -1.
     */
    await assert('⛔ in `bookProduct`, the check comes before the price in source', () => {
        const check = bookBody!.indexOf('assertOfferedSlot(');
        const price = bookBody!.indexOf('resolvePrice(');
        return check !== -1 && price !== -1 && check < price && !bookBody!.includes('parseSlotId(');
    });

    await assert('⛔ a fabricated slot cannot even be HELD', async () => {
        const w = world();
        const wasRefused = await refused(
            () => w.service.lockSlot('p1', slotId(at(9), at(17)), 'u1'),
            UNAVAILABLE, 409,
        );
        return wasRefused && w.heldSlots.length === 0;
    });

    await assert('⛔ in `lockSlot`, the check comes before the hold in source', () => {
        const check = lockBody!.indexOf('assertOfferedSlot(');
        const hold = lockBody!.indexOf('slotLockFacade.lockSlot(');
        return check !== -1 && hold !== -1 && check < hold;
    });

    console.log('\n══ § 6 · Group classes: a full class is refused, a class with room is not ══');

    await assert('a class with a seat left is offered', async () => {
        const w = world({ mode: 'capacity', seats: 3 });
        w.bookings.push({ start: at(10), end: at(11), count: 2 });
        const { start } = await offered(w, at(10), at(11));
        return start.getTime() === at(10).getTime();
    });

    await assert('⛔ a FULL class is refused', async () => {
        const w = world({ mode: 'capacity', seats: 3 });
        w.bookings.push({ start: at(10), end: at(11), count: 3 });
        return refused(() => offered(w, at(10), at(11)), UNAVAILABLE, 409, 'not_offered');
    });

    console.log('\n══ § 7 · Moving a booking: customers by availability, shops by length ══');

    /**
     * ⚠ **The customer branch is pinned by source, the shop branch by behaviour.** Running the
     * customer branch would lazily load the production booking service and read a real database;
     * the shop branch reads nothing, so it is exercised for real.
     */
    await assert('⛔ `rescheduleBooking` validates the target before the hold, and never re-parses it', () => {
        const check = rescheduleBody!.indexOf('assertRescheduleTarget(');
        const hold = rescheduleBody!.indexOf('assertLocked(');
        return check !== -1 && hold !== -1 && check < hold && !rescheduleBody!.includes('parseSlotId(');
    });

    await assert('⛔ only an explicit SHOP actor gets the looser rule; everyone else is checked against availability', () => {
        const body = methodBody(BS, /private async assertRescheduleTarget\(/);
        if (!body) return false;
        return body.includes("actor?.role === 'vendor'")
            && body.includes('productBookingService.assertOfferedSlot(')
            && !body.includes("role === 'customer'");
    });

    const moving = { startAt: at(10), endAt: at(11) };
    const vendorTarget = (start: Date, end: Date) =>
        (new BookingService() as unknown as {
            assertRescheduleTarget: (b: unknown, s: string, a: unknown) => Promise<{ start: Date; end: Date }>;
        }).assertRescheduleTarget(moving, slotId(start, end), { role: 'vendor', id: 'v1' });

    await assert('a shop may move an appointment OUTSIDE published hours at the same length — 19:00', async () => {
        const { start, end } = await vendorTarget(at(19), at(20));
        return start.getTime() === at(19).getTime() && end.getTime() === at(20).getTime();
    });

    await assert('⛔ a shop may NOT change the length — the price was fixed on the original', () =>
        refused(() => vendorTarget(at(19), at(21)), 'BOOKING_INVALID_SLOT_ID', 400, 'length_changed'));

    await assert('⛔ a shop may NOT send an inverted interval', () =>
        refused(() => vendorTarget(at(20), at(19)), 'BOOKING_INVALID_SLOT_ID', 400, 'inverted'));

    console.log('\n══ § 8 · ⛔ No door reaches a booking write around the chokepoints ══');

    /**
     * ⚠ **`createBooking`, `createCapacityBooking` and the group path's own `parseSlotId` are not
     * validated themselves**: they are reached only through `bookProduct`, which is. Checking the
     * same slot three times over would be three availability reads and three calendar calls for
     * one booking. What must hold instead is that NOTHING else calls them — so a new route that
     * does is a failure here, not a quiet reopening of the hole.
     *
     * `src/scripts/` is excluded: those are hand-run development scripts, not doors.
     */
    function productionCallers(pattern: RegExp): string[] {
        const out: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (full.endsWith(`${path.sep}scripts`)) continue;
                    walk(full);
                } else if (entry.name.endsWith('.ts')) {
                    const code = fs.readFileSync(full, 'utf8')
                        .replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/^\s*\/\/[^\n]*$/gm, '');
                    if (pattern.test(code)) out.push(path.relative(path.join(__dirname, '../../src'), full));
                }
            }
        };
        walk(path.join(__dirname, '../../src'));
        return out.map((p) => p.split(path.sep).join('/')).sort();
    }

    await assert('⛔ the single-occupancy and group writes are called from `bookProduct` alone', () => {
        const callers = productionCallers(/\.createBooking\(|\.createCapacityBooking\(/);
        // In scope: the known caller is found, so an empty list cannot pass.
        return JSON.stringify(callers) === JSON.stringify([
            'modules/booking/services/booking.service.ts',
            'modules/catalog/domain/services/booking/ProductBookingService.ts',
        ]) && /\.groupBookingService\.createBooking\(/.test(BS);
    });

    await assert('⛔ a group MOVE is reached only from `rescheduleBooking`', () =>
        JSON.stringify(productionCallers(/\.moveIntoSlot\(/))
            === JSON.stringify(['modules/booking/services/booking.service.ts'])
        && rescheduleBody!.includes('moveIntoSlot('));

    await assert('⛔ every production `parseSlotId` sits behind a chokepoint', () =>
        JSON.stringify(productionCallers(/\.parseSlotId\(/)) === JSON.stringify([
            'modules/booking/services/booking.service.ts',
            'modules/booking/services/group-booking.service.ts',
            'modules/catalog/domain/services/booking/ProductBookingService.ts',
        ]));

    /**
     * ⛔ **THERE ARE NOW TWO HOLD DOORS, AND EACH HAS ITS OWN RULE.** Until 2026-09-20 this
     * project could say "every hold reaches `lockSlot`, which validates it" — one sentence
     * covering every door. `holdSlotForReschedule` (§ 11) is the second, and it deliberately does
     * NOT ask `assertOfferedSlot`: it exists precisely to hold a time outside published hours.
     *
     * ⚠ **So the guard that used to be "one door" is now "these two, each validated".** A third
     * caller of the lock primitive is a hold with no rule at all — the fabricated-slot hole
     * reopened — and fails here rather than passing quietly. Both known callers are asserted to
     * validate first, so this cannot pass by a door merely existing.
     */
    await assert('⛔ exactly two doors take a hold, and each validates before it takes one', () => {
        const takesAHold = /slotLockService\.lock\(|slotLockFacade\.lockSlot\(/;
        const callers = productionCallers(takesAHold);

        /**
         * ⚠ **Counted per CALL SITE, not per file — the unit counted must be the unit claimed.**
         * The file list alone would let a THIRD door appear inside `booking.service.ts` — a new
         * method calling the lock primitive with no rule in front of it — while this assertion
         * stayed green, because the file was already on the list. That is the span error this
         * project keeps meeting, in a new disguise: the claim was about DOORS and the count was
         * about FILES. Found by the mutant "B8 a THIRD hold door appears".
         */
        const sites = callers.map((file) => (
            (fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/[^\n]*$/gm, '')
                // Re-flagging a module constant's own source with `g` to COUNT its matches —
                // the pattern is `takesAHold`, defined in this file, and no value from
                // outside it reaches the constructor. The ban's documented exception.
                // eslint-disable-next-line no-restricted-syntax
                .match(new RegExp(takesAHold.source, 'g')) ?? []).length
        ));
        if (sites.some((n) => n !== 1)) return false;
        const holdBody = methodBody(BS, /async holdSlotForReschedule\(/);
        const lockBody2 = methodBody(
            codeOf('modules/catalog/domain/services/booking/ProductBookingService.ts'),
            /async lockSlot\(/,
        );
        return JSON.stringify(callers) === JSON.stringify([
            // The two doors…
            'modules/booking/services/booking.service.ts',
            'modules/catalog/domain/services/booking/ProductBookingService.ts',
            // …and the facade one of them goes through, which is the primitive, not a door.
            'modules/catalog/domain/services/booking/SlotLockFacade.ts',
        ])
            && Boolean(holdBody && lockBody2)
            /**
             * Each door validates FIRST: the shop rule here, the offered rule there.
             *
             * ⚠ **Both positions are required to EXIST before they are compared**, and that is not
             * belt-and-braces. A mutation that deleted the validation entirely left `indexOf`
             * answering -1, and `-1 < 30` is true — so the ordering check passed hardest exactly
             * when the check it describes had stopped happening. Found by running that mutant.
             */
            && [
                [holdBody!, 'this.assertShopRuleSlot(', 'slotLockService.lock('],
                [lockBody2!, 'assertOfferedSlot(', 'slotLockFacade.lockSlot('],
            ].every(([body, validate, take]) => {
                const validatedAt = body.indexOf(validate);
                const takenAt = body.indexOf(take);
                return validatedAt >= 0 && takenAt >= 0 && validatedAt < takenAt;
            });
    });

    /**
     * ⚠ **One shop rule, not two.** The hold and the move must never disagree about what a shop
     * may move to, so both call `assertShopRuleSlot` and nothing else re-implements its length
     * comparison. A second copy is how a dashboard ends up holding a time the move refuses.
     */
    await assert('⛔ the shop rule is defined once and called by BOTH the hold and the move', () => {
        const definitions = (BS.match(/private assertShopRuleSlot\(/g) ?? []).length;
        const calls = (BS.match(/this\.assertShopRuleSlot\(/g) ?? []).length;
        const target = methodBody(BS, /private async assertRescheduleTarget\(/);
        const holdBody = methodBody(BS, /async holdSlotForReschedule\(/);
        return definitions === 1 && calls === 2
            && Boolean(target && holdBody)
            && target!.includes('this.assertShopRuleSlot(')
            && holdBody!.includes('this.assertShopRuleSlot(');
    });

    console.log('\n══ § 9 · The chat reschedule passes a product ID, not a product ══');

    /**
     * ⚠ **The in-memory case confirmed before the fix, kept as the pin.** `getUserBooking`
     * populates `productId`; on Mongoose 8 `String()` of a populated document is its inspected
     * contents, which the chat reschedule used to hand to `lockSlot` as a product id.
     */
    await assert('⛔ `String()` of a populated document is NOT its id — the defect, reproduced', () => {
        const Model = mongoose.models.SlotOfferPX
            ?? mongoose.model('SlotOfferPX', new mongoose.Schema({ title: String }));
        const doc = new Model({ title: 'Haircut' });
        return String(doc) !== doc._id.toString() && String(doc).includes('Haircut');
    });

    await assert('the id is taken explicitly from a populated document and from a bare id alike', () => {
        const Model = mongoose.models.SlotOfferPX!;
        const doc = new Model({ title: 'Haircut' });
        const bare = new mongoose.Types.ObjectId();
        return referencedIdOf(doc) === doc._id.toString()
            && referencedIdOf(bare) === bare.toString();
    });

    await assert('⛔ the chat reschedule no longer stringifies the reference', () => {
        const bot = codeOf('modules/bot-surface/controllers/bot-booking.controller.ts');
        const body = methodBody(bot, /static reschedule = /) ?? bot.slice(bot.indexOf('static reschedule'));
        return body.includes('referencedIdOf(existing.productId)')
            && !body.includes('existing.productId.toString()');
    });

    console.log('\n══ § 10 · ⛔ A shop\'s reschedule checks the hold the shop actually took ══');

    /**
     * ── ⛔ WHAT WAS WRONG, found 2026-09-19 ────────────────────────────────────────
     * The dashboard holds the new time through the storefront lock route, which writes the hold
     * under the signed-in USER id. The shop's reschedule route then asserted the hold under the
     * VENDOR id: the role entity, a different document with its own id. The two never matched,
     * so from 2026-02-23 every shop reschedule failed: 403 "locked by another user" on a
     * single-seat service (the other user being the shop itself), 409 "not locked" on a class.
     *
     * ⚠ **Pinned by RUNNING both handlers, not by reading them.** Both are driven with ONE
     * signed-in shop, and what each hands to the layer below is captured. A scan can say which
     * expression each passes; only running them says the two expressions name the same id. The
     * real hold store (the real `SlotLockService`, on an in-memory Redis) and the real
     * `rescheduleBooking` then prove that the id the handlers agree on is the one that passes.
     */
    const redisStore = new Map<string, string>();
    (redisFactory as Record<string, unknown>).getRedisClient = async (): Promise<unknown> => ({
        get: async (key: string) => redisStore.get(key) ?? null,
        set: async (key: string, value: string, opts?: { NX?: boolean }) => {
            if (opts?.NX && redisStore.has(key)) return null;
            redisStore.set(key, value);
            return 'OK';
        },
        del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
        exists: async (key: string) => (redisStore.has(key) ? 1 : 0),
    });

    /** A real user document, so `.id` and `._id` behave exactly as `requireAuth` hands them over. */
    const signedIn = () => {
        const user = new UserModel({});
        const vendorId = new mongoose.Types.ObjectId();
        return { user, vendorId, auth: { user, role: 'vendor', role_entity: { _id: vendorId } } };
    };
    const shopA = signedIn();
    const shopB = signedIn();

    type Handler = (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
    /** Runs an `asyncHandler`-wrapped handler to completion: it returns void, so wait on `res`/`next`. */
    const run = (handler: Handler, req: Record<string, unknown>): Promise<{ body?: unknown; error?: unknown }> =>
        new Promise((resolve) => {
            const res = {
                status: () => res,
                json: (body: unknown) => resolve({ body }),
            };
            handler(req, res, (error?: unknown) => resolve({ error }));
        });

    type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } };
    const lockRoute = (productBookingRouter.stack as unknown as RouteLayer[])
        .find((layer) => layer.route?.path === '/:productId/slots/:slotId/lock' && layer.route.methods.post)?.route;
    // The route's LAST handler is the route's own; the ones before it are `requireAuth`.
    const lockHandler = lockRoute?.stack[lockRoute.stack.length - 1]?.handle;

    await assert('in scope: the lock route is found, and a shop\'s user id and vendor id really differ', () =>
        typeof lockHandler === 'function'
        && (lockRoute?.stack.length ?? 0) >= 2
        && shopA.user.id !== shopA.vendorId.toString()
        && shopA.user.id === shopA.user._id.toString());

    let heldBy: string | undefined;
    let movedWith: { lockOwnerId: string; actor: unknown } | undefined;
    const originalLockSlot = productBookingService.lockSlot;
    const originalReschedule = BookingService.prototype.rescheduleBooking;
    try {
        productBookingService.lockSlot = async (_productId: string, _slotId: string, owner: string) => {
            heldBy = owner;
            return true;
        };
        BookingService.prototype.rescheduleBooking = async function (
            _bookingId: string, _slotId: string, lockOwnerId: string, actor?: { role: 'vendor' | 'customer'; id: string },
        ) {
            movedWith = { lockOwnerId, actor };
            return {} as never;
        };
        /**
         * ⚠ **Guarded, so a renamed lock route FAILS the assertions below rather than crashing
         * the run.** Proven: mutating the route's path leaves `lockHandler` undefined, and an
         * unguarded `run(lockHandler!, …)` threw out of `main` — which reads as a broken suite
         * rather than as the in-scope assertion catching a moved route.
         */
        if (typeof lockHandler === 'function') {
            await run(lockHandler, { auth: shopA.auth, params: { productId: 'p1', slotId: 'slot_x' } });
        }
        await run(VendorBookingController.rescheduleBooking as unknown as Handler, {
            auth: shopA.auth, params: { id: 'b1' }, body: { newSlotId: 'slot_x' },
        });
    } finally {
        productBookingService.lockSlot = originalLockSlot;
        BookingService.prototype.rescheduleBooking = originalReschedule;
    }

    await assert('⛔ the lock route and the shop\'s reschedule name the SAME hold owner: the shop\'s USER id', () =>
        heldBy === shopA.user.id && movedWith?.lockOwnerId === heldBy);

    await assert('⛔ …while the booking itself is still scoped by the shop\'s VENDOR id', () =>
        JSON.stringify(movedWith?.actor) === JSON.stringify({ role: 'vendor', id: shopA.vendorId.toString() }));

    /** Shop A's booking at 10:00–11:00, as `Booking.findOne` would return it. */
    const bookingOfShopA = () => ({
        _id: new mongoose.Types.ObjectId(),
        productId: new mongoose.Types.ObjectId(),
        vendorId: shopA.vendorId,
        userId: new mongoose.Types.ObjectId(),
        status: BookingStatus.CONFIRMED,
        startAt: at(10),
        endAt: at(11),
        deletedAt: null,
        saves: 0,
        async save() { this.saves++; return this; },
    });
    let stored: ReturnType<typeof bookingOfShopA> | null = null;

    /**
     * The real `rescheduleBooking` — and, in § 11, the real `holdSlotForReschedule` — with only
     * their database edges replaced. `overlaps` is what `countOverlappingBookings` answers, so a
     * target that is already sold can be set up without a database.
     */
    const rescheduler = (group: boolean, overlaps = 0) => {
        const service = new BookingService();
        const state = { service, groupMoves: 0 };
        const edges = service as unknown as Record<string, unknown>;
        edges.groupBookingService = {
            resolveCapacity: async () => (group ? { maxBookings: 3 } : null),
            moveIntoSlot: async () => { state.groupMoves++; },
            syncCalendarForMove: async () => undefined,
        };
        edges.countOverlappingBookings = async () => overlaps;
        edges.emitBookingRescheduledEvent = async () => undefined;
        return state;
    };
    const target = slotId(at(12), at(13));
    const asShop = (shop: typeof shopA) => ({ role: 'vendor' as const, id: shop.vendorId.toString() });

    const originalFindOne = Booking.findOne;
    const originalFindById = ProductModel.findById;
    try {
        /** Honours every key of the scope, which is the thing the cross-shop case is about. */
        (Booking as unknown as Record<string, unknown>).findOne = async (query: Record<string, unknown>) => {
            const doc = stored as unknown as Record<string, unknown> | null;
            const hit = doc !== null && Object.entries(query).every(([key, value]) =>
                value === null ? doc[key] == null : String(value) === String(doc[key]));
            return hit ? stored : null;
        };
        (ProductModel as unknown as Record<string, unknown>).findById = async () => ({ title: 'Yoga' });

        await assert('a shop moves a single-seat appointment onto a time it holds, and the hold is spent', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            const held = await world({ realLocks: true }).service.lockSlot('p1', target, shopA.user.id);
            const moved = await rescheduler(false).service.rescheduleBooking(
                stored._id.toString(), target, shopA.user.id, asShop(shopA));
            return held && moved.startAt.getTime() === at(12).getTime() && stored.saves === 1 && redisStore.size === 0;
        });

        await assert('⛔ the defect, reproduced: asserted under the VENDOR id, the shop\'s own hold is "someone else\'s"', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            await world({ realLocks: true }).service.lockSlot('p1', target, shopA.user.id);
            const wasRefused = await refused(() => rescheduler(false).service.rescheduleBooking(
                stored!._id.toString(), target, shopA.vendorId.toString(), asShop(shopA)), 'BOOKING_UNAUTHORIZED', 403);
            return wasRefused && stored.saves === 0;
        });

        await assert('a shop moves a CLASS booking onto a class it holds (the per-owner key)', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            await world({ mode: 'capacity', seats: 3, realLocks: true }).service.lockSlot('p1', target, shopA.user.id);
            const moving = rescheduler(true);
            await moving.service.rescheduleBooking(stored._id.toString(), target, shopA.user.id, asShop(shopA));
            return moving.groupMoves === 1 && [...redisStore.keys()].length === 0;
        });

        await assert('⛔ …and the class defect, reproduced: under the VENDOR id the per-owner key is never found', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            await world({ mode: 'capacity', seats: 3, realLocks: true }).service.lockSlot('p1', target, shopA.user.id);
            const moving = rescheduler(true);
            const wasRefused = await refused(() => moving.service.rescheduleBooking(
                stored!._id.toString(), target, shopA.vendorId.toString(), asShop(shopA)), 'BOOKING_SLOT_NOT_LOCKED', 409);
            return wasRefused && moving.groupMoves === 0;
        });

        await assert('⛔ another shop, HOLDING the very slot, cannot move this shop\'s booking', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            const held = await world({ realLocks: true }).service.lockSlot('p1', target, shopB.user.id);
            const wasRefused = await refused(() => rescheduler(false).service.rescheduleBooking(
                stored!._id.toString(), target, shopB.user.id, asShop(shopB)), 'BOOKING_NOT_FOUND', 404);
            return held && wasRefused && stored.saves === 0 && stored.startAt.getTime() === at(10).getTime();
        });

        console.log('\n══ § 11 · ⛔ The shop\'s own hold — the door that made the shop rule reachable ══');

        /**
         * ── WHY THIS DOOR EXISTS ────────────────────────────────────────────────────
         * A move needs a hold, and the only route that took one ran `assertOfferedSlot`, which
         * refuses anything outside published hours. So "a shop may move an appointment outside
         * its opening hours" was a rule with no way to exercise it: every such move died at the
         * hold, one step before the rule that allows it.
         *
         * ⚠ **The rule is ONE method, shared.** `holdSlotForReschedule` and the vendor branch of
         * `assertRescheduleTarget` both call `assertShopRuleSlot`, so this door cannot grant a
         * time the move would then refuse. The assertions below drive the REAL service, and § 8's
         * door census (extended for this door) is what stops a second hold path appearing beside
         * it with a rule of its own.
         */
        const hold = (shop: typeof shopA, slot: string, group = false, overlaps = 0) =>
            rescheduler(group, overlaps).service.holdSlotForReschedule(
                stored!._id.toString(), slot, shop.user.id, asShop(shop));

        const outsideHours = slotId(at(19), at(20)); // 19:00, after the 09–17 published rules

        await assert('a shop holds a time OUTSIDE its published hours — what the storefront lock refuses', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            const held = await hold(shopA, outsideHours);
            const refusedByCustomerDoor = await refused(
                () => world({ realLocks: true }).service.lockSlot('p1', outsideHours, shopA.user.id),
                'BOOKING_SLOT_UNAVAILABLE', 409, 'not_offered');
            return held.slotId === outsideHours
                && held.start.getTime() === at(19).getTime()
                && held.expiresAt.getTime() - Date.now() > 14 * 60 * 1000
                && redisStore.size === 1
                && refusedByCustomerDoor;
        });

        await assert('⛔ the hold is written under the shop\'s USER id — (a)\'s fix, carried into the new door', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            await hold(shopA, outsideHours);
            const key = [...redisStore.keys()][0] ?? '';
            const held = JSON.parse(redisStore.get(key) ?? '{}');
            return held.ownerId === shopA.user.id
                && held.ownerId !== shopA.vendorId.toString()
                && !key.includes(shopA.vendorId.toString());
        });

        await assert('⛔ and the held time really is the one the move then accepts', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            await hold(shopA, outsideHours);
            const moved = await rescheduler(false).service.rescheduleBooking(
                stored._id.toString(), outsideHours, shopA.user.id, asShop(shopA));
            return moved.startAt.getTime() === at(19).getTime() && redisStore.size === 0;
        });

        await assert('⛔ a shop cannot hold a time for ANOTHER shop\'s appointment', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            const wasRefused = await refused(() => hold(shopB, outsideHours), 'BOOKING_NOT_FOUND', 404);
            return wasRefused && redisStore.size === 0;
        });

        await assert('⛔ a cancelled or finished appointment cannot be held a new time', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            stored.status = BookingStatus.CANCELLED;
            const wasRefused = await refused(() => hold(shopA, outsideHours), 'BOOKING_NOT_RESCHEDULABLE', 409);
            return wasRefused && redisStore.size === 0;
        });

        await assert('⛔ the hold keeps the appointment\'s LENGTH, and refuses an inverted interval', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            const longer = await refused(() => hold(shopA, slotId(at(19), at(21))),
                'BOOKING_INVALID_SLOT_ID', 400, 'length_changed');
            const inverted = await refused(() => hold(shopA, slotId(at(20), at(19))),
                'BOOKING_INVALID_SLOT_ID', 400, 'inverted');
            return longer && inverted && redisStore.size === 0;
        });

        /**
         * ⚠ **`not_future` is NEW (2026-09-20) and lands on both doors in one change.** Without it
         * a shop could move an appointment into last week — rewriting history for a customer who
         * has already been, and putting the booking behind every sweep and reminder, which only
         * look forward. The customer rule never had the hole: `assertOfferedSlot` refuses a past
         * slot outright.
         */
        await assert('⛔ neither door accepts a time that has already passed', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            const gone = slotId(new Date(Date.UTC(2020, 0, 6, 8)), new Date(Date.UTC(2020, 0, 6, 9)));
            const heldRefused = await refused(() => hold(shopA, gone),
                'BOOKING_INVALID_SLOT_ID', 400, 'not_future');
            const moveRefused = await refused(() => rescheduler(false).service.rescheduleBooking(
                stored!._id.toString(), gone, shopA.user.id, asShop(shopA)),
                'BOOKING_INVALID_SLOT_ID', 400, 'not_future');
            return heldRefused && moveRefused && redisStore.size === 0 && stored.saves === 0;
        });

        /**
         * ⚠ **A hold taken at the boundary cannot be moved once that boundary has passed.** The
         * hold lives fifteen minutes and the rule is re-applied by the move, so a shop that holds
         * 19:00 at 18:59 and calls the move at 19:01 is refused — the hold does not grant the past.
         */
        await assert('⛔ a hold taken a minute before the start does not survive into the past', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            const service = rescheduler(false).service as unknown as {
                assertShopRuleSlot(b: unknown, s: string, now: Date): { start: Date };
            };
            const start = at(19);
            const justBefore = service.assertShopRuleSlot(stored, outsideHours, new Date(start.getTime() - MIN));
            let refusedAfter = false;
            try {
                service.assertShopRuleSlot(stored, outsideHours, new Date(start.getTime() + MIN));
            } catch (err) {
                refusedAfter = err instanceof AppError && err.details?.reason === 'not_future';
            }
            return justBefore.start.getTime() === start.getTime() && refusedAfter;
        });

        await assert('⛔ a time another appointment already occupies is refused (single occupancy)', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            const wasRefused = await refused(() => hold(shopA, outsideHours, false, 1),
                'BOOKING_SLOT_UNAVAILABLE', 409);
            return wasRefused && redisStore.size === 0;
        });

        /**
         * ⚠ **Seats are deliberately NOT counted here**, so a class hold passes an occupancy the
         * single-seat rule would refuse; capacity is enforced when the move happens, under the
         * target slot's mutex. A hold is not a seat, and a second opinion about capacity is a
         * second thing to disagree with.
         */
        await assert('a CLASS hold is per-owner, and does not count seats', async () => {
            redisStore.clear();
            stored = bookingOfShopA();
            const held = await hold(shopA, outsideHours, true, 3);
            const key = [...redisStore.keys()][0] ?? '';
            return held.slotId === outsideHours && key.includes(shopA.user.id);
        });

        await assert('⛔ the moving appointment overlapping ITSELF is allowed, as it is on the move', async () => {
            redisStore.clear();
            stored = bookingOfShopA(); // 10:00–11:00
            const held = await hold(shopA, slotId(at(10, 30), at(11, 30)), false, 1);
            return held.start.getTime() === at(10, 30).getTime();
        });

        // ── The door itself: mounted, gated, and passing both ids ────────────────────────────

        const holdRoute = (vendorBookingRouter.stack as unknown as RouteLayer[])
            .find((layer) => layer.route?.path === '/:id/slot-hold' && layer.route.methods.post)?.route;

        await assert('in scope: the vendor router really registers POST /:id/slot-hold', () =>
            Boolean(holdRoute) && typeof holdRoute!.stack[holdRoute!.stack.length - 1]?.handle === 'function');

        /**
         * ⚠ **Run, not read.** "The role middleware is present" is satisfied by a middleware that
         * lets everyone through; what must hold is that a CUSTOMER is actually refused. The
         * router's `use` layers are driven with a signed-in customer and one of them must answer
         * 403 before any route handler is reached.
         */
        await assert('⛔ a customer is REFUSED at this router, by running its gate', async () => {
            const gates = (vendorBookingRouter.stack as unknown as Array<{ route?: unknown; handle: Handler }>)
                .filter((layer) => !layer.route)
                .map((layer) => layer.handle);
            if (gates.length === 0) return false;
            const asRole = (role: string, auth: unknown) => ({ auth, role, headers: {}, params: {}, body: {} });
            const customerAuth = {
                user: new UserModel({}), role: 'customer', role_entity: { _id: new mongoose.Types.ObjectId() },
            };

            /**
             * The gate that DECIDES by role is the one that refuses a customer and lets the shop
             * through — found by running, so the assertion cannot be satisfied by `requireAuth`
             * (which refuses both, for want of a token) or by a middleware that refuses nobody.
             */
            for (const gate of gates) {
                const asCustomer = await run(gate, asRole('customer', customerAuth));
                const asVendor = await run(gate, asRole('vendor', shopA.auth));
                const refusal = asCustomer.error;
                if (
                    refusal instanceof AppError
                    && refusal.statusCode === 403
                    && refusal.code === 'AUTH_ROLE_NOT_FOUND'
                    && asVendor.error === undefined
                ) return true;
            }
            return false;
        });

        await assert('⛔ the handler holds under the USER id and scopes the booking by the VENDOR id', async () => {
            let passed: { slotId: string; holdOwnerId: string; actor: unknown } | undefined;
            const original = BookingService.prototype.holdSlotForReschedule;
            try {
                BookingService.prototype.holdSlotForReschedule = async function (
                    _bookingId: string, slot: string, holdOwnerId: string, actor: { role: 'vendor'; id: string },
                ) {
                    passed = { slotId: slot, holdOwnerId, actor };
                    return { slotId: slot, start: at(19), end: at(20), expiresAt: new Date() };
                };
                await run(VendorBookingController.holdSlot as unknown as Handler, {
                    auth: shopA.auth, params: { id: 'b1' }, body: { slotId: outsideHours },
                });
            } finally {
                BookingService.prototype.holdSlotForReschedule = original;
            }
            return passed?.slotId === outsideHours
                && passed.holdOwnerId === shopA.user.id
                && JSON.stringify(passed.actor) === JSON.stringify({ role: 'vendor', id: shopA.vendorId.toString() });
        });
    } finally {
        (Booking as unknown as Record<string, unknown>).findOne = originalFindOne;
        (ProductModel as unknown as Record<string, unknown>).findById = originalFindById;
    }

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
