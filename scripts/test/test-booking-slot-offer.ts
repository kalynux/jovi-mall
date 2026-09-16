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
import { TimeWindow } from '../../src/modules/booking/types/booking.types';
import { BookingService } from '../../src/modules/booking/services/booking.service';
import { referencedIdOf } from '../../src/modules/bot-surface/controllers/bot-booking.controller';

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

function world(overrides: Partial<Pick<World, 'mode' | 'seats' | 'bufferAfter'>> = {}): World {
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
        {
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
