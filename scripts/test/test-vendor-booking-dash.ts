/**
 * test:vendor-booking-dash — the vendor dashboard's 2026-10-26 asks:
 *   1. the services list carries price / length / booking mode on each service row;
 *   3. the customer's note reaches the vendor's Google Calendar on every write, and a capacity
 *      class's shared event lists every seat;
 *   4. the note is capped at 500 characters on the storefront booking door.
 *
 * Offline: the list service runs against fake repositories, the calendar text is pure, and the
 * places that must use it are pinned by source scans.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { ProductListService } from '../../src/modules/catalog/domain/services/ProductListService';
import { categoryCatalogCache } from '../../src/modules/categories/services/category-catalog.cache';
import {
    bookingEventDescription,
    capacityEventDescription,
    customerNote,
} from '../../src/modules/booking/utils/calendar-description.util';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };
let passed = 0;
let failed = 0;

async function assert(label: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    try {
        if (await fn()) {
            passed += 1;
            originalConsole.log(`  ✅ ${label}`);
        } else {
            failed += 1;
            originalConsole.log(`  ❌ FAIL: ${label}`);
        }
    } catch (error) {
        failed += 1;
        originalConsole.log(`  ❌ THROW: ${label} — ${error instanceof Error ? error.message : String(error)}`);
    }
}

const SRC = join(__dirname, '..', '..', 'src');
const code = (rel: string): string =>
    readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

async function main(): Promise<void> {
    // ── 1. The services list ────────────────────────────────────────────────
    originalConsole.log('\n── 1. GET /api/vendor/products?type=service — the `service` field ──');

    (categoryCatalogCache as unknown as Record<string, unknown>).refsForMany = async (lists: unknown[]) => lists.map(() => []);
    let variantReads = 0;
    const rows = [
        { id: 'p1', title: 'Coupe', type: 'service', status: 'active', mode: 'variant', categoryIds: [], hasVariants: true, fileIds: [], defaultVariantId: 'v1', vectorisationEnabled: false, vectorisationStatus: 'idle', createdAt: new Date(), updatedAt: new Date() },
        { id: 'p2', title: 'Yoga', type: 'service', status: 'active', mode: 'variant', categoryIds: [], hasVariants: true, fileIds: [], defaultVariantId: 'v2', vectorisationEnabled: false, vectorisationStatus: 'idle', createdAt: new Date(), updatedAt: new Date() },
        { id: 'p3', title: 'Draft', type: 'service', status: 'draft', mode: 'variant', categoryIds: [], hasVariants: false, fileIds: [], defaultVariantId: null, vectorisationEnabled: false, vectorisationStatus: 'idle', createdAt: new Date(), updatedAt: new Date() },
        { id: 'p4', title: 'Shoe', type: 'physical', status: 'active', mode: 'simple', categoryIds: [], hasVariants: false, fileIds: [], defaultVariantId: 'v4', vectorisationEnabled: false, vectorisationStatus: 'idle', createdAt: new Date(), updatedAt: new Date() },
    ];
    const service = new ProductListService(
        { searchListView: async () => ({ data: rows, total: rows.length, page: 1, limit: 20 }) } as never,
        { findManyByIds: async () => [] } as never,
        {} as never,
        {
            findManyByIds: async (ids: string[]) => {
                variantReads += 1;
                const all: Record<string, unknown> = {
                    v1: { id: 'v1', price: 5000, serviceConfig: { durationMinutes: 120, bookingMode: 'calendar', maxBookings: 4 } },
                    v2: { id: 'v2', price: 3000, serviceConfig: { durationMinutes: 60, bookingMode: 'capacity', maxBookings: 10 } },
                    v4: { id: 'v4', price: 9000 },
                };
                return ids.map((id) => all[id]).filter(Boolean);
            },
        } as never,
    );
    const page = await service.execute('vendor-1', { type: 'service' }, { page: 1, limit: 20 });
    const byId = new Map(page.data.map((r) => [r.id, r as unknown as Record<string, any>]));

    await assert('a service row carries { price, currency, durationMinutes, bookingMode, maxBookings }', () => {
        const s = byId.get('p1')!.service;
        return s.price === 5000 && s.currency === 'XAF' && s.durationMinutes === 120 && s.bookingMode === 'calendar';
    });
    await assert('maxBookings only for capacity — null otherwise, even when stored', () =>
        byId.get('p1')!.service.maxBookings === null && byId.get('p2')!.service.maxBookings === 10);
    await assert('price is the stored whole-XAF value — never divided or multiplied', () =>
        byId.get('p1')!.service.price === 5000 && byId.get('p2')!.service.price === 3000);
    await assert('a fresh draft with no default variant → service: null', () =>
        byId.get('p3')!.service === null && 'service' in byId.get('p3')!);
    await assert('a physical row carries no `service` key at all', () => !('service' in byId.get('p4')!));
    await assert('ONE variant read for the whole page — no per-row lookups', () => variantReads === 1);

    // ── 3. The calendar text ────────────────────────────────────────────────
    originalConsole.log('\n── 3. The customer note in the vendor\'s calendar ──');

    await assert('the single-booking description is the four lines asked for', () =>
        bookingEventDescription({
            email: 'a@example.com', priceSnapshot: 5000, currency: 'XAF', bookingNumber: 'BKG-2026-000041',
            bookingId: 'x', metadata: { notes: 'I have very long hair' },
        }) === 'Booked by a@example.com\nPrice: 5000 XAF\nBooking #BKG-2026-000041\nNotes: I have very long hair');
    await assert('no note → no "Notes:" line; a blank note counts as none', () =>
        !bookingEventDescription({ email: 'a@x', bookingNumber: 'B', bookingId: 'x', metadata: { notes: '   ' } }).includes('Notes')
        && customerNote({ notes: '  hi  ' }) === 'hi' && customerNote({}) === null && customerNote(null) === null);
    await assert('the class event lists every customer with booking number and note — the asked-for text', () =>
        capacityEventDescription(2, 10, [
            { email: 'a@example.com', bookingNumber: 'BKG-2026-000041', bookingId: 'x', metadata: { notes: 'I have very long hair' } },
            { email: 'b@example.com', bookingNumber: 'BKG-2026-000042', bookingId: 'y' },
        ]) === 'Capacity booking — 2/10 seats filled\n\nCustomers:\n'
            + '• a@example.com (#BKG-2026-000041) — Notes: I have very long hair\n'
            + '• b@example.com (#BKG-2026-000042)');

    const bookingSvc = code('modules/booking/services/booking.service.ts');
    const groupSvc = code('modules/booking/services/group-booking.service.ts');
    const paySync = code('modules/booking/services/booking-calendar-sync.service.ts');
    await assert('a) b) c) every single-booking event write in BookingService uses the shared helper', () =>
        (bookingSvc.match(/description: bookingEventDescription\(/g) ?? []).length === 3
        && !/description: `Booked by/.test(bookingSvc) && !/description: `Rescheduled booking by/.test(bookingSvc));
    await assert('d) a payment change writes the readable title and the same description — no raw ids', () =>
        paySync.includes('description: bookingEventDescription(')
        && !/Booking - Product \$\{/.test(paySync) && !/Booking by user \$\{/.test(paySync)
        && paySync.includes('`${statusPrefix} ${product?.title ?? \'Booking\'}`'));
    await assert('d) …and never on a capacity slot — one seat\'s payment must not overwrite the class', () =>
        /resolveCapacity\(booking\.productId\.toString\(\)\)[\s\S]{0,120}if \(isGroupSlot\) return;/.test(paySync));
    await assert('d) …and keeps the place: the Google client REPLACES the event, so location is re-sent', () =>
        paySync.includes('location: calendarLocationOf(booking.location, booking.access)'));
    await assert('e) the class event is rendered by capacityEventDescription from the seat rows', () =>
        groupSvc.includes('capacityEventDescription(') && !/`Capacity booking — \$\{seats\}/.test(groupSvc));
    await assert('the one-off rewrite exists, previews by default, and writes only with --apply', () => {
        const script = readFileSync(join(__dirname, '..', 'rewrite-booking-calendar-events.ts'), 'utf8');
        return script.includes("process.argv.includes('--apply')")
            && script.includes('sync.syncBookingPaymentStatus(booking)')
            && script.includes('groups.rerenderSlotEvent(')
            && /status: \{ \$in: \[BookingStatus\.PENDING, BookingStatus\.CONFIRMED\] \}/.test(script)
            && script.includes('startAt: { $gt: new Date() }');
    });

    // ── 4. The note's length ────────────────────────────────────────────────
    originalConsole.log('\n── 4. The note is capped at the storefront door ──');

    const route = code('modules/catalog/routes/product-booking.routes.ts');
    const botValidators = code('modules/bot-surface/validators/bot.validators.ts');
    await assert('the storefront /book caps metadata.notes at 500, trimmed — the bot door\'s number', () =>
        route.includes('export const BOOKING_NOTES_MAX = 500;')
        && route.includes('trimmed.length > BOOKING_NOTES_MAX')
        && /notes: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(500\)/.test(botValidators));
    await assert('the cleaned metadata is what is booked — never the raw body', () =>
        route.includes('cleanMetadata,') && !/userId, \/\/ lockOwnerId is same as userId\s*metadata,/.test(route));

    originalConsole.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
    originalConsole.error('Suite crashed:', error);
    process.exitCode = 1;
});
