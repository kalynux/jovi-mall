/**
 * Test: STREAM D — the checkout screen and the payment it starts.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── ⚠ WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
 * Five sessions build this surface in **one working tree with no branching**. Two sessions
 * appending to one shared suite is a read-then-write race on disk, not a merge conflict — one
 * session's work simply disappears. So `test-bot-surface.ts` is touched by **nobody**, and
 * this file is **Stream D's alone**.
 *
 * ── ⚠ AND THIS IS THE STREAM WHOSE MISTAKES COST MONEY ──────────────────────
 * The `co` handle authorises **placing an order against a stranger's saved address and
 * starting a payment**, from a URL carrying no other credential. Every assertion in § 1 is
 * one of the four things that keeps that safe. If one fails, stop and read
 * `inapp-surface.store.ts` before changing anything.
 *
 * Run: npm run test:inapp-checkout
 */
import fs from 'fs';
import path from 'path';
import { TTL_SECONDS, InAppSurfaceStore, newInAppHandle } from '../../src/modules/bot-surface/services/inapp-surface.store';
import { __IN_APP_COPY, inAppCopy } from '../../src/modules/bot-surface/miniapp/inapp-copy';
import { __SCREEN_KINDS } from '../../src/modules/bot-surface/miniapp/inapp-page.controller';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
// ── § 2's imports (Stream D) ────────────────────────────────────────────────
/**
 * ⚠ **The masking rules are imported from `checkout-masking.ts`, NOT from the controller, and
 * the reason is load-bearing for this whole suite.** `checkout.controller.ts` imports
 * `orders/order.service` and `payments/`, both of which do work at import time and never return
 * in a bare `ts-node` process — which is exactly how these suites run. An import of the
 * controller here hangs the run with no output at all, and the repair somebody reaches for
 * under that symptom is deleting the assertions rather than moving the functions.
 */
import { maskAddress, accountIdentifier } from '../../src/modules/bot-surface/miniapp/surfaces/checkout-masking';
// ── § 12's imports (the chat door, 2026-09-22) — both pure, both safe under bare ts-node ──
import { resolveChatDestination } from '../../src/modules/bot-surface/miniapp/surfaces/checkout-destination';
import { placedResponse } from '../../src/modules/whatsapp/flows/screens/checkout.adapter';
import {
    customerWhatsAppTemplateName,
    renderCustomerInApp,
} from '../../src/modules/notifications/catalog/customer-notification-catalog';
import { SUPPORTED_LANGUAGES } from '../../src/core/constants/languages';
import type { ICustomer, ICustomerSavedAddress } from '../../src/modules/customers/customer.model';
// ── § 13's imports (the server-drawn confirmation, 2026-09-22) — all pure, all safe under bare ts-node ──
import {
    ChatPlacementForReply,
    ChatReviewForReply,
    __CHECKOUT_REPLY_LIMITS,
    checkoutDeclinedReply,
    checkoutPlacedReply,
    checkoutReviewReply,
} from '../../src/modules/bot-surface/domain/checkout-chat-reply';
import {
    checkoutConfirmActionId,
    checkoutDeclineActionId,
    checkoutTokenBudgetProblems,
    isCheckoutRef,
    parseCheckoutConfirm,
    parseCheckoutDecline,
} from '../../src/modules/bot-surface/domain/bot-checkout-actions';
import {
    BotChromeKey,
    __CHROME_TABLE,
    __CHROME_TEMPLATES,
    botChrome,
    botChromeCopyGaps,
    botChromeFill,
} from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import {
    __CALLBACK_DATA_BYTES,
    parseBotActionId,
    paymentRetryActionId,
    paymentStatusActionId,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import { actionKeyOf } from '../../src/modules/bot-surface/domain/bot-action-dispatch';
import { BotReplyIntent, renderBotReply } from '../../src/modules/bot-surface/domain/channel-reply';
import type { BotAddressDto } from '../../src/modules/bot-surface/dto/bot-projections';

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

/**
 * Where the SOURCE SCANS read from — the real tree, unless a proof harness redirects them.
 *
 * ⚠ **This exists so a guard can be PROVEN to bite, not merely observed to pass.** A mutation
 * harness copies the scanned files to a scratch directory, breaks one rule or converts the line
 * endings, and runs THIS suite against the copy — so the proof exercises the real assertions
 * rather than a re-implementation of them, which could be right while the suite is wrong.
 *
 * ⚠ **Only file reads move.** Every `import` still resolves against the real tree, so the
 * behavioural assertions (masking, the catalogue) are unaffected, and a redirected run says so
 * loudly on its first line so it can never be mistaken for a real one.
 */
const SCAN_ROOT = process.env.INAPP_CHECKOUT_SCAN_ROOT
    ? path.resolve(process.env.INAPP_CHECKOUT_SCAN_ROOT)
    : path.join(__dirname, '../..');
if (process.env.INAPP_CHECKOUT_SCAN_ROOT) {
    console.log(`\n⚠ SCANS REDIRECTED to ${SCAN_ROOT} — this is a proof run, not a real one.`);
}
const PUBLIC_DIR = path.join(SCAN_ROOT, 'src/modules/bot-surface/miniapp/public');
const STORE_SRC = path.join(SCAN_ROOT, 'src/modules/bot-surface/services/inapp-surface.store.ts');

const page = (): string => fs.readFileSync(path.join(PUBLIC_DIR, 'co.html'), 'utf8');
/** Comments explain the rules; the scans below must read the CODE, not the explanation. */
const code = (): string => page().replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ─────────────────────────────────────────────────────────────────────────────
//  § 2's own fixtures (Stream D)
//
//  ⚠ Every scan below strips comments FIRST, for the reason § 1 records: these files
//  *explain* the rules they obey, and a guard that read the explanation as the offence would
//  fail on the file that gets it right — which is how a correct guard teaches somebody to
//  delete the comment that makes the code legible.
// ─────────────────────────────────────────────────────────────────────────────

const SCREEN_SRC = path.join(SCAN_ROOT, 'src/modules/bot-surface/miniapp/surfaces/checkout.controller.ts');
const CHAT_SRC = path.join(SCAN_ROOT, 'src/modules/bot-surface/controllers/bot-checkout.controller.ts');

/**
 * ⛔ **Line endings are normalised FIRST, and without it every bounded scan below was unbounded.**
 *
 * This machine runs `core.autocrlf=true`, the repo has no `.gitattributes`, and — measured — the
 * blobs themselves carry CRLF. So every source file here reads as `\r\n`, and a span bounded at
 * `'\n}\n'` never finds its end: `indexOf` answers -1, the slice silently runs to end-of-file, and
 * an absence check becomes true of the whole remainder of the file instead of one function. It
 * was found because a rewritten guard FAILED on correct code (its "one method" span contained two
 * other methods' calls); how many assertions had been passing on the wrong span before that is
 * exactly the question this line makes unnecessary to answer.
 */
const lf = (src: string): string => src.replace(/\r\n/g, '\n');

const stripTs = (src: string): string =>
    lf(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** § 1's `code()` for the page, with line endings normalised for § 2's bounded scans. */
const pageCode = (): string => lf(code());

const ORCHESTRATOR_SRC = path.join(SCAN_ROOT, 'src/modules/payments/services/payment-orchestrator.service.ts');
const NOTIFY_HANDLER_SRC = path.join(SCAN_ROOT, 'src/modules/notifications/services/customer-notification-event-handler.service.ts');
const NOTIFY_CONSUMER_SRC = path.join(SCAN_ROOT, 'src/modules/notifications/customer-notification-event-consumer.ts');

const MASKING_SRC = path.join(SCAN_ROOT, 'src/modules/bot-surface/miniapp/surfaces/checkout-masking.ts');

/**
 * The five payment helpers — `validatedPayerNumber`, `assertNetworkChargeable`,
 * `maskedPayerNumber`, `storedPayerNumber`, `mobileMoneyGateway` — extracted from the
 * controller 2026-09-20.
 *
 * ⚠ **The extraction was forced by a guard in ANOTHER suite, and the reason matters here.**
 * The booking pay screen's core needs these five, and that core is imported directly by the
 * WhatsApp form handler — so a controller anywhere in its import graph makes a bare `ts-node`
 * run do real work at module scope and hang with no output. `test-inapp-bookings` § 2 refuses
 * it. The helpers therefore moved to a module with no Express in it; the controller re-exports
 * them so no existing caller changed.
 *
 * ⚠ **Adding this path is not bookkeeping — SIX assertions below went red the moment the code
 * moved**, including the in-scope guard itself, which is precisely the outcome that guard
 * exists to produce. A "must NOT" scan over a file the subject has left passes vacuously.
 */
const PAYER_SRC = path.join(SCAN_ROOT, 'src/modules/bot-surface/miniapp/surfaces/checkout-payer.ts');

/**
 * ⚠ **The screen's scope is the controller AND every module the checkout logic was extracted
 * into, read together.** A "must NOT" scan over one file passes vacuously the day the code it
 * guards moves to another — backend-fc hit exactly that when extracting their reads: three
 * absence checks stayed green only because their subject had left the file. So the scope grows
 * with every extraction, and `the checkout logic is actually in scope` (§ 5, first) fails before
 * any absence check can pass on an empty subject.
 */
/** The chat door's address rule (2026-09-22). Pure — § 12 drives it as well as scanning it. */
const DESTINATION_SRC = path.join(SCAN_ROOT, 'src/modules/bot-surface/miniapp/surfaces/checkout-destination.ts');

const SCREEN_SCOPE = [SCREEN_SRC, MASKING_SRC, PAYER_SRC, DESTINATION_SRC];
const screenCode = (): string =>
    SCREEN_SCOPE.map((file) => stripTs(fs.readFileSync(file, 'utf8'))).join('\n');
const chatCode = (): string => stripTs(fs.readFileSync(CHAT_SRC, 'utf8'));
const orchestratorCode = (): string => stripTs(fs.readFileSync(ORCHESTRATOR_SRC, 'utf8'));
const notifyHandlerCode = (): string => stripTs(fs.readFileSync(NOTIFY_HANDLER_SRC, 'utf8'));
const notifyConsumerCode = (): string => stripTs(fs.readFileSync(NOTIFY_CONSUMER_SRC, 'utf8'));

function main(): void {
    console.log('\n══ § 1 · The four things that keep a checkout handle safe ══');

    console.log('\n── 1 · A short life ──');

    /**
     * ⚠ Thirty minutes is right for a list somebody is still scrolling; it is far too long for
     * a credential that can place an order. A checkout is finished in minutes or abandoned.
     */
    assert('⛔ checkout lives 10 minutes, not 30', () => TTL_SECONDS.co === 600);

    /**
     * ⚠ **This said "strictly the shortest-lived of THE FIVE" and went red when there were
     * eight** — not because anything regressed, but because `bp` (the booking pay screen) was
     * added at checkout's exact ten minutes, deliberately and for checkout's own reason: it is
     * also a credential that moves money. A count in an assertion is a fact about the world on
     * the day it was written.
     *
     * So the property is restated as what was actually meant, and it no longer carries a
     * number:
     *
     *  1. **Nothing outlives checkout downwards** — no handle anywhere is shorter-lived, so
     *     checkout sits at the floor.
     *  2. **Every handle that is NOT a payment credential is STRICTLY longer.** A tie is
     *     allowed only for another credential that can move money, which is the one case where
     *     ten minutes is the right answer rather than a drift toward it.
     *
     * Read together these still refuse the thing the original guarded: a browsing screen
     * quietly acquiring a checkout-length life, or checkout acquiring a browsing-length one.
     */
    const PAYMENT_HANDLES: (keyof typeof TTL_SECONDS)[] = ['co', 'bp'];

    assert('⛔ no handle is shorter-lived than checkout', () =>
        (Object.keys(TTL_SECONDS) as (keyof typeof TTL_SECONDS)[])
            .every((k) => TTL_SECONDS[k] >= TTL_SECONDS.co));

    assert('⛔ every NON-payment handle is strictly longer-lived than checkout', () =>
        (Object.keys(TTL_SECONDS) as (keyof typeof TTL_SECONDS)[])
            .filter((k) => !PAYMENT_HANDLES.includes(k))
            .every((k) => TTL_SECONDS[k] > TTL_SECONDS.co));

    // The tie above is a claim about `bp`, so it is pinned rather than assumed: if `bp` ever
    // stops being a payment credential, the exemption above must go with it.
    assert('⛔ the only handle tying checkout\'s life is the booking PAY screen', () =>
        (Object.keys(TTL_SECONDS) as (keyof typeof TTL_SECONDS)[])
            .filter((k) => k !== 'co' && TTL_SECONDS[k] === TTL_SECONDS.co)
            .join(',') === 'bp');

    console.log('\n── 2 · Single use on the write that places the order ──');

    /**
     * ⚠ **This mount has no `Idempotency-Key`** — `/api/bot/miniapp/*` is browser traffic and
     * a browser sends what the page sends, so the bot surface's mandatory-idempotency rule
     * cannot reach here. The store is the only guard there is.
     */
    assert('the store offers `consume`, which reads and deletes atomically', () =>
        typeof InAppSurfaceStore.prototype.consume === 'function');

    /**
     * ⚠ **`GETDEL` is NOT usable on this platform** — it landed in Redis 6.2 and the
     * development Redis here is 3.0, where it is an unknown command: a hard failure on the
     * first checkout, on a server that is otherwise fine. And it must never become a `get`
     * then a `del`: two concurrent submits would both see a live handle and both place an
     * order. `geo-candidate.store.ts` was bitten by exactly this once already.
     */
    assert('⛔ consumption is a Lua script — never GETDEL, never get-then-del', () => {
        const src = fs.readFileSync(STORE_SRC, 'utf8');
        /**
         * ⚠ Comments are stripped first, and that is not incidental: the store's own docstring
         * NAMES `GETDEL` in order to explain why it is unusable here. A scan that read the
         * explanation as the offence would fail on the very file that gets this right — which
         * is how a correct guard teaches somebody to delete the comment.
         */
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return code.includes('redis.call("get"')
            && code.includes('redis.call("del"')
            && !/GETDEL/i.test(code);
    });

    /**
     * ⚠ **Spent even when the caller then fails**, which is the safe direction: a customer who
     * loses a checkout re-taps and gets a fresh screen, whereas a handle that survived a
     * partial failure is a handle that can place the order twice.
     */
    assert('⛔ the page latches after ONE submit and offers no retry on it', () => {
        const c = code();
        return c.includes('if (placed) return;') && c.includes('placed = true;');
    });

    assert('⛔ a network failure after submit never claims the order was not placed', () =>
        code().includes('copy.failed') && !/not placed|was not placed/i.test(code()));

    console.log('\n── 3 · Nothing sensitive is projected in full ──');

    /**
     * ⚠ A `co` URL is forwardable. The address must be masked in the projection — the
     * `maskPhone` / `stripDeliveryCodes` precedent — and the mobile-money number never reaches
     * this page in full: it is the field's placeholder, and an empty field means "use the
     * number on my account".
     */
    assert('the page reads a masked phone and sends the field only when typed', () => {
        const c = code();
        return c.includes('phoneMasked') && c.includes('typed.length > 0 ? typed : null');
    });

    assert('the page renders the address the server sent and composes none of its own', () =>
        code().includes('data.address.text') && !code().includes('street') && !code().includes('postcode'));

    console.log('\n── 4 · The screen captures no address, and quotes no money of its own ──');

    /**
     * ⚠ Capturing an address here would drag `geo-candidate.store.ts`, `geo_search_address`
     * and the `gc_` picker into a WebView, and the chat already does it well with a map pin
     * and a candidate list. So "no saved address" is a real state with a real instruction.
     */
    assert('⛔ no saved address is a STATE with an instruction, not an error', () =>
        code().includes('copy.checkoutNoAddress'));

    assert('⛔ the screen has no address input of any kind', () => {
        const html = page().replace(/<!--[\s\S]*?-->/g, '');
        const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
        // Exactly one field, and it is the mobile-money number.
        return inputs.length === 1 && inputs[0].includes('type="tel"');
    });

    /**
     * ⚠ A WebView that computes a total is a second implementation of delivery fees, discounts
     * and the negotiated price lock, in the one place nothing tests. If a line and the total
     * disagree, the total is right — and it came from the server.
     */
    assert('⛔ the screen does no money arithmetic', () => {
        const c = code();
        return !c.includes('toFixed') && !c.includes('parseFloat') && !c.includes('Intl.NumberFormat');
    });

    console.log('\n── The result comes back in the CHAT ──');

    /**
     * ⚠ Neither a Mini App nor a WhatsApp Flow can hold a session open while somebody approves
     * a mobile-money push on their handset. The screen promises the answer in the thread and
     * closes; the chat delivers it, with Check-status and Try-again.
     */
    assert('the screen says the answer is coming to the chat, before the charge starts', () =>
        code().includes('copy.checkoutWatchChat'));

    assert('that message is on screen long enough to read before the page closes', () => {
        const m = code().match(/setTimeout\(function \(\) \{ if \(tg && tg\.close\)[\s\S]*?\}, (\d+)\)/);
        return m !== null && Number(m[1]) >= 2000;
    });

    console.log('\n── The frame ──');

    assert('the checkout page exists and is on the kind allowlist', () =>
        fs.existsSync(path.join(PUBLIC_DIR, 'co.html'))
        && (__SCREEN_KINDS as readonly string[]).includes('co'));

    assert('it links the shared stylesheet', () =>
        page().includes('/api/bot/miniapp/shell.css'));

    assert('every copy key it reads exists', () => {
        const known = Object.keys(__IN_APP_COPY);
        const used = [...new Set([...page().matchAll(/\bcopy\.([a-zA-Z]+)/g)].map((m) => m[1]))];
        const unknown = used.filter((k) => !known.includes(k));
        if (unknown.length > 0) console.error(`      co.html reads unknown keys: ${unknown.join(', ')}`);
        return unknown.length === 0;
    });

    assert('every checkout word resolves in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const c = inAppCopy(lang) as Record<string, string>;
            return ['checkoutHeading', 'checkoutTotal', 'checkoutAddress', 'checkoutNoAddress',
                'checkoutPhone', 'checkoutPay', 'checkoutWatchChat']
                .every((k) => typeof c[k] === 'string' && c[k].trim().length > 0);
        }));

    console.log('\n══ § 2 · Stream D\'s own assertions ══');

    console.log('\n── 5 · The write spends the handle, and spends it FIRST ──');

    /**
     * ⛔ **SCOPE, FIRST — every absence check in §§ 5–8 depends on this passing.** Each named
     * export must be present in the scanned text, or a "must NOT" below is true of nothing. If
     * this fails after an extraction, add the new module to `SCREEN_SCOPE`; do not delete it.
     */
    assert('⛔ the checkout logic is actually in scope for the scans below', () => {
        const src = screenCode();
        const required = [
            'export async function readCheckoutView(',
            'export async function placeCheckout(',
            'export class CheckoutController',
            'export function maskAddress(',
            'export function accountIdentifier(',
            'export async function storedPayerNumber(',
            'function mobileMoneyGateway(',
            // The chat door (2026-09-22): § 12's absence checks are about these three.
            'export async function readChatCheckout(',
            'async function precheckChatDoor(',
            'export function resolveChatDestination(',
        ];
        const missing = required.filter((needle) => !src.includes(needle));
        if (missing.length > 0) console.error(`      out of scope: ${missing.join(', ')}`);
        return SCREEN_SCOPE.every((file) => fs.existsSync(file)) && missing.length === 0;
    });

    /**
     * ⚠ **`consume` on the write, `read` on the page.** The page reads on every open and every
     * refresh; the one call that creates an order must not repeat. If this inverts, a refreshed
     * tab places a second order against the same basket and nothing anywhere notices — this
     * mount has no `Idempotency-Key`, because a browser sends what the page sends.
     */
    /**
     * ⚠ **Each scan names the ONE function it is true of, both ends.** The rules live in the
     * exported core now (`readCheckoutView`, `placeCheckout`), shared by the Telegram page and
     * the WhatsApp form. An earlier version of this assertion sliced the HTTP handler to the
     * class close — correct then, and silently scanning an empty wrapper the day the rules moved.
     */
    assert('⛔ `placeCheckout` consumes the handle and `readCheckoutView` only reads it', () => {
        const src = screenCode();
        const fn = (sig: string): string => {
            const start = src.indexOf(sig);
            return start < 0 ? '' : src.slice(start, src.indexOf('\n}\n', start));
        };
        const place = fn('export async function placeCheckout(');
        const read = fn('export async function readCheckoutView(');
        return place.includes("inAppSurfaceStore.consume('co'")
            && !place.includes('inAppSurfaceStore.read(')
            && read.includes("inAppSurfaceStore.read('co'")
            && !read.includes('inAppSurfaceStore.consume(');
    });

    /**
     * ⭐ **One read, one set of rules, two renderings.** The page's HTTP handlers must be thin
     * wrappers over the exported core, or the WhatsApp form — which calls the core directly —
     * inherits rules the page does not have, or the other way round.
     */
    assert('⛔ the HTTP handlers are thin wrappers — the rules live only in the exported core', () => {
        const src = screenCode();
        const start = src.indexOf('export class CheckoutController {');
        const cls = src.slice(start, src.indexOf('\n}\n', start));
        return start > 0
            && cls.includes('readCheckoutView(')
            && cls.includes('placeCheckout(')
            && !cls.includes('inAppSurfaceStore.')
            && !cls.includes('createOrdersFromCart(')
            && !cls.includes('initiatePaymentForCart(');
    });

    /**
     * ⛔ **The cheap, deterministic refusals come BEFORE the spend** — a mistyped number and a
     * deployment with no gateway must not cost a customer their handle — and everything that
     * takes time comes after it.
     */
    assert('⛔ number and gateway are checked before `consume`; orders and charge after it', () => {
        const src = screenCode();
        const start = src.indexOf('export async function placeCheckout(');
        const place = src.slice(start, src.indexOf('\n}\n', start));
        const at = (needle: string): number => place.indexOf(needle);
        const spend = at("inAppSurfaceStore.consume('co'");
        return spend > 0
            && at('validatedPayerNumber(phone)') > 0 && at('validatedPayerNumber(phone)') < spend
            && at('mobileMoneyGateway()') > 0 && at('mobileMoneyGateway()') < spend
            && at('createOrdersFromCart(') > spend
            && at('initiatePaymentForCart(') > spend;
    });

    /**
     * ⛔ **Every refusal after the spend says so.** A caller deciding whether a retry is honest
     * cannot tell from the status — a 400 comes from the typed number (before) or from order
     * creation (after) — so the whole post-spend block is wrapped and re-marked.
     */
    assert('⛔ everything after `consume` is inside the block that marks refusals spent', () => {
        const src = screenCode();
        const start = src.indexOf('export async function placeCheckout(');
        const place = src.slice(start, src.indexOf('\n}\n', start));
        const spend = place.indexOf("inAppSurfaceStore.consume('co'");
        const tryAt = place.indexOf('try {', spend);
        const catchAt = place.indexOf('} catch (error) {', tryAt);
        const body = place.slice(tryAt, catchAt);
        return tryAt > spend
            && body.includes('createOrdersFromCart(')
            && body.includes('initiatePaymentForCart(')
            && place.slice(catchAt).includes('throw markedSpent(error)');
    });

    /**
     * ⚠ **Measured: the platform phone schema REFUSES `''`.** A WhatsApp text input left empty
     * submits exactly that, so without folding it first "use the number on my account" — the
     * common case, and the one that discloses nothing — becomes a 400 on the form while it works
     * on the page, which sends `null`.
     */
    assert('⛔ an empty or blank number means "use my account\'s", on both doors', () => {
        const src = screenCode();
        const start = src.indexOf('function validatedPayerNumber(');
        const fn = src.slice(start, src.indexOf('\n}\n', start));
        const fold = fn.indexOf("phone.trim().length === 0) return null");
        const validate = fn.indexOf('OptionalPhoneNumberSchema.safeParse(');
        return fold > 0 && validate > fold && fn.includes('spent: false');
    });

    /**
     * ⛔ **ABSENT MEANS SPENT, on the page.** Only an explicit `spent === false` on a 400 may
     * unlatch the Pay button. The platform strips `details` from gateway and internal errors and
     * a lost response has no body — so reading "no flag" as "not spent" is how one tap places
     * two orders.
     */
    assert('⛔ the page unlatches ONLY on a 400 or 422 that says explicitly the handle was not spent', () => {
        const c = pageCode();
        /**
         * ⚠ The DECLARATION `var placed = false;` is excluded — it contains the same text and is
         * not an unlatch. The first draft of this scan counted it and failed against correct code.
         */
        const unlatches = [...c.matchAll(/(?<!var )placed = false;/g)];
        const unlatch = unlatches[0]?.index ?? -1;
        const guard = c.lastIndexOf('if (', unlatch);
        const condition = c.slice(guard, c.indexOf('{', guard));
        /**
         * ⚠ **The status set is pinned EXACTLY, not merely checked to contain 400.** An earlier
         * version passed for any condition that mentioned 400 — so adding `|| res.status === 503`
         * (no gateway configured: a retry no tap can ever fix) would have stayed green. The only
         * status comparison allowed is strict equality, and the set is exactly {400, 422}.
         */
        const statuses = [...condition.matchAll(/res\.status\s*===\s*(\d{3})/g)].map((m) => m[1]).sort();
        const otherComparisons = /res\.status\s*(!==|!=|>=|<=|>|<|==(?!=))/.test(condition);
        return unlatch > 0
            && unlatches.length === 1
            && statuses.join(',') === '400,422'
            && !otherComparisons
            && condition.includes('spent === false')
            && !/spent\s*!==\s*true/.test(c);
    });

    /**
     * ⚠ **The ORDER of these two lines is the whole guard.** Everything before `consume` is a
     * window in which two concurrent submits both see a live handle — so the basket read, the
     * customer read, the wallet lookup and the gateway choice all have to happen after it. A
     * refactor that hoists one "for clarity" re-opens the double-order race silently.
     */
    assert('⛔ the handle is spent BEFORE any order is created', () => {
        const src = screenCode();
        const spent = src.indexOf("inAppSurfaceStore.consume('co'");
        const placed = src.indexOf('createOrdersFromCart(');
        return spent > 0 && placed > spent;
    });

    /**
     * ⚠ **Both store calls name the kind.** `read`/`consume` refuse a mismatch, which is what
     * stops a `pl` handle — handed out freely in a chat, and forwardable — being replayed
     * against the one endpoint that can spend money. The check is by construction only for as
     * long as the literal is there.
     */
    assert('⛔ every store call on this screen names the `co` kind', () => {
        const calls = [...screenCode().matchAll(/inAppSurfaceStore\.(read|consume)\(([^,)]*)/g)];
        return calls.length >= 2 && calls.every((m) => m[2].trim() === "'co'");
    });

    console.log('\n── 6 · No prices are held, and the page is quoted no figure it computed ──');

    /**
     * ⚠ **A stored total is a total that can disagree with the basket by the time somebody
     * pays.** The `co` session carries an owner, a conversation and a cart id — nothing else.
     */
    assert('⛔ the minted checkout session holds a cartId and no money', () => {
        const src = chatCode();
        const mint = src.slice(src.indexOf("kind: 'co'"), src.indexOf("kind: 'co'") + 600);
        return mint.includes('cartId: cart.cartId')
            && !/\b(total|price|amount|subtotal)\s*:/i.test(mint);
    });

    /**
     * ⚠ **The total comes from `cartQuoteService`, the same service the storefront cart and
     * `cart_quote` call.** Summing the lines here would be a second implementation of delivery,
     * the vendor-absorbed fee, tax and discount — and it would be a *plausible-looking* one,
     * which is worse than an obviously missing one.
     */
    assert('⛔ the total is the quote service\'s figure, not a sum of the lines', () => {
        const src = screenCode();
        return src.includes('cartQuoteService.quoteForCustomer') && !src.includes('.reduce(');
    });

    /**
     * ⚠ Quoting WITH an address id makes `quoteForCustomer` validate it and throw — which would
     * turn the no-address state, a real state with a real instruction, into an error page.
     */
    assert('the quote is taken without an address, so no-address stays a STATE', () =>
        /quoteForCustomer\(\s*session\.customerId\s*\)/.test(screenCode()));

    console.log('\n── 7 · Mobile money is the only method, and the browser picks none of it ──');

    /**
     * ⚠ **A gateway name arriving from a browser is a caller choosing where a stranger's money
     * goes.** Every other entry point takes one from its caller because those callers are the
     * platform's own code; this one's caller is a web page.
     */
    assert('⛔ the gateway is chosen server-side and never read from the request', () => {
        const src = screenCode();
        return src.includes('mobileMoneyGateway()')
            && !/gateway\s*[:=][^;\n]*req\./.test(src)
            && !src.includes('STRIPE')
            && !src.includes('cardToken');
    });

    /**
     * ⚠ **NotchPay first is a REFUNDABILITY rule, not alphabetical order.** It is the gateway an
     * administrator can reverse a payment through; My-CoolPay has no refund API at all. Every
     * door onto a mobile-money charge must agree, or one basket gets two charges with different
     * reversibility depending on which door the customer came through.
     *
     * ⚠ **Asserted as ONE DEFINITION, not as copies that agree.** This used to check that the
     * screen and the chat each put NotchPay first — i.e. it blessed two copies of the rule, one
     * of which carried a docstring claiming the copies "word a refusal differently" (they threw the
     * identical error). The copy is gone; the chat imports the screen's. A third door (the booking
     * pay screen) imports it too, so agreement is by construction rather than by inspection.
     */
    assert('⛔ the gateway preference is defined ONCE, refundable one first, and imported by the chat', () => {
        const screen = screenCode();
        const chat = chatCode();
        const start = screen.indexOf('export function mobileMoneyGateway(');
        const rule = start < 0 ? '' : screen.slice(start, screen.indexOf('\n}\n', start));
        const notch = rule.indexOf("'NOTCHPAY'");
        const cool = rule.indexOf("'MYCOOLPAY'");
        return start > 0
            && notch > 0 && cool > notch
            && (screen.match(/function mobileMoneyGateway\(/g) ?? []).length === 1
            && !/function mobileMoneyGateway\(/.test(chat)
            && !chat.includes("'NOTCHPAY'") && !chat.includes("'MYCOOLPAY'")
            && /import \{[^}]*\bmobileMoneyGateway\b[^}]*\} from '\.\.\/miniapp\/surfaces\/checkout\.controller'/.test(chat);
    });

    /** COD takes no payment and produces a delivery code; it does not come through this screen. */
    assert('⛔ the screen checks out ONLINE and never cash on delivery', () => {
        const src = screenCode();
        return /createOrdersFromCart\([\s\S]{0,120}'online'/.test(src)
            && !src.includes('cash_on_delivery');
    });

    console.log('\n── 8 · A forwarded URL reads out no address and no payable number ──');

    /**
     * ⚠ **This is protection 3, and it is the one a source scan cannot check.** A scan sees that
     * *something* was dropped; only driving the function shows *what*. A `co` URL is
     * forwardable, so what must not survive is the part that gets somebody to a door.
     */
    assert('⛔ the masked address drops the street line, the second line and the postcode', () => {
        const masked = maskAddress({
            label: 'Home',
            address_line1: '12 Rue Joss',
            address_line2: 'Apartment 4B',
            city: 'Douala',
            state: 'Littoral',
            country: 'CM',
            is_default: true,
            geo: {
                formatted_address: '12 Rue Joss, Akwa, Douala, Cameroon',
                components: { neighbourhood: 'Akwa', city: 'Douala', region: 'Littoral', postal_code: '1234' },
            },
        } as unknown as ICustomerSavedAddress);

        return masked.includes('Home')
            && masked.includes('Akwa')
            && !masked.includes('Rue Joss')
            && !masked.includes('12')
            && !masked.includes('Apartment')
            && !masked.includes('1234');
    });

    /** `Akwa, Akwa` reads as a bug in the address rather than as a coarse one. */
    assert('a repeated locality is not printed twice', () => {
        const masked = maskAddress({
            label: 'Home',
            address_line1: 'somewhere',
            address_line2: null,
            city: 'Akwa',
            state: null,
            country: 'CM',
            is_default: true,
            geo: { formatted_address: 'x', components: { neighbourhood: 'Akwa', city: 'akwa' } },
        } as unknown as ICustomerSavedAddress);
        return (masked.match(/kwa/gi) ?? []).length === 1;
    });

    /** With no locality at all it falls back to the LABEL, never to the street line. */
    assert('⛔ an ungeocoded-looking address falls back to the label, not the street', () => {
        const masked = maskAddress({
            label: 'Office',
            address_line1: '99 Secret Lane',
            address_line2: null,
            city: '',
            state: null,
            country: 'CM',
            is_default: true,
            geo: { formatted_address: 'x', components: {} },
        } as unknown as ICustomerSavedAddress);
        return masked === 'Office' && !masked.includes('Secret');
    });

    /**
     * ⚠ **A DIGITAL basket needs no delivery address, and must not be parked in the no-address
     * state** — a screen telling somebody to send an address for a download they will never be
     * carried. The identifier it shows instead is masked and language-free, so it needs no copy.
     */
    assert('⛔ a digital basket names the account, masked, with no new copy key', () => {
        
        const byEmail = accountIdentifier({ email: 'jean.dupont@example.com', name: 'Jean' } as ICustomer);
        const byPhone = accountIdentifier({ phone: '+237600124417', name: 'Jean' } as ICustomer);
        const byName = accountIdentifier({ name: 'Jean Dupont' } as ICustomer);

        return !byEmail.includes('jean.dupont')
            && byEmail.includes('@example.com')
            && !byPhone.includes('0012')
            && byPhone.includes('4417')
            && byName === 'Jean Dupont';
    });

    /**
     * ⚠ **The number the charge goes to is read through the REPOSITORY, never through
     * `paymentMethodService`** — that service projects to `PaymentMethodDto`, which omits both
     * gateway ids, and a saved wallet's number is unreadable through every API by design. It is
     * read here to charge and leaves the process only through `maskPhone`.
     */
    assert('⛔ the payable number is never published unmasked', () => {
        const src = screenCode();
        return src.includes('maskPhone(stored)')
            && !src.includes('paymentMethodService')
            && !/phoneMasked:\s*(stored|number|payerNumber)\b/.test(src);
    });

    console.log('\n── 9 · The payment\'s answer reaches the chat ──');

    /**
     * ⭐ **The silence this closes was the defect.** Every other checkout outcome said
     * something; a failed payment said nothing, so it was indistinguishable from a successful
     * one that had gone quiet — the customer waits for an order that is not coming.
     *
     * ⚠ **It needs a WhatsApp TEMPLATE, not just copy**, because it can fire outside the
     * 24-hour service window: the charge is approved on a handset minutes after the customer
     * last wrote to us, and free-form text is refused by Meta once that window shuts.
     */
    assert('⛔ `order.payment_failed` has a WhatsApp template', () =>
        customerWhatsAppTemplateName('order.payment_failed') === 'customer_order_payment_failed');

    assert('⛔ it is written in every supported language', () =>
        SUPPORTED_LANGUAGES.every((lang) => {
            const rendered = renderCustomerInApp('order.payment_failed', lang, {
                orderNumber: 'ORD-1', currency: 'XAF', amountFormatted: '20 000',
            });
            return rendered.title.trim().length > 0
                && rendered.message.trim().length > 0
                && !rendered.message.includes('{{');
        }));

    /**
     * ⚠ **Three copy rules, each load-bearing, and each checkable.** The English body is the
     * one they are stated against; a translation that broke one would need its own assertion,
     * which is what `assertCustomerCatalogComplete` and a human reviewer are for.
     *
     *   · it must NOT say cancelled — the basket survives and the charge is retryable, and
     *     announcing a cancellation destroys a recoverable sale;
     *   · it must NOT blame the customer — the common causes are an unapproved push prompt and
     *     a timeout, neither of which is a judgement on them;
     *   · it MUST say nothing was charged, because that is the customer's actual first question.
     */
    assert('the failure copy does not cancel the order, and blames nobody', () => {
        const body = renderCustomerInApp('order.payment_failed', 'en', {
            orderNumber: 'ORD-1', currency: 'XAF', amountFormatted: '20 000',
        }).message.toLowerCase();
        return !body.includes('cancel')
            && !body.includes('declined')
            && body.includes('nothing has been charged');
    });

    /**
     * ⚠ **A record is DATA for the model to narrate; only a fixed-wording turn carries a
     * sentence.** Writing "your payment went through" in the chat controller would put a second
     * opinion beside the notification catalogue's own copy for the same event, in a different
     * table — and the customer would eventually be told both.
     *
     * ⚠ **REDRAWN 2026-09-22, and the old form is kept here as the lesson.** This asserted that
     * every reply in the chat controller was inside the screen door — i.e. that the chat
     * CONFIRMATION was a record for the model to narrate. The model's narration of one came back
     * truncated to "Your order is 200 XAF," (core exec 2294) and the customer never saw the
     * question. A confirmation and a placement are fixed-wording turns with controls, so they are
     * drawn now; the payment STATUS read and the retry are records and still draw nothing. So the
     * rule is pinned per function, both directions, and the file-wide count must be exactly the
     * drawn turns' — a reply added anywhere else fails here.
     */
    assert('⛔ the money READS set no reply; only the door, the confirmation, the placement and Not now do', () => {
        const src = chatCode();
        const span = (sig: string): string => {
            const start = src.indexOf(sig);
            return start < 0 ? '' : src.slice(start, src.indexOf('\n}\n', start));
        };
        const replies = (text: string): number => (text.match(/setBotReply\(/g) ?? []).length;

        const reads = ['async function reportPayment(', 'async function retryCharge(', 'export async function paymentTap(']
            .map(span);
        const drawn = ['async function reviewChatCheckout(', 'async function placeChatCheckout(', 'async function declineCheckoutTap(']
            .map(span);
        const door = src.slice(src.indexOf('static screen'), src.indexOf('static paymentStatus'));

        const readsSilent = reads.every((body) => body.length > 0 && replies(body) === 0);
        const drawnOnce = drawn.every((body) => body.length > 0 && replies(body) === 1);
        const accounted = replies(door) + drawn.reduce((sum, body) => sum + replies(body), 0);
        if (!readsSilent || !drawnOnce) console.error('      a money read draws a reply, or a drawn turn does not');
        return readsSilent && drawnOnce && replies(door) > 0 && replies(src) === accounted;
    });

    /**
     * ⚠ **Never a dead button.** `inAppScreenUrl` answers null whenever the deployment has no
     * HTTPS in-app origin — which is TRUE IN PRODUCTION TODAY — so the storefront path is the
     * one that runs, and a third case with neither must clear the reply rather than render a
     * control with an empty target.
     */
    assert('⛔ the screen door degrades to the storefront, then to no button at all', () => {
        const src = chatCode();
        return src.includes("botStorefrontLink('/shop/cart'")
            && !src.includes("botStorefrontLink('/cart'")
            && /setBotReply\(req,\s*fallback\s*\?/.test(src);
    });

    /**
     * ⛔ **The origin is checked BEFORE the handle is minted, and for `co` that ordering is the
     * decision.** `BOT_MINIAPP_BASE_URL` is unset in production, so minting first means every
     * single checkout turn creates a ten-minute ORDER-PLACING credential that is handed to
     * nobody. Not a leak — nothing receives it and it expires — but it makes "how many live
     * checkout handles exist" a number that means nothing, and that is the number somebody
     * reaches for the first time this surface has an incident.
     *
     * ⚠ **Asked through `inAppBaseUrl()`, never a second read of the variable.** `inapp-url.ts`
     * is its single reader and holds BOTH rules that decide the answer — HTTPS (Telegram
     * refuses a `web_app` button on any other scheme, and refuses the whole message with it)
     * and publicly reachable. A local `process.env` check would pass on an origin the renderer
     * then rejects. Stream C calls the same function from its own minting paths.
     */
    assert('⛔ no checkout handle is minted when there is no screen to open', () => {
        const src = chatCode();
        const door = src.slice(src.indexOf('static screen'), src.indexOf('static paymentStatus'));
        const guard = door.indexOf('if (!inAppBaseUrl())');
        const mint = door.indexOf('inAppSurfaceStore.mint(');
        return guard > 0 && mint > guard && !src.includes('process.env.BOT_MINIAPP_BASE_URL');
    });

    /**
     * ⚠ **A digital basket changes the LABEL, not just the value.** Under "Deliver to", a masked
     * email reads as an address the shop has mangled; under `checkoutDigitalDelivery` the same
     * string answers the only question a download raises — WHICH account. The server flags it
     * because the page cannot tell a download from a parcel.
     */
    assert('⛔ a digital basket is not headed "Deliver to"', () => {
        const pageSrc = pageCode();
        return pageSrc.includes('data.address.digital')
            && pageSrc.includes('copy.checkoutDigitalDelivery')
            && screenCode().includes('digital: true');
    });

    /**
     * ⚠ **The page's English table must cover EVERY key it reads.** `copy` is never null once
     * boot has run — a failed copy call falls back to this table — so a key added to the page
     * and not to the fallback produces `undefined` rendered as a label on exactly the request
     * that was already failing.
     */
    assert('⛔ the page\'s English fallback covers every key the page reads', () => {
        const pageSrc = lf(page());
        const used = [...new Set([...pageSrc.matchAll(/\bcopy\.([a-zA-Z]+)/g)].map((m) => m[1]))];
        const fallback = pageSrc.slice(pageSrc.indexOf('var FALLBACK = {'), pageSrc.indexOf('function boot'));
        /**
         * ⚠ The declared keys are collected with ONE static pattern and compared as a SET,
         * rather than searched for per key. Two reasons, and the second is the one that bites:
         *
         *   - a per-key `new RegExp` is banned repo-wide (regex injection + ReDoS);
         *   - a substring check matches any LONGER key sharing the prefix — `retry` is inside
         *     `retryLater`, `checkoutPa` inside `checkoutPay` — so a key that is missing from
         *     the fallback reads as present because a different, longer one is there.
         *
         * ⚠ Appending a colon (`includes('retry:')`) narrows that one pair and does not fix the
         * class, and the colon-less form is what somebody actually writes. A Set comparison has
         * no such edge.
         *
         * ⚠ **Measured, not reasoned** — `'retryLater: "x"'.includes('retry')` is `true`. An
         * earlier version of this comment illustrated the trap with `retry` inside
         * `checkoutRetry`, which is FALSE: that key contains `Retry` with a capital R, so the
         * substring never matched. A wrong example in a correct guard's comment is worse than
         * no example, because the next reader verifies the comment, finds it false, and
         * distrusts the guard.
         */
        const declared = new Set([...fallback.matchAll(/^\s*([a-zA-Z]+)\s*:/gm)].map((m) => m[1]));
        const missing = used.filter((k) => !declared.has(k));
        if (missing.length > 0) console.error(`      FALLBACK is missing: ${missing.join(', ')}`);
        return missing.length === 0;
    });

    /**
     * ⚠ **A retry re-opens a CHARGE, never re-places an ORDER.** The orders from the failed
     * attempt still exist and are still awaiting payment — which is exactly why the failure copy
     * says the items are waiting. Placing a second set would double the basket and the stock
     * hold, and the customer would find out when asked to pay twice.
     */
    /**
     * ⚠ **Sliced to the ONE function that does the work, both ends named.** An earlier version
     * sliced from `static retryPayment` to end-of-file — which passed only because it swallowed
     * the `retryCharge` helper below the class once the route became a one-line delegation. A
     * scan whose span is "everything after here" is true of whatever happens to follow.
     */
    assert('⛔ the retry opens a charge and creates no second order', () => {
        const src = chatCode();
        const start = src.indexOf('async function retryCharge(');
        const retry = src.slice(start, src.indexOf('\n}\n', start));
        return start > 0
            && retry.includes('initiatePaymentForCart(')
            && !retry.includes('createOrdersFromCart(')
            // Both the route and the tap reach it — one implementation, two doors.
            && /static retryPayment[\s\S]*?retryCharge\(req, res, null, phone\)/.test(src)
            && src.includes('retryCharge(req, res, transactionId, null)');
    });

    console.log('\n── 11 · Check status · Try again — the taps ──');

    /**
     * ⛔ **A button outlives the payment it was drawn for.** A "Try again" tapped under last
     * week's failure, by a customer who has checked out twice since, must not re-charge whichever
     * basket is newest. So a tap carries the transaction id and resolves THAT payment or nothing.
     * The ROUTE takes no id for the opposite reason — its caller is a model, which invents ids.
     */
    assert('⛔ both taps resolve the payment they were drawn under, owner-scoped', () => {
        const src = chatCode();
        const start = src.indexOf('async function resolveCheckoutPayment(');
        const resolver = src.slice(start, src.indexOf('\n}\n', start));
        return start > 0
            && /_id:\s*transactionId,\s*userId:\s*customerId/.test(resolver)
            && src.includes('reportPayment(req, res, transactionId)');
    });

    assert('⛔ the route takes no transaction id — a model would invent one', () => {
        const src = chatCode();
        return src.includes('reportPayment(req, res, null)')
            && /const NoArgsSchema = z\.object\(\{\}\)\.strict\(\)/.test(src);
    });

    /** 31 bytes against Telegram's 64 — and a malformed argument is a stale TOKEN, not a 404. */
    assert('⛔ tap tokens are `pay:st:<id>` / `pay:rt:<id>` and a malformed one gets the dispatcher\'s refusal', () => {
        const src = chatCode();
        const start = src.indexOf('export async function paymentTap(');
        const tap = start < 0 ? '' : src.slice(start, src.indexOf('\n}\n', start));
        const worst = `pay:rt:${'f'.repeat(24)}`;
        return start > 0
            && tap.includes("which === 'st'")
            && tap.includes("which === 'rt'")
            && Buffer.byteLength(worst, 'utf8') <= 64
            && /\^\[0-9a-fA-F\]\{24\}\$/.test(tap)
            // The dispatcher's ONE refusal factory — never a hand-built BOT_ACTION_TOKEN_UNKNOWN.
            && (tap.match(/throw unknownBotAction\(\)/g) ?? []).length === 2
            && !tap.includes('BOT_ACTION_TOKEN_UNKNOWN');
    });

    /**
     * ⛔ **THROW, never `next` — the dispatcher's contract.** Its `asyncHandler` is the one error
     * path. A handler that caught and called `next` would hand one failure to two error paths,
     * and a handler that awaited another route's `asyncHandler`-wrapped static would resolve
     * before the work finished while that wrapper's own `.catch(next)` swallowed the error — a
     * tap that produces no message and no log line.
     *
     * ⚠ The earlier shape of this controller did exactly the first of those (`next(error)` inside
     * a prefix matcher), copied from a sibling stream before the contract was settled.
     */
    assert('⛔ the tap handler THROWS its refusals and never touches `next` or a wrapped static', () => {
        const src = chatCode();
        const start = src.indexOf('export async function paymentTap(');
        const tap = start < 0 ? '' : src.slice(start, src.indexOf('\n}\n', start));
        const signature = tap.slice(0, tap.indexOf('{'));
        return start > 0
            && /action:\s*ParsedBotAction/.test(signature)
            && !/\bnext\b/.test(tap)
            && !tap.includes('catch (')
            && !tap.includes('BotCheckoutController.')
            && !src.includes('handleBotCheckoutTap');
    });

    /**
     * ⚠ **"Try again" on a basket that has since been paid is good news, not a refusal.** And
     * only that one code is caught — a catch-all here would turn a real gateway refusal into a
     * cheerful "settled".
     */
    assert('⛔ a retry that finds the basket already paid reports SETTLED, and catches nothing else', () => {
        const src = chatCode();
        const start = src.indexOf('async function retryCharge(');
        const retry = src.slice(start, src.indexOf('\n}\n', start));
        const catches = retry.match(/catch \(error\)/g) ?? [];
        return catches.length === 1
            && retry.includes('error.code === ERROR_CODES.PAYMENT_ORDER_ALREADY_PAID')
            && retry.includes("toPaymentReport(transaction, 'SUCCEEDED')")
            && retry.includes('throw error;');
    });

    /**
     * ⛔ **Two doors onto one charge must refuse the same inputs.** The chat retry once validated
     * a typed number with a 6–20 character length check, which put it in front of NotchPay and
     * My-CoolPay unvalidated — the exact defect `payment.validators.ts` was written to close.
     */
    assert('⛔ a number typed in chat is validated with the same E.164 schema as the screen', () => {
        const chat = chatCode();
        const retrySchema = chat.slice(chat.indexOf('const RetrySchema'), chat.indexOf('.strict();', chat.indexOf('const RetrySchema')));
        return retrySchema.includes('OptionalPhoneNumberSchema')
            && !/z\.string\(\)\.trim\(\)\.min\(6\)/.test(retrySchema)
            && screenCode().includes('OptionalPhoneNumberSchema');
    });

    /**
     * ⚠ **One rule for which wallet is charged, imported rather than re-derived.** A second
     * implementation in the chat would mean the screen and the chat pushing the prompt to two
     * different handsets for one customer — discovered by them, while trying to pay.
     */
    assert('⛔ the chat and the screen resolve the payable number the same way', () =>
        /import \{[^}]*\bstoredPayerNumber\b[^}]*\} from '\.\.\/miniapp\/surfaces\/checkout\.controller'/.test(chatCode())
        && !chatCode().includes('gateway_customer_id'));

    /**
     * ⚠ **A missing payer number has its own code, and the borrowed one must not come back.**
     * Both doors raised `PAYMENT_REFERENCE_REQUIRED` for this until 2026-09-19 — a code whose name
     * means a payment REFERENCE, which a later reader would reasonably "fix" into some other bug.
     * (That the screen's refusal reads as SPENT is not re-pinned here: it is raised after
     * `consume`, and section 5's "everything after `consume` is inside the block that marks refusals
     * spent" already covers every refusal in that span, this one included. Requiring the literal
     * `{ spent: true }` at this site would fail the day somebody removed a redundant flag.)
     */
    assert('⛔ a missing payer number is refused under its own name, never the borrowed reference code', () => {
        const refusal = (src: string, from: string): string | null => {
            const start = from ? src.indexOf(from) : 0;
            if (start < 0) return null;
            const at = src.indexOf('ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED', start);
            return at < 0 ? null : src.slice(at, src.indexOf(');', at));
        };
        const chat = refusal(chatCode(), '');
        const screen = refusal(screenCode(), 'export async function placeCheckout(');
        if (!chat || !screen) {
            console.error('      a payer-number refusal was not found — nothing below would be about it');
            return false;
        }
        return /^ERROR_CODES\.PAYMENT_PAYER_NUMBER_REQUIRED,\s*422,/.test(chat)
            && /^ERROR_CODES\.PAYMENT_PAYER_NUMBER_REQUIRED,\s*422,/.test(screen)
            && !chatCode().includes('PAYMENT_REFERENCE_REQUIRED')
            && !screenCode().includes('PAYMENT_REFERENCE_REQUIRED');
    });

    /**
     * ⛔ **A number no mobile network can be worked out for is refused BEFORE it costs anything.**
     * NotchPay resolves the network from the prefix inside the gateway — after the spend and after
     * the orders exist — so without this a number outside `cm-operator.ts`'s table cost the
     * customer their screen AND left an unpaid order and a stock hold behind. The typed number is
     * checked before the spend; the account's, which needs the session, before the orders.
     */
    assert('⛔ the mobile network is checked before the spend (typed) and before the orders (account)', () => {
        const src = screenCode();
        const start = src.indexOf('export async function placeCheckout(');
        const place = start < 0 ? '' : src.slice(start, src.indexOf('\n}\n', start));
        const spend = place.indexOf("inAppSurfaceStore.consume('co'");
        const typed = place.indexOf('assertNetworkChargeable(gateway, typedNumber, false)');
        const account = place.indexOf('assertNetworkChargeable(gateway, payerNumber, true)');
        const orders = place.indexOf('createOrdersFromCart(');
        const checkAt = src.indexOf('function assertNetworkChargeable(');
        const check = checkAt < 0 ? '' : src.slice(checkAt, src.indexOf('\n}\n', checkAt));
        return spend > 0
            && typed > 0 && typed < spend
            && account > spend && account < orders
            && check.includes("gateway !== 'NOTCHPAY'")
            && check.includes('resolveCameroonOperator(')
            && check.includes('ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED');
    });

    console.log('\n── 10 · ⭐ The trigger — the silence at the moment the order is lost ──');

    /**
     * ⭐ **These five are the assertions that would have caught the original defect**, and the
     * defect was an ABSENCE: `PaymentOrchestratorService` published `payment.received.full` on
     * success and published nothing at all on FAILED or CANCELLED, so a refused mobile-money
     * push reached the customer as silence — indistinguishable from a payment that had worked
     * and gone quiet. The copy for it already existed in the catalogue with no trigger, which
     * is the hardest kind of gap to see: everything present looks correct.
     *
     * ⚠ A publisher with no subscriber, or a subscriber with no publisher, is the same silence
     * with a different shape. Both halves are pinned here for that reason.
     */
    assert('⛔ a dead payment PUBLISHES, on the webhook path and the verify path alike', () => {
        const src = orchestratorCode();
        const calls = (src.match(/await this\.handlePaymentFailure\(/g) ?? []).length;
        return src.includes("eventBus.publish('payment.failed'")
            && calls === 2
            && (src.match(/this\.isDeadStatus\([^)]*\) && !this\.isDeadStatus\(/g) ?? []).length === 2;
    });

    /**
     * ⚠ **The reconciliation sweep reaches the customer through `verifyPayment`**, which is why
     * that call site is not optional. `PaymentReconciliationWorker` closes a payment whose
     * callback never arrived by calling that method rather than the gateway directly — so the
     * customer whose failure is only discovered ten minutes later by the cron, who has been in
     * the dark longest, is told by the same line a client poll uses.
     */
    assert('⛔ the verify path publishes, so the reconciliation sweep reaches the customer', () => {
        const src = orchestratorCode();
        const verify = src.slice(src.indexOf('async verifyPayment'), src.indexOf('async applyWebhookEvent'));
        return verify.includes('this.handlePaymentFailure(');
    });

    /**
     * ⚠ **A local `FAILED` is NOT evidence of a failed payment**, and this is the assertion
     * that keeps somebody from "completing" the coverage by adding the obvious third call site.
     * `recordFailedAttempt` writes FAILED from the CATCH of the gateway call, which cannot tell
     * a refusal from a timeout — and a timeout means the charge may be live and the money may
     * be moving. `releaseDeadAttempt` is reached only from inside a NEW attempt, so a customer
     * pressing pay would be told their payment failed as they pressed it.
     */
    /**
     * ⚠ **REWRITTEN because the first version was VACUOUS, proven by mutation.** It sliced the
     * orchestrator from one method name to the next and asserted an absence. Renaming
     * `recordFailedAttempt` AND making it notify — a real regression — still passed: `indexOf`
     * returned -1, the slice became something else, and an absence is true of anything.
     *
     * Two changes make it unable to be true of nothing:
     *   - **scope first** — each named method must be found, bounded at its own close, or the
     *     assertion fails rather than passing;
     *   - **the whole file, not just two spans** — every call anywhere must sit inside one of
     *     the two SANCTIONED methods, so a renamed method, a new method or the OTP path cannot
     *     notify without failing this, whatever it is called.
     */
    assert('⛔ a merely-locally-failed attempt tells the customer NOTHING', () => {
        const src = orchestratorCode();
        const method = (sig: string): string | null => {
            const start = src.indexOf(sig);
            return start < 0 ? null : src.slice(start, src.indexOf('\n  }\n', start));
        };
        const record = method('private async recordFailedAttempt(');
        const release = method('private async releaseDeadAttempt(');
        const verify = method('async verifyPayment(');
        const webhook = method('async applyWebhookEvent(');
        if (!record || !release || !verify || !webhook) {
            console.error('      a scanned method was not found — the absence checks would be vacuous');
            return false;
        }

        const calls = (text: string): number => (text.match(/this\.handlePaymentFailure\(/g) ?? []).length;
        const sanctioned = calls(verify) + calls(webhook);
        return !record.includes('handlePaymentFailure')
            && !release.includes('handlePaymentFailure')
            && sanctioned === 2
            && calls(src) === sanctioned;
    });

    assert('⛔ the customer stack SUBSCRIBES to it', () =>
        notifyConsumerCode().includes(
            "eventBus.subscribe('payment.failed', handler.handleOrderPaymentFailed.bind(handler))",
        ));

    assert('the handler raises the situation the catalogue already has copy for', () => {
        const src = notifyHandlerCode();
        const handler = src.slice(src.indexOf('async handleOrderPaymentFailed'));
        return handler.includes("situation: 'order.payment_failed'")
            && handler.includes('idempotencyKey: `customer.order.payment_failed:${p.orderId}`');
    });

    /**
     * ⚠ **Money carries no preference key, and this is the strongest case for that rule on the
     * whole table.** A customer who muted "order updates" and then quietly lost an order to a
     * failed charge would have muted the one message that was never optional. `dispatch`
     * suppresses the entire notification — in-app record included — for a muted group, so an
     * entry added here would not degrade the message, it would delete it.
     */
    assert('⛔ no preference can silence a failed payment', () => {
        const src = notifyHandlerCode();
        const table = src.slice(src.indexOf('const SITUATION_PREFERENCE'), src.indexOf('};', src.indexOf('const SITUATION_PREFERENCE')));
        return !table.includes('order.payment_failed');
    });

    /**
     * ⚠ **The gateway's own `reason` is never relayed.** It is provider-sourced text that can
     * name the provider and its error codes, and the copy's second rule is that the message
     * blames nobody — a raw "insufficient funds" string breaks that in one word.
     */
    assert('⛔ the gateway\'s own failure text never reaches the customer', () => {
        const src = notifyHandlerCode();
        const handler = src.slice(
            src.indexOf('async handleOrderPaymentFailed'),
            src.indexOf('async handleOrderCancelled'),
        );
        return !handler.includes('reason') && !handler.includes('gatewayMessage');
    });

    console.log('\n── 10b · The same silence for a BOOKING — and the same exclusions ──');

    /**
     * ⭐ **A failed mobile-money payment for an appointment told the customer nothing** until
     * 2026-09-16: `handlePaymentFailure` returned early on anything that was not an order. The fix
     * put a booking branch INSIDE that method, so a booking inherits every exclusion § 10 pins —
     * the call sites are the webhook and the verify path, never the catch of the gateway call.
     *
     * ⚠ **What § 10 cannot see, and these can.** § 10 counts calls to `handlePaymentFailure`. It
     * says nothing about an event published BESIDE it — a `payment.failed` with
     * `aggregateType: 'booking'` published straight from `initiateBookingPayment`'s catch passes
     * every § 10 assertion, and tells somebody their appointment payment failed while their
     * handset may still be prompting them. So the rule pinned here is about the EVENT: every
     * failure-named publish in the orchestrator sits inside the one sanctioned method.
     *
     * ⚠ Each assertion bounds its own span and FAILS when the span is not found — an absence
     * check over a span that does not exist is true of nothing, and passes hardest when broken.
     */
    const orchestratorMethod = (src: string, sig: string): string | null => {
        const start = src.indexOf(sig);
        if (start < 0) return null;
        const end = src.indexOf('\n  }\n', start);
        return end < 0 ? null : src.slice(start, end);
    };
    const handlerMethod = (src: string, sig: string): string | null => {
        const start = src.indexOf(sig);
        if (start < 0) return null;
        const end = src.indexOf('\n    }\n', start);
        return end < 0 ? null : src.slice(start, end);
    };

    assert('⛔ every failure-named event the orchestrator publishes comes from handlePaymentFailure — none beside it', () => {
        const src = orchestratorCode();
        const start = src.indexOf('private async handlePaymentFailure(');
        const end = start < 0 ? -1 : src.indexOf('\n  }\n', start);
        if (start < 0 || end < 0) {
            console.error('      handlePaymentFailure was not found — the containment check would be vacuous');
            return false;
        }
        const failures = [...src.matchAll(/eventBus\.publish\(\s*'([^']+)'/g)]
            .filter((m) => /fail/i.test(m[1]));
        const outside = failures.filter((m) => m.index! < start || m.index! > end);
        if (outside.length > 0) {
            console.error(`      published outside the sanctioned method: ${outside.map((m) => m[1]).join(', ')}`);
        }
        return failures.length === 2
            && failures.every((m) => m[1] === 'payment.failed')
            && outside.length === 0;
    });

    assert('⛔ the booking branch is inside the sanctioned method, and returns before the order branch', () => {
        const fail = orchestratorMethod(orchestratorCode(), 'private async handlePaymentFailure(');
        if (!fail) return false;
        const from = fail.indexOf('if (transaction.bookingId) {');
        const to = fail.indexOf('if (orderIds.length === 0) return;');
        if (from < 0 || to < 0 || from > to) {
            console.error('      the booking branch was not found ahead of the order branch');
            return false;
        }
        const branch = fail.slice(from, to);
        const publish = branch.indexOf("eventBus.publish('payment.failed'");
        return publish > 0
            && branch.includes("aggregateType: 'booking'")
            && branch.includes('purpose: transaction.purpose')
            && branch.indexOf('return;', publish) > publish
            && !branch.includes('orderId:');
    });

    /**
     * ⚠ **The two booking payment-start methods write a local FAILED from the catch of the
     * gateway call, and that is exactly where a timeout cannot be told from a refusal.** The
     * customer is in that request and is answered by its 502. Pinned by name, with the local
     * write asserted present, so the absence below is about the span that holds the catch.
     */
    assert('⛔ neither booking payment-start method announces a failure — the customer is in that request', () => {
        const src = orchestratorCode();
        const methods = [
            orchestratorMethod(src, 'async initiateBookingPayment('),
            orchestratorMethod(src, 'async initiateBookingBalancePayment('),
        ];
        if (methods.some((m) => m === null)) {
            console.error('      a booking payment-start method was not found — the absence check would be vacuous');
            return false;
        }
        return methods.every((m) =>
            m!.includes('await this.recordFailedAttempt(transaction, error)')
            && m!.includes('ERROR_CODES.PAYMENT_INITIATION_FAILED, 502')
            && !m!.includes('handlePaymentFailure')
            && !/publish\(\s*'[^']*fail/i.test(m!));
    });

    assert('⛔ the customer stack SUBSCRIBES the booking handler to the same event', () =>
        notifyConsumerCode().includes(
            "eventBus.subscribe('payment.failed', handler.handleBookingPaymentFailed.bind(handler))",
        ));

    /**
     * ⚠ **Two handlers hear one event, so each must refuse the other's payload.** Without the
     * booking filter an order failure would also be announced as an appointment; without the
     * order filter the reverse. Either is a second, wrong message about one failed charge.
     */
    assert('each handler takes only its own payload — one failure, one message', () => {
        const src = notifyHandlerCode();
        const booking = handlerMethod(src, 'async handleBookingPaymentFailed(');
        const order = handlerMethod(src, 'async handleOrderPaymentFailed(');
        if (!booking || !order) return false;
        return booking.includes("if (p.aggregateType !== 'booking' || !p.bookingId) return;")
            && /p\.aggregateType && p\.aggregateType !== 'order'\)\) return;/.test(order);
    });

    assert('a balance and the original price are told apart — a customer can fail at both', () => {
        const booking = handlerMethod(notifyHandlerCode(), 'async handleBookingPaymentFailed(');
        if (!booking) return false;
        return booking.includes("situation: 'booking.payment_failed'")
            && booking.includes("const isBalance = p.purpose === 'booking_balance';")
            && booking.includes("idempotencyKey: `customer.booking.payment_failed:${p.bookingId}${isBalance ? ':balance' : ''}`");
    });

    /**
     * ⚠ **Keys compared as a SET, never by substring** — a substring check is fooled by a longer
     * key sharing the prefix. The table must also be found non-empty first: an empty set makes
     * "the key is absent" true of nothing.
     */
    assert('⛔ no preference can silence a failed booking payment', () => {
        const src = notifyHandlerCode();
        const at = src.indexOf('const SITUATION_PREFERENCE');
        const table = at < 0 ? '' : src.slice(at, src.indexOf('};', at));
        const keys = new Set([...table.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]));
        return keys.size > 0 && keys.has('booking.reminder') && !keys.has('booking.payment_failed');
    });

    assert('⛔ the gateway\'s own failure text never reaches a booking customer', () => {
        const fail = orchestratorMethod(orchestratorCode(), 'private async handlePaymentFailure(');
        const booking = handlerMethod(notifyHandlerCode(), 'async handleBookingPaymentFailed(');
        if (!fail || !booking) return false;
        const branch = fail.slice(fail.indexOf('if (transaction.bookingId) {'), fail.indexOf('if (orderIds.length === 0) return;'));
        return branch.length > 0
            && !/reason|gatewayMessage|rawGatewayPayloads|error/.test(branch)
            && !/reason|gatewayMessage/.test(booking);
    });

    chatDoorAssertions();
    drawnConfirmationAssertions();

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

/**
 * § 12 — checkout IN the conversation, and a charge refused at open (2026-09-22).
 *
 * The owner's decision: the assistant completes a purchase with tools, choosing the delivery
 * address from the account's saved ones and paying from the account's own wallet. The chat door
 * (`reviewInChat` → `placeInChat`) is a thin wrapper over the screen's own core, so what is
 * pinned here is (a) the one rule it adds — which address — driven directly, and (b) that it
 * adds no OTHER rule and keeps every protection the screen has.
 *
 * And the defect found on the way: a charge the gateway REFUSED as it was opened comes back as
 * a successful placement with `status: FAILED`, and every renderer said "approve the payment on
 * your phone" for it.
 */
function chatDoorAssertions(): void {
    console.log('\n══ § 12 · Checkout in the chat — review, then place ══');

    const saved = (id: string, opts: { isDefault?: boolean; geo?: unknown } = {}): ICustomerSavedAddress =>
        ({
            _id: id,
            label: `A-${id.slice(-2)}`,
            address_line1: '12 Rue Joss',
            city: 'Douala',
            country: 'CM',
            is_default: opts.isDefault ?? false,
            geo: 'geo' in opts ? opts.geo : { coordinates: [9.7, 4.05], formatted_address: 'Akwa, Douala' },
        }) as unknown as ICustomerSavedAddress;
    const ID = (n: number): string => `64b000000000000000000${String(n).padStart(3, '0')}`;
    const kindOf = (d: ReturnType<typeof resolveChatDestination>): string =>
        d.kind === 'blocked' ? `blocked:${d.blocker}` : d.kind === 'address' ? `address:${String(d.address._id)}` : d.kind;

    console.log('\n── 12a · Which address — the one rule the chat door adds ──');

    assert('a digital basket needs no address, whatever id the model sends', () =>
        kindOf(resolveChatDestination('digital', [], ID(1))) === 'digital'
        && kindOf(resolveChatDestination('digital', [saved(ID(2), { geo: null })], null)) === 'digital');

    assert('an id that is not one of the customer\'s addresses is refused, never guessed', () =>
        kindOf(resolveChatDestination('physical', [saved(ID(1), { isDefault: true })], ID(9))) === 'blocked:address_not_found');

    assert('a chosen address with no mapped location is refused', () =>
        kindOf(resolveChatDestination('physical', [saved(ID(1), { geo: null })], ID(1))) === 'blocked:address_not_deliverable');

    // `toBotAddressDto` says `deliverable: Boolean(geo?.coordinates)` — the chat must not confirm
    // an address the address book called undeliverable a turn earlier.
    assert('"deliverable" means coordinates, not merely a geo object', () =>
        kindOf(resolveChatDestination('physical', [saved(ID(1), { geo: {} })], ID(1))) === 'blocked:address_not_deliverable');

    assert('a chosen deliverable address wins over the default', () =>
        kindOf(resolveChatDestination('physical', [saved(ID(1), { isDefault: true }), saved(ID(2))], ID(2))) === `address:${ID(2)}`);

    assert('with no choice: the default, even when it is not first', () =>
        kindOf(resolveChatDestination('physical', [saved(ID(1)), saved(ID(2), { isDefault: true })], null)) === `address:${ID(2)}`);

    assert('with no choice and no default: the first — the screen\'s rule exactly', () =>
        kindOf(resolveChatDestination('physical', [saved(ID(1)), saved(ID(2))], null)) === `address:${ID(1)}`);

    /**
     * ⛔ **The default is a statement of where the customer wants things.** Skipping it for "some
     * other geocoded address" would ship a parcel to their office because their home was typed by
     * hand — a decision for them, handed back with the list, never taken by a fallback.
     */
    assert('⛔ an undeliverable default is REFUSED, never silently skipped for another address', () =>
        kindOf(resolveChatDestination('physical', [saved(ID(1), { isDefault: true, geo: null }), saved(ID(2))], null))
            === 'blocked:address_not_deliverable');

    assert('no saved address at all is its own blocker — the website remedy', () =>
        kindOf(resolveChatDestination('physical', [], null)) === 'blocked:no_saved_address');

    console.log('\n── 12b · The chat door keeps every protection the screen has ──');

    const fn = (src: string, sig: string): string => {
        const start = src.indexOf(sig);
        return start < 0 ? '' : src.slice(start, src.indexOf('\n}\n', start));
    };

    /**
     * ⛔ **Before the spend, because it can be.** The screen learns its customer only from the
     * session; the chat knows the caller up front, so a wrong address id or a missing wallet is
     * refused with the handle still alive and fixed in the same turn.
     */
    assert('⛔ the chat door is checked BEFORE the spend, and its chosen id reaches the orders', () => {
        const place = fn(screenCode(), 'export async function placeCheckout(');
        const precheck = place.indexOf('precheckChatDoor(');
        const spend = place.indexOf("inAppSurfaceStore.consume('co'");
        return precheck > 0 && spend > precheck
            && /createOrdersFromCart\([\s\S]{0,160}\{ addressId, address: null \}/.test(place)
            && !/createOrdersFromCart\([\s\S]{0,160}addressId:\s*null/.test(place);
    });

    /**
     * ⛔ **A handle belongs to one customer.** A `co` URL is forwardable; pasted into somebody's
     * own chat it must not place an order for whoever it was minted for. Refused like an unknown
     * handle (anything else confirms it is real) and marked spent (because it now is).
     */
    assert('⛔ on the chat door the handle must be the CALLER\'s, checked straight after the spend', () => {
        const place = fn(screenCode(), 'export async function placeCheckout(');
        const spend = place.indexOf("inAppSurfaceStore.consume('co'");
        const owner = place.indexOf('session.customerId !== options.callerCustomerId');
        const tryAt = place.indexOf('try {', spend);
        return spend > 0 && owner > spend && owner < tryAt
            && place.slice(owner, tryAt).includes('throw handleGone(true)');
    });

    assert('⛔ every chat-door precheck refusal leaves the handle alive (`spent: false`)', () => {
        const src = screenCode();
        const pre = fn(src, 'async function precheckChatDoor(');
        const refusals = [...pre.matchAll(/createAppError\(/g)].length;
        const alive = [...pre.matchAll(/spent: false/g)].length;
        return pre.length > 0 && refusals >= 4 && alive === refusals
            && !pre.includes('inAppSurfaceStore.')
            && !pre.includes('createOrdersFromCart(')
            && !pre.includes('initiatePaymentForCart(');
    });

    /**
     * ⛔ **The review named an address; the place must name the same one.** Falling back to the
     * default at place time would ship the parcel elsewhere whenever the review had named a
     * different address — the reason `checkout_create_orders` requires the id too.
     */
    assert('⛔ a physical placement on the chat door must NAME its address', () => {
        const pre = fn(screenCode(), 'async function precheckChatDoor(');
        // The STATEMENT, not the phrase: `if (false && …)` keeps the phrase and removes the rule.
        const guard = pre.indexOf("if (cart.productType !== 'digital' && !requestedAddressId) {");
        const block = guard < 0 ? '' : pre.slice(guard, pre.indexOf('\n    }\n', guard));
        return block.includes('throw createAppError(')
            && block.includes("reason: 'address_not_named'")
            && guard < pre.indexOf('resolveChatDestination(');
    });

    assert('the wallet on the chat door is the ACCOUNT\'s, network-checked before the spend', () => {
        const pre = fn(screenCode(), 'async function precheckChatDoor(');
        return pre.includes('storedPayerNumber(customer)')
            && pre.includes('assertNetworkChargeable(gateway, stored, false)')
            && pre.includes('ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED');
    });

    /**
     * ⚠ **The screen is sent `CheckoutPlaced` field by field.** Order numbers and the masked
     * wallet are for the chat; a `co` URL is forwardable, and a spread would publish whatever the
     * placement gains next.
     */
    assert('⛔ the screen\'s write projects the placement explicitly — no order numbers, no wallet', () => {
        const src = screenCode();
        const start = src.indexOf('export class CheckoutController {');
        const cls = src.slice(start, src.indexOf('\n}\n', start));
        return start > 0
            && cls.includes('orderCount: placed.orderCount')
            && cls.includes('status: placed.status')
            && !cls.includes('orderNumbers')
            && !cls.includes('payerMasked')
            && !/sendSuccess\(res,\s*placed\)/.test(cls)
            && !/sendSuccess\(res,\s*await placeCheckout\(/.test(cls);
    });

    const chat = chatCode();
    const between = (from: string, to: string): string => {
        const start = chat.indexOf(from);
        const end = to ? chat.indexOf(to, start + from.length) : -1;
        return start < 0 ? '' : chat.slice(start, end < 0 ? chat.length : end);
    };
    /**
     * ⚠ **The review and the placement moved OUT of the statics on 2026-09-22**, into
     * `reviewChatCheckout` / `placeChatCheckout`, because a Place order TAP runs them too and a tap
     * may never await an `asyncHandler`-wrapped static. The scans below follow the bodies — a scan
     * left on the statics would read a two-line wrapper and pass every "must NOT" for free — and
     * the first assertion after these pins the statics as the wrappers they now are.
     */
    const review = fn(chat, 'async function reviewChatCheckout(');
    const placeInChat = fn(chat, 'async function placeChatCheckout(');
    const reviewRoute = between('static reviewInChat', 'static placeInChat');
    const placeRoute = between('static placeInChat', '\n}\n');

    assert('⛔ the two routes are thin wrappers over the ONE review and the ONE placement', () =>
        review.length > 0 && placeInChat.length > 0
        && reviewRoute.includes('await reviewChatCheckout(req, res, deliveryAddressId ?? null)')
        && !reviewRoute.includes('inAppSurfaceStore.') && !reviewRoute.includes('readChatCheckout(')
        && placeRoute.includes('await placeChatCheckout(req, res, checkoutRef, deliveryAddressId ?? null, phone)')
        && !placeRoute.includes('placeCheckout(')
        // One placement in the whole chat controller — the route and the tap cannot drift.
        && (chat.match(/\bplaceCheckout\(/g) ?? []).length === 1);

    /**
     * ⚠ **Every `co` mint in the chat controller holds a cart id and no money** — the rule § 6
     * pins for the screen door, which reads only the FIRST mint in the file. The review is a
     * second one.
     */
    assert('⛔ EVERY checkout handle the chat controller mints holds a cart id and no money', () => {
        const mints = [...chat.matchAll(/inAppSurfaceStore\.mint\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
        return mints.length === 2
            && mints.every((body) => body.includes("kind: 'co'") && /cartId: (cart|view)\.cartId/.test(body)
                && !/\b(total|price|amount|subtotal)\s*:/i.test(body));
    });

    assert('the review mints the credential only when the checkout can go ahead', () =>
        /const checkoutRef = blocked\s*\?\s*null\s*:\s*await inAppSurfaceStore\.mint\(/.test(review));

    assert('⛔ the review is the screen\'s read — no rule of its own', () =>
        review.includes('readChatCheckout(caller.customerId')
        && !review.includes('cartService.')
        && !review.includes('quoteForCustomer')
        && !review.includes('storedPayerNumber')
        && !review.includes('.reduce('));

    assert('⛔ the chat place IS `placeCheckout`, with the caller — it creates nothing itself', () =>
        /placeCheckout\(checkoutRef, phone, \{\s*callerCustomerId: caller\.customerId,/.test(placeInChat)
        && !placeInChat.includes('createOrdersFromCart(')
        && !placeInChat.includes('initiatePaymentForCart(')
        && !placeInChat.includes('inAppSurfaceStore.')
        && !placeInChat.includes('mobileMoneyGateway('));

    assert('the chat place reports a refused-at-open charge as `failed`, through the one mapping', () =>
        placeInChat.includes('state: stateOf(placed.status)'));

    assert('its amount is the transaction\'s snapshot, formatted — never a sum', () =>
        placeInChat.includes('formatBotPrice(transaction.amountSnapshot, transaction.currencySnapshot)')
        && !placeInChat.includes('.reduce('));

    /**
     * ⛔ **No gateway, no address text, no coordinate, no customer id from the body.** The key
     * sets are pinned EXACTLY: a model-facing schema that grew `gateway` would let a caller choose
     * where a stranger's money goes, and one that grew an address string would capture an address
     * the owner ruled must be added on the website.
     */
    assert('⛔ the chat door\'s two bodies accept exactly the keys they need, strictly', () => {
        const schemaKeys = (name: string): string[] | null => {
            const at = chat.indexOf(`const ${name} = z`);
            if (at < 0) return null;
            const body = chat.slice(at, chat.indexOf('.strict();', at));
            // A key opens a line or follows the object's `{` — the review's one key sits inline.
            return [...body.matchAll(/(?:^|\{)\s*([a-zA-Z]+):/gm)].map((m) => m[1]).sort();
        };
        const reviewKeys = schemaKeys('ChatReviewSchema');
        const placeKeys = schemaKeys('ChatPlaceSchema');
        return reviewKeys?.join(',') === 'deliveryAddressId'
            && placeKeys?.join(',') === 'checkoutRef,deliveryAddressId,phone'
            && chat.slice(chat.indexOf('const ChatPlaceSchema')).includes('OptionalPhoneNumberSchema');
    });

    console.log('\n── 12c · A charge refused AT OPEN is never "approve it on your phone" ──');

    /**
     * ⛔ The orchestrator answers a gateway's refusal as a RESULT (`status: FAILED`, 200), not an
     * error — the orders exist. The page used to say "approve the payment on your phone" for every
     * 200, sending the customer to wait for a prompt that was never coming.
     */
    assert('⛔ the page reads the charge status and says `failed` BEFORE any "approve it" line', () => {
        const c = pageCode();
        const errorBranch = c.indexOf('if (!res.ok || !res.body || res.body.success === false)');
        const read = c.indexOf('var charge = res.body.data && res.body.data.status;');
        const refused = c.indexOf('if (charge === "FAILED" || charge === "CANCELLED")');
        const watch = c.indexOf('say(copy.checkoutWatchChat, false);');
        const branch = refused < 0 ? '' : c.slice(refused, c.indexOf('}', refused));
        return errorBranch > 0 && read > errorBranch && refused > read && watch > refused
            && branch.includes('say(copy.failed, true);')
            && branch.includes('return;');
    });

    const copy = inAppCopy('en');
    const notice = (status: string): unknown =>
        (placedResponse({ orderCount: 1, transactionId: 't', status: status as never }, copy).data as { message?: unknown })
            .message;

    assert('⛔ the WhatsApp form says `failed` for a charge refused at open — FAILED and CANCELLED', () =>
        notice('FAILED') === copy.failed && notice('CANCELLED') === copy.failed);

    assert('…and still "approve it on your phone" for a charge that opened', () =>
        notice('PENDING') === copy.checkoutWatchChat && notice('INITIATED') === copy.checkoutWatchChat);

    assert('a refused charge is still stamped `placed` — the orders DO exist', () => {
        const data = placedResponse({ orderCount: 1, transactionId: 't', status: 'FAILED' }, copy).data as { outcome?: unknown };
        return data.outcome === 'placed';
    });

    console.log('\n── 12d · No saved address: ONE link, to the website, built by the server ──');

    /**
     * ⚠ **The URL is built in the core, through the storefront's one reader and the path table
     * `verify:landing-routes` checks** — never a literal, never by the page. And only for the
     * no-address state: a link on a screen that can already take the payment would lead the
     * customer away from the Pay button for nothing.
     */
    assert('⛔ the add-address URL is the server\'s, and exists only in the no-address state', () => {
        const read = fn(screenCode(), 'export async function readCheckoutView(');
        return /addAddressUrl: address \? null : botStorefrontLink\(surfacePath\('addresses'\), session\.language\)/.test(read)
            && !/addAddressUrl:\s*['"`]/.test(screenCode());
    });

    assert('the page\'s read hands it through — the /data contract is five fields', () => {
        const src = screenCode();
        const start = src.indexOf('export class CheckoutController {');
        const cls = src.slice(start, src.indexOf('\n}\n', start));
        return cls.includes('addAddressUrl: view.addAddressUrl ?? null');
    });

    const pageSrc = pageCode();
    const noAddressBranch = (() => {
        const at = pageSrc.indexOf('if (!data.address) {');
        return at < 0 ? '' : pageSrc.slice(at, pageSrc.indexOf('}', at));
    })();

    assert('⛔ the link is drawn in the no-address state and in NO other', () => {
        const calls = [...pageSrc.matchAll(/addressLink\(/g)].length;
        return noAddressBranch.includes('state(copy.checkoutNoAddress, false);')
            && noAddressBranch.includes('addressLink(data.addAddressUrl);')
            && noAddressBranch.indexOf('addressLink(') < noAddressBranch.indexOf('return;')
            // the definition + the one call site
            && calls === 2;
    });

    /**
     * ⛔ **A server value is still checked before it becomes a link** — only http(s), set through
     * `href` and `textContent`, never concatenated into markup. Defence in depth: the day
     * `STOREFRONT_URL` is mistyped as something else, the page draws nothing rather than a
     * `javascript:` target.
     */
    assert('⛔ the link accepts only an http(s) URL and never composes markup from it', () => {
        const at = pageSrc.indexOf('function addressLink(url) {');
        const body = at < 0 ? '' : pageSrc.slice(at, pageSrc.indexOf('\n  }\n', at));
        return body.includes('if (typeof url !== "string" || !/^https?:\\/\\//i.test(url)) return;')
            && body.includes('a.href = url;')
            && body.includes('a.textContent = copy.checkoutAddAddress;')
            && !body.includes('innerHTML')
            && body.includes('rel = "noopener noreferrer"');
    });

    assert('a re-render removes the link, so a retried read can never show two', () => {
        const at = pageSrc.indexOf('function state(text, retry) {');
        const body = at < 0 ? '' : pageSrc.slice(at, pageSrc.indexOf('\n  }\n', at));
        return body.includes('document.getElementById("addAddress")') && body.includes('oldLink.remove()');
    });

    assert('the link\'s words resolve in all five languages, and say what the owner ruled', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const c = inAppCopy(lang) as Record<string, string>;
            return typeof c.checkoutAddAddress === 'string' && c.checkoutAddAddress.trim().length > 0;
        })
        && /website/i.test(inAppCopy('en').checkoutNoAddress)
        && !/send me your address/i.test(inAppCopy('en').checkoutNoAddress));
}

/**
 * § 13 — the server draws the money confirmation, and the placement (2026-09-22).
 *
 * ⛔ **Why this section exists.** A customer typed "Place order"; `checkout_review` returned the
 * total, the address, the masked wallet and a `checkoutRef`; and the model's own confirmation came
 * back TRUNCATED to "Your order is 200 XAF," (core exec 2294). The customer never saw the question,
 * and the order was later placed without a proper one. So the review now draws the confirmation —
 * Place order · Not now, or one row per address — and the placement draws what to do with the phone.
 *
 * ⚠ **The controller cannot be imported here** (it reaches `orders/` and `payments/`, which hang a
 * bare `ts-node` run), so the reply builders were written PURE in `domain/checkout-chat-reply.ts`
 * and are driven directly; the controller's wiring is pinned by scan, span by span.
 */
function drawnConfirmationAssertions(): void {
    console.log('\n══ § 13 · The server draws the money confirmation — review, tap, placement ══');

    const ID = (n: number): string => `64b000000000000000000${String(n).padStart(3, '0')}`;
    /** A real handle, generated by the store's own generator — never a restated shape. */
    const REF = newInAppHandle();
    /** The masked form of the suite's fixture number, 237600000001 (`maskPhone`'s shape). */
    const PHONE = '+2376••••0001';
    const WA_TO = '237600000001';
    const TG_TO = '600000001';
    const chosen = { addressChosen: false };

    const address = (n: number, over: Partial<BotAddressDto> = {}): BotAddressDto => ({
        id: ID(n),
        label: `Place ${n}`,
        formattedAddress: `${n} Rue Joss, Akwa, Douala`,
        addressLine2: null,
        city: 'Douala',
        state: null,
        country: 'CM',
        isDefault: false,
        deliverable: true,
        ...over,
    });
    const HOME = address(1, { label: 'Home', isDefault: true });
    const OFFICE = address(2, { label: 'Office' });
    const SHOP = address(3, { label: 'Shop' });
    const SHED = address(4, { label: 'Shed', deliverable: false });

    const review = (over: Partial<ChatReviewForReply> = {}): ChatReviewForReply => ({
        ready: true,
        blocker: null,
        checkoutRef: REF,
        lines: [{ title: 'Red shoes', variantLabel: '42', quantity: 2, lineTotalText: '20 000 XAF' }],
        totalText: '21 500 XAF',
        delivery: { kind: 'address', address: HOME },
        addresses: [HOME],
        payment: { method: 'mobile_money', phoneMasked: PHONE },
        addAddressUrl: null,
        ...over,
    });

    type Choice = Extract<BotReplyIntent, { kind: 'choice' }>;
    type Text = Extract<BotReplyIntent, { kind: 'text' }>;
    const choice = (intent: BotReplyIntent | null): Choice | null => (intent?.kind === 'choice' ? intent : null);
    const textOf = (intent: BotReplyIntent | null): Text | null => (intent?.kind === 'text' ? intent : null);

    interface WaInteractive {
        type?: string;
        body?: { text?: string };
        action?: {
            buttons?: Array<{ reply: { id: string; title: string } }>;
            sections?: Array<{ rows: Array<{ id: string; title: string; description?: string }> }>;
        };
    }
    const waOf = (intent: BotReplyIntent): WaInteractive =>
        (renderBotReply(intent, 'whatsapp', WA_TO).body as { interactive?: WaInteractive }).interactive ?? {};
    const tgRowsOf = (intent: BotReplyIntent): Array<Array<{ callback_data?: string }>> =>
        (renderBotReply(intent, 'telegram', TG_TO).body as {
            reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
        }).reply_markup?.inline_keyboard ?? [];

    console.log('\n── 13a · The confirmation checkout_review draws ──');

    const single = choice(checkoutReviewReply(review(), chosen, 'en'));

    assert('⛔ one deliverable address: Place order (to THAT address) · Not now', () =>
        single !== null
        && single.options.length === 2
        && single.options[0].id === checkoutConfirmActionId(REF, HOME.id)
        && single.options[0].label === botChrome('placeOrderButton', 'en')
        && single.options[1].id === checkoutDeclineActionId(REF)
        && single.options[1].label === botChrome('notNowButton', 'en'));

    assert('…its text is the review line for line, and ENDS in the question', () => {
        const text = single?.text ?? '';
        return text.startsWith(botChrome('checkoutReviewIntro', 'en'))
            && text.includes('2 × Red shoes (42) — 20 000 XAF')
            && text.includes(`${botChrome('checkoutTotalLabel', 'en')} 21 500 XAF`)
            && text.includes(`${botChrome('checkoutDeliverToLabel', 'en')} Home — 1 Rue Joss, Akwa, Douala`)
            && text.includes(`${botChrome('checkoutMobileMoneyLabel', 'en')} ${PHONE}`)
            && text.endsWith(botChrome('checkoutPlaceQuestion', 'en'));
    });

    /**
     * ⛔ **The channel is where a truncation happens, so the channel is what is checked.** The body
     * must reach WhatsApp whole — the question is its last line — and the two controls must be reply
     * BUTTONS carrying the tokens, not a list hiding them behind a "Choose" tap.
     */
    assert('⛔ on WhatsApp: two reply buttons and the body UNCUT; on Telegram: two inline rows', () => {
        if (!single) return false;
        const wa = waOf(single);
        const rows = tgRowsOf(single);
        return wa.type === 'button'
            && wa.body?.text === single.text
            && wa.action?.buttons?.length === 2
            && wa.action.buttons[0].reply.id === single.options[0].id
            && rows.length === 2
            && rows[0][0].callback_data === single.options[0].id
            && rows[1][0].callback_data === single.options[1].id;
    });

    const several = choice(checkoutReviewReply(review({ addresses: [HOME, OFFICE, SHED, SHOP] }), chosen, 'en'));

    assert('⛔ several deliverable addresses: one row per address that PLACES there, default first, then Not now', () => {
        const ids = several?.options.map((option) => option.id) ?? [];
        return ids.length === 4
            && ids[0] === checkoutConfirmActionId(REF, HOME.id)
            && ids[1] === checkoutConfirmActionId(REF, OFFICE.id)
            && ids[2] === checkoutConfirmActionId(REF, SHOP.id)
            && ids[3] === checkoutDeclineActionId(REF)
            && !ids.some((id) => id.includes(SHED.id));
    });

    assert('…the text names no destination and asks WHERE; each row carries its own address', () =>
        several !== null
        && !several.text.includes(botChrome('checkoutDeliverToLabel', 'en'))
        && several.text.endsWith(botChrome('checkoutChooseAddressQuestion', 'en'))
        && several.options[1].shortLabel === 'Office'
        && several.options[1].description === OFFICE.formattedAddress
        && several.options[1].label.includes(OFFICE.formattedAddress));

    assert('⛔ on WhatsApp that is a LIST — a row has room for the address and a button does not', () => {
        if (!several) return false;
        const wa = waOf(several);
        const rows = wa.action?.sections?.[0]?.rows ?? [];
        return wa.type === 'list'
            && rows.length === 4
            && rows[0].id === several.options[0].id
            && rows.every((row) => row.title.length <= 24 && (row.description ?? '').length <= 72);
    });

    assert('a list never passes WhatsApp\'s ten rows: nine addresses, then Not now', () => {
        const many = Array.from({ length: 12 }, (_, i) => address(10 + i));
        const list = choice(checkoutReviewReply(review({ addresses: [HOME, ...many] }), chosen, 'en'));
        return list !== null
            && list.options.length === __CHECKOUT_REPLY_LIMITS.MAX_ADDRESS_OPTIONS + 1
            && list.options[list.options.length - 1].id === checkoutDeclineActionId(REF)
            && (waOf(list).action?.sections?.[0]?.rows.length ?? 0) === 10;
    });

    assert('⛔ an address the customer NAMED is confirmed on its own, never offered again among the rest', () => {
        const named = choice(checkoutReviewReply(
            review({ delivery: { kind: 'address', address: OFFICE }, addresses: [HOME, OFFICE, SHOP] }),
            { addressChosen: true },
            'en',
        ));
        return named !== null
            && named.options.length === 2
            && named.options[0].id === checkoutConfirmActionId(REF, OFFICE.id)
            && named.text.includes(`Office — ${OFFICE.formattedAddress}`);
    });

    assert('a download names the account it is SENT to, and its Place order carries no address', () => {
        const digital = choice(checkoutReviewReply(
            review({ delivery: { kind: 'digital', to: 'j•••@example.com' }, addresses: [] }),
            chosen,
            'en',
        ));
        return digital !== null
            && digital.options[0].id === checkoutConfirmActionId(REF, null)
            && digital.text.includes(`${botChrome('checkoutSentToLabel', 'en')} j•••@example.com`)
            && !digital.text.includes(botChrome('checkoutDeliverToLabel', 'en'));
    });

    const WEBSITE = 'https://shop.example/en/shop/account/addresses';
    const blocked = (blocker: ChatReviewForReply['blocker'], over: Partial<ChatReviewForReply> = {}): ChatReviewForReply =>
        review({ ready: false, blocker, checkoutRef: null, delivery: null, addAddressUrl: WEBSITE, ...over });

    assert('⛔ no saved address: ONE link, to the website\'s address page (owner\'s ruling 2026-09-20)', () => {
        const link = checkoutReviewReply(blocked('no_saved_address', { addresses: [] }), chosen, 'en');
        return link?.kind === 'link'
            && link.url === WEBSITE
            && link.label === botChrome('addAddressButton', 'en')
            && link.text === botChrome('checkoutAddAddressPrompt', 'en');
    });

    assert('…and the same when NO address can be delivered to — but not when another one can', () =>
        checkoutReviewReply(blocked('address_not_deliverable', { addresses: [SHED] }), chosen, 'en')?.kind === 'link'
        && checkoutReviewReply(blocked('address_not_deliverable', { addresses: [SHED, OFFICE] }), chosen, 'en') === null);

    assert('never a dead button: with no storefront URL there is no link at all', () =>
        checkoutReviewReply(blocked('no_saved_address', { addresses: [], addAddressUrl: null }), chosen, 'en') === null);

    /**
     * ⛔ **No wallet, no buttons.** A Place order over an account with no number could only fail
     * after the customer pressed it; the model asks for a number instead, as it always has.
     */
    assert('⛔ no number on the account: NO reply — the model asks; an unknown address and an empty review neither', () =>
        checkoutReviewReply(review({ payment: { method: 'mobile_money', phoneMasked: null } }), chosen, 'en') === null
        && checkoutReviewReply(blocked('address_not_found'), chosen, 'en') === null
        && checkoutReviewReply(review({ lines: [] }), chosen, 'en') === null
        && checkoutReviewReply(review({ checkoutRef: null }), chosen, 'en') === null);

    assert('five basket lines at most, then "+ N more" — filled, never a brace', () => {
        const lines = Array.from({ length: 7 }, (_, i) => ({
            title: `Item ${i + 1}`, variantLabel: null, quantity: 1, lineTotalText: '1 000 XAF',
        }));
        const text = choice(checkoutReviewReply(review({ lines }), chosen, 'en'))?.text ?? '';
        return text.includes('1 × Item 5 — 1 000 XAF')
            && !text.includes('Item 6')
            && text.includes(botChromeFill('checkoutMoreLines', 'en', { count: '2' }))
            && !/[{}]/.test(text);
    });

    /**
     * ⛔ **The defect this section exists for, at the one place it can come back.** WhatsApp cuts an
     * interactive body at 1024 characters, from the END — and the end is the question. Long product
     * names must fold into "+ N more"; the summary and the question never give way.
     */
    assert('⛔ the question is never what gets cut: long lines fold, in every language, and the body fits', () => {
        const lines = Array.from({ length: 9 }, (_, i) => ({
            title: `${'Ensemble de cuisine en acier inoxydable, poignées ergonomiques et couvercles '.repeat(3)}${i}`,
            variantLabel: 'Grand modèle, finition brossée, garantie de deux ans pièces et main-d’œuvre',
            quantity: 3,
            lineTotalText: '12 500 000 XAF',
        }));
        const far = address(5, { label: 'Maison de ma grand-mère à Bonapriso, près du marché', formattedAddress: 'Rue '.repeat(100) });
        const long = review({ lines, delivery: { kind: 'address', address: far }, addresses: [far] });

        let folded = false;
        const fits = BOT_COPY_LANGUAGES.every((lang) => {
            const intent = choice(checkoutReviewReply(long, chosen, lang));
            if (!intent) return false;
            const shown = intent.text.split('\n').filter((line) => line.includes(' × ')).length;
            if (shown < __CHECKOUT_REPLY_LIMITS.MAX_BASKET_LINES) folded = true;
            return intent.text.length <= __CHECKOUT_REPLY_LIMITS.BODY_LIMIT
                && intent.text.endsWith(botChrome('checkoutPlaceQuestion', lang))
                && waOf(intent).body?.text === intent.text;
        });
        // Non-vacuity: the fixture must actually push past the cap, or this proves nothing.
        if (!folded) console.error('      the fixture never forced a fold — lengthen it');
        return fits && folded;
    });

    console.log('\n── 13b · The tokens: a real handle, 64 bytes, and one grammar ──');

    assert('⛔ a handle the STORE generates is a checkout ref, and the longest button fits 64 bytes', () => {
        const handle = newInAppHandle();
        const worst = checkoutConfirmActionId(handle, 'f'.repeat(24));
        return isCheckoutRef(handle)
            && __CALLBACK_DATA_BYTES === 64
            && Buffer.byteLength(worst, 'utf8') <= __CALLBACK_DATA_BYTES
            && checkoutTokenBudgetProblems({ handleLength: handle.length }).length === 0;
    });

    assert('⛔ it BITES: a handle 15 characters longer is named as too long for the address button', () => {
        const problems = checkoutTokenBudgetProblems({ handleLength: newInAppHandle().length + 15 });
        const named = problems.some((line) => line.includes('with an address'));
        const declineStillFits = !problems.some((line) => line.includes('Not now'));
        if (!named) console.error(`      reported instead: ${problems.join('; ') || '(nothing)'}`);
        return named && declineStillFits;
    });

    const route = (token: string): ReturnType<typeof actionKeyOf> | null => {
        const parsed = parseBotActionId(token);
        return parsed ? actionKeyOf(parsed) : null;
    };

    assert('⛔ what is drawn routes to `yes:co` / `no:co` and parses back to the same ref and address', () => {
        const confirm = route(checkoutConfirmActionId(REF, HOME.id));
        const download = route(checkoutConfirmActionId(REF, null));
        const decline = route(checkoutDeclineActionId(REF));
        const c = confirm ? parseCheckoutConfirm(confirm.action.argument) : null;
        const d = download ? parseCheckoutConfirm(download.action.argument) : null;
        return confirm?.key === 'yes:co' && c?.checkoutRef === REF && c?.addressId === HOME.id
            && download?.key === 'yes:co' && d?.checkoutRef === REF && d?.addressId === null
            && decline?.key === 'no:co' && parseCheckoutDecline(decline.action.argument) === REF;
    });

    assert('⛔ the parser is strict — anything this service did not build is refused', () => {
        const refused = [
            '', 'ia_', 'xx_abcdefghijklmnopqrstuv', `${REF}:not-an-id`, `${REF}:${HOME.id}:extra`,
            `${REF}:${HOME.id}:`, `${REF} `, `${REF}:${HOME.id.slice(1)}`, `${HOME.id}:${REF}`,
        ];
        const accepted = refused.filter((argument) => parseCheckoutConfirm(argument) !== null);
        if (accepted.length) console.error(`      accepted: ${accepted.join(' · ')}`);
        return accepted.length === 0
            && parseCheckoutDecline(`${REF}:${HOME.id}`) === null
            && parseCheckoutDecline('') === null;
    });

    assert('a builder refuses to draw a button from something that is not a checkout handle', () => {
        const throws = (build: () => string): boolean => {
            try {
                build();
                return false;
            } catch {
                return true;
            }
        };
        return throws(() => checkoutConfirmActionId('not-a-handle', HOME.id))
            && throws(() => checkoutConfirmActionId(REF, 'nope'))
            && throws(() => checkoutDeclineActionId(`${REF}:x`));
    });

    console.log('\n── 13c · The taps: registered once, placing once, asking again when stale ──');

    const CONTROLLERS = path.join(SCAN_ROOT, 'src/modules/bot-surface/controllers');
    const chat = chatCode();
    const span = (sig: string): string => {
        const start = chat.indexOf(sig);
        return start < 0 ? '' : chat.slice(start, chat.indexOf('\n}\n', start));
    };
    const checkoutMap = (() => {
        const at = chat.indexOf('export const CHECKOUT_ACTION_HANDLERS');
        return at < 0 ? '' : chat.slice(at, chat.indexOf('});', at));
    })();

    assert('⛔ `yes:co` → Place order and `no:co` → Not now are registered, merged, and claimed by nobody else', () => {
        const dispatcher = stripTs(fs.readFileSync(path.join(CONTROLLERS, 'bot-action.controller.ts'), 'utf8'));
        const claims = fs.readdirSync(CONTROLLERS)
            .filter((file) => file.endsWith('.ts'))
            .map((file) => stripTs(fs.readFileSync(path.join(CONTROLLERS, file), 'utf8')))
            .reduce((sum, src) => sum + (src.match(/'(?:yes|no):co'\s*:/g) ?? []).length, 0);
        return /'yes:co':\s*confirmCheckoutTap,/.test(checkoutMap)
            && /'no:co':\s*declineCheckoutTap,/.test(checkoutMap)
            && /\[\s*'checkout',\s*CHECKOUT_ACTION_HANDLERS\s*\]/.test(dispatcher)
            && claims === 2;
    });

    const confirmTap = span('async function confirmCheckoutTap(');
    const declineTap = span('async function declineCheckoutTap(');
    const lapsed = span('function isUnspentLapsedCheckout(');

    assert('⛔ Place order runs THE placement, with the button\'s address and the account\'s own wallet', () =>
        confirmTap.includes('parseCheckoutConfirm(action.argument)')
        && /if \(!tap\) throw unknownBotAction\(\);/.test(confirmTap)
        && confirmTap.includes('await placeChatCheckout(req, res, tap.checkoutRef, tap.addressId, null);')
        && !confirmTap.includes('placeCheckout(')
        && !/\bnext\b/.test(confirmTap));

    /**
     * ⛔ **Only an UNSPENT lapse is asked again.** `placeCheckout`'s rule is that a MISSING flag means
     * orders may exist — so `spent !== true` would re-ask over an order that is real, and a catch-all
     * would turn every refusal into a confirmation. `=== false` and nothing else.
     */
    assert('⛔ a stale ref ASKS AGAIN for the same address — and only an unspent lapse, before any answer', () =>
        /if \(res\.headersSent \|\| !isUnspentLapsedCheckout\(error\)\) throw error;/.test(confirmTap)
        && confirmTap.includes('await reviewChatCheckout(req, res, tap.addressId);')
        && lapsed.includes('error instanceof AppError')
        && lapsed.includes('error.code === ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED')
        && lapsed.includes('error.details?.spent === false')
        && !/spent\s*!==\s*true/.test(lapsed));

    assert('⛔ Not now writes nothing — no store, no placement, no basket — and says so', () =>
        declineTap.includes('parseCheckoutDecline(action.argument)')
        && declineTap.includes('checkoutDeclinedReply(')
        && declineTap.includes('sendSuccess(res, { placed: false })')
        && !/inAppSurfaceStore\.|placeCheckout\(|placeChatCheckout\(|cartService\.|Model\./.test(declineTap));

    assert('the placement message is drawn AFTER the write, and a fault in it can never fail the placement', () => {
        const place = span('async function placeChatCheckout(');
        const guard = span('function drawnAfterTheWrite(');
        const wrote = place.indexOf('placeCheckout(');
        return wrote > 0
            && place.indexOf('setBotReply(req, drawnAfterTheWrite(') > wrote
            && place.includes('checkoutPlacedReply(placement,')
            && place.includes('sendSuccess(res, placement);')
            && guard.includes('catch (error)')
            && guard.includes('return null;');
    });

    assert('the confirmation is drawn from the SAME object the model is sent', () => {
        const rev = span('async function reviewChatCheckout(');
        return /setBotReply\(req, checkoutReviewReply\(review, \{ addressChosen: deliveryAddressId !== null \}, language\)\);/.test(rev)
            && rev.includes('sendSuccess(res, review);')
            && rev.includes('satisfies ChatReviewForReply');
    });

    console.log('\n── 13d · The placement message ──');

    const placement = (over: Partial<ChatPlacementForReply> = {}): ChatPlacementForReply => ({
        transactionId: ID(900),
        state: 'waiting',
        orderNumbers: ['ORD-2026-000101', 'ORD-2026-000102'],
        amountText: '21 500 XAF',
        payerMasked: PHONE,
        instructions: { message: 'Confirm the payment on your phone', ussdCode: '*126#', clientSecret: 'pi_secret_never_shown' },
        ...over,
    });

    assert('⛔ waiting: the orders, the prompt\'s amount and number, the operator\'s words — and Check status', () => {
        const waiting = textOf(checkoutPlacedReply(placement(), 'en'));
        return waiting !== null
            && waiting.text.startsWith(`${botChrome('checkoutOrderPlacedLabel', 'en')} ORD-2026-000101, ORD-2026-000102`)
            && waiting.text.includes(botChromeFill('checkoutPaymentRequestSent', 'en', { amount: '21 500 XAF', phone: PHONE }))
            && waiting.text.includes('\nConfirm the payment on your phone\n')
            && waiting.text.includes('\n*126#\n')
            && waiting.text.endsWith(botChrome('checkoutPaymentWait', 'en'))
            && waiting.actions?.length === 1
            && waiting.actions[0].id === paymentStatusActionId(ID(900))
            && waiting.actions[0].label === botChrome('checkStatusButton', 'en');
    });

    assert('⛔ the operator\'s instruction is an allowlist of two fields — a card secret never reaches a chat', () =>
        !(textOf(checkoutPlacedReply(placement(), 'en'))?.text ?? 'pi_secret').includes('pi_secret'));

    // Owner's handset 2026-09-22 (ORD-2026-000004): a NotchPay push prompt read "Approve it on your
    // phone with your PIN." and then the adapter's English "Approve the payment request on your phone
    // to complete this payment." — the instruction twice, and in a French chat in two languages.
    const push = { message: 'Approve the payment request on your phone to complete this payment.' };
    assert('⭐ a push prompt (no code, no SMS step) relays no second, English-only instruction — in any language', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const text = textOf(checkoutPlacedReply(placement({ instructions: push }), lang))?.text ?? '';
            return text.includes(botChromeFill('checkoutPaymentRequestSent', lang, { amount: '21 500 XAF', phone: PHONE }))
                && !text.includes(push.message);
        }));
    assert('an SMS-code step still relays the operator\'s words — the customer must do something different', () =>
        (textOf(checkoutPlacedReply(placement({ instructions: { message: 'Enter the confirmation code sent to your phone by SMS.', requiresOtp: true } }), 'en'))?.text ?? '')
            .includes('\nEnter the confirmation code sent to your phone by SMS.\n'));

    assert('⛔ failed: no money was taken — and Try again for THIS transaction, never Check status', () => {
        const failedReply = textOf(checkoutPlacedReply(placement({ state: 'failed' }), 'en'));
        return failedReply !== null
            && failedReply.text.includes(botChrome('checkoutPaymentNotSent', 'en'))
            && !failedReply.text.includes(botChrome('checkoutPaymentWait', 'en'))
            && failedReply.actions?.length === 1
            && failedReply.actions[0].id === paymentRetryActionId(ID(900))
            && failedReply.actions[0].label === botChrome('tryAgainButton', 'en');
    });

    assert('settled: the orders and a thank-you, and no button', () => {
        const settled = textOf(checkoutPlacedReply(placement({ state: 'settled' }), 'en'));
        return settled !== null
            && !settled.actions
            && settled.text.endsWith(botChrome('checkoutPaymentReceived', 'en'));
    });

    assert('an unknown amount draws nothing rather than a sentence with a hole in it', () =>
        checkoutPlacedReply(placement({ amountText: null }), 'en') === null);

    assert('⛔ in all five languages: no brace left behind, and Check status is a WhatsApp reply button', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const waiting = checkoutPlacedReply(placement(), lang);
            if (!waiting || waiting.kind !== 'text') return false;
            const wa = waOf(waiting);
            return !/[{}]/.test(waiting.text)
                && wa.type === 'button'
                && wa.action?.buttons?.[0]?.reply.id === paymentStatusActionId(ID(900));
        }));

    assert('Not now is one plain sentence saying nothing was ordered', () => {
        const declined = checkoutDeclinedReply('en');
        return declined.kind === 'text'
            && declined.text === botChrome('checkoutDeclined', 'en')
            && !declined.actions;
    });

    console.log('\n── 13e · The words: five languages, the button cap, and the placeholders ──');

    const NEW_KEYS: BotChromeKey[] = [
        'placeOrderButton', 'notNowButton', 'checkoutReviewIntro', 'checkoutMoreLines', 'checkoutTotalLabel',
        'checkoutDeliverToLabel', 'checkoutSentToLabel', 'checkoutMobileMoneyLabel', 'checkoutPlaceQuestion',
        'checkoutChooseAddressQuestion', 'checkoutDeclined', 'checkoutAddAddressPrompt', 'checkoutOrderPlacedLabel',
        'checkoutPaymentRequestSent', 'checkoutPaymentWait', 'checkoutPaymentNotSent', 'checkoutPaymentReceived',
    ];

    assert('⛔ every new copy key exists in all five languages', () =>
        NEW_KEYS.every((key) => BOT_COPY_LANGUAGES.every((lang) => (__CHROME_TABLE[key].copy[lang] ?? '').trim().length > 0)));

    assert('⛔ both buttons fit WhatsApp\'s 20-character reply-button title in every language, and are capped at 20', () =>
        (['placeOrderButton', 'notNowButton'] as const).every((key) =>
            __CHROME_TABLE[key].cap === 20
            && BOT_COPY_LANGUAGES.every((lang) => __CHROME_TABLE[key].copy[lang].length <= 20)));

    assert('⛔ each template declares its placeholders, and the whole table passes the boot guard', () =>
        __CHROME_TEMPLATES.checkoutMoreLines?.join(',') === 'count'
        && __CHROME_TEMPLATES.checkoutPaymentRequestSent?.join(',') === 'amount,phone'
        && botChromeCopyGaps(__CHROME_TABLE, __CHROME_TEMPLATES).length === 0);

    /**
     * ⛔ **THE BITE-PROOFS.** The boot guard is handed a copy of the real table with ONE value
     * broken and must name that key and that language. Built from the real table, so the proof
     * exercises the real rule — a hand-made fixture table could pass while the real one is wrong.
     */
    const withValue = (key: BotChromeKey, lang: 'fr' | 'pt' | 'es', value: string) => ({
        ...__CHROME_TABLE,
        [key]: { ...__CHROME_TABLE[key], copy: { ...__CHROME_TABLE[key].copy, [lang]: value } },
    });

    assert('⛔ it BITES: a French Place order two characters over the cap is named', () => {
        const gaps = botChromeCopyGaps(withValue('placeOrderButton', 'fr', 'Passer la commande !!!'), __CHROME_TEMPLATES);
        if (!gaps.length) console.error('      the guard named nothing');
        return gaps.some((gap) => gap === 'placeOrderButton:fr is 22 chars, cap is 20');
    });

    assert('⛔ it BITES: a Portuguese payment sentence that DROPS {amount} is named — and so is a stray brace', () => {
        const dropped = botChromeCopyGaps(
            withValue('checkoutPaymentRequestSent', 'pt', 'Foi enviado um pedido de pagamento para {phone}.'),
            __CHROME_TEMPLATES,
        );
        const stray = botChromeCopyGaps(withValue('checkoutDeclined', 'es', 'Sin problema, {name}.'), __CHROME_TEMPLATES);
        return dropped.includes('checkoutPaymentRequestSent:pt carries {amount} 0 times, expected once')
            && stray.includes('checkoutDeclined:es carries {name}, which nothing fills');
    });
}

main();
