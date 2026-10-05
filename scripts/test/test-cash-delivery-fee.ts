/**
 * Test: cash for delivery (ADR-A11 § Cash for delivery, D-7, W-F, 2026-10-04).
 *
 * An ONLINE order whose CUSTOMER-PAID delivery fee is handed to the rider in cash — the goods are
 * charged online, the fee is collected by a fee-only `CashCollection` (`kind: 'delivery_fee'`).
 *
 * Plain ts-node, hand-rolled asserts, DB-free (fake repositories, the transaction manager stubbed
 * to run inline):
 *
 *   1. The pure readers: payment mode, cash kind, the amounts a collection stores.
 *   2. Eligibility: every carrying agency must accept; COD / vendor-paid / fee 0 / no policy refuse.
 *   3. The quote: per shop, and folded for the whole checkout.
 *   4. Totals and the online charge: total_amount = items; delivery_cash = fees (checkout scan).
 *   5. The collection: created fee-only at accept, amounts, kind; liabilities credited.
 *   6. Exposure: counted for the agency and the agent, never in a vendor's COD terms cap.
 *   7. The split: agency + agent only, cash-settled, exactly once (no prepaid delivery split).
 *   8. Fee changes after checkout (W-E) on a cash_to_rider shipment: the collection moves.
 *   9. Surfaces: customer DTO, notification line, bot token, MCP catalogue, error code.
 *  10. Source scans: the gates read `collectsCash`, the refund keeps the agency's cash.
 *
 * Run: npm run test:cash-delivery-fee
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { priceVendorOrder, PricingLine, deliveryFeeCashVerdict } from '../../src/modules/orders/domain/vendor-order-pricing';
import {
  cashCollectionKindOf,
  cashToCollectOf,
  customerDeliveryFeeOf,
  deliveryCashOf,
  deliveryFeePaymentOf,
  paysDeliveryFeeInCash,
} from '../../src/modules/orders/domain/delivery-payer';
import { EarningsQuoteService, earnedFeeFor } from '../../src/modules/earnings/services/earnings-quote.service';
import { EarningsSplitService } from '../../src/modules/earnings/services/earnings-split.service';
import { transactionManager } from '../../src/core/database/transaction.manager';
import { sumCodExposure } from '../../src/modules/cod/domain/cod-limits';
import { CashCollectionService } from '../../src/modules/cod/services/cash-collection.service';
import { collectionKindOf } from '../../src/modules/cod/models/cash-collection.model';
import { deliveryFeeCashTotalOf } from '../../src/modules/orders/services/cart-quote.service';
import {
  feeIsCash,
  planCustomerApprovedIncrease,
  planDecrease,
  planVendorCoveredIncrease,
} from '../../src/modules/delivery-fee-proposals/domain/customer-fee-change.rules';
import { CustomerFeeApplicationService } from '../../src/modules/delivery-fee-proposals/services/customer-fee-application.service';
import { toCustomerOrderDto, amountDueToRiderOf } from '../../src/modules/orders/dto/customer-order.dto';
import { deliveryFeeCashReadyLine } from '../../src/modules/notifications/catalog/customer-notification-catalog';
import {
  checkoutDeliveryFeeCashActionId,
  checkoutTokenBudgetProblems,
  parseCheckoutDeliveryFeeCash,
} from '../../src/modules/bot-surface/domain/bot-checkout-actions';
import { checkoutPlacedReply, checkoutReviewReply } from '../../src/modules/bot-surface/domain/checkout-chat-reply';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { categoryFor } from '../../src/core/error-category';
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

const ROOT = join(__dirname, '../..');
const SRC = join(ROOT, 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
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

function policies(acceptsCash: boolean, over: Record<string, unknown> = {}): any {
  return {
    pricing: {
      pickup_based: { base_rate_first_kg: 1000, additional_per_kg: 200, out_of_region_surcharge: 500 },
      storage_based: { local_delivery_fee: 800, pick_pack_fee_per_order: 100, out_of_region_delivery_fee: 1500, monthly_storage_fee_per_sku: 0 },
      additional_fees: { cod_handling_fee: { type: 'percentage', value: 2 }, failed_delivery_fee: 0, rto_fee: 600 },
      max_fee_per_shipment: null,
      accepts_cash_delivery_fee: acceptsCash,
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
    terms: vendorDeliveryTermsOf({ mode: 'never', free_above_amount: null }),
    commissionPercent: 10,
    policiesByAgency: new Map([[A, policies(true)], [B, policies(true)]]),
    flatFeeFallback: 0,
    ...over,
  };
}

(transactionManager as any).runInTransaction = async (fn: (s: unknown) => unknown) => fn(undefined);

const oid = (id: string) => ({ toString: () => id, equals: (o: any) => String(o) === id });

function order(over: Record<string, unknown> = {}): any {
  return {
    _id: oid('o1'),
    order_number: 'ORD-1',
    cart_id: oid('c1'),
    vendor_id: oid('v1'),
    order_type: 'physical',
    payment_method: 'online',
    payment_status: 'paid',
    fulfillment_status: 'processing',
    currency: 'XAF',
    items: [{ _id: oid('i1'), product_id: oid('p1'), variant_id: oid('va1'), sku: 'S', title: 'T', variant_title: 'V', price: 10_000, currency: 'XAF', quantity: 1, floor_price_snapshot: null, weight_grams: 1000, delivery: { status: 'pending', shipment_id: oid('s1'), pickup_location: { source: 'vendor_address' } } }],
    // cash_to_rider: total = items (what was charged online), delivery_cash = the fee.
    price_breakdown: { base: 10_000, delivery: 0, delivery_cash: 1_000, tax: 0, discount: 0, total: 10_000 },
    total_amount: 10_000,
    delivery_payer: 'customer',
    delivery_fee_payment: 'cash_to_rider',
    delivery_address: { components: { region: 'Littoral' } },
    completion: null,
    created_at: new Date('2026-10-04T10:00:00Z'),
    updated_at: new Date('2026-10-04T10:00:00Z'),
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
    delivery_payer: 'customer',
    customer_delivery_fee: 1000,
    ...over,
  };
}

function feeCollection(over: Record<string, unknown> = {}): any {
  return {
    _id: oid('col1'),
    order_id: oid('o1'),
    shipment_id: oid('s1'),
    agency_id: oid(A),
    agent_id: oid('agent1'),
    currency: 'XAF',
    kind: 'delivery_fee',
    expected_amount: 1_000,
    items_amount: 0,
    delivery_fee_amount: 1_000,
    ...over,
  };
}

interface Harness {
  service: EarningsSplitService;
  allocations: any[];
  refundable: Map<string, number>;
}

function harness(opts: { shipments: any[]; commissionPercent: number; agentSharePercent?: number }): Harness {
  const allocations: any[] = [];
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
    setDeliveryFeeSnapshots: async () => undefined,
    setCustomerFeeRefundable: async (m: Map<string, number>) => m.forEach((v, k) => refundable.set(k, v)),
  };
  const agencyRepo: any = {
    findByIds: async (ids: string[]) => ids.map((id) => ({ _id: id, policies: policies(true) })),
    findById: async (id: string) => ({ _id: id, policies: policies(true) }),
  };
  const contracts: any = {
    findLive: async () => ({ _id: 'c1', fee_split: { model: 'percentage', agent_share_percent: opts.agentSharePercent ?? 40 } }),
  };
  const quotes = new EarningsQuoteService(agencyRepo, contracts);
  const service = new EarningsSplitService(allocationRepo, accounts, entitlements, shipmentRepo, agencyRepo, contracts, quotes);
  return { service, allocations, refundable };
}

const sumOf = (allocs: any[], type?: string) =>
  allocs.filter((a) => a.amount > 0 && (!type || a.beneficiary_type === type)).reduce((s, a) => s + a.amount, 0);
const typesOf = (allocs: any[]) => [...new Set(allocs.filter((a) => a.amount > 0).map((a) => a.beneficiary_type))].sort().join(',');

async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  section('1. The pure readers');

  await assert('deliveryFeePaymentOf: cash_to_rider on an online order; with_order on COD, legacy and null', () =>
    deliveryFeePaymentOf(order()) === 'cash_to_rider'
    && deliveryFeePaymentOf(order({ payment_method: 'cash_on_delivery' })) === 'with_order'
    && deliveryFeePaymentOf(order({ delivery_fee_payment: undefined })) === 'with_order'
    && deliveryFeePaymentOf(null) === 'with_order');
  await assert('paysDeliveryFeeInCash: customer-paid with a fee ⇒ true; vendor-paid / fee 0 (partial move) ⇒ false', () =>
    paysDeliveryFeeInCash(order(), shipment())
    && !paysDeliveryFeeInCash(order(), shipment({ delivery_payer: 'vendor', customer_delivery_fee: 0 }))
    && !paysDeliveryFeeInCash(order(), shipment({ customer_delivery_fee: 0 }))
    && !paysDeliveryFeeInCash(order({ delivery_fee_payment: 'with_order' }), shipment()));
  await assert('cashCollectionKindOf: COD → order, cash fee → delivery_fee, prepaid → null', () =>
    cashCollectionKindOf(order({ payment_method: 'cash_on_delivery' }), shipment()) === 'order'
    && cashCollectionKindOf(order(), shipment()) === 'delivery_fee'
    && cashCollectionKindOf(order({ delivery_fee_payment: 'with_order' }), shipment()) === null);
  await assert('cashToCollectOf: fee-only stores items 0 and expected = fee; COD stores goods + fee', () => {
    const f = cashToCollectOf('delivery_fee', 10_000, 1_000);
    const c = cashToCollectOf('order', 10_000, 1_000);
    const n = cashToCollectOf(null, 10_000, 1_000);
    return f.itemsAmount === 0 && f.deliveryFeeAmount === 1_000 && f.expectedAmount === 1_000
      && c.itemsAmount === 10_000 && c.expectedAmount === 11_000 && n.expectedAmount === 0;
  });
  await assert('deliveryCashOf reads price_breakdown.delivery_cash, 0 when absent', () =>
    deliveryCashOf(order()) === 1_000 && deliveryCashOf({ price_breakdown: { delivery_cash: null } }) === 0 && deliveryCashOf(null) === 0);
  await assert('collectionKindOf: a legacy row (no kind) is COD order cash', () =>
    collectionKindOf({}) === 'order' && collectionKindOf({ kind: 'delivery_fee' }) === 'delivery_fee');

  // ───────────────────────────────────────────────────────────────────────────
  section('2. Eligibility — every carrying agency must accept the fee in cash');

  await assert('customer-paid, the agency accepts ⇒ available; online = items, to rider = fee', () => {
    const p = priceVendorOrder([line()], facts());
    return p.payer === 'customer' && p.deliveryFeeCash.available
      && p.deliveryFeeCash.amountDueOnline === 10_000 && p.deliveryFeeCash.amountDueToRider === p.deliveryCharged
      && p.deliveryCharged === 1_000;
  });
  await assert('two agencies, one declines ⇒ agency_declines_cash naming THAT agency', () => {
    const p = priceVendorOrder([line(), line({ agencyId: B })], facts({ policiesByAgency: new Map([[A, policies(true)], [B, policies(false)]]) }));
    return !p.deliveryFeeCash.available && p.deliveryFeeCash.reason === 'agency_declines_cash'
      && p.deliveryFeeCash.decliningAgencyIds.join() === B && p.deliveryFeeCash.amountDueToRider === 0;
  });
  await assert('an agency with no pricing policy (flat fallback) does not accept', () => {
    const p = priceVendorOrder([line()], facts({ policiesByAgency: new Map(), flatFeeFallback: 700 }));
    return p.deliveryFeeCash.reason === 'agency_declines_cash';
  });
  await assert('vendor-paid (shop always free) ⇒ not_customer_paid', () =>
    priceVendorOrder([line()], facts({ terms: vendorDeliveryTermsOf(null) })).deliveryFeeCash.reason === 'not_customer_paid');
  await assert('COD ⇒ cash_on_delivery (cash for delivery is an online option)', () =>
    priceVendorOrder([line()], facts({ paymentMethod: 'cash_on_delivery' })).deliveryFeeCash.reason === 'cash_on_delivery');
  await assert('a 0 fee ⇒ no_delivery_fee', () =>
    deliveryFeeCashVerdict({ paymentMethod: 'online', payer: 'customer', itemsSubtotal: 5_000, deliveryCharged: 0, shipments: [{ agencyId: A }], policiesByAgency: new Map([[A, policies(true)]]) }).reason === 'no_delivery_fee');
  await assert('the cap fallback (D-6) is customer-paid too, so it may pay cash', () => {
    const p = priceVendorOrder([line({ unitPrice: 2_000 })], facts({ terms: vendorDeliveryTermsOf(null) }));
    return p.payerReason === 'cap_fallback' && p.deliveryFeeCash.available;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('3. The quote — per shop and for the whole checkout');

  const cashLine = (vendorId: string, total: number, fee: number) =>
    ({ vendorId, total, deliveryFeeCash: { available: true, reason: null, amountDueOnline: total - fee, amountDueToRider: fee } });
  const refuseLine = (vendorId: string, total: number, reason: any) =>
    ({ vendorId, total, deliveryFeeCash: { available: false, reason, amountDueOnline: total, amountDueToRider: 0 } });
  await assert('one cash shop + one free shop ⇒ available; online = grand − fee', () => {
    const t = deliveryFeeCashTotalOf([cashLine('v1', 11_000, 1_000), refuseLine('v2', 5_000, 'not_customer_paid')], 'physical');
    return t.available && t.amountDueOnline === 15_000 && t.amountDueToRider === 1_000 && t.vendorIds.join() === 'v1';
  });
  await assert('a customer-paid shop whose agency declines blocks the whole checkout', () => {
    const t = deliveryFeeCashTotalOf([cashLine('v1', 11_000, 1_000), refuseLine('v2', 6_000, 'agency_declines_cash')], 'physical');
    return !t.available && t.reason === 'agency_declines_cash' && t.amountDueToRider === 0 && t.amountDueOnline === 17_000;
  });
  await assert('every shop pays its own delivery ⇒ not_customer_paid; digital ⇒ no_delivery_fee', () =>
    deliveryFeeCashTotalOf([refuseLine('v1', 5_000, 'not_customer_paid')], 'physical').reason === 'not_customer_paid'
    && deliveryFeeCashTotalOf([{ vendorId: 'v1', total: 5_000, deliveryFeeCash: null }], 'digital').reason === 'no_delivery_fee');
  const quoteSrc = read('modules/orders/services/cart-quote.service.ts');
  await assert('the quote prices the cash verdict on the ONLINE method and exposes it per shop + overall', () =>
    /p\.byMethod\.get\('online'\)/.test(quoteSrc) && /deliveryFeeCash: deliveryFeeCashTotalOf\(perVendor/.test(quoteSrc));

  // ───────────────────────────────────────────────────────────────────────────
  section('4. Totals and the online charge (checkout)');

  const orderSvc = stripComments(read('modules/orders/order.service.ts'));
  const build = spanOf(orderSvc, 'private async buildVendorOrder(', 'const priceBreakdown = { base, delivery: 0, tax, discount, total };');
  await assert('cash chosen: delivery charged online = 0, delivery_cash = the fees, total = items', () =>
    /const delivery = cashFee \? 0 : pricing\.deliveryCharged;/.test(build)
    && /const deliveryCash = cashFee \? pricing\.deliveryCharged : 0;/.test(build)
    && /const total = base \+ delivery \+ tax - discount;/.test(build)
    && /delivery_cash: deliveryCash/.test(build)
    && /total_amount: total,/.test(build));
  await assert('cash applies only to a customer-paid vendor order with a fee; refused (422) when not available', () =>
    /const cashFee = wantsCash && pricing\.payer === 'customer' && pricing\.deliveryCharged > 0;/.test(build)
    && /if \(cashFee && !pricing\.deliveryFeeCash\.available\)/.test(build)
    && /ERROR_CODES\.DELIVERY_FEE_CASH_NOT_AVAILABLE/.test(build)
    && /delivery_fee_payment: cashFee \? 'cash_to_rider' : 'with_order'/.test(build));
  await assert('every shipment keeps customer_delivery_fee = its fee (the customer still pays it, in cash)', () =>
    /customer_delivery_fee: pricing\.payer === 'customer' \? priced\.fee : 0/.test(build));
  const create = spanOf(orderSvc, 'async createOrdersFromCart(', 'private async resolveDeliveryAddress(');
  await assert('checkout refuses cash_to_rider with COD, and when no vendor order took it', () =>
    /deliveryFeePayment === 'cash_to_rider' && paymentMethod === 'cash_on_delivery'/.test(create)
    && /!createdOrders\.some\(\(o\) => o\.delivery_fee_payment === 'cash_to_rider'\)/.test(create));
  const orchestrator = read('modules/payments/services/payment-orchestrator.service.ts');
  await assert('the online charge is Σ total_amount — so a cash-fee order is charged its items only', () =>
    /payable\.reduce\(\(sum, o\) => sum \+ o\.total_amount, 0\)/.test(orchestrator));

  // ───────────────────────────────────────────────────────────────────────────
  section('5. The fee-only collection — created at accept, credited at collect');

  const created: any[] = [];
  const ccs = new CashCollectionService(
    {
      findByShipmentId: async () => null,
      create: async (doc: any) => { created.push(doc); return { ...doc, _id: oid('col1') }; },
    } as never,
    { generateCode: () => '123456', hashCode: (c: string) => `h(${c})` } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    {
      creditInSession: async (owner: string, id: string, amount: number) => { credits.push({ owner, id, amount }); },
    } as never,
    {
      findLive: async () => ({ _id: oid('contract1') }),
      adjustOutstandingBalance: async (_id: string, amount: number) => { contractCredits.push(amount); },
    } as never,
  );
  const credits: Array<{ owner: string; id: string; amount: number }> = [];
  const contractCredits: number[] = [];
  const issued = await ccs.ensureForShipmentInSession(order(), shipment({ status: 'assigned' }), undefined as never);
  await assert('ensureForShipmentInSession: kind delivery_fee, items 0, expected = the customer fee, a code', () =>
    created.length === 1 && created[0].kind === 'delivery_fee' && created[0].items_amount === 0
    && created[0].delivery_fee_amount === 1_000 && created[0].expected_amount === 1_000 && issued.code === '123456');
  await assert('a COD collection is unchanged: kind order, goods + fee', () => {
    const a = ccs.cashAmountsOf(order({ payment_method: 'cash_on_delivery', delivery_fee_payment: 'with_order' }), shipment());
    return a.itemsAmount === 10_000 && a.expectedAmount === 11_000;
  });
  await assert('computeExpectedAmount on a cash-fee shipment = the fee alone; collectsCash true', () =>
    ccs.computeExpectedAmount(order(), shipment()) === 1_000 && ccs.collectsCash(order(), shipment())
    && !ccs.collectsCash(order({ delivery_fee_payment: 'with_order' }), shipment()));
  await assert('a shipment collecting nothing is refused, never given a code for 0', async () => {
    try {
      await ccs.ensureForShipmentInSession(order({ delivery_fee_payment: 'with_order' }), shipment(), undefined as never);
      return false;
    } catch (e: any) {
      return e.statusCode === 404;
    }
  });
  await (ccs as any).creditCashLiabilitiesInSession(feeCollection(), undefined);
  await assert('collect credits the AGENT (owes the agency) and the agency chain + the contract — the cash chain', () =>
    credits.length === 2 && credits.every((c) => c.amount === 1_000)
    && credits.map((c) => c.owner).sort().join() === 'agency,agent' && contractCredits.join() === '1000');

  // ───────────────────────────────────────────────────────────────────────────
  section('6. Exposure — agency + agent yes, vendor COD terms no');

  const shipmentsRows = [
    { shipmentId: 's1', vendorId: 'v1', amount: 1_000, collectionStatus: 'pending' as const, agencyOnly: true },
    { shipmentId: 's2', vendorId: 'v1', amount: 20_000, collectionStatus: null },
  ];
  const collectedRows = [
    { collectionId: 'c3', vendorId: 'v1', expectedAmount: 1_500, settledAmount: 0, agencyOnly: true },
    { collectionId: 'c4', vendorId: 'v1', expectedAmount: 8_000, settledAmount: 3_000 },
  ];
  await assert('agency-wide exposure counts the fee-only cash (in flight and collected-unremitted)', () => {
    const t = sumCodExposure(shipmentsRows, collectedRows);
    return t.inFlight === 21_000 && t.collectedUnremitted === 6_500 && t.total === 27_500;
  });
  await assert('a vendor-scoped sum skips it — a vendor\'s cap bounds that vendor\'s goods', () => {
    const t = sumCodExposure(shipmentsRows, collectedRows, 'v1');
    return t.inFlight === 20_000 && t.collectedUnremitted === 5_000;
  });
  const limitsSvc = read('modules/cod/services/cod-limits.service.ts');
  await assert('exposureRows reads cash-fee orders too, marking fee-only rows agencyOnly', () =>
    /\{ delivery_fee_payment: 'cash_to_rider' \}/.test(limitsSvc) && /agencyOnly: kind === 'delivery_fee'/.test(limitsSvc)
    && /agencyOnly: c\.kind === 'delivery_fee'/.test(limitsSvc));
  const exposureSvc = read('modules/cod/services/cod-exposure.service.ts');
  await assert('the agent\'s exposure is every pending collection + cash held — no kind filter', () =>
    /\{ status: 'pending', agent_id: new Types\.ObjectId\(agentId\) \}/.test(exposureSvc) && !/kind/.test(stripComments(exposureSvc)));

  // ───────────────────────────────────────────────────────────────────────────
  section('7. The split — the agency side is paid exactly once');

  {
    const h = harness({ shipments: [shipment()], commissionPercent: 10, agentSharePercent: 40 });
    await h.service.splitCodCollection(order(), feeCollection());
    await assert('fee-only collection ⇒ ONLY agency + agent rows, summing to the fee (1 000 = 600 + 400)', () =>
      typesOf(h.allocations) === 'agency,agent' && sumOf(h.allocations) === 1_000
      && sumOf(h.allocations, 'agency') === 600 && sumOf(h.allocations, 'agent') === 400);
    await assert('…every row waits for the cash (requires_cash_settlement) and carries no commission', () =>
      h.allocations.every((a) => a.requires_cash_settlement === true && a.commission_percent_snapshot === 0
        && a.source_type === 'cod_collection' && a.gross_snapshot === 1_000));
  }
  {
    const h = harness({ shipments: [shipment()], commissionPercent: 10 });
    await h.service.splitShipmentDelivery(order(), shipment(), 'delivered');
    await assert('splitShipmentDelivery writes NOTHING for a delivered cash-fee shipment (no double pay)', () => h.allocations.length === 0);
  }
  {
    const h = harness({ shipments: [shipment({ status: 'returned' })], commissionPercent: 10 });
    await h.service.splitShipmentDelivery(order(), shipment({ status: 'returned' }), 'returned');
    await assert('returned cash-fee shipment: no cash collected, nothing earned, nothing owed back', () =>
      sumOf(h.allocations) === 0 && h.refundable.size === 0);
  }
  {
    // A change-agency difference the vendor covered: fee 1 300, customer cash 1 000.
    const s = shipment({ status: 'returned', delivery_fee_snapshot: 1_300 });
    const h = harness({ shipments: [s], commissionPercent: 10 });
    await h.service.splitShipmentDelivery(order(), s, 'returned');
    await assert('returned with a vendor-borne remainder: ONLY that remainder goes back to the vendor', () =>
      typesOf(h.allocations) === 'vendor' && sumOf(h.allocations, 'vendor') === 300);
  }
  {
    const h = harness({ shipments: [shipment()], commissionPercent: 10 });
    await h.service.splitOrder(order());
    const online = sumOf(h.allocations);
    await assert('splitOrder: the vendor does not bear the cash fee; rows sum to the ONLINE charge (items)', () =>
      sumOf(h.allocations, 'vendor') === 9_000 && sumOf(h.allocations, 'platform') === 1_000 && online === order().total_amount);
  }
  await assert('a returned cash-fee shipment is quoted to the agency as earning 0 (like COD)', () =>
    earnedFeeFor(order(), shipment({ status: 'returned' }), 1_000, policies(true)) === 0
    && earnedFeeFor(order({ delivery_fee_payment: 'with_order' }), shipment({ status: 'returned' }), 1_000, policies(true)) === 600);
  // Since REFUND-FLOW-PLAN § 6 the order-refund scope lives in the clawback service, which
  // `EarningsRefundService` now wraps.
  const refundSvc = read('modules/earnings/services/earnings-clawback.service.ts');
  await assert('an order refund does NOT reverse a fee-only collection (the customer paid that fee in cash)', () =>
    /kind: \{ \$ne: 'delivery_fee' \}/.test(refundSvc));
  const settle = read('modules/cod/services/cod-settlement.service.ts');
  await assert('remittance FIFO settles fee-only collections like any other (cash chain), unlocking their rows', () =>
    !/kind/.test(stripComments(settle)) && /markCashSettledBySource\(\s*'cod_collection'/.test(settle));

  // ───────────────────────────────────────────────────────────────────────────
  section('8. Fee changes after checkout on a cash_to_rider shipment');

  const app = new CustomerFeeApplicationService({} as never, {} as never, {} as never, {} as never, {} as never);
  await assert('modeOf: cash_to_rider ⇒ cash_fee; COD ⇒ cod; otherwise online', () =>
    app.modeOf(order()) === 'cash_fee' && app.modeOf(order({ payment_method: 'cash_on_delivery' })) === 'cod'
    && app.modeOf(order({ delivery_fee_payment: 'with_order' })) === 'online' && feeIsCash('cash_fee') && !feeIsCash('online'));
  await assert('decrease: the collection drops by Δ — no refund, no refundable', () => {
    const p = planDecrease({ mode: 'cash_fee', fee: 1_000, customerFee: 1_000 }, 700);
    return p.collectDelta === -300 && p.orderTotalDelta === -300 && p.customerFeeAfter === 700
      && p.refundableAfter === 0 && p.topupDue === 0 && p.vendorAllocationDelta === 0;
  });
  await assert('approved increase: the collection grows by Δ — no top-up', () => {
    const p = planCustomerApprovedIncrease({ mode: 'cash_fee', fee: 1_000, customerFee: 1_000 }, 1_400);
    return p.collectDelta === 400 && p.topupDue === 0 && p.customerFeeAfter === 1_400 && p.refundableAfter === 0;
  });
  await assert('vendor-covered increase: the vendor allocation (split at payment) moves; no cash change', () => {
    const p = planVendorCoveredIncrease({ mode: 'cash_fee', fee: 1_000, customerFee: 1_000 }, 1_300);
    return p.vendorAllocationDelta === -300 && p.collectDelta === 0 && p.refundableAfter === 0;
  });
  await assert('decrease after a vendor-covered difference gives the vendor back first (online-split allocation)', () => {
    const p = planDecrease({ mode: 'cash_fee', fee: 1_300, customerFee: 1_000 }, 1_100);
    return p.vendorAllocationDelta === 200 && p.collectDelta === 0;
  });
  const appSrc = stripComments(read('modules/delivery-fee-proposals/services/customer-fee-application.service.ts'));
  await assert('applyInSession: re-prices the pending collection, moves delivery_cash (never total_amount)', () =>
    /if \(feeIsCash\(mode\) && plan\.collectDelta !== 0\)/.test(appSrc)
    && /'price_breakdown\.delivery_cash': plan\.orderTotalDelta/.test(appSrc)
    && /if \(mode !== 'cod' && plan\.vendorAllocationDelta !== 0\)/.test(appSrc)
    && /cancelFeeOnly/.test(appSrc));

  // ───────────────────────────────────────────────────────────────────────────
  section('9. Surfaces');

  const dto = toCustomerOrderDto({
    order: order(),
    storeName: 'Shop',
    storeSlug: 'shop',
    storeVerified: false,
    imagesByKey: new Map(),
    shipments: [{ _id: 's1', status: 'in_transit', delivery_payer: 'customer', customer_delivery_fee: 1_000, customer_fee_refundable: null }],
    deliveryFeeRefundLedger: [],
  } as any);
  await assert('customer DTO: deliveryFeePayment, priceBreakdown.deliveryCash, amountDueToRider, paidInCash', () =>
    dto.deliveryFeePayment === 'cash_to_rider' && dto.priceBreakdown.deliveryCash === 1_000 && dto.priceBreakdown.delivery === 0
    && dto.total === 10_000 && dto.amountDueToRider === 1_000 && dto.deliveryFees[0].paidInCash === true);
  await assert('amountDueToRider drops a delivered parcel; 0 on a with_order order', () =>
    amountDueToRiderOf(order(), [{ _id: 's1', status: 'delivered', delivery_payer: 'customer', customer_delivery_fee: 1_000 }]) === 0
    && amountDueToRiderOf(order({ delivery_fee_payment: 'with_order' }), [{ _id: 's1', status: 'in_transit', delivery_payer: 'customer', customer_delivery_fee: 1_000 }]) === 0);
  await assert('out-for-delivery: the delivery-fee cash line in all five languages, empty for 0', () =>
    (['en', 'fr', 'pt', 'es', 'ar'] as const).every((l) => deliveryFeeCashReadyLine(1_500, 'XAF', l).includes('1,500'))
    && deliveryFeeCashReadyLine(0, 'XAF', 'en') === '');
  const handler = read('modules/notifications/services/customer-notification-event-handler.service.ts');
  await assert('the shipment-status handler renders it for a cash_to_rider order', () =>
    /deliveryFeeCashReadyLine\(feeCash/.test(handler) && /delivery_fee_payment === 'cash_to_rider'/.test(handler));

  const REF = 'ia_' + 'A'.repeat(22);
  const ADDR = 'f'.repeat(24);
  await assert('bot token yes:cof:<ref>:<address> builds, parses back, and fits the 64-byte budget', () => {
    const id = checkoutDeliveryFeeCashActionId(REF, ADDR);
    const parsed = parseCheckoutDeliveryFeeCash(id.slice('yes:cof:'.length));
    return id.startsWith('yes:cof:') && parsed?.checkoutRef === REF && parsed.addressId === ADDR
      && checkoutTokenBudgetProblems({ handleLength: REF.length }).length === 0;
  });
  const review: any = {
    ready: true,
    blocker: null,
    checkoutRef: REF,
    lines: [{ title: 'T', variantLabel: null, quantity: 1, lineTotalText: '10 000 XAF' }],
    totalText: '11 000 XAF',
    delivery: { kind: 'address', address: { id: ADDR, label: 'Home', formattedAddress: 'Douala', isDefault: true, deliverable: true } },
    addresses: [{ id: ADDR, label: 'Home', formattedAddress: 'Douala', isDefault: true, deliverable: true }],
    payment: { method: 'mobile_money', phoneMasked: '6•••••31', cashOnDelivery: false, deliveryFeeCash: { onlineText: '10 000 XAF', toRiderText: '1 000 XAF' } },
    addAddressUrl: null,
    deliveryShortfalls: [],
    deliveryLines: [{ text: 'Delivery: 1 000 XAF', hint: null }],
    deliveryCharged: true,
  };
  const reply: any = checkoutReviewReply(review, { addressChosen: true }, 'en');
  await assert('the chat confirmation offers Pay now · Delivery in cash · Not now, with both amounts', () =>
    reply?.kind === 'choice' && reply.options.length === 3 && reply.options[1].id.startsWith('yes:cof:')
    && reply.text.includes('10 000 XAF') && reply.text.includes('1 000 XAF'));
  const withoutCash: any = checkoutReviewReply({ ...review, payment: { ...review.payment, deliveryFeeCash: null } }, { addressChosen: true }, 'en');
  await assert('…and not when the review does not offer it', () => !withoutCash.options.some((o: any) => o.id.startsWith('yes:cof:')));
  const placedReply: any = checkoutPlacedReply({ transactionId: 't', state: 'waiting', orderNumbers: ['ORD-1'], amountText: '10 000 XAF', payerMasked: '6•31', instructions: null, deliveryCashText: '1 000 XAF' }, 'fr');
  await assert('the placed message says the delivery fee is paid in cash to the rider', () =>
    placedReply.text.includes('1 000 XAF') && /espèces/.test(placedReply.text));
  const botCheckout = read('modules/bot-surface/controllers/bot-checkout.controller.ts');
  await assert('yes:cof is routed, and the chat place passes deliveryFeePayment', () =>
    /'yes:cof': deliveryFeeCashTap/.test(botCheckout) && /deliveryFeePayment,\n\s*\}\);/.test(botCheckout));
  const miniapp = read('modules/bot-surface/miniapp/surfaces/checkout.controller.ts');
  await assert('placeCheckout re-checks cash for delivery BEFORE the spend (spent: false) and passes it on', () => {
    const place = spanOf(miniapp, 'export async function placeCheckout(', 'export interface CashOnDeliveryPlacement');
    return place.indexOf('quote.deliveryFeeCash.available') < place.indexOf("inAppSurfaceStore.consume('co'")
      && /spent: false/.test(spanOf(place, 'quote.deliveryFeeCash.available', "inAppSurfaceStore.consume('co'"))
      && /\{ deliveryFeePayment \},/.test(place);
  });
  const coHtml = readFileSync(join(SRC, 'modules/bot-surface/miniapp/public/co.html'), 'utf8');
  await assert('co.html draws the server strings only and sends deliveryFeePayment', () =>
    /fc\.toRiderText/.test(coHtml) && /fc\.onlineText/.test(coHtml) && /deliveryFeePayment:/.test(coHtml)
    && !/parseInt|parseFloat|Number\(fc/.test(coHtml));
  const catalog = JSON.parse(readFileSync(join(ROOT, 'api-doc/n8n/tools/catalog.json'), 'utf8'));
  const tools: any[] = Array.isArray(catalog.tools) ? catalog.tools : Object.values(catalog.tools ?? catalog);
  const tool = (n: string) => tools.find((t) => t?.name === n);
  await assert('MCP catalogue: checkout_place / checkout_create_orders accept deliveryFeePayment; quote + review name the fields', () =>
    tool('checkout_place').parameters.properties.deliveryFeePayment.enum.join() === 'with_order,cash_to_rider'
    && tool('checkout_create_orders').parameters.properties.deliveryFeePayment
    && tool('cart_quote').response.important_fields.includes('deliveryFeeCash.available')
    && tool('checkout_review').response.important_fields.includes('payment.deliveryFeeCash.toRiderText'));
  await assert('DELIVERY_FEE_CASH_NOT_AVAILABLE: registered, has a default message, 422 → business_rule', () =>
    ERROR_CODES.DELIVERY_FEE_CASH_NOT_AVAILABLE === 'DELIVERY_FEE_CASH_NOT_AVAILABLE'
    && typeof (DEFAULT_ERROR_MESSAGES as any)[ERROR_CODES.DELIVERY_FEE_CASH_NOT_AVAILABLE] === 'string'
    && categoryFor(ERROR_CODES.DELIVERY_FEE_CASH_NOT_AVAILABLE, 422) === 'business_rule');
  const validator = read('modules/orders/customer-order.controller.ts');
  await assert('customer checkout accepts deliveryFeePayment (default with_order)', () =>
    /deliveryFeePayment: z\.enum\(\['with_order', 'cash_to_rider'\]\)\.optional\(\)\.default\('with_order'\)/.test(validator));

  // ───────────────────────────────────────────────────────────────────────────
  section('10. Source scans — every cash gate reads collectsCash');

  const shipmentSvc = stripComments(read('modules/shipments/shipment.service.ts'));
  await assert('status transitions: delivered only by the code, collection ensured at pickup, cancelled on return', () =>
    /const isCod = cashCollectionService\.collectsCash\(order, shipment\);/.test(shipmentSvc));
  await assert('customer confirmation refused for a cash-fee parcel; auto-confirm goes through autoCollect', () =>
    /if \(cashCollectionService\.collectsCash\(order, shipment\)\) \{\s*throw createAppError\(\s*ERROR_CODES\.SHIPMENT_CONFIRMATION_NOT_ALLOWED/.test(shipmentSvc)
    && /cashCollectionService\.collectsCash\(orderById\.get\(orderId\)!, shipment\)\s*\?\s*await cashCollectionService\.autoCollectWithoutCode/.test(shipmentSvc));
  await assert('the prepaid delivery split still runs for every online order (it guards cash itself)', () =>
    /order\.payment_method !== 'cash_on_delivery' && \(newStatus === 'agent_delivered' \|\| newStatus === 'returned'\)/.test(shipmentSvc));
  const assign = stripComments(read('modules/shipment-assignment/domain/services/shipment-assignment.service.ts'));
  await assert('agent accept creates the collection for any cash shipment (COD or fee-only)', () =>
    (assign.match(/riderCollectsCash\(order, shipment\)/g) ?? []).length >= 3
    && !/order\.payment_method === 'cash_on_delivery'/.test(assign));
  const candidate = stripComments(read('modules/shipment-assignment/domain/services/assignment-candidate.service.ts'));
  const policy = stripComments(read('modules/shipment-assignment/domain/services/contract-policy.service.ts'));
  await assert('the agent COD gate (ranking and contract policy) applies to the fee cash too', () =>
    /const isCod = riderCollectsCash\(order, shipment\);/.test(candidate)
    && /riderCollectsCash\(order, shipment\) : false/.test(policy));
  const view = read('modules/orders/services/customer-order-view.service.ts');
  await assert('the customer sees the fee-only collections (and their delivery code) in codCollections', () =>
    /deliveryFeePaymentOf\(o\) === 'cash_to_rider'/.test(view));
  await assert('the vendor is not told "payment received" for the riders\' delivery cash', () =>
    /if \(!feeOnly\) try \{/.test(read('modules/cod/services/cash-collection.service.ts')));
  const moveSrc = stripComments(read('modules/orders/vendor-order.service.ts'));
  await assert('a WHOLE move of a cash-fee shipment to an agency that refuses cash is refused before any write', () =>
    /whole && source && paysDeliveryFeeInCash\(order, source\)\s*&& !input\.destinationAcceptsCashFee/.test(moveSrc)
    && /destinationAcceptsCashFee: \(agencyExists as any\)\?\.policies\?\.pricing\?\.accepts_cash_delivery_fee === true/.test(moveSrc)
    && moveSrc.indexOf('input.destinationAcceptsCashFee') < moveSrc.indexOf('changeAgencyFeeService.prepareWholeMoveInSession('));
  await assert('customerDeliveryFeeOf on a cash shipment is the fee (what the vendor does NOT bear)', () =>
    customerDeliveryFeeOf(order(), shipment()) === 1_000);

  originalConsole.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  originalConsole.error(err);
  process.exit(1);
});
