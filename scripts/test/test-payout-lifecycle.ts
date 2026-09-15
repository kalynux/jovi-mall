/**
 * Test: the payout lifecycle, and the guards that stop money being sent twice.
 *
 * ── Why this suite is mostly SOURCE SCANS ────────────────────────────────────
 * Because the invariants here are properties of *call sites and query shapes*, not of
 * functions you can call. "The claim happens before the HTTP call", "the partial index spans
 * every held status", "a retry reuses the stored reference" — none of those can be observed
 * by invoking anything without a replica set and a live gateway. What actually catches a
 * future author moving the gateway call above the claim is reading the file.
 *
 * That crudeness is deliberate and has precedent: `test-tracking-outbox.ts` is the same shape
 * for the same reason, and its header says so.
 *
 * ── What is being protected ──────────────────────────────────────────────────
 * This is the only surface on the platform that sends money OUT, and the failure mode is not
 * "an error" — it is paying an owner twice, silently, with no undo. Every section below maps
 * to one way that could happen.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free, so CI discovers and runs it like every other suite.
 *
 * Run: npx ts-node scripts/test/test-payout-lifecycle.ts   (npm run test:payout-lifecycle)
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    PAYOUT_HELD_STATUSES,
    PAYOUT_REQUEST_STATUSES,
} from '../../src/modules/earnings/models/payout-request.model';
import { mintMerchantRef, merchantRefKind } from '../../src/modules/payments/domain/merchant-reference';
import { directionOfEventType } from '../../src/modules/payments/domain/webhook-verification';

const SRC = join(__dirname, '..', '..', 'src');
const ROOT = join(__dirname, '..', '..');

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    try {
        if (fn()) {
            console.log(`  ✅ ${name}`);
            passed++;
        } else {
            console.error(`  ❌ FAIL: ${name}`);
            failed++;
        }
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
    }
}

function section(title: string): void {
    console.log(`\n  ${title}`);
}

function read(...rel: string[]): string {
    return readFileSync(join(SRC, ...rel), 'utf8');
}

const MODEL = read('modules', 'earnings', 'models', 'payout-request.model.ts');
const REPO = read('modules', 'earnings', 'repositories', 'payout-request.repository.ts');
const SERVICE = read('modules', 'earnings', 'services', 'payout-request.service.ts');
const GATEWAY = read('modules', 'payments', 'gateways', 'notchpay.gateway.ts');
const PROCESSOR = read('modules', 'payments', 'services', 'webhook-processor.service.ts');

console.log('\n════════════════════════════════════════════════════════════');
console.log('  payout lifecycle');
console.log('════════════════════════════════════════════════════════════');

// ─────────────────────────────────────────────────────────────────────────────
section('1. The status set and what is still HOLDING money');

assert('five statuses, and the two new ones are the non-terminal pair', () =>
    PAYOUT_REQUEST_STATUSES.length === 5
    && ['pending', 'processing', 'paid', 'rejected', 'failed'].every((s) =>
        (PAYOUT_REQUEST_STATUSES as readonly string[]).includes(s)));

/**
 * ⛔ The one that matters. `failed` LOOKS finished and is not: a transfer that failed has not
 * returned the money, so the hold survives. Dropping it from this list would let an owner
 * open a second payout request for a balance they have not got back — the platform would then
 * owe it twice.
 */
assert('HELD spans pending, processing AND failed', () =>
    PAYOUT_HELD_STATUSES.length === 3
    && ['pending', 'processing', 'failed'].every((s) =>
        (PAYOUT_HELD_STATUSES as readonly string[]).includes(s)));

assert('no terminal status is treated as held', () =>
    !(PAYOUT_HELD_STATUSES as readonly string[]).includes('paid')
    && !(PAYOUT_HELD_STATUSES as readonly string[]).includes('rejected'));

/**
 * The partial unique index IS this list. They are asserted together because the index is the
 * only race-proof half of the one-request-per-owner rule — the service pre-check is an
 * optimisation, and a duplicate-key error is what actually stops a concurrent second request.
 */
assert('the partial unique index spreads PAYOUT_HELD_STATUSES, not a retyped list', () =>
    MODEL.includes('partialFilterExpression: { status: { $in: [...PAYOUT_HELD_STATUSES] } }'));

assert('...and it is named, so the legacy pending-only index can be dropped by name', () =>
    MODEL.includes("name: 'payout_one_held_per_owner'"));

/**
 * ⛔ Endorsement is a FIELD. Three things key on `status === 'pending'` and all three break if
 * an `endorsed` state is added — most sharply the index above, which would stop covering an
 * endorsed payout and let the owner open a second one.
 */
assert('there is no endorsed STATUS — triage is a field beside the status', () =>
    !(PAYOUT_REQUEST_STATUSES as readonly string[]).includes('endorsed')
    && MODEL.includes('triage: { type: ReviewTriageSchema, default: null }'));

// ─────────────────────────────────────────────────────────────────────────────
section('2. The transitions, and the two that are REFUSED');

/**
 * Reads ONE const declaration, so a later legitimate USE of the name cannot pollute the
 * match. The first version of this scanned the whole file for the name followed by
 * 'processing' before the next semicolon — which found `beginTransfer`, where the status is
 * legitimately set to processing, and failed an assertion about correct code.
 */
function declarationOf(source: string, name: string): string {
    const start = source.indexOf(`const ${name}`);
    if (start === -1) return '';
    return source.slice(start, source.indexOf(';', start));
}

/**
 * Rejecting releases the hold. Doing that while a transfer may still be in flight is how an
 * owner gets paid twice: once by the transfer that was never actually dead, and once out of
 * the balance that came back.
 */
assert('processing is not rejectable — REJECTABLE is pending|failed only', () => {
    const decl = declarationOf(REPO, 'REJECTABLE');
    return decl.includes("'pending'") && decl.includes("'failed'") && !decl.includes("'processing'");
});

/**
 * And a manual mark-paid is refused there too, for the mirror reason: the gateway is about to
 * report on that transfer itself, so recording a payment beside it claims one settlement twice.
 */
assert('processing is not manually settleable either', () => {
    const decl = declarationOf(REPO, 'MANUALLY_SETTLEABLE');
    return decl.includes("'pending'") && decl.includes("'failed'") && !decl.includes("'processing'");
});

assert('the service distinguishes in-flight from already-resolved', () =>
    SERVICE.includes('EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT')
    && SERVICE.includes('private assertResolvable'));

assert('a gateway settlement is guarded on processing, so a redelivery cannot re-settle', () =>
    /settleTransferPaid[\s\S]{0,400}status: 'processing'/.test(REPO));

assert('a transfer failure is guarded on processing too', () =>
    /markTransferFailed[\s\S]{0,400}status: 'processing'/.test(REPO));

// ─────────────────────────────────────────────────────────────────────────────
section('3. The double-send guard');

/**
 * ⛔ THE assertion in this file.
 *
 * The claim must be a compare-and-set that ALSO fixes the merchant reference, and it must
 * happen before anything leaves the process. A caller that sent first and recorded afterwards
 * has already sent twice by the time it discovers the race.
 */
assert('beginTransfer is a CAS narrowed on the sendable statuses', () =>
    /beginTransfer[\s\S]{0,600}status: \{ \$in: \[\.\.\.MANUALLY_SETTLEABLE\] \}/.test(REPO));

/**
 * `$ifNull` is what makes a retry reuse the reference of the attempt it is retrying. Minting a
 * fresh one per attempt would mean a transfer that actually succeeded, and merely failed to
 * report, is sent again under a reference the provider has never seen — and paid twice.
 *
 * It is an aggregation-pipeline update for exactly this reason; a plain `$set` cannot express
 * "keep what is there, else use this".
 */
assert('a retry REUSES the stored reference via $ifNull, never mints a fresh one', () =>
    /transfer_reference: \{ \$ifNull: \['\$transfer_reference', candidateReference\] \}/.test(REPO));

/** A pipeline update bypasses Mongoose timestamps, so `updated_at` has to be set by hand. */
assert('...and the pipeline update sets updated_at itself', () =>
    /beginTransfer[\s\S]{0,600}updated_at: '\$\$NOW'/.test(REPO));

assert('the claim happens BEFORE the gateway call in sendPayout', () => {
    const body = SERVICE.slice(SERVICE.indexOf('async sendPayout('));
    const claim = body.indexOf('this.beginTransfer(');
    const call = body.indexOf('gateway.createPayout!');
    return claim !== -1 && call !== -1 && claim < call;
});

assert('the transfer reference is uniquely indexed, so two payouts cannot claim one transfer', () =>
    MODEL.includes("name: 'payout_transfer_reference'") && MODEL.includes('unique: true'));

assert('payout references are their own merchant-ref kind', () => {
    const ref = mintMerchantRef('po');
    return ref.startsWith('jm_po_') && merchantRefKind(ref) === 'po' && ref.length === 38;
});

// ─────────────────────────────────────────────────────────────────────────────
section('4. Webhook direction — a transfer must never settle an order');

/**
 * The processor falls through to the order orchestrator for anything it cannot place, which is
 * deliberate (an unprefixed legacy reference still finds its way home) and would, without a
 * direction check, hand a `transfer.*` callback to the payment orchestrator.
 */
assert('transfer.* events are payouts', () =>
    directionOfEventType('transfer.complete') === 'payout'
    && directionOfEventType('transfer.failed') === 'payout'
    && directionOfEventType('transfer.created') === 'payout');

assert('payment.* events are collections', () =>
    directionOfEventType('payment.complete') === 'collection'
    && directionOfEventType('payment.failed') === 'collection');

/**
 * ⚠ The default is load-bearing. Every callback this platform has ever received is a
 * collection and many carry no type at all; defaulting the other way would have silently
 * rerouted the entire existing surface on the day this shipped.
 */
assert('an absent or unknown type defaults to collection, never payout', () =>
    directionOfEventType(null) === 'collection'
    && directionOfEventType('') === 'collection'
    && directionOfEventType('something.else') === 'collection');

assert('a payout event terminates in the payout branch — no fall-through', () => {
    const route = PROCESSOR.slice(PROCESSOR.indexOf('private async route('));
    const guard = route.indexOf("event.direction === 'payout'");
    const orchestrator = route.indexOf('this.orchestrator.applyWebhookEvent');
    return guard !== -1 && orchestrator !== -1 && guard < orchestrator
        && route.includes('return this.settlePayout(event);');
});

assert('a po reference arriving on a COLLECTION event is refused, not guessed at', () =>
    PROCESSOR.includes("if (kind === 'po')"));

assert('every gateway stamps a direction — it is required, not optional', () => {
    const shape = read('modules', 'payments', 'domain', 'webhook-verification.ts');
    return shape.includes('direction: WebhookDirection;')
        && !shape.includes('direction?: WebhookDirection');
});

// ─────────────────────────────────────────────────────────────────────────────
section('5. The NotchPay transfer contract');

/**
 * ⛔ The reference fields SWAP meaning between a payment and a transfer, verified against
 * NotchPay's own openapi.yaml — their prose docs contradict each other on this in three places.
 *
 *   Payment object   `reference` = theirs   `merchant_reference` = ours
 *   Transfer object  `id` = theirs (trf_…)  `reference`          = OURS
 *
 * Reading a transfer the payment way yields `merchantRef: null`, so settlement finds no payout
 * and answers unknown_transaction for every callback — silently, after the money moved.
 */
assert('the parser inverts the reference mapping for payouts', () =>
    /direction === 'payout'\s*\?\s*String\(trx\.id \?\? trx\.reference/.test(GATEWAY)
    && /direction === 'payout'\s*\?\s*\(trx\.reference \?\? trx\.merchant_reference/.test(GATEWAY));

/** A transfer is two calls: the beneficiary must exist before it can be named. */
assert('createPayout creates the beneficiary before the transfer', () => {
    const body = GATEWAY.slice(GATEWAY.indexOf('async createPayout('));
    const ben = body.indexOf("'/beneficiaries'");
    const trf = body.indexOf("'/transfers'");
    return ben !== -1 && trf !== -1 && ben < trf;
});

assert('both transfer calls carry X-Grant', () => {
    const body = GATEWAY.slice(GATEWAY.indexOf('async createPayout('));
    return (body.match(/\{ grant: true \}/g) ?? []).length >= 2;
});

assert('the caller reference is sent verbatim, never re-minted inside the gateway', () => {
    const body = GATEWAY.slice(GATEWAY.indexOf('async createPayout('));
    return body.includes('reference: payload.reference') && !body.includes('mintMerchantRef');
});

/**
 * `sent` is NOT settled — NotchPay reports it when a transfer reaches the network and has not
 * yet been accepted by it. Mapping it to SUCCEEDED would mark a payout paid, and release its
 * hold, on money that can still bounce.
 */
assert('sent maps to PENDING and reversed maps to FAILED', () =>
    /sent: 'PENDING'/.test(GATEWAY) && /reversed: 'FAILED'/.test(GATEWAY));

assert('an unknown status still maps to PENDING, never a terminal verdict', () =>
    GATEWAY.includes("return map[key] ?? 'PENDING'"));

assert('a 403 names the IP allowlist, since it is indistinguishable from a missing X-Grant', () =>
    GATEWAY.includes('private payoutBlockedReason')
    && /403[\s\S]{0,600}allowlist/i.test(GATEWAY));

// ─────────────────────────────────────────────────────────────────────────────
section('6. The migration mirrors the model');

/**
 * ⚠ The migration may NOT import the model: `autoIndex` is on, so registering a schema and
 * connecting builds every index it declares — which would make `--dry-run` WRITE. That has
 * happened on this project before. So it holds a literal copy, and this is what stops the copy
 * drifting.
 */
assert('the migration does not import the model', () => {
    const migration = readFileSync(join(ROOT, 'scripts', 'migrate-payout-lifecycle-index.ts'), 'utf8');
    return !migration.includes('payout-request.model') && migration.includes('COLLECTIONS');
});

assert('...and its HELD_STATUSES literal matches the model', () => {
    const migration = readFileSync(join(ROOT, 'scripts', 'migrate-payout-lifecycle-index.ts'), 'utf8');
    const match = migration.match(/const HELD_STATUSES = \[([^\]]*)\]/);
    if (!match) return false;
    const listed = match[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    return listed.length === PAYOUT_HELD_STATUSES.length
        && listed.every((s) => (PAYOUT_HELD_STATUSES as readonly string[]).includes(s));
});

assert('it drops the legacy index by exact name, and only the pending-only shape', () => {
    const migration = readFileSync(join(ROOT, 'scripts', 'migrate-payout-lifecycle-index.ts'), 'utf8');
    return migration.includes("const LEGACY_NAME = 'owner_type_1_owner_id_1'")
        && migration.includes('function isLegacyPendingIndex');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
