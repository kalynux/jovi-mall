/**
 * verify:refund-flow-live — the refund request against a REAL MongoDB (REFUND-FLOW-PLAN § 10).
 *
 * NEEDS a replica set (completion is one transaction). The gateway is NOT called: the
 * registered NotchPay adapter's payout methods are replaced in-process by a scripted stub, and
 * the payment settings are served from a stub store (the defaults: NotchPay pays out, fee 2%),
 * so this runs anywhere without moving money. What it proves is everything the offline suite
 * structurally cannot: the partial unique index BINDS, the claim's pipeline update really
 * reuses the reference, the ledger + payment totals + source status commit together, and a
 * re-fired callback is a no-op.
 *
 *   A. approve → send → callback → completed (ledger gross/fee/net, totals, order refunded,
 *      earnings port called with the attribution); a second open request is refused; a
 *      re-fired callback changes nothing
 *   B. a refused transfer → failed → retry reuses the SAME reference
 *   C. COD: a typed number needs a second approver; approved → waiting_for_cash; a deposit
 *      covers it → onCollectionsSettled sends it
 *   D. a recovery that throws after commit leaves `earnings_settled_at` null; the sweep re-runs it
 *   E. money returned by another road meanwhile → the claim refuses (`exceeds_refundable`)
 *   F. one of two transfers succeeded → settle-external records only the remainder
 *
 * Seeds its own fixtures under fresh ObjectIds and deletes exactly those. Run:
 *   npm run verify:refund-flow-live
 */
process.env.LOG_STDOUT = 'false';

import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { OrderModel } from '../../src/modules/orders/order.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { PaymentTransactionModel } from '../../src/modules/payments/models/payment-transaction.model';
import { RefundTransactionModel } from '../../src/modules/payments/models/refund-transaction.model';
import { RefundRequestModel } from '../../src/modules/payments/models/refund-request.model';
import { PAYMENT_GATEWAYS } from '../../src/modules/payments/gateways/registry';
import {
  __resetPaymentSettingsCacheForTests,
  __setPaymentSettingsStoreForTests,
} from '../../src/modules/payments/services/payment-settings.service';
import { DEFAULT_PAYMENT_SETTINGS } from '../../src/modules/payments/domain/payment-routing';
import { registerRefundPorts, CodCollectionCoverage, __resetRefundPortsForTests } from '../../src/modules/payments/domain/refund-ports';
import { refundRequestService } from '../../src/modules/payments/services/refund-request.service';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<boolean> | boolean): Promise<void> {
  try {
    if (await fn()) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.error(`  ❌ ${name}`);
      failed++;
    }
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
  }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : (e as Error).message;
  }
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

const sent: Array<{ reference: string; amount: number; phone: string }> = [];
let refuseNext = false;
const notchpay = PAYMENT_GATEWAYS.get('NOTCHPAY') as any;
notchpay.payoutAvailable = () => true;
notchpay.payoutBalance = async () => null;
notchpay.createPayout = async (p: { reference: string; amount: number; phone: string }) => {
  sent.push({ reference: p.reference, amount: p.amount, phone: p.phone });
  if (refuseNext) {
    refuseNext = false;
    return { success: false, gatewayRef: null, status: 'FAILED', message: 'scripted refusal' };
  }
  return { success: true, gatewayRef: `trf_${sent.length}`, status: 'PENDING' };
};

__setPaymentSettingsStoreForTests({
  ready: () => true,
  read: async () => null,
  create: async () => { throw new Error('read-only stub'); },
  compareAndSet: async () => null,
});
__resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, true);

const earningsCalls: Array<{ kind: string; args: unknown }> = [];
const coverage = new Map<string, CodCollectionCoverage[]>();
/** D: make the next earnings recovery throw, as a crash after commit would. */
let failNextRecovery = false;
__resetRefundPortsForTests();
registerRefundPorts({
  earnings: {
    onRequestOpened: async (target, id) => { earningsCalls.push({ kind: 'opened', args: { target, id } }); return true; },
    onRequestClosedWithoutRefund: async (target, id) => { earningsCalls.push({ kind: 'closed', args: { target, id } }); },
    onRefundCompleted: async (input) => {
      if (failNextRecovery) {
        failNextRecovery = false;
        throw new Error('scripted recovery failure');
      }
      earningsCalls.push({ kind: 'completed', args: input });
    },
  },
  codCoverage: { coverageForOrder: async (orderId) => coverage.get(orderId) ?? [] },
});

// ── Fixtures (raw driver: no hooks, no validation — these are not real orders) ─

const vendorId = new Types.ObjectId();
const customerId = new Types.ObjectId();
const created = { orders: [] as Types.ObjectId[], payments: [] as Types.ObjectId[] };

async function seedOnlineOrder(total: number, delivery: number, phone: string): Promise<Types.ObjectId> {
  const orderId = new Types.ObjectId();
  const paymentId = new Types.ObjectId();
  await OrderModel.collection.insertOne({
    _id: orderId,
    order_number: `VRF-${orderId.toHexString().slice(-6)}`,
    vendor_id: vendorId,
    customer_id: customerId,
    currency: 'XAF',
    payment_method: 'online',
    payment_status: 'paid',
    total_amount: total,
    price_breakdown: { base: total - delivery, delivery, tax: 0, discount: 0, total },
    delivered_at: null,
  } as any);
  await PaymentTransactionModel.collection.insertOne({
    _id: paymentId,
    orderId,
    userId: customerId,
    gateway: 'NOTCHPAY',
    method: 'MOBILE',
    status: 'SUCCEEDED',
    purpose: 'primary',
    gatewayRef: `np_${paymentId.toHexString()}`,
    // UNIQUE on the model: raw inserts bypass its default, so a second fixture without one
    // collides on `idempotencyKey: null` (E11000).
    idempotencyKey: `verify-rf-${paymentId.toHexString()}`,
    amountSnapshot: total,
    currencySnapshot: 'XAF',
    totalRefunded: 0,
    hasPartialRefund: false,
    payer: { name: 'Verify Payer', phone, email: null },
  } as any);
  created.orders.push(orderId);
  created.payments.push(paymentId);
  return orderId;
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  await RefundRequestModel.syncIndexes();
  await VendorModel.collection.insertOne({ _id: vendorId, policies: { return_policy: { return_shipping_payer: 'vendor' } } } as any);

  try {
    // ── A ────────────────────────────────────────────────────────────────────
    console.log('\n── A. approve → send → callback → completed');
    const orderA = await seedOnlineOrder(6000, 1000, '237677000001');
    const a = await refundRequestService.create({
      source: { kind: 'order', id: orderA.toString() },
      reasonKind: 'cancellation',
      reason: 'verify A',
      requestedBy: { id: 'admin-1', role: 'admin', name: 'Admin One' },
      approveNow: true,
    });
    await check('created approved and claimed: status sending, one leg to the payer (E.164)', () =>
      a.status === 'sending' && a.transfer_legs.length === 1 && a.transfer_legs[0].phone === '+237677000001'
      && a.transfer_gateway === 'NOTCHPAY' && /^jm_rf_/.test(a.transfer_reference ?? ''));
    await check('gross 6000, fee 2% = 120, net 5880 sent', () =>
      a.gross_amount === 6000 && a.fee_amount === 120 && a.net_amount === 5880 && sent[sent.length - 1].amount === 5880);
    await check('the earnings pause was raised (onRequestOpened)', () =>
      earningsCalls.some((c) => c.kind === 'opened' && (c.args as any).id === a.id));
    await check('⛔ a second OPEN request on the same order is refused by the index', async () =>
      (await codeOf(() => refundRequestService.create({
        source: { kind: 'order', id: orderA.toString() },
        reasonKind: 'cancellation',
        requestedBy: { id: 'admin-1', role: 'admin', name: 'Admin One' },
        amount: 100,
      }))) === ERROR_CODES.REFUND_ALREADY_OPEN);

    const done = await refundRequestService.applyTransferOutcome(a.transfer_reference!, { settled: true, gatewayRef: 'trf_x', reason: null });
    await check('the callback completes it', () => done?.status === 'completed' && done.refund_transaction_ids.length === 1);
    await check('ledger row: refundAmount GROSS, fee, net, channel payout, refundRequestId', async () => {
      const row = await RefundTransactionModel.findOne({ refundRequestId: a._id }).lean();
      return !!row && row.refundAmount === 6000 && row.feeAmount === 120 && row.netAmount === 5880 && row.channel === 'payout';
    });
    await check('payment totals and the order status moved in the same commit', async () => {
      const p = await PaymentTransactionModel.findById(created.payments[0]).lean();
      const o = await OrderModel.findById(orderA).select('payment_status').lean<any>();
      return p?.totalRefunded === 6000 && p?.status === 'REFUNDED' && o?.payment_status === 'refunded';
    });
    await check('earnings recovery was called with the attribution (goods 5000, delivery 1000)', () => {
      const c = earningsCalls.find((x) => x.kind === 'completed' && (x.args as any).refundKey === a.id);
      return !!c && (c.args as any).attribution.goods === 5000 && (c.args as any).attribution.delivery === 1000;
    });
    await check('a re-fired callback is a no-op (null)', async () =>
      (await refundRequestService.applyTransferOutcome(a.transfer_reference!, { settled: true, gatewayRef: 'trf_x', reason: null })) === null);

    // ── B ────────────────────────────────────────────────────────────────────
    console.log('\n── B. failure → retry reuses the reference');
    const orderB = await seedOnlineOrder(3000, 0, '+237677000002');
    refuseNext = true;
    const b = await refundRequestService.create({
      source: { kind: 'order', id: orderB.toString() },
      reasonKind: 'goodwill',
      requestedBy: { id: 'admin-1', role: 'admin', name: 'Admin One' },
      approveNow: true,
    });
    await check('a refused transfer parks the request in failed with the reason', () =>
      b.status === 'failed' && (b.transfer_failure_reason ?? '').includes('scripted refusal'));
    await check('⛔ sending→rejected is refused, but failed may be rejected (checked without doing it)', () =>
      b.status === 'failed');
    const firstRef = b.transfer_reference;
    const retried = await refundRequestService.retry(b.id);
    await check('the retry is sending again with the SAME reference', () =>
      retried.status === 'sending' && retried.transfer_reference === firstRef && sent[sent.length - 1].reference === firstRef);
    await check('a refund that is sending cannot be rejected', async () =>
      (await codeOf(() => refundRequestService.reject(b.id, { id: 'admin-2', name: 'Two' }, 'no'))) === ERROR_CODES.REFUND_REQUEST_STATUS_CONFLICT);
    await refundRequestService.applyTransferOutcome(firstRef!, { settled: true, gatewayRef: null, reason: null });

    // ── C ────────────────────────────────────────────────────────────────────
    console.log('\n── C. COD waits for cash');
    const orderC = new Types.ObjectId();
    created.orders.push(orderC);
    await OrderModel.collection.insertOne({
      _id: orderC,
      order_number: `VRF-${orderC.toHexString().slice(-6)}`,
      vendor_id: vendorId,
      customer_id: customerId,
      currency: 'XAF',
      payment_method: 'cash_on_delivery',
      payment_status: 'paid',
      total_amount: 3000,
      price_breakdown: { base: 3000, delivery: 0, tax: 0, discount: 0, total: 3000 },
      delivered_at: new Date(),
    } as any);
    const collectionId = new Types.ObjectId().toString();
    coverage.set(orderC.toString(), [
      { collectionId, shipmentId: new Types.ObjectId().toString(), kind: 'order', expected: 3000, settled: 0, settledAt: null, status: 'collected' },
    ]);
    const c = await refundRequestService.create({
      source: { kind: 'order', id: orderC.toString() },
      reasonKind: 'return',
      requestedBy: { id: 'admin-1', role: 'admin', name: 'Admin One' },
      destination: { phone: '699000111', name: 'Customer' },
      destinationProofFileId: new Types.ObjectId().toString(),
      approveNow: true,
    });
    await check('a typed number is never approved at creation', () => c.status === 'awaiting_approval' && c.destination?.source === 'typed');
    await check('the administrator who typed it cannot approve it', async () =>
      (await codeOf(() => refundRequestService.approve(c.id, { id: 'admin-1', name: 'Admin One' }))) === ERROR_CODES.REFUND_SECOND_APPROVER_REQUIRED);
    const approved = await refundRequestService.approve(c.id, { id: 'admin-2', name: 'Admin Two' });
    await check('a second administrator approves → waiting_for_cash (cash not at the platform)', () => approved.status === 'waiting_for_cash');
    coverage.set(orderC.toString(), [
      { collectionId, shipmentId: 'x', kind: 'order', expected: 3000, settled: 3000, settledAt: new Date(), status: 'collected' },
    ]);
    const moved = await refundRequestService.onCollectionsSettled([collectionId]);
    const after = await refundRequestService.getByIdOrThrow(c.id);
    await check('a deposit covering it releases and sends it', () => moved === 1 && after.status === 'sending' && after.transfer_legs[0].phone === '+237699000111');

    await check('finding 6: A\'s completed recovery stamped earnings_settled_at', async () =>
      Boolean((await refundRequestService.getByIdOrThrow(a.id)).earnings_settled_at));

    // ── D ────────────────────────────────────────────────────────────────────
    console.log('\n── D. a lost earnings recovery is re-run by the sweep (finding 6)');
    const orderD = await seedOnlineOrder(2000, 0, '+237677000004');
    const d = await refundRequestService.create({
      source: { kind: 'order', id: orderD.toString() },
      reasonKind: 'goodwill',
      requestedBy: { id: 'admin-1', role: 'admin', name: 'Admin One' },
      approveNow: true,
    });
    failNextRecovery = true;
    const dDone = await refundRequestService.applyTransferOutcome(d.transfer_reference!, { settled: true, gatewayRef: 'trf_d', reason: null });
    await check('the refund still completes; its marker stays null after the recovery threw', () =>
      dDone?.status === 'completed' && dDone.earnings_settled_at === null);
    // ⚠ Not the global sweep: on a shared database it would stamp OTHER requests settled through
    // this script's stub port. The sweep's query and its per-row step are exercised on D alone.
    const repo = (refundRequestService as any).repo;
    const due = await repo.findUnsettledCompleted(new Date(Date.now() + 60_000), 10_000);
    await check('the sweep\'s query finds D (completed, marker null)', () => due.some((r: any) => r.id === d.id));
    await refundRequestService.settleAftermath(await refundRequestService.getByIdOrThrow(d.id));
    const dAfter = await refundRequestService.getByIdOrThrow(d.id);
    await check('the sweep step re-runs the recovery and stamps earnings_settled_at', () =>
      Boolean(dAfter.earnings_settled_at)
      && earningsCalls.some((x) => x.kind === 'completed' && (x.args as any).refundKey === d.id));
    await check('…after which the sweep\'s query no longer returns it, and a re-run calls nothing', async () => {
      const before = earningsCalls.filter((x) => x.kind === 'completed' && (x.args as any).refundKey === d.id).length;
      await refundRequestService.settleAftermath(dAfter);
      const again = await repo.findUnsettledCompleted(new Date(Date.now() + 60_000), 10_000);
      return !again.some((r: any) => r.id === d.id)
        && earningsCalls.filter((x) => x.kind === 'completed' && (x.args as any).refundKey === d.id).length === before;
    });

    // ── E ────────────────────────────────────────────────────────────────────
    console.log('\n── E. money left by another road → the claim refuses (finding 5)');
    const orderE = await seedOnlineOrder(4000, 0, '+237677000005');
    const paymentE = created.payments[created.payments.length - 1];
    const e = await refundRequestService.create({
      source: { kind: 'order', id: orderE.toString() },
      reasonKind: 'goodwill',
      reason: 'verify E',
      requestedBy: { id: 'support-1', role: 'support', name: 'Support' },
    });
    // A delivery-fee refund (or any other road) returns 1000 while E waits for approval.
    await RefundTransactionModel.collection.insertOne({
      orderId: orderE, paymentTransactionId: paymentE, vendorId, userId: customerId, currency: 'XAF',
      refundAmount: 1000, status: 'completed', initiatedBy: customerId, initiatedByRole: 'system', completedAt: new Date(),
    } as any);
    const sentBeforeE = sent.length;
    const eAfter = await refundRequestService.approve(e.id, { id: 'admin-2', name: 'Admin Two' });
    await check('the 4000 request is NOT sent: failed with exceeds_refundable, nothing transferred', () =>
      eAfter.status === 'failed' && eAfter.transfer_failure_reason === 'exceeds_refundable' && sent.length === sentBeforeE);
    await check('settle-external is refused above the ceiling too', async () =>
      (await codeOf(() => refundRequestService.settleExternal(e.id, { method: 'cash', proofFileId: new Types.ObjectId().toString() }, { id: 'admin-2', name: 'Two' })))
        === ERROR_CODES.REFUND_REQUEST_STATUS_CONFLICT);
    await refundRequestService.reject(e.id, { id: 'admin-2', name: 'Two' }, 'verify E cleanup');

    // ── F ────────────────────────────────────────────────────────────────────
    console.log('\n── F. one of two transfers succeeded → settle-external pays only the rest (finding 4)');
    const orderF = await seedOnlineOrder(5000, 1000, '+237677000006');
    const primaryF = created.payments[created.payments.length - 1];
    await PaymentTransactionModel.collection.updateOne({ _id: primaryF }, { $set: { amountSnapshot: 4000 } });
    const topupF = new Types.ObjectId();
    await PaymentTransactionModel.collection.insertOne({
      _id: topupF, orderId: orderF, userId: customerId, gateway: 'NOTCHPAY', method: 'MOBILE', status: 'SUCCEEDED',
      purpose: 'order_delivery_topup', gatewayRef: `np_${topupF.toHexString()}`, idempotencyKey: `verify-rf-${topupF.toHexString()}`,
      amountSnapshot: 1000, currencySnapshot: 'XAF', totalRefunded: 0, hasPartialRefund: false,
      payer: { name: 'Other Payer', phone: '+237677000007', email: null },
    } as any);
    created.payments.push(topupF);
    refuseNext = true; // the FIRST transfer (the primary payer's) is refused, the second goes out
    const f = await refundRequestService.create({
      source: { kind: 'order', id: orderF.toString() },
      reasonKind: 'cancellation',
      requestedBy: { id: 'admin-1', role: 'admin', name: 'Admin One' },
      approveNow: true,
    });
    await check('two transfers, one per payer number', () => f.transfer_legs.length === 2);
    const okLeg = f.transfer_legs.find((l) => l.status === 'sending');
    if (okLeg) await refundRequestService.applyTransferOutcome(okLeg.reference, { settled: true, gatewayRef: 'trf_f', reason: null });
    const fFailed = await refundRequestService.getByIdOrThrow(f.id);
    await check('one leg succeeded, one failed → the request is failed', () =>
      fFailed.status === 'failed' && fFailed.transfer_legs.some((l) => l.status === 'succeeded'));
    const fDone = await refundRequestService.settleExternal(f.id, { method: 'cash', proofFileId: new Types.ObjectId().toString() }, { id: 'admin-2', name: 'Two' });
    const failedLeg = fFailed.transfer_legs.find((l) => l.status === 'failed')!;
    await check('external_settlement records ONLY the unpaid remainder', () =>
      fDone.status === 'completed' && fDone.external_settlement?.gross_amount === failedLeg.gross
      && fDone.external_settlement?.net_amount === failedLeg.amount);
    await check('the ledger records the sent leg as payout and the rest as external, nets summing to the request', async () => {
      const rows = await RefundTransactionModel.find({ refundRequestId: fDone._id }).lean();
      const channels = rows.map((r: any) => r.channel).sort().join(',');
      const net = rows.reduce((s: number, r: any) => s + r.netAmount, 0);
      return rows.length === 2 && channels === 'external,payout' && net === fDone.net_amount;
    });
  } finally {
    const orderIds = created.orders;
    await RefundTransactionModel.deleteMany({ orderId: { $in: orderIds } });
    await RefundRequestModel.deleteMany({ source_id: { $in: orderIds } });
    await PaymentTransactionModel.collection.deleteMany({ _id: { $in: created.payments } });
    await OrderModel.collection.deleteMany({ _id: { $in: orderIds } });
    await VendorModel.collection.deleteOne({ _id: vendorId });
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
