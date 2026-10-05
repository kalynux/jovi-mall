/**
 * verify:earnings-clawback-live — the refund clawback against a real database (REFUND-FLOW-PLAN
 * § 6, § 10). `test:earnings-clawback` proves the arithmetic and the wiring offline; this proves
 * the money actually moves, atomically, in the order the plan says:
 *
 *   1. a refund over RELEASED earnings takes available, then owes the rest (debt);
 *   2. the same refund key again moves nothing (`alreadyApplied`);
 *   3. the next release pays the debt down before anything reaches available;
 *   4. a payout returned to available (reject) nets the debt too;
 *   5. a write-off forgives what is left;
 *   6. a payout already `processing` is untouched by a new debt (C-7);
 *   7. a partial refund of a HELD share comes out of pending, and the release then moves only
 *      the remainder;
 *   8. a refund with no shipment row (delivery never spent) charges the vendor nothing beyond
 *      their rows; a returned vendor-paid delivery charges the vendor the courier's kept fee and
 *      claws their RTO leftover row (review findings 1 and 3, C-8).
 *
 * Needs a Mongo REPLICA SET (the clawback opens transactions). It writes its own fixtures under
 * fresh ObjectIds — inserted raw — with VENDOR shares only, so the shared platform singleton
 * accounts are never touched; it deletes everything it wrote, pass or fail.
 *
 * Run: MONGO_URI=mongodb://127.0.0.1:27117/verify_clawback?replicaSet=rs0 npm run verify:earnings-clawback-live
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';

import { transactionManager } from '../../src/core/database/transaction.manager';
import { earningsClawbackService } from '../../src/modules/earnings/services/earnings-clawback.service';
import { earningsAccountService } from '../../src/modules/earnings/services/earnings-account.service';
import { EarningsAllocationRepository } from '../../src/modules/earnings/repositories/earnings-allocation.repository';
import { OrderModel } from '../../src/modules/orders/order.model';
import { ShipmentModel } from '../../src/modules/shipments/shipment.model';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { EarningsAccountModel } from '../../src/modules/earnings/models/earnings-account.model';
import { EarningsLedgerModel } from '../../src/modules/earnings/models/earnings-ledger.model';
import { EarningsAdjustmentModel } from '../../src/modules/earnings/models/earnings-adjustment.model';
import { PayoutRequestModel } from '../../src/modules/earnings/models/payout-request.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

let passed = 0;
let failed = 0;

async function assert(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ FAIL: ${label}`);
    console.log(`     ${error instanceof Error ? error.message : String(error)}`);
  }
}

function eq<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const vendorId = new Types.ObjectId();
const orders: Types.ObjectId[] = [];
const shipments: Types.ObjectId[] = [];
const refundKeys: string[] = [];
const allocationRepo = new EarningsAllocationRepository();

async function account() {
  const a = await EarningsAccountModel.findOne({ owner_type: 'vendor', owner_id: vendorId }).lean();
  if (!a) throw new Error('vendor account missing');
  return a;
}

async function seedOrder(): Promise<Types.ObjectId> {
  const _id = new Types.ObjectId();
  orders.push(_id);
  await OrderModel.collection.insertOne({
    _id,
    order_number: `VERIFY-CLAW-${_id.toString().slice(-6)}`,
    vendor_id: vendorId,
    customer_id: new Types.ObjectId(),
    currency: 'XAF',
    total_amount: 0,
    created_at: new Date(),
  });
  return _id;
}

async function seedShare(
  orderId: Types.ObjectId,
  amount: number,
  status: 'held' | 'released',
  // A shipment-source row (§ 8). The beneficiary id stays the fixture vendor's so cleanup finds it.
  on?: { sourceType: 'shipment'; sourceId: Types.ObjectId; beneficiary: 'vendor' | 'agency' }
): Promise<Types.ObjectId> {
  const _id = new Types.ObjectId();
  await EarningsAllocationModel.collection.insertOne({
    _id,
    source_type: on?.sourceType ?? 'order',
    source_id: on?.sourceId ?? orderId,
    beneficiary_type: on?.beneficiary ?? 'vendor',
    beneficiary_id: vendorId,
    gross_snapshot: amount,
    commission_percent_snapshot: 0,
    amount,
    clawed_amount: 0,
    currency: 'XAF',
    status,
    completed_at: new Date(),
    hold_release_at: new Date(),
    paused_at: null,
    released_at: status === 'released' ? new Date() : null,
    reversed_at: null,
    requires_cash_settlement: false,
    cash_settled_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return _id;
}

/** What the release worker does for one matured row: claim, then release through the service. */
async function release(allocationId: Types.ObjectId): Promise<void> {
  await transactionManager.runInTransaction(async (session) => {
    const claimed = await allocationRepo.markReleased(allocationId, new Date(), session);
    if (!claimed) throw new Error('claim failed');
    await earningsAccountService.releaseInSession(claimed, session);
  });
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected (vendor fixture ${vendorId.toString()})`);

  await EarningsAccountModel.collection.insertOne({
    owner_type: 'vendor',
    owner_id: vendorId,
    currency: 'XAF',
    pending_balance: 4_000 + 5_000,
    available_balance: 3_000,
    reserve_balance: 0,
    requested_balance: 0,
    clawback_balance: 0,
    version: 0,
    created_at: new Date(),
    updated_at: new Date(),
  });

  // ── 1. Refund over released earnings ──────────────────────────────────────────────
  console.log('\n1. Refund over released money');
  const orderA = await seedOrder();
  const shareA = await seedShare(orderA, 9_000, 'released');
  const keyA = `verify:${new Types.ObjectId().toString()}`;
  refundKeys.push(keyA);
  const outA = await earningsClawbackService.applyRefund({ refundKey: keyA, target: { kind: 'order', id: orderA.toString() }, attribution: { goods: 9_000, delivery: 0 } });
  await assert('available first (3 000), then debt (6 000)', () => {
    eq(outA.fromAvailable, 3_000, 'fromAvailable');
    eq(outA.toDebt, 6_000, 'toDebt');
    eq(outA.alreadyApplied, false, 'alreadyApplied');
  });
  await assert('the account owes 6 000 and has 0 available (eager netting)', async () => {
    const a = await account();
    eq(a.available_balance, 0, 'available');
    eq(a.clawback_balance, 6_000, 'clawback');
  });
  await assert('the share is reversed with clawed_amount = amount; amount untouched', async () => {
    const r = await EarningsAllocationModel.findById(shareA).lean();
    eq(r?.status, 'reversed', 'status');
    eq(r?.clawed_amount, 9_000, 'clawed_amount');
    eq(r?.amount, 9_000, 'amount');
  });

  // ── 2. Idempotent ─────────────────────────────────────────────────────────────────
  console.log('\n2. Re-fire');
  const again = await earningsClawbackService.applyRefund({ refundKey: keyA, target: { kind: 'order', id: orderA.toString() }, attribution: { goods: 9_000, delivery: 0 } });
  await assert('the same refund key moves nothing', async () => {
    eq(again.alreadyApplied, true, 'alreadyApplied');
    eq((await account()).clawback_balance, 6_000, 'clawback unchanged');
    eq(await EarningsAdjustmentModel.countDocuments({ refund_key: keyA }), 1, 'one adjustment row');
  });

  // ── 7 (first half). Partial refund of a HELD share ────────────────────────────────
  console.log('\n7. Partial refund of a held share');
  const orderB = await seedOrder();
  const shareB = await seedShare(orderB, 4_000, 'held');
  const keyB = `verify:${new Types.ObjectId().toString()}`;
  refundKeys.push(keyB);
  const outB = await earningsClawbackService.applyRefund({ refundKey: keyB, target: { kind: 'order', id: orderB.toString() }, attribution: { goods: 1_000, delivery: 0 } });
  await assert('a held share gives from pending, no debt', async () => {
    eq(outB.fromPending, 1_000, 'fromPending');
    eq(outB.toDebt, 0, 'toDebt');
    eq((await account()).pending_balance, 8_000, 'pending');
    const r = await EarningsAllocationModel.findById(shareB).lean();
    eq(r?.status, 'held', 'still held');
    eq(r?.clawed_amount, 1_000, 'clawed');
  });

  // ── 3. The next release pays the debt first ───────────────────────────────────────
  console.log('\n3. Release nets debt');
  const orderC = await seedOrder();
  const shareC = await seedShare(orderC, 5_000, 'held');
  await release(shareC);
  await assert('5 000 released → all of it pays debt (6 000 → 1 000), nothing reaches available', async () => {
    const a = await account();
    eq(a.clawback_balance, 1_000, 'clawback');
    eq(a.available_balance, 0, 'available');
  });
  await assert('a clawback_recovery ledger row and adjustment were written', async () => {
    eq(await EarningsLedgerModel.countDocuments({ allocation_id: shareC, entry_type: 'clawback_recovery', amount: 5_000 }), 1, 'ledger');
    eq(await EarningsAdjustmentModel.countDocuments({ allocation_id: shareC, kind: 'clawback_recovery', amount: 5_000 }), 1, 'adjustment');
  });

  // ── 7 (second half). The held share releases its remainder ────────────────────────
  await release(shareB);
  await assert('the partly clawed share releases 3 000 (amount − clawed): 1 000 pays the debt, 2 000 available', async () => {
    const a = await account();
    eq(a.clawback_balance, 0, 'clawback');
    eq(a.available_balance, 2_000, 'available');
    eq(a.pending_balance, 0, 'pending');
  });

  // ── 6. A processing payout is untouched by a new debt ─────────────────────────────
  console.log('\n6. Payout in flight (C-7)');
  await EarningsAccountModel.updateOne({ owner_type: 'vendor', owner_id: vendorId }, { $inc: { available_balance: -2_000, requested_balance: 2_000 } });
  const payoutId = new Types.ObjectId();
  await PayoutRequestModel.collection.insertOne({
    _id: payoutId,
    owner_type: 'vendor',
    owner_id: vendorId,
    amount: 2_000,
    currency: 'XAF',
    status: 'processing',
    origin: 'manual',
    created_at: new Date(),
    updated_at: new Date(),
  });
  const orderD = await seedOrder();
  await seedShare(orderD, 3_000, 'released');
  const keyD = `verify:${new Types.ObjectId().toString()}`;
  refundKeys.push(keyD);
  await earningsClawbackService.applyRefund({ refundKey: keyD, target: { kind: 'order', id: orderD.toString() }, attribution: { goods: 3_000, delivery: 0 } });
  await assert('the debt appears (3 000) and the requested 2 000 is NOT cut', async () => {
    const a = await account();
    eq(a.clawback_balance, 3_000, 'clawback');
    eq(a.requested_balance, 2_000, 'requested');
    eq((await PayoutRequestModel.findById(payoutId).lean())?.status, 'processing', 'payout status');
  });

  // ── 4. A rejected payout nets the debt on its way back ────────────────────────────
  console.log('\n4. Reject nets');
  await transactionManager.runInTransaction((session) =>
    earningsAccountService.revertPayoutToAvailableInSession('vendor', vendorId.toString(), 2_000, session, `recovery:payout:${payoutId.toString()}:rejected`)
  );
  await assert('the 2 000 returned pays the debt: 3 000 → 1 000, available stays 0', async () => {
    const a = await account();
    eq(a.clawback_balance, 1_000, 'clawback');
    eq(a.available_balance, 0, 'available');
    eq(a.requested_balance, 0, 'requested');
  });

  // ── 5. Write-off ──────────────────────────────────────────────────────────────────
  console.log('\n5. Write-off');
  const wo = await earningsClawbackService.writeOff({ ownerType: 'vendor', ownerId: vendorId.toString(), amount: 1_000, reason: 'verify script', actor: { id: 'verify', name: 'verify' } });
  await assert('the debt is forgiven and recorded', async () => {
    eq(wo.clawbackAfter, 0, 'clawbackAfter');
    eq((await account()).clawback_balance, 0, 'clawback');
    eq(await EarningsAdjustmentModel.countDocuments({ refund_key: wo.writeOffKey, kind: 'write_off', amount: 1_000 }), 1, 'adjustment');
  });
  await assert('a write-off above the debt is refused', async () => {
    try {
      await earningsClawbackService.writeOff({ ownerType: 'vendor', ownerId: vendorId.toString(), amount: 1, reason: 'verify', actor: { id: 'verify', name: 'verify' } });
      throw new Error('expected a refusal');
    } catch (error: any) {
      if (!/EARNINGS_CLAWBACK_NOTHING_OWED/.test(error?.code ?? '')) throw error;
    }
  });

  // ── 8. Delivery never spent vs spent (review findings 1 and 3 / C-8) ─────────────
  console.log('\n8. Who bears the delivery');
  // 8a. A cancellation before delivery: no shipment row exists → the delivery part and the goods
  // gap are money the platform still holds; the vendor is charged NOTHING beyond their rows.
  const orderE = await seedOrder();
  const shareE = await seedShare(orderE, 8_000, 'held');
  await EarningsAccountModel.updateOne({ owner_type: 'vendor', owner_id: vendorId }, { $inc: { pending_balance: 8_000 } });
  const keyE = `verify:${new Types.ObjectId().toString()}`;
  refundKeys.push(keyE);
  const outE = await earningsClawbackService.applyRefund({ refundKey: keyE, target: { kind: 'order', id: orderE.toString() }, attribution: { goods: 9_000, delivery: 1_500 } });
  await assert('finding 1: no shipment rows → vendor gives only their row; delivery + gap unrecovered, no debt', async () => {
    eq(outE.fromPending, 8_000, 'fromPending');
    eq(outE.toDebt, 0, 'toDebt');
    eq(outE.unrecovered, 2_500, 'unrecovered (1 000 gap + 1 500 delivery)');
    eq(await EarningsAdjustmentModel.countDocuments({ refund_key: keyE }), 1, 'only the row adjustment — no vendor-beyond row');
    eq((await EarningsAllocationModel.findById(shareE).lean())?.clawed_amount, 8_000, 'clawed');
    eq((await account()).clawback_balance, 0, 'no debt');
  });

  // 8b. A returned vendor-paid delivery: the agency kept its RTO fee (400, out of scope) and the
  // vendor got the 600 leftover back on a shipment row → that row is in scope, and the 400 the
  // courier kept is the VENDOR's (C-8), never the platform's.
  const orderF = await seedOrder();
  await seedShare(orderF, 8_000, 'held');
  const shipmentF = new Types.ObjectId();
  shipments.push(shipmentF);
  await ShipmentModel.collection.insertOne({ _id: shipmentF, order_id: orderF, created_at: new Date() });
  const agencyRowF = await seedShare(orderF, 400, 'held', { sourceType: 'shipment', sourceId: shipmentF, beneficiary: 'agency' });
  const leftoverF = await seedShare(orderF, 600, 'held', { sourceType: 'shipment', sourceId: shipmentF, beneficiary: 'vendor' });
  await EarningsAccountModel.updateOne({ owner_type: 'vendor', owner_id: vendorId }, { $inc: { pending_balance: 8_600 } });
  const keyF = `verify:${new Types.ObjectId().toString()}`;
  refundKeys.push(keyF);
  const outF = await earningsClawbackService.applyRefund({ refundKey: keyF, target: { kind: 'order', id: orderF.toString() }, attribution: { goods: 9_000, delivery: 0 } });
  await assert('C-8: the vendor gives their order row AND the RTO leftover row, and owes the 400 the courier kept', async () => {
    eq(outF.fromPending, 8_600, 'fromPending');
    eq(outF.toDebt, 400, 'toDebt');
    eq(outF.unrecovered, 0, 'unrecovered');
    eq((await EarningsAllocationModel.findById(leftoverF).lean())?.clawed_amount, 600, 'leftover clawed');
    eq((await EarningsAllocationModel.findById(agencyRowF).lean())?.clawed_amount, 0, 'agency row untouched (C-1)');
    eq((await account()).clawback_balance, 400, 'debt');
  });
}

async function cleanup(): Promise<void> {
  const allocations = await EarningsAllocationModel.find({ beneficiary_id: vendorId }, { _id: 1 }).lean();
  await Promise.all([
    OrderModel.collection.deleteMany({ _id: { $in: orders } }),
    ShipmentModel.collection.deleteMany({ _id: { $in: shipments } }),
    EarningsAllocationModel.collection.deleteMany({ beneficiary_id: vendorId }),
    EarningsLedgerModel.collection.deleteMany({ owner_id: vendorId }),
    EarningsAdjustmentModel.collection.deleteMany({
      $or: [{ beneficiary_id: vendorId }, { refund_key: { $in: refundKeys } }, { allocation_id: { $in: allocations.map((a) => a._id) } }],
    }),
    EarningsAccountModel.collection.deleteMany({ owner_type: 'vendor', owner_id: vendorId }),
    PayoutRequestModel.collection.deleteMany({ owner_id: vendorId }),
  ]);
}

main()
  .catch((error) => {
    failed += 1;
    console.error('verify:earnings-clawback-live crashed:', error);
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      console.error('cleanup failed:', error);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
  });
