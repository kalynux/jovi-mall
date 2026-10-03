/**
 * test:delivery-region — the "Centre Region" incident (2026-10-02), and the forced pushes
 * that were built beside the fix.
 *
 * A customer's drop-off said "Centre Region"; every contract said `centre`. The region
 * resolver folded the first to `centre-region`, matched nothing, and no agent was ever
 * offered the delivery. Three things changed, and this suite pins each:
 *
 *   1. Matching — `resolveRegionKey` / `matchCountryRegion` see through filler words
 *      ("Region", "Région du"), separators, accents and the dataset's aliases.
 *   2. Writing — `canonicalizeAddressRegion` pins a customer address's (and, for new or
 *      edited entries, a vendor's or agency's pickup address's) region to one of
 *      its country's regions (falling back to the city), or refuses it with the picker.
 *   3. Forcing — `isForceableGate`: the agency's force now covers the region as well as
 *      the COD amount; an administrator's covers every gate except the active contract.
 *
 * Offline: no database, no server. Behaviour where it is pure, source scans where the rule
 * lives in a command path that needs Mongo to run.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  compactRegionToken,
  matchCountryRegion,
  regionKeyForCity,
  resolveRegionKey,
} from '../../src/core/constants/locations.helper';
import {
  assertHeadquartersInCountry,
  canonicalizeAddressRegion,
  pinAddressRegionIfKnown,
} from '../../src/core/validation/address-country.helper';
import { contractCoversRegion } from '../../src/modules/agents/domain/services/contract-coverage.service';
import { buildDeliveryPromise } from '../../src/modules/negotiation/domain/delivery-promise';
import {
  isForceableGate,
  ContractPolicyGateName,
} from '../../src/modules/shipment-assignment/domain/services/contract-policy.service';
import { CodCapacityVerdict } from '../../src/modules/cod/services/cod-exposure.service';
import { ERROR_CODES } from '../../src/core/error-codes';
import { GeoAddressInput } from '../../src/core/types/geo-address.types';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    console.log(`  ❌ ${name} — threw: ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

const SRC = join(__dirname, '..', '..', 'src');
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

// ─── 1. Matching ─────────────────────────────────────────────────────────────

console.log('\n1. A region is recognised however it is spelled');

const SPELLINGS: Array<[string, string]> = [
  ['Centre Region', 'centre'],
  ['Région du Centre', 'centre'],
  ['Center', 'centre'],
  ['  CENTRE ', 'centre'],
  ["Région de l'Extrême-Nord", 'far_north'],
  ['Far North Region', 'far_north'],
  ['Extreme North', 'far_north'],
  ['North West Region', 'northwest'],
  ['North-West', 'northwest'],
  ['Nord-Ouest', 'northwest'],
  ['Adamawa Region', 'adamaoua'],
  ['South-West Region', 'southwest'],
  ['Est', 'east'],
  ['Littoral Province', 'littoral'],
];
for (const [raw, key] of SPELLINGS) {
  assert(`"${raw}" → ${key}`, () => matchCountryRegion(raw, 'CM') === key);
}

assert('filler alone names no region', () => matchCountryRegion('Region', 'CM') === null && compactRegionToken('Région de la') === '');
assert('"North" and "Northwest" stay distinct', () =>
  matchCountryRegion('North Region', 'CM') === 'north' && matchCountryRegion('Northwest Region', 'CM') === 'northwest');
assert('an unknown country matches nothing strictly', () => matchCountryRegion('Centre', 'NG') === null);
assert('resolveRegionKey still falls back to the token for free text', () =>
  resolveRegionKey('Somewhere Odd', 'CM') === 'somewhere-odd');
assert('a city resolves its region (Yaoundé → centre, Douala → littoral)', () =>
  regionKeyForCity('Yaounde', 'CM') === 'centre' && regionKeyForCity('Douala', 'CM') === 'littoral');

console.log('\n2. Coverage matches the incident\'s exact strings');

assert('a contract covering `centre` covers a "Centre Region" drop-off — THE incident', () =>
  contractCoversRegion({ regions: ['centre'] } as never, 'Centre Region', 'CM'));
assert('… and a "Région du Centre" one, with no country code', () =>
  contractCoversRegion({ regions: ['Centre'] } as never, 'Région du Centre', null));
assert('… but not a Littoral contract', () =>
  !contractCoversRegion({ regions: ['littoral'] } as never, 'Centre Region', 'CM'));

const agency = { name: 'A', coverageAreas: ['centre'] } as never;
assert('the negotiation delivery promise agrees (it used a raw lowercase compare)', () =>
  buildDeliveryPromise({ productType: 'physical', currency: 'XAF', agency, region: 'Centre Region' }).coversRegion === true);

// ─── 2. Writing ──────────────────────────────────────────────────────────────

console.log('\n3. A customer address is pinned to a real region, or refused');

const geo = (components: Record<string, unknown>) => ({
  formatted_address: 'Somewhere, Cameroon',
  coordinates: { type: 'Point' as const, coordinates: [11.5, 3.8] as [number, number] },
  provider: 'geoapify' as const,
  components,
});

/** Run the guard on a wire-shape address built from these components. */
const pin = (components: Record<string, unknown>, context?: { addressId?: string | null }) =>
  canonicalizeAddressRegion(geo(components) as unknown as GeoAddressInput, context);

assert('"Centre Region" is stored as "Centre"', () =>
  pin({ region: 'Centre Region', city: 'Yaoundé', country_code: 'CM' })
    .components.region === 'Centre');
assert('the input object is not mutated', () => {
  const input = geo({ region: 'Centre Region', country_code: 'CM' });
  pin(input.components);
  return input.components.region === 'Centre Region';
});
assert('no region but a known city → the city\'s region', () =>
  pin({ region: null, city: 'Bafoussam', country_code: 'CM' })
    .components.region === 'West');
assert('a client-picked KEY is accepted (the repair path after a refusal)', () =>
  pin({ region: 'far_north', country_code: 'CM' }).components.region === 'Far North');
assert('a country with no region list passes untouched', () =>
  pin({ region: 'Lagos', country_code: 'NG' }).components.region === 'Lagos');
assert('no country code passes untouched', () =>
  pin({ region: 'Mars' }).components.region === 'Mars');
assert('an unmatched region and city → 400 ADDRESS_REGION_INVALID with the picker', () => {
  try {
    pin({ region: 'Mars', city: 'Nowhere', country_code: 'CM' }, { addressId: 'a1' });
    return false;
  } catch (err) {
    const e = err as { code?: string; errorCode?: string; statusCode?: number; details?: Record<string, unknown> };
    const regions = e.details?.allowedRegions as Array<{ key: string }> | undefined;
    return (e.code ?? e.errorCode) === ERROR_CODES.ADDRESS_REGION_INVALID
      && e.statusCode === 400
      && e.details?.addressId === 'a1'
      && !!regions && regions.length === 10 && regions.some((r) => r.key === 'centre');
  }
});

assert('every customer address write and the checkout drop-off go through the guard', () => {
  const profile = read('modules', 'customers', 'services', 'customer-profile.service.ts');
  const order = read('modules', 'orders', 'order.service.ts');
  return (profile.match(/canonicalizeAddressRegion\(/g) ?? []).length === 2
    && (order.match(/canonicalizeAddressRegion\(/g) ?? []).length === 3;
});

console.log('\n3b. Pickup addresses — vendor business addresses and agency headquarters');

assert('the lenient pin canonicalises what it can …', () =>
  pinAddressRegionIfKnown(geo({ region: 'Centre Region', country_code: 'CM' }) as unknown as GeoAddressInput)
    .components!.region === 'Centre');
assert('… and leaves an unmatched legacy row alone instead of refusing it', () =>
  pinAddressRegionIfKnown(geo({ region: 'Mars', city: 'Nowhere', country_code: 'CM' }) as unknown as GeoAddressInput)
    .components!.region === 'Mars');
assert('a NEW headquarters entry with no matching region is refused, named by index', () => {
  try {
    assertHeadquartersInCountry(
      [{ label: 'Depot', address_description: 'x', geo: geo({ region: 'Mars', city: 'Nowhere', country_code: 'CM' }) as unknown as GeoAddressInput }],
      [],
      'CM',
    );
    return false;
  } catch (err) {
    const e = err as { code?: string; errorCode?: string; details?: Record<string, unknown> };
    return (e.code ?? e.errorCode) === ERROR_CODES.ADDRESS_REGION_INVALID && e.details?.index === 0 && e.details?.label === 'Depot';
  }
});
assert('an UNCHANGED headquarters entry is grandfathered, whatever its region says', () => {
  const g = geo({ region: 'Mars', country_code: 'CM' });
  assertHeadquartersInCountry(
    [{ address_description: 'x', geo: g as unknown as GeoAddressInput }],
    [{ address_description: 'x', geo: g as never }],
    'CM',
  );
  return true;
});
assert('vendor business addresses: strict on new/edited entries, pinned on persist (both write paths)', () => {
  const vendor = read('modules', 'vendor', 'service', 'vendor-profile.service.ts');
  const magazin = read('modules', 'magazin', 'dto', 'magazin-profile.dto.ts');
  return /canonicalizeAddressRegion\(entry\.geo!, \{ index, label: entry\.label \?\? null \}\)/.test(vendor)
    && (vendor.match(/this\.toPersistableBusinessAddresses\(input\.business_addresses\)/g) ?? []).length === 2
    && magazin.includes('toGeoAddress(pinAddressRegionIfKnown(e.geo))');
});

// ─── 3. Forcing ──────────────────────────────────────────────────────────────

console.log('\n4. What a force may push past');

const verdict = (blocker: string): CodCapacityVerdict =>
  ({ allowed: false, blocker } as unknown as CodCapacityVerdict);
const gate = (g: ContractPolicyGateName) => ({ gate: g });

assert('NOTHING forces past an inactive contract — not even an administrator', () =>
  !isForceableGate(gate('contract_active'), null, { adminOverride: true, forceCoverage: true, forceCodLimit: true }));
assert('agency force: coverage', () => isForceableGate(gate('coverage_region'), null, { forceCoverage: true }));
assert('agency force: COD amount only', () =>
  isForceableGate(gate('cod_exposure'), verdict('exposure_exceeded'), { forceCodLimit: true })
  && !isForceableGate(gate('cod_exposure'), verdict('kyc_not_verified'), { forceCodLimit: true })
  && !isForceableGate(gate('cod_exposure'), verdict('trust_too_low'), { forceCodLimit: true }));
assert('agency force: never the value ceiling', () =>
  !isForceableGate(gate('shipment_value_ceiling'), null, { forceCodLimit: true, forceCoverage: true }));
assert('no force: nothing', () =>
  (['coverage_region', 'shipment_value_ceiling', 'cod_exposure'] as const)
    .every((g) => !isForceableGate(gate(g), verdict('exposure_exceeded'), {})));
assert('admin override: every other gate, the whole COD verdict included', () =>
  (['coverage_region', 'shipment_value_ceiling', 'cod_exposure'] as const)
    .every((g) => isForceableGate(gate(g), verdict('kyc_not_verified'), { adminOverride: true })));

console.log('\n5. The command paths honour it — and only for the right caller');

const svc = read('modules', 'shipment-assignment', 'domain', 'services', 'shipment-assignment.service.ts');
assert('an admin override is honoured only when the creator\'s role is admin', () =>
  (svc.match(/creator\.role === 'admin' \? \(/g) ?? []).length === 2);
assert('accept skips eligibility only for an admin-overridden offer', () =>
  /if \(!adminOverride\) await this\.eligibility\.assertEligible\(agentId, agencyId\);/.test(svc));
assert('accept over-commits capacity only for an admin-overridden offer', () =>
  /adminOverride\s*\?\s*await this\.capacity\.forceReserve\(agentId, session\)\s*:\s*await this\.capacity\.tryReserve\(agentId, session\)/.test(svc));
assert('accept re-applies the offer\'s recorded forces', () =>
  /forceCodLimit: !!offer\.cod_limit_forced,\s*forceCoverage: !!offer\.coverage_forced,/.test(svc));

const agencyCtl = read('modules', 'shipment-assignment', 'controllers', 'agency-assignment.controller.ts');
// Three agency placement paths since 2026-10-03: assign-agent, its bulk form, and reassign.
assert('the agency\'s `force` covers the region on assign-agent, bulk assign-agent and reassign', () =>
  (agencyCtl.match(/forceCoverage: force === true/g) ?? []).length === 3);

const adminRoutes = read('modules', 'shipments', 'admin-shipment.routes.ts');
assert('the admin surface has assign-agent and move-agency', () =>
  adminRoutes.includes("'/:shipmentId/assign-agent'") && adminRoutes.includes("'/:shipmentId/move-agency'"));

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
