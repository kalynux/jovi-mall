/**
 * test:vendor-analytics — the live vendor analytics (rebuilt 2026-09-27). **No DB, no network.**
 *
 * The old analytics could not be coherent (plan § 1): it reported `total_amount − refunds` as
 * "net revenue", subtracted refunds twice, never counted COD, and dropped the last day of every
 * range. What replaced it reads the earnings allocations. This suite pins:
 *
 *  1. **The formula is the one wi-admin's statements print** — the literal, and the arithmetic.
 *  2. **The period keeps its last day**, in the vendor's timezone.
 *  3. **Totals count ORDERS, not collections**, and refuse to invent a delivery/COD split.
 *  4. **Nothing reads the old snapshot.**
 *
 * Run: npm run test:vendor-analytics
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
    NET_FORMULA,
    daysOf,
    localDay,
    toAnalyticsPeriod,
    vendorSaleBreakdown,
} from '../../src/modules/vendors/analytics/net-revenue';
import { SaleFact, emptyDay, mergeFacts, totalsOf } from '../../src/modules/vendors/services/vendor-analytics.service';
import { SalesQuerySchema } from '../../src/modules/vendors/validators/analytics.validator';
import { codFeeOf } from '../../src/modules/earnings/analytics/delivery-analytics.service';
import { mapEarning, mapPayout } from '../../src/modules/transactions/services/vendor-transaction.service';
import { Types } from 'mongoose';

let passed = 0;
let failed = 0;
function assert(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`);
        failed++;
    }
}
function section(title: string): void {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}
const codeOf = (fn: () => unknown): string | null => {
    try {
        fn();
        return null;
    } catch (e) {
        return (e as { code?: string }).code ?? 'THREW';
    }
};

section('1. One formula, two services');
assert('NET_FORMULA literal', NET_FORMULA === 'net = gross - bargainFee - commission - deliveryFee - codFee');
{
    // The contract copy in wi-admin. Read as TEXT across the workspace: there is no shared
    // package, so this is the only mechanism that notices one side changing alone.
    const adminCopy = join(__dirname, '../../../admin/src/modules/statements/domain/money-breakdown.ts');
    if (existsSync(adminCopy)) {
        const text = readFileSync(adminCopy, 'utf8');
        assert("wi-admin's statements state the SAME literal", text.includes(`'${NET_FORMULA}'`));
    } else {
        console.log('  ⚪ wi-admin not checked out beside jovi-mall — cross-repo literal check skipped');
    }
}

const prepaid = vendorSaleBreakdown({ sourceType: 'order', gross: 10_000, net: 7_730, commission: 970, bargainFee: 300, deliveryFeeSnapshot: null });
assert('prepaid: residual is delivery, no COD fee', prepaid.deliveryFee === 1_000 && prepaid.codFee === 0);
const cod = vendorSaleBreakdown({ sourceType: 'cod_collection', gross: 10_000, net: 7_530, commission: 970, bargainFee: 300, deliveryFeeSnapshot: 1_000 });
assert('COD: fee snapshot is delivery, the rest is the COD fee', cod.deliveryFee === 1_000 && cod.codFee === 200);
assert('COD: the formula closes',
    cod.gross - cod.bargainFee - cod.commission - (cod.deliveryFee ?? 0) - (cod.codFee ?? 0) === cod.net);
const unsplit = vendorSaleBreakdown({ sourceType: 'cod_collection', gross: 10_000, net: 7_530, commission: 970, bargainFee: 300, deliveryFeeSnapshot: null });
assert('COD with no snapshot: no invented split', unsplit.deliveryFee === null && unsplit.deliveryAndCod === 1_200);

section('2. The period keeps its last day');
const p = toAnalyticsPeriod('2026-09-01', '2026-09-30', 'Africa/Douala');
assert('start = local midnight of `from`', p.start.toISOString() === '2026-08-31T23:00:00.000Z');
assert('end = local midnight AFTER `to` (exclusive)', p.end.toISOString() === '2026-09-30T23:00:00.000Z');
{
    const lateOnLastDay = new Date('2026-09-30T22:30:00Z'); // 23:30 in Douala
    assert('a 23:30 sale on the last day is inside', lateOnLastDay >= p.start && lateOnLastDay < p.end);
    assert('…and is bucketed on that local day', localDay(lateOnLastDay, 'Africa/Douala') === '2026-09-30');
}
assert('daysOf lists every day, so a quiet day is a zero row', daysOf(p).length === 30 && daysOf(p)[29] === '2026-09-30');
assert('an ISO timestamp is read as its date part',
    SalesQuerySchema.parse({ from: '2026-09-01T10:00:00Z', to: '2026-09-30' }).from === '2026-09-01');
assert('2026-02-31 is refused, not moved to March',
    codeOf(() => SalesQuerySchema.parse({ from: '2026-02-31', to: '2026-03-02' })) === 'ANALYTICS_INVALID_DATE_RANGE');
assert('`from` after `to` is refused',
    codeOf(() => SalesQuerySchema.parse({ from: '2026-09-02', to: '2026-09-01' })) === 'ANALYTICS_INVALID_DATE_RANGE');

section('3. Totals');
{
    const at = new Date('2026-09-10T10:00:00Z');
    const fact = (orderId: string, b: ReturnType<typeof vendorSaleBreakdown>, sourceType: SaleFact['sourceType'] = 'order'): SaleFact => ({ orderId, sourceType, receivedAt: at, breakdown: b });
    const twoCollectionsOneOrder = [fact('A', cod, 'cod_collection'), fact('A', cod, 'cod_collection'), fact('B', prepaid)];
    const t = totalsOf(twoCollectionsOneOrder);
    assert('orderCount counts ORDERS — two collections of one order are one', t.orderCount === 2);
    assert('netRevenue is the sum of vendor allocations', t.netRevenue === 7_530 * 2 + 7_730);
    assert('delivery + COD fees split when every sale has a snapshot', t.deliveryFee === 3_000 && t.codFee === 400);
    assert('AOV is gross per order', t.aov === Math.round(30_000 / 2));
    const withUnsplit = totalsOf([fact('A', cod, 'cod_collection'), fact('C', unsplit, 'cod_collection')]);
    assert('one unsplit sale nulls the split and keeps the combined figure',
        withUnsplit.deliveryFee === null && withUnsplit.codFee === null && withUnsplit.deliveryAndCodFees === 2_400);
    assert('an empty period is zeros, not an error', totalsOf([]).netRevenue === 0 && totalsOf([]).aov === 0);
}

section('4. Nothing reads the old snapshot');
{
    const src = readFileSync(join(__dirname, '../../src/modules/vendors/services/vendor-analytics.service.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert('the service imports no daily-metrics repository',
        !/DailyMetrics(Repository|Model)/.test(code) && !/daily-metrics/.test(code));
    assert('the service reads earnings allocations', /EarningsAllocationModel\.find/.test(code));
    assert('no `$lte` on a period bound (the dropped-last-day bug)', !/\$lte/.test(code));
    assert('no multiplication by a commission or margin rate', !/commission_percent|AI_MARGIN|\*\s*0\.3\b/.test(code));
    // REFUND-FLOW-PLAN § 6: refunds now claw shares PARTIALLY and from released money, recorded
    // one `earnings_adjustments` row per share. Those rows are the reversals; an allocation is
    // counted from `reversed_at` only when the pre-clawback path reversed it (clawed_amount 0),
    // so a fully clawed row is never counted twice.
    assert('reversals read refund clawbacks from earnings_adjustments (partial ones included)',
        /EarningsAdjustmentModel\.find\(\{[\s\S]{0,80}kind:\s*'refund_clawback'/.test(code));
    assert('a reversed allocation counts only when NO clawback recorded it (no double count)',
        /reversed_at:\s*window,\s*clawed_amount:\s*\{\s*\$in:\s*\[0,\s*null\]\s*\}/.test(code));
}

section('4b. Stored nightly days give the same answer as a live read');
{
    const money = (gross: number, net: number, split = true) => ({
        grossSales: gross, bargainFee: 0, commission: gross - net - 1_000, deliveryFee: split ? 1_000 : null,
        codFee: split ? 0 : null, deliveryAndCodFees: 1_000, netRevenue: net,
    });
    const day = (d: string, gross: number, net: number, orders: [string, string][], split = true) => ({
        ...emptyDay(d),
        sales: money(gross, net, split),
        orders: orders.map(([orderId, customerId]) => ({ orderId, customerId })),
        lines: orders.map(([orderId]) => ({ orderId, variantId: 'V1', productId: 'P1', title: 'Dress', sku: null, quantity: 1, revenue: 5_000 })),
    });
    // Order A is a COD order collected on BOTH days (two shipments); B is on day 2 only.
    const d1 = day('2026-09-01', 5_000, 3_500, [['A', 'C1']]);
    const d2 = day('2026-09-02', 10_000, 7_000, [['A', 'C1'], ['B', 'C1']]);
    const m = mergeFacts([d1, d2]);
    assert('money sums across stored days', m.sales.grossSales === 15_000 && m.sales.netRevenue === 10_500);
    assert('an order paid across two days is ONE order', m.sales.orderCount === 2);
    assert("its items are sold ONCE, not once per day", m.lines.filter((l) => l.orderId === 'A').length === 1);
    assert('a customer with two orders in the range is a repeat customer', [...m.orders.values()].filter((c) => c === 'C1').length === 2);
    assert('one unsplit day nulls the split for the range, keeps the combined figure',
        mergeFacts([d1, day('2026-09-03', 1_000, 0, [], false)]).sales.deliveryFee === null);

    const worker = readFileSync(join(__dirname, '../../src/core/jobs/aggregation-scheduler.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert('the nightly job writes the NEW store from the allocations', /VendorMoneyDailyModel\.bulkWrite/.test(worker) && /computeFacts/.test(worker));
    assert('coverage markers are written only when every vendor in the zone succeeded', /if \(failures === 0\)[\s\S]*vendor_id: null/.test(worker));
    assert('same worker key and schedule variable (no .env change)',
        /withWorkerLock\('analytics-aggregation'/.test(worker) && /ANALYTICS_AGGREGATION_CRON/.test(worker));
    const svc = readFileSync(join(__dirname, '../../src/modules/vendors/services/vendor-analytics.service.ts'), 'utf8');
    assert('reads use stored finished days and compute only the rest live', /factsFor/.test(svc) && /d < today/.test(svc) && /computeFacts\(vendorId, toAnalyticsPeriod\(missing\[0\]/.test(svc));
}

section('5. Agency and agent analytics (same rules)');
{
    assert('prepaid run: no COD fee', codFeeOf('shipment', 350, 150, null) === 0);
    assert('COD run: handling fee = agency + agent − delivery_fee_snapshot', codFeeOf('cod_collection', 1_250, 300, 1_500) === 50);
    assert('COD run without a snapshot: null, never invented', codFeeOf('cod_collection', 1_250, 300, null) === null);
    const src = readFileSync(join(__dirname, '../../src/modules/earnings/analytics/delivery-analytics.service.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    assert('earnings are read from allocations, not re-quoted', /EarningsAllocationModel\.find/.test(src) && !/applyFeeSplit|quoteFor/.test(src));
    assert('no `$lte` on a period bound', !/\$lte/.test(src));
    const agencyRoutes = readFileSync(join(__dirname, '../../src/modules/delivery/agency.routes.ts'), 'utf8');
    const agentRoutes = readFileSync(join(__dirname, '../../src/modules/delivery/agent.routes.ts'), 'utf8');
    assert('GET /api/agency/analytics is mounted', /router\.get\('\/analytics', DeliveryAnalyticsController\.agency\)/.test(agencyRoutes));
    assert('GET /api/agent/analytics is mounted', /router\.get\('\/analytics', DeliveryAnalyticsController\.agent\)/.test(agentRoutes));
}

section('6. The transactions feed can be summed');
{
    const oid = () => new Types.ObjectId();
    const ledger = (entry_type: string, amount: number) =>
        ({ _id: oid(), entry_type, amount, source_type: 'order', source_id: oid(), created_at: new Date() }) as never;
    const payout = (status: string, amount: number) =>
        ({ _id: oid(), status, amount, currency: 'XAF', created_at: new Date(), payout_method_snapshot: { method: 'mobile_money' } }) as never;

    // 10 000 held → released → 1 000 into reserve → 2 000 reversed from another hold of 2 000;
    // a paid payout of 5 000 and a rejected one of 3 000.
    const rows = [
        mapEarning(ledger('hold', 10_000), 'XAF', 'vendor'),
        mapEarning(ledger('release', 10_000), 'XAF', 'vendor'),
        mapEarning(ledger('reserve_hold', 1_000), 'XAF', 'agency'),
        mapEarning(ledger('hold', 2_000), 'XAF', 'vendor'),
        mapEarning(ledger('reversal', 2_000), 'XAF', 'vendor'),
        mapPayout(payout('paid', 5_000)),
        mapPayout(payout('rejected', 3_000)),
    ];
    const net = rows.reduce((s, r) => s + (r.direction === 'in' ? r.amount : r.direction === 'out' ? -r.amount : 0), 0);
    // Real balance change: +10 000 (kept) + 0 (2 000 held then reversed) − 5 000 paid out = 5 000.
    assert('Σ in − Σ out equals the real balance change (a release is not new money)', net === 5_000, `got ${net}`);
    assert('release is internal', rows[1].direction === 'internal');
    assert('reserve rows are internal and not labelled as a refund', rows[2].direction === 'internal' && !/refund/i.test(rows[2].description));
    assert('only a PAID payout is out', rows[5].direction === 'out' && rows[6].direction === 'internal');
    assert('a vendor hold says "Sale", an agency one "Delivery earning"',
        /^Sale/.test(rows[0].description) && /^Delivery earning/.test(mapEarning(ledger('hold', 1), 'XAF', 'agency').description));
    const svc = readFileSync(join(__dirname, '../../src/modules/transactions/services/vendor-transaction.service.ts'), 'utf8');
    assert('category=payout is wired to payout requests', /wantPayout/.test(svc) && /PayoutRequestModel\.find/.test(svc));
}

console.log(`\n${'═'.repeat(76)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═'.repeat(76));
if (failed > 0) process.exit(1);
