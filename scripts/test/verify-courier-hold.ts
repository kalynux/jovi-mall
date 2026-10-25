/**
 * verify:courier-hold — an agency's share of a delivery against a real database (owner
 * decisions, 2026-10-22). `test:courier-hold` proves the rules offline; this proves the
 * dates and the pauses actually land on the right rows:
 *
 *   1. a FREE agency's clock waits for proof: not started at the rider's tap, started at the
 *      customer's confirmation, releasable at once;
 *   2. a HELD agency's clock starts at the tap and runs its own days; a failed tap clears it;
 *   3. the ORDER's clock never touches a courier row;
 *   4. an administrator's ORDER pause skips the free agency and reaches everyone else; its
 *      resume moves only the rows it held;
 *   5. a customer's problem report still reaches the free agency;
 *   6. a DELIVERY pause reaches only that parcel's agency and rider;
 *   7. two pauses on one row: it stays held until both end, and moves by the whole span;
 *   8. the admin queue lists a paused delivery with its order and agency;
 *   9. the nightly backstop starts a clock a missed event left unstarted, and the release
 *      query then finds it.
 *
 * A standalone mongod is enough (no transactions). Fixtures are inserted raw under fresh
 * ObjectIds, and everything written is deleted, pass or fail.
 *
 * Run: MONGO_URI=mongodb://127.0.0.1:27117/verify_courier_hold npm run verify:courier-hold
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';

import { earningsCompletionService } from '../../src/modules/earnings/services/earnings-completion.service';
import { earningsPauseService, SYSTEM_PAUSE_ACTOR, PauseActor } from '../../src/modules/earnings/services/earnings-pause.service';
import { EarningsAllocationRepository } from '../../src/modules/earnings/repositories/earnings-allocation.repository';
import { EarningsReleaseWorker } from '../../src/modules/earnings/workers/earnings-release.worker';
import { OrderModel } from '../../src/modules/orders/order.model';
import { OrderTimelineModel } from '../../src/modules/orders/order-timeline.model';
import { ShipmentModel } from '../../src/modules/shipments/shipment.model';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DAY = 86_400_000;
const ADMIN: PauseActor = { userId: new Types.ObjectId().toString(), source: 'admin', name: 'verify admin' };

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

const orders: Types.ObjectId[] = [];
const shipments: Types.ObjectId[] = [];

interface Fixture {
  orderId: string;
  shipmentId: string;
  vendorRow: Types.ObjectId;
  freeAgency: Types.ObjectId;
  freeAgent: Types.ObjectId;
  heldAgency: Types.ObjectId;
}

/**
 * One prepaid order, delivered (order clock started a day ago), with two parcels' worth of
 * courier rows hanging off ONE shipment for brevity: a free agency + its rider (days 0) and a
 * held agency (days 2). The shipment sits at the rider's tap.
 */
async function makeFixture(tapAt: Date): Promise<Fixture> {
  const orderId = new Types.ObjectId();
  const shipmentId = new Types.ObjectId();
  orders.push(orderId);
  shipments.push(shipmentId);
  const deliveredAt = new Date(Date.now() - DAY);

  await OrderModel.collection.insertOne({
    _id: orderId,
    order_number: `VERIFY-${orderId.toString()}`,
    order_type: 'physical',
    payment_method: 'mobile_money',
    vendor_id: new Types.ObjectId(),
    currency: 'XAF',
    delivered_at: deliveredAt,
  });
  await ShipmentModel.collection.insertOne({
    _id: shipmentId,
    order_id: orderId,
    agency_id: new Types.ObjectId(),
    tracking_number: `TRK-${shipmentId.toString().slice(-6)}`,
    status: 'agent_delivered',
    delivery_fee_snapshot: 2000,
    status_history: [
      { status: 'in_transit', changed_at: new Date(tapAt.getTime() - 3_600_000), changed_by_role: 'agent' },
      { status: 'agent_delivered', changed_at: tapAt, changed_by_role: 'agent' },
    ],
  });

  const base = {
    gross_snapshot: 2000,
    commission_percent_snapshot: 0,
    clawed_amount: 0,
    currency: 'XAF',
    status: 'held',
    paused_at: null,
    requires_cash_settlement: false,
  };
  const snap = (days: number, agencyId: string) => ({
    shipment_id: shipmentId.toString(),
    agency_id: agencyId,
    days,
    protection_days: 3,
    returns_payer: 'vendor',
    claim_deadline_days: days,
  });
  const freeAgencyId = new Types.ObjectId().toString();
  const ids = {
    vendorRow: new Types.ObjectId(),
    freeAgency: new Types.ObjectId(),
    freeAgent: new Types.ObjectId(),
    heldAgency: new Types.ObjectId(),
  };
  await EarningsAllocationModel.collection.insertMany([
    {
      ...base, _id: ids.vendorRow, source_type: 'order', source_id: orderId,
      beneficiary_type: 'vendor', beneficiary_id: new Types.ObjectId(), amount: 9000,
      completed_at: deliveredAt, hold_release_at: new Date(deliveredAt.getTime() + 3 * DAY), courier_hold: null,
    },
    {
      ...base, _id: ids.freeAgency, source_type: 'shipment', source_id: shipmentId,
      beneficiary_type: 'agency', beneficiary_id: new Types.ObjectId(freeAgencyId), amount: 1500,
      completed_at: null, hold_release_at: null, courier_hold: snap(0, freeAgencyId),
    },
    {
      ...base, _id: ids.freeAgent, source_type: 'shipment', source_id: shipmentId,
      beneficiary_type: 'agent', beneficiary_id: new Types.ObjectId(), amount: 500,
      completed_at: null, hold_release_at: null, courier_hold: snap(0, freeAgencyId),
    },
    {
      // A second agency on the same source is impossible in production (one agency per
      // shipment); a distinct beneficiary id keeps the unique index happy and lets one parcel
      // carry both cases.
      ...base, _id: ids.heldAgency, source_type: 'shipment', source_id: shipmentId,
      beneficiary_type: 'agency', beneficiary_id: new Types.ObjectId(), amount: 1500,
      completed_at: null, hold_release_at: null, courier_hold: snap(2, new Types.ObjectId().toString()),
    },
  ]);
  return { orderId: orderId.toString(), shipmentId: shipmentId.toString(), ...ids };
}

const row = async (id: Types.ObjectId) => (await EarningsAllocationModel.findById(id).lean())!;

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`verify:courier-hold against ${MONGO_URI.replace(/\/\/[^@]*@/, '//***@')}`);

  try {
    const tapAt = new Date(Date.now() - 2 * DAY);
    const f = await makeFixture(tapAt);

    console.log('\n1–3. the courier clock');
    await earningsCompletionService.syncOrderHold(f.orderId);

    await assert('free agency at the rider\'s tap: NOT started (waits for proof)', async () => {
      eq((await row(f.freeAgency)).completed_at, null, 'free agency completed_at');
      eq((await row(f.freeAgent)).completed_at, null, 'free rider completed_at');
    });
    await assert('held agency: started at the tap, released 2 days later', async () => {
      const r = await row(f.heldAgency);
      eq(r.completed_at?.getTime(), tapAt.getTime(), 'held completed_at');
      eq(r.hold_release_at?.getTime(), tapAt.getTime() + 2 * DAY, 'held hold_release_at');
    });
    await assert('the vendor row keeps the ORDER\'s dates', async () => {
      const r = await row(f.vendorRow);
      eq(r.hold_release_at?.getTime(), r.completed_at!.getTime() + 3 * DAY, 'vendor 3-day hold');
    });

    await ShipmentModel.collection.updateOne(
      { _id: new Types.ObjectId(f.shipmentId) },
      { $set: { status: 'failed' }, $push: { status_history: { status: 'failed', changed_at: new Date(), changed_by_role: 'agent' } } as any }
    );
    await earningsCompletionService.syncOrderHold(f.orderId);
    await assert('a failed tap clears the held agency\'s start', async () => {
      eq((await row(f.heldAgency)).completed_at, null, 'held completed_at after failed');
    });

    const confirmedAt = new Date(Date.now() - DAY / 2);
    await ShipmentModel.collection.updateOne(
      { _id: new Types.ObjectId(f.shipmentId) },
      {
        $set: { status: 'delivered', customer_confirmation: { confirmed_at: confirmedAt, confirmed_by: null, auto: false } },
        $push: {
          status_history: {
            $each: [
              { status: 'agent_delivered', changed_at: new Date(confirmedAt.getTime() - 3_600_000), changed_by_role: 'agent' },
              { status: 'delivered', changed_at: confirmedAt, changed_by_role: 'customer' },
            ],
          },
        } as any,
      }
    );
    await earningsCompletionService.syncOrderHold(f.orderId);
    await assert('free agency and rider: started at the confirmation and due at once', async () => {
      for (const id of [f.freeAgency, f.freeAgent]) {
        const r = await row(id);
        eq(r.completed_at?.getTime(), confirmedAt.getTime(), 'free completed_at');
        eq(r.hold_release_at?.getTime(), confirmedAt.getTime(), 'free hold_release_at');
      }
    });
    await assert('the release query finds the free shares now', async () => {
      const due = await new EarningsAllocationRepository().findMaturedHeld(new Date(), 10_000);
      const ids = new Set(due.map((d) => String(d._id)));
      eq(ids.has(String(f.freeAgency)) && ids.has(String(f.freeAgent)), true, 'free rows due');
    });

    console.log('\n4. an administrator\'s ORDER pause');
    const beforeVendor = (await row(f.vendorRow)).hold_release_at!.getTime();
    const beforeFree = (await row(f.freeAgency)).hold_release_at!.getTime();
    const p = await earningsPauseService.pause({ kind: 'order', id: f.orderId }, 'admin', ADMIN, 'verify');
    await assert('paused: the vendor and the held agency, NOT the free agency or its rider', async () => {
      eq(p.changed, true, 'changed');
      eq(!!(await row(f.vendorRow)).paused_at, true, 'vendor paused');
      eq(!!(await row(f.heldAgency)).paused_at, true, 'held agency paused');
      eq((await row(f.freeAgency)).paused_at, null, 'free agency not paused');
      eq((await row(f.freeAgent)).paused_at, null, 'free rider not paused');
    });
    await assert('the worker double-check agrees: no pause holds the free share', async () => {
      const cache = new Map();
      eq(await earningsPauseService.pausedAtOfSource((await EarningsAllocationModel.findById(f.freeAgency))!, cache), null, 'free');
      eq(!!(await earningsPauseService.pausedAtOfSource((await EarningsAllocationModel.findById(f.vendorRow))!, cache)), true, 'vendor');
    });
    await new Promise((r) => setTimeout(r, 50));
    await earningsPauseService.resume({ kind: 'order', id: f.orderId }, ADMIN, null);
    await assert('resume moves the rows it held, and never the free agency\'s date', async () => {
      eq((await row(f.vendorRow)).paused_at, null, 'vendor unpaused');
      eq((await row(f.vendorRow)).hold_release_at!.getTime() > beforeVendor, true, 'vendor moved later');
      eq((await row(f.freeAgency)).hold_release_at!.getTime(), beforeFree, 'free date untouched');
    });

    console.log('\n5. a customer\'s problem report');
    await earningsPauseService.pause({ kind: 'order', id: f.orderId }, 'customer_problem_reported', SYSTEM_PAUSE_ACTOR, null);
    await assert('reaches the free agency too (only the admin pause skips it)', async () => {
      eq(!!(await row(f.freeAgency)).paused_at, true, 'free agency paused');
    });
    await earningsPauseService.resume({ kind: 'order', id: f.orderId }, SYSTEM_PAUSE_ACTOR, null);

    console.log('\n6–7. a DELIVERY pause, alone and overlapping');
    const vendorBefore = (await row(f.vendorRow)).hold_release_at!.getTime();
    const sp = await earningsPauseService.pause({ kind: 'shipment', id: f.shipmentId }, 'admin', ADMIN, 'verify');
    const spAt = sp.pause!.paused_at!.getTime();
    await assert('reaches the parcel\'s agency and rider — the free ones included — never the vendor', async () => {
      eq(!!(await row(f.freeAgency)).paused_at, true, 'free agency');
      eq(!!(await row(f.freeAgent)).paused_at, true, 'free rider');
      eq((await row(f.vendorRow)).paused_at, null, 'vendor');
    });
    await assert('the admin queue lists it with its order and agency', async () => {
      const { items } = await earningsPauseService.listActive('shipment', 1, 50);
      const mine = items.find((i) => i.id === f.shipmentId);
      eq(!!mine, true, 'listed');
      eq(mine!.orderId, f.orderId, 'orderId');
      eq(mine!.currency, 'XAF', 'currency from the order');
    });

    await new Promise((r) => setTimeout(r, 50));
    await earningsPauseService.pause({ kind: 'order', id: f.orderId }, 'card_dispute', SYSTEM_PAUSE_ACTOR, null);
    await new Promise((r) => setTimeout(r, 50));
    const freeBefore = (await row(f.freeAgency)).hold_release_at!.getTime();
    await earningsPauseService.resume({ kind: 'shipment', id: f.shipmentId }, ADMIN, null);
    await assert('delivery resumed while the order is still disputed: the agency stays held', async () => {
      eq(!!(await row(f.freeAgency)).paused_at, true, 'still paused by the order');
      eq((await row(f.freeAgency)).paused_at!.getTime(), spAt, 'mark is the start of the span');
    });
    await new Promise((r) => setTimeout(r, 50));
    const endAt = Date.now();
    await earningsPauseService.resume({ kind: 'order', id: f.orderId }, SYSTEM_PAUSE_ACTOR, null);
    await assert('order resumed too: released, moved by the WHOLE span from the delivery pause', async () => {
      const r = await row(f.freeAgency);
      eq(r.paused_at, null, 'unpaused');
      const moved = r.hold_release_at!.getTime() - freeBefore;
      const span = endAt - spAt;
      if (moved < span || moved > span + 2_000) throw new Error(`moved ${moved}ms for a ${span}ms span`);
    });
    await assert('the vendor moved only by the order pause, not the delivery\'s', async () => {
      const moved = (await row(f.vendorRow)).hold_release_at!.getTime() - vendorBefore;
      if (moved >= Date.now() - spAt) throw new Error(`vendor moved ${moved}ms — the delivery pause reached it`);
    });

    console.log('\n9. the nightly backstop');
    const g = await makeFixture(new Date(Date.now() - DAY));
    await ShipmentModel.collection.updateOne(
      { _id: new Types.ObjectId(g.shipmentId) },
      { $set: { status: 'delivered' }, $push: { status_history: { status: 'delivered', changed_at: new Date(Date.now() - 3_600_000), changed_by_role: 'customer' } } as any }
    );
    await (new EarningsReleaseWorker() as any).startCourierHolds(new Date());
    await assert('a clock no event started is started by the sweep, from the parcel\'s history', async () => {
      const r = await row(g.freeAgency);
      eq(!!r.completed_at, true, 'started');
      eq(r.hold_release_at!.getTime() <= Date.now(), true, 'due');
    });
  } finally {
    await EarningsAllocationModel.collection.deleteMany({
      $or: [
        { source_id: { $in: orders } },
        { source_id: { $in: shipments } },
      ],
    });
    await OrderModel.collection.deleteMany({ _id: { $in: orders } });
    await ShipmentModel.collection.deleteMany({ _id: { $in: shipments } });
    await OrderTimelineModel.collection.deleteMany({ order_id: { $in: orders } });
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
