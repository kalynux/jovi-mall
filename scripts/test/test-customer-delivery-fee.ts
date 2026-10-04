/**
 * Test: customer-paid delivery — the core money path (ADR-A11, W-C, 2026-10-03).
 *
 * Plain ts-node, hand-rolled asserts, DB-free: the pricing core is pure, and the earnings split
 * is driven against fake repositories with the transaction manager stubbed to run inline.
 *
 *   1. Who pays: the shop's terms, and the D-6 cap fallback (+ its shortfall).
 *   2. Totals: total = items + customer-paid delivery; absorbedByVendor for vendor-paid.
 *   3. Weight (D-4): snapshot weight, item-count fallback, per-kg growth.
 *   4. Region: surcharge only when both regions are known and differ.
 *   5. The one refusal left: customer-paid delivery that still leaves the vendor ≤ 0.
 *   6. The fee precedence: override → checkout snapshot → formula (weight + region).
 *   7. splitOrder, both payers: vendor net, gross_snapshot = items, reconciliation.
 *   8. splitCodCollection, both payers: COD fee on items only (D-5), cash reconciliation.
 *   9. splitShipmentDelivery RTO: the leftover goes to the customer on a customer-paid run.
 *  10. The expected COD amount and its pure twin agree, payer-aware.
 *  11. NET_FORMULA's residual stays exact for a customer-paid sale.
 *  12. Source scans: quote == checkout (one pricing path), checkout snapshots, proposals refuse.
 *
 * Run: npm run test:customer-delivery-fee
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { priceVendorOrder, PricingLine } from '../../src/modules/orders/domain/vendor-order-pricing';
import {
  collectionBreakdownOf,
  customerDeliveryFeeOf,
  deliveryFeeShares,
  deliveryPayerOf,
  orderItemsGrossOf,
  rtoLeftoverShares,
} from '../../src/modules/orders/domain/delivery-payer';
import { resolveItemWeightGrams } from '../../src/modules/earnings/domain/delivery-pricing';
import { EARNINGS_CONFIG } from '../../src/modules/earnings/config/earnings.config';
import { EarningsQuoteService } from '../../src/modules/earnings/services/earnings-quote.service';
import { EarningsSplitService } from '../../src/modules/earnings/services/earnings-split.service';
import { transactionManager } from '../../src/core/database/transaction.manager';
import { expectedCodAmount } from '../../src/modules/cod/domain/cod-limits';
import { CashCollectionService } from '../../src/modules/cod/services/cash-collection.service';
import { vendorSaleBreakdown } from '../../src/modules/vendors/analytics/net-revenue';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { categoryFor, ERROR_CATEGORIES } from '../../src/core/error-category';
import { vendorDeliveryTermsOf } from '../../src/modules/vendors/domain/delivery-terms';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };
let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).stack ?? (err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    originalConsole.log(`  ✅ ${name}`);
    passed++;
  } else {
    originalConsole.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}
const section = (t: string) => originalConsole.log(`\n${t}`);

const SRC = join(__dirname, '../../src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function spanOf(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`span start not found: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`span end not found: ${end}`);
  return src.slice(a, b);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function policies(over: Record<string, unknown> = {}): any {
  return {
    pricing: {
      pickup_based: { base_rate_first_kg: 1000, additional_per_kg: 200, out_of_region_surcharge: 500 },
      storage_based: { local_delivery_fee: 800, pick_pack_fee_per_order: 100, out_of_region_delivery_fee: 1500, monthly_storage_fee_per_sku: 0 },
      additional_fees: { cod_handling_fee: { type: 'percentage', value: 2 }, failed_delivery_fee: 0, rto_fee: 600 },
      max_fee_per_shipment: null,
      ...over,
    },
  };
}

function line(over: Partial<PricingLine> = {}): PricingLine {
  return {
    unitPrice: 10_000,
    quantity: 1,
    floorPrice: null,
    agencyId: A,
    pickupSource: 'vendor_address',
    pickupRegion: 'Littoral',
    unitWeightGrams: 1000,
    ...over,
  };
}

function facts(over: Record<string, unknown> = {}): any {
  return {
    paymentMethod: 'online',
    deliveryRegion: 'Littoral',
    terms: vendorDeliveryTermsOf(null),
    commissionPercent: 10,
    policiesByAgency: new Map([[A, policies()], [B, policies()]]),
    flatFeeFallback: 0,
    ...over,
  };
}

const terms = (mode: 'always' | 'never' | 'above', free_above_amount: number | null = null) =>
  vendorDeliveryTermsOf({ mode, free_above_amount });

// ─── Split harness ───────────────────────────────────────────────────────────

(transactionManager as any).runInTransaction = async (fn: (s: unknown) => unknown) => fn(undefined);

interface Harness {
  service: EarningsSplitService;
  allocations: any[];
  snapshots: Map<string, number>;
  refundable: Map<string, number>;
}

function harness(opts: { shipments: any[]; commissionPercent: number; agentSharePercent?: number }): Harness {
  const allocations: any[] = [];
  const snapshots = new Map<string, number>();
  const refundable = new Map<string, number>();
  const allocationRepo: any = {
    existsForSource: async () => false,
    findBySource: async () => [],
    create: async (input: any) => {
      allocations.push(input);
      return { ...input, _id: `alloc-${allocations.length}` };
    },
  };
  const accounts: any = { holdInSession: async () => undefined };
  const entitlements: any = { getEntitlements: async () => ({ commissionPercent: opts.commissionPercent }) };
  const shipmentRepo: any = {
    findByOrderId: async () => opts.shipments,
    findById: async (id: string) => opts.shipments.find((s) => String(s._id) === id) ?? null,
    setDeliveryFeeSnapshots: async (m: Map<string, number>) => m.forEach((v, k) => snapshots.set(k, v)),
    setCustomerFeeRefundable: async (m: Map<string, number>) => m.forEach((v, k) => refundable.set(k, v)),
  };
  const agencyRepo: any = {
    findByIds: async (ids: string[]) => ids.map((id) => ({ _id: id, policies: policies() })),
    findById: async (id: string) => ({ _id: id, policies: policies() }),
  };
  const contracts: any = {
    findLive: async () => ({ _id: 'c1', fee_split: { model: 'percentage', agent_share_percent: opts.agentSharePercent ?? 50 } }),
  };
  const quotes = new EarningsQuoteService(agencyRepo, contracts);
  const service = new EarningsSplitService(allocationRepo, accounts, entitlements, shipmentRepo, agencyRepo, contracts, quotes);
  return { service, allocations, snapshots, refundable };
}

const oid = (id: string) => ({ toString: () => id, equals: (o: any) => String(o) === id });

function order(over: Record<string, unknown> = {}): any {
  return {
    _id: oid('o1'),
    vendor_id: oid('v1'),
    order_type: 'physical',
    payment_method: 'online',
    currency: 'XAF',
    items: [{ _id: oid('i1'), price: 10_000, quantity: 1, floor_price_snapshot: null, weight_grams: 1000, delivery: { pickup_location: { source: 'vendor_address' } } }],
    price_breakdown: { base: 10_000, delivery: 0, tax: 0, discount: 0, total: 10_000 },
    total_amount: 10_000,
    delivery_payer: 'vendor',
    delivery_address: { components: { region: 'Littoral' } },
    completion: null,
    ...over,
  };
}

function shipment(over: Record<string, unknown> = {}): any {
  return {
    _id: oid('s1'),
    order_id: oid('o1'),
    agency_id: oid(A),
    agent_id: oid('agent1'),
    status: 'agent_delivered',
    items: [{ order_item_id: oid('i1'), quantity: 1 }],
    delivery_fee_snapshot: 1000,
    delivery_fee_override: null,
    delivery_payer: 'vendor',
    customer_delivery_fee: 0,
    ...over,
  };
}

const amountOf = (allocs: any[], type: string) =>
  allocs.filter((a) => a.beneficiary_type === type && a.amount > 0).reduce((s, a) => s + a.amount, 0);
const written = (allocs: any[]) => allocs.filter((a) => a.amount > 0);

async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  section('1. Who pays — the shop terms, and the D-6 cap fallback');

  await assert('always ⇒ vendor (shop_always)', () => {
    const p = priceVendorOrder([line()], facts({ terms: terms('always') }));
    return p.payer === 'vendor' && p.payerReason === 'shop_always' && p.freeDeliveryShortfall === null;
  });
  await assert('never ⇒ customer (shop_never), no shortfall to offer', () => {
    const p = priceVendorOrder([line()], facts({ terms: terms('never') }));
    return p.payer === 'customer' && p.payerReason === 'shop_never' && p.freeDeliveryShortfall === null;
  });
  await assert('above, met (inclusive) ⇒ vendor (shop_threshold_met)', () => {
    const p = priceVendorOrder([line()], facts({ terms: terms('above', 10_000) }));
    return p.payer === 'vendor' && p.payerReason === 'shop_threshold_met';
  });
  await assert('above, not met ⇒ customer (threshold_not_met), shortfall = threshold − subtotal', () => {
    const p = priceVendorOrder([line()], facts({ terms: terms('above', 15_000) }));
    return p.payer === 'customer' && p.payerReason === 'threshold_not_met' && p.freeDeliveryShortfall === 5_000;
  });
  await assert('vendor-paid that fails the 30% cap ⇒ CUSTOMER pays (cap_fallback), never a refusal', () => {
    // 2 000 of goods, 1 000 fee: 1 000 × 100 > 30 × 2 000.
    const p = priceVendorOrder([line({ unitPrice: 2_000 })], facts({ terms: terms('always') }));
    return p.payer === 'customer' && p.payerReason === 'cap_fallback'
      && p.capCheck !== null && !p.capCheck.met
      && p.deliveryMinimum !== null && p.deliveryMinimum.met;
  });
  await assert('… and its shortfall is the cap\'s ("add 1 334 for free delivery")', () => {
    const p = priceVendorOrder([line({ unitPrice: 2_000 })], facts({ terms: terms('always') }));
    return p.freeDeliveryShortfall === 3_334 - 2_000;
  });
  await assert('… COD: a small shipment of a large order falls the WHOLE vendor order back (one payer per vendor order)', () => {
    const p = priceVendorOrder(
      [line({ unitPrice: 20_000 }), line({ unitPrice: 1_000, agencyId: B })],
      facts({ terms: terms('always'), paymentMethod: 'cash_on_delivery' }),
    );
    return p.payer === 'customer' && p.payerReason === 'cap_fallback' && p.deliveryCharged === p.deliveryFeeTotal;
  });
  await assert('a customer-paid part never runs the cap (capCheck null)', () =>
    priceVendorOrder([line({ unitPrice: 500 })], facts({ terms: terms('never') })).capCheck === null);
  await assert('lenient (commission unknown): payer from the terms alone, minimum NOT evaluated', () => {
    const p = priceVendorOrder([line({ unitPrice: 500 })], facts({ commissionPercent: null }));
    return p.payer === 'vendor' && p.capCheck === null && p.deliveryMinimum === null;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('2. Totals');

  await assert('customer-paid: total = items + Σ shipment fees; absorbedByVendor 0', () => {
    const p = priceVendorOrder([line(), line({ agencyId: B })], facts({ terms: terms('never') }));
    return p.itemsSubtotal === 20_000 && p.deliveryFeeTotal === 2_000 && p.deliveryCharged === 2_000
      && p.total === 22_000 && p.absorbedByVendor === 0;
  });
  await assert('vendor-paid: total = items; the fee is absorbedByVendor', () => {
    const p = priceVendorOrder([line(), line({ agencyId: B })], facts());
    return p.total === 20_000 && p.deliveryCharged === 0 && p.absorbedByVendor === 2_000;
  });
  await assert('one fee per agency: two lines on one agency ⇒ ONE shipment (fee grows with weight, 2 kg)', () => {
    const p = priceVendorOrder([line(), line()], facts({ terms: terms('never') }));
    return p.shipments.length === 1 && p.shipments[0].fee === 1_200 && p.shipments[0].weightGrams === 2_000;
  });
  await assert('a line with no resolvable agency counts in the subtotal and rides no shipment', () => {
    const p = priceVendorOrder([line(), line({ agencyId: null })], facts({ terms: terms('never') }));
    return p.itemsSubtotal === 20_000 && p.shipments.length === 1;
  });
  await assert('an agency with no pricing policy charges the flat fallback, components null', () => {
    const p = priceVendorOrder([line()], facts({ terms: terms('never'), policiesByAgency: new Map(), flatFeeFallback: 700 }));
    return p.deliveryFeeTotal === 700 && p.shipments[0].components === null;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('3. Weight (D-4)');

  await assert('a weightless unit counts as DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS (item-count fallback)', () => {
    const w = resolveItemWeightGrams({ variantWeight: 0, shippingConfigWeight: null });
    return w.source === 'default' && w.grams === EARNINGS_CONFIG.DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS;
  });
  await assert('variant weight wins over the shipping config', () =>
    resolveItemWeightGrams({ variantWeight: 2500, shippingConfigWeight: 400 }).source === 'variant');
  await assert('3 × 1.2 kg ⇒ 4 kg billed ⇒ 1 000 + 3 × 200', () => {
    const p = priceVendorOrder([line({ quantity: 3, unitWeightGrams: 1200 })], facts({ terms: terms('never') }));
    return p.shipments[0].fee === 1_600 && p.shipments[0].components?.kg === 4;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('4. Region');

  await assert('pickup Centre, drop-off Littoral ⇒ out-of-region surcharge', () => {
    const p = priceVendorOrder([line({ pickupRegion: 'Centre' })], facts({ terms: terms('never') }));
    return p.shipments[0].outOfRegion && p.shipments[0].fee === 1_500;
  });
  await assert('drop-off region unknown ⇒ in-region (never guessed against the customer)', () => {
    const p = priceVendorOrder([line({ pickupRegion: 'Centre' })], facts({ terms: terms('never'), deliveryRegion: null }));
    return !p.shipments[0].outOfRegion && p.shipments[0].fee === 1_000;
  });
  await assert('a depot (storage) in another region charges the out-of-region delivery fee', () => {
    const p = priceVendorOrder([line({ pickupSource: 'agency_storage', pickupRegion: 'Centre' })], facts({ terms: terms('never') }));
    return p.shipments[0].fee === 1_500 + 100;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('5. The one refusal left — customer-paid that still leaves the vendor ≤ 0');

  await assert('commission 100% ⇒ deliveryMinimum.met false (ORDER_BELOW_DELIVERY_MINIMUM at checkout)', () => {
    const p = priceVendorOrder([line()], facts({ terms: terms('never'), commissionPercent: 100 }));
    return p.deliveryMinimum !== null && !p.deliveryMinimum.met && p.deliveryMinimum.units[0].reason === 'vendor_net_not_positive';
  });
  await assert('customer-paid ignores the 30% ratio: a 500 basket with a 1 000 fee is accepted', () => {
    const p = priceVendorOrder([line({ unitPrice: 500 })], facts({ terms: terms('never') }));
    return p.deliveryMinimum?.met === true && p.total === 1_500;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('6. computeShipmentDeliveryFee — override → checkout snapshot → formula');

  const quotes = new EarningsQuoteService({} as never, {} as never);
  const items = new Map([['i1', order().items[0]]]);
  await assert('the vendor-approved override wins', () =>
    quotes.computeShipmentDeliveryFee(shipment({ delivery_fee_override: { amount: 777 } }), policies(), items, 'o1') === 777);
  await assert('then the CHECKOUT snapshot (not today\'s policy)', () =>
    quotes.computeShipmentDeliveryFee(shipment({ delivery_fee_snapshot: 1_234 }), policies(), items, 'o1') === 1_234);
  await assert('then the formula, with the snapshotted weight', () => {
    const heavy = new Map([['i1', { ...order().items[0], weight_grams: 2_500 }]]);
    return quotes.computeShipmentDeliveryFee(shipment({ delivery_fee_snapshot: null }), policies(), heavy, 'o1') === 1_400;
  });
  await assert('… and the region of the vendor-address snapshot against the drop-off', () => {
    const away = new Map([['i1', { ...order().items[0], delivery: { pickup_location: { source: 'vendor_address', address_snapshot: { geo: { components: { region: 'Centre' } } } } } }]]);
    return quotes.computeShipmentDeliveryFee(shipment({ delivery_fee_snapshot: null }), policies(), away, 'o1', 'Littoral') === 1_500;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('7. splitOrder — both payers');

  await assert('vendor-paid: vendorNet = items − commission − fee; gross_snapshot = items', async () => {
    const h = harness({ shipments: [shipment()], commissionPercent: 10 });
    await h.service.splitOrder(order());
    const vendor = h.allocations.find((a) => a.beneficiary_type === 'vendor');
    return vendor.amount === 10_000 - 1_000 - 1_000 && vendor.gross_snapshot === 10_000
      && amountOf(h.allocations, 'platform') === 1_000 && h.snapshots.get('s1') === 1_000;
  });
  await assert('customer-paid: no delivery deduction, commission on ITEMS only (D-3)', async () => {
    const h = harness({ shipments: [shipment({ delivery_payer: 'customer', customer_delivery_fee: 1_000 })], commissionPercent: 10 });
    await h.service.splitOrder(order({
      delivery_payer: 'customer',
      total_amount: 11_000,
      price_breakdown: { base: 10_000, delivery: 1_000, tax: 0, discount: 0, total: 11_000 },
    }));
    const vendor = h.allocations.find((a) => a.beneficiary_type === 'vendor');
    return vendor.amount === 9_000 && vendor.gross_snapshot === 10_000 && amountOf(h.allocations, 'platform') === 1_000;
  });
  await assert('customer-paid reconciles: total = commission + vendor + Σ reserved fees', async () => {
    const h = harness({ shipments: [shipment({ delivery_payer: 'customer', customer_delivery_fee: 1_000 })], commissionPercent: 10 });
    await h.service.splitOrder(order({ delivery_payer: 'customer', total_amount: 11_000, price_breakdown: { base: 10_000, delivery: 1_000, tax: 0, discount: 0, total: 11_000 } }));
    const sum = written(h.allocations).reduce((s, a) => s + a.amount, 0);
    return sum + (h.snapshots.get('s1') ?? 0) === 11_000;
  });
  await assert('the split KEEPS the checkout snapshot (no live recompute over it)', async () => {
    const h = harness({ shipments: [shipment({ delivery_fee_snapshot: 1_111 })], commissionPercent: 10 });
    await h.service.splitOrder(order());
    return h.snapshots.get('s1') === 1_111;
  });
  await assert('a customer fee above the fee charged is recorded refundable, not allocated', async () => {
    const h = harness({ shipments: [shipment({ delivery_payer: 'customer', customer_delivery_fee: 1_000, delivery_fee_override: { amount: 800 } })], commissionPercent: 10 });
    await h.service.splitOrder(order({ delivery_payer: 'customer', total_amount: 11_000, price_breakdown: { base: 10_000, delivery: 1_000, tax: 0, discount: 0, total: 11_000 } }));
    return h.refundable.get('s1') === 200;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('8. splitCodCollection — both payers, COD fee on items only (D-5)');

  const collection = (over: Record<string, unknown> = {}): any => ({
    _id: oid('col1'),
    shipment_id: oid('s1'),
    agency_id: oid(A),
    agent_id: oid('agent1'),
    currency: 'XAF',
    expected_amount: 10_000,
    items_amount: 10_000,
    delivery_fee_amount: 0,
    ...over,
  });
  const codOrder = (over: Record<string, unknown> = {}) => order({ payment_method: 'cash_on_delivery', ...over });

  await assert('customer-paid COD: vendorNet = items − commission − codFee(2% of ITEMS)', async () => {
    const h = harness({ shipments: [shipment({ delivery_payer: 'customer', customer_delivery_fee: 1_000 })], commissionPercent: 10 });
    await h.service.splitCodCollection(codOrder({ delivery_payer: 'customer' }), collection({ expected_amount: 11_000, delivery_fee_amount: 1_000 }));
    return amountOf(h.allocations, 'vendor') === 10_000 - 1_000 - 200
      && amountOf(h.allocations, 'agency') === 1_000 - 500 + 200
      && amountOf(h.allocations, 'agent') === 500;
  });
  await assert('… and the cash reconciles exactly: Σ allocations = expected_amount', async () => {
    const h = harness({ shipments: [shipment({ delivery_payer: 'customer', customer_delivery_fee: 1_000 })], commissionPercent: 10 });
    await h.service.splitCodCollection(codOrder({ delivery_payer: 'customer' }), collection({ expected_amount: 11_000, delivery_fee_amount: 1_000 }));
    return written(h.allocations).reduce((s, a) => s + a.amount, 0) === 11_000
      && h.allocations.every((a) => a.gross_snapshot === 10_000);
  });
  await assert('vendor-paid COD: the vendor bears the fee and the COD fee (unchanged)', async () => {
    const h = harness({ shipments: [shipment()], commissionPercent: 10 });
    await h.service.splitCodCollection(codOrder(), collection());
    return amountOf(h.allocations, 'vendor') === 10_000 - 1_000 - 1_000 - 200
      && written(h.allocations).reduce((s, a) => s + a.amount, 0) === 10_000;
  });
  await assert('the COD fee is NOT computed on the delivery cash (2% × 10 000, not × 11 000)', async () => {
    const h = harness({ shipments: [shipment({ delivery_payer: 'customer', customer_delivery_fee: 1_000 })], commissionPercent: 0, agentSharePercent: 0 });
    await h.service.splitCodCollection(codOrder({ delivery_payer: 'customer' }), collection({ expected_amount: 11_000, delivery_fee_amount: 1_000 }));
    return amountOf(h.allocations, 'agency') === 1_000 + 200;
  });
  await assert('a legacy collection (no breakdown) reads as all goods', () => {
    const b = collectionBreakdownOf({ expected_amount: 9_000 });
    return b.itemsAmount === 9_000 && b.deliveryFeeAmount === 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('9. splitShipmentDelivery — the RTO leftover');

  await assert('customer-paid return: NO vendor row; the leftover is recorded owed to the customer', async () => {
    const h = harness({ shipments: [], commissionPercent: 10 });
    const s = shipment({ status: 'returned', delivery_payer: 'customer', customer_delivery_fee: 1_000 });
    await h.service.splitShipmentDelivery(order({ delivery_payer: 'customer' }), s, 'returned');
    return amountOf(h.allocations, 'vendor') === 0 && h.refundable.get('s1') === 400
      && amountOf(h.allocations, 'agency') + amountOf(h.allocations, 'agent') === 600;
  });
  await assert('vendor-paid return: the vendor gets the leftover back (unchanged)', async () => {
    const h = harness({ shipments: [], commissionPercent: 10 });
    await h.service.splitShipmentDelivery(order(), shipment({ status: 'returned' }), 'returned');
    return amountOf(h.allocations, 'vendor') === 400 && !h.refundable.has('s1');
  });
  await assert('a delivered customer-paid run divides the whole reserved fee, refunds nothing', async () => {
    const h = harness({ shipments: [], commissionPercent: 10 });
    await h.service.splitShipmentDelivery(order({ delivery_payer: 'customer' }), shipment({ delivery_payer: 'customer', customer_delivery_fee: 1_000 }), 'delivered');
    return amountOf(h.allocations, 'agency') + amountOf(h.allocations, 'agent') === 1_000 && !h.refundable.has('s1');
  });
  await assert('rtoLeftoverShares: customer first, up to what they covered', () => {
    const r = rtoLeftoverShares(1_000, 600, 300);
    return r.toCustomer === 300 && r.toVendor === 100;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('10. The expected COD amount — service and pure twin agree, payer-aware');

  const ccs = new CashCollectionService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const cases = [
    { name: 'vendor-paid', o: order(), s: shipment(), want: 10_000 },
    { name: 'customer-paid', o: order({ delivery_payer: 'customer' }), s: shipment({ delivery_payer: 'customer', customer_delivery_fee: 1_000 }), want: 11_000 },
    { name: 'legacy (no payer)', o: order({ delivery_payer: undefined }), s: shipment({ delivery_payer: undefined, customer_delivery_fee: undefined }), want: 10_000 },
    { name: 'customer-paid, moved item (no customer fee)', o: order({ delivery_payer: 'customer' }), s: shipment({ delivery_payer: 'customer', customer_delivery_fee: null, delivery_fee_snapshot: 900 }), want: 10_000 },
  ];
  for (const c of cases) {
    await assert(`${c.name}: computeExpectedAmount = expectedCodAmount = ${c.want}`, () =>
      ccs.computeExpectedAmount(c.o, c.s) === c.want
      && expectedCodAmount(c.o.items, c.s.items, customerDeliveryFeeOf(c.o, c.s)) === c.want
      && ccs.computeItemsAmount(c.o, c.s) === 10_000);
  }
  await assert('deliveryPayerOf: shipment, then order, then vendor', () =>
    deliveryPayerOf({ delivery_payer: 'customer' }, { delivery_payer: 'vendor' }) === 'vendor'
    && deliveryPayerOf({ delivery_payer: 'customer' }, {}) === 'customer'
    && deliveryPayerOf(null, null) === 'vendor');
  await assert('deliveryFeeShares splits a fee into covered / vendor-borne / excess', () => {
    const s = deliveryFeeShares(1_000, 1_300);
    const t = deliveryFeeShares(1_000, 0);
    return s.customerCovered === 1_000 && s.vendorBorne === 0 && s.customerExcess === 300 && t.vendorBorne === 1_000;
  });
  await assert('orderItemsGrossOf: base, else total − delivery', () =>
    orderItemsGrossOf({ total_amount: 11_000, price_breakdown: { base: 10_000 } }) === 10_000
    && orderItemsGrossOf({ total_amount: 11_000, price_breakdown: { delivery: 1_000 } as any }) === 10_000);

  // ───────────────────────────────────────────────────────────────────────────
  section('11. NET_FORMULA residual stays exact for a customer-paid sale');

  await assert('online customer-paid: residual deliveryFee = 0 (gross is items)', () => {
    const b = vendorSaleBreakdown({ sourceType: 'order', gross: 10_000, net: 9_000, commission: 1_000, bargainFee: 0, deliveryFeeSnapshot: null });
    return b.deliveryFee === 0 && b.codFee === 0;
  });
  await assert('COD customer-paid: the vendor-borne fee (0) splits the residual into codFee only', () => {
    const vendorBorne = deliveryFeeShares(1_000, customerDeliveryFeeOf(null, { delivery_payer: 'customer', customer_delivery_fee: 1_000 })).vendorBorne;
    const b = vendorSaleBreakdown({ sourceType: 'cod_collection', gross: 10_000, net: 8_800, commission: 1_000, bargainFee: 0, deliveryFeeSnapshot: vendorBorne });
    return b.deliveryFee === 0 && b.codFee === 200;
  });
  await assert('the analytics pass the VENDOR-BORNE fee, not the agency\'s', () => {
    const src = stripComments(read('modules/vendors/services/vendor-analytics.service.ts'));
    return src.includes('deliveryFeeShares(snapshot, customerDeliveryFeeOf(null, s)).vendorBorne');
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('12. Source scans — one pricing path, checkout snapshots, proposals refuse');

  const orderSrc = stripComments(read('modules/orders/order.service.ts'));
  const build = spanOf(orderSrc, 'private async buildVendorOrder(', 'async handlePaymentSuccess(');
  const quoteSrc = stripComments(read('modules/orders/services/cart-quote.service.ts'));
  const pricingSvc = stripComments(read('modules/orders/services/vendor-order-pricing.service.ts'));

  await assert('checkout resolves lines and prices through VendorOrderPricingService', () =>
    build.includes('vendorOrderPricingService.resolveDeliveryLines(') && build.includes('vendorOrderPricingService.price('));
  await assert('the cart quote resolves lines and prices through the SAME service', () =>
    quoteSrc.includes('this.pricing.resolveDeliveryLines(') && quoteSrc.includes('this.pricing.priceMethods('));
  await assert('the service defers to the pure priceVendorOrder (no second copy of the rules)', () =>
    pricingSvc.includes('priceVendorOrder(input.lines,') && !/resolveDeliveryPayer|assessDeliveryCostUnits|computeShipmentFee\(/.test(pricingSvc)
    && !/resolveDeliveryPayer|assessDeliveryCostUnits|computeShipmentFee\(/.test(quoteSrc));
  await assert('checkout snapshots the per-unit weight and its source on each order item', () =>
    build.includes('orderItem.weight_grams = fact.weight.grams;') && build.includes('orderItem.weight_source = fact.weight.source;'));
  await assert('checkout writes payer, reason and shortfall on the order; total = base + delivery', () =>
    build.includes('delivery_payer: pricing.payer,') && build.includes('delivery_payer_reason: pricing.payerReason,')
    && build.includes('free_delivery_shortfall: pricing.freeDeliveryShortfall,')
    && build.includes('const total = base + delivery + tax - discount;'));
  await assert('every physical shipment gets payer, snapshot, customer fee and components AT CHECKOUT', () =>
    build.includes('delivery_payer: pricing.payer,') && build.includes('delivery_fee_snapshot: priced.fee,')
    && build.includes("customer_delivery_fee: pricing.payer === 'customer' ? priced.fee : 0,") && build.includes('fee_components: {'));
  await assert('COD eligibility is measured on the total INCLUDING customer-paid delivery', () =>
    /assertVendorOrderEligible\(\{\s*orderType,\s*totalAmount: total,/.test(build)
    && build.indexOf('const total = base + delivery') < build.indexOf('assertVendorOrderEligible('));
  await assert('the auto-redirect threshold compares the ITEMS', () => {
    const body = spanOf(orderSrc, 'private async maybeDispatchToAgencies(', 'async dispatchToAgency(');
    return body.includes('const itemsValue = orderItemsGrossOf(order);') && body.includes('itemsValue > threshold');
  });
  await assert('the split measures the vendor on the items gross (never total_amount)', () => {
    const split = stripComments(read('modules/earnings/services/earnings-split.service.ts'));
    const body = spanOf(split, 'async splitOrder(order: IOrder)', 'private async computeAgencyDeliveryFees(');
    return body.includes('const gross = orderItemsGrossOf(order);') && !body.includes('order.total_amount');
  });
  await assert('collections store the breakdown (items_amount + delivery_fee_amount)', () => {
    const ccsSrc = stripComments(read('modules/cod/services/cash-collection.service.ts'));
    return ccsSrc.includes('items_amount: itemsAmount,') && ccsSrc.includes('delivery_fee_amount: deliveryFeeAmount,');
  });
  await assert('the agency quote\'s COD fee base is the GOODS (itemsAmount), at both call sites', () => {
    const svc = stripComments(read('modules/shipments/shipment.service.ts'));
    return svc.includes('[shipmentId, cod.itemsAmount]') && svc.includes('cod?.itemsAmount ?? 0');
  });
  // W-E (2026-10-04) replaced the interim refusal with the customer flow: a customer-paid
  // shipment's fee change goes to the CUSTOMER (D-8). Pinned in detail by test:customer-fee-changes.
  await assert('fee proposals route a customer-paid shipment to the customer flow (the interim refusal is gone)', () => {
    const svc = stripComments(read('modules/delivery-fee-proposals/services/delivery-fee-proposal.service.ts'));
    return !svc.includes('assertVendorPaid(') && svc.includes("deliveryPayerOf(order, shipment) === 'customer'")
      && svc.includes('createCustomerPaidProposal(');
  });
  await assert('DELIVERY_FEE_PROPOSAL_CUSTOMER_PAID_PENDING is retired (registry, messages and api-doc)', () =>
    !('DELIVERY_FEE_PROPOSAL_CUSTOMER_PAID_PENDING' in ERROR_CODES)
    && !Object.keys(DEFAULT_ERROR_MESSAGES).includes('DELIVERY_FEE_PROPOSAL_CUSTOMER_PAID_PENDING')
    && typeof categoryFor === 'function' && !!ERROR_CATEGORIES
    && !readFileSync(join(__dirname, '../../api-doc/errors/README.md'), 'utf8').includes('`DELIVERY_FEE_PROPOSAL_CUSTOMER_PAID_PENDING`'));

  originalConsole.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  originalConsole.error(err);
  process.exit(1);
});
