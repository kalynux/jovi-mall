/**
 * Test: earnings recovery ("clawback") — REFUND-FLOW-PLAN § 6, contract § 11.3.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free. The first half drives the pure rules (`domain/clawback-plan.ts`,
 * `domain/clawback-netting.ts`); the second half is SOURCE SCANS of the wiring no offline test
 * can execute: every inflow to `available_balance` nets debt, the release worker releases the
 * remainder, nothing on the clawback path writes an allocation's `amount`, and the idempotency
 * index is declared. Comments are stripped before scanning.
 *
 * Run: npm run test:earnings-clawback
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  ClawPlanRow,
  cumulativeShares,
  incrementalShares,
  planClawback,
  planRemaining,
} from '../../src/modules/earnings/domain/clawback-plan';
import {
  planBeyond,
  planRecovery,
  planTake,
  releasableAmount,
  totalTaken,
} from '../../src/modules/earnings/domain/clawback-netting';

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

const SRC = join(__dirname, '..', '..', 'src');
function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:async |private |protected |static |public )?[a-zA-Z_]+\s*(?:=|\(|<)/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Deterministic pseudo-random numbers (no flaky tests). */
let seed = 20261005;
function rand(max: number): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % max;
}

const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
const row = (id: string, amount: number, isVendor = false, remaining = amount): ClawPlanRow => ({ id, amount, isVendor, remaining });

// ─── 1. Shares: exact, monotone ──────────────────────────────────────────────
console.log('\n1. Cumulative shares');

assert('shares sum EXACTLY to min(total, Σweights)', () => {
  for (let t = 0; t < 300; t++) {
    const weights = [1 + rand(90_000), rand(12_000), rand(5_000)];
    const total = rand(120_000);
    const shares = cumulativeShares(total, weights);
    if (sum(shares) !== Math.min(total, sum(weights))) return false;
  }
  return true;
});

assert('at the full total every weight gets exactly itself', () => {
  const w = [52_450, 6_050, 4_500];
  const s = cumulativeShares(sum(w), w);
  return s[0] === 52_450 && s[1] === 6_050 && s[2] === 4_500;
});

assert('MONOTONE: raising the total never lowers a share (no Alabama paradox)', () => {
  const w = [8_500, 1_000, 500];
  let prev = cumulativeShares(0, w);
  for (let c = 1; c <= sum(w); c++) {
    const cur = cumulativeShares(c, w);
    if (cur.some((x, i) => x < prev[i])) return false;
    prev = cur;
  }
  return true;
});

assert('increments are never negative, even for a 1-unit refund', () => {
  const w = [8_500, 1_000, 500];
  for (let p = 0; p < 300; p++) {
    if (incrementalShares(p, 1, w).some((x) => x < 0)) return false;
  }
  return true;
});

assert('every share is at least floor of its exact proportion, never above its weight', () => {
  for (let t = 0; t < 300; t++) {
    const w = [1 + rand(60_000), rand(9_000), rand(4_000), rand(50)];
    const W = sum(w);
    const total = rand(W + 1);
    const s = cumulativeShares(total, w);
    if (s.some((x, i) => x < Math.floor((total * w[i]) / W) || x > w[i])) return false;
  }
  return true;
});

assert('a rounding unit goes to the LARGER share, not the 1-XAF one', () => {
  const s = cumulativeShares(1, [9_000, 1_000]);
  return s[0] === 1 && s[1] === 0;
});

assert('large amounts stay exact (BigInt arithmetic past 2^53)', () => {
  const w = [9_000_000_000, 1_000_000_007];
  const s = cumulativeShares(7_777_777_777, w);
  return sum(s) === 7_777_777_777;
});

// ─── 2. Who gives back what ──────────────────────────────────────────────────
console.log('\n2. The plan');

const ORDER = (): ClawPlanRow[] => [row('vendor', 52_450, true), row('platform', 6_050), row('ai', 4_500)];

assert('a full goods refund takes every share back exactly', () => {
  const p = planClawback({ rows: ORDER(), goods: 63_000, delivery: 0, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
  const by = new Map(p.lines.map((l) => [l.id, l.total]));
  return by.get('vendor') === 52_450 && by.get('platform') === 6_050 && by.get('ai') === 4_500 &&
    p.vendorBeyond.total === 0 && p.unrecovered === 0;
});

assert('goods: Σ lines + vendorBeyond + unrecovered === goods, always', () => {
  for (let t = 0; t < 300; t++) {
    const rows = [row('v', 1 + rand(50_000), true, 0), row('p', rand(8_000)), row('a', rand(3_000))];
    rows[0].remaining = rand(rows[0].amount + 1);
    const goods = rand(80_000);
    const p = planClawback({ rows, goods, delivery: 0, priorGoods: rand(5_000), priorDelivery: 0, deliverySpent: true });
    if (sum(p.lines.map((l) => l.goods)) + p.vendorBeyond.goods + p.unrecovered !== goods) return false;
  }
  return true;
});

assert('PARTIALS ADD UP TO THE FULL REFUND, row by row (random splits)', () => {
  for (let t = 0; t < 200; t++) {
    const amounts = [10_000 + rand(90_000), rand(15_000), rand(6_000)];
    const full = amounts[0] + amounts[1] + amounts[2];
    const fullPlan = planClawback({
      rows: [row('v', amounts[0], true), row('p', amounts[1]), row('a', amounts[2])],
      goods: full,
      delivery: 0,
      priorGoods: 0,
      priorDelivery: 0,
      deliverySpent: true,
    });
    // Split the same total into 2–4 partial refunds, applied one after another.
    const parts: number[] = [];
    let left = full;
    const n = 2 + rand(3);
    for (let k = 1; k < n; k++) {
      const x = rand(left + 1);
      parts.push(x);
      left -= x;
    }
    parts.push(left);
    const remaining = [...amounts];
    const got = [0, 0, 0];
    let prior = 0;
    for (const g of parts) {
      const p = planClawback({
        rows: [row('v', amounts[0], true, remaining[0]), row('p', amounts[1], false, remaining[1]), row('a', amounts[2], false, remaining[2])],
        goods: g,
        delivery: 0,
        priorGoods: prior,
        priorDelivery: 0,
        deliverySpent: true,
      });
      for (const l of p.lines) {
        const i = l.id === 'v' ? 0 : l.id === 'p' ? 1 : 2;
        got[i] += l.total;
        remaining[i] -= l.total;
      }
      if (p.vendorBeyond.total !== 0 || p.unrecovered !== 0) return false;
      prior += g;
    }
    const want = ['v', 'p', 'a'].map((id) => fullPlan.lines.find((l) => l.id === id)?.total ?? 0);
    if (got.some((x, i) => x !== want[i])) return false;
  }
  return true;
});

assert('a partial refund is proportional (half the goods → half of every share, ±1 rounding)', () => {
  const p = planClawback({ rows: ORDER(), goods: 31_500, delivery: 0, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
  const by = new Map(p.lines.map((l) => [l.id, l.total]));
  return Math.abs((by.get('platform') ?? 0) - 3_025) <= 1 && Math.abs((by.get('ai') ?? 0) - 2_250) <= 1 &&
    sum(p.lines.map((l) => l.total)) === 31_500;
});

assert('caps: a share gives at most its remaining; a PLATFORM shortfall is unrecovered', () => {
  const rows = [row('v', 9_000, true), row('p', 1_000, false, 200)];
  const p = planClawback({ rows, goods: 10_000, delivery: 0, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
  const plat = p.lines.find((l) => l.id === 'p')!;
  return plat.total === 200 && p.unrecovered === 800 && p.vendorBeyond.total === 0;
});

assert('caps: a VENDOR shortfall is the vendor\'s (vendorBeyond), never unrecovered', () => {
  const rows = [row('v', 9_000, true, 4_000), row('p', 1_000)];
  const p = planClawback({ rows, goods: 10_000, delivery: 0, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
  return p.lines.find((l) => l.id === 'v')!.total === 4_000 && p.vendorBeyond.goods === 5_000 && p.unrecovered === 0;
});

assert('delivery NEVER spent: goods beyond the rows are unrecovered (the platform still holds that money)', () => {
  const p = planClawback({ rows: [row('v', 8_000, true), row('p', 1_000)], goods: 10_000, delivery: 0, priorGoods: 0, priorDelivery: 0, deliverySpent: false });
  return sum(p.lines.map((l) => l.total)) === 9_000 && p.unrecovered === 1_000 && p.vendorBeyond.total === 0;
});

assert('C-8: delivery SPENT on a vendor-paid order — the goods gap is the VENDOR\'s (vendorBeyond), never unrecovered', () => {
  // 10 000 goods, free delivery 1 000 paid by the vendor to the courier: vendor row 8 000, platform 1 000.
  const p = planClawback({ rows: [row('v', 8_000, true), row('p', 1_000)], goods: 10_000, delivery: 0, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
  return sum(p.lines.map((l) => l.total)) === 9_000 && p.vendorBeyond.goods === 1_000 && p.unrecovered === 0 &&
    p.lines.find((l) => l.id === 'p')!.total === 1_000;
});

assert('C-8: an RTO leftover row of the vendor is in scope — the vendor gives it back and covers only the courier\'s part beyond', () => {
  // vendor-paid fee 1 000, returned: agency kept 400 (out of scope), vendor got 600 back (row 'vs').
  const p = planClawback({
    rows: [row('v', 8_000, true), row('p', 1_000), row('vs', 600, true)],
    goods: 10_000, delivery: 0, priorGoods: 0, priorDelivery: 0, deliverySpent: true,
  });
  const by = new Map(p.lines.map((l) => [l.id, l.total]));
  return by.get('v') === 8_000 && by.get('vs') === 600 && by.get('p') === 1_000 && p.vendorBeyond.goods === 400 && p.unrecovered === 0;
});

assert('finding 1: a cancellation before delivery takes NO delivery money from the vendor (rows or beyond)', () => {
  // customer paid 10 000 goods + 1 500 delivery; nothing was ever divided to a courier.
  const p = planClawback({ rows: ORDER(), goods: 63_000, delivery: 1_500, priorGoods: 0, priorDelivery: 0, deliverySpent: false });
  const vendorLine = p.lines.find((l) => l.id === 'vendor')!;
  return vendorLine.delivery === 0 && vendorLine.total === 52_450 && p.vendorBeyond.total === 0 && p.unrecovered === 1_500;
});

assert('finding 1: delivery-only refund with delivery never spent touches nobody', () => {
  const p = planClawback({ rows: ORDER(), goods: 0, delivery: 2_000, priorGoods: 0, priorDelivery: 0, deliverySpent: false });
  return p.lines.length === 0 && p.vendorBeyond.total === 0 && p.unrecovered === 2_000;
});

assert('goods + delivery: Σ lines + vendorBeyond + unrecovered === goods + delivery, either way', () => {
  for (let t = 0; t < 300; t++) {
    const rows = [row('v', 1 + rand(50_000), true), row('p', rand(8_000)), row('vs', rand(2_000), true)];
    const goods = rand(70_000);
    const delivery = rand(5_000);
    const p = planClawback({ rows, goods, delivery, priorGoods: 0, priorDelivery: 0, deliverySpent: rand(2) === 1 });
    if (sum(p.lines.map((l) => l.total)) + p.vendorBeyond.total + p.unrecovered !== goods + delivery) return false;
  }
  return true;
});

assert('delivery is taken from the VENDOR\'s rows only (C-1)', () => {
  const p = planClawback({ rows: ORDER(), goods: 0, delivery: 2_000, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
  return p.lines.length === 1 && p.lines[0].id === 'vendor' && p.lines[0].delivery === 2_000;
});

assert('delivery beyond the vendor\'s remaining is the vendor\'s debt-path (vendorBeyond)', () => {
  const rows = [row('v', 5_000, true, 500), row('p', 1_000)];
  const p = planClawback({ rows, goods: 0, delivery: 2_000, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
  return p.lines[0].total === 500 && p.vendorBeyond.delivery === 1_500 && p.unrecovered === 0;
});

assert('goods + delivery in one refund: goods first, delivery on what is left', () => {
  const rows = [row('v', 5_000, true), row('p', 1_000)];
  const p = planClawback({ rows, goods: 6_000, delivery: 1_000, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
  return p.lines.find((l) => l.id === 'v')!.goods === 5_000 && p.vendorBeyond.delivery === 1_000;
});

assert('a reversed (remaining 0) share gives nothing', () => {
  const p = planClawback({ rows: [row('v', 5_000, true, 0)], goods: 1_000, delivery: 0, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
  return p.lines.length === 0 && p.vendorBeyond.goods === 1_000;
});

assert('reverseRemaining takes everything still unclawed, released or held', () => {
  const lines = planRemaining([row('v', 5_000, true, 3_000), row('p', 1_000, false, 0), row('a', 400)]);
  return lines.length === 2 && lines[0].total === 3_000 && lines[1].total === 400;
});

assert('the plan refuses fractions and negatives (money is whole XAF)', () => {
  try {
    planClawback({ rows: ORDER(), goods: 10.5, delivery: 0, priorGoods: 0, priorDelivery: 0, deliverySpent: true });
    return false;
  } catch {
    return true;
  }
});

// ─── 3. Where the money comes from ───────────────────────────────────────────
console.log('\n3. Netting order');

assert('a HELD share is taken from pending, whatever available holds', () => {
  const t = planTake(700, { status: 'held', reserveHeld: 0 }, 10_000);
  return t.pending === 700 && t.available === 0 && t.debt === 0;
});
assert('a RELEASED share: its own reserve slice → available → debt', () => {
  const t = planTake(1_000, { status: 'released', reserveHeld: 150 }, 600);
  return t.reserve === 150 && t.available === 600 && t.debt === 250 && totalTaken(t) === 1_000;
});
assert('a released share with enough available owes nothing', () => {
  const t = planTake(1_000, { status: 'released', reserveHeld: 0 }, 5_000);
  return t.available === 1_000 && t.debt === 0;
});
assert('money beyond the shares: available, then debt', () => {
  const t = planBeyond(900, 400);
  return t.available === 400 && t.debt === 500 && t.pending === 0 && t.reserve === 0;
});
assert('an inflow pays debt FIRST, the rest reaches available', () => {
  const a = planRecovery(1_000, 300);
  const b = planRecovery(1_000, 5_000);
  return a.recovered === 300 && a.toAvailable === 700 && b.recovered === 1_000 && b.toAvailable === 0;
});
assert('no debt → the whole inflow reaches available', () => planRecovery(800, 0).toAvailable === 800);
assert('the worker releases amount − clawed_amount (legacy rows: the whole amount)', () =>
  releasableAmount({ amount: 5_000, clawed_amount: 1_200 }) === 3_800 &&
  releasableAmount({ amount: 5_000 }) === 5_000 &&
  releasableAmount({ amount: 5_000, clawed_amount: 5_000 }) === 0);

// ─── 4. Every inflow to available nets debt (source scans) ───────────────────
console.log('\n4. Inflows net debt');

const accountRepo = code('modules/earnings/repositories/earnings-account.repository.ts');
for (const m of ['async release(', 'async releaseWithReserve(', 'async releaseReserve(', 'async releaseRequestedToAvailable(']) {
  assert(`${m.replace('async ', '').replace('(', '')} goes through the netting pipeline`, () =>
    /this\.nettingInflow\(/.test(methodBody(accountRepo, m)));
}
assert('the netting pipeline recovers min(inflow, clawback_balance) in the SAME update', () => {
  const body = methodBody(accountRepo, 'private async nettingInflow(');
  return /\$min:\s*\[inflow,\s*debt\]/.test(body) && /clawback_balance:\s*\{\s*\$subtract/.test(body) && /findOneAndUpdate\(/.test(body);
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
assert('NOWHERE in src/ does a $inc ADD to available_balance (every credit is a netting pipeline)', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const incs = src.match(/\$inc:\s*\{[^}]*\}/g) ?? [];
    for (const inc of incs) {
      const m = inc.match(/available_balance:\s*([^,}\n]+)/);
      if (m && !m[1].trim().startsWith('-')) offenders.push(`${file}: ${inc}`);
    }
  }
  if (offenders.length) console.error(offenders.join('\n'));
  return offenders.length === 0;
});

const accountSvc = code('modules/earnings/services/earnings-account.service.ts');
assert('a release moves releasableAmount(allocation), not allocation.amount', () => {
  const body = methodBody(accountSvc, 'async releaseInSession(');
  return /releasableAmount\(allocation\)/.test(body) && !/release\(account\._id,\s*allocation\.amount/.test(body);
});
assert('a release with reserve moves the remainder too', () =>
  /releasableAmount\(allocation\)/.test(methodBody(accountSvc, 'async releaseWithReserveInSession(')));
assert('recovered debt writes a clawback_recovery ledger row AND an adjustment', () => {
  const body = methodBody(accountSvc, 'private async recordRecovery(');
  return /entry_type:\s*'clawback_recovery'/.test(body) && /kind:\s*'clawback_recovery'/.test(body);
});
assert('a payout returned to available nets debt and records the recovery', () => {
  const body = methodBody(accountSvc, 'async revertPayoutToAvailableInSession(');
  return /releaseRequestedToAvailable\(/.test(body) && /kind:\s*'clawback_recovery'/.test(body);
});
const payoutSvc = code('modules/earnings/services/payout-request.service.ts');
assert('payout REJECT and the failed-ticket compensation both pass a recovery key', () =>
  /recovery:payout:\$\{payoutRequestId\}:rejected/.test(payoutSvc) &&
  /recovery:payout:\$\{payoutRequest\.id\}:ticket_failed/.test(payoutSvc));

// ─── 5. The release worker releases the remainder ────────────────────────────
console.log('\n5. Release worker');

const worker = code('modules/earnings/workers/earnings-release.worker.ts');
assert('the reserve slice is computed on the remainder', () =>
  /releasableAmount\(allocation\)/.test(methodBody(worker, 'private reserveAmountFor(')));
assert('the worker releases through the account service (which nets and uses the remainder)', () => {
  const body = methodBody(worker, 'private async releaseMaturedHolds(');
  return /releaseWithReserveInSession\(/.test(body) && /releaseInSession\(/.test(body);
});

// ─── 6. The clawback writes clawed_amount, never amount ──────────────────────
console.log('\n6. amount is never written');

const allocRepo = code('modules/earnings/repositories/earnings-allocation.repository.ts');
const addClawed = methodBody(allocRepo, 'async addClawed(');
assert('addClawed is a compare-and-set on status AND clawed_amount', () =>
  /status:\s*expectedStatus/.test(addClawed) && /clawed_amount:\s*expectedClawed/.test(addClawed));
assert('addClawed sets clawed_amount (and reversed when nothing is left), never amount', () =>
  /clawed_amount:\s*next/.test(addClawed) && /status\s*=\s*'reversed'/.test(addClawed) && !/set\.amount|\$set:\s*\{\s*amount/.test(addClawed));
assert('adjustHeldAmount refuses a new amount below clawed_amount', () =>
  /clawed_amount:\s*\{\s*\$not:\s*\{\s*\$gt:\s*newAmount/.test(methodBody(allocRepo, 'async adjustHeldAmount(')));

const clawSvc = code('modules/earnings/services/earnings-clawback.service.ts');
assert('the clawback service writes no document itself (repositories only)', () =>
  !/\.(updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|save)\(/.test(clawSvc));
assert('the clawback service never names `amount:` in a write to an allocation', () =>
  !/addClawed\([^)]*amount:/.test(clawSvc));
assert('agency and agent shares are never in scope (C-1, C-3)', () =>
  /CLAWABLE_BENEFICIARIES[^=]*=\s*\['vendor',\s*'platform',\s*'platform_ai'\]/.test(clawSvc));
assert('a fee-only COD collection is never in scope', () => /kind:\s*\{\s*\$ne:\s*'delivery_fee'\s*\}/.test(clawSvc));
assert('a booking\'s scope includes its balance-payment rows', () => /bookingSourcesOf\(target\.id\)/.test(clawSvc));
assert('C-8: an order\'s scope includes its SHIPMENT sources (the vendor\'s RTO leftover row)', () =>
  /ShipmentModel\.find\(\{\s*order_id:\s*orderId\s*\}/.test(clawSvc) && /\.\.\.shipmentSources,\s*\],\s*homeSources/.test(clawSvc));
assert('finding 1 / C-8: applyRefund decides deliverySpent from the delivery probe, inside the transaction', () =>
  /deliverySpent:\s*await this\.deliverySpent\(scope,\s*session\)/.test(methodBody(clawSvc, 'async applyRefund(')) &&
  /findBySources\(scope\.deliveryProbe,\s*session\)/.test(clawSvc) &&
  /source_type === 'shipment' \|\| row\.beneficiary_type === 'agency' \|\| row\.beneficiary_type === 'agent'/.test(clawSvc));
assert('a booking has no delivery probe (never "spent")', () => /deliveryProbe:\s*\[\],/.test(clawSvc));
assert('one transaction per refund, retried on a transient conflict', () => /runInTransactionWithRetry\(/.test(clawSvc));
assert('idempotent: an applied refund_key answers alreadyApplied, a duplicate-key race too', () =>
  /existsForRefund\(refundKey\)/.test(clawSvc) && /isDuplicateKey\(error\)\)\s*return EMPTY\(refundKey,\s*true\)/.test(clawSvc));
assert('C-7: a pending payout gets a ticket note, never a cut', () =>
  /createSystemNote\(/.test(clawSvc) && !/deductFromRequested|moveAvailableToRequested/.test(clawSvc));

const refundSvc = code('modules/earnings/services/earnings-refund.service.ts');
assert('EarningsRefundService is a thin wrapper (reverseRemaining), no direct reversal left', () =>
  /reverseRemaining\(/.test(refundSvc) && !/markReversed|reverseInSession/.test(refundSvc));

// ─── 7. The idempotency index ────────────────────────────────────────────────
console.log('\n7. earnings_adjustments');

const adjModel = code('modules/earnings/models/earnings-adjustment.model.ts');
assert('unique on {refund_key, allocation_id, kind} is DECLARED', () =>
  /index\(\s*\{\s*refund_key:\s*1,\s*allocation_id:\s*1,\s*kind:\s*1\s*\},\s*\{\s*unique:\s*true/.test(adjModel));
assert('the three kinds of § 11.3', () => /enum:\s*\['refund_clawback',\s*'write_off',\s*'clawback_recovery'\]/.test(adjModel));
assert('registered as EARNINGS_ADJUSTMENT → earnings_adjustments', () =>
  /EARNINGS_ADJUSTMENT:\s*'earnings_adjustments'/.test(code('core/database/collections.ts')));
assert('adjustments are created in the ARRAY form (the session is honoured)', () =>
  /EarningsAdjustmentModel\.create\(\s*\[/.test(code('modules/earnings/repositories/earnings-adjustment.repository.ts')));

// ─── 8. Fields, closure, admin surface ───────────────────────────────────────
console.log('\n8. Fields and surfaces');

assert('EarningsAccount.clawback_balance ≥ 0, default 0', () =>
  /clawback_balance:\s*\{\s*type:\s*Number,\s*required:\s*true,\s*default:\s*0,\s*min:\s*0\s*\}/.test(
    code('modules/earnings/models/earnings-account.model.ts')));
assert('EarningsAllocation.clawed_amount ≥ 0, default 0', () =>
  /clawed_amount:\s*\{\s*type:\s*Number,\s*required:\s*true,\s*default:\s*0,\s*min:\s*0\s*\}/.test(
    code('modules/earnings/models/earnings-allocation.model.ts')));
assert('a reserve hold can be `clawed`', () =>
  /enum:\s*\['held',\s*'released',\s*'clawed'\]/.test(code('modules/earnings/models/earnings-reserve-hold.model.ts')));
assert('the ledger knows clawback / clawback_recovery / clawback_write_off', () => {
  const ledger = code('modules/earnings/models/earnings-ledger.model.ts');
  return /'clawback',\s*'clawback_recovery',\s*'clawback_write_off'\]/.test(ledger) && /'refund_clawback'/.test(ledger);
});
assert('role closure is refused while a clawback debt stands (C-5)', () =>
  /'earnings_clawback_outstanding'/.test(code('modules/role-closure/role-closure.types.ts')) &&
  /push\('earnings_clawback_outstanding'/.test(code('modules/role-closure/services/role-closure-blockers.service.ts')));
assert('getBalances reports `clawback`', () => /clawback:\s*account\?\.clawback_balance/.test(accountSvc));
const routes = code('modules/earnings/routes/admin-earnings.routes.ts');
assert('GET /clawbacks and POST /clawbacks/:ownerType/:ownerId/write-off are mounted', () =>
  /router\.get\('\/clawbacks',/.test(routes) && /router\.post\('\/clawbacks\/:ownerType\/:ownerId\/write-off',/.test(routes));
assert('the write-off actor comes from the admin-caller headers', () =>
  /adminCallerActor\(req\)/.test(methodBody(code('modules/earnings/controllers/admin-earnings.controller.ts'), 'static writeOffClawback')));
assert('migrate:earnings-clawback-fields is registered BEFORE migrate:declared-indexes', () => {
  const migrate = readFileSync(join(__dirname, '..', 'migrate.ts'), 'utf8');
  const a = migrate.indexOf("name: 'migrate:earnings-clawback-fields'");
  const b = migrate.indexOf("name: 'migrate:declared-indexes'");
  return a > -1 && b > a;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
