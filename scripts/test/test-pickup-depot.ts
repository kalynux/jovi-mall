/**
 * Test: the agency-depot pickup location — which of an agency's warehouses a
 * product is collected from.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free, and that is the point: `resolveHqAddress` is the single
 * fallback four separate readers depend on to route an agent, and none of those
 * readers can be exercised without Mongo. Same for `toPersistableHeadquarters`'s
 * `_id` continuity — get that wrong and every product pointing at a depot
 * silently falls back to the primary, with no error anywhere.
 *
 * Run: npm run test:pickup-depot
 */
import mongoose from 'mongoose';
import { resolveHqAddress } from '../../src/modules/magazin/domain/hq-address.resolver';
import {
  toPersistableHeadquarters,
  findUnknownHeadquartersIds,
} from '../../src/modules/magazin/dto/magazin-profile.dto';
import {
  MagazinHeadquartersAddressSchema,
  MagazinHeadquartersAddressArraySchema,
} from '../../src/modules/magazin/validators/magazin.validator';
import { assertHeadquartersInCountry } from '../../src/core/validation/address-country.helper';
import { pickupLocationSchema } from '../../src/modules/catalog/validators/product.validator';
import { mergeDeliveryConfig } from '../../src/modules/catalog/domain/services/delivery-config.merge';
import { PickupLocationValidationService } from '../../src/modules/catalog/domain/services/PickupLocationValidationService';
import { IAgencyHeadquartersAddress } from '../../src/modules/magazin/models/magazin.model';
import { IDeliveryAgency } from '../../src/modules/delivery/delivery-agency.model';
import { IVendor } from '../../src/modules/vendors/vendor.model';
import { AppError } from '../../src/core/errors';

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ID_A = '507f1f77bcf86cd799439011';
const ID_B = '507f1f77bcf86cd799439012';
const ID_GONE = '507f1f77bcf86cd799439099';

const geo = (placeId: string, lng = 9.7, lat = 4.05) => ({
  formatted_address: `Place ${placeId}`,
  coordinates: { type: 'Point' as const, coordinates: [lng, lat] as [number, number] },
  provider: 'nominatim' as const,
  provider_place_id: placeId,
  components: { city: 'Douala', region: 'Littoral', country: 'Cameroon', country_code: 'CM' },
  raw_input: 'x',
});

const depot = (id: string, label: string, placeId: string): IAgencyHeadquartersAddress =>
  ({
    _id: new mongoose.Types.ObjectId(id),
    label,
    region: 'Littoral',
    city: 'Douala',
    address_description: `${label} street`,
    support_contact: { phone: '+237600000000', email: null },
    location: geo(placeId).coordinates,
    geo: geo(placeId),
  }) as unknown as IAgencyHeadquartersAddress;

const hqInput = (overrides: Record<string, unknown> = {}) => ({
  label: 'Main depot',
  region: null,
  city: null,
  address_description: 'Main depot street',
  support_contact: { phone: '+237600000000', email: null },
  geo: geo('p1'),
  ...overrides,
});

const DEPOTS = [depot(ID_A, 'Main depot', 'p1'), depot(ID_B, 'Bonabéri branch', 'p2')];

const agencyWith = (storage: boolean, pickup: boolean) =>
  ({
    policies: { pricing: { storage_based: { enabled: storage }, pickup_based: { enabled: pickup } } },
  }) as unknown as IDeliveryAgency;

const vendorWithAddress = (addressId: string) =>
  ({ business_addresses: [{ _id: new mongoose.Types.ObjectId(addressId) }] }) as unknown as IVendor;

function isAppErrorWithCode(fn: () => void, code: string): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof AppError && err.code === code;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log('\n── resolveHqAddress — the one fallback four readers share ──\n');

  assert('a null id resolves to the primary (index 0)', () =>
    resolveHqAddress(DEPOTS, null)?._id.toString() === ID_A);

  assert('an undefined id resolves to the primary', () =>
    resolveHqAddress(DEPOTS)?._id.toString() === ID_A);

  assert('a known id resolves to that depot, not the primary', () =>
    resolveHqAddress(DEPOTS, ID_B)?._id.toString() === ID_B);

  assert('an ObjectId (not a string) resolves too — order snapshots store ObjectIds', () =>
    resolveHqAddress(DEPOTS, new mongoose.Types.ObjectId(ID_B))?._id.toString() === ID_B);

  // A deleted depot must not strand a delivery: the agent still gets sent somewhere.
  assert('a DANGLING id falls back to the primary rather than returning null', () =>
    resolveHqAddress(DEPOTS, ID_GONE)?._id.toString() === ID_A);

  assert('an empty depot list is null, not a crash', () => resolveHqAddress([], ID_A) === null);
  assert('an undefined depot list is null', () => resolveHqAddress(undefined, ID_A) === null);
  assert('a null depot list is null', () => resolveHqAddress(null) === null);

  console.log('\n── HQ validators — id shape, and the duplicate-id guard ──\n');

  assert('an HQ entry without an id is accepted (a genuinely new location)', () =>
    MagazinHeadquartersAddressSchema.safeParse(hqInput()).success);

  assert('an HQ entry with a valid id is accepted', () =>
    MagazinHeadquartersAddressSchema.safeParse(hqInput({ id: ID_A })).success);

  assert('a malformed id is rejected', () =>
    !MagazinHeadquartersAddressSchema.safeParse(hqInput({ id: 'not-an-id' })).success);

  assert('two entries sharing one id are rejected', () =>
    !MagazinHeadquartersAddressArraySchema.safeParse([
      hqInput({ id: ID_A }),
      hqInput({ id: ID_A, address_description: 'Other street' }),
    ]).success);

  assert('two entries with DIFFERENT ids are accepted', () =>
    MagazinHeadquartersAddressArraySchema.safeParse([
      hqInput({ id: ID_A }),
      hqInput({ id: ID_B, address_description: 'Other street' }),
    ]).success);

  // Several id-less entries are legal — they are all new locations.
  assert('several id-less entries are accepted', () =>
    MagazinHeadquartersAddressArraySchema.safeParse([
      hqInput(),
      hqInput({ address_description: 'Other street' }),
    ]).success);

  console.log('\n── findUnknownHeadquartersIds — the stale-view guard ──\n');

  assert('an id on the magazin is not reported', () =>
    findUnknownHeadquartersIds([hqInput({ id: ID_A })] as never, DEPOTS).length === 0);

  assert('an id NOT on the magazin is reported with its index', () => {
    const unknown = findUnknownHeadquartersIds([hqInput(), hqInput({ id: ID_GONE })] as never, DEPOTS);
    return unknown.length === 1 && unknown[0].index === 1 && unknown[0].id === ID_GONE;
  });

  assert('id-less entries are never reported', () =>
    findUnknownHeadquartersIds([hqInput(), hqInput()] as never, DEPOTS).length === 0);

  console.log('\n── toPersistableHeadquarters — _id continuity ──\n');

  assert('an echoed id is preserved verbatim', () => {
    const [out] = toPersistableHeadquarters([hqInput({ id: ID_B, geo: geo('p2') })] as never, DEPOTS);
    return (out as { _id?: mongoose.Types.ObjectId })._id?.toString() === ID_B;
  });

  // The safety net: a client that has not shipped the id echo must not orphan
  // every product pointing at these depots.
  assert('an id-less entry matching an existing one by content inherits its _id', () => {
    const [out] = toPersistableHeadquarters(
      [hqInput({ address_description: 'Bonabéri branch street', geo: geo('p2') })] as never,
      DEPOTS,
    );
    return (out as { _id?: mongoose.Types.ObjectId })._id?.toString() === ID_B;
  });

  assert('a genuinely new entry gets NO _id (Mongoose mints one)', () => {
    const [out] = toPersistableHeadquarters(
      [hqInput({ address_description: 'Brand new street', geo: geo('p9') })] as never,
      [],
    );
    return (out as { _id?: mongoose.Types.ObjectId })._id === undefined;
  });

  assert('same address text but a MOVED pin does not inherit an _id', () => {
    const [out] = toPersistableHeadquarters(
      [hqInput({ address_description: 'Bonabéri branch street', geo: geo('p2', 11.5, 3.86) })] as never,
      DEPOTS,
    );
    return (out as { _id?: mongoose.Types.ObjectId })._id === undefined;
  });

  // Two identical entries must not collapse onto one `_id` — that is exactly the
  // ambiguity the duplicate-id validator guard exists to prevent.
  assert('the content match is consumed once: a second identical entry gets no _id', () => {
    const entry = hqInput({ address_description: 'Bonabéri branch street', geo: geo('p2') });
    const out = toPersistableHeadquarters([entry, { ...entry }] as never, DEPOTS) as unknown as Array<{
      _id?: mongoose.Types.ObjectId;
    }>;
    return out[0]._id?.toString() === ID_B && out[1]._id === undefined;
  });

  assert('an _id claimed by an explicit echo cannot also be content-matched', () => {
    const out = toPersistableHeadquarters(
      [
        hqInput({ id: ID_B, address_description: 'Renamed street', geo: geo('p2') }),
        hqInput({ address_description: 'Bonabéri branch street', geo: geo('p2') }),
      ] as never,
      DEPOTS,
    ) as unknown as Array<{ _id?: mongoose.Types.ObjectId }>;
    return out[0]._id?.toString() === ID_B && out[1]._id === undefined;
  });

  console.log('\n── assertHeadquartersInCountry — id-OR-content grandfathering ──\n');

  assert('an unchanged entry matched by CONTENT is still grandfathered (legacy clients)', () => {
    assertHeadquartersInCountry(
      [{ address_description: 'Main depot street', geo: geo('p1') }],
      DEPOTS,
      'CM',
    );
    return true;
  });

  // The case content-matching alone misses: renaming a depot whose pin is unmoved.
  assert('a renamed entry matched by ID is grandfathered', () => {
    assertHeadquartersInCountry(
      [{ id: ID_A, address_description: 'Corrected street name', geo: geo('p1') }],
      DEPOTS,
      'CM',
    );
    return true;
  });

  // "Moved" is defined by `geoAddressEquals`: provider, place id, formatted
  // address and COORDINATES. A relabelled country alone is not a move, so the
  // fixture has to actually relocate the pin for the assertion to be reached.
  assert('a matching id with a MOVED pin is re-asserted, not grandfathered', () => {
    const movedAbroad = {
      ...geo('paris', 2.35, 48.85),
      components: { city: 'Paris', region: 'Île-de-France', country: 'France', country_code: 'FR' },
    };
    return isAppErrorWithCode(
      () =>
        assertHeadquartersInCountry(
          [{ id: ID_A, address_description: 'Main depot street', geo: movedAbroad }],
          DEPOTS,
          'CM',
        ),
      'ADDRESS_COUNTRY_MISMATCH',
    );
  });

  console.log('\n── pickupLocationSchema — the wire contract ──\n');

  assert('agencyAddressId is accepted', () =>
    pickupLocationSchema.safeParse({ source: 'agency_storage', agencyAddressId: ID_B }).success);

  assert('agency_storage WITHOUT a depot is accepted (null means the primary)', () =>
    pickupLocationSchema.safeParse({ source: 'agency_storage' }).success);

  assert('a malformed agencyAddressId is rejected', () =>
    !pickupLocationSchema.safeParse({ source: 'agency_storage', agencyAddressId: 'nope' }).success);

  // .strict() is what stops a client shipping a field the model has not declared,
  // which Mongoose would drop silently with a 200.
  assert('an unknown key is still rejected — the schema stays strict', () =>
    !pickupLocationSchema.safeParse({ source: 'agency_storage', depotId: ID_B }).success);

  assert('vendor_address still requires vendorAddressId', () =>
    !pickupLocationSchema.safeParse({ source: 'vendor_address' }).success);

  console.log('\n── mergeDeliveryConfig — the field that must survive a partial patch ──\n');

  const existing = {
    agencyId: null,
    freeDelivery: false,
    pickupLocation: { source: 'agency_storage' as const, vendorAddressId: null, agencyAddressId: ID_B },
  };

  // The bug this whole function exists to prevent, now for the new field.
  assert('a freeDelivery-only patch does NOT wipe the depot', () =>
    mergeDeliveryConfig(existing, { freeDelivery: true }).pickup_location?.agency_address_id === ID_B);

  assert('a new depot replaces the old one', () =>
    mergeDeliveryConfig(existing, {
      pickupLocation: { source: 'agency_storage', agencyAddressId: ID_A },
    }).pickup_location?.agency_address_id === ID_A);

  assert('omitting agencyAddressId on a new agency_storage patch clears it to null (= primary)', () =>
    mergeDeliveryConfig(existing, {
      pickupLocation: { source: 'agency_storage' },
    }).pickup_location?.agency_address_id === null);

  assert('switching to vendor_address normalises the depot away', () =>
    mergeDeliveryConfig(existing, {
      pickupLocation: { source: 'vendor_address', vendorAddressId: ID_A, agencyAddressId: ID_B },
    }).pickup_location?.agency_address_id === null);

  assert('switching to agency_storage normalises the vendor address away', () =>
    mergeDeliveryConfig(existing, {
      pickupLocation: { source: 'agency_storage', vendorAddressId: ID_A, agencyAddressId: ID_B },
    }).pickup_location?.vendor_address_id === null);

  assert('an explicit null still clears the whole pickup location', () =>
    mergeDeliveryConfig(existing, { pickupLocation: null }).pickup_location === null);

  console.log('\n── assertValid — the depot must belong to the effective agency ──\n');

  const service = new PickupLocationValidationService();
  const storageAgency = agencyWith(true, false);
  const vendor = vendorWithAddress(ID_A);

  assert('a depot on the agency passes', () => {
    service.assertValid(
      { source: 'agency_storage', vendorAddressId: null, agencyAddressId: ID_B },
      storageAgency,
      vendor,
      [ID_A, ID_B],
    );
    return true;
  });

  assert('a depot NOT on the agency is rejected 422', () =>
    isAppErrorWithCode(
      () =>
        service.assertValid(
          { source: 'agency_storage', vendorAddressId: null, agencyAddressId: ID_GONE },
          storageAgency,
          vendor,
          [ID_A, ID_B],
        ),
      'CATALOG_PRODUCT_INVALID_PICKUP_LOCATION',
    ));

  // The three "must never block" cases — activation cannot break over a depot.
  assert('a null depot always passes (it means the primary)', () => {
    service.assertValid(
      { source: 'agency_storage', vendorAddressId: null, agencyAddressId: null },
      storageAgency,
      vendor,
      [ID_A, ID_B],
    );
    return true;
  });

  assert('an unresolvable magazin (null depot list) passes rather than blocking the vendor', () => {
    service.assertValid(
      { source: 'agency_storage', vendorAddressId: null, agencyAddressId: ID_B },
      storageAgency,
      vendor,
      null,
    );
    return true;
  });

  assert('an agency with no depots on file passes', () => {
    service.assertValid(
      { source: 'agency_storage', vendorAddressId: null, agencyAddressId: ID_B },
      storageAgency,
      vendor,
      [],
    );
    return true;
  });

  assert('the storage-policy check still fires before the depot check', () =>
    isAppErrorWithCode(
      () =>
        service.assertValid(
          { source: 'agency_storage', vendorAddressId: null, agencyAddressId: ID_GONE },
          agencyWith(false, true),
          vendor,
          [ID_A],
        ),
      'CATALOG_PRODUCT_INVALID_PICKUP_LOCATION',
    ));

  assert('vendor_address is unaffected by the depot list', () => {
    service.assertValid(
      { source: 'vendor_address', vendorAddressId: ID_A },
      agencyWith(false, true),
      vendor,
      null,
    );
    return true;
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
