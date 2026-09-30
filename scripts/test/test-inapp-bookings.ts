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
    bookingRowStatusLabel,
    BookingRowStatus,
} from '../../src/modules/bot-surface/domain/bot-booking-copy';
import {
    assertSomethingDue,
    bookingPayable,
    CustomerBookingSource,
    NOTHING_DUE_CODES,
    orderUpcomingFirst,
    payPurposeOrRefuse,
    projectCustomerBookings,
} from '../../src/modules/bot-surface/miniapp/surfaces/booking-rows';
import { inAppCopy } from '../../src/modules/bot-surface/miniapp/inapp-copy';
import { AppError } from '../../src/core/errors';
import {
    bookingPayActionId,
    parseBookingPayArgument,
    parseBotActionId,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import { actionKeyOf } from '../../src/modules/bot-surface/domain/bot-action-dispatch';
import { bookInviteActions } from '../../src/modules/bot-surface/domain/purchase-chat-copy';
import {
    CUSTOMER_NOTIFICATION_CATALOG,
    renderCustomerQuickReplies,
} from '../../src/modules/notifications/catalog/customer-notification-catalog';

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

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
    let ok = false;
    let thrown: Error | null = null;
    try {
        ok = await fn();
    } catch (err) {
        thrown = err as Error;
    }
    assert(name, () => {
        if (thrown) throw thrown;
        return ok;
    });
}

/** The code a refusal throws, or null when it does not throw. */
function refusalCode(fn: () => void): string | null {
    try {
        fn();
        return null;
    } catch (err) {
        return err instanceof AppError ? err.code : `NOT-AN-APPERROR: ${(err as Error).message}`;
    }
}

/**
 * The body of a function or method: from its declaration up to AND INCLUDING the end marker, so
 * a line-anchored pattern on its last statement still sees that statement's newline. Empty when
 * either end is missing — every caller treats empty as a failure, never as nothing-to-find.
 */
function spanOf(source: string, start: string, end: string): string {
    const at = source.indexOf(start);
    if (at < 0) return '';
    const stop = source.indexOf(end, at + start.length);
    return stop < 0 ? '' : source.slice(at, stop + end.length);
}

async function main(): Promise<void> {
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

    console.log('\n══ § 4b · ⛔ The money screen ══');

    const pay = core.slice(core.indexOf('export async function payBooking('));
    const payRead = core.slice(
        core.indexOf('export async function readBookingPayment('),
        core.indexOf('export async function payBooking('),
    );

    assert('in scope: both halves of the pay screen are found', () =>
        pay.length > 0 && payRead.length > 0);

    /**
     * ⭐ **THE AMOUNT IS NEVER HELD.** The `bp` session carries a booking id and a purpose; a
     * figure in it is a figure that can disagree with what is actually charged a minute later,
     * and a balance in particular moves when the vendor settles the appointment. Both the read
     * and the write resolve it from the booking, at the moment they run.
     */
    /**
     * ⚠ **Line-anchored, because "contains the right call" is not "uses only the right call".**
     * The first version asserted that the read CONTAINED `amountDueFor(...)`, and a mutant that
     * preferred a session figure and fell back to the call — `session.amount ?? amountDueFor(…)` —
     * satisfied it exactly. The assertion has to be about what the amount IS, not about a string
     * appearing somewhere in the expression.
     */
    assert('⛔ the amount is re-resolved from the booking, never read from the session', () =>
        /\n\s*const amount = amountDueFor\(booking, session\.purpose\);\n/.test(payRead)
        // ⚠ Only a READ of an amount OFF the session is forbidden. An earlier version banned
        // "amount … session." on one line and so failed on the correct line itself, which reads
        // `const amount = amountDueFor(booking, session.purpose)`.
        && !/session[^\n]{0,40}\.(amount|price|total|amountText)\b/.test(core)
        && core.includes('function amountDueFor('));

    assert('⛔ the write SPENDS the handle, and the read does not', () =>
        pay.includes("inAppSurfaceStore.consume('bp'")
        && payRead.includes("inAppSurfaceStore.read('bp'")
        && !payRead.includes('consume('));

    /**
     * ⚠ **The gateway is the server's choice.** Every other entry point takes it from its caller
     * because those callers are the platform's own code; this one's caller is a browser, and a
     * gateway name from a browser is a caller choosing where a stranger's money goes.
     *
     * ADR-A08: nor does the page name the PROVIDER — the payer's number decides it, through the
     * one `mobileMoneyRoute`, and the settings decide who collects.
     */
    assert('⛔ the page never names the gateway', () =>
        pay.includes('mobileMoneyRoute(')
        && !pay.includes('mobileMoneyGateway(')
        && !/input\.(gateway|provider)/.test(pay));

    /**
     * ⚠ **Checked before the spend for a typed number, after it for the account's.** The typed
     * one can be judged immediately; the account's needs the session to find the customer. A
     * number no network can be resolved for must not cost the customer their screen. Before
     * either, whether any mobile provider is on offer at all.
     */
    assert('⛔ the mobile network is checked on both numbers, in that order', () => {
        const offeredAt = pay.indexOf('assertMobileMoneyOffered()');
        const typedAt = pay.indexOf('mobileMoneyRoute(typed, false)');
        const spendAt = pay.indexOf("inAppSurfaceStore.consume('bp'");
        const accountAt = pay.indexOf('const route = mobileMoneyRoute(payer.number, true, payer.savedProvider)');
        return offeredAt > 0 && typedAt > offeredAt && spendAt > typedAt && accountAt > spendAt;
    });

    assert('⛔ every refusal after the spend is marked spent', () =>
        pay.includes('throw markSpent(error);') && core.includes('function markSpent('));

    /**
     * ⭐ **THE SCREEN MAY NOT REACH A VERDICT, and this is the assertion that keeps it honest.**
     * The orchestrator publishes a booking failure ONLY where the gateway gave one — the webhook
     * and the verify sweep, on the transition into a dead status — and deliberately NOT from the
     * catch around the charge, where a timeout cannot be told from a refusal and the money may
     * still be moving. So nothing here may announce an outcome: no chat push, no situation, no
     * event. The customer hears it from the payment path or not at all.
     */
    assert('⛔ the pay path announces NOTHING — no push, no event, no situation', () =>
        !/pushReceipt|sendMessage|eventBus\.publish|notify\(/.test(pay));

    /**
     * ⚠ **Bounded at the handler's own end, because `pay` is the LAST method in the class** and a
     * slice to end-of-file swallows `pushReceipt`'s definition — which made this fail on correct
     * code the first time it ran. A span that runs past its subject is the defect this project
     * keeps meeting; here it pointed the wrong way, at code that was right.
     */
    assert('⛔ and the transport does not announce it either', () => {
        const screens = stripped(SCREENS);
        const at = screens.indexOf('static pay = asyncHandler');
        const end = screens.indexOf('\n    });', at);
        if (at < 0 || end < 0) return false;
        return !/pushReceipt|sendMessage/.test(screens.slice(at, end));
    });

    /**
     * The page is the other half of the same rule: it may say "sent", never "paid".
     *
     * ⚠ **JS comments are stripped as well as HTML ones.** The page EXPLAINS that it must not say
     * "paid", inside a `/* *\/` block in its script — so a scan that read only the markup failed
     * on the file that gets it right, which is how a correct guard teaches somebody to delete the
     * comment that makes the code legible.
     */
    assert('⛔ the page never claims the payment succeeded or failed', () => {
        const page = read('src/modules/bot-surface/miniapp/public/bp.html')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        /**
         * ⚠ **The property is "no VERDICT", not "no failure message".** An earlier version banned
         * only "paid" and "payment failed", which leaves the CHEERFUL direction open — a screen
         * saying "payment received" on its own authority is the same fault, and the easier one to
         * add later without anybody noticing, because it reads like good news rather than a bug.
         */
        return page.includes('copy.paySent')
            && !/\bpaid\b|payment (failed|received|confirmed|complete)|\bsuccessful\b/i.test(page);
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

    await phase6();

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

/**
 * Bookings phase 6 (`api-doc/n8n/BOOKINGS-PHASE-6-PLAN.md`) — the plumbing between three finished
 * screens and a customer.
 */
async function phase6(): Promise<void> {
    const core = stripped(CORE);
    const PAGES = ['bl', 'bk', 'bp'].map((k) => `src/modules/bot-surface/miniapp/public/${k}.html`);
    /** Script only — HTML and JS comments explain the rules and must not satisfy or fail them. */
    const pageScript = (rel: string): string =>
        read(rel).replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    console.log('\n══ § 6 · Step 1 — the copy reaches the three booking pages ══');

    /**
     * ⚠ **Every page under `public/`, not just the booking three.** The booking pages fetched
     * `/api/bot/miniapp/copy` — a route that has never existed — while the six others fetched
     * `base + "/copy"`. A 404 there is silent: every page falls back to inline English.
     */
    /**
     * ⚠ **Comment-stripped, deliberately** — the fix itself carries a comment NAMING the dead URL,
     * and a raw scan failed on the file that gets it right. The span this guards is the script's
     * CODE; a comment cannot fetch anything.
     */
    assert('⛔ no screen fetches the one-segment /api/bot/miniapp/copy', () => {
        const dir = 'src/modules/bot-surface/miniapp/public';
        const pages = fs.readdirSync(path.join(SCAN_ROOT, dir)).filter((f) => f.endsWith('.html'));
        return pages.length >= 9
            && pages.every((f) => !pageScript(`${dir}/${f}`).includes('/api/bot/miniapp/copy'))
            && PAGES.every((rel) => pageScript(rel).includes('json(base + "/copy?lang="'));
    });

    /**
     * ⚠ **Every word a booking page READS must be a word somebody SENDS.** `bk.html` read
     * `copy.sent` for months while `BookingScreenCopy` had no such key, so its "done" line was the
     * inline English fallback in every language. The two tables a booking page receives are the
     * `/copy` route's (`inAppCopy`) and the data's (`bookingScreenCopy`).
     */
    assert('⛔ every copy.<key> a booking page reads is a key one of its two tables sends', () => {
        const sent = new Set([...Object.keys(bookingScreenCopy('en')), ...Object.keys(inAppCopy('en'))]);
        const read_ = PAGES.flatMap((rel) =>
            [...pageScript(rel).matchAll(/\bcopy\.([A-Za-z]+)/g)].map((m) => m[1]));
        const missing = [...new Set(read_)].filter((key) => !sent.has(key));
        if (missing.length) console.error(`      read but never sent: ${missing.join(', ')}`);
        return read_.length > 10 && missing.length === 0;
    });

    /**
     * ⚠ **Line-anchored on the RETURN, and on the signature.** `bl.html` reads `data.copy`, and a
     * fixture that supplies one proves the page renders, not that the read sends it — which is
     * exactly how an English-only list looked healthy.
     */
    assert('⛔ readCustomerBookings sends the screen\'s words with its rows', () => {
        const list = spanOf(core, 'export async function readCustomerBookings(', '\n}\n');
        return /\n\s*return \{ copy: bookingScreenCopy\(language\), bookings \};\n/.test(list)
            && /Promise<\{ copy: ReturnType<typeof bookingScreenCopy>; bookings: /.test(list);
    });

    assert('the three new page words exist in all five languages, none left English', () => {
        const en = bookingScreenCopy('en');
        return (['fr', 'pt', 'es', 'ar'] as const).every((lang) => {
            const copy = bookingScreenCopy(lang);
            return (['sent', 'slotTaken', 'payNothingDue'] as const).every((key) =>
                typeof copy[key] === 'string' && copy[key].length > 0 && copy[key] !== en[key]);
        });
    });

    /**
     * ⭐ **A lost slot is explained as a lost slot, and reports nothing about payment (M-16).**
     * ⚠ And Back stays disabled: the confirm spent the handle, so the day list would answer "no
     * longer available". The sentence sends the customer to the chat instead.
     */
    /**
     * ⚠ The "never re-enabled" half is bounded to the CONFIRM handler — choosing a slot enables
     * Confirm elsewhere on the page, correctly, and a page-wide ban failed on that line.
     */
    assert('⛔ bk: a 409 says slotTaken, and the confirm handler re-enables neither button', () => {
        const page = pageScript(PAGES[1]);
        const confirm = spanOf(page, 'el.confirm.addEventListener("click"', '\n  });\n');
        return /if \(res\.status === 409\) return copy\.slotTaken/.test(page)
            && confirm.includes('sent = true;')
            && !/\.disabled = false/.test(confirm);
    });

    assert('⛔ bp: the page\'s "nothing due" codes are exactly the ones the read throws', () => {
        const page = pageScript(PAGES[2]);
        const list = page.slice(page.indexOf('var NOTHING_DUE = ['), page.indexOf('];', page.indexOf('var NOTHING_DUE = [')));
        const codes = [...list.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
        return codes.length === NOTHING_DUE_CODES.length
            && JSON.stringify(codes) === JSON.stringify([...NOTHING_DUE_CODES].sort())
            // Checked before the 400/422 branch, which would show the registry's English message.
            && page.indexOf('NOTHING_DUE.indexOf(error.code)') < page.indexOf('res.status === 400 || res.status === 422');
    });

    console.log('\n══ § 7 · Step 2 — the bookings list: next first, a word per row, payable ══');

    const NOW = new Date('2026-09-27T10:00:00Z');
    const at = (iso: string) => new Date(iso);
    const row = (over: Partial<CustomerBookingSource> & { id: string }): CustomerBookingSource => ({
        _id: over.id,
        vendorId: over.vendorId ?? 'v1',
        bookingNumber: `BKG-2026-${over.id.padStart(6, '0')}`,
        productId: { title: 'Coupe de cheveux et barbe pour homme' },
        status: 'confirmed',
        paymentStatus: 'paid',
        requiresPayment: true,
        settlement: undefined,
        startAt: at('2026-10-01T09:00:00Z'),
        ...over,
    } as CustomerBookingSource);

    const far = row({ id: '1', startAt: at('2026-11-20T09:00:00Z') });
    const near = row({ id: '2', startAt: at('2026-09-28T09:00:00Z') });
    const past = row({ id: '3', startAt: at('2026-09-01T09:00:00Z'), status: 'completed' as never });

    /**
     * ⭐ **The NEXT appointment first.** The list used to sort `startAt` descending, which put the
     * one furthest in the future on top and buried the one the customer is about to attend.
     */
    assert('⛔ upcoming first, nearest on top; the past after it', () => {
        const ordered = orderUpcomingFirst([far, past, near], NOW);
        return ordered.map((r) => r._id).join(',') === '2,1,3';
    });

    assert('⛔ the read asks for upcoming ascending, then the past descending', () => {
        const list = spanOf(core, 'export async function readCustomerBookings(', '\n}\n');
        const upcomingAt = list.indexOf('startAt: { $gte: now } })\n        .sort({ startAt: 1 })');
        const pastAt = list.indexOf('startAt: { $lt: now } })\n            .sort({ startAt: -1 })');
        return upcomingAt > 0 && pastAt > upcomingAt && list.includes('projectCustomerBookings(');
    });

    await assertAsync('⛔ the shop\'s timezone is read once per DISTINCT vendor, not per row', async () => {
        let reads = 0;
        await projectCustomerBookings(
            [far, near, past, row({ id: '4', vendorId: 'v2' }), row({ id: '5', vendorId: 'v2' })],
            {
                language: 'fr', now: NOW, limit: 20,
                timezoneOf: async () => { reads += 1; return 'Africa/Douala'; },
                when: () => 'lun. 28 sept. 10:00',
            },
        );
        return reads === 2;
    });

    const project = (rows: CustomerBookingSource[], language: string, when: (d: Date) => string) =>
        projectCustomerBookings(rows, {
            language, now: NOW, limit: 20,
            timezoneOf: async () => 'Africa/Douala',
            when: (d) => when(d),
        });

    await assertAsync('⛔ a cancelled appointment carries its word — in FRENCH — and no Pay', async () => {
        const [out] = await project([row({ id: '6', status: 'cancelled' as never, paymentStatus: 'unpaid' })], 'fr', () => 'lun. 28 sept. 10:00');
        return out.status === 'cancelled'
            && out.statusLabel === 'Annulé'
            && out.description === 'BKG-2026-000006 · Annulé'
            && out.payable === null;
    });

    /**
     * ⭐ **Two rows for one service, checked in FRENCH and ARABIC through the real projection** —
     * not through `fitBookingRowTitle` alone, which the rows could stop calling.
     */
    for (const [lang, times] of [['fr', ['lun. 28 sept. 14:00', 'lun. 28 sept. 17:00']], ['ar', ['الاثنين ٢٨ سبتمبر ١٤:٠٠', 'الاثنين ٢٨ سبتمبر ١٧:٠٠']]] as const) {
        await assertAsync(`⛔ two appointments for one service stay distinct rows in ${lang.toUpperCase()}, within 24`, async () => {
            const a = row({ id: '7', startAt: at('2026-09-28T13:00:00Z') });
            const b = row({ id: '8', startAt: at('2026-09-28T16:00:00Z') });
            const service = lang === 'ar' ? 'قص الشعر وتهذيب اللحية للرجال' : 'Coupe de cheveux et barbe pour homme';
            (a.productId as { title: string }).title = service;
            (b.productId as { title: string }).title = service;
            const out = await project([a, b], lang, (d) => (d.getTime() === a.startAt.getTime() ? times[0] : times[1]));
            return out.length === 2
                && out[0].title !== out[1].title
                && out.every((r) => r.title.length <= 24 && r.description.length <= 72);
        });
    }

    // 20 spelled out: it is what the description's room leaves, not a number read from the module.
    assert('every row word is ≤ 20 characters in all five languages', () => {
        const keys: BookingRowStatus[] = ['awaitingShop', 'unpaid', 'balanceDue', 'cancelled', 'done', 'missed'];
        return LANGUAGES.every((lang) => keys.every((key) => {
            const word = bookingRowStatusLabel(key, lang);
            return word.length > 0 && word.length <= 20;
        }))
            && (['fr', 'ar'] as const).every((lang) => bookingRowStatusLabel('cancelled', lang) !== bookingRowStatusLabel('cancelled', 'en'));
    });

    /**
     * ⭐ **Which charge a Pay control would open — and never on an appointment the shop has not
     * accepted, a charge already in flight, or a refund.**
     */
    assert('⛔ payable: the price only while unpaid/failed and ACCEPTED; a balance only when completed', () => {
        const c = (o: Partial<CustomerBookingSource>) => bookingPayable(row({ id: '9', ...o }));
        return c({ paymentStatus: 'unpaid' }) === 'primary'
            && c({ paymentStatus: 'failed' }) === 'primary'
            && c({ paymentStatus: 'pending' }) === null
            && c({ paymentStatus: 'paid' }) === null
            && c({ paymentStatus: 'refunded' }) === null
            && c({ paymentStatus: 'unpaid', status: 'pending' as never }) === null
            && c({ paymentStatus: 'unpaid', status: 'cancelled' as never }) === null
            && c({ paymentStatus: 'unpaid', requiresPayment: false }) === null
            && c({ status: 'completed' as never, settlement: { balanceDue: 5000, balancePaid: 0 } as never }) === 'balance'
            && c({ status: 'completed' as never, settlement: { balanceDue: 5000, balancePaid: 5000 } as never }) === null;
    });

    /** M-1 on the list: `payable` names a charge and carries no figure. */
    await assertAsync('⛔ a row carries NO amount — the figure is bp\'s to resolve', async () => {
        const [out] = await project([row({ id: '10', paymentStatus: 'unpaid' })], 'en', () => 'x');
        const keys = Object.keys(out);
        return out.payable === 'primary'
            && !keys.some((k) => /amount|price|total|balance|due/i.test(k));
    });

    console.log('\n══ § 8 · Step 3 — an unchargeable booking is refused at the READ ══');

    const due = (o: Partial<CustomerBookingSource>, purpose: 'primary' | 'balance') =>
        refusalCode(() => assertSomethingDue(row({ id: '11', ...o }), purpose));

    assert('⛔ cancelled · paid price · nothing required · settled balance — each refused, by its code', () =>
        due({ status: 'cancelled' as never, paymentStatus: 'unpaid' }, 'primary') === 'PAYMENT_BOOKING_CANCELLED'
        && due({ paymentStatus: 'paid' }, 'primary') === 'PAYMENT_BOOKING_ALREADY_PAID'
        && due({ requiresPayment: false, paymentStatus: 'unpaid' }, 'primary') === 'PAYMENT_BOOKING_NO_PAYMENT_REQUIRED'
        && due({ status: 'completed' as never, settlement: { balanceDue: 900, balancePaid: 900 } as never }, 'balance') === 'BOOKING_BALANCE_ALREADY_SETTLED');

    assert('…and an unpaid price or an open balance is NOT refused', () =>
        due({ paymentStatus: 'unpaid' }, 'primary') === null
        && due({ status: 'completed' as never, settlement: { balanceDue: 900, balancePaid: 100 } as never }, 'balance') === null);

    /**
     * ⚠ **Line-anchored, and ordered.** The refusal must run at the read and BEFORE the amount is
     * resolved — a refusal at Pay has already spent the handle (M-4) and leaves the page latched.
     */
    assert('⛔ readBookingPayment refuses before it resolves an amount; payBooking is not where it lives', () => {
        const payRead = spanOf(core, 'export async function readBookingPayment(', 'export async function payBooking(');
        const guardAt = payRead.search(/\n\s*assertSomethingDue\(booking, session\.purpose\);\n/);
        const amountAt = payRead.search(/\n\s*const amount = amountDueFor\(booking, session\.purpose\);\n/);
        return guardAt > 0 && amountAt > guardAt;
    });

    console.log('\n══ § 9 · Step 4 — the outcome is told in the chat the customer paid in ══');

    /**
     * ⭐ **M-12.** The chat is the SESSION's — stamped by `openInAppScreen` from the request
     * envelope — and never anything the page sent. A page choosing where somebody's receipt goes
     * is a page redirecting it.
     */
    assert('⛔ payBooking hands the orchestrator the SESSION\'s chat, on both purposes', () => {
        const pay = spanOf(core, 'export async function payBooking(', '\n}\n');
        return /\n\s*const origin = \{ originChat: session\.channel \};\n/.test(pay)
            && /initiateBookingBalancePayment\(String\(booking\._id\), route, channel, origin\)/.test(pay)
            && /initiateBookingPayment\(String\(booking\._id\), route, channel, origin\)/.test(pay)
            && !/originChat:\s*input\./.test(pay);
    });

    assert('⛔ the chat routes bookings_pay and pay-balance with the ENVELOPE\'s channel', () => {
        const ctl = stripped('src/modules/bot-surface/controllers/bot-booking.controller.ts');
        const pay = spanOf(ctl, 'static pay = asyncHandler', 'static payBalance = asyncHandler');
        const balance = spanOf(ctl, 'static payBalance = asyncHandler', 'static cancel = asyncHandler');
        const stamp = '{ originChat: req.bot!.envelope.channel }';
        return pay.includes('initiateBookingPayment(') && pay.includes(stamp)
            && balance.includes('initiateBookingBalancePayment(') && balance.includes(stamp);
    });

    console.log('\n══ § 10 · Step 5 — `bp` gets its door, and "Try again" stops lying ══');

    const HEX = 'a1b2c3d4e5f6a7b8c9d0e1f2';

    // 64 is Telegram's callback_data cap in BYTES — spelled out, not read from the module.
    assert('bpay tokens: 29 and 31 bytes, and they round-trip through the one parser', () => {
        const price = bookingPayActionId(HEX, 'primary');
        const balance = bookingPayActionId(HEX, 'balance');
        const back = parseBookingPayArgument(balance.slice('bpay:'.length));
        return Buffer.byteLength(price) === 29 && Buffer.byteLength(balance) === 31
            && JSON.stringify(parseBookingPayArgument(price.slice(5))) === JSON.stringify({ bookingId: HEX, purpose: 'primary' })
            && back?.purpose === 'balance' && back.bookingId === HEX;
    });

    /**
     * ⭐ **M-13: a handle never travels in a chat button.** The parser takes a 24-hex booking id and
     * nothing else — an `ia_` handle, a longer string, or a stray suffix is an unknown tap.
     */
    assert('⛔ the bpay parser accepts a booking id and refuses a handle or any other shape', () =>
        parseBookingPayArgument('ia_0123456789abcdef0123456789abcdef') === null
        && parseBookingPayArgument(`${HEX}:x`) === null
        && parseBookingPayArgument(`${HEX}:b:b`) === null
        && parseBookingPayArgument(HEX.toUpperCase()) === null
        && parseBookingPayArgument('') === null);

    const ctl = stripped('src/modules/bot-surface/controllers/bot-booking.controller.ts');
    const payTap = spanOf(ctl, 'async function bookingPayTap(', '\n}\n');

    /**
     * ⚠ **Ordered, and each position must EXIST before it is compared** — a missing call makes
     * `indexOf` −1, which is "before" everything and would pass hardest once the rule had gone.
     * Ownership, then the refusal, then the mint.
     */
    assert('⛔ bpay: owner-scoped read (404), then the refusal, then the mint — in that order', () => {
        const owned = payTap.indexOf('bookingService.getUserBooking(target.bookingId, botCallerOf(req).userId)');
        const refused = payTap.indexOf('assertSomethingDue(booking, target.purpose)');
        const minted = payTap.indexOf('openInAppScreen(req, {');
        return owned > 0 && refused > owned && minted > refused
            && payTap.includes("payload: { kind: 'bp', bookingId: target.bookingId, purpose: target.purpose }")
            && !/\b403\b|FORBIDDEN/.test(payTap);
    });

    /** Trap 10 of the plan: `BOT_MINIAPP_BASE_URL` is unset in production, so this path RUNS. */
    assert('⛔ bpay passes a real fallbackPath, never null', () =>
        /fallbackPath: target\.purpose === 'balance' \? `\$\{bookingPath\}\/balance` : bookingPath,/.test(payTap)
        && /const bookingPath = `\$\{surfacePath\('bookings'\)\}\/\$\{target\.bookingId\}`;/.test(payTap)
        && !/fallbackPath:\s*null/.test(payTap));

    assert('the bpay handler is registered in the bookings map', () =>
        /export const BOOKING_ACTION_HANDLERS[^;]*\n\s*bpay: bookingPayTap,/.test(ctl));

    /**
     * ⭐ **A token can be drawn AND routed AND still be a dead end** — `pay:rt:` under a booking was
     * green in every suite and answered about ORDERS, because its handler filters
     * `cartId: { $ne: null }` (`resolveCheckoutPayment`) and a booking transaction has no cart.
     * So every token any `booking.*` situation can draw is checked against the keys whose handlers
     * are KNOWN to serve a booking — an allowlist, named here, not derived from the registry,
     * because "routed" is exactly the property that was not enough.
     */
    /**
     * `tkt` is here because `booking.rescheduled` draws `tkt:new` and `parseTicketTap` gives the
     * bare form `orderId: null` — a support request needs no order. Verified 2026-09-27, not
     * assumed; `pay` is absent on purpose, and that absence is this assertion.
     */
    const SERVES_A_BOOKING = new Set(['bpay', 'book', 'open:bl', 'tkt']);
    assert('⛔ no booking.* notification draws a token whose handler cannot serve a booking', () => {
        const bookingSituations = Object.keys(CUSTOMER_NOTIFICATION_CATALOG).filter((s) => s.startsWith('booking.'));
        const tokens = bookingSituations.flatMap((s) =>
            ((CUSTOMER_NOTIFICATION_CATALOG as Record<string, { actions?: Array<{ token: string }> }>)[s].actions ?? [])
                .map((a) => ({ s, token: a.token.replace(/\{\{\s*\w+\s*\}\}/g, HEX) })));
        const bad = tokens.filter(({ token }) => {
            const parsed = parseBotActionId(token);
            return !parsed || !SERVES_A_BOOKING.has(actionKeyOf(parsed).key);
        });
        if (bad.length) console.error(`      ${bad.map((b) => `${b.s} → ${b.token}`).join('; ')}`);
        return bookingSituations.length >= 5 && tokens.some((t) => t.token.startsWith('bpay:')) && bad.length === 0;
    });

    assert('⛔ every bpay the catalogue writes parses with the builder\'s own parser', () => {
        const all = Object.values(CUSTOMER_NOTIFICATION_CATALOG as Record<string, { actions?: Array<{ token: string }> }>)
            .flatMap((entry) => entry.actions ?? [])
            .map((a) => a.token)
            .filter((t) => t.startsWith('bpay:'));
        return all.length >= 3
            && all.every((t) => parseBookingPayArgument(t.replace(/\{\{\s*\w+\s*\}\}/g, HEX).slice(5)) !== null);
    });

    /** Rendered through the real renderer: exactly one Try again, pointing at the right charge. */
    assert('⛔ a failed PRICE draws bpay:<id>; a failed BALANCE draws bpay:<id>:b — never both', () => {
        const price = renderCustomerQuickReplies('booking.payment_failed', 'fr', { payPriceBookingId: HEX, payBalanceBookingId: '' } as never);
        const balance = renderCustomerQuickReplies('booking.payment_failed', 'fr', { payPriceBookingId: '', payBalanceBookingId: HEX } as never);
        return price.length === 1 && price[0].token === `bpay:${HEX}`
            && balance.length === 1 && balance[0].token === `bpay:${HEX}:b`;
    });

    assert('booking.balance.due offers bpay:<id>:b in chat, and keeps its URL button', () => {
        const replies = renderCustomerQuickReplies('booking.balance.due', 'en', { bookingId: HEX } as never);
        const entry = (CUSTOMER_NOTIFICATION_CATALOG as Record<string, { button?: unknown }>)['booking.balance.due'];
        return replies.length === 1 && replies[0].token === `bpay:${HEX}:b` && Boolean(entry.button);
    });

    console.log('\n══ § 11 · Step 6 — `bk` gets its door: Book opens the picker ══');

    assert('open:bk:<productId> is 32 bytes and carries the product id, not a handle', () => {
        const [action] = bookInviteActions(HEX, 'fr');
        return action.id === `open:bk:${HEX}` && Buffer.byteLength(action.id) === 32;
    });

    // 20 is WhatsApp's reply-button title cap — a literal, per the caps rule in § 4.
    assert('"Choose a time" fits a button in all five languages, and is translated', () =>
        LANGUAGES.every((lang) => {
            const label = bookInviteActions(HEX, lang)[0].label;
            return label.length > 0 && label.length <= 20;
        })
        && bookInviteActions(HEX, 'fr')[0].label !== bookInviteActions(HEX, 'en')[0].label
        && bookInviteActions(HEX, 'ar')[0].label !== bookInviteActions(HEX, 'en')[0].label);

    const pickTap = spanOf(ctl, 'async function bookingPickerTap(', '\n}\n');

    /**
     * ⚠ **Refused by the availability read ITSELF**, before anything is minted: an unknown,
     * unpublished or suspended product is the read's own 404, a non-service its 422. A copy of those
     * rules here would be a second opinion — ordered, and each position must exist.
     */
    assert('⛔ open:bk: 24-hex id, then the availability read\'s own refusals, then the mint', () => {
        const shape = pickTap.indexOf('if (!/^[0-9a-f]{24}$/.test(productId)) throw unknownBotAction();');
        const refused = pickTap.indexOf('await readBookingDays({ productId,');
        const minted = pickTap.indexOf('openInAppScreen(req, {');
        return shape > 0 && refused > shape && minted > refused
            && pickTap.includes("payload: { kind: 'bk', productId, bookingId: null }")
            && !/ProductModel|isPublishableProduct|type !== 'service'/.test(pickTap);
    });

    assert('⛔ open:bk falls back to the product\'s own page, never null', () =>
        pickTap.includes('fallbackPath: `/shop/p/${productId}`,') && !/fallbackPath:\s*null/.test(pickTap));

    assert('the open:bk handler is registered in the bookings map', () =>
        /export const BOOKING_ACTION_HANDLERS[^;]*\n\s*'open:bk': bookingPickerTap,/.test(ctl));

    /**
     * The button is drawn by the `book` tap and ONLY there: `bargain`'s next step is an offer, and
     * the invitation's question is kept for the customer who would rather type.
     */
    /**
     * ⭐ **Straight to the picker** (owner, 2026-09-27): with a screen, the question AND a button
     * that opens the picker itself; without one, the `open:bk` tap. Bargain draws nothing.
     */
    assert('⛔ the Book reply keeps its question and opens the picker directly; Bargain draws nothing', () => {
        const purchase = stripped('src/modules/bot-surface/controllers/bot-purchase.controller.ts');
        const reply = spanOf(purchase, 'function replyForPurchase(', '\n}\n');
        return reply.includes("if (result.verb !== 'book') return { kind: 'text', text: result.message };")
            && /result\.url\s*\?\s*\{ kind: 'inapp', text: result\.message, label: botChrome\('bookChooseTimeButton', language\), url: result\.url \}\s*:\s*\{ kind: 'text', text: result\.message, actions: bookInviteActions\(result\.productId, language\) \}/.test(reply)
            && purchase.includes("message: purchaseInvitePrompt(product.title, 'book', language),");
    });

    console.log('\n══ § 12 · Owner decisions of 2026-09-27 ══');

    const purchase = stripped('src/modules/bot-surface/controllers/bot-purchase.controller.ts');

    // ── #4 / #5 — every Book offers the picker ──────────────────────────────────────────────
    /**
     * The picker is minted in the ONE shared purchase path, so the chat tap and the product screen
     * cannot disagree. Checked against the screen origin BEFORE minting (checkout's rule), and it
     * holds no slot — `bookingId: null`, and the hold is Confirm's.
     */
    assert('⛔ Book mints the picker in the shared path — origin checked first, no slot held', () => {
        const mint = spanOf(purchase, 'async function mintPickerUrl(', '\n}\n');
        const origin = mint.indexOf('if (!inAppBaseUrl()) return null;');
        const minted = mint.indexOf('inAppSurfaceStore.mint({');
        return origin > 0 && minted > origin
            && mint.includes("kind: 'bk',") && mint.includes('bookingId: null,')
            && mint.includes('owner: ctx.userId,') && mint.includes('channel: ctx.channel,')
            && purchase.includes('url: await mintPickerUrl(ctx, productId),');
    });

    assert('⛔ the product screen goes straight to the picker and pushes no question into the chat', () => {
        const straight = purchase.includes("const straightToPicker = result.verb === 'book' && result.url !== null;")
            && purchase.includes("if (result.outcome === 'chat' && !straightToPicker) {")
            && purchase.includes("...(result.outcome === 'checkout' || straightToPicker ? { url: result.url } : {}),");
        const page = pageScript('src/modules/bot-surface/miniapp/public/pd.html');
        return straight
            && page.includes('if ((out.outcome === "checkout" || out.outcome === "chat") && out.url) { window.location.assign(out.url); return; }');
    });

    /**
     * The WhatsApp form's completion is CALLER-SUPPLIED, so it gets the tap (which mints for
     * whoever tapped), never a screen minted from the completion itself.
     */
    assert('⛔ the WhatsApp form offers Choose a time on Book only, as a tap — never a minted screen', () => {
        const flow = stripped('src/modules/whatsapp/flows/commands/flow-complete.command.ts');
        const invite = spanOf(flow, "if (plan.kind === 'invite_reply') {", '\n    }\n');
        return invite.includes("...(verb === 'book' ? { actions: bookInviteActions(plan.productId, language) } : {}),")
            && !invite.includes("kind: 'bk'");
    });

    // ── #2 — WhatsApp customers get the receipt too ─────────────────────────────────────────
    const screens = stripped(SCREENS);
    const receipt = spanOf(screens, 'async function pushReceipt(', '\n}\n');

    /**
     * ⛔ It returned early for WhatsApp on the false premise that WhatsApp uses Flows. Now both
     * apps get the SAME full receipt and the SAME My bookings button — and since the platform's
     * own message is no longer sent for a chat booking (#1), this is the only confirmation.
     */
    assert('⛔ the picker\'s receipt reaches WhatsApp too: same sentence, same My bookings button', () => {
        const wa = receipt.indexOf("if (channel === 'whatsapp') {");
        return wa > 0
            && receipt.indexOf("if (channel !== 'telegram') return;") > wa
            && !/if \(channel !== 'telegram'\) return;[\s\S]*if \(channel === 'whatsapp'\)/.test(receipt)
            && receipt.includes('sendButtons({')
            && receipt.includes('body: text,')
            && receipt.includes('buttons: [{ id: myBookings.token, title: myBookings.label }],')
            && receipt.includes("token: openSurfaceActionId('bl')")
            && receipt.includes('callbackData: myBookings.token,');
    });

    // ── #1 — one message, in the chat they booked from ──────────────────────────────────────
    assert('⛔ both chat booking doors mark the booking with the SERVER-KNOWN chat', () => {
        const confirmBody = spanOf(core, 'export async function confirmBooking(', '\n}\n');
        const create = spanOf(ctl, 'static create = asyncHandler', 'static reschedule = asyncHandler');
        return confirmBody.includes("{ ...(input.notes ? { notes: input.notes } : {}), bookedInChat: session.channel },")
            && create.includes('bookedInChat: req.bot!.envelope.channel,')
            && !/bookedInChat:\s*(input|req\.body)/.test(confirmBody + create);
    });

    // ── #3 — Pay from the appointments list ─────────────────────────────────────────────────
    const listRefusal = (o: Partial<CustomerBookingSource>) =>
        refusalCode(() => payPurposeOrRefuse(row({ id: '12', ...o })));
    const purposeOf = (o: Partial<CustomerBookingSource>) => {
        try { return payPurposeOrRefuse(row({ id: '13', ...o })); } catch { return null; }
    };

    assert('⛔ the list\'s Pay re-decides at the tap: price, balance, or a refusal with its reason', () =>
        purposeOf({ paymentStatus: 'unpaid' }) === 'primary'
        && purposeOf({ status: 'completed' as never, settlement: { balanceDue: 900, balancePaid: 0 } as never }) === 'balance'
        && listRefusal({ paymentStatus: 'paid' }) === 'PAYMENT_BOOKING_ALREADY_PAID'
        && listRefusal({ status: 'cancelled' as never, paymentStatus: 'unpaid' }) === 'PAYMENT_BOOKING_CANCELLED'
        && listRefusal({ paymentStatus: 'pending' }) === 'PAYMENT_BOOKING_IN_PROGRESS'
        && listRefusal({ status: 'pending' as never, paymentStatus: 'unpaid' }) === 'BOOKING_NOT_PAYABLE_NOW');

    /**
     * ⛔ The page names a booking id and NOTHING else. Ownership is the LIST's owner in the query
     * (404 for anybody else's), the list handle is READ not spent, and the new `bp` session takes
     * owner, chat and language from the list session — so the payment's result goes to this
     * customer's own conversation, and no amount travels anywhere.
     */
    assert('⛔ opening Pay from the list: owner-scoped, list not spent, session fields not the page\'s', () => {
        const open = spanOf(core, 'export async function openPaymentFromList(', '\n}\n');
        const readAt = open.indexOf("inAppSurfaceStore.read('bl', handle)");
        const ownedAt = open.indexOf('await payableBooking(bookingId, session.owner)');
        const decidedAt = open.indexOf('payPurposeOrRefuse(booking)');
        const mintAt = open.indexOf('inAppSurfaceStore.mint({');
        const mint = open.slice(mintAt);
        return readAt > 0 && ownedAt > readAt && decidedAt > ownedAt && mintAt > decidedAt
            && !open.includes('consume(')
            && ['owner: session.owner,', 'customerId: session.customerId,', 'channel: session.channel,',
                'externalId: session.externalId,', 'language: session.language,'].every((f) => mint.includes(f))
            && !/\b(amount|price|total)\b/.test(mint);
    });

    assert('the list\'s Pay route is mounted, and answers a same-origin URL', () => {
        const routes = stripped('src/modules/bot-surface/miniapp/miniapp.routes.ts');
        const open = spanOf(screens, 'static openPay = asyncHandler', '\n    });\n');
        return routes.includes("router.post('/s/bl/:handle/pay', BookingScreensController.openPay);")
            && open.includes('`${__IN_APP_SCREEN_PATH}/bp/${opened.handle}?lang=${toBotCopyLanguage(opened.language)}`')
            && open.includes('{ bookingId: body.bookingId }');
    });

    /** The page decides nothing about money: a button only where the SERVER said payable. */
    assert('⛔ bl draws Pay only where the server said payable, and sends only the booking id', () => {
        const page = pageScript(PAGES[0]);
        return page.includes('+ (booking.payable')
            && page.includes('body: JSON.stringify({ bookingId: button.getAttribute("data-pay") })')
            && page.includes('json(base + "/pay", {')
            && !/amount|price/i.test(page);
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
