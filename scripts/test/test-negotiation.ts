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

function main(): void {
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

    originalConsole.log('\n════════════════════════════════════════════════════════════════════════════');
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('════════════════════════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exitCode = 1;
}

main();
