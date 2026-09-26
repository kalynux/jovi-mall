/**
 * test:recently-sent — "what the platform has recently sent this customer" (2026-09-22).
 *
 * Follows the scripts/test convention — plain ts-node, hand-rolled asserts, no framework. DB-free:
 * the decisions are pure (`domain/bot-recently-sent.ts`), the store runs against a FAKE Redis with
 * the real `SET EX` semantics, and the reply interceptor is driven with a fake request.
 *
 * ── THE PROPERTIES THIS SUITE EXISTS FOR ────────────────────────────────────
 *   1. Every drawn reply — tool-drawn and TAP-drawn alike — is recorded from the ONE place they
 *      all pass through (`attachBotReply`), as one compact line with its button LABELS.
 *   2. ⛔ No credential ever enters the record. Every URL is stripped, whatever its host and
 *      whatever token it carries; the COD delivery code is withheld at its disclosure site.
 *   3. The window is five, newest last, and an entry older than two hours is gone even when the
 *      key's TTL was refreshed by newer traffic.
 *   4. A notification delivered to a chat is recorded too — and one that was NOT delivered is not.
 *   5. `/identity/sync` and `/identity/resolve` both carry it, and a Redis fault yields `[]`
 *      rather than a failed turn.
 *
 * Every key assertion is also run against a deliberately broken copy (⭐ MUTANT), and must fail
 * there — a test that cannot fail proves nothing. The URL rule has two: a naive stripper that
 * only knows `http://`, and a mutated source for the withhold scan.
 *
 * Fixtures use the fake phone 237600000001. Run: npm run test:recently-sent
 */
import fs from 'fs';
import path from 'path';

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

function section(title: string): void {
    console.log(`\n▶ ${title}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The fake Redis is installed BEFORE anything that reaches for a client
// ─────────────────────────────────────────────────────────────────────────────
// The store calls `getRedisClient` at CALL time, so patching the factory's export is enough — the
// technique `test:bot-surface` and `test:chat-answer` both use. A store driven against real
// SET/EX/GET semantics is an assertion; a mocked store would be a restatement of the code.
import * as redisFactory from '../../src/infra/redis/redis.factory';

interface FakeEntry { value: string; expiresAtMs: number | null }

class FakeRedis {
    readonly store = new Map<string, FakeEntry>();

    private live(key: string): FakeEntry | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiresAtMs !== null && Date.now() > entry.expiresAtMs) {
            this.store.delete(key);
            return null;
        }
        return entry;
    }

    async get(key: string): Promise<string | null> {
        return this.live(key)?.value ?? null;
    }

    async set(key: string, value: string, options?: { NX?: boolean; EX?: number }): Promise<string | null> {
        if (options?.NX && this.live(key)) return null;
        this.store.set(key, { value, expiresAtMs: options?.EX ? Date.now() + options.EX * 1000 : null });
        return 'OK';
    }

    async del(key: string | string[]): Promise<number> {
        const keys = Array.isArray(key) ? key : [key];
        let removed = 0;
        for (const k of keys) if (this.store.delete(k)) removed++;
        return removed;
    }

    ttlSeconds(key: string): number | null {
        const entry = this.store.get(key);
        if (!entry || entry.expiresAtMs === null) return null;
        return Math.round((entry.expiresAtMs - Date.now()) / 1000);
    }
}

const fakeRedis = new FakeRedis();
(redisFactory as unknown as { getRedisClient: () => Promise<FakeRedis> }).getRedisClient = async () => fakeRedis;

import type { Request, Response } from 'express';
import {
    BotRecentlySentEntry,
    RECENTLY_SENT_MAX,
    RECENTLY_SENT_TEXT_MAX,
    RECENTLY_SENT_TTL_SECONDS,
    REDACTED_LINK,
    appendRecentlySent,
    compactSentText,
    readRecentlySent,
    recentlySentView,
    sentTextForIntent,
    serializeRecentlySent,
    stripUrls,
} from '../../src/modules/bot-surface/domain/bot-recently-sent';
import { BotRecentlySentStore } from '../../src/modules/bot-surface/services/bot-recently-sent.store';
import type { PendingQuestionOwner } from '../../src/modules/bot-surface/domain/bot-pending-question';
import type { BotReplyIntent } from '../../src/modules/bot-surface/domain/channel-reply';
// ⚠ Loaded for its `declare global` — `req.bot` is declared there, and ts-node type-checks
// `bot-reply.middleware.ts` against only the files this suite's import graph reaches.
import '../../src/modules/bot-surface/middlewares/bot-identity.middleware';
import {
    attachBotReply,
    withholdFromRecentlySent,
} from '../../src/modules/bot-surface/middlewares/bot-reply.middleware';
import { toBotIdentityDto } from '../../src/modules/bot-surface/dto/bot-projections';
import { BotMemoryResetPorts, BotMemoryService } from '../../src/modules/bot-surface/services/bot-memory.service';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const USER = '68d000000000000000000a01';
const OTHER_USER = '68d000000000000000000a02';
const CUSTOMER = '68d000000000000000000f01';
const PHONE = '237600000001';

const OWNER: PendingQuestionOwner = { userId: USER, channel: 'whatsapp' };
const TELEGRAM_OWNER: PendingQuestionOwner = { userId: USER, channel: 'telegram' };
const NOW = new Date('2026-09-22T10:00:00.000Z');

const KEY = `bot:sent:${USER}:whatsapp`;

/**
 * ⭐ MUTANT — the stripper somebody writes when they think about the links they have SEEN.
 * Every token below survives it, which is what makes § 2's assertions meaningful.
 */
const naiveStrip = (text: string): string => text.replace(/http:\/\/\S+/g, REDACTED_LINK);

/** The credential-bearing links this platform actually sends a customer. */
const LINKS: Array<{ what: string; url: string; secret: string }> = [
    { what: 'a magic sign-in link', url: 'https://wi-mall.com/login?token=mgc_9f2a7c41bb', secret: 'mgc_9f2a7c41bb' },
    { what: 'a password-reset link', url: 'https://wi-mall.com/reset-password?token=abc123def456', secret: 'abc123def456' },
    { what: 'a digital download link', url: 'https://api.wi-mall.com/api/digital/download/dl_77aa11', secret: 'dl_77aa11' },
    { what: 'a payment link', url: 'https://wi-mall.com/pay/pl_5c8e2b90', secret: 'pl_5c8e2b90' },
    { what: 'a Mini App screen handle', url: 'https://wi-mall.com/miniapp/pd?h=ia_3399ffee', secret: 'ia_3399ffee' },
    { what: 'a bare www host', url: 'www.wi-mall.com/pay/pl_beefcafe', secret: 'pl_beefcafe' },
    { what: 'a scheme-less t.me deep link', url: 't.me/wimallbot?start=tok_112233', secret: 'tok_112233' },
    { what: 'a scheme-less wa.me link', url: 'wa.me/237600000001?text=code_998877', secret: 'code_998877' },
    { what: 'a tg:// scheme', url: 'tg://resolve?domain=wimallbot&start=tok_445566', secret: 'tok_445566' },
];

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// ⚠ NORMALISED ON THE WAY IN. `core.autocrlf=true` here, so a fresh checkout of the index (and the
// exported copy the coordinator gates) hands these files CRLF — and every scan below anchors on
// `\n`. Two mutants went vacuously green that way: they matched nothing to delete, so deleting it
// "failed the scan" for the wrong reason. Normalise once, here, and the guards read the same text
// in a working tree, an export and Linux CI.
const read = (...parts: string[]) =>
    fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8').replace(/\r\n/g, '\n');

/** The text between two markers — a scan must look at the span its claim is about. */
function spanOf(src: string, from: string, to: string | null): string {
    const start = src.indexOf(from);
    if (start < 0) return '';
    const end = to ? src.indexOf(to, start + from.length) : -1;
    return end < 0 ? src.slice(start) : src.slice(start, end);
}

/** Run a scan over mutated source and demand it FAILS — the proof the scan bites. */
function bites(mutated: string, check: (src: string) => boolean): boolean {
    let ok: boolean;
    try {
        ok = check(mutated);
    } catch {
        ok = false;
    }
    return ok === false;
}

function storedEntries(owner: PendingQuestionOwner = OWNER, now: Date = new Date()): BotRecentlySentEntry[] {
    return readRecentlySent(
        fakeRedis.store.get(`bot:sent:${owner.userId}:${owner.channel}`)?.value ?? null,
        owner,
        now,
    );
}

async function main(): Promise<void> {
    console.log('\n═══ test:recently-sent ══════════════════════════════════════════════════════\n');

    // ═════════════════════════════════════════════════════════════════════════
    section('1 · The one-line rendering');
    // ═════════════════════════════════════════════════════════════════════════

    await assert('the owner\'s numbers: five entries, two hours, ~160 characters', () =>
        RECENTLY_SENT_MAX === 5
        && RECENTLY_SENT_TTL_SECONDS === 2 * 60 * 60
        && RECENTLY_SENT_TEXT_MAX === 160);

    await assert('newlines and runs of blank are collapsed — this lands in a prompt as one line', () =>
        compactSentText('Order JM-1\n\nTotal:   12 000 XAF\n\tPaid') === 'Order JM-1 Total: 12 000 XAF Paid');

    await assert('button labels follow in parentheses, and never a button id', () => {
        const line = compactSentText('Place this order?', ['Place order', 'Not now']);
        return line === 'Place this order? (Place order · Not now)' && !line.includes('yes:co:');
    });

    await assert('a long body keeps its BEGINNING and is capped', () => {
        const body = `Payment received for order JM-2026-000123. ${'Thank you for shopping with us. '.repeat(20)}`;
        const line = compactSentText(body);
        return Array.from(line).length <= RECENTLY_SENT_TEXT_MAX
            && line.startsWith('Payment received for order JM-2026-000123.')
            && line.endsWith('…');
    });

    await assert('the cap counts CODE POINTS — an emoji or an Arabic letter is never cut in half', () => {
        const line = compactSentText('😀'.repeat(400) + ' تم استلام الدفعة', [], 50);
        return Array.from(line).length === 50 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(line);
    });

    await assert('an empty body with labels still renders — a picker with no preamble', () =>
        compactSentText('', ['Yes', 'No']) === '(Yes · No)');

    await assert('an empty label is dropped rather than printed as a gap', () =>
        compactSentText('Pick one', ['Yes', '   ', '']) === 'Pick one (Yes)');

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · ⛔ No credential enters the record — every URL is STRIPPED');
    // ═════════════════════════════════════════════════════════════════════════

    for (const link of LINKS) {
        await assert(`${link.what} is stripped, token and all`, () => {
            const line = compactSentText(`Here you go: ${link.url} — tap to continue`, ['Open']);
            return !line.includes(link.secret)
                && !line.includes(link.url)
                && line.includes(REDACTED_LINK)
                // The sentence around it survives, so the model still knows a link was sent.
                && line.includes('Here you go:');
        });
    }

    await assert('⭐ MUTANT: a stripper that only knows `http://` leaks ALL NINE — including https', () => {
        const leaked = LINKS.filter((link) => naiveStrip(`Here you go: ${link.url}`).includes(link.secret));
        return leaked.length === LINKS.length
            // It DOES catch the one shape it was written for, so the mutant is a plausible
            // implementation rather than a strawman — and it is still wrong about every link
            // this platform actually sends, `https` first among them.
            && !naiveStrip('http://wi-mall.com/pay/pl_x').includes('pl_x');
    });

    await assert('a URL inside a BUTTON LABEL is stripped too — labels go through the same rule', () =>
        !compactSentText('Your receipt', ['Open https://wi-mall.com/r/rcpt_5150']).includes('rcpt_5150'));

    await assert('⚠ ordinary prose that merely LOOKS dotted is left alone', () =>
        stripUrls('Rated 3.5/10 by 12 buyers') === 'Rated 3.5/10 by 12 buyers'
        && stripUrls('12.000/mois') === '12.000/mois'
        && stripUrls('Order JM-2026-000123 is on its way') === 'Order JM-2026-000123 is on its way');

    await assert('a `link` intent records its SENTENCE and its LABEL — never its url', () => {
        const line = sentTextForIntent({
            kind: 'link',
            text: 'Your payment link is ready.',
            label: 'Pay now',
            url: 'https://wi-mall.com/pay/pl_5c8e2b90',
        });
        return line === 'Your payment link is ready. (Pay now)' && !line.includes('pl_5c8e2b90');
    });

    await assert('an `inapp` intent records no url either — its handle is single-use', () => {
        const line = sentTextForIntent({
            kind: 'inapp',
            text: 'Open your basket',
            label: 'Open',
            url: 'https://wi-mall.com/miniapp/co?h=ia_3399ffee',
        });
        return !(line ?? '').includes('ia_3399ffee');
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · Every intent kind renders, and a new one is a COMPILE error');
    // ═════════════════════════════════════════════════════════════════════════

    const INTENTS: Array<{ kind: string; intent: BotReplyIntent; expect: string }> = [
        {
            kind: 'text',
            intent: { kind: 'text', text: 'What is your email?', actions: [{ id: 'skip:email', label: 'Skip' }] },
            expect: 'What is your email? (Skip)',
        },
        {
            kind: 'choice',
            intent: {
                kind: 'choice',
                text: 'Place this order?',
                options: [{ id: 'yes:co:r1', label: 'Place order' }, { id: 'no:co:r1', label: 'Not now' }],
                listButton: 'Choose',
                sectionTitle: 'Options',
            },
            expect: 'Place this order? (Place order · Not now)',
        },
        {
            kind: 'contact_request',
            intent: { kind: 'contact_request', text: 'I need your number.', buttonLabel: 'Share my number' },
            expect: 'I need your number. (Share my number)',
        },
        {
            kind: 'location_request',
            intent: {
                kind: 'location_request',
                text: 'Where should we deliver?',
                buttonLabel: 'Send my location',
                skipLabel: 'Skip',
            },
            expect: 'Where should we deliver? (Send my location · Skip)',
        },
    ];

    for (const { kind, intent, expect } of INTENTS) {
        await assert(`a \`${kind}\` reply renders to its words and its labels`, () =>
            sentTextForIntent(intent) === expect);
    }

    await assert('a `product_list` records the CARD TITLES, not the same five button words', () => {
        const line = sentTextForIntent({
            kind: 'product_list',
            text: '',
            browsePrompt: 'Here is what I found',
            cards: [
                { productId: 'p1', variantId: 'v1', title: 'Red kettle', priceText: '9 000 XAF', storeName: 'Chez Ada', inStock: true, imageUrl: null, detailUrl: null, addToken: null, buyToken: null },
                { productId: 'p2', variantId: null, title: 'Blue kettle', priceText: '7 500 XAF', storeName: 'Chez Ada', inStock: false, imageUrl: null, detailUrl: null, addToken: null, buyToken: null },
            ],
            hasMore: false,
            labels: { browse: 'Browse', buyNow: 'Buy now', addToCart: 'Add to cart', seeMore: 'See more', details: 'Details' },
        } as BotReplyIntent);
        return line === 'Here is what I found (Red kettle · Blue kettle)';
    });

    await assert('nothing to say records nothing', () =>
        sentTextForIntent(null) === null && sentTextForIntent(undefined) === null);

    const domainSrc = read('src', 'modules', 'bot-surface', 'domain', 'bot-recently-sent.ts');
    const exhaustive = (src: string) =>
        /const exhaustive: never = intent;/.test(spanOf(src, 'export function sentTextForIntent', '\n}\n'));
    await assert('the renderer switches EXHAUSTIVELY — a new intent kind cannot be silently unrecorded', () =>
        exhaustive(domainSrc));
    await assert('⭐ MUTANT: deleting the exhaustiveness check fails that scan', () =>
        bites(domainSrc.replace('const exhaustive: never = intent;', 'const exhaustive = intent as never;'), exhaustive));

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · The rolling window — five, newest last, two hours PER ENTRY');
    // ═════════════════════════════════════════════════════════════════════════

    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

    await assert('the sixth entry pushes the first out, and the newest is LAST', () => {
        let entries: BotRecentlySentEntry[] = [];
        for (let i = 1; i <= 6; i++) entries = appendRecentlySent(entries, { at: at(6 - i), text: `m${i}` }, NOW);
        return entries.length === RECENTLY_SENT_MAX
            && entries.map((entry) => entry.text).join() === 'm2,m3,m4,m5,m6';
    });

    await assert('⚠ an entry past two hours is dropped even though newer traffic refreshed the key', () => {
        const entries = appendRecentlySent(
            [{ at: at(200), text: 'three hours ago' }, { at: at(30), text: 'half an hour ago' }],
            { at: at(0), text: 'just now' },
            NOW,
        );
        return entries.length === 2 && entries.map((entry) => entry.text).join() === 'half an hour ago,just now';
    });

    await assert('a record is refused on read when it is not one this service would have written', () => {
        const good = serializeRecentlySent(OWNER, [{ at: at(1), text: 'hello' }]);
        const tampered = (patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(good), ...patch });
        return readRecentlySent(good, OWNER, NOW).length === 1
            && readRecentlySent(good, { userId: OTHER_USER, channel: 'whatsapp' }, NOW).length === 0
            && readRecentlySent('{not json', OWNER, NOW).length === 0
            && readRecentlySent(null, OWNER, NOW).length === 0
            && readRecentlySent(tampered({ entries: 'nope' }), OWNER, NOW).length === 0
            && readRecentlySent(tampered({ entries: [{ at: 'never', text: 'x' }, { at: at(1) }] }), OWNER, NOW).length === 0;
    });

    await assert('the cap is re-applied on the way OUT — an edited cache cannot put six lines in a prompt', () => {
        const six = Array.from({ length: 6 }, (_, i) => ({ at: at(1), text: `m${i}` }));
        return recentlySentView(six).length === RECENTLY_SENT_MAX
            && recentlySentView(six)[4].text === 'm5'
            && recentlySentView(null).length === 0;
    });

    await assert('the view carries EXACTLY { at, text } — nothing else can ride along', () => {
        const view = recentlySentView([{ at: at(1), text: 'hi', context: 'co' } as BotRecentlySentEntry]);
        return Object.keys(view[0]).sort().join() === 'at,text';
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · The store — one record per conversation, two hours');
    // ═════════════════════════════════════════════════════════════════════════

    const store = new BotRecentlySentStore();

    await assert('records under bot:sent:<userId>:<channel> with a two-hour TTL', async () => {
        fakeRedis.store.clear();
        await store.noteSent(OWNER, 'Payment received', ['View order']);
        const ttl = fakeRedis.ttlSeconds(KEY);
        return fakeRedis.store.has(KEY)
            && ttl !== null && ttl > RECENTLY_SENT_TTL_SECONDS - 5 && ttl <= RECENTLY_SENT_TTL_SECONDS;
    });

    await assert('the key holds no phone number', () =>
        [...fakeRedis.store.keys()].every((key) => !key.includes(PHONE)));

    await assert('entries accumulate newest-last and stop at five', async () => {
        fakeRedis.store.clear();
        for (let i = 1; i <= 7; i++) await store.noteSent(OWNER, `message ${i}`);
        const entries = storedEntries();
        return entries.length === 5 && entries[4].text === 'message 7' && entries[0].text === 'message 3';
    });

    await assert('one chat per channel: the Telegram chat has its own record', async () => {
        fakeRedis.store.clear();
        await store.noteSent(OWNER, 'on whatsapp');
        await store.noteSent(TELEGRAM_OWNER, 'on telegram');
        return storedEntries(OWNER)[0].text === 'on whatsapp'
            && storedEntries(TELEGRAM_OWNER)[0].text === 'on telegram';
    });

    await assert('peek reads it back and LEAVES it — this record is never spent', async () => {
        const first = await store.peek(OWNER);
        const second = await store.peek(OWNER);
        return first.length === 1 && second.length === 1;
    });

    await assert('clear forgets one conversation, clearForUser every chat of that account only', async () => {
        await store.noteSent({ userId: OTHER_USER, channel: 'whatsapp' }, 'someone else');
        await store.clear(TELEGRAM_OWNER);
        const telegramGone = storedEntries(TELEGRAM_OWNER).length === 0 && storedEntries(OWNER).length === 1;
        await store.clearForUser(USER);
        return telegramGone
            && storedEntries(OWNER).length === 0
            && storedEntries(TELEGRAM_OWNER).length === 0
            && storedEntries({ userId: OTHER_USER, channel: 'whatsapp' }).length === 1;
    });

    await assert('noteDraw on an intent that says nothing touches Redis at all', async () => {
        fakeRedis.store.clear();
        const entry = await store.noteDraw(OWNER, null);
        return entry === null && fakeRedis.store.size === 0;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('6 · Recorded in the ONE place every drawn reply passes — `attachBotReply`');
    // ═════════════════════════════════════════════════════════════════════════

    /** Drive the real interceptor exactly as Express would, and return what it sent. */
    async function drawThroughInterceptor(
        intent: BotReplyIntent | null,
        body: Record<string, unknown>,
        withhold = false,
    ) {
        const req = {
            bot: {
                caller: { userId: USER, customerId: CUSTOMER, channel: 'whatsapp', externalIdentity: PHONE, identityHint: '••••0001' },
                envelope: { channel: 'whatsapp', externalId: PHONE },
                tool: 'test',
                anonymous: false,
                language: 'en',
                replyIntent: intent,
            },
        } as unknown as Request;
        if (withhold) withholdFromRecentlySent(req);
        let sent: unknown = null;
        const res = { json(payload: unknown) { sent = payload; return this; } } as unknown as Response;
        attachBotReply(req, res, () => undefined);
        res.json(body);
        await tick();
        await tick();
        return sent as Record<string, unknown>;
    }

    await assert('a TOOL-drawn reply is recorded, and still sent', async () => {
        fakeRedis.store.clear();
        const sent = await drawThroughInterceptor(
            { kind: 'text', text: 'Added to your basket: Red kettle ×1' },
            { success: true, data: {} },
        );
        return storedEntries()[0]?.text === 'Added to your basket: Red kettle ×1' && 'reply' in sent;
    });

    await assert('⭐ a TAP-drawn reply is recorded too — the turn the model never sees at all', async () => {
        fakeRedis.store.clear();
        await drawThroughInterceptor(
            { kind: 'text', text: 'Your order JM-1 was cancelled.', actions: [{ id: 'ord:list', label: 'My orders' }] },
            { success: true, data: {} },
        );
        return storedEntries()[0]?.text === 'Your order JM-1 was cancelled. (My orders)';
    });

    await assert('a FAILED response records nothing — nothing was drawn for it here', async () => {
        fakeRedis.store.clear();
        await drawThroughInterceptor(
            { kind: 'text', text: 'never sent' },
            { success: false, error: { code: 'X', customerMessage: 'Sorry', category: 'business_rule' } },
        );
        return storedEntries().length === 0;
    });

    await assert('an idempotency REPLAY (body already carries reply) records nothing again', async () => {
        fakeRedis.store.clear();
        await drawThroughInterceptor(
            { kind: 'text', text: 'placed once' },
            { success: true, data: {}, reply: { channel: 'whatsapp' } },
        );
        return storedEntries().length === 0;
    });

    await assert('⛔ a turn marked as carrying a CREDENTIAL is sent and NOT recorded', async () => {
        fakeRedis.store.clear();
        const sent = await drawThroughInterceptor(
            { kind: 'text', text: 'Delivery code: 4821' },
            { success: true, data: {} },
            true,
        );
        return 'reply' in sent
            && JSON.stringify(sent).includes('4821')
            && storedEntries().length === 0;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('7 · Source scans — the wiring nothing behavioural can see');
    // ═════════════════════════════════════════════════════════════════════════

    const replySrc = read('src', 'modules', 'bot-surface', 'middlewares', 'bot-reply.middleware.ts');
    const orderSrc = read('src', 'modules', 'bot-surface', 'controllers', 'bot-order.controller.ts');
    const notifSrc = read('src', 'modules', 'notifications', 'services', 'customer-notification-event-handler.service.ts');
    const identitySrc = read('src', 'modules', 'bot-surface', 'controllers', 'bot-identity.controller.ts');

    /**
     * ⛔ The one message on this surface whose WORDS are a credential. A redaction rule cannot
     * reach it — the code is digits — so the disclosure site has to say so itself.
     */
    const codWithholds = (src: string) =>
        /withholdFromRecentlySent\(req\);/.test(spanOf(src, 'async function discloseCodCode', '\n}\n'));
    await assert('⛔ the COD delivery-code disclosure withholds itself from the record', () =>
        codWithholds(orderSrc));
    await assert('⭐ MUTANT: deleting that one line fails the scan', () =>
        bites(orderSrc.replace('    withholdFromRecentlySent(req);\n', ''), codWithholds));

    await assert('the interceptor is the ONLY caller of noteDraw on this store', () => {
        const root = path.join(__dirname, '..', '..', 'src');
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').includes('botRecentlySentStore.noteDraw(')) {
                    hits.push(path.relative(root, full).replace(/\\/g, '/'));
                }
            }
        };
        walk(root);
        return hits.length === 1 && hits[0] === 'modules/bot-surface/middlewares/bot-reply.middleware.ts';
    });

    await assert('the interceptor records only on a SUCCESS that actually rendered', () =>
        /if \(envelope\.success !== false\) \{\s*notePendingQuestion\(req\);\s*noteRecentlySent\(req\);/.test(replySrc)
        && replySrc.indexOf('if (rendered.length === 0) return envelope;') < replySrc.indexOf('noteRecentlySent(req);'));

    /**
     * ⚠ A notification is recorded only where it was actually DELIVERED, and only to a chat.
     * Email and the in-app inbox are a different place — the record answers "what has this
     * customer been shown in THIS conversation".
     */
    const chatOnly = (src: string) =>
        /if \(delivered\) this\.noteSentToChat\(customer, 'telegram'/.test(src)
        && /if \(delivered\) \{[\s\S]{0,900}?this\.noteSentToChat\(customer, 'whatsapp'/.test(src)
        && !/noteSentToChat\(customer, 'email'/.test(src)
        && !/noteSentToChat\(customer, 'in-app'/.test(src);
    await assert('a notification is recorded only once DELIVERED, and only to a chat channel', () =>
        chatOnly(notifSrc));
    await assert('⭐ MUTANT: recording regardless of delivery fails that scan', () =>
        bites(notifSrc.replace("if (delivered) this.noteSentToChat(customer, 'telegram'", "this.noteSentToChat(customer, 'telegram'"), chatOnly));

    await assert('a sender that declined to send reports false rather than looking like a success', () =>
        /private async sendWhatsApp\([\s\S]{0,400}?\): Promise<boolean>/.test(notifSrc)
        && /send: \(\) => Promise<boolean \| void>/.test(notifSrc)
        && /return \(await send\(\)\) !== false;/.test(notifSrc));

    const bothRoutes = (src: string) =>
        (src.match(/recentlySent,/g) ?? []).length >= 2
        && /recentlySentTo\(caller\)/.test(src)
        && /recentlySentTo\(\{ userId: outcome\.account\.userId, channel: outcome\.account\.channel \}\)/.test(src);
    await assert('BOTH identity routes supply it — resolve is the readonly-maintenance fallback', () =>
        bothRoutes(identitySrc));
    await assert('⭐ MUTANT: dropping it from `resolve` fails that scan', () =>
        bites(identitySrc.replace('            recentlySentTo(caller),\n', ''), bothRoutes));

    await assert('the read FAILS OPEN — a Redis blip costs context, never the turn', () =>
        /catch \(error\) \{[\s\S]{0,260}?return \[\];/.test(spanOf(identitySrc, 'async function recentlySentTo', '\n}\n')));

    // ═════════════════════════════════════════════════════════════════════════
    section('8 · The wire shape on /identity/sync');
    // ═════════════════════════════════════════════════════════════════════════

    const identityInput = {
        displayName: 'Ada',
        language: 'fr',
        connectedChannels: ['whatsapp' as const],
        hasOpenOrders: true,
        identityHint: '••••0001',
        botToken: 'sealed-identity-token-placeholder',
        memoryEpoch: 0,
        pendingQuestion: null,
    };

    await assert('`customer.recentlySent` is an ARRAY of { at, text }, newest last', () => {
        const dto = toBotIdentityDto({
            ...identityInput,
            recentlySent: [{ at: at(9), text: 'older' }, { at: at(1), text: 'newer' }],
        });
        return Array.isArray(dto.recentlySent)
            && dto.recentlySent.length === 2
            && dto.recentlySent[1].text === 'newer'
            && Object.keys(dto.recentlySent[0]).sort().join() === 'at,text';
    });

    await assert('nothing sent is an EMPTY ARRAY, never null — one shape for the caller to read', () => {
        const dto = toBotIdentityDto({ ...identityInput, recentlySent: [] });
        return Array.isArray(dto.recentlySent) && dto.recentlySent.length === 0;
    });

    await assert('the DTO carries no token and no url from the messages it reports', () => {
        const dto = toBotIdentityDto({
            ...identityInput,
            recentlySent: [{ at: at(1), text: compactSentText('Pay: https://wi-mall.com/pay/pl_5c8e2b90') }],
        });
        const json = JSON.stringify(dto);
        return !json.includes('pl_5c8e2b90') && !json.includes('https://');
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('9 · The contract copy in api-doc');
    // ═════════════════════════════════════════════════════════════════════════

    const doc = read('api-doc', 'n8n', 'bot-surface.md');
    await assert('§ 11.4 documents the field, its cap and its two hours', () =>
        doc.includes('"recentlySent"')
        && /recentlySent/.test(doc)
        && doc.includes('two hours')
        && /at most (five|5)/i.test(doc));

    await assert('⛔ the doc tells n8n these are PLATFORM messages, not things the model said', () =>
        /not things? (your model|the model) said/i.test(doc));

    await assert('the doc says an administrator\'s memory reset clears it', () =>
        /memory reset[\s\S]{0,200}clears (it|this)|reset[\s\S]{0,120}clears `?recentlySent/i.test(doc));

    // ═════════════════════════════════════════════════════════════════════════
    section('10 · ⭐ The administrator\'s memory reset forgets it too');
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * The button is described to administrators as *"make the bot forget this customer's chat"*,
     * and it is pressed because the bot is confused by something it remembers. Bumping the epoch
     * and clearing the waiting question while still handing the model the last five platform
     * messages for two hours does not match that promise — and those messages are exactly the
     * material a confused turn would latch back onto (owner's call, 2026-09-22).
     */
    await assert('a reset clears every chat of that account — and no other account\'s', async () => {
        fakeRedis.store.clear();
        await store.noteSent(OWNER, 'on whatsapp');
        await store.noteSent(TELEGRAM_OWNER, 'on telegram');
        await store.noteSent({ userId: OTHER_USER, channel: 'whatsapp' }, 'someone else');

        const ports: BotMemoryResetPorts = {
            async bumpEpoch() { return 4; },
            async clearPendingQuestions() { /* its own suite */ },
            clearRecentlySent: (userId) => store.clearForUser(userId),
        };
        const result = await new BotMemoryService(ports).reset(USER, NOW);

        return result.memoryEpoch === 4
            && Object.keys(result).sort().join() === 'memoryEpoch,resetAt,userId'
            && storedEntries(OWNER).length === 0
            && storedEntries(TELEGRAM_OWNER).length === 0
            && storedEntries({ userId: OTHER_USER, channel: 'whatsapp' }).length === 1;
    });

    await assert('a Redis fault on that clear does not fail the reset — the epoch is already bumped', async () => {
        const ports: BotMemoryResetPorts = {
            async bumpEpoch() { return 7; },
            async clearPendingQuestions() { /* fine */ },
            async clearRecentlySent() { throw new Error('redis down'); },
        };
        const result = await new BotMemoryService(ports).reset(USER, NOW);
        return result.memoryEpoch === 7 && result.resetAt === NOW.toISOString();
    });

    await assert('⚠ a fault on the pending-question clear still reaches this one — separate try blocks', async () => {
        fakeRedis.store.clear();
        await store.noteSent(OWNER, 'should be forgotten');
        const ports: BotMemoryResetPorts = {
            async bumpEpoch() { return 1; },
            async clearPendingQuestions() { throw new Error('redis down'); },
            clearRecentlySent: (userId) => store.clearForUser(userId),
        };
        await new BotMemoryService(ports).reset(USER, NOW);
        return storedEntries(OWNER).length === 0;
    });

    const memorySrc = read('src', 'modules', 'bot-surface', 'services', 'bot-memory.service.ts');
    const resetClears = (src: string) =>
        /clearRecentlySent: \(userId\) => botRecentlySentStore\.clearForUser\(userId\)/.test(src)
        && /await this\.ports\.clearRecentlySent\?\.\(userId\);/.test(spanOf(src, 'async reset(', '\n    }\n'));
    await assert('the real ports supply it and `reset` calls it', () => resetClears(memorySrc));
    await assert('⭐ MUTANT: dropping the call from `reset` fails that scan', () =>
        bites(memorySrc.replace('await this.ports.clearRecentlySent?.(userId);', ''), resetClears));
    await assert('⭐ MUTANT: dropping the real port implementation fails that scan', () =>
        bites(
            memorySrc.replace(
                'clearRecentlySent: (userId) => botRecentlySentStore.clearForUser(userId),',
                '',
            ),
            resetClears,
        ));

    await assert('the port stays OPTIONAL — a fake that omits it still compiles and still resets', async () => {
        const ports: BotMemoryResetPorts = {
            async bumpEpoch() { return 2; },
            async clearPendingQuestions() { /* no clearRecentlySent at all */ },
        };
        return (await new BotMemoryService(ports).reset(USER, NOW)).memoryEpoch === 2;
    });

    console.log(`\n═══ ${passed} passed, ${failed} failed ═══════════════════════════════════════\n`);
    if (failed > 0) process.exit(1);
}

void main();
