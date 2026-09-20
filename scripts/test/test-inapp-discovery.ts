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

    originalConsole.log('\n════════════════════════════════════════════════════════════════════════════');
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('════════════════════════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exitCode = 1;
}

void main();
