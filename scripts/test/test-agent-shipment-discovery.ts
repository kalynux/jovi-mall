/**
 * Test: Agent shipment discovery — search escaping, the shared AddressDetail
 * read-model, the agent-cut arithmetic, pickup precedence, and offer redaction.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework — this project has none). Everything here is DB-free: the pieces
 * under test are pure by construction, which is why they were extracted rather
 * than left inline in the enrichment paths.
 *
 * What it deliberately does NOT cover (needs Mongo, verify by running the app):
 * the two-phase search fan-out itself, the earnings quote's repository lookups,
 * and the geo-tracker route call.
 *
 * Run: npx ts-node scripts/test/test-agent-shipment-discovery.ts
 *      (npm run test:agent-shipment-discovery)
 */
import { escapeRegex, buildSearchRegex } from '../../src/core/utils/regex.util';
import { haversineKm } from '../../src/core/utils/geo-distance.util';
import {
    toAddressDetail,
    fromSavedAddress,
    fromPickupSnapshot,
    fromHqAddress,
    fromHandoverPickup,
} from '../../src/core/read-models/address-detail.resolver';
import { applyFeeSplit } from '../../src/modules/earnings/services/earnings-quote.service';
import { firstNameOf, redactAddress } from '../../src/modules/shipment-assignment/domain/services/shipment-assignment.service';
import { ShipmentService } from '../../src/modules/shipments/shipment.service';

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
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const geo = (lng: number, lat: number, formatted = 'Rue 1234, Akwa, Douala') => ({
    formatted_address: formatted,
    coordinates: { type: 'Point' as const, coordinates: [lng, lat] as [number, number] },
    provider: 'nominatim' as const,
    provider_place_id: null,
    components: {
        street: 'Rue 1234',
        neighbourhood: 'Akwa',
        city: 'Douala',
        region: 'Littoral',
        country: 'Cameroon',
        country_code: 'CM',
        postal_code: null,
    },
    raw_input: null,
    resolved_at: new Date(),
});

// ─── Search escaping ──────────────────────────────────────────────────────────

section('Search term escaping');

assert('regex metacharacters are neutralised', () =>
    escapeRegex('a+b(c)') === 'a\\+b\\(c\\)'
);

assert('an unbalanced paren cannot crash the RegExp constructor', () => {
    // Unescaped, `new RegExp('(')` throws — a 500 on a user's search box.
    const rx = buildSearchRegex('(');
    return rx.test('order (123)');
});

assert('a catastrophic-backtracking term is matched literally', () => {
    const rx = buildSearchRegex('(a+)+$');
    return rx.test('literal (a+)+$ text') && !rx.test('aaaaaaaaaaaaaaaa');
});

assert('a wildcard cannot widen the result set', () => {
    // `.*` must match the literal characters, not everything.
    const rx = buildSearchRegex('.*');
    return !rx.test('Ordinary Customer') && rx.test('weird.*name');
});

assert('search is case-insensitive and substring-based', () => {
    const rx = buildSearchRegex('samsung');
    return rx.test('Samsung Galaxy A54') && rx.test('SAMSUNG');
});

assert('surrounding whitespace is trimmed', () =>
    buildSearchRegex('  +237  ').source === escapeRegex('+237')
);

// ─── AddressDetail read-model ─────────────────────────────────────────────────

section('AddressDetail read-model');

assert('GeoJSON [lng, lat] is flipped to { lat, lng }', () => {
    const d = toAddressDetail(geo(9.7043, 4.0511));
    return d?.coordinates?.lat === 4.0511 && d?.coordinates?.lng === 9.7043;
});

assert('a legacy address with no geo yields null coordinates, not a fake point', () => {
    const d = fromSavedAddress({
        label: 'Home', address_line1: 'BP 1234', city: 'Douala', country: 'CM', geo: null, location: null,
    });
    return d !== null && d.coordinates === null && d.city === 'Douala';
});

assert('the deprecated bare `location` is used when geo is absent', () => {
    const d = fromSavedAddress({
        label: 'Home', address_line1: 'BP 1234', city: 'Douala',
        location: { type: 'Point', coordinates: [9.70, 4.05] }, geo: null,
    });
    return d?.coordinates?.lat === 4.05 && d?.coordinates?.lng === 9.70;
});

assert('geo coordinates beat the deprecated bare location', () => {
    const d = fromSavedAddress({
        label: 'Home', address_line1: 'BP 1234', city: 'Douala',
        location: { type: 'Point', coordinates: [0, 0] }, geo: geo(9.70, 4.05),
    });
    return d?.coordinates?.lat === 4.05 && d?.coordinates?.lng === 9.70;
});

assert('malformed coordinates are rejected rather than emitted as NaN', () => {
    const broken: any = { ...geo(9.7, 4.05), coordinates: { type: 'Point', coordinates: [9.7] } };
    return toAddressDetail(broken)?.coordinates === null;
});

assert('the entity\'s own loose fields win over the provider components', () => {
    // The provider parsed "Douala"; the record says "Bonabéri". The record wins.
    const d = fromSavedAddress({
        label: 'Home', address_line1: 'BP 1234', city: 'Bonabéri', geo: geo(9.7, 4.05),
    });
    return d?.city === 'Bonabéri';
});

assert('provider components fill a field the record does not carry', () => {
    // The pickup snapshot has no `country` column at all.
    const d = fromPickupSnapshot({ label: 'Warehouse', address_line1: 'Zone 4', city: 'Douala', geo: geo(9.7, 4.05) });
    return d?.country === 'Cameroon';
});

assert('formattedAddress is composed when the address was never geocoded', () => {
    const d = fromSavedAddress({ label: 'Home', address_line1: 'BP 1234', city: 'Douala', state: null, country: 'CM' });
    return d?.formattedAddress === 'BP 1234, Douala, CM';
});

assert('an entirely empty address resolves to null, not an object of nulls', () =>
    fromSavedAddress({}) === null && fromSavedAddress(null) === null
);

assert('the HQ address maps address_description → line1 and region → state', () => {
    const d = fromHqAddress({ label: 'HQ', address_description: 'Rue Njo-Njo', city: 'Douala', region: 'Littoral' });
    return d?.addressLine1 === 'Rue Njo-Njo' && d?.state === 'Littoral';
});

assert('the handover pickup maps its nested line1/line2', () => {
    const d = fromHandoverPickup({
        label: 'Agency counter',
        address: { line1: 'Rue 500', line2: 'Floor 2', city: 'Douala', state: 'Littoral', country: 'CM' },
        geo: null, location: { type: 'Point', coordinates: [9.71, 4.06] },
    });
    return d?.addressLine1 === 'Rue 500' && d?.addressLine2 === 'Floor 2' && d?.coordinates?.lat === 4.06;
});

// ─── Agent-cut arithmetic ─────────────────────────────────────────────────────

section('Agent-cut arithmetic (applyFeeSplit)');

assert('a percentage split takes its share of the fee', () =>
    applyFeeSplit({ model: 'percentage', agent_share_percent: 60, agent_flat_fee: null, currency: 'XAF' }, 2000) === 1200
);

assert('a percentage split floors rather than emitting fractional minor units', () =>
    applyFeeSplit({ model: 'percentage', agent_share_percent: 33, agent_flat_fee: null, currency: 'XAF' }, 1000) === 330
);

assert('a flat split pays its fixed amount', () =>
    applyFeeSplit({ model: 'flat', agent_share_percent: null, agent_flat_fee: 750, currency: 'XAF' }, 2000) === 750
);

assert('a flat fee above the delivery fee is clamped to the fee', () =>
    applyFeeSplit({ model: 'flat', agent_share_percent: null, agent_flat_fee: 5000, currency: 'XAF' }, 2000) === 2000
);

assert('the overflow callback reports the unclamped amount', () => {
    let reported = 0;
    applyFeeSplit({ model: 'flat', agent_share_percent: null, agent_flat_fee: 5000, currency: 'XAF' }, 2000, (raw) => { reported = raw; });
    return reported === 5000;
});

assert('an unconfigured split (the contract default) pays 0, not NaN', () =>
    applyFeeSplit({ model: 'percentage', agent_share_percent: null, agent_flat_fee: null, currency: 'XAF' }, 2000) === 0
);

assert('a missing contract split pays 0', () =>
    applyFeeSplit(null, 2000) === 0 && applyFeeSplit(undefined, 2000) === 0
);

assert('a zero or negative delivery fee yields no cut', () =>
    applyFeeSplit({ model: 'percentage', agent_share_percent: 60, agent_flat_fee: null, currency: 'XAF' }, 0) === 0 &&
    applyFeeSplit({ model: 'flat', agent_share_percent: null, agent_flat_fee: 750, currency: 'XAF' }, -100) === 0
);

// ─── Offer redaction ──────────────────────────────────────────────────────────

section('Pending-offer redaction');

assert('a pending offer shows only the first name', () =>
    firstNameOf('Marie Claire Ngo Bassong') === 'Marie'
);

assert('a single-word name is returned whole', () => firstNameOf('Marie') === 'Marie');

assert('a missing name stays null', () => firstNameOf(null) === null && firstNameOf('') === null);

assert('a pending offer keeps the city and coordinates but drops the street', () => {
    const full = toAddressDetail(geo(9.7043, 4.0511));
    const r = redactAddress(full, false);
    return r?.addressLine1 === null
        && r?.label === null
        && r?.city === 'Douala'
        && r?.coordinates?.lat === 4.0511
        && r?.formattedAddress === 'Douala, Littoral, Cameroon';
});

assert('an accepted offer keeps the full address untouched', () => {
    const full = toAddressDetail(geo(9.7043, 4.0511));
    const r = redactAddress(full, true);
    return r?.addressLine1 === 'Rue 1234' && r?.formattedAddress === 'Rue 1234, Akwa, Douala';
});

assert('redacting a null address stays null', () => redactAddress(null, false) === null);

// ─── Pickup precedence ────────────────────────────────────────────────────────

section('Pickup resolution');

const svc = new ShipmentService() as any;

const orderWithPickups = {
    items: [
        { _id: 'oi-1', delivery: { pickup_location: { source: 'vendor_address', address_snapshot: { label: 'Shop', address_line1: 'Rue 100', city: 'Douala', geo: geo(9.70, 4.05) } } } },
        { _id: 'oi-2', delivery: { pickup_location: { source: 'agency_storage', address_snapshot: null } } },
        // Names the agency's SECOND depot — the depot-picker case.
        { _id: 'oi-3', delivery: { pickup_location: { source: 'agency_storage', address_snapshot: null, agency_address_id: 'hq-2' } } },
        // Names a depot the agency has since deleted — must fall back, not vanish.
        { _id: 'oi-4', delivery: { pickup_location: { source: 'agency_storage', address_snapshot: null, agency_address_id: 'hq-gone' } } },
    ],
};
// The batch map now carries EVERY depot, in stored order (index 0 = primary),
// because an order item names which one it wants.
const hqMap = new Map([['agency-1', [
    { _id: { toString: () => 'hq-1' }, label: 'HQ', address_description: 'Rue Njo-Njo', city: 'Douala', region: 'Littoral', geo: geo(9.72, 4.07) },
    { _id: { toString: () => 'hq-2' }, label: 'Bonabéri', address_description: 'Rue Bonabéri', city: 'Douala', region: 'Littoral', geo: geo(9.68, 4.08, 'Rue Bonabéri, Douala') },
]]]);
const shipmentOf = (overrides: any = {}) => ({
    _id: 'ship-1',
    agency_id: { toString: () => 'agency-1' },
    items: [{ order_item_id: { toString: () => 'oi-1' }, product_id: { toString: () => 'p-1' }, quantity: 1 }],
    handover: null,
    ...overrides,
});

assert('a vendor-address item resolves to the order\'s pickup snapshot', () => {
    const p = svc._resolvePickup(shipmentOf(), orderWithPickups, hqMap);
    return p.mode === 'pickup_based' && p.count === 1 && p.address.addressLine1 === 'Rue 100';
});

assert('a storage-based item naming NO depot resolves to the primary, live', () => {
    const s = shipmentOf({ items: [{ order_item_id: { toString: () => 'oi-2' }, product_id: { toString: () => 'p-2' }, quantity: 1 }] });
    const p = svc._resolvePickup(s, orderWithPickups, hqMap);
    return p.mode === 'storage_based' && p.address.addressLine1 === 'Rue Njo-Njo';
});

assert('a storage-based item naming a depot resolves to THAT depot, not the primary', () => {
    const s = shipmentOf({ items: [{ order_item_id: { toString: () => 'oi-3' }, product_id: { toString: () => 'p-3' }, quantity: 1 }] });
    const p = svc._resolvePickup(s, orderWithPickups, hqMap);
    return p.mode === 'storage_based' && p.address.addressLine1 === 'Rue Bonabéri';
});

// A deleted depot must not strand the agent with no address at all.
assert('a storage-based item naming a DELETED depot falls back to the primary', () => {
    const s = shipmentOf({ items: [{ order_item_id: { toString: () => 'oi-4' }, product_id: { toString: () => 'p-4' }, quantity: 1 }] });
    const p = svc._resolvePickup(s, orderWithPickups, hqMap);
    return p.mode === 'storage_based' && p.address.addressLine1 === 'Rue Njo-Njo';
});

// Two depots of the SAME agency are two places the agent must drive to.
assert('two items in different depots count as TWO pickups', () => {
    const s = shipmentOf({
        items: [
            { order_item_id: { toString: () => 'oi-2' }, product_id: { toString: () => 'p-2' }, quantity: 1 },
            { order_item_id: { toString: () => 'oi-3' }, product_id: { toString: () => 'p-3' }, quantity: 1 },
        ],
    });
    const p = svc._resolvePickup(s, orderWithPickups, hqMap);
    return p.count === 2 && p.mode === 'storage_based';
});

assert('a shipment mixing both fulfilment modes reports `mixed` and counts both', () => {
    const s = shipmentOf({
        items: [
            { order_item_id: { toString: () => 'oi-1' }, product_id: { toString: () => 'p-1' }, quantity: 1 },
            { order_item_id: { toString: () => 'oi-2' }, product_id: { toString: () => 'p-2' }, quantity: 1 },
        ],
    });
    const p = svc._resolvePickup(s, orderWithPickups, hqMap);
    return p.mode === 'mixed' && p.count === 2;
});

assert('two items from the same address count as ONE pickup', () => {
    const s = shipmentOf({
        items: [
            { order_item_id: { toString: () => 'oi-1' }, product_id: { toString: () => 'p-1' }, quantity: 1 },
            { order_item_id: { toString: () => 'oi-1' }, product_id: { toString: () => 'p-3' }, quantity: 2 },
        ],
    });
    return svc._resolvePickup(s, orderWithPickups, hqMap).count === 1;
});

assert('a reassignment handover pickup BEATS the order snapshot', () => {
    // The parcel is physically with the previous agent; sending the replacement
    // to the vendor address the order still names would be the wrong place.
    const s = shipmentOf({
        handover: { pickup: { source: 'previous_agent_location', label: 'Meet point', address: { line1: 'Rue 900', city: 'Douala' }, geo: geo(9.75, 4.09), location: null, note: null, is_fallback: false } },
    });
    const p = svc._resolvePickup(s, orderWithPickups, hqMap);
    return p.address.addressLine1 === 'Rue 900' && p.count === 1;
});

assert('a legacy item with no pickup snapshot resolves to no pickup, not a crash', () => {
    const p = svc._resolvePickup(shipmentOf(), { items: [{ _id: 'oi-1', delivery: null }] }, hqMap);
    return p.address === null && p.mode === null && p.count === 0;
});

// ─── Drop-off precedence ──────────────────────────────────────────────────────

section('Drop-off resolution');

assert('the order\'s checkout snapshot beats the customer\'s saved default', () => {
    // The customer may have edited their profile since ordering; the snapshot is
    // the address they actually ordered to.
    const d = svc._resolveDeliveryAddress(
        { delivery_address: geo(9.7043, 4.0511, 'Rue 1234, Akwa, Douala') },
        { label: 'New home', address_line1: 'Somewhere else', city: 'Yaoundé' }
    );
    return d.formattedAddress === 'Rue 1234, Akwa, Douala' && d.coordinates.lat === 4.0511;
});

assert('a legacy order with no snapshot falls back to the saved default', () => {
    const d = svc._resolveDeliveryAddress(
        { delivery_address: null },
        { label: 'Home', address_line1: 'BP 1234', city: 'Douala', country: 'CM' }
    );
    return d.addressLine1 === 'BP 1234' && d.city === 'Douala';
});

assert('a legacy order with no saved address at all resolves to null', () =>
    svc._resolveDeliveryAddress({ delivery_address: null }, null) === null
);

// ─── Straight-line distance ───────────────────────────────────────────────────

section('Straight-line fallback distance');

assert('haversine measures a known short hop within a few percent', () => {
    // Akwa → Bonanjo, Douala: roughly 2.4 km apart.
    const km = haversineKm(
        { type: 'Point', coordinates: [9.7043, 4.0511] },
        { type: 'Point', coordinates: [9.6870, 4.0430] }
    );
    return km > 2.0 && km < 2.6;
});

assert('the same point is zero distance', () =>
    haversineKm({ type: 'Point', coordinates: [9.70, 4.05] }, { type: 'Point', coordinates: [9.70, 4.05] }) === 0
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(72)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(72)}\n`);

process.exit(failed > 0 ? 1 : 0);
