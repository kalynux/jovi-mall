/**
 * Test: the two-sided stock-adjustment flow for agency-warehoused SKUs.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free.
 *
 * What is worth testing without a database, and why:
 *
 *   1. **The authority table.** `resolveAvailableActions` is the single definition of
 *      who may approve, reject or withdraw — read by the service to enforce and by
 *      the DTO to render buttons. A second copy is how a dashboard ends up offering
 *      a verb the API refuses, so the asymmetry (author ⇒ withdraw only;
 *      counterparty ⇒ approve/reject only) is pinned here.
 *   2. **`awaitingMyDecision`.** The same row must answer differently for the two
 *      viewers. Getting it backwards puts every request in the wrong inbox.
 *   3. **The warehousing predicate.** `isWarehousedBy` decides who the counterparty
 *      is. Getting it wrong lets one agency answer for another's warehouse.
 *   4. **The validators**, because `quantity` being absolute (never a delta) and
 *      required over HTTP is a contract a client depends on.
 *
 * What is NOT covered here and needs a live database: the compare-and-set on
 * resolution, the one-open-per-SKU unique index, and that approval applies the
 * variant write and the status flip in ONE transaction. See the api-doc's
 * verification section.
 *
 * Run: npx ts-node scripts/test/test-stock-requests.ts
 */
import {
  resolveAvailableActions,
  StockRequestMapper,
} from '../../src/modules/stock-requests/dto/stock-adjustment-request.dto';
import {
  CreateStockRequestSchema,
  RejectStockRequestSchema,
  StockRequestQuerySchema,
} from '../../src/modules/stock-requests/validators/stock-request.validator';
import { IStockAdjustmentRequest } from '../../src/modules/stock-requests/models/stock-adjustment-request.model';
import {
  isWarehousedBy,
  resolveEffectiveAgencyId,
} from '../../src/modules/catalog/domain/services/effective-delivery-agency';
import { Product } from '../../src/modules/catalog/repositories/mappers/product.mapper';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok = false;
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

const VENDOR = '507f1f77bcf86cd799439021';
const AGENCY_A = '507f1f77bcf86cd799439051';
const AGENCY_B = '507f1f77bcf86cd799439052';
const PRODUCT = '507f1f77bcf86cd799439031';
const VARIANT = '507f1f77bcf86cd799439041';
const REQUEST = '507f1f77bcf86cd799439061';
const USER = '507f1f77bcf86cd799439071';

const AT = new Date('2026-08-06T09:00:00.000Z');

/**
 * A request document, shaped as the mapper receives it. Only the fields the DTO
 * reads are populated — a full Mongoose document is neither needed nor available
 * without a connection.
 *
 * `overrides` is a loose record rather than `Partial<IStockAdjustmentRequest>`: ids
 * are ObjectIds on the real document and plain strings here, which is fine because
 * the mapper only ever calls `.toString()` on them.
 */
function requestDoc(overrides: Record<string, unknown> = {}): IStockAdjustmentRequest {
  return {
    _id: REQUEST,
    vendor_id: VENDOR,
    agency_id: AGENCY_A,
    product_id: PRODUCT,
    variant_id: VARIANT,
    requested_by_role: 'vendor',
    requested_by_user_id: USER,
    requested_at: AT,
    quantity_before: 120,
    infinite_before: false,
    requested_quantity: 90,
    requested_infinite: false,
    status: 'pending',
    note: null,
    approval: null,
    rejection: null,
    withdrawal: null,
    status_history: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as unknown as IStockAdjustmentRequest;
}

/** A product configured for agency storage, with an optional own-agency override. */
function storedProduct(agencyOverride: string | null): Pick<Product, 'type' | 'delivery'> {
  return {
    type: 'physical',
    delivery: {
      agencyId: agencyOverride,
      freeDelivery: false,
      pickupLocation: { source: 'agency_storage', vendorAddressId: null, agencyAddressId: null },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log('\n=== Stock adjustment requests (DB-free) ===\n');

  console.log('── The authority table ──\n');

  // The asymmetry is the whole design, lifted from ContractTermsProposal. Give the
  // author a reject and a request has two ways to die that mean different things;
  // give the counterparty a withdraw and either side can retract the other's ask.
  assert('the AUTHOR may only withdraw', () => {
    const actions = resolveAvailableActions('pending', 'vendor', 'vendor');
    return actions.length === 1 && actions[0] === 'withdraw';
  });

  assert('the COUNTERPARTY may approve or reject — never withdraw', () => {
    const actions = resolveAvailableActions('pending', 'vendor', 'agency');
    return actions.length === 2
      && actions.includes('approve')
      && actions.includes('reject')
      && !actions.includes('withdraw');
  });

  assert('the table is symmetric — an agency-raised request reads the same, mirrored', () => {
    const author = resolveAvailableActions('pending', 'agency', 'agency');
    const counterparty = resolveAvailableActions('pending', 'agency', 'vendor');
    return author.join() === 'withdraw' && counterparty.join() === 'approve,reject';
  });

  for (const status of ['approved', 'rejected', 'withdrawn'] as const) {
    assert(`a ${status} request offers NOTHING to either party`, () =>
      resolveAvailableActions(status, 'vendor', 'vendor').length === 0
      && resolveAvailableActions(status, 'vendor', 'agency').length === 0);
  }

  console.log('\n── awaitingMyDecision: one row, two viewers ──\n');

  const pending = requestDoc();

  assert('a vendor-raised request awaits the AGENCY', () =>
    StockRequestMapper.toDto(pending, 'agency').awaitingMyDecision === true);

  assert('…and does NOT await the vendor who raised it', () =>
    StockRequestMapper.toDto(pending, 'vendor').awaitingMyDecision === false);

  assert('an agency-raised request awaits the VENDOR', () => {
    const doc = requestDoc({ requested_by_role: 'agency' });
    return StockRequestMapper.toDto(doc, 'vendor').awaitingMyDecision === true
      && StockRequestMapper.toDto(doc, 'agency').awaitingMyDecision === false;
  });

  assert('a resolved request awaits nobody', () => {
    const doc = requestDoc({ status: 'approved' });
    return StockRequestMapper.toDto(doc, 'agency').awaitingMyDecision === false
      && StockRequestMapper.toDto(doc, 'vendor').awaitingMyDecision === false;
  });

  assert('the DTO\'s availableActions match the table for the SAME viewer', () => {
    const dto = StockRequestMapper.toDto(pending, 'agency');
    return dto.availableActions.join() === resolveAvailableActions('pending', 'vendor', 'agency').join();
  });

  console.log('\n── Drift: quantityBefore vs currentQuantity ──\n');

  // Two different questions. `quantityBefore` is what the PROPOSER saw;
  // `currentQuantity` is what the shelf reads now. The pair differing is drift the
  // approver needs to notice — and is deliberately not a 409, because the request
  // proposes an absolute number, so drift changes what is replaced, not whether the
  // request still makes sense.
  assert('currentQuantity is null when the caller supplied no live state', () => {
    const dto = StockRequestMapper.toDto(pending, 'agency');
    return dto.currentQuantity === null && dto.quantityBefore === 120;
  });

  assert('drift is surfaced, not hidden — before 120, now 100, target 90', () => {
    const dto = StockRequestMapper.toDto(pending, 'agency', { quantity: 100, isInfinite: false });
    return dto.quantityBefore === 120 && dto.currentQuantity === 100 && dto.requestedQuantity === 90;
  });

  console.log('\n── Outcome sub-documents ──\n');

  assert('an approval reports who, when, and what it replaced', () => {
    const dto = StockRequestMapper.toDto(requestDoc({
      status: 'approved',
      approval: { by_role: 'agency', by_user_id: USER, at: AT, quantity_at_apply: 100 },
    }), 'vendor');
    return dto.approval?.byRole === 'agency'
      && dto.approval.quantityAtApply === 100
      && dto.rejection === null
      && dto.withdrawal === null;
  });

  assert('a rejection carries its reason', () => {
    const dto = StockRequestMapper.toDto(requestDoc({
      status: 'rejected',
      rejection: { by_role: 'agency', by_user_id: USER, at: AT, reason: 'Counted 118 on the shelf' },
    }), 'vendor');
    return dto.rejection?.reason === 'Counted 118 on the shelf' && dto.approval === null;
  });

  console.log('\n── Who the counterparty is ──\n');

  assert('the product\'s OWN agency override wins over the vendor default', () =>
    resolveEffectiveAgencyId(storedProduct(AGENCY_B) as Product, AGENCY_A) === AGENCY_B);

  assert('with no override, the vendor default applies', () =>
    resolveEffectiveAgencyId(storedProduct(null) as Product, AGENCY_A) === AGENCY_A);

  assert('neither set resolves to null, not to a guess', () =>
    resolveEffectiveAgencyId(storedProduct(null) as Product, null) === null);

  assert('an agency warehouses a product whose effective agency is it', () =>
    isWarehousedBy(storedProduct(null), AGENCY_A, AGENCY_A));

  // Getting this wrong would let one agency answer for another's warehouse.
  assert('a DIFFERENT agency does not warehouse it', () =>
    !isWarehousedBy(storedProduct(null), AGENCY_A, AGENCY_B));

  assert('a vendor_address pickup is warehoused by nobody', () => {
    const product = {
      type: 'physical' as const,
      delivery: {
        agencyId: AGENCY_A,
        freeDelivery: false,
        pickupLocation: { source: 'vendor_address' as const, vendorAddressId: null, agencyAddressId: null },
      },
    };
    return !isWarehousedBy(product, AGENCY_A, AGENCY_A);
  });

  assert('a non-physical product is warehoused by nobody', () => {
    const product = { ...storedProduct(AGENCY_A), type: 'digital' as const };
    return !isWarehousedBy(product, AGENCY_A, AGENCY_A);
  });

  assert('a product with no delivery config at all is warehoused by nobody', () =>
    !isWarehousedBy({ type: 'physical', delivery: undefined }, AGENCY_A, AGENCY_A));

  console.log('\n── Validators ──\n');

  assert('a well-formed request parses', () => {
    const parsed = CreateStockRequestSchema.parse({
      productId: PRODUCT, variantId: VARIANT, quantity: 90, note: 'Counted this morning',
    });
    return parsed.quantity === 90 && parsed.note === 'Counted this morning';
  });

  // Absolute, never a delta — a delta approved three days later applies to a number
  // nobody agreed on.
  assert('quantity is REQUIRED over HTTP', () =>
    !CreateStockRequestSchema.safeParse({ productId: PRODUCT, variantId: VARIANT }).success);

  assert('quantity 0 is valid — a warehouse can be emptied', () =>
    CreateStockRequestSchema.safeParse({ productId: PRODUCT, variantId: VARIANT, quantity: 0 }).success);

  assert('a negative quantity is rejected', () =>
    !CreateStockRequestSchema.safeParse({ productId: PRODUCT, variantId: VARIANT, quantity: -1 }).success);

  assert('a fractional quantity is rejected', () =>
    !CreateStockRequestSchema.safeParse({ productId: PRODUCT, variantId: VARIANT, quantity: 1.5 }).success);

  // Accepted so the ask can be REFUSED with the right error rather than silently
  // dropped — an agency-warehoused SKU may never be unlimited.
  assert('isInfiniteStock is accepted by the schema (the service refuses it)', () =>
    CreateStockRequestSchema.safeParse({
      productId: PRODUCT, variantId: VARIANT, quantity: 0, isInfiniteStock: true,
    }).success);

  assert('a bad ObjectId is rejected', () =>
    !CreateStockRequestSchema.safeParse({ productId: 'nope', variantId: VARIANT, quantity: 5 }).success);

  assert('an unknown field is rejected — the schema is strict', () =>
    !CreateStockRequestSchema.safeParse({
      productId: PRODUCT, variantId: VARIANT, quantity: 5, delta: 3,
    }).success);

  assert('a 501-character note is rejected', () =>
    !CreateStockRequestSchema.safeParse({
      productId: PRODUCT, variantId: VARIANT, quantity: 5, note: 'x'.repeat(501),
    }).success);

  assert('reject takes an optional reason', () =>
    RejectStockRequestSchema.safeParse({}).success
    && RejectStockRequestSchema.parse({ reason: 'Counted 118' }).reason === 'Counted 118');

  console.log('\n── Inbox query ──\n');

  // Every status by default, terminal rows included: the list is the only place a
  // party learns the id of a request it raised itself.
  assert('no status filter is applied by default', () =>
    StockRequestQuerySchema.parse({}).status === undefined);

  assert('paginates like every other list here', () => {
    const q = StockRequestQuerySchema.parse({ page: '2', limit: '50' });
    return q.page === 2 && q.limit === 50;
  });

  assert('direction accepts raised_by_me and awaiting_me', () =>
    StockRequestQuerySchema.parse({ direction: 'raised_by_me' }).direction === 'raised_by_me'
    && StockRequestQuerySchema.parse({ direction: 'awaiting_me' }).direction === 'awaiting_me');

  assert('an unknown direction is rejected', () =>
    !StockRequestQuerySchema.safeParse({ direction: 'sideways' }).success);

  assert('an unknown status is rejected', () =>
    !StockRequestQuerySchema.safeParse({ status: 'superseded' }).success);

  assert('limit is capped at 100', () =>
    !StockRequestQuerySchema.safeParse({ limit: '500' }).success);

  assert('an unknown query param is rejected — the schema is strict', () =>
    !StockRequestQuerySchema.safeParse({ nope: '1' }).success);

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
