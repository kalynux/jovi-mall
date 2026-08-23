/**
 * Test: the customer's view of a parcel — who is delivering it, who is carrying it,
 * and the schema rule that stops a saved address bricking the document holding it.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── Why two unrelated-looking subjects share one file ────────────────────────
 *
 * They arrived together, from one frontend request
 * (`api-doc/customer/BACKEND-REQUIREMENTS-order-detail.md`), and they are the same KIND of
 * thing: rules whose violation is invisible from every other angle.
 *
 *  - **ADR-A06's disclosure window** is a privacy boundary rendered as a boolean table. Widen
 *    it by one status and every response still parses, every screen still renders, and a
 *    worker's name reaches people it was decided must not have it. No behavioural test
 *    anywhere else would notice.
 *  - **The null-`location` rule** is structural. Reintroduce `default: null` on any of the
 *    three models and nothing fails until a customer with a geocoded address tries to add a
 *    second one — at which point EVERY write to that document is refused, including the ones
 *    that have nothing to do with addresses. That is exactly how it shipped.
 *
 * Both are therefore SOURCE SCANS in part, and unapologetically so.
 *
 * Run: npm run test:customer-order-detail
 */
import fs from 'fs';
import path from 'path';
import {
    AGENT_IDENTITY_VISIBLE_FROM,
    agentIdentityVisibleAt,
    toAgentDisplayName,
    toCustomerShipmentDto,
    toCustomerShipmentStatus,
} from '../../src/modules/orders/dto/customer-shipment.dto';
import { IShipment, ShipmentStatus } from '../../src/modules/shipments/shipment.model';

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

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * The same file with comments removed. Every "does this file do X" assertion must read
 * CODE, not prose — these files document at length the rule they used to break, so a naive
 * substring scan finds the tombstone and passes (or fails) on the wrong evidence.
 */
const readCode = (rel: string): string =>
    read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every member of the shipment enum, so a twelfth cannot slip past the tables below. */
const ALL_STATUSES: ShipmentStatus[] = [
    'pending',
    'assigned',
    'pending_agency_reassignment',
    'rejected',
    'picked_up',
    'in_transit',
    'handing_over',
    'agent_delivered',
    'delivered',
    'failed',
    'returned',
];

const shipmentAt = (status: ShipmentStatus): IShipment =>
    ({
        _id: '507f1f77bcf86cd799439100',
        status,
        tracking_number: 'ACR-260823-101010-K7Q2M',
        items: [],
        status_history: [],
        delivery_failures: [],
    }) as unknown as IShipment;

// ─── 1 · The ADR-A06 disclosure window ───────────────────────────────────────

console.log('\n── ADR-A06: when the carrying agent is disclosed ──');

/**
 * The whole decision table, written out rather than derived, so that changing the source
 * table has to be a deliberate edit HERE too. A derived expectation would agree with any
 * table, which is the one thing this must not do.
 */
const EXPECTED_VISIBILITY: Record<ShipmentStatus, boolean> = {
    pending: false,
    assigned: false,
    pending_agency_reassignment: false,
    rejected: false,
    picked_up: true,
    in_transit: true,
    handing_over: true,
    agent_delivered: true,
    failed: true,
    delivered: false,
    returned: false,
};

for (const status of ALL_STATUSES) {
    assert(`${status.padEnd(28)} → agent ${EXPECTED_VISIBILITY[status] ? 'VISIBLE' : 'hidden '}`, () =>
        agentIdentityVisibleAt(status) === EXPECTED_VISIBILITY[status]);
}

assert('the visibility table is TOTAL — a new status cannot inherit a default', () => {
    const table = readCode('modules/orders/dto/customer-shipment.dto.ts');
    const block = table.slice(table.indexOf('AGENT_IDENTITY_VISIBLE'));
    // Substring rather than a built RegExp: the keys are literals, and `escapeRegex`
    // exists for user input rather than for dressing up a fixed string.
    return ALL_STATUSES.every((s) => block.includes(`${s}:`));
});

assert('`delivered` REVOKES the disclosure — it is not merely terminal', () =>
    agentIdentityVisibleAt('delivered') === false && agentIdentityVisibleAt('agent_delivered') === true);

assert('`failed` KEEPS it (not terminal — the same agent is coming back)', () =>
    agentIdentityVisibleAt('failed') === true);

assert('`returned` closes it, though it shares a customer word with `failed`', () =>
    agentIdentityVisibleAt('returned') === false &&
    toCustomerShipmentStatus('failed') === toCustomerShipmentStatus('returned'));

/**
 * ADR-A06 D-2. The request asked for `out_for_delivery` meaning "the parcel is out"; here
 * that word maps from `agent_delivered`, i.e. the handover has ALREADY been reported. If
 * this assertion ever fails because someone "corrected" the constant to match the request,
 * the feature silently becomes a courier card that appears after the courier left.
 */
assert('the window opens at `shipped`, NOT at the word `out_for_delivery`', () =>
    AGENT_IDENTITY_VISIBLE_FROM === 'shipped' &&
    toCustomerShipmentStatus('agent_delivered') === 'out_for_delivery' &&
    toCustomerShipmentStatus('picked_up') === 'shipped' &&
    agentIdentityVisibleAt('picked_up') === true);

// ─── 2 · The name is reduced, never passed through ───────────────────────────

console.log('\n── ADR-A06: the partial name ──');

assert('"Jean Pierre Talla" → "Jean T."', () => toAgentDisplayName('Jean Pierre Talla') === 'Jean T.');
assert('"Jean Pierre" → "Jean P."', () => toAgentDisplayName('Jean Pierre') === 'Jean P.');
assert('a single-token name is returned whole (one letter identifies nobody)', () =>
    toAgentDisplayName('Jean') === 'Jean');
assert('surrounding and repeated whitespace is collapsed', () =>
    toAgentDisplayName('  Jean   Talla  ') === 'Jean T.');
assert('the initial is upper-cased', () => toAgentDisplayName('jean talla') === 'jean T.');
assert('a blank name yields null, so the caller publishes no block at all', () =>
    toAgentDisplayName('   ') === null && toAgentDisplayName(null) === null && toAgentDisplayName(undefined) === null);
assert('a non-Latin surname yields its whole first character, not half a surrogate pair', () =>
    toAgentDisplayName('Jean 𝒯alla') === 'Jean 𝒯.');
assert('the full surname never survives — the output is first name + one char + a stop', () => {
    const out = toAgentDisplayName('Jean Pierre Talla')!;
    return !out.includes('Talla') && !out.includes('Pierre') && out.endsWith('.');
});

/**
 * The load-bearing structural claim: the DTO cannot construct a display name, so a caller
 * that forgets `toAgentDisplayName` cannot accidentally hand it a full name that "looks
 * fine". Every path into `agent.displayName` goes through the reducer in the service.
 */
assert('SOURCE: the service reduces the name — the stored one never reaches the DTO', () => {
    const svc = readCode('modules/orders/order.service.ts');
    return (
        /toAgentDisplayName\(\s*identity\.name\s*\)/.test(svc) &&
        !/displayName\s*:\s*identity\.name/.test(svc)
    );
});

assert('SOURCE: agents outside the window are never even LOOKED UP', () => {
    const svc = readCode('modules/orders/order.service.ts');
    // The gate must appear in the id-collection step, not only in the mapping step.
    const collect = svc.slice(svc.indexOf('disclosableAgentIds'), svc.indexOf('findPublicIdentitiesByIds'));
    return /agentIdentityVisibleAt\(/.test(collect);
});

assert('SOURCE: the customer agent block carries NO phone field', () => {
    const dto = readCode('modules/orders/dto/customer-shipment.dto.ts');
    const iface = dto.slice(dto.indexOf('interface CustomerShipmentAgent'));
    const body = iface.slice(0, iface.indexOf('}'));
    return !/phone/i.test(body) && !/email/i.test(body);
});

assert('SOURCE: the agent lookup is a two-field projection, not a full hydrate', () => {
    const repo = readCode('modules/agents/repositories/agent.repository.ts');
    return /findPublicIdentitiesByIds[\s\S]{0,400}\.select\('name avatar_file_id'\)/.test(repo);
});

// ─── 3 · The projected shipment ──────────────────────────────────────────────

console.log('\n── The projected shipment ──');

const agency = {
    id: 'a1',
    name: 'Douala Express',
    logo: null,
    supportPhone: '+237670000000',
    supportEmail: 'support@dx.cm',
    supportWhatsapp: null,
};

assert('`agencyName` still shipped, and reads off the same block as `agency.name`', () => {
    const dto = toCustomerShipmentDto(shipmentAt('in_transit'), { agency, agent: null });
    return dto.agencyName === 'Douala Express' && dto.agency!.name === dto.agencyName;
});

assert('no magazin → `agency` and `agencyName` are BOTH null, never disagreeing', () => {
    const dto = toCustomerShipmentDto(shipmentAt('in_transit'), { agency: null, agent: null });
    return dto.agency === null && dto.agencyName === null;
});

assert('the agency support contacts reach the customer (their own order, that agency)', () => {
    const dto = toCustomerShipmentDto(shipmentAt('in_transit'), { agency, agent: null });
    return dto.agency!.supportPhone === '+237670000000' && dto.agency!.supportEmail === 'support@dx.cm';
});

assert('`agent` is whatever the caller resolved, and null is a first-class answer', () => {
    const withAgent = toCustomerShipmentDto(shipmentAt('in_transit'), {
        agency,
        agent: { displayName: 'Jean T.', photo: null, visibleFrom: AGENT_IDENTITY_VISIBLE_FROM },
    });
    const without = toCustomerShipmentDto(shipmentAt('delivered'), { agency, agent: null });
    return withAgent.agent!.displayName === 'Jean T.' && without.agent === null;
});

assert('the failure REASON and NOTE are still withheld — only the count is published', () => {
    const shipment = shipmentAt('failed');
    (shipment as unknown as { delivery_failures: unknown[] }).delivery_failures = [
        { reason: 'customer_unreachable', note: 'gate locked, dog', failed_at: new Date() },
    ];
    const serialised = JSON.stringify(toCustomerShipmentDto(shipment, { agency, agent: null }));
    return (
        !serialised.includes('gate locked') &&
        !serialised.includes('customer_unreachable') &&
        serialised.includes('"failedAttempts":1')
    );
});

// ─── 4 · The 2dsphere null-location rule ─────────────────────────────────────

console.log('\n── A stored null `location` bricks the document holding it ──');

/**
 * Measured against MongoDB on 2026-08-23, and the measurement is why these are assertions
 * rather than a comment: with one element holding a real point and another holding an
 * explicit null, the insert, every subsequent update AND the index build are all refused.
 * `sparse` and `partialFilterExpression` were both tried and both still fail — they select
 * documents, and this document legitimately holds a point.
 *
 * So the invariant is: no write path may store the key as null, on any of the three models
 * carrying a 2dsphere index over an array of addresses.
 */
const ARRAY_INDEXED_MODELS: Array<[string, string, string]> = [
    ['modules/customers/customer.model.ts', 'saved_addresses', 'customer'],
    ['modules/vendors/vendor.model.ts', 'business_addresses', 'vendor'],
    ['modules/magazin/models/magazin.model.ts', 'headquarters_addresses', 'magazin'],
];

for (const [file, arrayPath, label] of ARRAY_INDEXED_MODELS) {
    const code = readCode(file);

    assert(`${label}: the array IS 2dsphere-indexed on the bare \`location\` (so the rule applies)`, () =>
        code.includes(`'${arrayPath}.location': '2dsphere'`));

    assert(`${label}: \`location\` defaults to UNDEFINED, never null`, () =>
        /location:\s*\{\s*type:\s*GeoPointSchema,\s*default:\s*undefined\s*\}/.test(code) &&
        !/location:\s*\{\s*type:\s*GeoPointSchema,\s*default:\s*null\s*\}/.test(code));
}

assert('SOURCE: the magazin write path OMITS the key rather than persisting a null', () => {
    const dto = readCode('modules/magazin/dto/magazin-profile.dto.ts');
    return (
        /e\.location\s*\?\?\s*undefined/.test(dto) &&
        /\.\.\.\(location\s*\?\s*\{\s*location\s*\}\s*:\s*\{\}\)/.test(dto) &&
        !/e\.location\s*\?\?\s*null/.test(dto)
    );
});

assert('SOURCE: the customer add-address path routes through `dropNullLocation`', () => {
    const svc = readCode('modules/customers/services/customer-profile.service.ts');
    return /dropNullLocation\(rest\)/.test(svc);
});

assert('SOURCE: clearing a saved address `location` is an $unset, never a $set null', () => {
    const repo = readCode('modules/customers/customer.repository.ts');
    const method = repo.slice(repo.indexOf('async updateAddress'), repo.indexOf('async removeAddress'));
    return /key === 'location' && value === null/.test(method) && /\$unset/.test(method);
});

assert('SOURCE: the vendor write path inherits it through `withGeoAddress`', () => {
    const geo = readCode('core/types/geo-address.types.ts');
    return /export function withGeoAddress[\s\S]{0,400}dropNullLocation\(rest\)/.test(geo);
});

/**
 * A nested GeoAddress is immune for a reason worth pinning: its `coordinates` is REQUIRED,
 * so `geo: null` puts the null one level ABOVE the indexed leaf and the path is simply
 * absent. Relax that `required` and the second index on every one of these models acquires
 * the same defect — with no other symptom.
 */
assert('GeoAddressSchema.coordinates stays REQUIRED — that is what makes `geo: null` safe', () => {
    const geo = readCode('core/types/geo-address.types.ts');
    return /coordinates:\s*\{\s*type:\s*GeoPointSchema,\s*required:\s*true\s*\}/.test(geo);
});

// ─── 5 · A refused payment initiation does not claim to be awaiting one ──────

console.log('\n── A refused gateway charge leaves the order payable ──');

assert('SOURCE: AWAITING_PAYMENT is written only when the gateway took the charge', () => {
    const svc = readCode('modules/payments/services/payment-orchestrator.service.ts');
    return /order\.payment_status === 'pending' && gatewayResult\.success/.test(svc);
});

assert('SOURCE: no gateway path writes `failed` to an order (that would kill every retry)', () => {
    const svc = readCode('modules/payments/services/payment-orchestrator.service.ts');
    return !/order\.payment_status\s*=\s*'failed'/.test(svc);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
