/**
 * Test: the booking number, and the booking notifications that name it.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free — everything here is either pure formatting or a source
 * scan.
 *
 * ── What it pins, and why each one is worth a test ──────────────────────────
 *
 *  1. **Producer ↔ consumer field agreement on the `booking.*` events.** This is
 *     the whole point of the file. `DomainEvent.payload` is untyped, so a handler
 *     that destructures `bookingNumber, serviceName, startTime` from an event
 *     carrying `productTitle, vendorName, startAt` compiles perfectly and agrees
 *     with the producer on nothing. That is exactly what shipped: every vendor
 *     was sent "New booking # for scheduled on Invalid Date." in five languages,
 *     over in-app, email and Telegram, and the WhatsApp send failed outright
 *     because Meta rejects an empty template parameter. No type-checker, linter
 *     or runtime error could see it — the empty string IS the designed rendering
 *     of a missing value (`message-renderer.ts`), so the defect looks like copy.
 *     A source scan is the only instrument that sees it, which is why this exists.
 *
 *  2. **Every catalog placeholder is supplied by its handler.** The narrower,
 *     cheaper half of the same rule, for the booking situations.
 *
 *  3. **WhatsApp `bodyParams` cover the whole body.** A placeholder in the copy
 *     that is not a body param means the approved template CANNOT say what the
 *     in-window text says — five customer templates already carry that defect and
 *     each needed a hand-written substitute body. The vendor booking templates
 *     must not join them.
 *
 *  4. **`bodyParams.length` matches the template registry.** Meta rejects a send
 *     whose parameter count differs from the approved template, and the failure
 *     surfaces only at delivery time, to one vendor, in a log.
 *
 *  5. **The booking number's format**, including the two things about it that are
 *     easy to get wrong later: the year is UTC, and the sequence widens rather
 *     than truncating past six digits.
 *
 * Run: npm run test:booking-notification
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    NOTIFICATION_CATALOG,
    renderInApp,
    renderWhatsAppTemplateParams
} from '../../src/modules/notifications/catalog/notification-catalog';
import { SUPPORTED_LANGUAGES, Language } from '../../src/modules/notifications/catalog/notification-i18n';
import {
    formatBookingNumber,
    BOOKING_NUMBER_PATTERN
} from '../../src/modules/booking/utils/booking-number.generator';

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

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

const BOOKING_SERVICE = read('modules/booking/services/booking.service.ts');
const VENDOR_HANDLER = read('modules/notifications/services/vendor-notification-event-handler.service.ts');
const CUSTOMER_HANDLER = read('modules/notifications/services/customer-notification-event-handler.service.ts');
const TEMPLATE_REGISTRY = read('modules/whatsapp/handlers/template/template-registry.ts');

// ─── Source-scan helpers ─────────────────────────────────────────────────────

/**
 * The span of a balanced `{...}` / `[...]` / `(...)` starting at the first opener
 * at or after `from`. Returns the INNER text.
 *
 * Naive about strings and comments containing braces. Every caller strips
 * comments from the extracted body BEFORE parsing it — see stripComments, and
 * read its warning: doing it the other way round silently loses keys.
 */
function balancedBody(src: string, from: number, opener = '{'): string {
    const closer = { '{': '}', '[': ']', '(': ')' }[opener as '{' | '[' | '('];
    const start = src.indexOf(opener, from);
    if (start === -1) return '';
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        if (src[i] === opener) depth++;
        else if (src[i] === closer) {
            depth--;
            if (depth === 0) return src.slice(start + 1, i);
        }
    }
    return '';
}

/**
 * The field names a `eventBus.publish('<type>', { ... payload: { ... } })` call
 * puts on its payload.
 *
 * Keys only — not values. `vendorName: await this.resolve(...)` contributes
 * `vendorName`, and a spread contributes the literal `...`, which the caller
 * treats as "cannot be verified here" rather than as a field.
 */
function publishedPayloadFields(src: string, eventType: string): Set<string> {
    const call = src.indexOf(`eventBus.publish('${eventType}'`);
    if (call === -1) return new Set();
    const args = balancedBody(src, call, '(');
    const payloadAt = args.indexOf('payload:');
    if (payloadAt === -1) return new Set();
    const rawBody = balancedBody(args, payloadAt);

    const body = stripComments(rawBody);

    const fields = new Set<string>();
    // Anchored at a line start so `productId: booking.productId.toString(),`
    // contributes `productId` and nothing from its value.
    for (const m of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) fields.add(m[1]);
    // Shorthand: `productTitle,` on its own line. The trailing comma is optional
    // because the LAST field of a literal may not have one — `previousStartAt` on
    // `booking.rescheduled` is exactly that, and requiring the comma reported a
    // published field as missing.
    for (const m of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/gm)) fields.add(m[1]);
    // A spread hides its fields from this scan entirely. Record it so callers can
    // refuse to draw a conclusion rather than silently reporting the spread
    // fields as absent.
    if (/^\s*\.\.\./m.test(body)) fields.add('...');
    return fields;
}

/**
 * The field names a handler reads out of `event.payload`, split by whether the
 * handler declared them OPTIONAL.
 *
 * Matches `const { a, b, c } = event.payload;` and the customer stack's
 * `const p = event.payload as { a: string; b?: Date };` — two different shapes
 * for the same act, and both have to be checked or half the surface is unpinned.
 *
 * ── Why the split matters ───────────────────────────────────────────────────
 *
 * A bare destructure states "this field is here"; a `?` states "it may not be,
 * and I have a fallback". Those are different claims and only the first is a
 * defect when it turns out to be false — which is why the vendor handler's
 * `const { bookingNumber, serviceName, startTime } = event.payload` shipped
 * broken while the customer handler's `productTitle?: string` beside the same
 * absent field renders "your service" and reads fine.
 *
 * So: an unpublished REQUIRED field fails the suite. An unpublished OPTIONAL one
 * is reported as dead weight and does not — it is a field to delete, not a
 * message to fix.
 */
function consumedPayloadFields(src: string, methodName: string): { required: Set<string>; optional: Set<string> } {
    const at = src.indexOf(`async ${methodName}(`);
    if (at === -1) return { required: new Set<string>(), optional: new Set<string>() };
    // Bound the search to this method: the next `async <name>(` at method indent.
    const next = src.slice(at + 1).search(/\n {4}(?:\/\*\*|(?:private |protected )?async [A-Za-z_$])/);
    // Comments stripped for the same reason as above — and here there is a second:
    // this handler's docstring NAMES the three fields the old broken version read,
    // so a scan that cannot tell prose from code would find them and report the
    // defect as still present.
    const body = stripComments(next === -1 ? src.slice(at) : src.slice(at, at + 1 + next));

    const required = new Set<string>();
    const optional = new Set<string>();

    // A plain destructure carries no optionality — every name in it is a claim
    // that the field is there.
    const destructure = body.indexOf('} = event.payload');
    if (destructure !== -1) {
        const open = body.lastIndexOf('{', destructure);
        for (const m of body.slice(open + 1, destructure).matchAll(/([A-Za-z_$][\w$]*)/g)) {
            required.add(m[1]);
        }
    }

    const cast = body.indexOf('event.payload as {');
    if (cast !== -1) {
        const inner = balancedBody(body, cast + 'event.payload as'.length);
        for (const m of inner.matchAll(/^\s*([A-Za-z_$][\w$]*)(\??)\s*:/gm)) {
            (m[2] === '?' ? optional : required).add(m[1]);
        }
    }

    return { required, optional };
}

/**
 * Source with block- and line-comments removed.
 *
 * Needed wherever an assertion says "this code must not mention X": the code that
 * deliberately avoids X usually documents that it does, and a scan that cannot
 * tell prose from code fails on its own explanation.
 *
 * ⚠ Every extractor below strips BEFORE it parses, never after. Prose contains
 * commas and colons, so a comment left in place can split an object literal
 * mid-sentence and swallow the key that follows — a false MISSING, which reads as
 * a defect in the code rather than in the scan.
 *
 * Naive about `//` inside a string literal (a URL). Nothing scanned here contains
 * one; check that before pointing it at another file.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The `{{placeholder}}` names in a string. */
function placeholdersIn(text: string): string[] {
    return [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
}

/**
 * Body-param count the template registry claims for a Meta template.
 *
 * A literal find plus a STATIC regex, rather than a built one: `new RegExp` is
 * banned repo-wide (`core/utils/regex.util`), and the ban is deliberately blunt —
 * it does not try to tell a safe interpolation from an unsafe one, so an
 * exemption here would be the first of a habit rather than a one-off. The name is
 * a literal from a closed list either way.
 */
function registryParamCount(name: string): number | null {
    const anchor = `['${name}',`;
    const at = TEMPLATE_REGISTRY.indexOf(anchor);
    if (at === -1) return null;
    const m = TEMPLATE_REGISTRY.slice(at + anchor.length).match(/^\s*(\d+)/);
    return m ? Number(m[1]) : null;
}

// ─── 1 · Producer ↔ consumer field agreement ─────────────────────────────────

console.log('\n1 · booking.* events: every field a handler reads is one the producer sends');

/**
 * Handlers keyed by the event they consume. `booking.created` has TWO consumers
 * with entirely different messages, and the vendor one is where the defect was.
 */
const CONSUMERS: Array<{ event: string; label: string; src: string; method: string }> = [
    { event: 'booking.created', label: 'vendor', src: VENDOR_HANDLER, method: 'handleBookingCreated' },
    { event: 'booking.created', label: 'customer', src: CUSTOMER_HANDLER, method: 'handleBookingCreated' },
    { event: 'booking.cancelled', label: 'vendor', src: VENDOR_HANDLER, method: 'handleBookingCancelled' },
    { event: 'booking.cancelled', label: 'customer', src: CUSTOMER_HANDLER, method: 'handleBookingCancelled' },
    { event: 'booking.confirmed', label: 'customer', src: CUSTOMER_HANDLER, method: 'handleBookingConfirmed' },
    { event: 'booking.rescheduled', label: 'customer', src: CUSTOMER_HANDLER, method: 'handleBookingRescheduled' },
    { event: 'booking.completed', label: 'customer', src: CUSTOMER_HANDLER, method: 'handleBookingCompleted' }
];

for (const consumer of CONSUMERS) {
    const published = publishedPayloadFields(BOOKING_SERVICE, consumer.event);

    assert(`${consumer.event} is published by BookingService with a payload`, () => published.size > 0);

    assert(`${consumer.event} → ${consumer.label} handler reads only published fields`, () => {
        const consumed = consumedPayloadFields(consumer.src, consumer.method);
        if (consumed.required.size + consumed.optional.size === 0) {
            console.error(`     scanned no fields out of ${consumer.method} — the scan is broken, not the code`);
            return false;
        }
        if (published.has('...')) {
            console.error(`     ${consumer.event}'s payload contains a spread — this scan cannot see through`);
            console.error('     one, so spell the fields out in the literal instead');
            return false;
        }

        // Dead weight, not a broken message: reported so it can be deleted, but it
        // renders a fallback rather than a hole. See consumedPayloadFields.
        const deadOptional = [...consumed.optional].filter((f) => !published.has(f));
        for (const f of deadOptional) {
            console.log(`     note: optional ${f} is never published — dead read, harmless`);
        }

        const unknown = [...consumed.required].filter((f) => !published.has(f));
        if (unknown.length > 0) {
            console.error(`     reads ${unknown.join(', ')} as REQUIRED — not on the ${consumer.event} payload`);
            console.error(`     payload carries: ${[...published].sort().join(', ')}`);
        }
        return unknown.length === 0;
    });
}

assert('booking.created carries the four fields the vendor message renders', () => {
    const published = publishedPayloadFields(BOOKING_SERVICE, 'booking.created');
    // Named individually rather than counted: each is the subject of a clause in
    // the vendor's copy, and each was the thing that rendered empty.
    return ['bookingNumber', 'productTitle', 'customerName', 'startAt', 'status'].every((f) =>
        published.has(f)
    );
});

assert('booking.created carries vendorTimezone', () => {
    // Separate assertion because it is the one field with no visible symptom when
    // it goes missing: the time still renders, in the server's zone, silently
    // wrong for every vendor who is not in it.
    return publishedPayloadFields(BOOKING_SERVICE, 'booking.created').has('vendorTimezone');
});

assert('booking.cancelled carries bookingNumber', () => {
    // The vendor's cancellation copy is one sentence whose only specific detail is
    // the number. Without it the message names no booking at all.
    return publishedPayloadFields(BOOKING_SERVICE, 'booking.cancelled').has('bookingNumber');
});

// ─── 2 · Catalog placeholders are supplied ───────────────────────────────────

console.log('\n2 · vendor booking templates: every placeholder is supplied by the handler');

/**
 * The context keys a vendor handler method passes to `dispatch`. Same anchored
 * extraction as above, over the `context: { ... }` object literal.
 */
function dispatchContextKeys(src: string, methodName: string): Set<string> {
    const at = src.indexOf(`async ${methodName}(`);
    if (at === -1) return new Set();
    const ctxAt = src.indexOf('context:', at);
    if (ctxAt === -1) return new Set();
    // COMMENTS FIRST, then split. The other order loses keys silently: prose
    // contains commas, so `// each is the subject of a clause, so each gets a`
    // splits mid-sentence and the key that follows lands in a fragment starting
    // with an ordinary word. That reported `bookingNumber` and `actionLine` as
    // unsupplied while the handler was supplying both.
    const body = stripComments(balancedBody(src, ctxAt));

    const keys = new Set<string>();
    // Not line-anchored: `context: { bookingNumber: x, bookingId }` is written on
    // ONE line in the cancelled handler, and a line-anchored scan finds nothing in
    // it — which reported a supplied placeholder as missing.
    //
    // Splitting at depth-0 commas rather than matching keys directly, so a value
    // containing a colon or a brace (`x ? a : b`, a nested object) cannot
    // contribute a phantom key.
    let depth = 0;
    let current = '';
    const parts: string[] = [];
    for (const ch of body) {
        if ('{[('.includes(ch)) depth++;
        else if ('}])'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);

    for (const part of parts) {
        const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
        if (m) keys.add(m[1]);
    }
    return keys;
}

const VENDOR_BOOKING_SITUATIONS: Array<{ situation: 'booking.created' | 'booking.cancelled'; method: string }> = [
    { situation: 'booking.created', method: 'handleBookingCreated' },
    { situation: 'booking.cancelled', method: 'handleBookingCancelled' }
];

for (const { situation, method } of VENDOR_BOOKING_SITUATIONS) {
    const entry = NOTIFICATION_CATALOG[situation];
    const supplied = dispatchContextKeys(VENDOR_HANDLER, method);

    assert(`${situation}: handler supplies every placeholder, in all 5 languages`, () => {
        const wanted = new Set<string>();
        for (const lang of SUPPORTED_LANGUAGES) {
            const copy = entry.base[lang as Language];
            placeholdersIn(copy.subject).forEach((p) => wanted.add(p));
            placeholdersIn(copy.body).forEach((p) => wanted.add(p));
        }
        if (entry.button) placeholdersIn(entry.button.urlSuffix).forEach((p) => wanted.add(p));

        const missing = [...wanted].filter((p) => !supplied.has(p));
        if (missing.length > 0) console.error(`     unsupplied: ${missing.join(', ')}`);
        return missing.length === 0;
    });
}

// ─── 3 · bodyParams cover the body ───────────────────────────────────────────

console.log('\n3 · vendor booking templates: bodyParams cover their own copy');

for (const { situation } of VENDOR_BOOKING_SITUATIONS) {
    const entry = NOTIFICATION_CATALOG[situation];
    const params = new Set(entry.whatsapp.template.bodyParams.flatMap(placeholdersIn));

    assert(`${situation}: every body placeholder is a bodyParam`, () => {
        const inBody = new Set<string>();
        for (const lang of SUPPORTED_LANGUAGES) {
            placeholdersIn(entry.base[lang as Language].body).forEach((p) => inBody.add(p));
        }
        const uncovered = [...inBody].filter((p) => !params.has(p));
        if (uncovered.length > 0) {
            console.error(`     ${uncovered.join(', ')} appear in the copy but are not bodyParams —`);
            console.error('     the approved template cannot say what the in-window text says');
        }
        return uncovered.length === 0;
    });

    assert(`${situation}: bodyParams count matches the template registry`, () => {
        const declared = registryParamCount(entry.whatsapp.template.name);
        if (declared === null) {
            console.error(`     ${entry.whatsapp.template.name} is not in the template registry`);
            return false;
        }
        if (declared !== entry.whatsapp.template.bodyParams.length) {
            console.error(`     registry says ${declared}, catalog sends ${entry.whatsapp.template.bodyParams.length}`);
        }
        return declared === entry.whatsapp.template.bodyParams.length;
    });
}

assert('vendor_booking_created takes 5 params — the widened shape', () => {
    // Pinned as a literal because widening it was a Meta Business Manager
    // operation. Changing this number back without re-approving the template
    // there breaks every out-of-window send, silently, one vendor at a time.
    return registryParamCount('vendor_booking_created') === 5;
});

// ─── 4 · The rendered message ────────────────────────────────────────────────

console.log('\n4 · the message a vendor actually receives');

const FULL_CONTEXT = {
    bookingNumber: 'BKG-2026-000123',
    serviceName: 'Deep Tissue Massage',
    customerName: 'Awa Ndongo',
    startDate: '2026-09-12 14:30',
    actionLine: 'It is waiting for you to confirm or decline it.',
    bookingId: '68b0c1d2e3f4a5b6c7d8e9f0'
};

for (const lang of SUPPORTED_LANGUAGES) {
    assert(`booking.created renders with no empty gap [${lang}]`, () => {
        const { title, message } = renderInApp('booking.created', lang as Language, FULL_CONTEXT);
        const bad = !title || !message || /\{\{/.test(message) || /#\s|#$/.test(message);
        if (bad) console.error(`     ${JSON.stringify(message)}`);
        return !bad;
    });
}

assert('booking.created English copy names all five values', () => {
    const { message } = renderInApp('booking.created', 'en', FULL_CONTEXT);
    console.log(`     "${message}"`);
    return (
        message.includes('BKG-2026-000123') &&
        message.includes('Deep Tissue Massage') &&
        message.includes('Awa Ndongo') &&
        message.includes('2026-09-12 14:30') &&
        message.includes('confirm or decline')
    );
});

assert('no WhatsApp param is empty when the context is complete', () => {
    // An empty parameter is not a cosmetic problem: Meta rejects the whole send,
    // so the channel fails rather than degrading. This is what the shipped defect
    // did on every booking.
    const params = renderWhatsAppTemplateParams('booking.created', 'en', FULL_CONTEXT);
    if (params.length !== 5) {
        console.error(`     expected 5 params, got ${params.length}`);
        return false;
    }
    const empty = params.filter((p) => p.trim() === '');
    if (empty.length > 0) console.error(`     ${empty.length} empty param(s): ${JSON.stringify(params)}`);
    return empty.length === 0;
});

assert('the OLD payload shape would now be caught, not rendered', () => {
    // The regression, spelled out: feed the message the field names the handler
    // used to read and the producer never sent. Every one renders empty.
    const brokenContext = {
        bookingNumber: undefined,
        serviceName: undefined,
        customerName: undefined,
        startDate: new Date(undefined as unknown as string).toLocaleString(),
        actionLine: undefined,
        bookingId: 'x'
    };
    const { message } = renderInApp('booking.created', 'en', brokenContext);
    console.log(`     what shipped: "${message}"`);
    // Not an assertion about the fix — an assertion that this input really is
    // broken, so the test above is testing something.
    return message.includes('Invalid Date') && !message.includes('BKG-');
});

// ─── 5 · The booking number's format ─────────────────────────────────────────

console.log('\n5 · booking number format');

assert('formats as BKG-YYYY-NNNNNN', () => formatBookingNumber(2026, 123) === 'BKG-2026-000123');

assert('the first of the year is 000001, not 000000', () => formatBookingNumber(2026, 1) === 'BKG-2026-000001');

assert('matches its own pattern', () => BOOKING_NUMBER_PATTERN.test(formatBookingNumber(2026, 42)));

assert('past six digits it widens rather than truncating', () => {
    // A truncated number is a DUPLICATE number, which the unique index would
    // reject at insert time — a failed booking. A seventh digit is merely ugly.
    const wide = formatBookingNumber(2026, 1234567);
    return wide === 'BKG-2026-1234567' && BOOKING_NUMBER_PATTERN.test(wide);
});

assert('the year segment is UTC, not the process timezone', () => {
    // 2026-01-01T00:30Z is still 2025 in Douala-minus zones and already 2026 in
    // Tokyo. The number must not depend on where the server is.
    const src = readFileSync(
        join(SRC, 'modules/booking/utils/booking-number.generator.ts'),
        'utf8'
    );
    return src.includes('getUTCFullYear()') && !/\bnow\.getFullYear\(\)/.test(src);
});

assert('the sequence comes from the atomic counter, not countDocuments', () => {
    // The order generator counts rows and adds one, which is a race two
    // simultaneous bookings both lose. This must not be copied back in.
    //
    // Comments are stripped first: the generator's own docstring NAMES
    // `countDocuments` to explain what it deliberately does not do, and a scan
    // that cannot tell prose from code fails on its own documentation.
    const src = stripComments(
        readFileSync(join(SRC, 'modules/booking/utils/booking-number.generator.ts'), 'utf8')
    );
    return src.includes('nextSequenceValue') && !src.includes('countDocuments');
});

assert('the number is drawn OUTSIDE the creating transaction', () => {
    // Inside it, every concurrent booking conflicts on the one counter document
    // and an atomic increment becomes a retry storm. The generator's docstring
    // says so; this is what holds the call site to it.
    const beforeTxn = BOOKING_SERVICE.indexOf('const bookingNumber = await BookingNumberGenerator.generate()');
    const txn = BOOKING_SERVICE.indexOf('transactionManager.runInTransaction');
    return beforeTxn !== -1 && txn !== -1 && beforeTxn < txn;
});

assert('both creation paths stamp a number', () => {
    // `createBooking` and `createCapacityBooking` (group services). A booking with
    // no number is a notification with no handle.
    const draws = BOOKING_SERVICE.split('BookingNumberGenerator.generate()').length - 1;
    const group = readFileSync(
        join(SRC, 'modules/booking/services/group-booking.service.ts'),
        'utf8'
    );
    return draws === 2 && group.includes('bookingNumber,');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
