/**
 * Test: the administrator's money-split view of one order, and the platform's earnings total
 * (owner request 2026-10-04 — "who gets what, on what basis, as soon as it can be known", and
 * "the bargain fee is missing from what the platform made").
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free. Two halves:
 *
 *   - the PURE assembly (`domain/order-money-split.ts`): roles, waits, bases and the
 *     reconciliation — driven with the owner's own worked example (min 50 000, sold 65 000);
 *   - SOURCE SCANS for the two structural promises no behavioural test can see: every `split*`
 *     method now computes through a write-free `compute*` twin, and the view prices nothing of
 *     its own — it only reads allocations or calls those twins. A view with its own copy of the
 *     arithmetic does not fail when the split changes; it silently explains the wrong number.
 *
 * Run: npm run test:order-money-split
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AllocationFacts,
  agentSplitBasisOf,
  bargainFeeLinesOf,
  customerRefundLine,
  feeSourceOf,
  goodsBasisOf,
  lineFromAllocation,
  MoneySplitSection,
  prepaidGoodsFromRows,
  projectedLine,
  roleOf,
  summarise,
  waitingOnOf,
} from '../../src/modules/earnings/domain/order-money-split';
import { computeOrderAiMargin } from '../../src/modules/earnings/services/negotiation-margin.service';
import { EARNINGS_CONFIG } from '../../src/modules/earnings/config/earnings.config';

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

const SRC = path.resolve(__dirname, '../../src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The body of one class method, from its signature to the next member at the same indent. */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:async |private |static |[a-zA-Z]+\()/);
  return next < 0 ? rest : rest.slice(0, next);
}

const NOW = new Date('2026-10-04T12:00:00Z');
const PAST = new Date('2026-09-20T12:00:00Z');
const FUTURE = new Date('2026-10-10T12:00:00Z');

function row(over: Partial<AllocationFacts>): AllocationFacts {
  return {
    _id: 'a1',
    source_type: 'order',
    source_id: 'o1',
    beneficiary_type: 'vendor',
    beneficiary_id: 'v1',
    gross_snapshot: 65000,
    commission_percent_snapshot: 10,
    amount: 0,
    status: 'held',
    completed_at: null,
    hold_release_at: null,
    released_at: null,
    requires_cash_settlement: false,
    cash_settled_at: null,
    ...over,
  };
}

function section(over: Partial<MoneySplitSection>): MoneySplitSection {
  return {
    key: 'k',
    moment: 'payment',
    source: { type: 'order', id: 'o1' },
    state: 'allocated',
    noneReason: null,
    shipment: null,
    goods: null,
    delivery: null,
    lines: [],
    notes: [],
    ...over,
  };
}

// ─── 1. The bargain fee's per-line basis — the owner's example ────────────────

console.log('\n── 1. Bargain fee basis ──');

const example = bargainFeeLinesOf([
  { orderItemId: 'i1', title: 'Phone', unitPrice: 65000, floorPrice: 50000, quantity: 1 },
]);

assert('sold 65 000 over a 50 000 minimum: uplift 15 000', () => example[0].uplift === 15000);
assert(`fee is ${EARNINGS_CONFIG.AI_MARGIN_PERCENT}% of the uplift (4 500 at 30%)`, () =>
  example[0].fee === Math.floor((15000 * EARNINGS_CONFIG.AI_MARGIN_PERCENT) / 100));

const mixed = [
  { orderItemId: 'i1', title: 'A', unitPrice: 65000, floorPrice: 50000, quantity: 1 },
  { orderItemId: 'i2', title: 'B', unitPrice: 1001, floorPrice: 1000, quantity: 3 },
  { orderItemId: 'i3', title: 'C', unitPrice: 4000, floorPrice: null, quantity: 2 },
];
assert('Σ line fees === the split\'s own order margin (per-line flooring, never a margin on the sum)', () =>
  bargainFeeLinesOf(mixed).reduce((s, l) => s + l.fee, 0) ===
    computeOrderAiMargin(mixed.map((l) => ({ unitPrice: l.unitPrice, floorPrice: l.floorPrice, quantity: l.quantity }))));
assert('a non-bargainable line is KEPT with fee 0, so a reader sees every item', () => {
  const lines = bargainFeeLinesOf(mixed);
  return lines.length === 3 && lines[2].fee === 0 && lines[2].uplift === 0 && lines[2].floorPrice === null;
});
assert('a line sold AT its minimum pays nothing', () =>
  bargainFeeLinesOf([{ orderItemId: 'x', title: null, unitPrice: 50000, floorPrice: 50000, quantity: 2 }])[0].fee === 0);

// ─── 2. The goods basis ───────────────────────────────────────────────────────

console.log('\n── 2. Goods basis ──');

const goods = goodsBasisOf({
  gross: 65000,
  bargainFee: 4500,
  bargainLines: example,
  commissionPercent: 10,
  commission: 6050,
  deliveryFeeCharged: 2000,
  codHandlingFee: 0,
  vendorNet: 52450,
});
assert('commission base is gross − bargain fee (no commission on the bargain fee)', () => goods.commission.base === 60500);
assert('the bargain-fee rate travels with the basis', () => goods.bargainFee.percent === EARNINGS_CONFIG.AI_MARGIN_PERCENT);

const fromRows = prepaidGoodsFromRows(
  [
    row({ beneficiary_type: 'vendor', beneficiary_id: 'v1', amount: 52450 }),
    row({ beneficiary_type: 'platform', beneficiary_id: null, amount: 6050 }),
    row({ beneficiary_type: 'platform_ai', beneficiary_id: null, amount: 4500 }),
  ],
  example
);
assert('read back from rows: the delivery the vendor paid is the residual (2 000)', () =>
  fromRows !== null && fromRows.deliveryFeeCharged === 2000 && fromRows.vendorNet === 52450);
assert('read back from rows: the rate is the SNAPSHOT, not today\'s', () =>
  fromRows !== null && fromRows.commission.percent === 10);
assert('no rows → no basis', () => prepaidGoodsFromRows([], []) === null);
assert('an order with no bargainable line has no platform_ai row and a 0 fee', () => {
  const g = prepaidGoodsFromRows(
    [row({ beneficiary_type: 'vendor', amount: 900 }), row({ beneficiary_type: 'platform', beneficiary_id: null, amount: 100, gross_snapshot: 1000 })],
    []
  );
  return g !== null && g.bargainFee.amount === 0;
});

// ─── 3. Roles and lines ───────────────────────────────────────────────────────

console.log('\n── 3. Roles and lines ──');

assert('roles: platform_ai → bargain_fee, platform → commission', () =>
  roleOf('order', 'platform_ai') === 'bargain_fee' && roleOf('cod_collection', 'platform') === 'commission');
assert('roles: a vendor row on the order / a COD collection is the goods share', () =>
  roleOf('order', 'vendor') === 'vendor_net' && roleOf('cod_collection', 'vendor') === 'vendor_net');
assert('roles: a vendor row on a SHIPMENT is the unspent fee coming back', () =>
  roleOf('shipment', 'vendor') === 'delivery_refund_vendor');
assert('roles: agency / agent', () =>
  roleOf('shipment', 'agency') === 'delivery_agency' && roleOf('cod_collection', 'agent') === 'delivery_agent');

assert('a line keeps the allocation\'s id, status and dates', () => {
  const line = lineFromAllocation(row({ _id: 'x9', amount: 7, status: 'released', released_at: PAST }), NOW);
  return line.allocationId === 'x9' && line.status === 'released' && line.releasedAt === PAST && line.amount === 7;
});
assert('the platform\'s line has a null id, not a string "null"', () =>
  lineFromAllocation(row({ beneficiary_type: 'platform', beneficiary_id: null }), NOW).beneficiary.id === null);
assert('a zero projected share is dropped, exactly as `persist` skips it', () =>
  projectedLine('commission', { type: 'platform', id: null }, 0) === null);
assert('an UNKNOWN agent share (null) is kept, not dropped', () =>
  projectedLine('delivery_agent', { type: 'agent', id: 'g1' }, null)?.amount === null);
assert('a customer refund is `owed` once recorded, `projected` before', () =>
  customerRefundLine('c1', 500, false)?.status === 'owed' && customerRefundLine('c1', 500, true)?.status === 'projected');
assert('no refund line for 0', () => customerRefundLine('c1', 0, false) === null);

// ─── 4. Why a held line is not released ───────────────────────────────────────

console.log('\n── 4. Release waits ──');

assert('held, order not completed → order_not_completed', () =>
  waitingOnOf(row({}), NOW).join() === 'order_not_completed');
assert('held, completed, window still open → hold_window', () =>
  waitingOnOf(row({ completed_at: PAST, hold_release_at: FUTURE }), NOW).join() === 'hold_window');
assert('held, window over → nothing time-based (the worker will release it)', () =>
  waitingOnOf(row({ completed_at: PAST, hold_release_at: PAST }), NOW).length === 0);
assert('COD cash not yet at the platform is reported beside the time wait', () =>
  waitingOnOf(row({ requires_cash_settlement: true }), NOW).join() === 'order_not_completed,cash_not_settled');
assert('settled cash is not reported', () =>
  waitingOnOf(row({ completed_at: PAST, hold_release_at: PAST, requires_cash_settlement: true, cash_settled_at: PAST }), NOW).length === 0);
assert('released / reversed rows wait on nothing', () =>
  waitingOnOf(row({ status: 'released' }), NOW).length === 0 && waitingOnOf(row({ status: 'reversed' }), NOW).length === 0);

// ─── 5. The reconciliation ────────────────────────────────────────────────────

console.log('\n── 5. Reconciliation ──');

const line = (role: Parameters<typeof projectedLine>[0], type: Parameters<typeof projectedLine>[1]['type'], amount: number) =>
  projectedLine(role, { type, id: type === 'platform' || type === 'platform_ai' ? null : `${type}1` }, amount)!;

// The worked example, prepaid, vendor pays a 2 000 delivery, agent takes 60%.
const prepaidVendorPaid = [
  section({
    state: 'projected',
    lines: [line('vendor_net', 'vendor', 52450), line('commission', 'platform', 6050), line('bargain_fee', 'platform_ai', 4500)],
  }),
  section({
    key: 'shipment:s1',
    moment: 'delivery',
    state: 'projected',
    lines: [line('delivery_agency', 'agency', 800), line('delivery_agent', 'agent', 1200)],
  }),
];
const sum1 = summarise(prepaidVendorPaid, 65000);
assert('vendor-paid delivery: distributed === charged (65 000), difference 0', () =>
  sum1.reconciliation.distributed === 65000 && sum1.reconciliation.difference === 0);
assert('platform total = commission + bargain fee (10 550)', () =>
  sum1.totals.platform.total === 10550 && sum1.totals.platform.bargainFee === 4500 && sum1.totals.platform.commission === 6050);
assert('agency / agent / vendor totals', () =>
  sum1.totals.agencies === 800 && sum1.totals.agents === 1200 && sum1.totals.vendor === 52450);
assert('every line projected → estimated, and complete', () => sum1.estimated && sum1.reconciliation.complete);

// Customer pays the 2 000 on top: the vendor keeps it out of the net, the customer is charged 67 000.
const customerPaid = summarise(
  [
    section({ lines: [line('vendor_net', 'vendor', 54450), line('commission', 'platform', 6050), line('bargain_fee', 'platform_ai', 4500)] }),
    section({ key: 'shipment:s1', moment: 'delivery', lines: [line('delivery_agency', 'agency', 800), line('delivery_agent', 'agent', 1200)] }),
  ],
  67000
);
assert('customer-paid delivery: charged 67 000, difference 0', () => customerPaid.reconciliation.difference === 0);

const reversed = summarise(
  [
    section({
      lines: [
        { ...line('vendor_net', 'vendor', 52450), status: 'reversed' },
        { ...line('commission', 'platform', 6050), status: 'reversed' },
      ],
    }),
  ],
  65000
);
assert('reversed lines are excluded from every total and counted apart', () =>
  reversed.totals.vendor === 0 && reversed.totals.platform.total === 0 && reversed.totals.reversed === 58500);
assert('a reversed line makes the reconciliation incomplete', () => !reversed.reconciliation.complete);
assert('a `none` section makes it incomplete too', () =>
  !summarise([section({ state: 'none', noneReason: 'order_void' })], 0).reconciliation.complete);
assert('an unknown agent share counts as 0 in the sum (it is inside the agency line)', () => {
  const s = summarise(
    [section({ lines: [line('delivery_agency', 'agency', 2000), projectedLine('delivery_agent', { type: 'agent', id: null }, null)!] })],
    2000
  );
  return s.reconciliation.difference === 0 && s.totals.agents === 0;
});
assert('a customer refund is part of what was distributed', () =>
  summarise([section({ lines: [customerRefundLine('c1', 300, false)!] })], 300).totals.customerRefunds === 300);
assert('an all-allocated order is not estimated', () =>
  !summarise([section({ lines: [lineFromAllocation(row({ amount: 5 }), NOW)] })], 5).estimated);

// ─── 6. Fee source and the agent's split basis ───────────────────────────────

console.log('\n── 6. Delivery basis helpers ──');

assert('fee source precedence: vendor-approved override > snapshot > formula', () =>
  feeSourceOf({ delivery_fee_override: { amount: 1500 }, delivery_fee_snapshot: 2000 }) === 'vendor_approved' &&
  feeSourceOf({ delivery_fee_snapshot: 2000 }) === 'snapshot' &&
  feeSourceOf({}) === 'formula');
assert('a zero snapshot is a real snapshot, not "missing"', () => feeSourceOf({ delivery_fee_snapshot: 0 }) === 'snapshot');
assert('agent split: percentage carries the percent only', () => {
  const b = agentSplitBasisOf({ model: 'percentage', agent_share_percent: 60, agent_flat_fee: 999 });
  return b !== null && b.percent === 60 && b.flatAmount === null;
});
assert('agent split: flat carries the amount only', () => {
  const b = agentSplitBasisOf({ model: 'flat', agent_share_percent: 60, agent_flat_fee: 700 });
  return b !== null && b.flatAmount === 700 && b.percent === null;
});
assert('agent split: no contract → null', () => agentSplitBasisOf(null) === null);

// ─── 7. Source scans — one formula, two callers ───────────────────────────────

console.log('\n── 7. The split and the view share ONE computation ──');

const splitSrc = stripComments(read('modules/earnings/services/earnings-split.service.ts'));
const PAIRS: Array<[string, string]> = [
  ['async splitOrder(', 'this.computeOrderSplit(order)'],
  ['async splitCodCollection(', 'this.computeCodCollectionSplit(order,'],
  ['async splitDeliveryFeeCollection(', 'this.computeDeliveryFeeCollectionSplit(order,'],
  ['async splitShipmentDelivery(', 'this.computeShipmentDeliverySplit(order, shipment, outcome, policies)'],
];
for (const [split, compute] of PAIRS) {
  assert(`${split.replace('async ', '').replace('(', '')} computes through ${compute.split('(')[0].replace('this.', '')}`, () =>
    methodBody(splitSrc, split).includes(compute));
}

const COMPUTES = [
  'async computeOrderSplit(',
  'async computeCodCollectionSplit(',
  'async computeDeliveryFeeCollectionSplit(',
  'async computeShipmentDeliverySplit(',
];
for (const signature of COMPUTES) {
  assert(`${signature.replace('async ', '').replace('(', '')} WRITES NOTHING (no snapshot, no refund mark, no allocation, no event)`, () => {
    const body = methodBody(splitSrc, signature);
    return (
      body.length > 0 &&
      !/setDeliveryFeeSnapshots|setCustomerFeeRefundable|this\.persist\(|emitSplit\(|\.create\(|\.save\(/.test(body)
    );
  });
}

assert('the fee arithmetic left the split methods (no second copy beside the compute twin)', () =>
  !/computeCodHandlingFee\(/.test(methodBody(splitSrc, 'async splitCodCollection(')) &&
  !/resolveEarnedFee\(/.test(methodBody(splitSrc, 'async splitShipmentDelivery(')) &&
  !/computeOrderAiMargin\(/.test(methodBody(splitSrc, 'async splitOrder(')));

console.log('\n── 8. The view prices nothing of its own ──');

const viewSrc = stripComments(read('modules/earnings/services/order-money-split.service.ts'));
const domainSrc = stripComments(read('modules/earnings/domain/order-money-split.ts'));

assert('the view calls all four compute twins', () =>
  ['computeOrderSplit(', 'computeCodCollectionSplit(', 'computeDeliveryFeeCollectionSplit(', 'computeShipmentDeliverySplit('].every(
    (call) => viewSrc.includes(`this.splits.${call}`)
  ));
assert('no rate, no rounding in the view or its domain file', () =>
  !/\/\s*100\b|\*\s*\w*[Pp]ercent|Math\.floor/.test(viewSrc) && !/\/\s*100\b|Math\.floor/.test(domainSrc));
assert('no fee helper is imported by the view (it must ask the split, not re-derive)', () =>
  !/\b(applyFeeSplit|computeCodHandlingFee|computeAiMargin|computeShipmentFee|resolveEarnedFee|computeAgencyCut)\b/.test(viewSrc));
assert('the view never writes', () =>
  !/\.save\(|updateOne|updateMany|findOneAndUpdate|insertMany|\.create\(|deleteOne|deleteMany|setDeliveryFeeSnapshots|setCustomerFeeRefundable/.test(viewSrc));
assert('the bargain-fee basis goes through the split\'s own per-line function', () =>
  domainSrc.includes('computeNegotiatedLineSplit('));

console.log('\n── 9. Wiring ──');

assert('the route is mounted on the internal earnings router', () =>
  read('modules/earnings/routes/admin-earnings.routes.ts').includes("router.get('/orders/:orderId/split', AdminEarningsController.getOrderMoneySplit)"));
assert('platform earnings reads BOTH platform accounts (commission AND bargain fee)', () => {
  const ctrl = stripComments(read('modules/earnings/controllers/admin-earnings.controller.ts'));
  return ctrl.includes("getBalances('platform', null)") && ctrl.includes("getBalances('platform_ai', null)");
});
assert('the old top-level fields survive (the commission account), so an existing client keeps working', () =>
  stripComments(read('modules/earnings/controllers/admin-earnings.controller.ts')).includes(
    'sendSuccess(res, { ...commission, accounts: { commission, bargainFee }, total })'
  ));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
