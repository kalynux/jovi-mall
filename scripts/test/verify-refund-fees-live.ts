/**
 * verify:refund-fees-live — agency liability and damage claims against a real database (owner
 * decisions F-6…F-9, 2026-10-22). `test:refund-fees` proves the rules and the wiring offline;
 * this proves the money moves, on the right rows, with the right explanation:
 *
 *   1. a delivery at fault INSIDE the agency's window: the agency and rider fund the customer's
 *      delivery money, the vendor gives back only the goods;
 *   2. OUTSIDE the window: the couriers keep their fee, the vendor carries the delivery as before;
 *   3. the window opens from the order's OWN customer's problem report, never somebody else's;
 *   4. a free (vendor-paid) delivery at fault: the couriers relieve the vendor of the courier cost;
 *   5. seller-cancel fees and a lost dispute's pay-in fee land on the vendor, explained;
 *   6. a damage claim: refused above the cap, charged inside the window (agency only), the vendor
 *      and the platform credited, a second claim refused, a parcel outside its window refused;
 *   7. the agency can read why: its adjustments carry the explanation.
 *
 * Needs a Mongo REPLICA SET (clawback and claims open transactions) and a THROWAWAY database: it
 * drops the database it ran in when it finishes, and refuses to run unless the name contains
 * "verify" — except under CI, where it moves itself to `verify_refund_fees_ci` (see DB_NAME).
 *
 * Run: MONGO_URI=mongodb://127.0.0.1:27118/verify_refund_fees?replicaSet=rs0 npm run verify:refund-fees-live
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { transactionManager } from '../../src/core/database/transaction.manager';
import { earningsClawbackService } from '../../src/modules/earnings/services/earnings-clawback.service';
import { earningsAccountService } from '../../src/modules/earnings/services/earnings-account.service';
import { courierLiabilityService } from '../../src/modules/earnings/services/courier-liability.service';
import { agencyClaimService } from '../../src/modules/earnings/services/agency-claim.service';
import { EarningsAllocationRepository } from '../../src/modules/earnings/repositories/earnings-allocation.repository';
import { EarningsAdjustmentRepository } from '../../src/modules/earnings/repositories/earnings-adjustment.repository';
import { OrderModel } from '../../src/modules/orders/order.model';
import { ShipmentModel } from '../../src/modules/shipments/shipment.model';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { TicketModel } from '../../src/modules/tickets/models/ticket.model';
import { ActorRole, EntityType, TicketType } from '../../src/modules/tickets/types/ticket.types';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { EarningsAccountModel } from '../../src/modules/earnings/models/earnings-account.model';
import { EarningsAdjustmentModel } from '../../src/modules/earnings/models/earnings-adjustment.model';
import { courierHoldSnapshot } from '../../src/modules/earnings/domain/courier-hold';

const MONGO_URI = process.env.MONGO_URI || '';
// CI's live job points every suite at ONE seeded database (jovi_mall_ci) that the running
// server and the later suites still need, so dropping it would break them. There this suite
// runs in a sibling throwaway database on the same replica set instead. Anywhere else a URI
// without "verify" is still refused: it may name a real database.
const DB_NAME = /verify/i.test(MONGO_URI) ? undefined : process.env.CI ? 'verify_refund_fees_ci' : null;
const DAY = 86_400_000;

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

async function rejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  // The throw stays OUTSIDE the catch: `preserve-caught-error` wants a `cause` on an
  // error raised inside one, and `new Error(msg, { cause })` needs the ES2022 lib.
  let caught: any;
  try {
    await fn();
  } catch (error: any) {
    caught = error ?? {};
  }
  if (caught === undefined) throw new Error(`expected ${code}, nothing was thrown`);
  if (caught.code === code || caught.errorCode === code || caught.error?.code === code || String(caught.message ?? '').includes(code)) return;
  throw new Error(`expected ${code}, got ${caught.code ?? caught.message}`);
}

const allocationRepo = new EarningsAllocationRepository();
const adjustmentRepo = new EarningsAdjustmentRepository();

const TERMS = { returns: { payer: 'vendor' }, damage: { claim_deadline_days: 2, max_refund_per_item: 5_000, investigation_fee: 1_000 } };

interface Fixture {
  orderId: string;
  shipmentId: string;
  vendorId: string;
  agencyId: string;
  agentId: string;
  customerUserId: Types.ObjectId;
  vendorRow: Types.ObjectId;
  agencyRow: Types.ObjectId;
  agentRow: Types.ObjectId;
}

/** A share created the way the split does (held, pending credited), optionally released. */
async function share(input: {
  sourceType: 'order' | 'shipment';
  sourceId: string;
  beneficiary: 'vendor' | 'agency' | 'agent';
  beneficiaryId: string;
  amount: number;
  courier?: ReturnType<typeof courierHoldSnapshot>;
  released?: boolean;
}): Promise<Types.ObjectId> {
  return transactionManager.runInTransaction(async (session) => {
    const row = await allocationRepo.create(
      {
        source_type: input.sourceType,
        source_id: input.sourceId,
        beneficiary_type: input.beneficiary,
        beneficiary_id: input.beneficiaryId,
        gross_snapshot: input.amount,
        commission_percent_snapshot: 0,
        amount: input.amount,
        currency: 'XAF',
        completed_at: new Date(),
        hold_release_at: new Date(),
        courier_hold: input.courier ?? null,
      },
      session
    );
    await earningsAccountService.holdInSession(row, session);
    if (input.released) {
      const claimed = await allocationRepo.markReleased(row._id as Types.ObjectId, new Date(), session);
      if (claimed) await earningsAccountService.releaseInSession(claimed, session);
    }
    return row._id as Types.ObjectId;
  });
}

/**
 * One order with one parcel delivered `deliveredDaysAgo` ago. `customerPaysDelivery` false = a
 * free delivery the vendor paid (the vendor's share is then the goods minus the courier's fee).
 */
async function fixture(opts: { deliveredDaysAgo: number; customerPaysDelivery: boolean; vendorShare: number }): Promise<Fixture> {
  const orderId = new Types.ObjectId();
  const shipmentId = new Types.ObjectId();
  const vendorId = new Types.ObjectId().toString();
  const agencyId = new Types.ObjectId();
  const agentId = new Types.ObjectId().toString();
  const customerId = new Types.ObjectId();
  const customerUserId = new Types.ObjectId();
  const deliveredAt = new Date(Date.now() - opts.deliveredDaysAgo * DAY);

  await CustomerModel.collection.insertOne({ _id: customerId, user_id: customerUserId });
  await DeliveryAgencyModel.collection.insertOne({ _id: agencyId, user_id: new Types.ObjectId(), policies: TERMS });
  await OrderModel.collection.insertOne({
    _id: orderId,
    order_number: `VERIFY-FEES-${orderId.toString().slice(-6)}`,
    order_type: 'physical',
    payment_method: 'mobile_money',
    customer_id: customerId,
    vendor_id: new Types.ObjectId(vendorId),
    currency: 'XAF',
    delivery_payer: opts.customerPaysDelivery ? 'customer' : 'vendor',
    delivered_at: deliveredAt,
  });
  await ShipmentModel.collection.insertOne({
    _id: shipmentId,
    order_id: orderId,
    agency_id: agencyId,
    tracking_number: `TRK-${shipmentId.toString().slice(-6)}`,
    status: 'delivered',
    delivery_payer: opts.customerPaysDelivery ? 'customer' : 'vendor',
    delivery_fee_snapshot: 2_000,
    customer_delivery_fee: opts.customerPaysDelivery ? 2_000 : 0,
    status_history: [
      { status: 'agent_delivered', changed_at: deliveredAt, changed_by_role: 'agent' },
      { status: 'delivered', changed_at: new Date(deliveredAt.getTime() + 3_600_000), changed_by_role: 'customer' },
    ],
  });

  const snap = courierHoldSnapshot(shipmentId.toString(), agencyId.toString(), TERMS, 3);
  return {
    orderId: orderId.toString(),
    shipmentId: shipmentId.toString(),
    vendorId,
    agencyId: agencyId.toString(),
    agentId,
    customerUserId,
    vendorRow: await share({ sourceType: 'order', sourceId: orderId.toString(), beneficiary: 'vendor', beneficiaryId: vendorId, amount: opts.vendorShare }),
    agencyRow: await share({ sourceType: 'shipment', sourceId: shipmentId.toString(), beneficiary: 'agency', beneficiaryId: agencyId.toString(), amount: 1_500, courier: snap }),
    agentRow: await share({ sourceType: 'shipment', sourceId: shipmentId.toString(), beneficiary: 'agent', beneficiaryId: agentId, amount: 500, courier: snap }),
  };
}

const row = async (id: Types.ObjectId) => (await EarningsAllocationModel.findById(id).lean())!;
const key = () => new Types.ObjectId().toString();
const pending = async (type: string, id: string) =>
  (await EarningsAccountModel.findOne({ owner_type: type, owner_id: new Types.ObjectId(id) }).lean())?.pending_balance ?? 0;

async function main(): Promise<void> {
  if (DB_NAME === null) throw new Error('Refusing to run: MONGO_URI must name a throwaway "verify" database');
  await mongoose.connect(MONGO_URI, DB_NAME ? { dbName: DB_NAME } : {});
  console.log(`verify:refund-fees-live against ${MONGO_URI.replace(/\/\/[^@]*@/, '//***@')} (database ${mongoose.connection.db?.databaseName})`);
  // A collection created INSIDE a transaction while Mongoose builds its indexes is a catalog
  // write conflict on a fresh database: create every collection and index first.
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    await model.createCollection().catch(() => undefined);
    await model.init().catch(() => undefined);
  }

  try {
    console.log('\n1. delivery at fault, inside the window (customer paid delivery)');
    const a = await fixture({ deliveredDaysAgo: 1, customerPaysDelivery: true, vendorShare: 9_300 });
    const [faultA] = await courierLiabilityService.assessDeliveryFault(a.orderId, [a.shipmentId], new Date());
    await assert('judged inside the 2-day window, funding the 2,000 the customer paid', () => {
      eq(faultA.insideWindow, true, 'inside');
      eq(faultA.windowDays, 2, 'window');
      eq(faultA.customerDeliveryAmount, 2_000, 'customer part');
    });
    const agencyBefore = await pending('agency', a.agencyId);
    await earningsClawbackService.applyRefund({
      refundKey: key(),
      target: { kind: 'order', id: a.orderId },
      attribution: { goods: 9_300, delivery: 2_000 },
      deliveryFault: [faultA],
    });
    await assert('the agency gives 1,500 and the rider 500; the vendor gives the goods only', async () => {
      eq((await row(a.agencyRow)).clawed_amount, 1_500, 'agency clawed');
      eq((await row(a.agentRow)).clawed_amount, 500, 'rider clawed');
      eq((await row(a.vendorRow)).clawed_amount, 9_300, 'vendor clawed');
      const beyond = await EarningsAdjustmentModel.findOne({ beneficiary_type: 'vendor', beneficiary_id: new Types.ObjectId(a.vendorId), allocation_id: null }).lean();
      eq(beyond, null, 'no vendor charge beyond the share');
      eq(agencyBefore - (await pending('agency', a.agencyId)), 1_500, 'agency pending down 1,500');
    });
    await assert('the agency\'s adjustment explains it: fault, window, amount', async () => {
      const adj: any = await EarningsAdjustmentModel.findOne({ allocation_id: a.agencyRow }).lean();
      eq(adj.reason_code, 'refund_delivery_fault', 'code');
      if (!/2-day window/.test(adj.explanation) || !/1,500 XAF/.test(adj.explanation)) throw new Error(adj.explanation);
    });

    console.log('\n2. outside the window');
    const b = await fixture({ deliveredDaysAgo: 5, customerPaysDelivery: true, vendorShare: 9_300 });
    const [faultB] = await courierLiabilityService.assessDeliveryFault(b.orderId, [b.shipmentId], new Date());
    await assert('a problem raised on day 5 of a 2-day window is outside; it funds nothing', () => {
      eq(faultB.insideWindow, false, 'inside');
      eq(faultB.customerDeliveryAmount, 0, 'customer part');
    });
    await earningsClawbackService.applyRefund({
      refundKey: key(),
      target: { kind: 'order', id: b.orderId },
      attribution: { goods: 9_300, delivery: 2_000 },
      deliveryFault: [faultB],
    });
    await assert('the couriers keep their fee; the vendor carries the delivery money', async () => {
      eq((await row(b.agencyRow)).clawed_amount ?? 0, 0, 'agency clawed');
      eq((await row(b.agentRow)).clawed_amount ?? 0, 0, 'rider clawed');
      const beyond: any = await EarningsAdjustmentModel.findOne({ beneficiary_id: new Types.ObjectId(b.vendorId), allocation_id: null }).lean();
      eq(beyond?.delivery_amount, 2_000, 'vendor beyond delivery');
    });

    console.log('\n3. the window opens from the order\'s OWN customer');
    const c = await fixture({ deliveredDaysAgo: 5, customerPaysDelivery: true, vendorShare: 9_300 });
    const shipped = new Date(Date.now() - 5 * DAY);
    await TicketModel.collection.insertOne({
      _id: new Types.ObjectId(), type: TicketType.ORDER_ISSUE, entity_type: EntityType.ORDER, entity_id: c.orderId,
      created_by_role: ActorRole.CUSTOMER, created_by_user_id: new Types.ObjectId(), // somebody else
      createdAt: new Date(shipped.getTime() + DAY / 2), status: 'open', subject: 'x', description: 'x',
    });
    await assert('somebody else\'s early report does not open it', async () => {
      const [f] = await courierLiabilityService.assessDeliveryFault(c.orderId, [c.shipmentId], new Date());
      eq(f.insideWindow, false, 'inside');
    });
    await TicketModel.collection.insertOne({
      _id: new Types.ObjectId(), type: TicketType.SHIPPING_ISSUE, entity_type: EntityType.SHIPMENT, entity_id: c.shipmentId,
      created_by_role: ActorRole.CUSTOMER, created_by_user_id: c.customerUserId,
      createdAt: new Date(shipped.getTime() + DAY), status: 'open', subject: 'x', description: 'x',
    });
    await assert('the customer\'s own report on day 1 does, and dates the problem', async () => {
      const [f] = await courierLiabilityService.assessDeliveryFault(c.orderId, [c.shipmentId], new Date());
      eq(f.insideWindow, true, 'inside');
      if (Math.abs(f.raisedAt.getTime() - (shipped.getTime() + DAY)) > 5_000) throw new Error(`raisedAt ${f.raisedAt.toISOString()}`);
    });

    console.log('\n4. a free (vendor-paid) delivery at fault');
    const d = await fixture({ deliveredDaysAgo: 1, customerPaysDelivery: false, vendorShare: 7_300 });
    const [faultD] = await courierLiabilityService.assessDeliveryFault(d.orderId, [d.shipmentId], new Date());
    await earningsClawbackService.applyRefund({
      refundKey: key(),
      target: { kind: 'order', id: d.orderId },
      attribution: { goods: 9_300, delivery: 0 },
      deliveryFault: [faultD],
    });
    await assert('the couriers carry the 2,000 courier cost the vendor would have (C-8)', async () => {
      eq((await row(d.agencyRow)).clawed_amount, 1_500, 'agency');
      eq((await row(d.agentRow)).clawed_amount, 500, 'rider');
      eq((await row(d.vendorRow)).clawed_amount, 7_300, 'vendor row');
      const beyond: any = await EarningsAdjustmentModel.findOne({ beneficiary_id: new Types.ObjectId(d.vendorId), allocation_id: null }).lean();
      eq(beyond, null, 'no vendor beyond');
    });

    console.log('\n5. fees charged to the vendor');
    const e = await fixture({ deliveredDaysAgo: 1, customerPaysDelivery: true, vendorShare: 9_300 });
    await earningsClawbackService.applyRefund({
      refundKey: key(),
      target: { kind: 'order', id: e.orderId },
      attribution: { goods: 9_300, delivery: 0 },
      vendorCharge: 480,
    });
    await assert('seller-cancel fees: one charge beyond the share, explained', async () => {
      const beyond: any = await EarningsAdjustmentModel.findOne({ beneficiary_id: new Types.ObjectId(e.vendorId), allocation_id: null }).lean();
      eq(beyond?.fee_amount, 480, 'fee');
      eq(beyond?.reason_code, 'refund_beyond_share', 'code');
      if (!/cancelled by you/.test(beyond.explanation)) throw new Error(beyond.explanation);
    });
    const f = await fixture({ deliveredDaysAgo: 1, customerPaysDelivery: true, vendorShare: 9_300 });
    await earningsClawbackService.reverseRemaining({ kind: 'order', id: f.orderId }, `dispute:${key()}`, { vendorCharge: 200, dispute: true });
    await assert('a lost dispute: the share back and the 2% pay-in, each explained', async () => {
      const shareRow: any = await EarningsAdjustmentModel.findOne({ allocation_id: f.vendorRow }).lean();
      eq(shareRow.reason_code, 'dispute_share', 'share code');
      const beyond: any = await EarningsAdjustmentModel.findOne({ beneficiary_id: new Types.ObjectId(f.vendorId), allocation_id: null }).lean();
      eq(beyond?.reason_code, 'dispute_payin_fee', 'fee code');
      eq(beyond?.fee_amount, 200, 'fee');
      eq((await row(f.agencyRow)).clawed_amount ?? 0, 0, 'agency untouched');
    });

    console.log('\n6. damage claims');
    const g = await fixture({ deliveredDaysAgo: 1, customerPaysDelivery: true, vendorShare: 9_300 });
    await assert('eligible: inside the window, 5,000 per item, 1,000 investigation fee', async () => {
      const el = await agencyClaimService.eligibility(g.shipmentId);
      eq(el.eligible, true, 'eligible');
      eq(el.maxPerItem, 5_000, 'per item');
      eq(el.investigationFee, 1_000, 'fee');
    });
    await assert('above the cap is refused', () =>
      rejects(() => agencyClaimService.create({ shipmentId: g.shipmentId, itemCount: 1, amount: 6_000, note: 'crushed box', actor: { id: 'adm', name: 'Admin' } }), 'AGENCY_CLAIM_EXCEEDS_CAP'));
    const vendorBefore = await pending('vendor', g.vendorId);
    const claim = await agencyClaimService.create({ shipmentId: g.shipmentId, itemCount: 1, amount: 5_000, note: 'crushed box', actor: { id: 'adm', name: 'Admin' } });
    await assert('the agency is charged 6,000: its 1,500 held for the parcel, then 4,500 as debt', async () => {
      eq((await row(g.agencyRow)).clawed_amount, 1_500, 'agency row');
      eq((await row(g.agentRow)).clawed_amount ?? 0, 0, 'rider untouched');
      const acct: any = await EarningsAccountModel.findOne({ owner_type: 'agency', owner_id: new Types.ObjectId(g.agencyId) }).lean();
      eq(acct.clawback_balance, 4_500, 'agency debt');
      eq(claim.taken_from.pending + claim.taken_from.debt, 6_000, 'claim taken_from');
    });
    await assert('the vendor is credited 5,000 and the platform 1,000, due at the next sweep', async () => {
      eq((await pending('vendor', g.vendorId)) - vendorBefore, 5_000, 'vendor pending up');
      const credits = await EarningsAllocationModel.find({ source_type: 'agency_claim', source_id: claim._id }).lean();
      eq(credits.length, 2, 'two credits');
      const due = await allocationRepo.findMaturedHeld(new Date(), 1_000);
      eq(credits.every((cr) => due.some((d2) => String(d2._id) === String(cr._id))), true, 'both due');
    });
    await assert('a second claim on the parcel is refused', () =>
      rejects(() => agencyClaimService.create({ shipmentId: g.shipmentId, itemCount: 1, amount: 1_000, note: 'again', actor: { id: 'adm', name: 'Admin' } }), 'AGENCY_CLAIM_EXISTS'));
    const h = await fixture({ deliveredDaysAgo: 5, customerPaysDelivery: true, vendorShare: 9_300 });
    await assert('a parcel outside its window is refused', () =>
      rejects(() => agencyClaimService.create({ shipmentId: h.shipmentId, itemCount: 1, amount: 1_000, note: 'late', actor: { id: 'adm', name: 'Admin' } }), 'AGENCY_CLAIM_OUTSIDE_WINDOW'));

    console.log('\n7. the agency can read why');
    await assert('its adjustments list carries the damage-claim explanation', async () => {
      const { items } = await adjustmentRepo.pageForOwner('agency', g.agencyId, 1, 20);
      const mine = items.filter((i) => i.reason_code === 'damage_claim');
      eq(mine.length >= 1, true, 'rows');
      if (!/5,000 XAF per item/.test(String(mine[0].explanation))) throw new Error(String(mine[0].explanation));
    });
  } finally {
    const name = mongoose.connection.db?.databaseName ?? '';
    if (/verify/i.test(name)) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
