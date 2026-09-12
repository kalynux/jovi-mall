/**
 * test:negotiation-lock — Stream A's half of the negotiated-price port (plan D-11).
 *
 * No database. The verdict is a pure function by construction
 * (`domain/lock-verdict.rule.ts`), and everything that cannot be reached without
 * Mongo — the compare-and-set burn, the boot registration, the lifecycle call —
 * is a source scan.
 *
 * Run: npm run test:negotiation-lock
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
    judgeLock,
    LockJudgement,
    LockWindow,
} from '../../src/modules/negotiation/domain/lock-verdict.rule';
import { LockVerdict } from '../../src/modules/catalog/domain/ports/negotiated-price.port';

const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
};
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

function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SRC = join(__dirname, '..', '..', 'src');
const MODULE = join(SRC, 'modules', 'negotiation');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

/** Refusal reason, or `'ok'`. Collapses the union so a test reads as one line. */
function reasonOf(verdict: LockVerdict): string {
    return verdict.ok ? 'ok' : verdict.reason;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-09-08T12:00:00.000Z');
/** Inside the 20-minute lock TTL. */
const LOCK_EXPIRY = new Date('2026-09-08T12:15:00.000Z');

const CUSTOMER = '68b0000000000000000000c1';
const VARIANT = '68b0000000000000000000v1';

/**
 * The plan's worked example: floor 32 000, ask 45 000, agreed at 41 000, qty 2.
 * `floor_snapshot` on the lock is deliberately DIFFERENT from the live floor in
 * the default fixture, so any test that accidentally returns the stored one
 * instead of the live one fails loudly rather than coincidentally passing.
 */
function judgement(over: {
    lock?: Partial<LockJudgement['lock']>;
    binding?: Partial<LockJudgement['binding']>;
    presented?: Partial<LockJudgement['presented']>;
    window?: LockWindow | null;
    now?: Date;
} = {}): LockVerdict {
    return judgeLock({
        lock: { unit_price: 41000, expires_at: LOCK_EXPIRY, consumed_at: null, ...over.lock },
        binding: { customerId: CUSTOMER, variantId: VARIANT, quantity: 2, ...over.binding },
        presented: { customerId: CUSTOMER, variantId: VARIANT, quantity: 2, ...over.presented },
        window: over.window === undefined ? { floor: 32000, ask: 45000 } : over.window,
        now: over.now ?? NOW,
    });
}

async function main(): Promise<void> {
    originalConsole.log('\n══ test:negotiation-lock — the price lock verdict (Stream A) ══\n');

    originalConsole.log('── 1 · The happy path ──────────────────────────────────────────────────');

    assert('a lock inside its window, its TTL and its binding is honoured', () => {
        const verdict = judgement();
        eq(reasonOf(verdict), 'ok', 'verdict');
        if (!verdict.ok) return;
        eq(verdict.unitPrice, 41000, 'unitPrice');
    });

    assert('the customer is charged the AGREED price, never the shelf price', () => {
        // The ask is 45 000. Honouring a lock must not quietly re-quote it.
        const verdict = judgement();
        if (!verdict.ok) throw new Error('expected ok');
        if (verdict.unitPrice === 45000) throw new Error('the lock was re-quoted at the ask');
        eq(verdict.unitPrice, 41000, 'unitPrice');
    });

    assert('a price exactly AT the floor is honoured (the agent conceded the whole window)', () => {
        eq(reasonOf(judgement({ lock: { unit_price: 32000 } })), 'ok', 'verdict');
    });

    assert('a price exactly AT the ask is honoured (a haggle that moved nothing)', () => {
        eq(reasonOf(judgement({ lock: { unit_price: 45000 } })), 'ok', 'verdict');
    });

    assert('a degenerate window (floor === ask) admits exactly that price', () => {
        eq(
            reasonOf(judgement({ lock: { unit_price: 32000 }, window: { floor: 32000, ask: 32000 } })),
            'ok',
            'verdict',
        );
    });

    originalConsole.log('\n── 2 · The binding — (customer, variant, quantity) ─────────────────────');

    assert('⭐ another customer\'s lock is NOT_FOUND, never a distinct refusal', () => {
        // Confirming that a guessed handle is real — merely somebody else's — is a
        // disclosure. A lock is a bearer credential for a price; the house rule at
        // `NegotiationService.record` says a wrong id is a 404, never a 403.
        const verdict = judgement({ presented: { customerId: '68b0000000000000000000c2' } });
        eq(reasonOf(verdict), 'not_found', 'verdict');
    });

    assert('a wrong customer is not reported as `mismatch` (that would confirm it exists)', () => {
        const verdict = judgement({ presented: { customerId: '68b0000000000000000000c2' } });
        if (reasonOf(verdict) === 'mismatch') {
            throw new Error('a cross-customer probe is being told the lock is real');
        }
    });

    assert('a lock presented for a different variant is `mismatch`', () => {
        eq(
            reasonOf(judgement({ presented: { variantId: '68b0000000000000000000v2' } })),
            'mismatch',
            'verdict',
        );
    });

    assert('a lock presented for a different quantity is `mismatch`', () => {
        eq(reasonOf(judgement({ presented: { quantity: 3 } })), 'mismatch', 'verdict');
    });

    assert('⭐ the binding is judged BEFORE expiry — the wrong line is the useful truth', () => {
        // Reporting `expired` here would send the bot off to re-negotiate the
        // wrong item. It is not for that line whether or not it has lapsed.
        const verdict = judgement({
            presented: { variantId: '68b0000000000000000000v2' },
            now: new Date('2026-09-08T13:00:00.000Z'),
        });
        eq(reasonOf(verdict), 'mismatch', 'verdict');
    });

    assert('the binding is judged before the WINDOW too', () => {
        const verdict = judgement({ presented: { quantity: 9 }, window: null });
        eq(reasonOf(verdict), 'mismatch', 'verdict');
    });

    originalConsole.log('\n── 3 · State — spent and lapsed ────────────────────────────────────────');

    assert('a consumed lock is refused', () => {
        eq(
            reasonOf(judgement({ lock: { consumed_at: new Date('2026-09-08T12:05:00.000Z') } })),
            'consumed',
            'verdict',
        );
    });

    assert('⭐ consumed is reported BEFORE expired when a lock is both', () => {
        // `consumed` means an order exists and the customer is probably reading a
        // stale chat message. `expired` invites a re-negotiation that would
        // duplicate a purchase they have already made.
        const verdict = judgement({
            lock: { consumed_at: new Date('2026-09-08T12:05:00.000Z') },
            now: new Date('2026-09-08T13:00:00.000Z'),
        });
        eq(reasonOf(verdict), 'consumed', 'verdict');
    });

    assert('a lapsed lock is `expired`', () => {
        eq(reasonOf(judgement({ now: new Date('2026-09-08T12:15:01.000Z') })), 'expired', 'verdict');
    });

    assert('the expiry boundary is EXCLUSIVE — the instant itself is outside', () => {
        eq(reasonOf(judgement({ now: LOCK_EXPIRY })), 'expired', 'verdict');
    });

    assert('one millisecond before expiry is still honoured', () => {
        eq(
            reasonOf(judgement({ now: new Date(LOCK_EXPIRY.getTime() - 1) })),
            'ok',
            'verdict',
        );
    });

    assert('⭐ the rule takes NO session status or session expiry — only the lock\'s', () => {
        // The two TTLs differ and mean different things: the session is how long a
        // haggle stays resumable, the lock is how long the agreed price stays
        // spendable. A session marked `expired` around a live lock must still be
        // honoured, and the rule cannot get that wrong because it is never told.
        const src = stripComments(read(MODULE, 'domain', 'lock-verdict.rule.ts'));
        // Nothing session-shaped reaches the rule at all — not a status, not an
        // expiry, not the document. It cannot judge on the wrong clock because it
        // is never handed one.
        if (/session/i.test(src)) {
            throw new Error('the lock verdict is given session state — expiry must be the LOCK\'s alone');
        }
        if (!src.includes('lock.expires_at')) throw new Error('the lock TTL is not being judged at all');
    });

    originalConsole.log('\n── 4 · D-10 — the window as it stands NOW ──────────────────────────────');

    assert('a vendor raising the floor past the agreed price strands the lock', () => {
        // The failure D-10 knowingly accepts: the customer did nothing wrong and is
        // refused anyway, so a vendor is never paid below their current floor.
        eq(reasonOf(judgement({ window: { floor: 42000, ask: 45000 } })), 'window_moved', 'verdict');
    });

    assert('the floor boundary is INCLUSIVE — a price exactly at the new floor survives', () => {
        eq(reasonOf(judgement({ window: { floor: 41000, ask: 45000 } })), 'ok', 'verdict');
    });

    assert('a vendor dropping the ask below the agreed price also refuses', () => {
        eq(reasonOf(judgement({ window: { floor: 32000, ask: 40000 } })), 'window_moved', 'verdict');
    });

    assert('⭐ a CLEARED window refuses, and that is customer-favourable', () => {
        // Under D-1 a bargainable variant is shelved at its ASK, so clearing the
        // window drops the displayed price to `variant.price` — the floor.
        // Honouring 41 000 against a shelf now reading 32 000 would charge more
        // than the storefront advertises.
        eq(reasonOf(judgement({ window: null })), 'window_moved', 'verdict');
    });

    assert('a stranded lock is `window_moved`, never a generic refusal', () => {
        // D-10's second obligation: the chat has to be able to say "the seller just
        // changed this price" and reopen the negotiation. `not_found` or `expired`
        // here would dead-end a customer on something untrue.
        for (const window of [
            { floor: 42000, ask: 45000 },
            { floor: 32000, ask: 40000 },
            null,
        ] as Array<LockWindow | null>) {
            eq(reasonOf(judgement({ window })), 'window_moved', `window ${JSON.stringify(window)}`);
        }
    });

    originalConsole.log('\n── 5 · floorSnapshot — the number the earnings split spends ────────────');

    assert('⭐ floorSnapshot is the LIVE floor, not the lock\'s agreement-time snapshot', () => {
        // The port: "the vendor's floor as of THIS verdict, and it is the number
        // the earnings split must use." Returning the agreement-time basis would
        // under-report a floor the vendor has since raised, and the AI margin would
        // take 30% of an uplift measured against a floor no longer in force.
        const verdict = judgement({ window: { floor: 35000, ask: 45000 } });
        if (!verdict.ok) throw new Error(`expected ok, got ${reasonOf(verdict)}`);
        eq(verdict.floorSnapshot, 35000, 'floorSnapshot');
    });

    assert('the resolver never reads `floor_snapshot` off the stored lock', () => {
        // The field stays on the session as the audit record of the agreement-time
        // window. Reading it into a verdict is the mistake the test above catches
        // numerically; this catches it structurally.
        const src = stripComments(read(MODULE, 'services', 'negotiated-price.resolver.ts'));
        if (src.includes('floor_snapshot')) {
            throw new Error('the resolver reads lock.floor_snapshot — floorSnapshot must be the LIVE floor');
        }
    });

    assert('the pure rule is not even GIVEN the stored floor snapshot', () => {
        const src = stripComments(read(MODULE, 'domain', 'lock-verdict.rule.ts'));
        if (src.includes('floor_snapshot')) {
            throw new Error('StoredLock carries floor_snapshot — the rule must not be able to return it');
        }
    });

    assert('⭐ an honoured verdict always satisfies unitPrice >= floorSnapshot', () => {
        // The invariant EarningsSplitService relies on (`vendorGross >= floor x qty`).
        // It holds by construction because the floor check precedes the return, and
        // this asserts the construction rather than trusting it.
        for (let floor = 30000; floor <= 45000; floor += 500) {
            for (let price = 30000; price <= 46000; price += 500) {
                const verdict = judgement({
                    lock: { unit_price: price },
                    window: { floor, ask: 45000 },
                });
                if (verdict.ok && verdict.unitPrice < verdict.floorSnapshot) {
                    throw new Error(
                        `honoured a line below the live floor: price ${price} < floor ${verdict.floorSnapshot}`,
                    );
                }
            }
        }
    });

    assert('every verdict is either ok or one of the five closed reasons', () => {
        const allowed = new Set(['ok', 'not_found', 'expired', 'consumed', 'mismatch', 'window_moved']);
        const probes: Array<Parameters<typeof judgement>[0]> = [
            {},
            { presented: { customerId: 'other' } },
            { presented: { variantId: 'other' } },
            { presented: { quantity: 7 } },
            { lock: { consumed_at: NOW } },
            { now: new Date('2026-09-09T00:00:00.000Z') },
            { window: null },
            { window: { floor: 44000, ask: 45000 } },
            { window: { floor: 1, ask: 2 } },
        ];
        for (const probe of probes) {
            const reason = reasonOf(judgement(probe));
            if (!allowed.has(reason)) throw new Error(`unknown reason ${reason}`);
        }
    });

    originalConsole.log('\n── 6 · The rule stays pure ─────────────────────────────────────────────');

    assert('the verdict rule reads no clock and no database of its own', () => {
        const src = stripComments(read(MODULE, 'domain', 'lock-verdict.rule.ts'));
        for (const forbidden of ['Date.now(', 'new Date(', 'Model.', 'await ', 'async ']) {
            if (src.includes(forbidden)) {
                throw new Error(`the lock rule references ${forbidden} — it must stay testable at a boundary`);
            }
        }
    });

    assert('the verdict TYPE is catalog\'s, imported rather than re-declared', () => {
        // Two declarations of `LockVerdict` is how the two sides come to disagree
        // about what the closed reason set contains.
        const src = read(MODULE, 'domain', 'lock-verdict.rule.ts');
        if (!/import[\s\S]{0,200}LockVerdict[\s\S]{0,200}negotiated-price\.port/.test(src)) {
            throw new Error('LockVerdict is not imported from the catalog port');
        }
    });

    originalConsole.log('\n── 7 · The resolver and the boot wiring ────────────────────────────────');

    const resolverSrc = read(MODULE, 'services', 'negotiated-price.resolver.ts');

    assert('⭐ a refusal is a RETURNED verdict — the resolver never throws', () => {
        // Throwing bypasses catalog's mapping onto the five client-safe
        // NEGOTIATION_LOCK_* codes, and the chat gets a 500 it cannot explain.
        const src = stripComments(resolverSrc);
        if (/\bthrow\b/.test(src)) {
            throw new Error('the resolver throws — a refusal must be a verdict catalog can map');
        }
    });

    assert('⭐ the burn is a COMPARE-AND-SET on consumed_at, not a read-then-save', () => {
        // Two checkouts racing for one lock is exactly what a single-use credential
        // exists to lose. An unguarded save lets both win.
        const src = stripComments(resolverSrc);
        if (!src.includes("'lock.consumed_at': null")) {
            throw new Error('the consume filter does not guard on an unspent lock');
        }
        if (!src.includes('matchedCount === 0')) {
            throw new Error('the resolver does not check whether it actually won the burn');
        }
    });

    assert('consume runs its read AND its burn on the passed transaction', () => {
        const src = stripComments(resolverSrc);
        const consume = src.slice(src.indexOf('async consume('));
        if (!consume.includes('{ session }')) {
            throw new Error('the burn is not written on the order transaction — a rollback would not release it');
        }
        // The judge is handed the session too, so the window it judged and the row
        // it burns are one snapshot.
        if (!consume.includes('this.judge(lockRef, context, session)')) {
            throw new Error('consume judges outside its own transaction');
        }
    });

    assert('peek writes nothing (D-12 — the lock is spent LATE)', () => {
        const src = stripComments(resolverSrc);
        const peek = src.slice(src.indexOf('async peek('), src.indexOf('async consume('));
        for (const forbidden of ['updateOne', 'save(', 'deleteOne', '$set']) {
            if (peek.includes(forbidden)) {
                throw new Error(`peek performs a write (${forbidden}) — add-to-cart must not burn a lock`);
            }
        }
    });

    assert('⭐ the bootstrap registers the resolver on catalog\'s port', () => {
        const src = stripComments(read(MODULE, 'negotiation.bootstrap.ts'));
        if (!src.includes('setNegotiatedPriceResolver(')) {
            throw new Error('negotiation.bootstrap.ts does not register a resolver');
        }
    });

    assert('⭐ lifecycle.ts CALLS the bootstrap — the defect this suite exists for', () => {
        // Until 2026-09-08 nothing anywhere called `setNegotiatedPriceResolver`, so
        // the port's refusing default answered every haggled add-to-cart with a 500.
        // This is the one assertion that would have caught it.
        const src = stripComments(read(SRC, 'lifecycle.ts'));
        if (!src.includes('initializeNegotiationDomain()')) {
            throw new Error(
                'lifecycle.ts does not call initializeNegotiationDomain() — every presented lock will be REFUSED',
            );
        }
    });

    assert('the bootstrap is imported by PATH, not through a module barrel', () => {
        // A barrel is how the negotiation <-> catalog require cycle the port exists
        // to prevent would come back in through the side door.
        const src = read(SRC, 'lifecycle.ts');
        if (!src.includes("from './modules/negotiation/negotiation.bootstrap'")) {
            throw new Error('the negotiation bootstrap is not imported by direct path');
        }
    });

    assert('⭐ the registration RESOLVES — no require cycle, and the port is claimed', () => {
        // The scans above prove the call is written; this proves it works. Importing
        // the bootstrap pulls negotiation -> catalog (the port, the catalogue
        // repositories, the bargain rule), which is the exact direction that once
        // crashed this service with "AuthService is not a constructor". A cycle
        // shows up here as an undefined import, not as a boot that quietly leaves
        // the refusing default in place.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { initializeNegotiationDomain } = require('../../src/modules/negotiation/negotiation.bootstrap');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const port = require('../../src/modules/catalog/domain/ports/negotiated-price.port');

        eq(port.getNegotiatedPriceResolver().name, 'unregistered', 'default before boot');

        initializeNegotiationDomain();

        const resolver = port.getNegotiatedPriceResolver();
        eq(resolver.name, 'negotiation', 'resolver after boot');
        eq(typeof resolver.peek, 'function', 'peek');
        eq(typeof resolver.consume, 'function', 'consume');

        port.resetNegotiatedPriceResolver();
    });

    originalConsole.log('\n── 8 · One definition of the live window ───────────────────────────────');

    assert('⭐ the gate and the resolver read the SAME window reader', () => {
        // D-10's re-read and the gate's per-turn read must agree down to the
        // isBargainEffective gate: a variant the dashboard calls non-negotiable
        // cannot be negotiated, and must not be honoured at a negotiated price.
        const gate = stripComments(read(MODULE, 'services', 'negotiation.service.ts'));
        const resolver = stripComments(resolverSrc);
        if (!gate.includes('liveWindowReader.read(')) {
            throw new Error('the gate no longer reads through the shared window reader');
        }
        if (!resolver.includes('liveWindowReader.read(')) {
            throw new Error('the resolver derives its own window — that is the drift the reader prevents');
        }
    });

    assert('neither caller re-derives `isBargainEffective` for itself', () => {
        for (const file of [
            join(MODULE, 'services', 'negotiation.service.ts'),
            join(MODULE, 'services', 'negotiated-price.resolver.ts'),
        ]) {
            if (stripComments(readFileSync(file, 'utf8')).includes('isBargainEffective')) {
                throw new Error(`${file} re-derives the window gate — it belongs to LiveWindowReader alone`);
            }
        }
    });

    assert('the reader reports a MISS and never maps it to an HTTP code', () => {
        // The two callers owe their callers different answers for the same absence:
        // catalogue codes at the tool door, `window_moved` at the checkout.
        const src = stripComments(read(MODULE, 'services', 'live-window.reader.ts'));
        for (const forbidden of ['createAppError', 'ERROR_CODES', 'window_moved']) {
            if (src.includes(forbidden)) {
                throw new Error(`the window reader references ${forbidden} — mapping belongs to each caller`);
            }
        }
    });

    assert('the reader takes an optional session, so consume reads one snapshot', () => {
        const src = stripComments(read(MODULE, 'services', 'live-window.reader.ts'));
        if (!src.includes('ClientSession')) {
            throw new Error('the window reader cannot join a transaction — consume would check outside its burn');
        }
    });

    originalConsole.log(
        `\n${'═'.repeat(76)}\n  ${passed} passed, ${failed} failed\n${'═'.repeat(76)}\n`,
    );
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    originalConsole.error(err);
    process.exit(1);
});
