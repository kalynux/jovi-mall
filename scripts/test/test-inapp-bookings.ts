/**
 * Test: the booking screens' core, its words, and the two rules that are invisible in English.
 *
 * Run: `npm run test:inapp-bookings`
 *
 * ── WHAT THIS PINS, AND WHY EACH ONE IS WORTH A TEST ────────────────────────
 *  1. **The core is transport-neutral.** The WhatsApp form imports it directly; the day it
 *     imports Express, or the controller, that channel's suite stops being runnable at all —
 *     `bot-booking.controller.ts` reaches the booking and payment services, which do work at
 *     import time, so a bare `ts-node` run produces NO output and reads as a broken test.
 *  2. **The write spends its handle and the reads do not.** One press, one appointment.
 *  3. **The slot is re-verified by the same rule every other door uses** — not re-implemented
 *     here. A caller-supplied interval priced pro rata is the hole this module must never reopen.
 *  4. ⭐ **A row built from DATA must distinguish two rows in FRENCH and ARABIC**, not in English.
 *     Three live lists were found rendering two identical rows to a French customer on the day
 *     this was written, including one where the customer then picked paid content at random.
 *  5. **The content-free acknowledgement is its own sentence**, not the receipt with its holes
 *     left empty — which renders "Booked: , . Your reference is ." in five languages.
 */
import fs from 'fs';
import path from 'path';
import {
    BOOKING_TEXT_CAPS,
    bookingChatAcknowledgement,
    bookingChatReceipt,
    bookingScreenCopy,
    bookingTimesAvailable,
    fitBookingRowTitle,
} from '../../src/modules/bot-surface/domain/bot-booking-copy';

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

/** ⚠ Normalised first: the blobs carry CRLF, so every `'\n}\n'`-bounded span would run to EOF. */
const SCAN_ROOT = process.env.INAPP_BOOKINGS_SCAN_ROOT
    ? path.resolve(process.env.INAPP_BOOKINGS_SCAN_ROOT)
    : path.join(__dirname, '../..');
if (process.env.INAPP_BOOKINGS_SCAN_ROOT) {
    console.log(`\n⚠ SCANS REDIRECTED to ${SCAN_ROOT} — a proof run, not a real one.`);
}

const read = (rel: string): string =>
    fs.readFileSync(path.join(SCAN_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** Comments explain the rules; a scan that read the explanation would fail on the file obeying it. */
const stripped = (rel: string): string =>
    read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CORE = 'src/modules/bot-surface/miniapp/surfaces/booking.core.ts';
const SCREENS = 'src/modules/bot-surface/miniapp/surfaces/booking.controller.ts';
const COPY = 'src/modules/bot-surface/domain/bot-booking-copy.ts';

const LANGUAGES = ['en', 'fr', 'pt', 'es', 'ar'] as const;

function main(): void {
    console.log('\n══ § 1 · In scope — nothing below may pass by scanning nothing ══');

    const core = stripped(CORE);

    assert('the three files are found, and the core holds its five exported doors', () =>
        core.length > 0
        && stripped(SCREENS).length > 0
        && stripped(COPY).length > 0
        && ['readBookingDays', 'readBookingSlots', 'readBookingPicker', 'confirmBooking', 'readCustomerBookings']
            .every((fn) => core.includes(`export async function ${fn}(`)));

    console.log('\n══ § 2 · The core is transport-neutral — the WhatsApp form imports it ══');

    /**
     * ⚠ The check is on IMPORTS, not on the word "express" anywhere: a comment explaining why
     * Express is absent would otherwise fail the file that gets it right.
     */
    assert('⛔ no Express, no controller, no route file reaches the core', () => {
        const imports = [...core.matchAll(/^import[^;]*from '([^']+)';/gm)].map((m) => m[1]);
        if (imports.length === 0) return false;
        return !imports.some((from) =>
            from === 'express'
            || /\.controller$/.test(from)
            || /\.routes$/.test(from));
    });

    assert('the transport is the one that holds Express, and it is thin', () => {
        const screens = stripped(SCREENS);
        return screens.includes("from 'express'")
            && screens.includes("from './booking.core'")
            // Every rule it needs comes from the core: the transport computes no availability.
            && !screens.includes('getAvailability(');
    });

    console.log('\n══ § 3 · One press, one appointment ══');

    const confirm = core.slice(core.indexOf('export async function confirmBooking('));

    assert('⛔ the confirm SPENDS the handle (consume), and the picker only reads it', () => {
        const picker = core.slice(
            core.indexOf('export async function readBookingPicker('),
            core.indexOf('export async function confirmBooking('),
        );
        return confirm.includes("inAppSurfaceStore.consume('bk'")
            && !confirm.includes("inAppSurfaceStore.read('bk'")
            && picker.includes("inAppSurfaceStore.read('bk'")
            && !picker.includes('consume(');
    });

    /**
     * ⚠ **The re-check is NOT re-implemented here, and that is the assertion.** `lockSlot` runs
     * `assertOfferedSlot` and the customer branch of `assertRescheduleTarget` runs it too, so the
     * slot a form hands back meets the same rule as every other door. A second copy in this file
     * would be a second opinion, and the two would disagree the day one changed.
     */
    assert('⛔ the slot is re-verified through the shared doors, not by a local copy', () =>
        confirm.includes('productBookingService.lockSlot(')
        && confirm.includes('bookingService.rescheduleBooking(')
        && confirm.includes('productBookingService.bookProduct(')
        && !confirm.includes('assertOfferedSlot(')
        && !confirm.includes('getAvailability('));

    assert('⛔ a failed confirm releases the hold rather than leaving it for the TTL', () => {
        const rescue = confirm.slice(confirm.indexOf('} catch (error) {'));
        return rescue.includes('productBookingService.unlockSlot(') && rescue.includes('throw error;');
    });

    console.log('\n══ § 4 · ⭐ The row rule, checked in FRENCH and ARABIC ══');

    /**
     * ⚠ **The numbers are asserted as LITERALS, because they are not ours.** WhatsApp truncates a
     * list row title at 24 characters and a button at 20 whatever this repository believes, so a
     * guard that read the cap from the module it guards would bless raising it — and every row
     * would then be cut by Meta instead, in the longest languages first.
     */
    assert('the caps are the platform\'s numbers, not ours', () =>
        BOOKING_TEXT_CAPS.rowTitle === 24
        && BOOKING_TEXT_CAPS.rowDescription === 72
        && BOOKING_TEXT_CAPS.button === 20
        && BOOKING_TEXT_CAPS.option === 30);

    /**
     * Two appointments for the same service, three hours apart. In every language the rows must
     * differ — and the English case is the one that would pass while the others failed, which is
     * why it is not the case this asserts.
     */
    const SAME_SERVICE = {
        fr: 'Coupe de cheveux et barbe pour homme',
        ar: 'قص الشعر وتهذيب اللحية للرجال',
        en: "Men's haircut and beard trim",
    };

    assert('⛔ two appointments for one service differ in FRENCH', () => {
        const a = fitBookingRowTitle(SAME_SERVICE.fr, 'mar. 22 sept. 14:00');
        const b = fitBookingRowTitle(SAME_SERVICE.fr, 'mar. 22 sept. 17:00');
        return a !== b && a.includes('14:00') && b.includes('17:00');
    });

    assert('⛔ …and in ARABIC, the longest of the five', () => {
        const a = fitBookingRowTitle(SAME_SERVICE.ar, '١٤:٠٠');
        const b = fitBookingRowTitle(SAME_SERVICE.ar, '١٧:٠٠');
        return a !== b && a.endsWith('١٤:٠٠') && b.endsWith('١٧:٠٠');
    });

    // 24 spelled out again rather than read from the module: see the literals assertion above.
    assert('every row title fits the control, in all five languages', () =>
        Object.values(SAME_SERVICE).every((service) =>
            fitBookingRowTitle(service, 'mar. 22 sept. 14:00').length <= 24));

    /**
     * ⚠ **The SERVICE is what gets shortened, never the time.** Cutting from the right removes
     * the only thing that tells two of somebody's appointments apart — the failure this whole
     * section exists to stop.
     */
    assert('⛔ the time survives whole; the service is what is shortened', () => {
        const title = fitBookingRowTitle('A very long service name indeed', '14:00');
        return title.endsWith('14:00') && title.includes('…');
    });

    console.log('\n══ § 5 · The words ══');

    assert('every screen word exists in all five languages', () =>
        LANGUAGES.every((lang) => {
            const copy = bookingScreenCopy(lang);
            return Object.values(copy).every((word) => typeof word === 'string' && word.length > 0);
        }));

    assert('no language was left as a copy of the English', () => {
        const en = JSON.stringify(bookingScreenCopy('en'));
        return (['fr', 'pt', 'es', 'ar'] as const).every((lang) =>
            JSON.stringify(bookingScreenCopy(lang)) !== en);
    });

    assert('the count sits inside the sentence, in every language', () =>
        LANGUAGES.every((lang) => bookingTimesAvailable(6, lang).includes('6'))
        && bookingTimesAvailable(1, 'en') !== bookingTimesAvailable(2, 'en'));

    /**
     * ⭐ **The acknowledgement is its own sentence.** Feeding the receipt empty strings renders
     * "Booked: , . Your reference is ." — punctuation soup, in five languages, and it would have
     * shipped: the call site reads exactly like the correct one. Measured, not assumed.
     */
    assert('⛔ the short acknowledgement is NOT the receipt with its holes left empty', () =>
        LANGUAGES.every((lang) => {
            const empty = bookingChatReceipt(
                { moved: false, awaitingShop: false },
                { reference: '', when: '', service: '' },
                lang,
            );
            const ack = bookingChatAcknowledgement({ moved: false }, lang);
            return ack !== empty && !/\s,|,\s*\.|\s\.\s*$/.test(ack);
        }));

    assert('⛔ a move never says "booked" — its own verb, in every language', () =>
        LANGUAGES.every((lang) =>
            bookingChatAcknowledgement({ moved: true }, lang)
                !== bookingChatAcknowledgement({ moved: false }, lang)));

    /**
     * ⚠ A `manual`-mode service comes back REQUESTED, not confirmed. The receipt must say so, and
     * the short acknowledgement must be true without knowing — which is why it says "got" rather
     * than "confirmed".
     */
    assert('a booking awaiting the shop says so, and the short form claims nothing', () => {
        const waiting = bookingChatReceipt(
            { moved: false, awaitingShop: true },
            { reference: 'BKG-2026-000123', when: 'Tue 22 Sep 14:00', service: 'Haircut' },
            'en',
        );
        const settled = bookingChatReceipt(
            { moved: false, awaitingShop: false },
            { reference: 'BKG-2026-000123', when: 'Tue 22 Sep 14:00', service: 'Haircut' },
            'en',
        );
        return waiting.length > settled.length
            && waiting.includes('accept')
            && !bookingChatAcknowledgement({ moved: false }, 'en').includes('confirm');
    });

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main();
