/**
 * Test: the agency inventory roster — which SKUs an agency stores, at which depot,
 * what it should be charging to hold them, and whether that stock is countable.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free, and deliberately so — three rules here are pure and
 * load-bearing:
 *
 *   1. `resolveStockLocationId` decides whether a product's stock is recorded
 *      against a real building or against nothing. It differs from the ROUTING
 *      resolver (`resolveHqAddress`) in exactly one case — a dangling depot id — and
 *      that divergence is invisible in any integration test that happens to use a
 *      live depot.
 *   2. The **storage-fee quote** is money an agency will go and collect out-of-band.
 *      Its two easy-to-break properties are that size is *displayed but never
 *      priced*, and that the quantity comes from the catalogue rather than the
 *      Phase-1 on-hand counter (which is 0 and would quote every agency zero).
 *   3. The **countable-stock rule** is enforced in three places (activation gate,
 *      product update, stock-request creation) from one definition. Tested here so
 *      the three cannot drift.
 *
 * Run: npm run test:agency-inventory
 */
import mongoose from 'mongoose';
import {
  resolveStockLocationId,
  dedupeByKey,
} from '../../src/modules/inventory/domain/services/agency-inventory-reconciler';
import { findRemovedDepotIds } from '../../src/modules/inventory/domain/services/depot-removal.guard';
import { quantityAvailable } from '../../src/modules/inventory/read-models/inventory-row.resolver';
import { InventoryQuerySchema } from '../../src/modules/inventory/validators/inventory.validator';
import { resolveHqAddress } from '../../src/modules/magazin/domain/hq-address.resolver';
import { IAgencyHeadquartersAddress } from '../../src/modules/magazin/models/magazin.model';
import { DerivedStockRow } from '../../src/modules/inventory/repositories/agency-stock-level.repository';
import {
  quoteStorageFee,
  resolveStorageQuantity,
  resolveStorageSize,
} from '../../src/modules/inventory/domain/services/storage-fee.calculator';
import {
  assertCountableStockForAgencyStorage,
  infiniteStockVariantLabels,
  requiresCountableStock,
} from '../../src/modules/catalog/domain/services/agency-storage-stock.rule';

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

const DEPOT_A = '507f1f77bcf86cd799439011'; // primary
const DEPOT_B = '507f1f77bcf86cd799439012';
const DEPOT_GONE = '507f1f77bcf86cd799439099';
const VENDOR = '507f1f77bcf86cd799439021';
const PRODUCT = '507f1f77bcf86cd799439031';
const VARIANT_1 = '507f1f77bcf86cd799439041';
const VARIANT_2 = '507f1f77bcf86cd799439042';
const AGENCY = '507f1f77bcf86cd799439051';

const LIVE = [DEPOT_A, DEPOT_B];

const depotDoc = (id: string, label: string): IAgencyHeadquartersAddress =>
  ({
    _id: new mongoose.Types.ObjectId(id),
    label,
    region: 'Littoral',
    city: 'Douala',
    address_description: `${label} street`,
    support_contact: { phone: '+237600000000', email: null },
    location: null,
    geo: null,
  }) as unknown as IAgencyHeadquartersAddress;

const CURRENT_DEPOTS = [depotDoc(DEPOT_A, 'Main'), depotDoc(DEPOT_B, 'Bonabéri')];

const row = (variantId: string, locationId: string | null): DerivedStockRow => ({
  agencyId: AGENCY,
  locationId,
  vendorId: VENDOR,
  productId: PRODUCT,
  variantId,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log('\n── resolveStockLocationId — where stock is RECORDED ──\n');

  assert('no depot named → the primary (the product really is there)', () =>
    resolveStockLocationId(null, LIVE) === DEPOT_A);

  assert('undefined behaves as "none named"', () =>
    resolveStockLocationId(undefined, LIVE) === DEPOT_A);

  assert('a live depot → that depot, not the primary', () =>
    resolveStockLocationId(DEPOT_B, LIVE) === DEPOT_B);

  // THE rule. Routing sends the agent to the primary so a delivery still
  // happens; inventory must NOT claim the goods moved buildings.
  assert('a DANGLING depot → null, NOT the primary', () =>
    resolveStockLocationId(DEPOT_GONE, LIVE) === null);

  assert('an agency with no depots at all → null even with no id named', () =>
    resolveStockLocationId(null, []) === null);

  assert('an agency with no depots at all → null with an id named', () =>
    resolveStockLocationId(DEPOT_B, []) === null);

  console.log('\n── …and how that DIFFERS from routing ──\n');

  // The two resolvers agree everywhere except the dangling case. If this test
  // ever fails, one of them was "fixed" to match the other and a real
  // distinction was lost.
  assert('routing and inventory AGREE when no depot is named (both → primary)', () =>
    resolveHqAddress(CURRENT_DEPOTS, null)?._id.toString() === resolveStockLocationId(null, LIVE));

  assert('routing and inventory AGREE on a live depot', () =>
    resolveHqAddress(CURRENT_DEPOTS, DEPOT_B)?._id.toString() === resolveStockLocationId(DEPOT_B, LIVE));

  assert('routing and inventory DIVERGE on a dangling depot — this is the point', () => {
    const routed = resolveHqAddress(CURRENT_DEPOTS, DEPOT_GONE)?._id.toString();
    const recorded = resolveStockLocationId(DEPOT_GONE, LIVE);
    return routed === DEPOT_A && recorded === null;
  });

  console.log('\n── dedupeByKey — the collection\'s natural key ──\n');

  assert('two variants at one depot are two rows', () =>
    dedupeByKey([row(VARIANT_1, DEPOT_A), row(VARIANT_2, DEPOT_A)]).length === 2);

  assert('one variant at two depots is two rows', () =>
    dedupeByKey([row(VARIANT_1, DEPOT_A), row(VARIANT_1, DEPOT_B)]).length === 2);

  assert('the same (variant, depot) twice collapses to one', () =>
    dedupeByKey([row(VARIANT_1, DEPOT_A), row(VARIANT_1, DEPOT_A)]).length === 1);

  // Unresolved rows still need deduping, and null must not collide with a real id.
  assert('null location is its own key, not merged with the primary', () =>
    dedupeByKey([row(VARIANT_1, null), row(VARIANT_1, DEPOT_A)]).length === 2);

  assert('two unresolved rows for one variant collapse to one', () =>
    dedupeByKey([row(VARIANT_1, null), row(VARIANT_1, null)]).length === 1);

  console.log('\n── findRemovedDepotIds — diffed against what WILL be persisted ──\n');

  assert('keeping both depots removes nothing', () =>
    findRemovedDepotIds(CURRENT_DEPOTS, [
      { _id: new mongoose.Types.ObjectId(DEPOT_A) },
      { _id: new mongoose.Types.ObjectId(DEPOT_B) },
    ]).length === 0);

  assert('dropping one reports exactly that one', () => {
    const removed = findRemovedDepotIds(CURRENT_DEPOTS, [{ _id: new mongoose.Types.ObjectId(DEPOT_A) }]);
    return removed.length === 1 && removed[0] === DEPOT_B;
  });

  // The trap this signature exists to avoid: an id-less entry that
  // `toPersistableHeadquarters` content-matched still carries its old `_id`, so
  // diffing the REQUEST would have called it a removal and 409'd a no-op save.
  assert('an entry that kept its _id by content match is NOT a removal', () =>
    findRemovedDepotIds(CURRENT_DEPOTS, [
      { _id: new mongoose.Types.ObjectId(DEPOT_A) },
      { _id: new mongoose.Types.ObjectId(DEPOT_B) },
    ]).length === 0);

  assert('a genuinely new entry (no _id) does not mask a removal', () => {
    const removed = findRemovedDepotIds(CURRENT_DEPOTS, [
      { _id: new mongoose.Types.ObjectId(DEPOT_A) },
      {},
    ]);
    return removed.length === 1 && removed[0] === DEPOT_B;
  });

  assert('replacing every depot reports both', () =>
    findRemovedDepotIds(CURRENT_DEPOTS, [{}]).length === 2);

  assert('an agency with no depots yet removes nothing', () =>
    findRemovedDepotIds(undefined, [{}]).length === 0);

  console.log('\n── quantityAvailable ──\n');

  assert('available = on hand − reserved', () => quantityAvailable(10, 3) === 7);
  assert('fully reserved is zero', () => quantityAvailable(4, 4) === 0);
  // Phase 2 allows oversell; a negative availability would be read wrong everywhere.
  assert('oversold clamps to zero, never negative', () => quantityAvailable(2, 5) === 0);
  assert('a Phase 1 derived row is zero available', () => quantityAvailable(0, 0) === 0);

  console.log('\n── InventoryQuerySchema ──\n');

  assert('defaults to page 1, limit 20, newest first', () => {
    const q = InventoryQuerySchema.parse({});
    return q.page === 1 && q.limit === 20 && q.sortBy === 'createdAt' && q.sortDir === 'desc';
  });

  assert('numeric query params arrive as strings and coerce', () => {
    const q = InventoryQuerySchema.parse({ page: '3', limit: '50' });
    return q.page === 3 && q.limit === 50;
  });

  // The rows whose depot was deleted are the ones an agency most needs to find.
  assert('locationId accepts the literal "unassigned"', () =>
    InventoryQuerySchema.parse({ locationId: 'unassigned' }).locationId === 'unassigned');

  assert('locationId accepts a real id', () =>
    InventoryQuerySchema.parse({ locationId: DEPOT_B }).locationId === DEPOT_B);

  assert('locationId rejects anything else', () =>
    !InventoryQuerySchema.safeParse({ locationId: 'somewhere' }).success);

  assert('limit is capped at 100', () =>
    !InventoryQuerySchema.safeParse({ limit: '500' }).success);

  assert('an unknown query param is rejected — the schema is strict', () =>
    !InventoryQuerySchema.safeParse({ nope: '1' }).success);

  // ─── Storage-fee quote ─────────────────────────────────────────────────────

  console.log('\n── Storage fee: dimension precedence ──\n');

  const VARIANT_DIMS = { weight: 850, length: 30, width: 20, height: 12 };
  const PRODUCT_DIMS = { weight: 500, length: 10, width: 10, height: 10 };

  assert('the variant\'s own dimensions win over the product defaults', () => {
    const size = resolveStorageSize(VARIANT_DIMS, PRODUCT_DIMS);
    return size?.source === 'variant' && size.lengthCm === 30 && size.volumeCm3 === 7200;
  });

  assert('the product shipping-config defaults fill in when the variant has none', () => {
    const size = resolveStorageSize(null, PRODUCT_DIMS);
    return size?.source === 'product_default' && size.volumeCm3 === 1000;
  });

  assert('a variant with only a weight still counts as the variant source', () => {
    const size = resolveStorageSize({ weight: 400 }, PRODUCT_DIMS);
    return size?.source === 'variant' && size.weightG === 400 && size.volumeCm3 === null;
  });

  assert('neither side carrying dimensions yields null, not a zero-size object', () =>
    resolveStorageSize(null, null) === null);

  // Null rather than 0: this field's whole job is to be checkable against a shelf,
  // and 0 would read as a claim that the item has no volume.
  assert('a missing single dimension makes volume null, not zero', () => {
    const size = resolveStorageSize({ length: 30, width: 20 }, null);
    return size?.volumeCm3 === null;
  });

  console.log('\n── Storage fee: the quantity, and the arithmetic ──\n');

  const PRICING = {
    enabled: true,
    monthly_storage_fee_per_sku: 500,
    pick_pack_fee_per_order: 0,
    local_delivery_fee: 0,
    out_of_region_delivery_fee: 0,
  };

  assert('quantity comes from the CATALOGUE stock, not the (Phase-1 zero) on-hand', () =>
    resolveStorageQuantity({ quantity: 120, isInfinite: false }) === 120);

  // Can only be a legacy or suspended row — an active agency-stored product cannot
  // have infinite stock (the activation gate refuses it). Inventing a quantity for it
  // would be a fabricated charge.
  assert('an infinite-stock SKU is billed for 0', () =>
    resolveStorageQuantity({ quantity: 120, isInfinite: true }) === 0);

  assert('a negative quantity clamps to 0 rather than crediting the vendor', () =>
    resolveStorageQuantity({ quantity: -5, isInfinite: false }) === 0);

  assert('fee = rate × quantity', () => {
    const quote = quoteStorageFee(PRICING, { quantity: 120, isInfinite: false }, null);
    return quote.monthlyEstimate === 60_000 && quote.quantity === 120 && quote.basis === 'per_sku_monthly';
  });

  // The whole point of the flat basis: the agency's policy holds no size dimension,
  // so size is displayed for sanity-checking and must never enter the arithmetic.
  assert('size does NOT change the fee — a pallet and an envelope cost the same', () => {
    const small = quoteStorageFee(PRICING, { quantity: 10, isInfinite: false }, resolveStorageSize(PRODUCT_DIMS, null));
    const large = quoteStorageFee(PRICING, { quantity: 10, isInfinite: false }, resolveStorageSize(VARIANT_DIMS, null));
    return small.monthlyEstimate === large.monthlyEstimate && small.monthlyEstimate === 5_000;
  });

  assert('storage disabled on the policy quotes 0, and says so', () => {
    const quote = quoteStorageFee({ ...PRICING, enabled: false }, { quantity: 120, isInfinite: false }, null);
    return quote.monthlyEstimate === 0 && quote.storageBasedEnabled === false;
  });

  // A half-configured agency must degrade to "no fee quoted", not 500 an inventory list.
  assert('a missing policy quotes 0 rather than throwing', () => {
    const quote = quoteStorageFee(null, { quantity: 120, isInfinite: false }, null);
    return quote.monthlyEstimate === 0 && quote.monthlyRatePerSku === 0;
  });

  // ─── The countable-stock rule ──────────────────────────────────────────────

  console.log('\n── Agency storage requires countable stock ──\n');

  const activeInfinite = { status: 'active' as const, isInfiniteStock: true, sku: 'SKU-INF', name: 'Infinite' };
  const activeFinite = { status: 'active' as const, isInfiniteStock: false, sku: 'SKU-FIN' };
  const archivedInfinite = { status: 'archived' as const, isInfiniteStock: true, sku: 'SKU-ARC' };

  assert('an active infinite variant is reported, by its NAME when it has one', () =>
    infiniteStockVariantLabels([activeInfinite])[0] === 'Infinite');

  assert('a variant with no name falls back to its SKU', () =>
    infiniteStockVariantLabels([{ ...activeInfinite, name: undefined }])[0] === 'SKU-INF');

  // Archived variants hold nothing an agency has to shelve.
  assert('an ARCHIVED infinite variant is ignored', () =>
    infiniteStockVariantLabels([archivedInfinite]).length === 0);

  assert('every offender is reported, not just the first', () =>
    infiniteStockVariantLabels([activeInfinite, activeFinite, { ...activeInfinite, sku: 'SKU-INF2', name: undefined }]).length === 2);

  assert('a compliant product reports nothing', () =>
    infiniteStockVariantLabels([activeFinite]).length === 0);

  assert('only agency_storage is subject to the rule', () =>
    requiresCountableStock('agency_storage') && !requiresCountableStock('vendor_address'));

  assert('an unset pickup source is not subject to the rule', () =>
    !requiresCountableStock(null) && !requiresCountableStock(undefined));

  // The two write paths throw where the activation gate collects — same rule,
  // different reporting, one source.
  assert('assert… throws for agency_storage + an infinite variant', () => {
    try {
      assertCountableStockForAgencyStorage('agency_storage', [activeInfinite]);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK';
    }
  });

  assert('assert… is silent for vendor_address, infinite variant or not', () => {
    assertCountableStockForAgencyStorage('vendor_address', [activeInfinite]);
    return true;
  });

  assert('assert… is silent for agency_storage with finite stock', () => {
    assertCountableStockForAgencyStorage('agency_storage', [activeFinite]);
    return true;
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
