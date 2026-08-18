/**
 * Test: the checkout half of the storefront — stock reservation semantics and the cart's
 * write contract.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── Why a large part of this is a SOURCE SCAN ───────────────────────────────
 *
 * The stock lifecycle is three services that each need Mongo, so the arithmetic cannot be
 * exercised here directly. What *can* be pinned down without a database is the invariant the
 * whole design rests on, and it is a structural one:
 *
 *     reserve writes NO stock · commit writes it ONCE · release writes NONE
 *
 * That is not a preference. The previous code decremented at *reserve* time while the model
 * TTL-**deletes** an expired reservation — so every abandoned checkout permanently destroyed
 * the units it had decremented, because the release could never run on a row that no longer
 * existed. And `InventoryAvailabilityCalculator` computes `stock − activeReservations`,
 * which double-counts unless `stock` means physically-on-hand.
 *
 * A regression here is invisible in every other test: reserving *would* still work, orders
 * *would* still be created, and stock would just quietly drain. So the scan asserts on the
 * files themselves — the same tool `test:password-epoch` uses to prove both credential paths
 * check the epoch, and `test:system` uses to prove every worker takes the lock.
 *
 * Run: npm run test:storefront-checkout
 */
import fs from 'fs';
import path from 'path';
import { InventoryAvailabilityCalculator } from '../../src/modules/catalog/domain/services/inventory/InventoryAvailabilityCalculator';
import { OrderStockService } from '../../src/modules/orders/services/order-stock.service';
import {
    SetCartItemQuantitySchema,
    MergeCartSchema,
    QuoteCartSchema,
    CartItemVariantParamSchema,
} from '../../src/modules/cart/validators/cart.validator';
import { deliveryFeeForPickupMix } from '../../src/modules/earnings/services/earnings-quote.service';
import { IAgencyPolicies } from '../../src/modules/delivery/delivery-agency.model';

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

const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
    schema.safeParse(value).success;
const rejects = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
    !schema.safeParse(value).success;

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * The same file with comments removed.
 *
 * Every "does this file do X" assertion below must read **code**, not prose. These files
 * document the semantics they replaced — `StockReleaseService`'s header explains at length
 * that it used to `$inc` the quantity back — so a naive substring scan finds the very thing
 * the comment exists to say is gone, and fails on a correct file.
 */
const readCode = (rel: string): string =>
    read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments, incl. docblocks
        .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, without eating `https://`

const PRICING = 'modules/catalog/domain/services/pricing-inventory';

// ─── 1. Availability arithmetic ──────────────────────────────────────────────

console.log('\n── Availability ──');

const calc = new InventoryAvailabilityCalculator();

assert('available = stock − active reservations', () =>
    calc.calculate({ stock: 10, activeReservations: 3, allowOversell: false }) === 7);

assert('reservations do NOT reduce availability when oversell is on', () =>
    calc.calculate({ stock: 10, activeReservations: 3, allowOversell: true }) === 10);

assert('availability can go negative — the vendor needs to see what they owe', () =>
    calc.calculate({ stock: 2, activeReservations: 5, allowOversell: false }) === -3);

assert('no reservations means availability is just the stock', () =>
    calc.calculate({ stock: 10, activeReservations: 0, allowOversell: false }) === 10);

// ─── 2. The stock lifecycle, asserted on the source ──────────────────────────

console.log('\n── Stock lifecycle (source scan) ──');

// Code only — these files document the semantics they replaced, so a comment mentioning
// `$inc` must not read as the file doing one. See `readCode`.
const reserveSrc = readCode(`${PRICING}/StockReservationService.ts`);
const commitSrc = readCode(`${PRICING}/StockCommitService.ts`);
const releaseSrc = readCode(`${PRICING}/StockReleaseService.ts`);

assert('RESERVE writes no stock — no $inc anywhere in it', () =>
    !reserveSrc.includes('$inc'));

assert('RESERVE still refuses when the units are not there', () =>
    reserveSrc.includes('CATALOG_INSUFFICIENT_STOCK'));

assert('RESERVE measures against active reservations, not the raw counter', () =>
    reserveSrc.includes('countActiveByVariant'));

assert('RESERVE honours both vendor escapes (infinite stock, oversell)', () =>
    reserveSrc.includes('isInfiniteStock') && reserveSrc.includes('allowOversell'));

assert('COMMIT is the ONLY one of the three that decrements', () =>
    commitSrc.includes('$inc: -') && !reserveSrc.includes('$inc: -') && !releaseSrc.includes('$inc: -'));

assert('COMMIT pushes the TTL out so the audit row survives', () =>
    commitSrc.includes('COMMITTED_RESERVATION_RETENTION_DAYS') && commitSrc.includes('.commit('));

assert('RELEASE writes no stock at all — nothing was taken', () =>
    !releaseSrc.includes('$inc'));

assert('RELEASE still refuses a committed reservation (those units are sold)', () =>
    releaseSrc.includes('Cannot release committed reservation'));

assert('all three can join a caller transaction — a rolled-back order must not leave a hold', () =>
    [reserveSrc, commitSrc, releaseSrc].every((src) => src.includes('command.session')));

// ── The count that feeds availability ────────────────────────────────────────
const reservationRepoSrc = read('modules/catalog/repositories/mongo/stock-reservation.repository.mongo.ts');

assert('the active-reservation count sums QUANTITY, not rows', () =>
    reservationRepoSrc.includes("units: { $sum: '$quantity' }"));

assert('an expired-but-unswept row stops counting immediately, ahead of the TTL', () =>
    reservationRepoSrc.includes('expiresAt: { $gt: new Date() }'));

assert('commit sets status and expiresAt in ONE $set — they must never move apart', () =>
    /\$set:\s*\{\s*status:\s*'committed',\s*expiresAt/.test(reservationRepoSrc));

// ─── 3. The wiring — four moments, four call sites ───────────────────────────

console.log('\n── Stock wiring ──');

// Code only: these assert that a CALL exists, and both files discuss these operations at
// length in their comments — a prose mention must not stand in for the wiring.
const orderServiceSrc = readCode('modules/orders/order.service.ts');
const shipmentServiceSrc = readCode('modules/shipments/shipment.service.ts');

assert('checkout RESERVES, inside the order transaction', () =>
    orderServiceSrc.includes('reserveForCheckout'));

assert('payment success COMMITS', () =>
    /handlePaymentSuccess[\s\S]{0,2000}commitForOrder/.test(orderServiceSrc));

assert('a COD order commits at CREATION — it fulfils before payment', () =>
    /cash_on_delivery'\)\s*\{[\s\S]{0,400}commitForOrder/.test(orderServiceSrc));

assert('cancelling RELEASES', () => orderServiceSrc.includes('releaseForOrder'));

assert('a RETURNED shipment restocks — a release would silently no-op on a committed row', () =>
    shipmentServiceSrc.includes('restockForShipment'));

assert('the unpaid-order worker no longer claims stock is unreserved', () => {
    const worker = read('modules/orders/workers/unpaid-order-cancel.worker.ts');
    return !/Stock is not reserved at order creation/.test(worker);
});

// ─── 4. The reservation id ───────────────────────────────────────────────────

console.log('\n── Reservation id ──');

assert('the id is derived from cart + variant, so commit can reconstruct it', () =>
    OrderStockService.reservationIdFor('cart1', 'variantA') === 'cart1:variantA');

assert('it is deterministic — the same pair is the same idempotency key', () =>
    OrderStockService.reservationIdFor('c', 'v') === OrderStockService.reservationIdFor('c', 'v'));

assert('different variants in one cart get different ids', () =>
    OrderStockService.reservationIdFor('c', 'v1') !== OrderStockService.reservationIdFor('c', 'v2'));

assert('the same variant in two carts gets different ids', () =>
    OrderStockService.reservationIdFor('c1', 'v') !== OrderStockService.reservationIdFor('c2', 'v'));

// ─── 5. Cart write contract ──────────────────────────────────────────────────

console.log('\n── Cart writes ──');

assert('a quantity of 1 is the floor — DELETE removes a line, not quantity 0', () =>
    accepts(SetCartItemQuantitySchema, { quantity: 1 }) &&
    rejects(SetCartItemQuantitySchema, { quantity: 0 }));

assert('a negative quantity is refused', () => rejects(SetCartItemQuantitySchema, { quantity: -1 }));
assert('a fractional quantity is refused', () => rejects(SetCartItemQuantitySchema, { quantity: 1.5 }));
assert('an absurd quantity is bounded — quantity × price is money', () =>
    rejects(SetCartItemQuantitySchema, { quantity: 100000 }));

assert('the variant param must be a real ObjectId', () =>
    accepts(CartItemVariantParamSchema, { variantId: '507f1f77bcf86cd799439077' }) &&
    rejects(CartItemVariantParamSchema, { variantId: 'v1' }));

assert('merge defaults to summing — both carts are the shopper\'s own', () =>
    MergeCartSchema.parse({ items: [] }).strategy === 'sum');

assert('all three merge strategies are accepted', () =>
    ['sum', 'replace', 'keep_server'].every((strategy) =>
        accepts(MergeCartSchema, { items: [], strategy })));

assert('an unknown merge strategy is refused', () =>
    rejects(MergeCartSchema, { items: [], strategy: 'newest_wins' }));

assert('merge REFUSES a client-supplied price — it would let a caller name their own', () => {
    const parsed = MergeCartSchema.parse({
        items: [{ productId: '507f1f77bcf86cd799439066', variantId: '507f1f77bcf86cd799439077', quantity: 1, price: 1 }],
    });
    return !('price' in parsed.items[0]);
});

assert('merge is capped — the body is untrusted localStorage data', () => {
    const line = { productId: '507f1f77bcf86cd799439066', variantId: '507f1f77bcf86cd799439077', quantity: 1 };
    return rejects(MergeCartSchema, { items: Array.from({ length: 101 }, () => line) });
});

assert('merge ids must be ObjectIds — a mock id like "p1" cannot reach a query', () =>
    rejects(MergeCartSchema, { items: [{ productId: 'p1', variantId: 'v1', quantity: 1 }] }));

assert('quote accepts no address (the cart opens before one is chosen)', () =>
    accepts(QuoteCartSchema, {}));
assert('quote refuses a malformed address id', () =>
    rejects(QuoteCartSchema, { deliveryAddressId: 'home' }));

// ─── 6. The delivery-fee formula is shared, not copied ───────────────────────

console.log('\n── Delivery fee ──');

const policies = (over: Partial<IAgencyPolicies['pricing']> = {}): IAgencyPolicies =>
    ({
        pricing: {
            pickup_based: { base_rate_first_kg: 1500, additional_per_kg: 0, out_of_region_surcharge: 0 },
            storage_based: {
                local_delivery_fee: 800,
                pick_pack_fee_per_order: 200,
                out_of_region_delivery_fee: 0,
                monthly_storage_fee_per_sku: 50,
            },
            ...over,
        },
    } as unknown as IAgencyPolicies);

assert('a pickup-only delivery charges the pickup base rate', () =>
    deliveryFeeForPickupMix(policies(), { hasPickupBased: true, hasStorageBased: false }) === 1500);

assert('a storage-only delivery charges local delivery + pick/pack', () =>
    deliveryFeeForPickupMix(policies(), { hasPickupBased: false, hasStorageBased: true }) === 1000);

assert('a MIXED delivery charges both — real distinct work happens for each', () =>
    deliveryFeeForPickupMix(policies(), { hasPickupBased: true, hasStorageBased: true }) === 2500);

assert('an unclassifiable delivery charges nothing rather than guessing', () =>
    deliveryFeeForPickupMix(policies(), { hasPickupBased: false, hasStorageBased: false }) === 0);

assert('monthly storage rent is NOT folded into a per-order fee', () =>
    deliveryFeeForPickupMix(policies(), { hasPickupBased: false, hasStorageBased: true }) === 1000);

assert('the split delegates to the shared formula rather than keeping a copy', () => {
    const quoteSrc = readCode('modules/earnings/services/earnings-quote.service.ts');
    // One definition of the arithmetic: the shipment path classifies, then defers. The
    // negative half is the load-bearing one — a re-inlined `shipmentFee +=` would be a
    // second copy, and a quote drifting from a charge is exactly what this guards.
    return (
        quoteSrc.includes('return deliveryFeeForPickupMix(policies, mix)') &&
        !/shipmentFee \+=/.test(quoteSrc)
    );
});

assert('the cart quote uses that same formula', () => {
    const quoteService = readCode('modules/orders/services/cart-quote.service.ts');
    return quoteService.includes('deliveryFeeForPickupMix');
});

assert('the customer total does NOT include delivery — the vendor absorbs it', () => {
    const quoteService = readCode('modules/orders/services/cart-quote.service.ts');
    // `delivery: 0` and `total: subtotal` are the honest pair while splitOrder computes
    // vendorNet = gross − commission − deliveryTotal off the items subtotal. Charging the
    // customer as well would collect the fee twice.
    return quoteService.includes('delivery: 0') && quoteService.includes('total: subtotal');
});

// ─── 7. Checkout refuses an undeliverable physical order ─────────────────────

console.log('\n── Checkout guards ──');

assert('a physical checkout with no geocoded drop-off is refused', () =>
    orderServiceSrc.includes('ORDER_DELIVERY_ADDRESS_REQUIRED'));

assert('the refusal distinguishes "none chosen" from "chosen but not geocoded"', () =>
    orderServiceSrc.includes('selected_address_not_geocoded') &&
    orderServiceSrc.includes('no_delivery_address'));

assert('booking availability now applies the publishable filter', () => {
    // The route is unauthenticated and used `findByIdUnscoped` with a `type` check only, so
    // a logged-out caller could read a draft product's whole appointment book.
    const booking = readCode('modules/catalog/domain/services/booking/ProductBookingService.ts');
    return booking.includes('isPublishableProduct(product)');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
