/**
 * Simple-mode product tests (no DB needed).
 *
 * Covers the pure and stub-injectable parts of the simple-product feature:
 * the two Zod schemas, SKU generation, the delivery-config merge, pickup-location
 * derivation, the mode guards, and — most importantly — that refactoring
 * ProductStatusValidationService.validate() into collectActivationBlockers()
 * did not change what validate() throws.
 *
 * Run: npx ts-node scripts/test/test-simple-product.ts
 */

import { Types } from 'mongoose';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import {
  CreateSimpleProductSchema,
  UpdateSimpleProductSchema,
} from '../../src/modules/catalog/validators/simple-product.validator';
import { generateSimpleSku } from '../../src/modules/catalog/domain/services/simple/sku-generator';
import {
  assertNotSimpleMode,
  assertSimpleMode,
} from '../../src/modules/catalog/domain/services/simple/mode-guard';
import { mergeDeliveryConfig } from '../../src/modules/catalog/domain/services/delivery-config.merge';
import { derivePickupLocation } from '../../src/modules/catalog/domain/services/PickupLocationResolver';
import { ProductStatusValidationService } from '../../src/modules/catalog/domain/services/ProductStatusValidationService';
import { Product } from '../../src/modules/catalog/repositories/mappers/product.mapper';
import { Variant } from '../../src/modules/catalog/repositories/mappers/variant.mapper';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${label}`);
  }
}

const OID = '507f1f77bcf86cd799439011';
const OID2 = '507f1f77bcf86cd799439012';

// ─── Create schema ────────────────────────────────────────────────────────────

{
  const valid = { title: 'Simple Shoes', description: 'Comfy.', category: 'footwear', price: 15000 };

  const ok = CreateSimpleProductSchema.safeParse(valid);
  assert(ok.success, 'create: minimal valid body passes');
  if (ok.success) {
    assert(ok.data.stock === 0, 'create: stock defaults to 0');
    assert(ok.data.isInfiniteStock === false, 'create: isInfiniteStock defaults to false');
    assert(ok.data.publish === true, 'create: publish defaults to true');
    assert(ok.data.freeDelivery === false, 'create: freeDelivery defaults to false');
  }

  for (const field of ['title', 'description', 'category', 'price'] as const) {
    const body: Record<string, unknown> = { ...valid };
    delete body[field];
    assert(!CreateSimpleProductSchema.safeParse(body).success, `create: missing ${field} rejected`);
  }

  // A zero price can never be activated, so it is rejected up front rather than
  // becoming a silent activation blocker later.
  assert(!CreateSimpleProductSchema.safeParse({ ...valid, price: 0 }).success,
    'create: price 0 rejected');
  assert(!CreateSimpleProductSchema.safeParse({ ...valid, price: -1 }).success,
    'create: negative price rejected');

  assert(!CreateSimpleProductSchema.safeParse({ ...valid, title: 'ab' }).success,
    'create: 2-char title rejected');
  assert(!CreateSimpleProductSchema.safeParse({ ...valid, title: 'x'.repeat(201) }).success,
    'create: 201-char title rejected');
  assert(!CreateSimpleProductSchema.safeParse({ ...valid, description: '' }).success,
    'create: empty description rejected');

  assert(!CreateSimpleProductSchema.safeParse({ ...valid, fileIds: [OID, OID] }).success,
    'create: duplicate fileIds rejected');
  assert(!CreateSimpleProductSchema.safeParse({ ...valid, fileIds: ['not-an-oid'] }).success,
    'create: malformed fileId rejected');

  assert(!CreateSimpleProductSchema.safeParse({
    ...valid, pickupLocation: { source: 'vendor_address' },
  }).success, 'create: vendor_address pickup without vendorAddressId rejected');
  assert(CreateSimpleProductSchema.safeParse({
    ...valid, pickupLocation: { source: 'agency_storage' },
  }).success, 'create: agency_storage pickup without an address accepted');

  // Fields belonging to capabilities the simple editor does not expose must not
  // be silently swallowed — accepting them would make `mode: 'simple'` a lie.
  assert(!CreateSimpleProductSchema.safeParse({ ...valid, type: 'digital' }).success,
    'create: type rejected (simple is physical-only)');
  assert(!CreateSimpleProductSchema.safeParse({ ...valid, mode: 'advanced' }).success,
    'create: mode rejected');
  assert(!CreateSimpleProductSchema.safeParse({ ...valid, status: 'active' }).success,
    'create: status rejected');
  assert(!CreateSimpleProductSchema.safeParse({ ...valid, serviceConfig: {} }).success,
    'create: serviceConfig rejected');
}

// ─── Update schema ────────────────────────────────────────────────────────────

{
  assert(!UpdateSimpleProductSchema.safeParse({}).success,
    'update: empty body rejected');
  assert(UpdateSimpleProductSchema.safeParse({ price: 39000 }).success,
    'update: single field accepted');
  assert(UpdateSimpleProductSchema.safeParse({ pickupLocation: null }).success,
    'update: null pickupLocation accepted (clears it)');

  const noPublish = UpdateSimpleProductSchema.safeParse({ price: 1 });
  assert(noPublish.success && noPublish.data.publish === undefined,
    'update: publish has NO default — an edit must not silently republish');

  assert(!UpdateSimpleProductSchema.safeParse({ status: 'active' }).success,
    'update: status rejected');
  assert(!UpdateSimpleProductSchema.safeParse({ mode: 'advanced' }).success,
    'update: mode rejected');
  assert(!UpdateSimpleProductSchema.safeParse({ price: 0 }).success,
    'update: price 0 rejected');
}

// ─── SKU generation ───────────────────────────────────────────────────────────

{
  const sku = generateSimpleSku('Nike Air Max 90', OID);
  assert(/^[A-Z0-9-]+$/.test(sku), 'sku: only uppercase alphanumerics and dashes');
  assert(sku.endsWith(OID.toUpperCase()), 'sku: ends with the product id');
  assert(sku.length <= 100, 'sku: within the 100-char column cap');

  assert(generateSimpleSku('Nike Air Max 90', OID) === sku, 'sku: deterministic');
  assert(generateSimpleSku('Nike Air Max 90', OID2) !== sku,
    'sku: differs across products — globally unique by construction');

  const ID = OID.toUpperCase();

  // A title with no ASCII alphanumerics must still produce a usable prefix.
  assert(generateSimpleSku('!!! ???', OID) === `ITEM-${ID}`, 'sku: punctuation-only title → ITEM');
  assert(generateSimpleSku('日本語', OID) === `ITEM-${ID}`, 'sku: CJK title → ITEM');
  assert(generateSimpleSku('Café Crème', OID) === `CAF-CR-ME-${ID}`, 'sku: accents become separators');

  const long = generateSimpleSku('A'.repeat(80), OID);
  assert(long === `${'A'.repeat(24)}-${ID}`, 'sku: prefix truncated to 24 chars');

  // The slice can land on a separator; a trailing dash would double up.
  assert(!generateSimpleSku('ab'.repeat(20), OID).includes('--'), 'sku: no doubled separator');
}

// ─── Delivery config merge ────────────────────────────────────────────────────

{
  const existing: Product['delivery'] = {
    agencyId: OID,
    freeDelivery: false,
    pickupLocation: { source: 'vendor_address', vendorAddressId: OID2, agencyAddressId: null },
  };

  // The bug this helper exists to prevent: $set replaces the whole sub-document,
  // so a patch touching one field must not wipe the others.
  const onlyFree = mergeDeliveryConfig(existing, { freeDelivery: true });
  assert(onlyFree.free_delivery === true, 'merge: freeDelivery applied');
  assert(onlyFree.agency_id === OID, 'merge: agency_id preserved');
  assert(onlyFree.pickup_location?.vendor_address_id === OID2, 'merge: pickup_location preserved');

  assert(mergeDeliveryConfig(existing, { pickupLocation: null }).pickup_location === null,
    'merge: explicit null clears pickup_location');

  const storage = mergeDeliveryConfig(existing, {
    pickupLocation: { source: 'agency_storage', vendorAddressId: OID2 },
  });
  assert(storage.pickup_location?.vendor_address_id === null,
    'merge: agency_storage forces vendor_address_id null');

  const empty = mergeDeliveryConfig(undefined, {});
  assert(empty.agency_id === null && empty.free_delivery === false && empty.pickup_location === null,
    'merge: empty existing + empty patch → all-null shape');

  assert(mergeDeliveryConfig(existing, { agencyId: null }).agency_id === null,
    'merge: explicit null clears agency_id');
}

// ─── Pickup-location derivation ───────────────────────────────────────────────

{
  const agency = (pickup: boolean, storage: boolean) => ({
    policies: { pricing: { pickup_based: { enabled: pickup }, storage_based: { enabled: storage } } },
  }) as any;
  const vendor = (addressCount: number) => ({
    business_addresses: Array.from({ length: addressCount }, () => ({ _id: new Types.ObjectId() })),
  }) as any;

  const single = derivePickupLocation(vendor(1), agency(true, false));
  assert(single.reason === 'derived_single_address', 'derive: one address + pickup agency');
  assert(single.pickupLocation?.source === 'vendor_address', 'derive: uses vendor_address');

  // The case that deliberately declines: guessing sends a courier to the wrong city.
  const many = derivePickupLocation(vendor(3), agency(true, false));
  assert(many.reason === 'multiple_addresses', 'derive: >1 address declines');
  assert(many.pickupLocation === null, 'derive: >1 address persists nothing');

  const storageOnly = derivePickupLocation(vendor(1), agency(false, true));
  assert(storageOnly.reason === 'derived_agency_storage', 'derive: storage-only agency');
  assert(storageOnly.pickupLocation?.vendor_address_id === null, 'derive: storage has no address');

  // Both on offer + one address: prefer vendor_address, since storage is a
  // standing arrangement a vendor configures deliberately.
  assert(derivePickupLocation(vendor(1), agency(true, true)).pickupLocation?.source === 'vendor_address',
    'derive: both enabled prefers vendor_address');

  assert(derivePickupLocation(vendor(0), agency(true, true)).reason === 'derived_agency_storage',
    'derive: no address falls through to storage');
  assert(derivePickupLocation(vendor(0), agency(true, false)).reason === 'no_business_address',
    'derive: pickup-only agency + no address');
  assert(derivePickupLocation(vendor(1), agency(false, false)).reason === 'agency_offers_neither',
    'derive: agency offers neither');

  // A partially-populated policies object must not throw.
  assert(derivePickupLocation(vendor(1), {} as any).reason === 'agency_offers_neither',
    'derive: missing policies treated as neither');
}

// ─── Mode guards ──────────────────────────────────────────────────────────────

{
  const product = (mode: unknown) => ({ id: OID, mode }) as unknown as Product;

  let thrown: unknown;
  try { assertNotSimpleMode(product('simple'), 'adding another variant'); } catch (e) { thrown = e; }
  assert(thrown instanceof AppError, 'guard: simple product throws AppError');
  if (thrown instanceof AppError) {
    assert(thrown.statusCode === 409, 'guard: 409');
    assert(thrown.code === ERROR_CODES.CATALOG_PRODUCT_SIMPLE_MODE_LOCKED, 'guard: correct code');
    assert(thrown.message.includes('adding another variant'), 'guard: operation in message');
    // The frontend renders its "switch to advanced" button off this.
    assert(typeof thrown.details?.convertEndpoint === 'string', 'guard: details.convertEndpoint present');
  }

  let advancedThrew = false;
  try { assertNotSimpleMode(product('advanced'), 'x'); } catch { advancedThrew = true; }
  assert(!advancedThrew, 'guard: advanced product passes');

  // Legacy documents have no `mode` key at all — they must behave as advanced.
  let legacyThrew = false;
  try { assertNotSimpleMode(product(undefined), 'x'); } catch { legacyThrew = true; }
  assert(!legacyThrew, 'guard: legacy undefined mode passes');

  let notSimpleThrown: unknown;
  try { assertSimpleMode(product('advanced')); } catch (e) { notSimpleThrown = e; }
  assert(notSimpleThrown instanceof AppError
    && notSimpleThrown.code === ERROR_CODES.CATALOG_PRODUCT_NOT_SIMPLE_MODE,
    'guard: assertSimpleMode rejects an advanced product');

  let simpleThrew = false;
  try { assertSimpleMode(product('simple')); } catch { simpleThrew = true; }
  assert(!simpleThrew, 'guard: assertSimpleMode passes a simple product');
}

// ─── Activation blockers ──────────────────────────────────────────────────────

{
  const variant = (over: Partial<Variant> = {}): Variant => ({
    id: OID2, productId: OID, sku: 'SKU-1', status: 'active', optionSignature: 'SKU-1',
    price: 1000, stock: 5, isInfiniteStock: false, lowStockThreshold: null, allowOversell: false,
    optionValueIds: [], fileIds: [], createdAt: new Date(), updatedAt: new Date(),
    ...over,
  }) as Variant;

  const product = (over: Partial<Product> = {}): Product => ({
    id: OID, vendorId: OID2, type: 'physical', mode: 'simple', status: 'draft',
    title: 'T', description: 'A description', slug: 't', category: 'c', tags: [],
    seo: {}, hasVariants: true, defaultVariantId: OID2, fileIds: [],
    delivery: { agencyId: null, freeDelivery: false, pickupLocation: { source: 'agency_storage', vendorAddressId: null } },
    vectorisationEnabled: false, vectorisationStatus: 'not_started', vectorisedDataId: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  }) as Product;

  const build = (opts: {
    variants?: Variant[];
    defaultAgencyId?: string | null;
    agencyActive?: boolean;
    connectionActive?: boolean;
  }) => new ProductStatusValidationService(
    {} as any,
    { findByProduct: async () => opts.variants ?? [variant()] } as any,
    { findById: async () => ({ default_delivery_agency_id: opts.defaultAgencyId === undefined ? OID : opts.defaultAgencyId, business_addresses: [] }) } as any,
    { findById: async () => (opts.agencyActive === false ? null : { status: 'active', policies: { pricing: { storage_based: { enabled: true } } } }) } as any,
    { findByVendorAndAgency: async () => ({ status: opts.connectionActive === false ? 'paused' : 'active' }) } as any,
  );

  const runs: Array<{ label: string; svc: ProductStatusValidationService; product: Product; expect: string[] }> = [
    {
      label: 'fully valid physical product',
      svc: build({}),
      product: product(),
      expect: [],
    },
    {
      label: 'no description',
      svc: build({}),
      product: product({ description: '  ' }),
      expect: [ERROR_CODES.CATALOG_PRODUCT_NO_DESCRIPTION],
    },
    {
      label: 'no variants',
      svc: build({ variants: [] }),
      product: product(),
      expect: [ERROR_CODES.CATALOG_PRODUCT_NO_VARIANTS, ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT],
    },
    {
      label: 'zero-priced variant',
      svc: build({ variants: [variant({ price: 0 })] }),
      product: product(),
      expect: [ERROR_CODES.CATALOG_PRODUCT_VARIANT_ZERO_PRICE],
    },
    {
      label: 'no default delivery agency',
      svc: build({ defaultAgencyId: null }),
      product: product(),
      expect: [ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY],
    },
    {
      label: 'no agency AND no pickup location — both reported at once',
      svc: build({ defaultAgencyId: null }),
      product: product({ delivery: undefined }),
      expect: [ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY, ERROR_CODES.CATALOG_PRODUCT_NO_PICKUP_LOCATION],
    },
    {
      label: 'connection not active',
      svc: build({ connectionActive: false }),
      product: product(),
      expect: [ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY],
    },
    {
      label: 'multiple independent failures',
      svc: build({ variants: [], defaultAgencyId: null }),
      product: product({ description: '' }),
      expect: [
        ERROR_CODES.CATALOG_PRODUCT_NO_DESCRIPTION,
        ERROR_CODES.CATALOG_PRODUCT_NO_VARIANTS,
        ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT,
        ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
      ],
    },
  ];

  void (async () => {
    for (const run of runs) {
      const blockers = await run.svc.collectActivationBlockers(run.product);
      assert(
        blockers.length === run.expect.length && blockers.every((b, i) => b.code === run.expect[i]),
        `blockers: ${run.label} → [${run.expect.join(', ')}] (got [${blockers.map(b => b.code).join(', ')}])`,
      );

      // Blocker messages are shown to vendors verbatim as their publish
      // checklist, so none may be a placeholder or the generic fallback.
      for (const b of blockers) {
        assert(b.message !== 'An unexpected error occurred' && b.message !== b.code.toLowerCase().replace(/_/g, ' '),
          `blockers: ${b.code} has vendor-readable copy (got "${b.message}")`);
      }

      // THE regression guard: validate() must still throw exactly what it threw
      // before it was refactored to delegate to the collector.
      let thrown: unknown;
      try { await run.svc.validate(run.product, 'active'); } catch (e) { thrown = e; }
      if (run.expect.length === 0) {
        assert(thrown === undefined, `parity: ${run.label} → validate() does not throw`);
      } else {
        assert(thrown instanceof AppError && thrown.code === run.expect[0],
          `parity: ${run.label} → validate() throws ${run.expect[0]}`);
        assert(thrown instanceof AppError && thrown.statusCode === 422,
          `parity: ${run.label} → validate() throws 422`);
      }
    }

    // A non-'active' target is a no-op, as before.
    let draftThrew = false;
    try { await build({ variants: [] }).validate(product(), 'draft'); } catch { draftThrew = true; }
    assert(!draftThrew, 'parity: validate() is a no-op for non-active targets');

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      process.exit(1);
    }
  })();
}
