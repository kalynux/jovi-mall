/**
 * test:inapp-discovery — Stream B round 2: the "Lock it in" press, and (later) the discovery
 * controller's category, similar-items, save-for-later and reviews turns.
 *
 * No database. The press decision is a pure function by construction
 * (`domain/offer-acceptance.rule.ts`), and the part that cannot be reached without Mongo — the
 * compare-and-set that makes two writers safe — is driven through `acceptOffer`'s injected
 * dependencies against an in-memory store that honours the same rule.
 *
 * ── ⭐ WHAT THIS SUITE IS ACTUALLY FOR ───────────────────────────────────────
 * A deal now has TWO closers: the bargaining agent, and the customer pressing the agent's own
 * offer. Everything dangerous here is an interleaving — two writers deciding against a session
 * they have both already read — and an interleaving is invisible to a happy-path test. So every
 * race below is run TWICE: once against the real guard, and once against a store with the guard
 * REMOVED, asserting that the unguarded run produces the specific damage. A test that cannot fail
 * is worth nothing, and the mutant run is what proves this one can.
 *
 * Run: npm run test:inapp-discovery
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
    decideOfferAcceptance,
    OfferSessionView,
    OfferWindowRead,
} from '../../src/modules/negotiation/domain/offer-acceptance.rule';
import { judgeProposedPrice, reviseInstruction } from '../../src/modules/negotiation/domain/negotiation-gate.rule';
import {
    acceptOffer,
    AcceptOfferOutcome,
    LoadedOfferSession,
    OfferAcceptanceDeps,
} from '../../src/modules/negotiation/services/offer-acceptance.service';
import { INegotiationLock } from '../../src/modules/negotiation/models/negotiation-session.model';
import { toBotProductCard } from '../../src/modules/bot-surface/domain/product-card';
import { counterOfferIntent } from '../../src/modules/negotiation/services/offer-outbound.service';
import { downloadActionId } from '../../src/modules/bot-surface/domain/bot-action-id';
import { botChrome } from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import { BotReplyOption, renderBotReply } from '../../src/modules/bot-surface/domain/channel-reply';
import { downloadOptions } from '../../src/modules/bot-surface/controllers/bot-catalog.controller';
import { WA_LIMITS } from '../../src/modules/whatsapp/constants/whatsapp-limits';
import { distinguishingPart } from '../../src/modules/bot-surface/controllers/bot-discovery.controller';

const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
};
let passed = 0;
let failed = 0;

function assert(label: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            passed += 1;
            originalConsole.log(`  ✅ ${label}`);
        })
        .catch((error: unknown) => {
            failed += 1;
            originalConsole.log(`  ❌ FAIL: ${label}`);
            originalConsole.log(`     ${error instanceof Error ? error.message : String(error)}`);
        });
}

function eq<T>(actual: T, expected: T, what: string): void {
    if (actual !== expected) {
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SRC = join(__dirname, '..', '..', 'src');
const MODULE = join(SRC, 'modules', 'negotiation');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8').replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────────────────────
//  Fixtures — the plan's worked example: floor 32 000, ask 45 000, offered 41 000
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-09-20T12:00:00.000Z');
const SESSION = '68b0000000000000000000a1';
const CUSTOMER = '68b0000000000000000000c1';
const VARIANT = '68b0000000000000000000v1';
const PRODUCT = '68b0000000000000000000p1';
const WINDOW: OfferWindowRead = { ok: true, floor: 32000, ask: 45000 };

/** The session as the store holds it, mutable so a race can move it mid-call. */
interface FakeSession {
    status: OfferSessionView['status'];
    round: number;
    currentCounter: number | null;
    offers: Array<{ round: number; agentProposedPrice: number }>;
    expiresAt: Date;
    quantity: number;
    lock: { ref: string; unitPrice: number; expiresAt: Date; consumedAt: Date | null } | null;
}

function openSession(over: Partial<FakeSession> = {}): FakeSession {
    return {
        status: 'open',
        round: 3,
        currentCounter: 41000,
        offers: [
            { round: 1, agentProposedPrice: 45000 },
            { round: 2, agentProposedPrice: 43000 },
            { round: 3, agentProposedPrice: 41000 },
        ],
        // Well inside the 30-minute session life.
        expiresAt: new Date('2026-09-20T12:20:00.000Z'),
        quantity: 2,
        lock: null,
        ...over,
    };
}

function viewOf(session: FakeSession): OfferSessionView {
    return {
        status: session.status,
        round: session.round,
        currentCounter: session.currentCounter,
        offers: session.offers,
        expiresAt: session.expiresAt,
        customerId: CUSTOMER,
        variantId: VARIANT,
        quantity: session.quantity,
        lock: session.lock
            ? {
                  unitPrice: session.lock.unitPrice,
                  expiresAt: session.lock.expiresAt,
                  consumedAt: session.lock.consumedAt,
              }
            : null,
    };
}

interface FakeOptions {
    /**
     * ⭐ **The mutant switch.** `false` removes the compare-and-set — the write lands whatever the
     * session has become since it was read, which is precisely the lost write this design exists to
     * prevent. Every race below is run both ways.
     */
    guard?: boolean;
    /** Fires once, immediately BEFORE the first write — where the other writer lands. */
    interleave?: () => void;
    window?: OfferWindowRead;
    now?: Date;
}

function fakeDeps(session: FakeSession, options: FakeOptions = {}): OfferAcceptanceDeps {
    const guard = options.guard !== false;
    let interleaved = false;
    let minted = 0;

    return {
        async load(sessionId: string, customerId: string): Promise<LoadedOfferSession | null> {
            if (sessionId !== SESSION || customerId !== CUSTOMER) return null;
            return {
                view: viewOf(session),
                productId: PRODUCT,
                variantId: VARIANT,
                currency: 'XAF',
                lockRef: session.lock?.ref ?? null,
            };
        },

        async readWindow(): Promise<OfferWindowRead> {
            return options.window ?? WINDOW;
        },

        async lockIfStillOpen(_sessionId, _customerId, round, lock: INegotiationLock) {
            if (!interleaved && options.interleave) {
                interleaved = true;
                options.interleave();
            }
            if (guard && (session.status !== 'open' || session.round !== round)) return false;
            session.status = 'agreed';
            session.lock = {
                ref: lock.ref,
                unitPrice: lock.unit_price,
                expiresAt: lock.expires_at,
                consumedAt: null,
            };
            return true;
        },

        async markExpiredIfStillOpen(_sessionId, _customerId, round) {
            if (guard && (session.status !== 'open' || session.round !== round)) return;
            session.status = 'expired';
        },

        async recordAgreement() {
            /* the profile counter; irrelevant here */
        },

        now: () => options.now ?? NOW,

        newLockRef: () => {
            minted += 1;
            return `nlk_fake${minted}`;
        },
    };
}

const press = (session: FakeSession, options: FakeOptions = {}, round = 3): Promise<AcceptOfferOutcome> =>
    acceptOffer(fakeDeps(session, options), { customerId: CUSTOMER, sessionId: SESSION, round });

/** The agent's own turn landing: a new counter at the next round. */
function agentCounters(session: FakeSession, price: number): void {
    session.round += 1;
    session.currentCounter = price;
    session.offers.push({ round: session.round, agentProposedPrice: price });
}

/** The other press landing: the deal closed by somebody else's tap. */
function otherPressCloses(session: FakeSession, ref: string, price = 41000): void {
    session.status = 'agreed';
    session.lock = {
        ref,
        unitPrice: price,
        expiresAt: new Date(NOW.getTime() + 20 * 60_000),
        consumedAt: null,
    };
}

async function main(): Promise<void> {
    originalConsole.log('\n══ test:inapp-discovery — Lock it in, and the two writers of one deal ══\n');

    originalConsole.log('── 1 · The press decision ──────────────────────────────────────────────');

    await assert('accepting the standing offer locks it at the price that was shown', () => {
        const decision = decideOfferAcceptance({
            session: viewOf(openSession()),
            pressedRound: 3,
            window: WINDOW,
            now: NOW,
        });
        eq(decision.kind, 'lock_now', 'kind');
        if (decision.kind !== 'lock_now') return;
        eq(decision.unitPrice, 41000, 'unitPrice');
    });

    await assert('⛔ a press on a SUPERSEDED round is refused, never locked at the old price', () => {
        // The customer scrolled up and tapped round 2's button after the agent moved to 41 000.
        const decision = decideOfferAcceptance({
            session: viewOf(openSession()),
            pressedRound: 2,
            window: WINDOW,
            now: NOW,
        });
        eq(decision.kind, 'superseded', 'kind');
        if (decision.kind !== 'superseded') return;
        eq(decision.latestRound, 3, 'latestRound');
        eq(decision.latestPrice, 41000, 'latestPrice');
    });

    await assert('a round this service never offered is unavailable, not a lock', () => {
        for (const round of [0, 4, 99, 1.5, Number.NaN]) {
            const decision = decideOfferAcceptance({
                session: viewOf(openSession()),
                pressedRound: round,
                window: WINDOW,
                now: NOW,
            });
            eq(decision.kind, 'unavailable', `round ${round}`);
        }
    });

    await assert('⛔ the price is re-judged against the LIVE window — a raised floor refuses', () => {
        // The vendor raised the floor to 42 000 after the agent offered 41 000 (D-10).
        const decision = decideOfferAcceptance({
            session: viewOf(openSession()),
            pressedRound: 3,
            window: { ok: true, floor: 42000, ask: 45000 },
            now: NOW,
        });
        eq(decision.kind, 'price_changed', 'kind');
    });

    await assert('a cleared bargaining window is "price changed"; a product off sale is not', () => {
        eq(
            decideOfferAcceptance({
                session: viewOf(openSession()),
                pressedRound: 3,
                window: { ok: false, gone: false },
                now: NOW,
            }).kind,
            'price_changed',
            'window cleared',
        );
        eq(
            decideOfferAcceptance({
                session: viewOf(openSession()),
                pressedRound: 3,
                window: { ok: false, gone: true },
                now: NOW,
            }).kind,
            'unavailable',
            'product gone',
        );
    });

    await assert('a session that lapsed before the press expires it, and says so', () => {
        const decision = decideOfferAcceptance({
            session: viewOf(openSession({ expiresAt: new Date('2026-09-20T11:59:00.000Z') })),
            pressedRound: 3,
            window: WINDOW,
            now: NOW,
        });
        eq(decision.kind, 'expired', 'kind');
        if (decision.kind !== 'expired') return;
        eq(decision.markExpired, true, 'markExpired');
    });

    await assert('a lock already spent by an order reads as ordered, not as expired', () => {
        const session = openSession({ status: 'agreed' });
        session.lock = {
            ref: 'nlk_spent',
            unitPrice: 41000,
            // Both spent AND lapsed: "you already ordered this" is the useful half.
            expiresAt: new Date('2026-09-20T11:00:00.000Z'),
            consumedAt: new Date('2026-09-20T11:30:00.000Z'),
        };
        eq(
            decideOfferAcceptance({ session: viewOf(session), pressedRound: 3, window: WINDOW, now: NOW }).kind,
            'already_ordered',
            'kind',
        );
    });

    await assert('⛔ a ledger that disagrees with itself refuses rather than guessing a price', () => {
        // The round's recorded offer and the current counter are two records of one number.
        const session = openSession({ currentCounter: 39000 });
        eq(
            decideOfferAcceptance({ session: viewOf(session), pressedRound: 3, window: WINDOW, now: NOW }).kind,
            'unavailable',
            'kind',
        );
    });

    originalConsole.log('\n── 2 · ⭐ One lock, one spend — two presses racing ──────────────────────');

    await assert('a double tap mints ONE lock and the second press spends the first', async () => {
        const session = openSession();
        const outcome = await press(session, {
            // The other tap completes entirely between this press's decision and its write.
            interleave: () => otherPressCloses(session, 'nlk_other'),
        });

        eq(outcome.kind, 'locked', 'kind');
        if (outcome.kind !== 'locked') return;
        eq(outcome.lockRef, 'nlk_other', 'lockRef');
        eq(outcome.fresh, false, 'fresh');
        eq(outcome.unitPrice, 41000, 'unitPrice');
        eq(session.lock?.ref, 'nlk_other', 'the stored lock was not replaced');
    });

    await assert('⭐ MUTANT — without the guard the second press OVERWRITES the first lock', async () => {
        const session = openSession();
        const outcome = await press(session, {
            guard: false,
            interleave: () => otherPressCloses(session, 'nlk_other'),
        });

        if (outcome.kind !== 'locked') throw new Error(`expected a lock, got ${outcome.kind}`);
        // THE DAMAGE, stated: the basket that the first press filled holds `nlk_other`, and the
        // session now carries a different handle — so checkout refuses that line as `not_found`.
        if (outcome.lockRef === 'nlk_other') {
            throw new Error('the unguarded write did not overwrite — this test can no longer bite');
        }
        eq(outcome.fresh, true, 'fresh');
        eq(session.lock?.ref, outcome.lockRef, 'the stored lock was replaced by the loser');
    });

    originalConsole.log('\n── 3 · ⭐ The agent and the customer racing ─────────────────────────────');

    await assert('the agent counters first: the press answers "that offer changed" with the new one', async () => {
        const session = openSession();
        const outcome = await press(session, {
            interleave: () => agentCounters(session, 39500),
        });

        eq(outcome.kind, 'superseded', 'kind');
        if (outcome.kind !== 'superseded') return;
        eq(outcome.latestRound, 4, 'latestRound');
        eq(outcome.latestPrice, 39500, 'latestPrice');
        eq(session.lock, null, 'nothing was locked');
    });

    await assert('⭐ MUTANT — without the guard the press locks a price nobody is offering', async () => {
        const session = openSession();
        const outcome = await press(session, {
            guard: false,
            interleave: () => agentCounters(session, 39500),
        });

        // THE DAMAGE: the session is at round 4 offering 39 500, and the press has just locked
        // round 3's 41 000 — the customer pays MORE than the offer standing when they pressed.
        if (outcome.kind !== 'locked') throw new Error(`expected a lock, got ${outcome.kind}`);
        eq(outcome.unitPrice, 41000, 'unitPrice');
        eq(session.round, 4, 'round');
        eq(session.currentCounter, 39500, 'currentCounter');
    });

    await assert('the press wins: the agent is told what was agreed, by whom, and to stop selling', () => {
        /**
         * The other order of the same race. `record` re-reads after losing its compare-and-set and
         * judges again — against a session the press has closed. This is that judgement and the
         * instruction it produces, with the details `NegotiationService.refusalDetails` attaches
         * whenever the session holds a lock.
         */
        const verdict = judgeProposedPrice({
            floor: 32000,
            ask: 45000,
            proposedPrice: 40000,
            previousCounter: 41000,
            sessionStatus: 'agreed',
            sessionExpiresAt: new Date('2026-09-20T12:20:00.000Z'),
            now: NOW,
        });

        if (verdict.approved) throw new Error('a priced turn was approved on a closed deal');
        eq(verdict.refusal, 'session_closed', 'refusal');

        const instruction = reviseInstruction('session_closed', {
            status: 'agreed',
            agreedPrice: 41000,
            closedBy: 'button',
        });

        if (!instruction.includes('41000')) throw new Error('the instruction does not name the agreed price');
        if (!instruction.includes('pressing your offer')) {
            throw new Error('the instruction does not say the customer pressed it');
        }
        if (!/do not quote a price|reopen/i.test(instruction)) {
            throw new Error('the instruction does not forbid reopening the deal');
        }
    });

    await assert('⛔ without the agreed price the instruction is the old dead end', () => {
        // The fallback, proving the sentence above comes from the DETAILS and not from the code
        // happening to be reached — a lock-less closed session still gets the plain refusal.
        const instruction = reviseInstruction('session_closed', { status: 'closed' });
        eq(instruction, 'This negotiation is closed. Do not quote a price on it.', 'instruction');
    });

    originalConsole.log('\n── 4 · The wiring nothing behavioural can see ───────────────────────────');

    const serviceSrc = stripComments(read(MODULE, 'services', 'negotiation.service.ts'));
    const storeSrc = stripComments(read(MODULE, 'repositories', 'negotiation-session.store.ts'));
    const ruleSrc = read(MODULE, 'domain', 'offer-acceptance.rule.ts');

    await assert('the scans found their files (a scan that matches nothing passes everything)', () => {
        if (!serviceSrc.includes('async record(')) throw new Error('record() not found in the service');
        if (!serviceSrc.includes('async context(')) throw new Error('context() not found in the service');
        if (!storeSrc.includes('stillOpenAtRound')) throw new Error('the guard is not in the store');
    });

    /**
     * ⚠ **`test:negotiation` pins only the FIRST `judgeProposedPrice({` call in the service.** That
     * was sound when there was one; the press added a second judgement path, so this asserts the
     * property over EVERY call rather than over whichever one appears first.
     */
    await assert('EVERY judgement in the service reads the live window, never the session snapshot', () => {
        const calls = serviceSrc.split('judgeProposedPrice({').slice(1);
        if (calls.length === 0) throw new Error('no judgeProposedPrice call found');
        for (const call of calls) {
            const args = call.slice(0, call.indexOf('});'));
            if (args.includes('floor_at_open') || args.includes('ask_at_open')) {
                throw new Error('a judgement reads the session snapshot — a vendor price edit becomes exploitable');
            }
            if (!args.includes('window.floor') || !args.includes('window.ask')) {
                throw new Error('a judgement does not read the live window');
            }
        }
    });

    /**
     * ⚠ **These are ASSIGNMENTS, and the pattern has to say so.** The first version of this scan
     * looked for the substring `session.status =` and went red on correct code, because
     * `session.status === 'open'` — a perfectly good READ, which the service does three times —
     * contains it. That is the prefix collision this repository has been bitten by before, and a
     * guard that fails on correct code is worse than no guard: it teaches the next person to
     * weaken it. `=(?!=)` is an assignment and nothing else.
     */
    const UNGUARDED_WRITES: Array<[string, RegExp]> = [
        ['session.status =', /session\.status\s*=(?!=)/],
        ['session.lock =', /session\.lock\s*=(?!=)/],
        ['existing.status =', /existing\.status\s*=(?!=)/],
        ['session.turns.push(', /session\.turns\.push\(/],
    ];

    await assert('⛔ the service never moves a session out of `open` with a bare save()', () => {
        for (const [name, pattern] of UNGUARDED_WRITES) {
            if (pattern.test(serviceSrc)) {
                throw new Error(`\`${name}\` is an unguarded write — it can overwrite a customer's press`);
            }
        }
    });

    await assert('record() re-reads after losing the compare-and-set instead of failing', () => {
        const record = serviceSrc.slice(serviceSrc.indexOf('async record('));
        const body = record.slice(0, record.indexOf('async acceptOffer('));
        if (!body.includes('appendTurnIfStillOpen')) throw new Error('record() does not write through the guard');
        if (!/if \(!written\) continue;/.test(body)) {
            throw new Error('record() does not re-read after a lost write');
        }
        if (!body.includes('refusalDetails(')) {
            throw new Error('record() does not attach the agreed price to a refusal');
        }
    });

    await assert('⭐ all three racing writes use the ONE shared guard', () => {
        const uses = storeSrc.split('stillOpenAtRound(').length - 1;
        // The definition, plus one use in each of the three writes.
        if (uses < 4) throw new Error(`only ${uses - 1} of 3 writes build their filter with the guard`);
        if (/updateOne\(\s*\{/.test(storeSrc)) {
            throw new Error('a write builds its filter inline — it can silently stop checking the round');
        }
    });

    await assert('the press rule stays pure — no clock, no database, no await', () => {
        for (const forbidden of ['Date.now(', 'new Date(', 'Model.', 'await ']) {
            if (ruleSrc.includes(forbidden)) {
                throw new Error(`the rule references ${forbidden} — it must stay testable at a boundary`);
            }
        }
    });

    originalConsole.log('\n── 5 · ⭐ Every scan above, proven to BITE on a mutated copy ────────────');

    /** Run one scan's logic over mutated text and demand it throws. */
    function bites(label: string, mutated: string, check: (src: string) => void): void {
        let threw = false;
        try {
            check(mutated);
        } catch {
            threw = true;
        }
        if (!threw) throw new Error(`${label}: the scan passed a mutant it exists to catch`);
    }

    /**
     * ⚠ **A mutant has to be made in the SPAN the scan is about.** The first version of the
     * snapshot mutant below replaced the first `floor: window.floor` in the file — which is
     * `context()`'s returned payload, not the judgement — so the scan correctly said nothing and
     * the mutant "passed", which reads exactly like a scan that has stopped working. Same root as
     * the collision above: the check and the claim were about different spans. This one mutates
     * inside the judgement call itself.
     */
    function mutateJudgement(src: string): string {
        const at = src.indexOf('judgeProposedPrice({');
        const head = src.slice(0, at);
        const tail = src.slice(at).replace('floor: window.floor', 'floor: session.floor_at_open');
        return head + tail;
    }

    await assert('the guarded-write scans catch the exact faults they name', () => {
        bites('bare save()', serviceSrc.replace('await negotiationSessionStore.markExpiredIfStillOpen', 'existing.status = "expired"; await noop'), (src) => {
            for (const [, pattern] of UNGUARDED_WRITES) {
                if (pattern.test(src)) throw new Error('found');
            }
        });

        // ⚠ And the same scan must NOT fire on the reads it once confused for writes.
        for (const read of ["if (session.status === 'open') {", "session.status === 'agreed' && session.lock"]) {
            for (const [name, pattern] of UNGUARDED_WRITES) {
                if (pattern.test(read)) throw new Error(`${name} fires on a comparison: ${read}`);
            }
        }

        bites('lost write unhandled', serviceSrc.replace('if (!written) continue;', 'if (!written) throw new Error("lost");'), (src) => {
            const record = src.slice(src.indexOf('async record('));
            const body = record.slice(0, record.indexOf('async acceptOffer('));
            if (!/if \(!written\) continue;/.test(body)) throw new Error('found');
        });

        bites('a write dropping the guard', storeSrc.replace('stillOpenAtRound(sessionId, customerId, round),\n            { $set: { lock, status: \'agreed\' } },', 'updateOne-inline'), (src) => {
            const uses = src.split('stillOpenAtRound(').length - 1;
            if (uses < 4) throw new Error('found');
        });

        bites('a snapshot judgement', mutateJudgement(serviceSrc), (src) => {
            for (const call of src.split('judgeProposedPrice({').slice(1)) {
                const args = call.slice(0, call.indexOf('});'));
                if (args.includes('floor_at_open') || !args.includes('window.floor')) throw new Error('found');
            }
        });

        bites('an impure rule', `${ruleSrc}\nconst t = Date.now();`, (src) => {
            for (const forbidden of ['Date.now(', 'new Date(', 'Model.', 'await ']) {
                if (src.includes(forbidden)) throw new Error('found');
            }
        });
    });

    originalConsole.log('\n── 6 · ⛔ The out-of-stock card, which used to offer two buttons that could only fail ──');

    /**
     * ⚠ **The defect this section exists for, stated so it cannot come back quietly.** Until
     * 2026-09-20 `toBotProductCard` considered only the product TYPE, so a sold-out product drew
     * **Buy now** and **Add to cart**; `executePurchase` then re-resolved the affordance, found it
     * disabled, and refused every single tap. The round's own design notes asserted the card
     * "correctly drops them" — it did not, which is why this is pinned by behaviour AND by source.
     */
    const listRow = (over: Record<string, unknown> = {}) =>
        ({
            id: 'aaaaaaaaaaaaaaaaaaaaaaa1',
            slug: 'anc',
            title: 'Headphones',
            type: 'physical',
            category: 'Electronics',
            tags: [],
            price: 20000,
            compareAtPrice: null,
            currency: 'XAF',
            inStock: true,
            image: null,
            rating: null,
            store: { slug: 'techhub', name: 'TechHub', isOpen: true },
            freeDelivery: false,
            updatedAt: '2026-09-20T12:00:00.000Z',
            ...over,
        }) as never;

    await assert('⛔ a SOLD-OUT card drops both buy buttons and offers Similar items + Save', () => {
        const card = toBotProductCard(listRow({ inStock: false }), 'bbbbbbbbbbbbbbbbbbbbbbb1', 'fr');
        eq(card.addToken, null, 'addToken');
        eq(card.buyToken, null, 'buyToken');
        eq(card.variantId, null, 'variantId');
        eq(card.similarToken, 'sim:aaaaaaaaaaaaaaaaaaaaaaa1', 'similarToken');
        eq(card.saveToken, 'save:aaaaaaaaaaaaaaaaaaaaaaa1', 'saveToken');
    });

    await assert('an IN-STOCK card is unchanged — buy buttons, and neither new token', () => {
        const card = toBotProductCard(listRow(), 'bbbbbbbbbbbbbbbbbbbbbbb1', 'fr');
        eq(card.addToken, 'add:aaaaaaaaaaaaaaaaaaaaaaa1:bbbbbbbbbbbbbbbbbbbbbbb1', 'addToken');
        eq(card.similarToken, null, 'similarToken');
        eq(card.saveToken, null, 'saveToken');
    });

    await assert('⛔ a SERVICE gets neither token, in stock or out — its Details link is the booking door', () => {
        for (const inStock of [true, false]) {
            const card = toBotProductCard(listRow({ type: 'service', inStock }), 'bbbbbbbbbbbbbbbbbbbbbbb1', 'fr');
            eq(card.addToken, null, `addToken (inStock ${inStock})`);
            eq(card.similarToken, null, `similarToken (inStock ${inStock})`);
            eq(card.saveToken, null, `saveToken (inStock ${inStock})`);
        }
    });

    await assert('the builder derives BOTH from stock, in source — not by a happy fixture', () => {
        const cardSrc = stripComments(read(SRC, 'modules', 'bot-surface', 'domain', 'product-card.ts'));
        if (!/const buyable = item\.inStock \?/.test(cardSrc)) {
            throw new Error('the buy tokens are not gated on stock');
        }
        if (!/const soldOut = item\.type !== 'service' && !item\.inStock;/.test(cardSrc)) {
            throw new Error('the two new tokens are not gated on (not a service AND out of stock)');
        }
    });

    await assert('⭐ MUTANT — the source scan catches a builder that forgets stock', () => {
        const cardSrc = stripComments(read(SRC, 'modules', 'bot-surface', 'domain', 'product-card.ts'));
        bites('stock forgotten', cardSrc.replace('const buyable = item.inStock ?', 'const buyable = true ?'), (src) => {
            if (!/const buyable = item\.inStock \?/.test(src)) throw new Error('found');
        });
        bites(
            'a service offered the new buttons',
            cardSrc.replace("const soldOut = item.type !== 'service' && !item.inStock;", 'const soldOut = !item.inStock;'),
            (src) => {
                if (!/const soldOut = item\.type !== 'service' && !item\.inStock;/.test(src)) {
                    throw new Error('found');
                }
            },
        );
    });

    originalConsole.log('\n── 7 · ⭐ The counter-offer carries the price ON its button ─────────────');

    /**
     * ⚠ **Without this the "Lock it in" press is unreachable.** The gate returns its approved
     * sentence as a plain string and the bargaining flow sends exactly that — so unless the gate
     * also hands back a channel-ready body, no button is ever drawn and every branch tested above
     * is dead code. This is the half that makes the feature exist for a customer at all.
     */
    const OFFER = {
        sessionId: SESSION,
        round: 3,
        reply: 'Pour vous, 41 000 et on ne bouge plus.',
        unitPrice: 41000,
        currency: 'XAF',
    };

    await assert('the button names the price, in the customer’s own language', () => {
        const intent = counterOfferIntent({ ...OFFER, language: 'fr' });
        if (intent.kind !== 'text' || !intent.actions?.length) throw new Error('no button');
        const button = intent.actions[0];
        eq(button.id, `deal:${SESSION}:3`, 'token');
        eq(button.label, 'Je valide · 41 000 XAF', 'label');
        eq(intent.text, OFFER.reply, 'the approved sentence is sent unchanged');
    });

    await assert('⛔ the WhatsApp short label fits 20 characters at a NINE-DIGIT price', () => {
        for (const language of ['ar', 'fr', 'pt', 'es', 'en']) {
            const intent = counterOfferIntent({ ...OFFER, unitPrice: 999999999, language });
            if (intent.kind !== 'text' || !intent.actions?.length) throw new Error('no button');
            const short = intent.actions[0].shortLabel ?? intent.actions[0].label;
            if (short.length > 20) {
                throw new Error(`"${short}" is ${short.length} chars in ${language} — WhatsApp cuts at 20`);
            }
            if (!short.includes('999')) throw new Error('the price left the button');
        }
    });

    await assert('⛔ the token fits Telegram’s 64-byte callback cap at every realistic round', () => {
        for (const round of [1, 99, 999]) {
            const intent = counterOfferIntent({ ...OFFER, round, language: 'ar' });
            if (intent.kind !== 'text' || !intent.actions?.length) throw new Error('no button');
            const bytes = Buffer.byteLength(intent.actions[0].id, 'utf8');
            if (bytes > 64) throw new Error(`token is ${bytes} bytes at round ${round}`);
        }
    });

    await assert('⛔ a turn that CLOSED the deal carries no button — nothing is left to accept', () => {
        const record = serviceSrc.slice(serviceSrc.indexOf('async record('));
        const body = record.slice(0, record.indexOf('async acceptOffer('));
        if (!/const outbound = input\.lock/.test(body)) {
            throw new Error('a locking turn would be sent with a Lock it in button under it');
        }
        if (!body.includes('outbound,')) throw new Error('the body is built and never returned');
    });

    await assert('⭐ MUTANT — the no-button-on-a-closed-deal scan catches the inversion', () => {
        bites(
            'button on a closed deal',
            serviceSrc.replace('const outbound = input.lock', 'const outbound = false'),
            (src) => {
                const record = src.slice(src.indexOf('async record('));
                const body = record.slice(0, record.indexOf('async acceptOffer('));
                if (!/const outbound = input\.lock/.test(body)) throw new Error('found');
            },
        );
    });


    originalConsole.log('\n── 8 · ⭐ Digital downloads — a bearer URL that must never be pre-fetched ──');

    /**
     * ⛔ **THE DEFECT THIS CLOSED:** a customer could not download a file they had paid for.
     * `digital_create_download_link` is tier `flow_only` — deliberately, because a model holding a
     * bearer URL is a model that can put it in a sentence — and no flow was ever built to call it.
     * Built, mounted, validated, documented, reachable by nobody: failure mode 1.
     *
     * ⛔ **AND THE HAZARD THAT DECIDED THE SHAPE:** the URL is public (the token IS the auth),
     * single-use (read-and-deleted atomically on the first GET, by whoever makes it) and lives 15
     * minutes. Telegram and WhatsApp PRE-FETCH URLs in message TEXT to build a preview, so a pasted
     * link is spent by a robot before the customer taps it — they get a dead link and the log
     * records a successful download. Hence a link BUTTON, which is not pre-fetched.
     */
    const catalogSrc = stripComments(read(SRC, 'modules', 'bot-surface', 'controllers', 'bot-catalog.controller.ts'));
    const downloadSrc = read(SRC, 'modules', 'digital-delivery', 'services', 'download-link.service.ts');

    await assert('the download tap fits Telegram’s callback cap', () => {
        const id = downloadActionId('68b0000000000000000000e1');
        eq(id, 'dl:68b0000000000000000000e1', 'token');
        const bytes = Buffer.byteLength(id, 'utf8');
        if (bytes > 64) throw new Error(`${bytes} bytes`);
    });

    await assert('⛔ the link is handed over as a BUTTON — never inside the message text', () => {
        const handler = catalogSrc.slice(catalogSrc.indexOf('async function handleDownloadTap'));
        const body = handler.slice(0, handler.indexOf('function downloadOrigin'));
        if (!body.includes("kind: 'link'")) {
            throw new Error('the reply is not a link intent — a URL in text is spent by the link preview');
        }
        if (/text:\s*`/.test(body)) {
            throw new Error('the message text is composed with a template literal — the URL may be inside it');
        }
    });

    await assert('⛔ the minted URL never reaches the JSON body either', () => {
        const handler = catalogSrc.slice(catalogSrc.indexOf('async function handleDownloadTap'));
        const body = handler.slice(0, handler.indexOf('function downloadOrigin'));
        const success = body.slice(body.lastIndexOf('sendSuccess(res, {'));
        if (/\burl\b/.test(success.slice(0, success.indexOf('});')))) {
            throw new Error('the download URL is published in the response body, where a model can read it');
        }
    });

    await assert('⛔ HTTPS only — Telegram drops the whole message on any other scheme', () => {
        const origin = catalogSrc.slice(catalogSrc.indexOf('function downloadOrigin'));
        if (!origin.includes("'https:'")) {
            throw new Error('the origin is not restricted to HTTPS');
        }
        if (!origin.includes('process.env.API_PUBLIC_URL')) {
            throw new Error('the origin is not read as a spelled-out env access — test:env cannot see it');
        }
    });

    /**
     * ⭐ **THE DRIFT PIN.** The expiry is stated to the customer IN WORDS, in five languages, with
     * the number baked into each sentence (this copy table has no placeholders, by an earlier
     * decision). So the sentence and the service's TTL are two records of one fact, and nothing
     * would otherwise notice them disagreeing — the customer would simply be told the wrong number.
     */
    await assert('⭐ the "15 minutes" the customer is told IS the service’s TTL', () => {
        const ttl = /15 \* 60 \* 1000/.test(downloadSrc);
        if (!ttl) {
            throw new Error('the service no longer mints a 15-minute link — the five sentences now lie');
        }
        for (const language of ['en', 'fr', 'pt', 'es', 'ar']) {
            const sentence = botChrome('downloadReadyPrompt', language);
            if (!sentence.includes('15')) {
                throw new Error(`the ${language} sentence does not state the 15-minute expiry`);
            }
        }
    });

    await assert('⭐ MUTANT — the drift pin bites when the service changes its TTL', () => {
        bites('ttl moved', downloadSrc.replace('15 * 60 * 1000', '30 * 60 * 1000'), (src) => {
            if (!/15 \* 60 \* 1000/.test(src)) throw new Error('found');
        });
    });

    await assert('every download label fits WhatsApp’s 20-character button title', () => {
        for (const language of ['en', 'fr', 'pt', 'es', 'ar']) {
            const label = botChrome('downloadButton', language);
            if (label.length > 20) throw new Error(`${language}: "${label}" is ${label.length}`);
        }
    });

    await assert('⛔ only a row that can actually be downloaded becomes a button', () => {
        /**
         * ⚠ **The span is the WHOLE method, and the first version of this got it wrong.** Slicing
         * to the first `});` stopped at the `windowForChat({…})` call — several statements before
         * the filter it was meant to inspect — so the scan reported the filter missing from code
         * that has it. The honest boundary is the next method in the file.
         */
        const listing = catalogSrc.slice(catalogSrc.indexOf('static listEntitlements'));
        const body = listing.slice(0, listing.indexOf('static createDownloadLink'));
        if (body.length === 0 || body.length === listing.length) {
            throw new Error('the method boundary moved — this scan is no longer looking at listEntitlements');
        }
        if (!/entitlements\.filter\(\(entitlement\) => entitlement\.canDownload\)/.test(body)) {
            throw new Error('the picker is not filtered on canDownload — it would offer taps that refuse');
        }
        if (!/downloadable\.slice\(0, BOT_CHAT_LIST_MAX\)/.test(body)) {
            throw new Error('the picker is filtered AFTER windowing — a downloadable row can fall out of view');
        }
    });

    await assert('⭐ MUTANT — the canDownload scan catches a picker that offers everything', () => {
        const check = (src: string): void => {
            const listing = src.slice(src.indexOf('static listEntitlements'));
            const body = listing.slice(0, listing.indexOf('static createDownloadLink'));
            if (!/entitlements\.filter\(\(entitlement\) => entitlement\.canDownload\)/.test(body)) {
                throw new Error('found');
            }
        };

        // The plausible mistake: dropping the filter so every owned row becomes a button — which
        // offers taps that can only answer "you have used all the downloads for that item".
        bites(
            'unfiltered picker',
            catalogSrc.replace('entitlements.filter((entitlement) => entitlement.canDownload)', 'entitlements.slice()'),
            check,
        );

        // ⚠ And the scan must still pass on the real file, so the mutant above proves something.
        check(catalogSrc);
    });

    originalConsole.log('\n── 9 · ⛔ Row titles that collide after the channel cuts them ───────────');

    /**
     * ⭐ **THE RULE THIS SECTION ENFORCES, binding for the rest of the round: a row title built
     * from DATA needs a `shortLabel`, and its test case must be French or Arabic, never English.**
     *
     * Two live defects were found this way, both by RENDERING rather than reading, and both
     * invisible in English — which is why every check any of us ran had passed:
     *   · two modules of one course →  "Cours de couture profes…" twice, for PAID content
     *   · two categories           →  "Électroménager et petit…" / "Électroménager et gros …"
     * A customer picks one at random. Below, every case goes through the REAL renderer and asserts
     * on the row titles WhatsApp would actually draw.
     */
    const waRows = (options: readonly BotReplyOption[]): Array<{ title: string; description?: string }> => {
        const body = renderBotReply(
            {
                kind: 'choice',
                text: 'x',
                options,
                listButton: 'Choose',
                sectionTitle: 'Items',
            },
            'whatsapp',
            '237600000000',
        ).body as Record<string, any>;

        const rows = body.interactive?.action?.sections?.[0]?.rows;
        if (!Array.isArray(rows)) throw new Error('the renderer did not draw a list — no rows to check');
        return rows;
    };

    const titlesDistinct = (options: readonly BotReplyOption[]): boolean => {
        const titles = waRows(options).map((row) => row.title);
        return new Set(titles).size === titles.length;
    };

    await assert('⛔ FRENCH — two modules of one course are told apart in the row title', () => {
        const options = downloadOptions([
            { id: '68b0000000000000000000d1', productTitle: 'Cours de couture professionnelle', variantName: 'Module 1' },
            { id: '68b0000000000000000000d2', productTitle: 'Cours de couture professionnelle', variantName: 'Module 2' },
        ]);
        if (!titlesDistinct(options)) {
            throw new Error(`identical rows: ${waRows(options).map((r) => r.title).join(' | ')}`);
        }
        // And the product's full name is still on the row, where there is room for it.
        eq(waRows(options)[0].description, 'Cours de couture professionnelle', 'description');
    });

    await assert('⛔ FRENCH — the last-resort numbering survives the cut when nothing distinguishes', () => {
        // Neither a variant nor a file name: the fallback lands on the product title for both.
        const options = downloadOptions([
            { id: '68b0000000000000000000d1', productTitle: 'Cours de couture professionnelle' },
            { id: '68b0000000000000000000d2', productTitle: 'Cours de couture professionnelle' },
        ]);
        const titles = waRows(options).map((row) => row.title);
        if (new Set(titles).size !== titles.length) throw new Error(`identical rows: ${titles.join(' | ')}`);
        if (!titles[1].endsWith('(2)')) throw new Error(`the number did not survive: "${titles[1]}"`);
        for (const title of titles) {
            if ([...title].length > 24) throw new Error(`"${title}" is ${[...title].length} code points`);
        }
    });

    await assert('⛔ ARABIC — a long shared prefix still yields distinct rows', () => {
        const options = downloadOptions([
            { id: '68b0000000000000000000d1', productTitle: 'دورة الخياطة الاحترافية الكاملة', variantName: 'الوحدة الأولى' },
            { id: '68b0000000000000000000d2', productTitle: 'دورة الخياطة الاحترافية الكاملة', variantName: 'الوحدة الثانية' },
        ]);
        if (!titlesDistinct(options)) {
            throw new Error(`identical rows: ${waRows(options).map((r) => r.title).join(' | ')}`);
        }
    });

    await assert('⛔ FRENCH — colliding categories are trimmed to what differs', () => {
        const names = ['Produits de beauté et soins du visage', 'Produits de beauté et soins du corps'];
        eq(distinguishingPart(names[0], names), 'visage', 'first');
        eq(distinguishingPart(names[1], names), 'corps', 'second');
    });

    /**
     * ⛔ **THE REGRESSION THAT MATTERS, and the reason the first version of this helper was wrong.**
     * It asked whether EVERY sibling shared the opening, so one unrelated category vetoed the
     * trimming for the pair that actually collided — it passed every two-row test and failed in any
     * real shop. Found by backend-d5, by rendering it.
     */
    await assert('⛔ an UNRELATED category no longer vetoes the trimming (the real-shop case)', () => {
        const names = [
            'Produits de beauté et soins du visage',
            'Produits de beauté et soins du corps',
            'Chaussures',
        ];
        eq(distinguishingPart(names[0], names), 'visage', 'first');
        eq(distinguishingPart(names[1], names), 'corps', 'second');
        eq(distinguishingPart(names[2], names), 'Chaussures', 'the unrelated one is untouched');

        const options: BotReplyOption[] = names.map((name) => ({
            id: `cat:${name.length}`,
            label: name,
            shortLabel: distinguishingPart(name, names),
            description: name,
        }));
        if (!titlesDistinct(options)) {
            throw new Error(`identical rows: ${waRows(options).map((r) => r.title).join(' | ')}`);
        }
    });

    await assert('names that do not collide at the cap are left whole', () => {
        const names = ['Chaussures', 'Téléphones'];
        eq(distinguishingPart(names[0], names), 'Chaussures', 'untrimmed');
        eq(distinguishingPart('Chaussures', ['Chaussures']), 'Chaussures', 'a lone name');
    });

    await assert('⚠ a trimmed part is never cut mid-word, and never shrinks to noise', () => {
        // Word-aligned: cutting "électroménager" to "ménager" would read as a different category.
        const names = ['Grand électroménager de cuisine', 'Grand électroménager de salon'];
        for (const name of names) {
            const part = distinguishingPart(name, names);
            if (part.includes('ménager') && !part.includes('électroménager')) {
                throw new Error(`cut mid-word: "${part}"`);
            }
        }
        // A remainder under three characters is not worth the loss of context.
        const pair = ['Téléphones et accessoires A', 'Téléphones et accessoires B'];
        for (const name of pair) {
            eq(distinguishingPart(name, pair), name, 'too short to help — keep the whole name');
        }
    });

    await assert('⭐ MUTANT — dropping the shortLabel brings the collision straight back', () => {
        const options = downloadOptions([
            { id: '68b0000000000000000000d1', productTitle: 'Cours de couture professionnelle', variantName: 'Module 1' },
            { id: '68b0000000000000000000d2', productTitle: 'Cours de couture professionnelle', variantName: 'Module 2' },
        ]).map((option) => ({ id: option.id, label: option.label, description: option.description }));

        if (titlesDistinct(options)) {
            throw new Error('without shortLabel the rows are still distinct — this test cannot bite');
        }
    });

    /**
     * ⚠ **Compared as NUMBERS, not scanned as text.** The first version of this looked for
     * `LIST_ROW_TITLE: 24` in the renderer, where the constant is only ever *used* — it is defined
     * in `whatsapp-limits.ts` — so the guard reported a divergence that did not exist. A scan that
     * names the wrong file is indistinguishable from a real finding, which is the whole hazard.
     */
    await assert('the row-title cap these controllers assume IS WhatsApp’s own', () => {
        eq(WA_LIMITS.LIST_ROW_TITLE, 24, 'the platform cap');

        for (const file of ['bot-discovery.controller.ts', 'bot-catalog.controller.ts']) {
            const src = stripComments(read(SRC, 'modules', 'bot-surface', 'controllers', file));
            const declared = /WA_ROW_TITLE_CAP = (\d+)/.exec(src);
            if (!declared) throw new Error(`${file} no longer declares the cap it disambiguates against`);
            eq(Number(declared[1]), WA_LIMITS.LIST_ROW_TITLE, `${file} cap`);
        }
    });
    originalConsole.log('\n════════════════════════════════════════════════════════════════════════════');
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('════════════════════════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exitCode = 1;
}

void main();
