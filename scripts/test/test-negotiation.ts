/**
 * test:negotiation — the bargaining gate (Stream A).
 *
 * No database. The gate is a pure function by construction, the traits guard is a
 * Zod schema, and everything that cannot be reached without Mongo is a source scan.
 *
 * Run: npm run test:negotiation
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
    GateInput,
    REFUSAL_CODES,
    judgeProposedPrice,
    reviseInstruction,
} from '../../src/modules/negotiation/domain/negotiation-gate.rule';
import {
    NegotiationContextSchema,
    NegotiationRecordSchema,
    NegotiationTraitsSchema,
} from '../../src/modules/negotiation/validators/negotiation.validator';
import {
    composeDealText,
    DEAL_MESSAGE_BUDGET,
    dealInBasketIntent,
    dealRefusedIntent,
} from '../../src/modules/negotiation/domain/deal-in-basket';
import { isRecordReplay, ReplaySessionView } from '../../src/modules/negotiation/domain/record-replay.rule';
import { AgreedDeal, placeDealInBasket } from '../../src/modules/negotiation/services/deal-basket.service';
import { botChrome } from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import { BOT_COPY_LANGUAGES, customerMessageFor } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { BotReplyIntent, renderBotReply } from '../../src/modules/bot-surface/domain/channel-reply';
import { addedToCartActions } from '../../src/modules/bot-surface/domain/purchase-chat-copy';
import { WA_LIMITS } from '../../src/modules/whatsapp/constants/whatsapp-limits';
import { ERROR_CATEGORIES } from '../../src/core/error-category';
import { ERROR_CODES } from '../../src/core/error-codes';
import { AppError, createAppError } from '../../src/core/errors';
import { CartService } from '../../src/modules/cart/services/cart.service';
import { CartModel } from '../../src/modules/cart/models/cart.model';

const originalConsole = { log: console.log.bind(console) };
let passed = 0;
let failed = 0;

function assert(label: string, fn: () => void): void {
    try {
        fn();
        passed += 1;
        originalConsole.log(`  ✅ ${label}`);
    } catch (error) {
        failed += 1;
        originalConsole.log(`  ❌ FAIL: ${label}`);
        originalConsole.log(`     ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function assertAsync(label: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed += 1;
        originalConsole.log(`  ✅ ${label}`);
    } catch (error) {
        failed += 1;
        originalConsole.log(`  ❌ FAIL: ${label}`);
        originalConsole.log(`     ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Run a scan over MUTATED text and demand that it throws — a guard nobody has seen fail is untested. */
function bites(label: string, original: string, mutated: string, scan: (src: string) => void): void {
    // A mutant that changes nothing proves nothing: it would "pass" by being the original.
    if (mutated === original) throw new Error(`${label}: the mutant did not apply — its anchor is gone`);
    scan(original); // the target must PASS at baseline, or the bite below proves nothing either
    let threw = false;
    try {
        scan(mutated);
    } catch {
        threw = true;
    }
    if (!threw) throw new Error(`${label}: the scan passed a mutant it exists to catch`);
}

const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const readSrc = (...parts: string[]): string =>
    readFileSync(join(__dirname, '..', '..', 'src', ...parts), 'utf8').replace(/\r\n/g, '\n');

/** The body of one method, from its signature to the next member at the same indentation. */
function methodBody(src: string, signature: string): string {
    const at = src.indexOf(signature);
    if (at < 0) throw new Error(`\`${signature}\` not found`);
    const rest = src.slice(at + signature.length);
    const next = rest.search(/\n {4}(?:private |async |static |public )/);
    return next < 0 ? rest : rest.slice(0, next);
}

const actionIdsOf = (intent: BotReplyIntent): string[] =>
    intent.kind === 'text' && intent.actions ? intent.actions.map((a) => a.id) : [];

function eq<T>(actual: T, expected: T, what: string): void {
    if (actual !== expected) {
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

const SRC = join(__dirname, '..', '..', 'src', 'modules', 'negotiation');
const NOW = new Date('2026-09-07T12:00:00.000Z');
const LATER = new Date('2026-09-07T12:30:00.000Z');

/** floor 32 000, ask 45 000 — the plan's worked example. */
function gate(over: Partial<GateInput> = {}): ReturnType<typeof judgeProposedPrice> {
    return judgeProposedPrice({
        floor: 32000,
        ask: 45000,
        proposedPrice: 41000,
        previousCounter: null,
        sessionStatus: 'open',
        sessionExpiresAt: LATER,
        now: NOW,
        ...over,
    });
}

function refusalOf(v: ReturnType<typeof judgeProposedPrice>): string {
    return v.approved ? 'APPROVED' : v.refusal;
}

async function main(): Promise<void> {
    originalConsole.log('\n── 1 · The gate: the window ─────────────────────────────────────────────');

    assert('a price inside the window is approved', () => {
        eq(gate().approved, true, 'approved');
    });

    assert('⭐ a price EXACTLY at the floor is approved — the boundary is inclusive', () => {
        eq(gate({ proposedPrice: 32000 }).approved, true, 'approved');
    });

    assert('⭐ a price EXACTLY at the ask is approved', () => {
        eq(gate({ proposedPrice: 45000 }).approved, true, 'approved');
    });

    assert('one franc below the floor is refused', () => {
        eq(refusalOf(gate({ proposedPrice: 31999 })), 'below_floor', 'refusal');
    });

    assert('one franc above the ask is refused', () => {
        eq(refusalOf(gate({ proposedPrice: 45001 })), 'above_ask', 'refusal');
    });

    assert('a degenerate window (floor === ask) admits exactly that price', () => {
        eq(gate({ floor: 32000, ask: 32000, proposedPrice: 32000 }).approved, true, 'at');
        eq(refusalOf(gate({ floor: 32000, ask: 32000, proposedPrice: 31999 })), 'below_floor', 'below');
        eq(refusalOf(gate({ floor: 32000, ask: 32000, proposedPrice: 32001 })), 'above_ask', 'above');
    });

    originalConsole.log('\n── 2 · The gate: direction (playbook iron rule 1) ───────────────────────');

    assert('a lower counter than the last is approved', () => {
        eq(gate({ previousCounter: 41000, proposedPrice: 38000 }).approved, true, 'approved');
    });

    assert('⭐ HOLDING at the same price is approved — Margin Guardian depends on it', () => {
        eq(gate({ previousCounter: 41000, proposedPrice: 41000 }).approved, true, 'approved');
    });

    assert('going back UP is refused', () => {
        eq(refusalOf(gate({ previousCounter: 38000, proposedPrice: 41000 })), 'price_increased', 'refusal');
    });

    assert('the first turn has no previous counter and is unconstrained by direction', () => {
        eq(gate({ previousCounter: null, proposedPrice: 45000 }).approved, true, 'approved');
    });

    assert('the window is checked BEFORE direction — a sub-floor hold reports the floor', () => {
        // Both rules are violated; the vendor's boundary is the more important answer.
        eq(refusalOf(gate({ previousCounter: 31000, proposedPrice: 31000 })), 'below_floor', 'refusal');
    });

    originalConsole.log('\n── 3 · The gate: session state ─────────────────────────────────────────');

    for (const status of ['agreed', 'closed'] as const) {
        assert(`a ${status} session refuses any price`, () => {
            eq(refusalOf(gate({ sessionStatus: status })), 'session_closed', 'refusal');
        });
    }

    assert('an expired session reports session_expired, not session_closed', () => {
        eq(refusalOf(gate({ sessionStatus: 'expired' })), 'session_expired', 'refusal');
    });

    assert('⭐ expiry EXACTLY now counts as expired', () => {
        eq(refusalOf(gate({ sessionExpiresAt: NOW })), 'session_expired', 'refusal');
    });

    assert('one millisecond before expiry is still live', () => {
        eq(gate({ sessionExpiresAt: new Date(NOW.getTime() + 1) }).approved, true, 'approved');
    });

    assert('session state is checked before the price — a closed session is not a price problem', () => {
        eq(refusalOf(gate({ sessionStatus: 'closed', proposedPrice: 1 })), 'session_closed', 'refusal');
    });

    originalConsole.log('\n── 4 · Refusals map to codes, and to model instructions ────────────────');

    assert('every refusal has an error code — the map is total', () => {
        const refusals = ['session_closed', 'session_expired', 'below_floor', 'above_ask', 'price_increased'];
        for (const r of refusals) {
            if (!REFUSAL_CODES[r as keyof typeof REFUSAL_CODES]) throw new Error(`no code for ${r}`);
        }
        eq(Object.keys(REFUSAL_CODES).length, refusals.length, 'code count');
    });

    assert('every refusal has a non-empty instruction naming the number to act on', () => {
        if (!reviseInstruction('below_floor', { floor: 32000 }).includes('32000')) {
            throw new Error('below_floor instruction does not name the floor');
        }
        if (!reviseInstruction('above_ask', { ask: 45000 }).includes('45000')) {
            throw new Error('above_ask instruction does not name the ask');
        }
        if (!reviseInstruction('price_increased', { previousCounter: 38000 }).includes('38000')) {
            throw new Error('price_increased instruction does not name the previous counter');
        }
    });

    originalConsole.log('\n── 5 · The traits guard (the one column a model writes) ────────────────');

    assert('flat scalars are accepted', () => {
        NegotiationTraitsSchema.parse({ tone: 'skeptical', trust_level: 0.4, is_returning: true });
    });

    assert('a NESTED object is refused', () => {
        if (NegotiationTraitsSchema.safeParse({ tone: { a: 1 } }).success) {
            throw new Error('nested object accepted');
        }
    });

    assert('an ARRAY value is refused', () => {
        if (NegotiationTraitsSchema.safeParse({ tone: ['a'] }).success) {
            throw new Error('array accepted');
        }
    });

    assert('a key that is not lower_snake_case is refused', () => {
        if (NegotiationTraitsSchema.safeParse({ 'Tone Of Voice': 'x' }).success) {
            throw new Error('bad key accepted');
        }
    });

    assert('⭐ prose in a trait is refused — a trait is a label, not a transcript', () => {
        if (NegotiationTraitsSchema.safeParse({ tone: 'x'.repeat(121) }).success) {
            throw new Error('121-character trait accepted');
        }
    });

    assert('more than 40 traits is refused', () => {
        const many: Record<string, string> = {};
        for (let i = 0; i < 41; i += 1) many[`trait_${i}`] = 'x';
        if (NegotiationTraitsSchema.safeParse(many).success) throw new Error('41 traits accepted');
    });

    assert('NaN and Infinity are refused', () => {
        if (NegotiationTraitsSchema.safeParse({ trust_level: Number.NaN }).success) {
            throw new Error('NaN accepted');
        }
        if (NegotiationTraitsSchema.safeParse({ trust_level: Number.POSITIVE_INFINITY }).success) {
            throw new Error('Infinity accepted');
        }
    });

    originalConsole.log('\n── 6 · Identity is never a parameter ───────────────────────────────────');

    const validIdentity = { channel: 'whatsapp' as const, externalId: '237600123456' };

    assert('⭐ a customerId in the body is a 400, not a silently ignored field', () => {
        const result = NegotiationContextSchema.safeParse({
            identity: validIdentity,
            variantId: 'v1',
            customerId: 'deadbeefdeadbeefdeadbeef',
        });
        if (result.success) {
            throw new Error(
                'customerId was accepted — on a surface reachable with a service token that is account takeover',
            );
        }
    });

    assert('a userId inside the identity envelope is refused too', () => {
        const result = NegotiationRecordSchema.safeParse({
            identity: { ...validIdentity, userId: 'x' },
            sessionId: 's',
            reply: 'hi',
            agentProposedPrice: 100,
        });
        if (result.success) throw new Error('userId accepted inside the envelope');
    });

    assert('a fractional price is refused — both rails settle in whole XAF', () => {
        const result = NegotiationRecordSchema.safeParse({
            identity: validIdentity,
            sessionId: 's',
            reply: 'hi',
            agentProposedPrice: 100.5,
        });
        if (result.success) throw new Error('fractional price accepted');
    });

    assert('`lock` defaults to false — a close is never inferred from silence', () => {
        const parsed = NegotiationRecordSchema.parse({
            identity: validIdentity,
            sessionId: 's',
            reply: 'hi',
            agentProposedPrice: 41000,
        });
        eq(parsed.lock, false, 'lock');
    });

    originalConsole.log('\n── 7 · Source scans ────────────────────────────────────────────────────');

    const serviceSrc = readFileSync(join(SRC, 'services', 'negotiation.service.ts'), 'utf8');
    const ruleSrc = readFileSync(join(SRC, 'domain', 'negotiation-gate.rule.ts'), 'utf8');

    assert('⭐ the gate judges the LIVE window, never the session snapshot', () => {
        // `floor_at_open` / `ask_at_open` are audit. If either reaches judgeProposedPrice,
        // a vendor's price edit becomes exploitable for the life of the session.
        const judgeCall = serviceSrc.slice(serviceSrc.indexOf('judgeProposedPrice({'));
        const args = judgeCall.slice(0, judgeCall.indexOf('});'));
        if (args.includes('floor_at_open') || args.includes('ask_at_open')) {
            throw new Error('the gate is being judged against the session snapshot');
        }
        if (!args.includes('window.floor') || !args.includes('window.ask')) {
            throw new Error('the gate is not reading the live window');
        }
    });

    assert('`record` re-reads the window on every turn', () => {
        const record = serviceSrc.slice(serviceSrc.indexOf('async record('));
        if (!record.slice(0, record.indexOf('judgeProposedPrice')).includes('readLiveWindow')) {
            throw new Error('record() does not call readLiveWindow before judging');
        }
    });

    assert('the floor snapshot on a LOCK is taken from the live window, not the session', () => {
        if (!serviceSrc.includes('floor_snapshot: window.floor')) {
            throw new Error(
                'lock.floor_snapshot is not window.floor — Stream C/E computes the 30% uplift from it',
            );
        }
    });

    assert('the pure rule reads no clock and no database of its own', () => {
        for (const forbidden of ['Date.now(', 'new Date(', 'Model.', 'await ']) {
            if (ruleSrc.includes(forbidden)) {
                throw new Error(`the gate rule references ${forbidden} — it must stay pure and testable at a boundary`);
            }
        }
    });

    assert('the session lookup is scoped to the caller — a wrong id is 404, never 403', () => {
        const record = serviceSrc.slice(serviceSrc.indexOf('async record('));
        const lookup = record.slice(0, record.indexOf('if (!session)'));
        if (!lookup.includes('customer_id')) {
            throw new Error('the session lookup is not customer-scoped');
        }
        if (!record.includes('NEGOTIATION_SESSION_NOT_FOUND, 404')) {
            throw new Error('a missing session is not answered as 404');
        }
    });

    await spokenDealSections();

    originalConsole.log('\n════════════════════════════════════════════════════════════════════════════');
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('════════════════════════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exitCode = 1;
}

/**
 * ⭐ § 8–12 — A DEAL AGREED IN WORDS DOES WHAT THE LOCK-IT-IN PRESS DOES (owner, 2026-09-22).
 *
 * The incident (executions 1914 → 1934): the agent agreed 6 000 XAF in words and the gate minted the
 * lock — and nothing was added to the basket, no button was drawn, and the approved sentence asked
 * for "your delivery address and number". The customer reached the basket only by tapping an OLD
 * offer button two turns later. These sections pin the fix at every seam it has: the shared basket
 * core, the message both closers render, the retry rule, the wiring, and the agent's instruction.
 */
async function spokenDealSections(): Promise<void> {
    const DEAL: AgreedDeal = {
        customerId: '68b0000000000000000000c1',
        productId: '68b0000000000000000000a1',
        variantId: '68b0000000000000000000b1',
        quantity: 2,
        currency: 'XAF',
        lockRef: 'nlk_00000000000000000000000000000001',
    };
    const LEAD = 'Va pour 10 500 l’unité 🤝';
    const BASKET_IDS = addedToCartActions('en').map((a) => a.id);

    originalConsole.log('\n── 8 · ⭐ The ONE basket core both closers call ─────────────────────────');

    await assertAsync('a placed deal is written ONCE, with every field from the deal and nothing else', async () => {
        const calls: AgreedDeal[] = [];
        const outcome = await placeDealInBasket({ addToCart: async (d) => { calls.push(d); } }, DEAL);
        eq(outcome.placed, true, 'placed');
        eq(calls.length, 1, 'cart writes');
        eq(JSON.stringify(calls[0]), JSON.stringify(DEAL), 'the write');
    });

    await assertAsync('⭐ a cart REFUSAL is an outcome, never a throw — the deal is already agreed', async () => {
        const thrown = createAppError(ERROR_CODES.CART_MIXED_PRODUCT_TYPES, 409, 'mixed');
        const outcome = await placeDealInBasket({ addToCart: async () => { throw thrown; } }, DEAL);
        if (outcome.placed) throw new Error('a refused basket reported placed');
        eq(outcome.refusal.code, ERROR_CODES.CART_MIXED_PRODUCT_TYPES, 'code');
        eq(outcome.refusal.category, ERROR_CATEGORIES.CONFLICT, 'category');
        // The press RETHROWS this, so its reply stays the bot surface's own error envelope.
        if (outcome.error !== thrown) throw new Error('the original error was not carried for the press to rethrow');
    });

    await assertAsync('a FAULT (not an AppError) is classified as internal, and still never thrown', async () => {
        const outcome = await placeDealInBasket({ addToCart: async () => { throw new Error('socket hang up'); } }, DEAL);
        if (outcome.placed) throw new Error('a fault reported placed');
        eq(outcome.refusal.code, ERROR_CODES.INTERNAL_SERVER_ERROR, 'code');
        eq(outcome.refusal.category, ERROR_CATEGORIES.INTERNAL, 'category');
    });

    originalConsole.log('\n── 9 · ⭐ What the customer reads — the press\'s line and its three buttons ──');

    for (const language of BOT_COPY_LANGUAGES) {
        assert(`[${language}] with no lead it is EXACTLY the press's reply — same line, same three buttons`, () => {
            const intent = dealInBasketIntent(language);
            if (intent.kind !== 'text') throw new Error(`kind ${intent.kind}`);
            eq(intent.text, botChrome('dealLockedPrompt', language), 'text');
            eq(JSON.stringify(actionIdsOf(intent)), JSON.stringify(addedToCartActions(language).map((a) => a.id)), 'buttons');
        });

        assert(`[${language}] the spoken close leads with the agent's sentence, then the SAME line`, () => {
            const intent = dealInBasketIntent(language, LEAD);
            if (intent.kind !== 'text') throw new Error(`kind ${intent.kind}`);
            eq(intent.text, `${LEAD}\n\n${botChrome('dealLockedPrompt', language)}`, 'text');
            eq(JSON.stringify(actionIdsOf(intent)), JSON.stringify(BASKET_IDS), 'buttons');
        });

        assert(`[${language}] ⭐ on WhatsApp it is ONE interactive message with the three basket buttons, titles ≤ 20`, () => {
            const reply = renderBotReply(dealInBasketIntent(language, LEAD), 'whatsapp', '237600000001');
            const interactive = (reply.body as { interactive?: { type: string; action: { buttons: Array<{ reply: { id: string; title: string } }> } } }).interactive;
            if (!interactive || interactive.type !== 'button') throw new Error('not an interactive button message');
            const buttons = interactive.action.buttons;
            eq(JSON.stringify(buttons.map((b) => b.reply.id)), JSON.stringify(BASKET_IDS), 'button ids');
            for (const b of buttons) {
                if (b.reply.title.length > WA_LIMITS.BUTTON_REPLY_TITLE) {
                    throw new Error(`"${b.reply.title}" is ${b.reply.title.length} characters`);
                }
            }
        });

        assert(`[${language}] ⛔ a REFUSED basket never says "it's in your basket" — it says why not`, () => {
            const refusal = { code: ERROR_CODES.CART_MIXED_PRODUCT_TYPES, category: ERROR_CATEGORIES.CONFLICT };
            const intent = dealRefusedIntent(refusal, language, LEAD);
            if (intent.kind !== 'text') throw new Error(`kind ${intent.kind}`);
            if (intent.text.includes(botChrome('dealLockedPrompt', language))) {
                throw new Error('a refused basket claims the item is in it');
            }
            const why = customerMessageFor(refusal.code, refusal.category, language);
            eq(intent.text, `${LEAD}\n\n${why}`, 'text');
        });
    }

    assert('⛔ a closed deal never carries a Lock it in button — there is nothing left to accept', () => {
        for (const language of BOT_COPY_LANGUAGES) {
            const ids = actionIdsOf(dealInBasketIntent(language, LEAD));
            if (ids.some((id) => id.startsWith('deal:'))) throw new Error(`a deal: token on a closed deal (${language})`);
        }
    });

    assert('⭐ a long agent sentence is trimmed so the basket line SURVIVES WhatsApp\'s 1 024 cut', () => {
        const line = botChrome('dealLockedPrompt', 'fr');
        const composed = composeDealText('x'.repeat(3000), line);
        if (composed.length > DEAL_MESSAGE_BUDGET) throw new Error(`${composed.length} > ${DEAL_MESSAGE_BUDGET}`);
        if (!composed.endsWith(line)) throw new Error('the basket line was cut');
        eq(DEAL_MESSAGE_BUDGET, WA_LIMITS.INTERACTIVE_BODY, 'the budget is WhatsApp\'s interactive body');

        // And the renderer, which cuts from the END, now has nothing to cut.
        const reply = renderBotReply(dealInBasketIntent('fr', 'x'.repeat(3000)), 'whatsapp', '237600000001');
        const body = (reply.body as { interactive: { body: { text: string } } }).interactive.body.text;
        if (!body.endsWith(line)) throw new Error('the rendered body lost the basket line');
    });

    assert('⭐ MUTANT — an untrimmed composition loses the line exactly as the guard says', () => {
        // The naive join the guard replaces: the renderer's own truncate eats the END of it.
        const line = botChrome('dealLockedPrompt', 'fr');
        const naive: BotReplyIntent = { kind: 'text', text: `${'x'.repeat(3000)}\n\n${line}`, actions: addedToCartActions('fr') };
        const reply = renderBotReply(naive, 'whatsapp', '237600000001');
        const body = (reply.body as { interactive: { body: { text: string } } }).interactive.body.text;
        if (body.endsWith(line)) throw new Error('the naive composition kept the line — the guard would be protecting nothing');
    });

    assert('a blank lead is the press\'s message, never a dangling separator', () => {
        eq(composeDealText('   ', 'L'), 'L', 'blank');
        eq(composeDealText(null, 'L'), 'L', 'null');
    });

    assert('Telegram draws the same three buttons as callbacks', () => {
        const reply = renderBotReply(dealInBasketIntent('en', LEAD), 'telegram', '600000001');
        const rows = (reply.body as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data: string }>> } }).reply_markup?.inline_keyboard ?? [];
        const ids = rows.flat().map((b) => b.callback_data);
        eq(JSON.stringify(ids), JSON.stringify(BASKET_IDS), 'callbacks');
    });

    originalConsole.log('\n── 10 · ⭐ A retried close is the close, not a refusal ─────────────────');

    const EXPIRES = new Date('2026-09-07T12:20:00.000Z');
    const closedByModel = (over: Partial<ReplaySessionView> = {}): ReplaySessionView => ({
        status: 'agreed',
        lock: { closedBy: 'model', unitPrice: 6000, expiresAt: EXPIRES, consumedAt: null },
        lastTurn: { agentProposedPrice: 6000, lockRequested: true, reply: LEAD },
        ...over,
    });
    const retry = { agentProposedPrice: 6000, reply: LEAD, lock: true };

    assert('⭐ the SAME closing call, sent again, is a replay', () => {
        eq(isRecordReplay(closedByModel(), retry, NOW), true, 'replay');
    });

    const notReplays: Array<[string, ReplaySessionView, typeof retry, Date]> = [
        ['a different price is a new turn on a closed deal', closedByModel(), { ...retry, agentProposedPrice: 5500 }, NOW],
        ['a different sentence is a new turn — the ledger keeps what the customer was sent', closedByModel(), { ...retry, reply: 'Autre chose' }, NOW],
        ['`lock: false` is not a close at all', closedByModel(), { ...retry, lock: false }, NOW],
        ['an OPEN session has nothing to replay', closedByModel({ status: 'open' }), retry, NOW],
        ['⛔ a deal the customer PRESSED is not the model\'s to replay', closedByModel({ lock: { closedBy: 'button', unitPrice: 6000, expiresAt: EXPIRES, consumedAt: null } }), retry, NOW],
        ['a SPENT lock (an order exists) has nothing left to replay', closedByModel({ lock: { closedBy: 'model', unitPrice: 6000, expiresAt: EXPIRES, consumedAt: NOW } }), retry, NOW],
        ['⭐ a lock expiring EXACTLY now has expired', closedByModel(), retry, EXPIRES],
        ['a last turn that did not ask for the lock is not the closing turn', closedByModel({ lastTurn: { agentProposedPrice: 6000, lockRequested: false, reply: LEAD } }), retry, NOW],
        ['a lock at another price than the turn is not this close', closedByModel({ lock: { closedBy: 'model', unitPrice: 6500, expiresAt: EXPIRES, consumedAt: null } }), retry, NOW],
    ];
    for (const [label, session, attempt, at] of notReplays) {
        assert(label, () => eq(isRecordReplay(session, attempt, at), false, 'replay'));
    }

    assert('the replay rule is pure — no clock, no database, no await', () => {
        const ruleSrc = stripComments(readSrc('modules', 'negotiation', 'domain', 'record-replay.rule.ts'));
        for (const forbidden of ['Date.now(', 'new Date(', 'Model.', 'await ']) {
            if (ruleSrc.includes(forbidden)) throw new Error(`the rule references ${forbidden}`);
        }
    });

    originalConsole.log('\n── 11 · The wiring: both closers reach the ONE core ─────────────────────');

    const serviceSrc = stripComments(readSrc('modules', 'negotiation', 'services', 'negotiation.service.ts'));
    const tapSrc = stripComments(readSrc('modules', 'bot-surface', 'controllers', 'bot-negotiation.controller.ts'));

    /** record() on a fresh close: settle AFTER the committed write, and only on a lock. */
    const recordSettles = (src: string): void => {
        const record = methodBody(src, 'async record(');
        const afterCommit = record.slice(record.indexOf('if (!written) continue;'));
        if (record.indexOf('if (!written) continue;') < 0) throw new Error('record() lost its compare-and-set loop');
        if (!/if \(input\.lock\) \{\s*lock = \{[^}]*\};\s*closed = await this\.settleClosedDeal\(/.test(afterCommit)) {
            throw new Error('a fresh close does not put the item in the basket (settleClosedDeal is not called on the lock)');
        }
    };

    /** settleClosedDeal: the shared core with the production cart, then the closed-deal message. */
    const settleUsesCore = (src: string): void => {
        const body = methodBody(src, 'private async settleClosedDeal(');
        if (!body.includes('placeDealInBasket(CART_DEAL_BASKET,')) throw new Error('the spoken close does not use the shared basket core');
        if (!body.includes('buildClosedDealOutbound(')) throw new Error('the spoken close does not render the closed-deal message');
        // Every field of the basket write comes from the RECORD — a price is never a caller's to name.
        for (const field of ['args.session.product_id', 'args.session.variant_id', 'args.session.quantity', 'args.session.currency']) {
            if (!body.includes(field)) throw new Error(`the basket write does not read ${field}`);
        }
        if (/agentProposedPrice|unitPrice/.test(body)) throw new Error('the basket write is told a price');
    };

    /** The replay is decided BEFORE a price is judged, and answered by the replay path. */
    const replayFirst = (src: string): void => {
        const record = methodBody(src, 'async record(');
        const replayAt = record.indexOf('isRecordReplay(');
        const judgeAt = record.indexOf('judgeProposedPrice(');
        if (replayAt < 0 || judgeAt < 0 || replayAt > judgeAt) throw new Error('the replay check does not run before the judgement');
        if (!/isRecordReplay\([^)]*\), input, now\)\) \{\s*return this\.replayClosingTurn\(/.test(record)) {
            throw new Error('a replay is not answered by replayClosingTurn');
        }
    };

    /** The tap reaches the SAME core and keeps its error envelope. */
    const tapUsesCore = (src: string): void => {
        if (!src.includes('placeDealInBasket(CART_DEAL_BASKET,')) throw new Error('the press does not use the shared basket core');
        if (!/if \(!basket\.placed\) throw basket\.error;/.test(src)) throw new Error('the press swallows a refusal instead of rethrowing it');
        if (!src.includes('setBotReply(req, dealInBasketIntent(language));')) throw new Error('the press renders its own copy of the message');
        if (/\.addToCart\(/.test(src)) throw new Error('the press writes the basket itself — a second implementation');
    };

    /** A statistic can never fail a close the customer already has. */
    const statisticIsBestEffort = (src: string): void => {
        const record = methodBody(src, 'async record(');
        if (!/recordAgreement\(caller\.customerId\)\.catch\(/.test(record)) {
            throw new Error('a failed agreement statistic would fail the gate after the deal is in the basket');
        }
    };

    assert('⭐ record(): a fresh close puts the item in the basket, after the commit', () => recordSettles(serviceSrc));
    assert('⭐ the spoken close uses the shared core, reading every field from the record', () => settleUsesCore(serviceSrc));
    assert('⭐ a retried close is recognised BEFORE a price is judged', () => replayFirst(serviceSrc));
    assert('⭐ the press uses the SAME core and still rethrows a refusal', () => tapUsesCore(tapSrc));
    assert('the agreement statistic is best-effort on a close', () => statisticIsBestEffort(serviceSrc));

    assert('⭐ MUTANT — every wiring scan above bites on the exact fault it names', () => {
        bites('close without basket', serviceSrc,
            serviceSrc.replace('closed = await this.settleClosedDeal(', 'closed = null; void (') , recordSettles);
        bites('spoken close with its own cart', serviceSrc,
            serviceSrc.replace('placeDealInBasket(CART_DEAL_BASKET,', 'someOtherCart.add('), settleUsesCore);
        bites('a caller-named price', serviceSrc,
            serviceSrc.replace('productId: args.session.product_id.toString(),', 'productId: args.session.product_id.toString(), unitPrice: 1,'), settleUsesCore);
        bites('no replay check at all', serviceSrc,
            serviceSrc.replace('if (isRecordReplay(this.replayViewOf(session), input, now)) {', 'if (false) {'), replayFirst);
        bites('a replay judged as a refusal', serviceSrc,
            serviceSrc.replace('return this.replayClosingTurn(', 'return this.revise('), replayFirst);
        bites('the press writing the basket itself', tapSrc,
            tapSrc.replace('if (!basket.placed) throw basket.error;', 'if (!basket.placed) throw basket.error;\n            await cartService.addToCart(caller.customerId);'), tapUsesCore);
        bites('the press swallowing a refusal', tapSrc,
            tapSrc.replace('if (!basket.placed) throw basket.error;', 'if (!basket.placed) return;'), tapUsesCore);
        bites('a fatal statistic', serviceSrc,
            serviceSrc.replace('recordAgreement(caller.customerId).catch(', 'recordAgreement(caller.customerId).then('), statisticIsBestEffort);
    });

    originalConsole.log('\n── 12 · ⛔ The agent is never sent after an address or a phone number ────');

    const closedByAgent = reviseInstruction('session_closed', { status: 'agreed', agreedPrice: 6000, closedBy: 'model' });
    const noAddressHunt = (instruction: string): void => {
        if (/move on to .*delivery|where to deliver|ask .*(address|phone)/i.test(instruction.replace('Never ask for a delivery address or a phone number', ''))) {
            throw new Error(`the instruction sends the agent after delivery details: ${instruction}`);
        }
        if (!instruction.includes('Never ask for a delivery address or a phone number')) {
            throw new Error('the instruction does not forbid asking for the address and number');
        }
        if (!/check out/.test(instruction)) throw new Error('the instruction does not point at checkout');
    };

    assert('⭐ a closed deal tells the agent: in the basket, offer checkout, never ask for address or phone', () => {
        noAddressHunt(closedByAgent);
        if (!closedByAgent.includes('6000')) throw new Error('the agreed price is not named');
    });

    assert('⭐ MUTANT — the instruction this replaced is caught', () => {
        const old = 'The customer has already accepted 6000 for this line. The deal is closed and the item is in their'
            + ' basket at that price. Do not quote a price or reopen it — confirm warmly and move on to quantity,'
            + ' payment and delivery.';
        bites('the old instruction', closedByAgent, old, noAddressHunt);
    });

    await digitalLineSection();
}

/**
 * ⭐ § 13 — A DEAL ON A DIGITAL ITEM ALREADY IN THE BASKET IS HONOURED.
 *
 * The defect: the one-digital-product guard in `CartService.addToCart` refused ANY digital add to
 * a non-empty basket — including the same variant, re-presented with the lock the customer had
 * just won. So a customer who put a course in the basket at 7 500 and haggled it to 6 000 was told
 * "only one digital product at a time" about that very course, by the press and by the spoken close
 * alike, and checkout charged 7 500. (The existing-line branch meant to handle a re-add was
 * unreachable for digital behind that guard.)
 *
 * Driven through the REAL `CartService.addToCart` — only its three collaborators and the cart
 * lookup are stubbed, never the rule — and through the SAME `placeDealInBasket` both closers call,
 * so `placed: true` here means what it means in production.
 */
async function digitalLineSection(): Promise<void> {
    originalConsole.log('\n── 13 · ⭐ A deal on a digital item already in the basket is honoured ───');

    const CUSTOMER = '68b0000000000000000000c1';
    const PRODUCT = '68b0000000000000000000a1';
    const VARIANT = '68b0000000000000000000b1';
    const OTHER_VARIANT = '68b0000000000000000000b2';
    const VENDOR = '68b0000000000000000000d1';
    const REF = 'nlk_00000000000000000000000000000002';

    const line = (variantId: string, over: Record<string, unknown> = {}) => ({
        variantId, sku: 'SKU-1', variantTitle: 'Standard', optionsSnapshot: '', productId: PRODUCT,
        title: 'Cours de couture', vendorId: VENDOR, productType: 'digital', quantity: 1, price: 7500,
        currency: 'XAF', negotiated_unit_price: null, floor_price_snapshot: null, negotiation_lock_ref: null,
        ...over,
    });

    /**
     * The real service with its collaborators replaced. `lockHonoured` stands in for the resolver's
     * verdict on the presented lock: the peek is `negotiation`'s rule and has its own suite; this
     * section is about what the CART does once the lock is honoured.
     */
    async function withCart(
        existing: ReturnType<typeof line>[],
        productType: 'digital' | 'physical',
        run: (svc: CartService, saved: () => number, doc: InstanceType<typeof CartModel>) => Promise<void>,
    ): Promise<void> {
        const doc = new CartModel({ userId: CUSTOMER, productType, items: existing });
        let saves = 0;
        (doc as unknown as { save: () => Promise<unknown> }).save = async () => { saves += 1; return doc; };

        const svc = new CartService();
        const internals = svc as unknown as Record<string, unknown>;
        internals.productRepository = { findByIdUnscoped: async () => ({ id: PRODUCT, type: productType, vendorId: VENDOR, title: 'Cours de couture' }) };
        internals.variantRepository = { findById: async (id: string) => ({ id, productId: PRODUCT, sku: 'SKU-1', optionSignature: '' }) };
        internals.priceResolverService = {
            execute: async (command: { negotiation?: { lockRef: string } }) => command.negotiation
                ? { unitPrice: 6000, total: 6000, negotiated: { lockRef: command.negotiation.lockRef, floorPrice: 5000 } }
                : { unitPrice: 7500, total: 7500 },
        };

        const model = CartModel as unknown as { findOne: unknown };
        const realFindOne = model.findOne;
        model.findOne = async () => doc;
        try {
            await run(svc, () => saves, doc);
        } finally {
            model.findOne = realFindOne;
        }
    }

    await assertAsync('⭐ the SAME digital line + a lock → placed, re-priced to the deal, still ONE line at quantity 1', async () => {
        await withCart([line(VARIANT)], 'digital', async (svc, saved, doc) => {
            const outcome = await placeDealInBasket(
                { addToCart: (d) => svc.addToCart(d.customerId, d.productId, d.variantId, d.quantity, d.currency, d.lockRef) },
                { customerId: CUSTOMER, productId: PRODUCT, variantId: VARIANT, quantity: 1, currency: 'XAF', lockRef: REF },
            );
            if (!outcome.placed) throw new Error(`refused: ${outcome.refusal.code}`);
            eq(doc.items.length, 1, 'lines');
            const item = doc.items[0]!;
            eq(item.quantity, 1, 'quantity');
            eq(item.price, 6000, 'price');
            eq(item.negotiated_unit_price, 6000, 'negotiated_unit_price');
            eq(item.floor_price_snapshot, 5000, 'floor_price_snapshot');
            eq(item.negotiation_lock_ref, REF, 'negotiation_lock_ref');
            eq(saved(), 1, 'saves');
        });
    });

    await assertAsync('the response the customer sees carries the agreed price — and never the floor', async () => {
        await withCart([line(VARIANT)], 'digital', async (svc) => {
            const cart = await svc.addToCart(CUSTOMER, PRODUCT, VARIANT, 1, 'XAF', REF);
            const item = cart.items[0] as unknown as Record<string, unknown>;
            eq(item.price, 6000, 'price');
            eq(item.negotiatedUnitPrice, 6000, 'negotiatedUnitPrice');
            if (JSON.stringify(cart).includes('5000')) throw new Error('the floor reached the customer-facing cart');
        });
    });

    await assertAsync('⛔ WITHOUT a lock the same digital re-add is still refused, exactly as before', async () => {
        await withCart([line(VARIANT)], 'digital', async (svc, saved) => {
            let code: string | null = null;
            try {
                await svc.addToCart(CUSTOMER, PRODUCT, VARIANT, 1, 'XAF');
            } catch (error) {
                code = error instanceof AppError ? error.code : 'not-an-AppError';
            }
            eq(code, ERROR_CODES.CART_DIGITAL_LIMIT_REACHED, 'code');
            eq(saved(), 0, 'saves');
        });
    });

    await assertAsync('⛔ a lock on a DIFFERENT digital item is still refused — one digital product per basket', async () => {
        await withCart([line(OTHER_VARIANT)], 'digital', async (svc, saved) => {
            const outcome = await placeDealInBasket(
                { addToCart: (d) => svc.addToCart(d.customerId, d.productId, d.variantId, d.quantity, d.currency, d.lockRef) },
                { customerId: CUSTOMER, productId: PRODUCT, variantId: VARIANT, quantity: 1, currency: 'XAF', lockRef: REF },
            );
            if (outcome.placed) throw new Error('a second digital product was let in by a lock');
            eq(outcome.refusal.code, ERROR_CODES.CART_DIGITAL_LIMIT_REACHED, 'code');
            eq(saved(), 0, 'saves');
        });
    });

    await assertAsync('a physical line + a lock is unchanged: SET to the lock\'s quantity at the agreed price', async () => {
        await withCart([line(VARIANT, { productType: 'physical', quantity: 3 })], 'physical', async (svc, _saved, doc) => {
            await svc.addToCart(CUSTOMER, PRODUCT, VARIANT, 2, 'XAF', REF);
            eq(doc.items.length, 1, 'lines');
            eq(doc.items[0]!.quantity, 2, 'quantity');
            eq(doc.items[0]!.price, 6000, 'price');
            eq(doc.items[0]!.negotiation_lock_ref, REF, 'lock ref');
        });
    });
}

void main();
