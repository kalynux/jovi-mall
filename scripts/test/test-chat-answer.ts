/**
 * test:chat-answer — "the question waiting for an answer", the typed-answer tool, and the
 * administrator's bot-memory reset (2026-09-22).
 *
 * Follows the scripts/test convention — plain ts-node, hand-rolled asserts, no framework. DB-free:
 * the decisions are pure (`domain/bot-pending-question.ts`), the store runs against a FAKE Redis
 * with the real `SET EX` / atomic-take semantics, the reply interceptor is driven with a fake
 * request, and the memory reset takes its two ports by injection.
 *
 * ── THE PROPERTIES THIS SUITE EXISTS FOR ────────────────────────────────────
 *   1. A drawn Yes/No question is RECORDED — for each of the five answerable contexts, from the
 *      ONE place every drawn reply passes through (`attachBotReply`), with a TTL.
 *   2. ⛔ Account closure is NEVER recorded, never answerable, and a closure question drawn after
 *      another question WITHDRAWS it — so "yes" to "close my account?" cannot place the order that
 *      was still waiting underneath.
 *   3. A typed answer runs the stored token through the SAME registry and router the tap uses, and
 *      the handler receives byte-for-byte what a tap would hand it.
 *   4. No question → `409 BOT_NO_PENDING_QUESTION`, with a sentence in five languages.
 *   5. A tap clears the question; a newer question overwrites an older one; an answer TAKES it.
 *   6. The memory reset bumps the epoch, clears the question, and answers the exact contract shape.
 *
 * Every key assertion is also run against a deliberately broken copy (⭐ MUTANT), and must fail
 * there — a test that cannot fail proves nothing.
 *
 * Fixtures use the fake phone 237600000001. Run: npm run test:chat-answer
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
// The stores call `getRedisClient` at CALL time, so patching the factory's export is enough — the
// technique `test:bot-surface` uses. A store driven against real SET/EX/take semantics is an
// assertion; a mocked store would be a restatement of the code.
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

    /** The only script the store evals is GET-then-DEL. */
    async eval(_script: string, options: { keys: string[] }): Promise<string | null> {
        const entry = this.live(options.keys[0]);
        if (!entry) return null;
        this.store.delete(options.keys[0]);
        return entry.value;
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
    ANSWERABLE_QUESTION_CONTEXTS,
    BotPendingQuestion,
    PENDING_QUESTION_TEXT_MAX,
    PENDING_QUESTION_TTL_SECONDS,
    PendingQuestionOwner,
    answerTokenFor,
    clipQuestionText,
    pendingQuestionDecisionFor,
    readPendingQuestion,
    serializePendingQuestion,
    tokenForAnswer,
} from '../../src/modules/bot-surface/domain/bot-pending-question';
import { BotPendingQuestionStore } from '../../src/modules/bot-surface/services/bot-pending-question.store';
import { actionKeyOf } from '../../src/modules/bot-surface/domain/bot-action-dispatch';
import {
    confirmActionId,
    declineActionId,
    parseBotActionId,
    skipActionId,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import {
    checkoutConfirmActionId,
    checkoutDeclineActionId,
} from '../../src/modules/bot-surface/domain/bot-checkout-actions';
import {
    orderCancelConfirmActionId,
    orderCancelDeclineActionId,
    ticketCloseConfirmActionId,
    ticketCloseDeclineActionId,
} from '../../src/modules/bot-surface/domain/bot-ticket-actions';
import { mintConfirmationRef } from '../../src/modules/bot-surface/domain/bot-confirmation-ref';
import { newInAppHandle } from '../../src/modules/bot-surface/services/inapp-surface.store';
import type { BotReplyIntent } from '../../src/modules/bot-surface/domain/channel-reply';
// ⚠ Loaded for its `declare global` — `req.bot` is declared there, and ts-node type-checks
// `bot-reply.middleware.ts` against only the files this suite's import graph reaches.
import '../../src/modules/bot-surface/middlewares/bot-identity.middleware';
import { attachBotReply } from '../../src/modules/bot-surface/middlewares/bot-reply.middleware';
import { BOT_ROUTES, botRouteFor } from '../../src/modules/bot-surface/domain/bot-route-table';
import { BotChatAnswerSchema } from '../../src/modules/bot-surface/validators/bot.validators';
import { toBotIdentityDto } from '../../src/modules/bot-surface/dto/bot-projections';
import { BOT_COPY_LANGUAGES, customerMessageFor } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { BotMemoryResetPorts, BotMemoryService } from '../../src/modules/bot-surface/services/bot-memory.service';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { ERROR_CODES } from '../../src/core/error-codes';
import { ERROR_CATEGORIES } from '../../src/core/error-category';
import { AppError, DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { readCatalog, selectMcpTools } from '../gen-mcp-workflow';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = 'test-secret-for-confirmation-refs-only-0123456789';
const USER = '68d000000000000000000a01';
const OTHER_USER = '68d000000000000000000a02';
const ORDER = '68d000000000000000000b01';
const SHIPMENT = '68d000000000000000000c01';
const TICKET = '68d000000000000000000d01';
const ADDRESS = '68d000000000000000000e01';
const ADDRESS_2 = '68d000000000000000000e02';
const PHONE = '237600000001';

const OWNER: PendingQuestionOwner = { userId: USER, channel: 'whatsapp' };
const TELEGRAM_OWNER: PendingQuestionOwner = { userId: USER, channel: 'telegram' };
const NOW = new Date('2026-09-22T10:00:00.000Z');

const subject = { userId: USER, channel: 'whatsapp' };
const cancelRef = mintConfirmationRef('cancel', subject, ORDER, NOW.getTime(), SECRET);
const ticketRef = mintConfirmationRef('ticket-close', subject, TICKET, NOW.getTime(), SECRET);
const unlinkRef = mintConfirmationRef('unlink', subject, 'telegram', NOW.getTime(), SECRET);
const closeRef = mintConfirmationRef('close', subject, '', NOW.getTime(), SECRET);
const checkoutRef = newInAppHandle();

const pair = (yes: string, no: string, text = 'Shall I go ahead?'): BotReplyIntent => ({
    kind: 'choice',
    text,
    options: [{ id: yes, label: 'Yes' }, { id: no, label: 'No' }],
    listButton: 'Choose',
    sectionTitle: 'Options',
});

/** One drawn question per answerable context, built with the REAL builders each stream draws with. */
const DRAWN: Record<string, { yes: string; no: string; intent: BotReplyIntent }> = {};
function drawn(context: string, yes: string, no: string, intent?: BotReplyIntent): void {
    DRAWN[context] = { yes, no, intent: intent ?? pair(yes, no) };
}
drawn('co', checkoutConfirmActionId(checkoutRef, ADDRESS), checkoutDeclineActionId(checkoutRef));
drawn('cd', confirmActionId('cd', `${ORDER}:${SHIPMENT}`), declineActionId('cd', `${ORDER}:${SHIPMENT}`));
drawn('cnc', orderCancelConfirmActionId(ORDER, cancelRef), orderCancelDeclineActionId(ORDER));
drawn('tcl', ticketCloseConfirmActionId(TICKET, ticketRef), ticketCloseDeclineActionId(TICKET));
// The account stream draws this one as a `text` with actions, decline first — so both intent
// kinds and both button orders are covered.
{
    const yes = confirmActionId('unl', `telegram:${unlinkRef}`);
    const no = declineActionId('unl', 'telegram');
    drawn('unl', yes, no, {
        kind: 'text',
        text: 'Telegram\n\nDisconnect this app from your account?',
        actions: [{ id: no, label: 'Keep it' }, { id: yes, label: 'Disconnect' }],
    });
}

/** The close preview exactly as `bot-account.controller.ts` draws it. */
const CLOSE_INTENT: BotReplyIntent = {
    kind: 'text',
    text: 'Closing your account cannot be undone.',
    actions: [
        { id: declineActionId('close'), label: 'Keep my account' },
        { id: confirmActionId(`close:${closeRef}`), label: 'Close my account' },
    ],
};

function recorded(owner: PendingQuestionOwner): BotPendingQuestion | null {
    return readPendingQuestion(
        fakeRedis.store.get(`bot:pq:${owner.userId}:${owner.channel}`)?.value ?? null,
        owner,
        new Date(),
    );
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const read = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');

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

async function main(): Promise<void> {
    console.log('\n═══ test:chat-answer ════════════════════════════════════════════════════════\n');

    // ═════════════════════════════════════════════════════════════════════════
    section('1 · Which drawn replies are questions a word may answer');
    // ═════════════════════════════════════════════════════════════════════════

    await assert('the five answerable contexts are exactly the owner\'s list', () =>
        [...ANSWERABLE_QUESTION_CONTEXTS].sort().join() === ['cd', 'cnc', 'co', 'tcl', 'unl'].join());

    for (const context of ANSWERABLE_QUESTION_CONTEXTS) {
        await assert(`a drawn \`${context}\` pair is RECORDED with its exact tokens`, () => {
            const { yes, no, intent } = DRAWN[context];
            const decision = pendingQuestionDecisionFor(intent, NOW);
            return decision.kind === 'record'
                && decision.question.context === context
                && decision.question.yesToken === yes
                && decision.question.noToken === no
                && decision.question.askedAt === NOW.toISOString();
        });
    }

    await assert('⛔ the account-closure question is NEVER recorded — it supersedes as button-only', () => {
        const decision = pendingQuestionDecisionFor(CLOSE_INTENT, NOW);
        return decision.kind === 'supersede' && decision.reason === 'button_only';
    });

    await assert('a confirm context nobody has approved for words is treated like close', () => {
        const decision = pendingQuestionDecisionFor(pair(confirmActionId('bkc', ORDER), declineActionId('bkc', ORDER)), NOW);
        return decision.kind === 'supersede' && decision.reason === 'button_only';
    });

    await assert('a checkout with SEVERAL address rows is not a yes/no — "yes" names no address', () => {
        const intent: BotReplyIntent = {
            kind: 'choice',
            text: 'Which address?',
            options: [
                { id: checkoutConfirmActionId(checkoutRef, ADDRESS), label: 'Home' },
                { id: checkoutConfirmActionId(checkoutRef, ADDRESS_2), label: 'Office' },
                { id: checkoutDeclineActionId(checkoutRef), label: 'Not now' },
            ],
            listButton: 'Choose',
            sectionTitle: 'Addresses',
        };
        const decision = pendingQuestionDecisionFor(intent, NOW);
        return decision.kind === 'supersede' && decision.reason === 'not_a_pair';
    });

    await assert('a reply with no confirm button leaves the waiting question alone', () =>
        pendingQuestionDecisionFor({ kind: 'text', text: 'Your email?', actions: [{ id: skipActionId('email'), label: 'Skip' }] }, NOW).kind === 'none'
        && pendingQuestionDecisionFor({ kind: 'link', text: 'Pay', label: 'Pay', url: 'https://example.com' }, NOW).kind === 'none'
        && pendingQuestionDecisionFor(null, NOW).kind === 'none');

    await assert('a long question keeps its END — where the question is — within the cap', () => {
        const body = `${'Basket line\n'.repeat(60)}Total: 12 000 XAF\nPlace this order?`;
        const clipped = clipQuestionText(body);
        return Array.from(clipped).length <= PENDING_QUESTION_TEXT_MAX
            && clipped.startsWith('…')
            && clipped.endsWith('Place this order?');
    });

    await assert('clipping never cuts an emoji or an Arabic letter in half', () => {
        const clipped = clipQuestionText('😀'.repeat(400) + ' هل تريد المتابعة؟', 50);
        return Array.from(clipped).length === 50 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · The store — one question per conversation, fifteen minutes');
    // ═════════════════════════════════════════════════════════════════════════

    const store = new BotPendingQuestionStore();

    await assert('noteDraw records under bot:pq:<userId>:<channel> with a 15-minute TTL', async () => {
        fakeRedis.store.clear();
        const decision = await store.noteDraw(OWNER, DRAWN.cnc.intent);
        const key = `bot:pq:${USER}:whatsapp`;
        const ttl = fakeRedis.ttlSeconds(key);
        return decision.kind === 'record'
            && fakeRedis.store.has(key)
            && ttl !== null && ttl > PENDING_QUESTION_TTL_SECONDS - 5 && ttl <= PENDING_QUESTION_TTL_SECONDS
            && PENDING_QUESTION_TTL_SECONDS === 15 * 60;
    });

    await assert('the key holds no phone number', () =>
        [...fakeRedis.store.keys()].every((key) => !key.includes(PHONE)));

    await assert('a newer question OVERWRITES an older one', async () => {
        await store.noteDraw(OWNER, DRAWN.cd.intent);
        return recorded(OWNER)?.context === 'cd' && recorded(OWNER)?.yesToken === DRAWN.cd.yes;
    });

    await assert('⛔ a closure question drawn after a checkout question CLEARS the checkout one', async () => {
        await store.noteDraw(OWNER, DRAWN.co.intent);
        const before = recorded(OWNER)?.context === 'co';
        const decision = await store.noteDraw(OWNER, CLOSE_INTENT);
        return before && decision.kind === 'supersede' && recorded(OWNER) === null;
    });

    await assert('a reply with no confirm button does not touch the waiting question', async () => {
        await store.noteDraw(OWNER, DRAWN.tcl.intent);
        await store.noteDraw(OWNER, { kind: 'text', text: 'Anything else?' });
        return recorded(OWNER)?.context === 'tcl';
    });

    await assert('one chat per channel: the Telegram chat has its own question', async () => {
        await store.noteDraw(TELEGRAM_OWNER, DRAWN.cd.intent);
        return recorded(OWNER)?.context === 'tcl' && recorded(TELEGRAM_OWNER)?.context === 'cd';
    });

    await assert('peek leaves it; take removes it; a second take finds nothing', async () => {
        const peeked = await store.peek(OWNER);
        const taken = await store.take(OWNER);
        const again = await store.take(OWNER);
        return peeked?.context === 'tcl' && taken?.context === 'tcl' && again === null;
    });

    await assert('clear forgets one conversation, clearForUser every chat of that account only', async () => {
        await store.noteDraw(OWNER, DRAWN.co.intent);
        await store.noteDraw({ userId: OTHER_USER, channel: 'whatsapp' }, DRAWN.co.intent);
        await store.clear(TELEGRAM_OWNER);
        const telegramGone = recorded(TELEGRAM_OWNER) === null && recorded(OWNER) !== null;
        await store.noteDraw(TELEGRAM_OWNER, DRAWN.cd.intent);
        await store.clearForUser(USER);
        return telegramGone
            && recorded(OWNER) === null
            && recorded(TELEGRAM_OWNER) === null
            && recorded({ userId: OTHER_USER, channel: 'whatsapp' }) !== null;
    });

    await assert('a record is refused on read when it is not one this service would have written', () => {
        const question = (pendingQuestionDecisionFor(DRAWN.co.intent, NOW) as { question: BotPendingQuestion }).question;
        const good = serializePendingQuestion(OWNER, question);
        const within = new Date(NOW.getTime() + 60_000);
        const late = new Date(NOW.getTime() + (PENDING_QUESTION_TTL_SECONDS + 1) * 1000);
        const tampered = (patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(good), ...patch });
        return readPendingQuestion(good, OWNER, within)?.context === 'co'
            && readPendingQuestion(good, { userId: OTHER_USER, channel: 'whatsapp' }, within) === null
            && readPendingQuestion(good, OWNER, late) === null
            && readPendingQuestion('{not json', OWNER, within) === null
            && readPendingQuestion(tampered({ context: 'close' }), OWNER, within) === null
            && readPendingQuestion(tampered({ yesToken: DRAWN.cd.yes }), OWNER, within) === null;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · Recorded in the ONE place every drawn reply passes — `attachBotReply`');
    // ═════════════════════════════════════════════════════════════════════════

    /** Drive the real interceptor exactly as Express would, and return what it sent. */
    async function drawThroughInterceptor(intent: BotReplyIntent | null, body: Record<string, unknown>) {
        const req = {
            bot: {
                caller: { userId: USER, customerId: '68d000000000000000000f01', channel: 'whatsapp', externalIdentity: PHONE, identityHint: '••••0001' },
                envelope: { channel: 'whatsapp', externalId: PHONE },
                tool: 'test',
                anonymous: false,
                language: 'en',
                replyIntent: intent,
            },
        } as unknown as Request;
        let sent: unknown = null;
        const res = { json(payload: unknown) { sent = payload; return this; } } as unknown as Response;
        attachBotReply(req, res, () => undefined);
        res.json(body);
        await tick();
        await tick();
        return sent as Record<string, unknown>;
    }

    for (const context of ANSWERABLE_QUESTION_CONTEXTS) {
        await assert(`a drawn \`${context}\` reply is recorded by the interceptor, and still sent`, async () => {
            fakeRedis.store.clear();
            const sent = await drawThroughInterceptor(DRAWN[context].intent, { success: true, data: {} });
            return recorded(OWNER)?.context === context && 'reply' in sent;
        });
    }

    await assert('⛔ the interceptor never records the closure question', async () => {
        fakeRedis.store.clear();
        await drawThroughInterceptor(CLOSE_INTENT, { success: true, data: {} });
        /**
         * ⚠ **`bot:pq:` keys only, not an empty database.** The same interceptor also writes
         * `bot:sent:` — "what the platform has recently sent this customer"
         * (`domain/bot-recently-sent.ts`, `test:recently-sent`) — and the closure preview IS a
         * message the customer was shown, so that record correctly holds its words. What must
         * never exist is a waiting QUESTION a typed "yes" could spend.
         */
        return [...fakeRedis.store.keys()].every((key) => !key.startsWith('bot:pq:'));
    });

    await assert('a FAILED response records nothing — the question was never shown', async () => {
        fakeRedis.store.clear();
        await drawThroughInterceptor(DRAWN.co.intent, {
            success: false,
            error: { code: 'X', customerMessage: 'Sorry', category: 'business_rule' },
        });
        return fakeRedis.store.size === 0;
    });

    await assert('an idempotency REPLAY (body already carries reply) records nothing again', async () => {
        fakeRedis.store.clear();
        await drawThroughInterceptor(DRAWN.co.intent, { success: true, data: {}, reply: { channel: 'whatsapp' } });
        return fakeRedis.store.size === 0;
    });

    const replySrc = read('src', 'modules', 'bot-surface', 'middlewares', 'bot-reply.middleware.ts');
    const noteDrawCallers = () => {
        const root = path.join(__dirname, '..', '..', 'src');
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes('.noteDraw(')) {
                    hits.push(path.relative(root, full).replace(/\\/g, '/'));
                }
            }
        };
        walk(root);
        return hits;
    };

    await assert('⭐ exactly ONE caller records questions — the interceptor, not the controllers', () => {
        const hits = noteDrawCallers();
        return hits.length === 1 && hits[0] === 'modules/bot-surface/middlewares/bot-reply.middleware.ts';
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · A typed answer runs the TAP\'s handler, with the TAP\'s action');
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * ⚠ **The router is private to the controller, and that is fine for what is being proved.**
     * `routeTap` is a deterministic function of (the one registry, the token): it parses, resolves
     * the key with `actionKeyOf`, and runs `HANDLERS[key]`. So "the typed answer runs the tap's
     * handler with the tap's action" is two facts — (a) the answer hands `routeTap` the button's
     * token, byte for byte, which is proved here behaviourally; (b) both doors hand their token to
     * that one router and nothing else routes, which the scans below prove, each with a mutant.
     * That the drawn buttons' keys are registered at all is `test:bot-surface` § 20.
     */
    for (const context of ANSWERABLE_QUESTION_CONTEXTS) {
        for (const answer of ['yes', 'no'] as const) {
            await assert(`typed "${answer}" to \`${context}\` hands the router the ${answer} button's own token`, async () => {
                fakeRedis.store.clear();
                await store.noteDraw(OWNER, DRAWN[context].intent);

                const typedToken = await answerTokenFor(store, OWNER, answer);
                const tapToken = answer === 'yes' ? DRAWN[context].yes : DRAWN[context].no;
                const typed = actionKeyOf(parseBotActionId(typedToken)!);
                const tapped = actionKeyOf(parseBotActionId(tapToken)!);

                return typedToken === tapToken
                    && typed.key === `${answer}:${context}`
                    && JSON.stringify(typed) === JSON.stringify(tapped);
            });
        }
    }

    await assert('no question waiting → 409 BOT_NO_PENDING_QUESTION, category conflict', async () => {
        fakeRedis.store.clear();
        try {
            await answerTokenFor(store, OWNER, 'no');
            return false;
        } catch (error) {
            return error instanceof AppError
                && error.code === ERROR_CODES.BOT_NO_PENDING_QUESTION
                && error.statusCode === 409
                && error.category === ERROR_CATEGORIES.CONFLICT;
        }
    });

    await assert('the refusal has its OWN sentence in all five languages, and an operator message', () => {
        const fallback = (lang: string) => customerMessageFor('NO_SUCH_CODE_FOR_TEST', ERROR_CATEGORIES.CONFLICT, lang);
        return BOT_COPY_LANGUAGES.length === 5
            && BOT_COPY_LANGUAGES.every((lang) => {
                const text = customerMessageFor(ERROR_CODES.BOT_NO_PENDING_QUESTION, ERROR_CATEGORIES.CONFLICT, lang);
                return text.trim().length > 20 && text !== fallback(lang);
            })
            && typeof DEFAULT_ERROR_MESSAGES[ERROR_CODES.BOT_NO_PENDING_QUESTION] === 'string';
    });

    /** ⛔ The property, as a function of the answer rule — so the mutant below can be held to it. */
    async function closeNeverRuns(tokenFor: (q: BotPendingQuestion, a: 'yes' | 'no') => string | null): Promise<boolean> {
        fakeRedis.store.clear();
        // A record an operator (or a bug) planted: closure, dressed as a waiting question.
        const planted = {
            context: 'close',
            yesToken: confirmActionId(`close:${closeRef}`),
            noToken: declineActionId('close'),
            questionText: 'Close?',
            askedAt: new Date().toISOString(),
        };
        await fakeRedis.set(`bot:pq:${USER}:whatsapp`, JSON.stringify({ ...planted, owner: USER }), { EX: 900 });
        // What the answer rule would hand the router for "yes" on that record.
        const handedToRouter = tokenFor(planted as unknown as BotPendingQuestion, 'yes');
        let refused = false;
        try {
            await answerTokenFor(store, OWNER, 'yes');
        } catch (error) {
            refused = error instanceof AppError && error.code === ERROR_CODES.BOT_NO_PENDING_QUESTION;
        }
        return refused && handedToRouter === null;
    }

    await assert('⛔ a planted closure record is refused on the way OUT — yes:close never reaches the router', () =>
        closeNeverRuns(tokenForAnswer));

    await assert('⭐ MUTANT — an answer rule without the context check WOULD hand the router yes:close', async () => {
        const mutantTokenFor = (q: BotPendingQuestion, a: 'yes' | 'no') => (a === 'yes' ? q.yesToken : q.noToken);
        return (await closeNeverRuns(mutantTokenFor)) === false;
    });

    /** "Taken, not read" — as a function of the store, so the mutant below can be held to it. */
    async function answeredOnce(candidate: BotPendingQuestionStore): Promise<boolean> {
        fakeRedis.store.clear();
        await candidate.noteDraw(OWNER, DRAWN.cnc.intent);
        await answerTokenFor(candidate, OWNER, 'yes');
        try {
            await answerTokenFor(candidate, OWNER, 'yes');
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === ERROR_CODES.BOT_NO_PENDING_QUESTION;
        }
    }

    await assert('an answered question is GONE — a second "yes" is refused, never run twice', () => answeredOnce(store));

    await assert('⭐ MUTANT — a store that READS instead of taking would run the cancel twice', async () => {
        class ReadingStore extends BotPendingQuestionStore {
            async take(owner: PendingQuestionOwner): Promise<BotPendingQuestion | null> {
                return this.peek(owner);
            }
        }
        return (await answeredOnce(new ReadingStore())) === false;
    });

    // ── The controller: both doors, one registry, one router ────────────────
    const controllerSrc = read('src', 'modules', 'bot-surface', 'controllers', 'bot-action.controller.ts');

    const dispatchSpan = (src: string) => spanOf(src, 'static dispatch = asyncHandler', 'static answer = asyncHandler');
    const answerSpan = (src: string) => spanOf(src, 'static answer = asyncHandler', 'async function routeTap(');
    const routerSpan = (src: string) => spanOf(src, 'async function routeTap(', null);

    /** The tap clears the question BEFORE it routes, through the one router. */
    const tapClearsThenRoutes = (src: string) => {
        const span = dispatchSpan(src);
        const clear = span.indexOf('botPendingQuestionStore.clear(caller)');
        const route = span.indexOf('routeTap(req, res, token)');
        return clear > 0 && route > clear;
    };
    /** The answer takes the question BEFORE it routes, through the SAME router. */
    const answerTakesThenRoutes = (src: string) => {
        const span = answerSpan(src);
        const take = span.indexOf('answerTokenFor(botPendingQuestionStore, caller, answer)');
        const route = span.indexOf('routeTap(req, res, token)');
        return take > 0 && route > take;
    };
    /** There is ONE router: the only parse and the only registry lookup in the file are inside it. */
    const oneRouter = (src: string) => {
        const router = routerSpan(src);
        return src.split('mergeActionHandlers([').length === 2
            && src.split('HANDLERS[').length === 2 && router.includes('const handler = HANDLERS[key];')
            && src.split('parseBotActionId(').length === 2 && router.includes('parseBotActionId(token)')
            && router.includes('actionKeyOf(parsed)')
            && router.includes('await handler(req, res, action);');
    };

    await assert('a TAP clears the waiting question before its handler runs', () => tapClearsThenRoutes(controllerSrc));
    await assert('an ANSWER takes the question, then hands its token to the tap\'s own router', () =>
        answerTakesThenRoutes(controllerSrc));
    await assert('there is ONE registry and ONE router in the controller', () => oneRouter(controllerSrc));

    await assert('⭐ MUTANT — the tap scan catches a dispatcher that no longer clears', () =>
        bites(controllerSrc.replace('await botPendingQuestionStore.clear(caller);', '// removed'), tapClearsThenRoutes));
    await assert('⭐ MUTANT — the answer scan catches typed answers sent to a second router', () =>
        bites(
            controllerSrc.replace(
                /(static answer = asyncHandler[\s\S]*?)routeTap\(req, res, token\)/,
                '$1routeAnswer(req, res, token)',
            ),
            answerTakesThenRoutes,
        ));
    await assert('⭐ MUTANT — the router scan catches a second registry lookup', () =>
        bites(
            controllerSrc.replace(
                'const token = await answerTokenFor(',
                'const own = HANDLERS[\'yes:co\'];\n        const token = await answerTokenFor(',
            ),
            oneRouter,
        ));

    // The store's clear, as the tap runs it: a question drawn, a tap, and nothing left.
    await assert('a tap\'s clear leaves nothing for a later typed answer', async () => {
        fakeRedis.store.clear();
        await store.noteDraw(OWNER, DRAWN.co.intent);
        await store.clear(OWNER);
        try {
            await answerTokenFor(store, OWNER, 'yes');
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === ERROR_CODES.BOT_NO_PENDING_QUESTION;
        }
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · The route, the schema and the catalogue move in lockstep');
    // ═════════════════════════════════════════════════════════════════════════

    await assert('BOT_ROUTES mounts chat_answer_question at POST /chat/answer, mutating', () => {
        const row = BOT_ROUTES.find((r) => r.tool === 'chat_answer_question');
        return row?.method === 'POST' && row.path === '/chat/answer' && row.mutating === true && row.requiresCustomerRole === true
            && botRouteFor('POST', '/api/internal/bot/chat/answer')?.tool === 'chat_answer_question';
    });

    await assert('bot.routes.ts wires it to BotActionController.answer', () =>
        /chat_answer_question:\s*BotActionController\.answer,/.test(read('src', 'modules', 'bot-surface', 'bot.routes.ts')));

    await assert('the schema takes yes or no and NOTHING else — never a token', () =>
        BotChatAnswerSchema.safeParse({ answer: 'yes' }).success
        && BotChatAnswerSchema.safeParse({ answer: 'no' }).success
        && !BotChatAnswerSchema.safeParse({ answer: 'maybe' }).success
        && !BotChatAnswerSchema.safeParse({ answer: 'yes', token: DRAWN.co.yes }).success
        && !BotChatAnswerSchema.safeParse({}).success);

    const catalog = readCatalog();
    const row = catalog.tools.find((t) => t.name === 'chat_answer_question') as
        | (ReturnType<typeof readCatalog>['tools'][number] & { errors?: Array<{ code: string; status: number }> })
        | undefined;

    await assert('the catalogue row is MODEL-FACING (core, not flow_only) and emitted to MCP', () =>
        row?.tier === 'core'
        && row.surface === 'bot_internal'
        && row.mutating === true
        && selectMcpTools(catalog).some((t) => t.name === 'chat_answer_question'));

    await assert('its only argument is `answer`, enum yes|no', () => {
        const props = row?.parameters.properties ?? {};
        return Object.keys(props).join() === 'answer'
            && JSON.stringify(props.answer?.enum) === JSON.stringify(['yes', 'no'])
            && JSON.stringify(row?.parameters.required) === JSON.stringify(['answer']);
    });

    await assert('its description tells the model: never for closure, a question is not an answer', () => {
        const text = `${row?.description} ${row?.when_to_use} ${row?.when_not_to_use}`;
        return /closing the account/i.test(text)
            && /question is not an answer/i.test(text)
            && /pendingQuestion/.test(text)
            && /SENDS THE CUSTOMER/.test(text);
    });

    await assert('its errors name BOT_NO_PENDING_QUESTION at 409', () =>
        (row?.errors ?? []).some((e) => e.code === 'BOT_NO_PENDING_QUESTION' && e.status === 409));

    // ═════════════════════════════════════════════════════════════════════════
    section('6 · /identity/sync shows the model the question and the epoch — never the tokens');
    // ═════════════════════════════════════════════════════════════════════════

    const identityInput = {
        displayName: 'Ada',
        language: 'fr',
        connectedChannels: ['whatsapp' as const],
        hasOpenOrders: true,
        identityHint: '••••0001',
        // Opaque to the projection; a real seal needs a secret this DB-free suite does not hold.
        botToken: 'sealed-identity-token-placeholder',
        // The sibling record. Its own suite is `test:recently-sent`; here it only has to be
        // supplied, because `toBotIdentityDto` requires it for the reason `memoryEpoch` is
        // required — a caller that could forget it would hand a model half a conversation.
        recentlySent: [],
    };

    await assert('pendingQuestion is { context, text, askedAt } and carries neither button token', () => {
        const question = (pendingQuestionDecisionFor(DRAWN.cnc.intent, NOW) as { question: BotPendingQuestion }).question;
        const dto = toBotIdentityDto({ ...identityInput, memoryEpoch: 2, pendingQuestion: question });
        const json = JSON.stringify(dto);
        return Object.keys(dto.pendingQuestion ?? {}).sort().join() === 'askedAt,context,text'
            && dto.pendingQuestion?.context === 'cnc'
            && !json.includes(DRAWN.cnc.yes)
            && !json.includes(cancelRef)
            && !json.includes('yesToken') && !json.includes('noToken');
    });

    await assert('memoryEpoch passes through, and a missing or broken value reads as 0', () =>
        toBotIdentityDto({ ...identityInput, memoryEpoch: 3, pendingQuestion: null }).memoryEpoch === 3
        && toBotIdentityDto({ ...identityInput, memoryEpoch: Number.NaN, pendingQuestion: null }).memoryEpoch === 0
        && toBotIdentityDto({ ...identityInput, memoryEpoch: -1, pendingQuestion: null }).memoryEpoch === 0
        && toBotIdentityDto({ ...identityInput, memoryEpoch: 0, pendingQuestion: null }).pendingQuestion === null);

    const identitySrc = read('src', 'modules', 'bot-surface', 'controllers', 'bot-identity.controller.ts');
    await assert('BOTH identity routes supply the epoch and the question (resolve is the maintenance fallback)', () => {
        const resolve = spanOf(identitySrc, 'static resolve = asyncHandler', 'static sync = asyncHandler');
        const describe = spanOf(identitySrc, 'async function describe(', 'function setOnboardingReply');
        return /memoryEpoch:\s*customer\?\.bot_memory_epoch \?\? 0/.test(resolve)
            && /waitingQuestionOf\(caller\)/.test(resolve)
            && /memoryEpoch:\s*customer\.bot_memory_epoch \?\? 0/.test(describe)
            && /waitingQuestionOf\(\{ userId: outcome\.account\.userId, channel: outcome\.account\.channel \}\)/.test(describe);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('7 · The administrator\'s memory reset');
    // ═════════════════════════════════════════════════════════════════════════

    await assert('the Customer schema holds the epoch (default 0) and the reset time (default null)', () => {
        const epoch = CustomerModel.schema.path('bot_memory_epoch') as unknown as { defaultValue?: unknown; instance?: string };
        const at = CustomerModel.schema.path('bot_memory_reset_at') as unknown as { defaultValue?: unknown; instance?: string };
        return epoch?.instance === 'Number' && epoch.defaultValue === 0
            && at?.instance === 'Date' && at.defaultValue === null;
    });

    await assert('a reset answers exactly { userId, memoryEpoch, resetAt } and clears the question', async () => {
        fakeRedis.store.clear();
        await store.noteDraw(OWNER, DRAWN.co.intent);
        await store.noteDraw(TELEGRAM_OWNER, DRAWN.cd.intent);
        const bumped: Array<{ userId: string; at: Date }> = [];
        const ports: BotMemoryResetPorts = {
            async bumpEpoch(userId, at) { bumped.push({ userId, at }); return 4; },
            clearPendingQuestions: (userId) => store.clearForUser(userId),
        };
        const result = await new BotMemoryService(ports).reset(USER, NOW);
        return JSON.stringify(result) === JSON.stringify({ userId: USER, memoryEpoch: 4, resetAt: NOW.toISOString() })
            && bumped.length === 1 && bumped[0].userId === USER && bumped[0].at === NOW
            && recorded(OWNER) === null && recorded(TELEGRAM_OWNER) === null;
    });

    await assert('an account with no customer profile → 404 AUTH_PROFILE_NOT_FOUND, nothing cleared', async () => {
        let cleared = false;
        const ports: BotMemoryResetPorts = {
            async bumpEpoch() { return null; },
            async clearPendingQuestions() { cleared = true; },
        };
        try {
            await new BotMemoryService(ports).reset(USER, NOW);
            return false;
        } catch (error) {
            return error instanceof AppError && error.code === ERROR_CODES.AUTH_PROFILE_NOT_FOUND
                && error.statusCode === 404 && !cleared;
        }
    });

    await assert('a Redis failure on the clear does NOT fail a reset whose epoch already moved', async () => {
        const ports: BotMemoryResetPorts = {
            async bumpEpoch() { return 1; },
            async clearPendingQuestions() { throw new Error('redis down'); },
        };
        const originalWarn = console.warn;
        console.warn = () => undefined;
        try {
            const result = await new BotMemoryService(ports).reset(USER, NOW);
            return result.memoryEpoch === 1;
        } finally {
            console.warn = originalWarn;
        }
    });

    const memorySrc = read('src', 'modules', 'bot-surface', 'services', 'bot-memory.service.ts');
    const incrementsAtomically = (src: string) =>
        /\$inc:\s*\{\s*bot_memory_epoch:\s*1\s*\}/.test(src)
        && /\$set:\s*\{\s*bot_memory_reset_at:\s*at\s*\}/.test(src)
        && /timestamps:\s*false/.test(src)
        && /\{\s*user_id:\s*userId\s*\}/.test(src);

    await assert('the write is ONE atomic $inc + $set on the customer, updated_at untouched', () => incrementsAtomically(memorySrc));
    await assert('⭐ MUTANT — the scan catches a read-then-write epoch', () =>
        bites(memorySrc.replace('$inc: { bot_memory_epoch: 1 }', '$set: { bot_memory_epoch: epoch + 1 }'), incrementsAtomically));

    const routesSrc = read('src', 'modules', 'users', 'admin-user.routes.ts');
    const adminControllerSrc = read('src', 'modules', 'users', 'admin-user.controller.ts');
    const adminRoutesSrc = read('src', 'api', 'routes', 'internal-admin.routes.ts');

    await assert('POST /:userId/bot-memory/reset is on the /users admin router, behind requireAdminCaller', () =>
        routesSrc.includes("router.post('/:userId/bot-memory/reset', AdminUserController.resetBotMemory)")
        && adminRoutesSrc.includes("router.use('/users', buildAdminUserRouter([requireAdminCaller]))"));

    await assert('the handler checks the USER first, then resets, and answers with no `message`', () => {
        const span = spanOf(adminControllerSrc, 'static resetBotMemory = asyncHandler', null);
        const check = span.indexOf('adminUserService.getById(req.params.userId)');
        const reset = span.indexOf('botMemoryService.reset(req.params.userId)');
        return check > 0 && reset > check && /sendSuccess\(res, result\);/.test(span);
    });

    console.log(`\n${'─'.repeat(76)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log(`${'─'.repeat(76)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('test:chat-answer crashed:', err);
    process.exit(1);
});
