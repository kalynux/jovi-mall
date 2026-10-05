/**
 * test:refund-entry-points — the refund flow's ENTRY POINTS, wired onto refund requests
 * (REFUND-FLOW-PLAN § 4, R6), plus the boot wiring and the migrations that carry them. Offline.
 *
 *   1. Boot wiring (§ 11.2)        — both ports registered before the listener, the COD subscriber,
 *                                     the nightly sweep scheduled and inventoried
 *   2. The earnings port adapter    — pause on open (a no-op over another pause is the pause's own
 *                                     rule), resume ONLY refund_in_progress, claw THEN close
 *   3. Vendor                       — opens a request through RefundRequestService; never the
 *                                     gateway; the delivery-anchored return window kept
 *   4. Legacy admin route           — ⛔ refuses ≥ 2,000,000 (REFUND_USE_REFUND_QUEUE, 422)
 *   5. Booking                      — a system request; PAUSES, never reverses, before the customer
 *                                     is paid; the balance payment is a refundable leg
 *   6. Delivery-fee refunds         — a system request with NO earnings impact; the ledger row
 *                                     follows the request; the legacy settle screen refuses a
 *                                     linked row
 *   7. raiseRefundOwed (D-4)        — a request awaiting approval, linked to the ticket
 *   8. Disputes                     — earnings recovery keyed `dispute:<id>`
 *   9. Transactions feed            — clawback out; recovery / write-off internal
 *  10. Migrations                   — registered, ordered data-before-index, names match the model
 *  11. `earningsImpact: 'none'`     — RefundRequestService against a fake repository: no port
 *                                     needed, attribution is delivery, nothing paused
 *
 * DB-free and network-free. Run: npm run test:refund-entry-points
 */

process.env.LOG_STDOUT = 'false';

import { readFileSync } from 'fs';
import { join } from 'path';
import { Types } from 'mongoose';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { RefundEarningsAdapter } from '../../src/modules/earnings/services/refund-earnings.adapter';
import { RefundCashRecheckWorker, refundCashRecheckWorker } from '../../src/modules/payments/workers/refund-cash-recheck.worker';
import { WORKER_INVENTORY, WORKER_KEYS } from '../../src/modules/dev-tools/worker-registry';
import { disputeRefundKey } from '../../src/modules/payments/services/dispute.service';
import { LEGACY_ADMIN_REFUND_CEILING } from '../../src/modules/orders/admin-refund.service';
import { computeVendorRefundEligibility, reasonKindOf } from '../../src/modules/vendor/service/vendor-refund.service';
import { planRefundLegs } from '../../src/modules/payments/domain/refund-legs';
import { mapEarning } from '../../src/modules/transactions/services/vendor-transaction.service';
import { MIGRATIONS } from '../migrate';
import { PLANNED as REFUND_INDEXES } from '../migrate-refund-requests-indexes';
import { OPEN_REFUND_STATUSES } from '../../src/modules/payments/domain/refund-status';
import { RefundRequestService } from '../../src/modules/payments/services/refund-request.service';
import { __resetRefundPortsForTests } from '../../src/modules/payments/domain/refund-ports';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
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

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
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

function section(title: string): void {
  originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

const root = join(__dirname, '..', '..');
const raw = (p: string) => readFileSync(join(root, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = (p: string) => stripComments(raw(join('src', p)));
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  return a < 0 ? '' : s.slice(a, b < 0 ? undefined : b);
};

async function main(): Promise<void> {
  // ───────────────────────────────────────────────────────────────────────────
  section('1. Boot wiring — ports, the COD subscriber, the nightly sweep');
  const lifecycle = src('lifecycle.ts');
  const boot = src('modules/payments/refund.bootstrap.ts');
  assert('lifecycle calls initializeRefundDomain() BEFORE startBackgroundWork() and the listener', () => {
    const init = lifecycle.indexOf('initializeRefundDomain();');
    return init > 0 && init < lifecycle.indexOf('startBackgroundWork();') && init < lifecycle.indexOf('app.listen(');
  });
  assert('…imported by PATH, not through a barrel (the require-cycle rule)', () =>
    lifecycle.includes("from './modules/payments/refund.bootstrap'"));
  assert('the bootstrap registers BOTH ports — the earnings adapter and the COD coverage read', () =>
    /registerRefundPorts\(\{\s*earnings:\s*refundEarningsAdapter,\s*codCoverage:\s*codCoverageService\s*\}\)/.test(boot));
  assert('…and subscribes the COD release (cod.collections.settled)', () => boot.includes('registerRefundCodSubscriber();'));
  assert('…once: a second call registers nothing twice', () => boot.includes('if (initialized) return;'));
  assert('the nightly sweep is STARTED at boot', () => lifecycle.includes('refundCashRecheckWorker.start();'));
  assert('…and is inventoried + triggerable (a worker nobody can see is one nobody can stop)', () =>
    WORKER_KEYS.includes('refund-cash-recheck' as never)
    && WORKER_INVENTORY.some((e) => e.key === 'refund-cash-recheck' && e.worker === refundCashRecheckWorker));
  assert('its schedule is the value it schedules with: a nightly 5-field cron, source "hardcoded"', () => {
    const s = refundCashRecheckWorker.schedules[0];
    return s.kind === 'cron' && s.expression === RefundCashRecheckWorker.CRON
      && s.expression.trim().split(/\s+/).length === 5 && s.source === 'hardcoded';
  });
  const worker = src('modules/payments/workers/refund-cash-recheck.worker.ts');
  assert('the sweep runs recheckWaitingForCash under the shared overlap lock', () =>
    worker.includes("withWorkerLock('refund-cash-recheck'") && worker.includes('refundRequestService.recheckWaitingForCash('));
  assert('…and respects a maintenance window at the tick site', () => worker.includes('if (maintenanceBlocksWorkers()) return;'));

  // ───────────────────────────────────────────────────────────────────────────
  section('2. The earnings port adapter — pause, resume, claw then close');
  {
    const calls: string[] = [];
    const pauses: any = {
      pause: async (_t: unknown, reason: string) => { calls.push(`pause:${reason}`); return { changed: true, pause: null }; },
      resume: async (_t: unknown, _a: unknown, _n: unknown, only: string[]) => { calls.push(`resume:${only.join('|')}`); return { changed: true, pause: null }; },
      closeOnRefund: async () => { calls.push('close'); return { changed: true, pause: null }; },
    };
    let clawThrows = false;
    const clawback: any = {
      applyRefund: async (input: any) => {
        calls.push(`claw:${input.refundKey}:${input.attribution.goods}+${input.attribution.delivery}:${input.codCollectionIds?.length ?? 'none'}`);
        if (clawThrows) throw new Error('boom');
        return {};
      },
    };
    const adapter = new RefundEarningsAdapter(pauses, clawback);
    const target = { kind: 'order' as const, id: new Types.ObjectId().toString() };

    await adapter.onRequestOpened(target, 'rq1');
    assert('opened → pause with reason refund_in_progress', () => calls[0] === 'pause:refund_in_progress');
    await adapter.onRequestClosedWithoutRefund(target, 'rq1');
    assert('closed without a refund → resume ONLY a refund_in_progress pause', () => calls[1] === 'resume:refund_in_progress');
    await adapter.onRefundCompleted({ refundKey: 'rq1', target, attribution: { goods: 4000, delivery: 500 }, codCollectionIds: [] });
    assert('completed → claw back by attribution FIRST, then close the pause', () =>
      calls[2] === 'claw:rq1:4000+500:none' && calls[3] === 'close');
    calls.length = 0;
    await adapter.onRefundCompleted({ refundKey: 'rq2', target, attribution: { goods: 1, delivery: 0 }, codCollectionIds: ['c1', 'c2'] });
    assert('COD collection ids are passed through to the clawback', () => calls[0] === 'claw:rq2:1+0:2');
    calls.length = 0;
    clawThrows = true;
    let threw = false;
    try {
      await adapter.onRefundCompleted({ refundKey: 'rq3', target, attribution: { goods: 1, delivery: 0 }, codCollectionIds: [] });
    } catch {
      threw = true;
    }
    assert('⛔ a failed clawback does NOT close the pause (paused money stays visible)', () => threw && !calls.includes('close'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('3. Vendor — a refund REQUEST, never the gateway');
  const vendor = src('modules/vendor/service/vendor-refund.service.ts');
  const vendorRefund = between(vendor, 'async refund(', 'private async evaluate(');
  assert('the vendor path opens the request through RefundRequestService.create', () => vendorRefund.includes('this.refunds.create('));
  assert('…as role vendor, asking to send at once (honoured only within policy, to the payer, not COD)', () =>
    vendorRefund.includes("role: 'vendor'") && vendorRefund.includes('approveNow: true') && vendorRefund.includes('overridePolicy: false'));
  assert('…and never calls the orchestrator\'s refundPayment', () => !vendor.includes('refundPayment('));
  assert('the open-request guard is checked before anything is created (409 REFUND_ALREADY_OPEN)', () =>
    vendor.includes("findOpenForSource('order'") && vendorRefund.includes('ERROR_CODES.REFUND_ALREADY_OPEN'));
  assert('the offered maximum is capped by the SAME ceiling create enforces (attribution + money)', () =>
    vendor.includes('describeSource(') && vendor.includes('maxAttributable('));
  assert('the return window still starts at DELIVERY (deliveredAtOf), never at order creation', () =>
    vendor.includes('const windowStart = deliveredAtOf(order);'));
  assert('a partial policy offers a WHOLE amount, rounded down', () => {
    const order: any = { payment_status: 'paid', delivered_at: null, currency: 'XAF' };
    const policy: any = { return_eligible: true, refund_type: 'partial', refund_percentage: 50, return_window_days: 14 };
    const v = computeVendorRefundEligibility(order, policy, { amountSnapshot: 999, totalRefunded: 0, currencySnapshot: 'XAF' });
    return v.eligible && v.maxRefundable === 499;
  });
  assert('finding 10: the vendor\'s offer re-runs the policy on THIS order\'s refundable money (not a cart payment)', () => {
    const evaluate = between(vendor, 'private async evaluate(', 'export function reasonKindOf(');
    return /computeVendorRefundEligibility\(order, returnPolicy, \{\s*amountSnapshot: facts\.remaining,\s*totalRefunded: 0,/.test(evaluate)
      && /Math\.min\(scoped\.maxRefundable, attributionCeiling, facts\.remaining\)/.test(evaluate)
      && !/Math\.min\(pure\.maxRefundable/.test(evaluate);
  });
  assert('finding 10: a 50 % policy on a 10 000 order inside a 100 000 cart offers 5 000, not 50 000', () => {
    const order: any = { payment_status: 'paid', delivered_at: null, currency: 'XAF' };
    const policy: any = { return_eligible: true, refund_type: 'partial', refund_percentage: 50, return_window_days: 14 };
    const cartWide = computeVendorRefundEligibility(order, policy, { amountSnapshot: 100_000, totalRefunded: 0, currencySnapshot: 'XAF' });
    const scoped = computeVendorRefundEligibility(order, policy, { amountSnapshot: 10_000, totalRefunded: 0, currencySnapshot: 'XAF' });
    return cartWide.maxRefundable === 50_000 && Math.min(scoped.maxRefundable, 10_000) === 5_000;
  });
  assert('finding 10: the legacy admin route reports the vendor policy on the order\'s money too', () => {
    const ev = between(src('modules/orders/admin-refund.service.ts'), 'private async evaluate(', 'export const adminRefundService');
    return /vendorPolicy = computeVendorRefundEligibility\(order, returnPolicy, \{\s*amountSnapshot: facts\.remaining,/.test(ev);
  });
  assert('before delivery the request is a cancellation (D-5); after, a return (C-1)', () =>
    reasonKindOf({ delivered_at: null }) === 'cancellation' && reasonKindOf({ delivered_at: new Date() }) === 'return');
  assert('the vendor body accepts a whole amount only, plus the C-1 itemDefective tick', () => {
    const v = src('modules/vendor/validators/vendor-order.validator.ts');
    return v.includes("z.number().int('Amount must be a whole number')") && v.includes('itemDefective: z.boolean().optional()');
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('4. Legacy admin route — ⛔ refuses 2,000,000 and above');
  const admin = src('modules/orders/admin-refund.service.ts');
  const adminRefund = between(admin, 'async refund(', 'private async load(');
  assert('the ceiling is 2,000,000 — the same line as wi-admin\'s four-eyes', () => LEGACY_ADMIN_REFUND_CEILING === 2_000_000);
  assert('amount ≥ ceiling → 422 REFUND_USE_REFUND_QUEUE, checked BEFORE the request is created', () => {
    const guard = adminRefund.indexOf('amount >= LEGACY_ADMIN_REFUND_CEILING');
    return guard > 0 && guard < adminRefund.indexOf('this.refunds.create(')
      && /ERROR_CODES\.REFUND_USE_REFUND_QUEUE,\s*422/.test(adminRefund);
  });
  assert('finding 8: the line is CUMULATIVE per order (completed refunds + this amount), so it cannot be split', () => {
    const sum = adminRefund.indexOf('const alreadyRefunded = await sumCompletedRefundsForOrder(orderId);');
    const guard = adminRefund.indexOf('if (alreadyRefunded + amount >= LEGACY_ADMIN_REFUND_CEILING)');
    // Open requests are refused above (REFUND_ALREADY_OPEN), so completed refunds are the whole history.
    const openGuard = adminRefund.indexOf('verdict.openRefundRequest');
    return sum > 0 && guard > sum && openGuard > -1 && openGuard < guard && /alreadyRefunded,/.test(adminRefund);
  });
  assert('REFUND_USE_REFUND_QUEUE is a registered code with its own message', () =>
    ERROR_CODES.REFUND_USE_REFUND_QUEUE === 'REFUND_USE_REFUND_QUEUE'
    && typeof (DEFAULT_ERROR_MESSAGES as Record<string, string>)[ERROR_CODES.REFUND_USE_REFUND_QUEUE] === 'string');
  assert('the admin creates as role admin, and is the approver only where money can be sent', () =>
    adminRefund.includes("role: 'admin'") && adminRefund.includes('approveNow: verdict.gatewayRefundSupported'));
  assert('COD is no longer refused outright (REFUND_ORDER_IS_COD gone from the refund path)', () =>
    !adminRefund.includes('REFUND_ORDER_IS_COD'));
  assert('the dispute hold still freezes it (423) and the override still has to be deliberate (422)', () =>
    adminRefund.includes('ORDER_DISPUTE_HOLD, 423') && adminRefund.includes('REFUND_POLICY_OVERRIDE_REQUIRED'));

  // ───────────────────────────────────────────────────────────────────────────
  section('5. Booking — a system request; PAUSE, never reverse, before the customer is paid');
  const booking = src('modules/booking/services/booking-refund.service.ts');
  assert('the booking path opens a SYSTEM refund request, asking to send at once', () =>
    booking.includes('refunds.create(') && booking.includes("role: 'system'") && booking.includes('approveNow: true'));
  assert('⛔ nothing on the booking path reverses earnings any more', () =>
    !booking.includes('earningsRefundService') && !booking.includes('onRefund(') && !booking.includes('reverseRemaining('));
  assert('the no-request fallback PAUSES (booking_cancelled_unrefunded) and opens a ticket', () => {
    const manual = between(booking, 'private async markPendingManualRefund(', 'private async syncCalendar(');
    return manual.includes("'booking_cancelled_unrefunded'") && manual.includes('earningsPauseService.pause(') && manual.includes('createSystemTicket(');
  });
  assert('refund_pending is set by a compare-and-set FROM paid (a completed refund is never overwritten)', () =>
    booking.includes("{ _id: bookingId, paymentStatus: 'paid' }, { $set: { paymentStatus: 'refund_pending' } }"));
  assert('the BALANCE payment is a refundable booking leg (decision 9 fixed)', () => {
    const orch = src('modules/payments/services/payment-orchestrator.service.ts');
    const legs = between(orch, 'async resolveRefundLegs(', 'async refundableFor(');
    return legs.includes("purpose: { $in: ['primary', 'booking_balance', null] }");
  });
  assert('…and refunds AFTER the primary charge under primary_first', () => {
    const plan = planRefundLegs(
      [{ id: 'bal', purpose: 'booking_balance', remaining: 500 }, { id: 'pri', purpose: 'primary', remaining: 1000 }],
      1200,
      'primary_first'
    );
    return JSON.stringify(plan) === JSON.stringify([{ id: 'pri', amount: 1000 }, { id: 'bal', amount: 200 }]);
  });
  assert('"fully refunded" for a booking counts the balance payment too', () => {
    const svc = src('modules/payments/services/refund-request.service.ts');
    return between(svc, "if (row.source_kind === 'booking') {", 'return { fullyRefunded: false').includes("'booking_balance'");
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('6. Delivery-fee refunds — a request that touches no earnings');
  const dfr = src('modules/delivery-fee-proposals/services/delivery-fee-refund.service.ts');
  const outstanding = between(dfr, 'async refundOutstanding(', 'async sweepOutstanding(');
  assert('a SYSTEM request, top-up first, sent at once, with earningsImpact none', () =>
    outstanding.includes('refunds.create(') && outstanding.includes("role: 'system'")
    && outstanding.includes("prefer: 'topup_first'") && outstanding.includes("earningsImpact: 'none'") && outstanding.includes('approveNow: true'));
  assert('the claim row is linked to its request', () => outstanding.includes('claim.refund_request_id = request._id'));
  assert('a completed request closes the row; a rejected one returns it to the manual screen, unlinked', () => {
    const follow = between(dfr, 'private async followRequest(', 'private async recordRow(');
    return follow.includes("status: 'completed'") && follow.includes("status: 'manual_required'")
      && follow.includes('rejected_refund_request_id: request._id') && follow.includes('refund_request_id: null');
  });
  assert('payment.refunded closes a row whose transfer settled later; the daily sweep is the backstop', () =>
    dfr.includes("'payment.refunded'") && between(dfr, 'async sweepOutstanding(', 'async onEarningsSplit(').includes('this.followRequest('));
  assert('a legacy processing row (no request) is still closed as manual when stale — a linked one never is', () =>
    /status: 'processing',\s*refund_request_id: null,\s*created_at:/.test(between(dfr, 'async sweepOutstanding(', 'async onEarningsSplit(')));
  assert('⛔ the legacy settle screen refuses a row whose money sits in an open refund request', () => {
    const adm = src('modules/delivery-fee-proposals/services/delivery-fee-refund-admin.service.ts');
    const settle = between(adm, 'async settle(', 'private async closeTicketBestEffort(');
    return settle.includes('if (row.refund_request_id)') && settle.indexOf('if (row.refund_request_id)') < settle.indexOf('runInTransaction(');
  });
  assert('RefundRequestService: earnings_impact none → no pause target, no clawback', () => {
    const svc = src('modules/payments/services/refund-request.service.ts');
    return /function pauseTargetOf\([\s\S]*?if \(row\.earnings_impact === 'none'\) return null;/.test(svc)
      && svc.includes("earnings_impact: unallocated ? 'none' : 'clawback'")
      && svc.includes("!unallocated && (input.source.kind === 'order' || input.source.kind === 'booking')");
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('7. raiseRefundOwed (D-4) — a request awaiting approval, linked to the ticket');
  const owed = src('modules/earnings/services/refund-owed.service.ts');
  assert('it opens a SYSTEM request with approveNow FALSE (a person still decides)', () =>
    owed.includes('refundRequestService.create(') && owed.includes("role: 'system'") && owed.includes('approveNow: false'));
  assert('…AFTER the ticket, carrying its id', () =>
    owed.indexOf('createSystemTicket(') < owed.indexOf('refundRequestService.create(') && owed.includes('ticketId,'));
  assert('…best-effort: its failure is logged, never thrown', () =>
    /catch \(error\) \{\s*console\.error\(`\[RefundOwed\] could not open the refund request/.test(owed));
  assert('…loaded on first use (payments reaches back into earnings)', () =>
    owed.includes("await import('../../payments/services/refund-request.service')"));

  // ───────────────────────────────────────────────────────────────────────────
  section('8. Disputes — earnings recovery keyed dispute:<id>');
  assert('dispute id first, then the PaymentIntent, then the source', () =>
    disputeRefundKey('dp_1', 'pi_1', 'o1') === 'dispute:dp_1'
    && disputeRefundKey(null, 'pi_1', 'o1') === 'dispute:pi_1'
    && disputeRefundKey(null, '', 'o1') === 'dispute:o1');
  const dispute = src('modules/payments/services/dispute.service.ts');
  assert('a lost ORDER dispute recovers with that key', () =>
    dispute.includes('earningsRefundService.onOrderRefund(orderId, disputeRefundKey(disputeId, paymentIntentId, orderId))'));
  assert('a lost BOOKING dispute recovers with that key (booking + balance rows)', () =>
    dispute.includes("earningsRefundService.onRefund('booking', bookingId, disputeRefundKey(disputeId, paymentIntentId, bookingId))"));
  assert('resolving a dispute by hand keys on the dispute the order was frozen by', () =>
    dispute.includes("held?.dispute_hold?.gateway_dispute_id ?? null"));
  assert('the webhook\'s own idempotency is untouched (already-refunded → no unwind)', () =>
    dispute.includes("if (order.payment_status === 'refunded') {") && dispute.includes("if (booking.paymentStatus === 'refunded') return; // already unwound"));

  // ───────────────────────────────────────────────────────────────────────────
  section('9. Transactions feed — clawback out; recovery and write-off internal');
  const row = (entry_type: string): any => ({
    _id: new Types.ObjectId(), entry_type, amount: 100, source_type: 'order', source_id: new Types.ObjectId(), created_at: new Date(),
  });
  assert('clawback → out', () => mapEarning(row('clawback'), 'XAF', 'vendor').direction === 'out');
  assert('clawback_recovery → internal (the clawback row already counted it out)', () =>
    mapEarning(row('clawback_recovery'), 'XAF', 'vendor').direction === 'internal');
  assert('clawback_write_off → internal, with a description of its own', () => {
    const m = mapEarning(row('clawback_write_off'), 'XAF', 'vendor');
    return m.direction === 'internal' && m.description !== 'Earnings movement';
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('10. Migrations — registered, data before index, names match the model');
  const names = MIGRATIONS.map((m) => m.name);
  const dataAt = names.indexOf('migrate:legacy-refunds-to-requests');
  const indexAt = names.indexOf('migrate:refund-requests-indexes');
  assert('both are registered', () => dataAt >= 0 && indexAt >= 0);
  assert('the data migration runs BEFORE the index build, which runs before the catch-all', () =>
    dataAt < indexAt && indexAt < names.indexOf('migrate:declared-indexes'));
  assert('both accept --dry-run', () =>
    MIGRATIONS.filter((m) => m.name === 'migrate:legacy-refunds-to-requests' || m.name === 'migrate:refund-requests-indexes')
      .every((m) => m.dryRun && raw(m.file).includes('--dry-run')));
  const unique = REFUND_INDEXES.find((i) => i.name === 'refund_one_open_per_source');
  assert('the partial unique index is built with EXACTLY the open statuses', () =>
    unique !== undefined && (unique.options as any)?.unique === true
    && JSON.stringify((unique.options as any)?.partialFilterExpression?.status?.$in) === JSON.stringify([...OPEN_REFUND_STATUSES]));
  assert('the migration builds as many indexes as the model declares, the named two by their names', () => {
    const model = raw('src/modules/payments/models/refund-request.model.ts');
    const declared = (model.match(/RefundRequestSchema\.index\(/g) ?? []).length;
    return declared === REFUND_INDEXES.length
      && model.includes("name: 'refund_one_open_per_source'") && model.includes("name: 'refund_transfer_leg_reference'")
      && REFUND_INDEXES.some((i) => i.name === 'refund_transfer_leg_reference');
  });
  assert('…and the unnamed four under Mongoose\'s default names, keys as declared', () => {
    const model = raw('src/modules/payments/models/refund-request.model.ts');
    const unnamed: Array<[string, string]> = [
      ['{ status: 1, created_at: -1 }', 'status_1_created_at_-1'],
      ['{ status: 1, updated_at: 1 }', 'status_1_updated_at_1'],
      ['{ cod_collection_ids: 1, status: 1 }', 'cod_collection_ids_1_status_1'],
      ['{ source_id: 1, created_at: -1 }', 'source_id_1_created_at_-1'],
    ];
    return unnamed.every(([key, name]) =>
      model.includes(`RefundRequestSchema.index(${key});`) && REFUND_INDEXES.some((i) => i.name === name));
  });
  const legacy = raw('scripts/migrate-legacy-refunds-to-requests.ts');
  assert('the legacy migration raises AWAITING APPROVAL through the live service, sending nothing', () =>
    legacy.includes('refundRequestService.create(') && !legacy.includes('approveNow: true') && legacy.includes('approveNow: false'));
  assert('…delivery rows carry no earnings impact; bookings already carrying a request are skipped', () =>
    legacy.includes("earningsImpact: 'none'") && legacy.includes("RefundRequestModel.exists({ source_kind: 'booking'"));
  assert('…a rejected (unlinked) delivery row is never re-raised', () => legacy.includes('rejected_refund_request_id: null'));

  // ───────────────────────────────────────────────────────────────────────────
  section('11. earningsImpact none — against a fake repository, no earnings port');
  {
    __resetRefundPortsForTests();
    const stored = new Map<string, any>();
    const repo: any = {
      create: async (doc: any) => {
        const row = { ...doc, id: doc._id.toString(), created_at: new Date(), updated_at: new Date(), transfer_legs: [], refund_transaction_ids: [] };
        stored.set(row.id, row);
        return row;
      },
      findById: async (id: string) => stored.get(id) ?? null,
      // `create` pre-checks for an open request on the source before anything else (the unique
      // index stays the guarantee); nothing is open on these fresh order ids.
      findOpenBySource: async () => null,
    };
    const svc = new RefundRequestService(repo, {} as any, {} as any);
    const legId = new Types.ObjectId().toString();
    (svc as any).loadSource = async () => ({
      kind: 'order', id: new Types.ObjectId().toString(), orderNumber: 'ORD-1', vendorId: new Types.ObjectId().toString(),
      customerId: new Types.ObjectId().toString(), currency: 'XAF', paymentChannel: 'mobile_money',
      legs: [{ id: legId, purpose: 'primary', remaining: 5000, gateway: 'NOTCHPAY', payerPhone: '+237670000001', payerName: 'Ama' }],
      remaining: 5000, goodsAmount: 4000, deliveryAmountPaid: 1000, delivered: true, returnShippingPayer: 'customer', codCollections: [],
    });
    const orderId = new Types.ObjectId().toString();

    let created: any = null;
    let code: string | null = null;
    try {
      created = await svc.create({
        source: { kind: 'order', id: orderId }, amount: 1500, reasonKind: 'goodwill',
        requestedBy: { id: null, role: 'system', name: 'delivery-fee refund' }, approveNow: false, earningsImpact: 'none',
      });
    } catch (e) {
      code = e instanceof AppError ? e.code : (e as Error).message;
    }
    assert('with NO earnings port registered, an unallocated refund is still created (nothing to pause)', () => created !== null && code === null);
    assert('…its attribution is delivery money, all of it', () => created?.attribution?.goods === 0 && created?.attribution?.delivery === 1500);
    assert('…it may exceed the goods-first attribution cap (1500 > 0 delivery allowed after delivery)', () => created?.gross_amount === 1500);
    assert('…and it is stored as earnings_impact none', () => created?.earnings_impact === 'none');

    let ordinaryCode: string | null = null;
    try {
      await svc.create({
        source: { kind: 'order', id: orderId }, amount: 1000, reasonKind: 'return',
        requestedBy: { id: null, role: 'system', name: 'x' }, approveNow: false,
      });
    } catch (e) {
      ordinaryCode = e instanceof AppError ? e.code : (e as Error).message;
    }
    assert('an ORDINARY refund with no port still REFUSES (REFUND_PORT_NOT_REGISTERED) — never skips', () =>
      ordinaryCode === ERROR_CODES.REFUND_PORT_NOT_REGISTERED);
  }

  originalConsole.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  originalConsole.error(err);
  process.exit(1);
});
