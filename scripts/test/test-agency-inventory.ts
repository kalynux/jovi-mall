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
 *   2. The **storage-fee quote** is money an agency will go and collect out-of-band, and
 *      since Step 14 it is also written onto a durable statement. Its two easy-to-break
 *      properties are that size is *displayed but never priced*, and that the quantity is
 *      the WAREHOUSED count — it used to be the catalogue quantity, and swapping those
 *      back would bill a vendor for units their agency never received.
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
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { findRemovedDepotIds } from '../../src/modules/inventory/domain/services/depot-removal.guard';
import {
  MOVEMENT_RULES,
  deltasFor,
  isAgencyWritable,
  wouldGoNegative,
} from '../../src/modules/inventory/domain/services/stock-movement.rules';
import {
  periodContaining,
  previousPeriod,
  parsePeriodKey,
} from '../../src/modules/inventory/domain/services/storage-period';
import { AgencyStockCountService } from '../../src/modules/inventory/services/agency-stock-count.service';
import { AgencyStockProjectionService } from '../../src/modules/inventory/services/agency-stock-projection.service';
import { AgencyInventoryReconciler } from '../../src/modules/inventory/domain/services/agency-inventory-reconciler';
import {
  StockReceiptSchema,
  StockCountAdjustmentSchema,
  StockTransferSchema,
} from '../../src/modules/inventory/validators/inventory.validator';
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

async function main(): Promise<void> {
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

  // ⚠ This block INVERTED at Step 14 and the inversion is the assertion. It used to read
  // "quantity comes from the CATALOGUE stock, not the (Phase-1 zero) on-hand", which was
  // right while nothing could count. Rent is owed on what is physically on a shelf.
  assert('quantity is the WAREHOUSED count, not the catalogue quantity', () =>
    resolveStorageQuantity({ onHand: 120, isCounted: true }) === 120);

  // The visible cost of D-6: no intake recorded means the platform does not know what is
  // there, and it will not invent a charge for it.
  assert('an UNCOUNTED row is billed for 0, whatever the catalogue says', () =>
    resolveStorageQuantity({ onHand: 120, isCounted: false }) === 0);

  assert('a negative balance bills 0 rather than crediting the vendor', () =>
    resolveStorageQuantity({ onHand: -5, isCounted: true }) === 0);

  assert('fee = rate × quantity', () => {
    const quote = quoteStorageFee(PRICING, { onHand: 120, isCounted: true }, null);
    return quote.monthlyEstimate === 60_000 && quote.quantity === 120 && quote.basis === 'per_sku_monthly';
  });

  // "0 due" and "not counted yet" are different sentences, and a screen that renders them
  // the same way tells an agency it is owed nothing.
  assert('the quote reports WHICH basis it used', () => {
    const counted = quoteStorageFee(PRICING, { onHand: 0, isCounted: true }, null);
    const uncounted = quoteStorageFee(PRICING, { onHand: 0, isCounted: false }, null);
    return counted.quantityBasis === 'counted' && uncounted.quantityBasis === 'uncounted';
  });

  // The whole point of the flat basis: the agency's policy holds no size dimension,
  // so size is displayed for sanity-checking and must never enter the arithmetic.
  assert('size does NOT change the fee — a pallet and an envelope cost the same', () => {
    const small = quoteStorageFee(PRICING, { onHand: 10, isCounted: true }, resolveStorageSize(PRODUCT_DIMS, null));
    const large = quoteStorageFee(PRICING, { onHand: 10, isCounted: true }, resolveStorageSize(VARIANT_DIMS, null));
    return small.monthlyEstimate === large.monthlyEstimate && small.monthlyEstimate === 5_000;
  });

  assert('storage disabled on the policy quotes 0, and says so', () => {
    const quote = quoteStorageFee({ ...PRICING, enabled: false }, { onHand: 120, isCounted: true }, null);
    return quote.monthlyEstimate === 0 && quote.storageBasedEnabled === false;
  });

  // A half-configured agency must degrade to "no fee quoted", not 500 an inventory list.
  assert('a missing policy quotes 0 rather than throwing', () => {
    const quote = quoteStorageFee(null, { onHand: 120, isCounted: true }, null);
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


  // ═══════════════════════════════════════════════════════════════════════════
  //  Step 14 · counted stock
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n── Movement rules: what each type does to the two counters ──\n');

  // The single most valuable assertion in this group. A sale takes units off the shelf AND
  // ends the hold that was on them; getting the second half wrong leaves `reserved`
  // permanently positive, which is invisible — the list still renders, the numbers are still
  // plausible, and available stock silently shrinks to nothing over a few weeks.
  assert('a sale moves BOTH counters down', () => {
    const d = deltasFor('sale', 3);
    return d.onHand === -3 && d.reserved === -3;
  });

  assert('a reservation holds units WITHOUT taking them off the shelf', () => {
    const d = deltasFor('reservation', 3);
    return d.onHand === 0 && d.reserved === 3;
  });

  // A return is NOT the inverse of a sale: the hold was consumed when the sale happened, so
  // only the shelf moves. Mirroring the sale here is the same permanent-positive bug in the
  // other direction.
  assert('a customer return moves ONLY the shelf', () => {
    const d = deltasFor('customer_return', 3);
    return d.onHand === 3 && d.reserved === 0;
  });

  assert('a release gives back the hold and nothing else', () => {
    const d = deltasFor('reservation_released', 3);
    return d.onHand === 0 && d.reserved === -3;
  });

  assert('a receipt adds to the shelf; a return to the vendor takes from it', () =>
    deltasFor('receipt', 10).onHand === 10 && deltasFor('return_to_vendor', 10).onHand === -10);

  // Every other type takes a magnitude, so passing -5 to a receipt cannot credit a shelf by
  // accident. The adjustment is the one verb where the direction is the answer.
  assert('only count_adjustment carries a SIGNED quantity', () => {
    const signed = Object.entries(MOVEMENT_RULES).filter(([, rule]) => rule.signedQuantity);
    return signed.length === 1 && signed[0][0] === 'count_adjustment'
      && deltasFor('receipt', -5).onHand === 5
      && deltasFor('count_adjustment', -5).onHand === -5;
  });

  assert('the four order-path types are SYSTEM-written and nothing else is', () => {
    const system = Object.keys(MOVEMENT_RULES).filter((t) => !isAgencyWritable(t as never)).sort();
    return system.join(',') === 'customer_return,reservation,reservation_released,sale';
  });

  // ── The asymmetry: agencies are refused below zero, the order path is not ──
  //
  // Clamping a system movement would make `quantity_on_hand === Σ deltas` false, which is the
  // one invariant the reconciler checks — and it would hide the variance for good. Refusing
  // one would fail a checkout over bookkeeping.
  assert('a movement that would go negative is detected', () =>
    wouldGoNegative({ onHand: 2, reserved: 0 }, deltasFor('return_to_vendor', 5)) === true);

  assert('a movement that fits is not', () =>
    wouldGoNegative({ onHand: 9, reserved: 0 }, deltasFor('return_to_vendor', 5)) === false);

  assert('a reserved counter going negative counts too', () =>
    wouldGoNegative({ onHand: 50, reserved: 1 }, deltasFor('reservation_released', 4)) === true);

  console.log('\n── The count verbs ──\n');

  interface FakeRow {
    _id: string;
    agency_id: string;
    variant_id: string;
    vendor_id: string;
    product_id: string;
    location_id: string | null;
    quantity_on_hand: number;
    quantity_reserved: number;
    source: 'derived' | 'counted';
  }

  function fakeRow(over: Partial<FakeRow> = {}): FakeRow {
    return {
      _id: 'row1',
      agency_id: 'ag1',
      variant_id: 'v1',
      vendor_id: 'vend1',
      product_id: 'p1',
      location_id: 'depot1',
      quantity_on_hand: 0,
      quantity_reserved: 0,
      source: 'derived',
      ...over,
    };
  }

  /**
   * A movement repository that applies the REAL rules to an in-memory row.
   *
   * Deliberately not a stub that records calls: the properties worth asserting here are
   * about what the counters end up holding, and a call-recording fake would pass a suite
   * that had the signs backwards.
   */
  function fakeMovements(row: FakeRow) {
    const written: Array<{ type: string; onHand: number; reserved: number; key: string | null }> = [];
    return {
      written,
      apply: async (input: {
        type: string;
        quantity: number;
        idempotencyKey?: string | null;
        stockLevelId: string;
      }) => {
        if (input.idempotencyKey && written.some((w) => w.key === input.idempotencyKey)) {
          return {
            movement: { _id: 'dup', stock_level_id: input.stockLevelId, on_hand_delta: 0 },
            onHand: row.quantity_on_hand,
            reserved: row.quantity_reserved,
            applied: false,
          };
        }
        const deltas = deltasFor(input.type as never, input.quantity);
        row.quantity_on_hand += deltas.onHand;
        row.quantity_reserved += deltas.reserved;
        if (isAgencyWritable(input.type as never)) row.source = 'counted';
        written.push({
          type: input.type,
          onHand: deltas.onHand,
          reserved: deltas.reserved,
          key: input.idempotencyKey ?? null,
        });
        return {
          movement: {
            _id: `m${written.length}`,
            stock_level_id: input.stockLevelId,
            on_hand_delta: deltas.onHand,
          },
          onHand: row.quantity_on_hand,
          reserved: row.quantity_reserved,
          applied: true,
        };
      },
    };
  }

  await (async () => {
    const row = fakeRow();
    const movements = fakeMovements(row);
    const service = new AgencyStockCountService(
      { findRawByIdForAgency: async () => row } as never,
      movements as never,
      {} as never,
      (fn) => fn({} as never),
    );

    const result = await service.recordReceipt({ agencyId: 'ag1', userId: 'u1' }, 'row1', { quantity: 12 });

    assert('a receipt puts units on the shelf', () => result.quantityOnHand === 12);
    // The whole of D-6 in one assertion: intake is what the platform is willing to claim a
    // quantity from, and nothing else promotes a row.
    assert('the first receipt makes the row COUNTED', () => row.source === 'counted');
  })();

  await (async () => {
    // The shelf reads 15; somebody counted 12. The verb takes what they COUNTED and works out
    // the difference — a delta-shaped API would be the wrong question to ask at a shelf, and
    // computing the difference outside the transaction would let a concurrent sale turn a
    // correction into a second error.
    const row = fakeRow({ quantity_on_hand: 15, source: 'counted' });
    const movements = fakeMovements(row);
    const service = new AgencyStockCountService(
      { findRawByIdForAgency: async () => row } as never,
      movements as never,
      {} as never,
      (fn) => fn({} as never),
    );

    const result = await service.recordCountAdjustment(
      { agencyId: 'ag1', userId: 'u1' },
      'row1',
      { countedQuantity: 12, reason: 'quarterly count' },
    );

    assert('an adjustment applies the DIFFERENCE, not the counted figure', () =>
      result.quantityOnHand === 12 && result.appliedDelta === -3);
  })();

  await (async () => {
    // "We checked, and it was right" is worth a ledger row. It is the only movement allowed
    // to be zero, and dropping it would make a completed audit indistinguishable from one
    // nobody performed.
    const row = fakeRow({ quantity_on_hand: 8, source: 'counted' });
    const movements = fakeMovements(row);
    const service = new AgencyStockCountService(
      { findRawByIdForAgency: async () => row } as never,
      movements as never,
      {} as never,
      (fn) => fn({} as never),
    );

    await service.recordCountAdjustment(
      { agencyId: 'ag1', userId: 'u1' },
      'row1',
      { countedQuantity: 8, reason: 'matches' },
    );

    assert('a count that matches still writes a movement', () =>
      movements.written.length === 1 && movements.written[0].onHand === 0);
  })();

  await (async () => {
    const source = fakeRow({ quantity_on_hand: 10, source: 'counted' });
    const destination = fakeRow({ _id: 'row2', location_id: 'depot2', source: 'counted' });
    const movements = fakeMovements(source);
    // The destination is a different row, so it needs its own counter application.
    const destMovements = fakeMovements(destination);

    const service = new AgencyStockCountService(
      {
        findRawByIdForAgency: async (id: string) => (id === 'row1' ? source : destination),
        findOrCreateCountedRow: async () => destination,
      } as never,
      {
        apply: async (input: { stockLevelId: string; type: string; quantity: number }) =>
          (input.stockLevelId === 'row1' ? movements : destMovements).apply(input as never),
      } as never,
      { findHqAddressIdsByAgencyId: async () => ['depot1', 'depot2'] } as never,
      (fn) => fn({} as never),
    );

    const result = await service.transfer(
      { agencyId: 'ag1', userId: 'u1' },
      'row1',
      { toLocationId: 'depot2', quantity: 4 },
    );

    assert('a transfer moves units out of one shelf and into the other', () =>
      result.from.quantityOnHand === 6 && result.to.quantityOnHand === 4);

    // Out first. A transfer the source cannot pay for must fail before anything is credited —
    // the reverse leaves the destination holding units that were never on any shelf.
    assert('the transfer writes OUT before IN', () =>
      movements.written[0].type === 'transfer_out' && destMovements.written[0].type === 'transfer_in');
  })();

  await (async () => {
    const service = new AgencyStockCountService(
      {} as never,
      {} as never,
      { findHqAddressIdsByAgencyId: async () => ['depot1'] } as never,
      (fn) => fn({} as never),
    );
    let code: string | null = null;
    try {
      await service.transfer({ agencyId: 'ag1', userId: null }, 'row1', {
        toLocationId: 'not-mine',
        quantity: 1,
      });
    } catch (err) {
      code = (err as { code?: string }).code ?? null;
    }
    assert('a transfer to somebody else\'s depot is refused before anything moves', () =>
      code === 'INVENTORY_LOCATION_UNKNOWN');
  })();

  console.log('\n── The order-path projection ──\n');

  await (async () => {
    const row = fakeRow({ quantity_on_hand: 10, source: 'counted' });
    const movements = fakeMovements(row);
    const projection = new AgencyStockProjectionService(
      { findCountedByVariant: async () => row } as never,
      movements as never,
    );

    await projection.reserve('cart1', [{ variantId: 'v1', quantity: 2 }]);
    assert('a checkout holds units on the shelf without removing them', () =>
      row.quantity_on_hand === 10 && row.quantity_reserved === 2);

    await projection.sell('cart1', [{ variantId: 'v1', quantity: 2 }], 'order1');
    assert('the sale takes them off it and ends the hold', () =>
      row.quantity_on_hand === 8 && row.quantity_reserved === 0);
  })();

  await (async () => {
    // A retried payment webhook is the ordinary case, not an exotic one: the gateway resends
    // until it gets a 2xx. Without the key the same units are sold off the shelf twice.
    const row = fakeRow({ quantity_on_hand: 10, source: 'counted' });
    const movements = fakeMovements(row);
    const projection = new AgencyStockProjectionService(
      { findCountedByVariant: async () => row } as never,
      movements as never,
    );

    await projection.sell('cart1', [{ variantId: 'v1', quantity: 3 }], 'order1');
    await projection.sell('cart1', [{ variantId: 'v1', quantity: 3 }], 'order1');

    assert('a replayed sale is applied ONCE', () => row.quantity_on_hand === 7);
  })();

  await (async () => {
    // D-6's other half: the platform claims nothing about a shelf nobody counted, so an order
    // must not invent a −1 for it. This is the ordinary case for an agency that has not
    // started doing intake, and it must be silent rather than an error.
    const row = fakeRow({ source: 'derived' });
    const movements = fakeMovements(row);
    const projection = new AgencyStockProjectionService(
      { findCountedByVariant: async () => null } as never,
      movements as never,
    );

    await projection.sell('cart1', [{ variantId: 'v1', quantity: 2 }], 'order1');
    assert('a DERIVED row is never touched by the order path', () =>
      movements.written.length === 0 && row.quantity_on_hand === 0);
  })();

  await (async () => {
    // Property 1 of the projection service. A depot row that cannot be written must never fail
    // the order that triggered it — the money has already moved by then.
    const projection = new AgencyStockProjectionService(
      { findCountedByVariant: async () => { throw new Error('mongo is down'); } } as never,
      {} as never,
    );
    let threw = false;
    try {
      await projection.sell('cart1', [{ variantId: 'v1', quantity: 1 }], 'order1');
    } catch {
      threw = true;
    }
    assert('a projection failure never reaches the order path', () => threw === false);
  })();

  await (async () => {
    // Keyed on the SHIPMENT, not the cart: one order can return in several parcels, and a
    // cart-keyed idempotency key would let the first swallow the rest.
    const row = fakeRow({ quantity_on_hand: 5, source: 'counted' });
    const movements = fakeMovements(row);
    const projection = new AgencyStockProjectionService(
      { findCountedByVariant: async () => row } as never,
      movements as never,
    );

    await projection.restock('ship1', [{ variantId: 'v1', quantity: 1 }]);
    await projection.restock('ship2', [{ variantId: 'v1', quantity: 1 }]);

    assert('two returned parcels of one order both restock', () => row.quantity_on_hand === 7);
  })();

  console.log('\n── Drift: the ledger is the authority ──\n');

  await (async () => {
    const rows = [
      { _id: 'a', quantity_on_hand: 10, quantity_reserved: 0 },
      { _id: 'b', quantity_on_hand: 4, quantity_reserved: 1 },
      { _id: 'c', quantity_on_hand: 0, quantity_reserved: 0 },
    ];
    const written: Array<{ id: string; onHand: number; reserved: number }> = [];

    const reconciler = new AgencyInventoryReconciler(
      {} as never,
      {} as never,
      {
        findAllRawForAgency: async () => rows,
        setCounters: async (_agencyId: string, id: string, onHand: number, reserved: number) => {
          written.push({ id, onHand, reserved });
          const row = rows.find((r) => r._id === id)!;
          row.quantity_on_hand = onHand;
          row.quantity_reserved = reserved;
        },
      } as never,
      {
        sumByStockLevels: async () => new Map([
          ['a', { onHand: 10, reserved: 0 }],   // agrees
          ['b', { onHand: 6, reserved: 1 }],    // the counter is short by 2
          // 'c' has no movements at all, and its counters are zero — uncounted, not drifted
        ]),
      } as never,
    );

    const drift = await reconciler.findDrift('ag1');
    assert('a row whose counter disagrees with its ledger is drift', () =>
      drift.length === 1 && drift[0].stockLevelId === 'b' && drift[0].ledgerOnHand === 6);

    assert('a row with no movements and no counters is NOT drift', () =>
      !drift.some((d) => d.stockLevelId === 'c'));

    const corrected = await reconciler.correctDrift('ag1');
    assert('the repair sets the counter TO the ledger', () =>
      corrected.length === 1 && written.length === 1 && written[0].onHand === 6);

    // Idempotence, and it comes from setting rather than adjusting: a repair that applied a
    // difference would double-correct on a second pass over a row still being written to.
    const again = await reconciler.findDrift('ag1');
    assert('a second pass finds nothing', () => again.length === 0);
  })();

  await (async () => {
    // The failure this check exists for: something wrote a counter without writing the ledger.
    const reconciler = new AgencyInventoryReconciler(
      {} as never,
      {} as never,
      { findAllRawForAgency: async () => [{ _id: 'a', quantity_on_hand: 7, quantity_reserved: 0 }] } as never,
      { sumByStockLevels: async () => new Map() } as never,
    );
    const drift = await reconciler.findDrift('ag1');
    assert('a non-zero counter with NO ledger at all is drift', () =>
      drift.length === 1 && drift[0].onHand === 7 && drift[0].ledgerOnHand === 0);
  })();

  console.log('\n── Storage periods ──\n');

  assert('a period is the UTC calendar month containing the instant', () => {
    const p = periodContaining(new Date('2026-08-14T12:00:00Z'));
    return p.key === '2026-08'
      && p.start.toISOString() === '2026-08-01T00:00:00.000Z'
      && p.end.toISOString() === '2026-09-01T00:00:00.000Z';
  });

  // A run on the 1st bills the month that just closed, so this is the only calculation that
  // decides what a statement is FOR.
  assert('a run on the 1st bills the month before', () =>
    previousPeriod(new Date('2026-09-01T02:00:00Z')).key === '2026-08');

  // January is the case a hand-rolled `month - 1` gets wrong.
  assert('January rolls back to December of the previous year', () =>
    previousPeriod(new Date('2026-01-01T02:00:00Z')).key === '2025-12');

  assert('a period key round-trips', () => parsePeriodKey('2026-08')?.key === '2026-08');

  assert('a malformed or impossible period key is refused', () =>
    parsePeriodKey('2026-13') === null
    && parsePeriodKey('2026-8') === null
    && parsePeriodKey('August') === null);

  console.log('\n── The schemas ──\n');

  assert('a receipt must be at least one unit', () =>
    !StockReceiptSchema.safeParse({ quantity: 0 }).success
    && StockReceiptSchema.safeParse({ quantity: 1 }).success);

  // 0 is a legitimate count — the shelf is empty — so this is the one movement schema whose
  // floor is 0 rather than 1.
  assert('a count of ZERO is legitimate', () =>
    StockCountAdjustmentSchema.safeParse({ countedQuantity: 0, reason: 'empty' }).success);

  // The one verb that moves stock with no physical event behind it. Without the reason,
  // "we miscounted" and "a box is missing" are the same row.
  assert('an adjustment REQUIRES a reason', () =>
    !StockCountAdjustmentSchema.safeParse({ countedQuantity: 5 }).success);

  assert('a transfer to the primary depot is null, not a missing field', () =>
    StockTransferSchema.safeParse({ toLocationId: null, quantity: 2 }).success);

  assert('every movement schema is strict', () =>
    !StockReceiptSchema.safeParse({ quantity: 1, extra: true }).success
    && !StockTransferSchema.safeParse({ toLocationId: null, quantity: 1, extra: true }).success);

  console.log('\n── Source scans: the invariants no behavioural test can see ──\n');

  const SRC = join(__dirname, '..', '..', 'src', 'modules', 'inventory');

  /**
   * Comments stripped, and here that is load-bearing rather than tidiness: the files below
   * DOCUMENT the rules being asserted — "no `CreditWallet` debit and no payout anywhere in
   * this module" is a sentence in the invoice model — so a scan over raw source finds every
   * word it is hunting for and fails on the prose explaining why it should not.
   *
   * (`test:connections` argues the opposite for its own scans, and both are right: there the
   * comments are tombstones naming deleted code and stripping them would hide the diff; here
   * the comments restate the rule.)
   */
  const stripComments = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const read = (...parts: string[]) => stripComments(readFileSync(join(SRC, ...parts), 'utf8'));

  const movementRepoSrc = read('repositories', 'agency-stock-movement.repository.ts');
  const stockLevelRepoSrc = read('repositories', 'agency-stock-level.repository.ts');
  const projectionSrc = read('services', 'agency-stock-projection.service.ts');
  const invoiceModelSrc = read('models', 'agency-storage-invoice.model.ts');
  const invoiceServiceSrc = read('services', 'agency-storage-invoice.service.ts');

  // ONE writer. A counter that moves without a ledger row is precisely what `findDrift`
  // reports as a bug, and the only way to keep that true is for nothing else to write it.
  assert('ONLY the two repositories write the counters — nothing else in the module', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (entry.name === 'agency-stock-movement.repository.ts') continue;
        if (entry.name === 'agency-stock-level.repository.ts') continue;
        const code = stripComments(readFileSync(full, 'utf8'));
        // A write is one of Mongo's update operators naming the field. A DTO or a read
        // model mentioning `quantity_on_hand` is fine and common.
        if (/quantity_on_hand/.test(code) && /\$set|\$inc|\$setOnInsert/.test(code)) {
          offenders.push(entry.name);
        }
      }
    };
    walk(SRC);
    if (offenders.length > 0) console.log('    unexpected counter writers:', offenders.join(', '));
    return offenders.length === 0;
  });

  assert('the projection never throws at its caller', () => {
    // Every method funnels through one private `project`, which wraps the write in try/catch.
    const body = projectionSrc.slice(projectionSrc.indexOf('private async project'));
    return body.includes('try {') && body.includes('catch (error)') && !/\bthrow\b/.test(body);
  });

  // D-6, structurally: an uncounted shelf is one the platform makes no claim about.
  assert('the projection only ever addresses COUNTED rows', () =>
    projectionSrc.includes('findCountedByVariant')
    && stockLevelRepoSrc.includes("source: 'counted'"));

  // D-7. The whole decision is that this module records rent and does not move it; a stray
  // earnings or wallet call here would make the platform a party to money it is not.
  assert('nothing in the storage-invoice path moves money', () => {
    const combined = invoiceModelSrc + invoiceServiceSrc;
    return !/EarningsLedger|earningsService|CreditWallet|creditWallet|payout|PayoutRequest/.test(combined);
  });

  assert('the storage invoice is idempotent on (agency, vendor, period)', () =>
    invoiceServiceSrc.includes('issueOnce')
    && invoiceModelSrc.includes('period_key: 1')
    && invoiceModelSrc.includes('unique: true'));

  // The reconcile is a worker now (14.1). A read path that re-derives the roster also walks
  // the movement ledger on every page load, and reintroducing it would be invisible.
  assert('the inventory read path no longer reconciles', () => {
    const serviceSrc = read('services', 'agency-inventory.service.ts');
    return !serviceSrc.includes('reconcileIfStale(');
  });

  // 14.3. It tested row existence while every quantity was 0; leaving it there once counts are
  // real means an agency can never close a depot it has emptied.
  assert('the depot guard tests QUANTITY, not row existence', () =>
    stockLevelRepoSrc.includes('quantity_on_hand: { $ne: 0 }')
    && stockLevelRepoSrc.includes('quantity_reserved: { $ne: 0 }'));

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
