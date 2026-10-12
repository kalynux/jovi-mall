/**
 * verify:problem-report-hold — a customer's problem report against a real database (owner
 * decision, 2026-10-10). `test:problem-report-hold` proves the rules offline; this proves the
 * money is actually paused and resumed, and by whom:
 *
 *   1. a customer's report on their own order pauses it, and its held shares;
 *   2. the SELLER ending the request frees nothing;
 *   3. the customer ending it resumes, and the hold moves later by the paused time;
 *   4. a second report by the same customer pauses again;
 *   5. an administrator ending it resumes for good: a later report does not pause;
 *   6. somebody else's order, a question, and released money are never paused;
 *   7. two reports: the pause stands until the last one ends;
 *   8. a report about a SHIPMENT pauses its order;
 *   9. a report under another active pause takes over when that pause ends without a refund;
 *  10. an administrator's manual resume releases every request;
 *  11. a booking is paused the same way.
 *
 * A standalone mongod is enough (no transactions). It writes its own fixtures under fresh
 * ObjectIds — inserted raw — and deletes everything it wrote, pass or fail.
 *
 * Run: MONGO_URI=mongodb://127.0.0.1:27117/verify_problem_hold npm run verify:problem-report-hold
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';

import { ticketEarningsHoldService } from '../../src/modules/tickets/services/ticket-earnings-hold.service';
import { earningsPauseService, SYSTEM_PAUSE_ACTOR } from '../../src/modules/earnings/services/earnings-pause.service';
import { TicketModel, ITicket } from '../../src/modules/tickets/models/ticket.model';
import { TicketNoteModel } from '../../src/modules/tickets/models/ticket-note.model';
import { OrderModel } from '../../src/modules/orders/order.model';
import { OrderTimelineModel } from '../../src/modules/orders/order-timeline.model';
import { ShipmentModel } from '../../src/modules/shipments/shipment.model';
import { Booking } from '../../src/modules/booking/models/booking.model';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { ActorRole, EntityType, TicketType } from '../../src/modules/tickets/types/ticket.types';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
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

const orders: Types.ObjectId[] = [];
const bookings: Types.ObjectId[] = [];
const shipments: Types.ObjectId[] = [];
const tickets: Types.ObjectId[] = [];

interface Buyer { userId: Types.ObjectId; customerId: Types.ObjectId }
const buyer = (): Buyer => ({ userId: new Types.ObjectId(), customerId: new Types.ObjectId() });
const seller = { userId: new Types.ObjectId().toString(), role: ActorRole.VENDOR };
const admin = { userId: new Types.ObjectId().toString(), role: ActorRole.ADMIN };

/** An order with one vendor share, delivered a day ago. `status` is that share's status. */
async function makeOrder(owner: Buyer, status: 'held' | 'released' = 'held'): Promise<string> {
  const _id = new Types.ObjectId();
  orders.push(_id);
  const deliveredAt = new Date(Date.now() - DAY);
  await OrderModel.collection.insertOne({
    _id,
    order_number: `VERIFY-${_id.toString()}`,
    customer_id: owner.customerId,
    vendor_id: new Types.ObjectId(),
    delivered_at: deliveredAt,
  });
  await EarningsAllocationModel.collection.insertOne({
    _id: new Types.ObjectId(),
    source_type: 'order',
    source_id: _id,
    beneficiary_type: 'vendor',
    beneficiary_id: new Types.ObjectId(),
    gross_snapshot: 10000,
    commission_percent_snapshot: 10,
    amount: 9000,
    clawed_amount: 0,
    currency: 'XAF',
    status,
    completed_at: deliveredAt,
    hold_release_at: new Date(deliveredAt.getTime() + 3 * DAY),
    paused_at: null,
    requires_cash_settlement: false,
  });
  return _id.toString();
}

async function makeTicket(
  owner: Buyer,
  entityType: EntityType,
  entityId: string,
  type: TicketType = TicketType.ORDER_ISSUE
): Promise<ITicket> {
  const ticket = await TicketModel.create({
    subject: 'verify',
    description: 'verify',
    type,
    status: 'open',
    priority: 'normal',
    importance: 'medium',
    priority_locked: false,
    entity_type: entityType,
    entity_id: entityId,
    created_by_role: ActorRole.CUSTOMER,
    created_by_user_id: owner.userId,
  });
  tickets.push(ticket._id as Types.ObjectId);
  return ticket;
}

/** Open a request the way `TicketService.createTicket` does, and return the stored ticket. */
async function report(owner: Buyer, entityType: EntityType, entityId: string, type?: TicketType): Promise<ITicket> {
  const ticket = await makeTicket(owner, entityType, entityId, type);
  await ticketEarningsHoldService.onTicketCreated(ticket, {
    userId: owner.userId.toString(),
    entityId: owner.customerId.toString(),
  });
  return (await TicketModel.findById(ticket._id))!;
}

const end = async (ticket: ITicket, by: { userId: string; role: string }) =>
  ticketEarningsHoldService.onTicketEnded((await TicketModel.findById(ticket._id))!, by);
const asCustomer = (owner: Buyer) => ({ userId: owner.userId.toString(), role: ActorRole.CUSTOMER });
const pauseOf = (orderId: string) => earningsPauseService.currentPause({ kind: 'order', id: orderId });
const shareOf = (orderId: string) => EarningsAllocationModel.findOne({ source_id: new Types.ObjectId(orderId) }).lean();
const holds = async (ticket: ITicket) => (await TicketModel.findById(ticket._id).lean())?.holds_earnings === true;

async function run(): Promise<void> {
  // ── 1–3: pause, the seller cannot lift it, the customer can ─────────────────
  console.log('\n1–3. Pause, and who may lift it');
  const alice = buyer();
  const order1 = await makeOrder(alice);
  const before = (await shareOf(order1))!.hold_release_at!.getTime();
  const t1 = await report(alice, EntityType.ORDER, order1);

  await assert('a customer\'s report on their own order pauses it', async () => {
    const pause = await pauseOf(order1);
    eq(pause?.active, true, 'pause.active');
    eq(pause?.reason, 'customer_problem_reported', 'pause.reason');
    eq(await holds(t1), true, 'ticket.holds_earnings');
    eq((await shareOf(order1))!.paused_at !== null, true, 'the held share carries paused_at');
  });

  await assert('a public note tells every follower the earnings are on hold', async () => {
    eq(await TicketNoteModel.countDocuments({ ticket_id: t1._id }), 1, 'system notes');
  });

  await end(t1, seller);
  await assert('the SELLER ending the request frees nothing', async () => {
    eq((await pauseOf(order1))?.active, true, 'pause.active');
    eq(await holds(t1), true, 'ticket.holds_earnings');
  });

  await end(t1, asCustomer(alice));
  await assert('the customer ending it resumes, signed by the system', async () => {
    const pause = await pauseOf(order1);
    eq(pause?.active, false, 'pause.active');
    eq(pause?.resumed_by_source, 'platform', 'resumed_by_source');
    eq(await holds(t1), false, 'ticket.holds_earnings');
  });

  await assert('the hold continues: its release date is never earlier than before', async () => {
    const share = (await shareOf(order1))!;
    eq(share.paused_at, null, 'paused_at cleared');
    eq(share.hold_release_at!.getTime() >= before, true, 'hold_release_at not earlier');
  });

  // ── 4–5: a second report; an administrator's decision is final ──────────────
  console.log('\n4–5. A second report, and an administrator\'s decision');
  const t2 = await report(alice, EntityType.ORDER, order1);
  await assert('a second report by the same customer pauses again', async () => {
    eq((await pauseOf(order1))?.active, true, 'pause.active');
    eq(await holds(t2), true, 'ticket.holds_earnings');
  });

  await end(t2, admin);
  await assert('an administrator ending it resumes, recorded as an administrator\'s decision', async () => {
    const pause = await pauseOf(order1);
    eq(pause?.active, false, 'pause.active');
    eq(pause?.resumed_by_source, 'admin', 'resumed_by_source');
  });

  const t3 = await report(alice, EntityType.ORDER, order1);
  await assert('after that, a new report does not pause by itself', async () => {
    eq((await pauseOf(order1))?.active, false, 'pause.active');
    eq(await holds(t3), false, 'ticket.holds_earnings');
  });

  // ── 6: what is never paused ────────────────────────────────────────────────
  console.log('\n6. What is never paused');
  const bob = buyer();
  const order2 = await makeOrder(alice);
  const stranger = await report(bob, EntityType.ORDER, order2);
  await assert('somebody else\'s order: quoting its id freezes nothing', async () => {
    eq(await pauseOf(order2), null, 'pause');
    eq(await holds(stranger), false, 'ticket.holds_earnings');
  });

  const question = await report(alice, EntityType.ORDER, order2, TicketType.INVOICE_REQUEST);
  await assert('a question (an invoice request) is not a problem report', async () => {
    eq(await pauseOf(order2), null, 'pause');
    eq(await holds(question), false, 'ticket.holds_earnings');
  });

  const order3 = await makeOrder(alice, 'released');
  const late = await report(alice, EntityType.ORDER, order3);
  await assert('money already released: the request is opened and holds nothing', async () => {
    eq(await pauseOf(order3), null, 'pause');
    eq(await holds(late), false, 'ticket.holds_earnings');
  });

  // ── 7: two reports ─────────────────────────────────────────────────────────
  console.log('\n7. Two reports on one order');
  const a = await report(alice, EntityType.ORDER, order2);
  const b = await report(alice, EntityType.ORDER, order2);
  await end(a, asCustomer(alice));
  await assert('ending one of two keeps the money paused', async () => {
    eq((await pauseOf(order2))?.active, true, 'pause.active');
  });
  await end(b, asCustomer(alice));
  await assert('ending the last one resumes', async () => {
    eq((await pauseOf(order2))?.active, false, 'pause.active');
  });

  // ── 8: a shipment ──────────────────────────────────────────────────────────
  console.log('\n8. A report about a shipment');
  const order4 = await makeOrder(alice);
  const shipmentId = new Types.ObjectId();
  shipments.push(shipmentId);
  await ShipmentModel.collection.insertOne({ _id: shipmentId, order_id: new Types.ObjectId(order4) });
  const s = await report(alice, EntityType.SHIPMENT, shipmentId.toString(), TicketType.SHIPPING_ISSUE);
  await assert('it pauses the shipment\'s ORDER', async () => {
    eq((await pauseOf(order4))?.reason, 'customer_problem_reported', 'pause.reason');
    eq(await holds(s), true, 'ticket.holds_earnings');
  });
  await end(s, asCustomer(alice));
  await assert('and ending it resumes that order', async () => {
    eq((await pauseOf(order4))?.active, false, 'pause.active');
  });

  // ── 9: under another pause ─────────────────────────────────────────────────
  console.log('\n9. A report while another pause is active');
  const order5 = await makeOrder(alice);
  const target5 = { kind: 'order' as const, id: order5 };
  await earningsPauseService.pause(target5, 'refund_in_progress', SYSTEM_PAUSE_ACTOR, 'verify');
  const under = await report(alice, EntityType.ORDER, order5);
  await assert('the other pause is left exactly as it was, and the request is still recorded', async () => {
    eq((await pauseOf(order5))?.reason, 'refund_in_progress', 'pause.reason');
    eq(await holds(under), true, 'ticket.holds_earnings');
  });
  // What `RefundEarningsAdapter.onRequestClosedWithoutRefund` does: resume its own, reconcile.
  await earningsPauseService.resume(target5, SYSTEM_PAUSE_ACTOR, 'verify', ['refund_in_progress']);
  await ticketEarningsHoldService.reconcile(target5);
  await assert('when that pause ends without a refund, the report takes over', async () => {
    const pause = await pauseOf(order5);
    eq(pause?.active, true, 'pause.active');
    eq(pause?.reason, 'customer_problem_reported', 'pause.reason');
  });

  // ── 10: an administrator's manual resume ───────────────────────────────────
  console.log('\n10. An administrator resumes by hand');
  await earningsPauseService.resume(target5, { userId: admin.userId, source: 'admin', name: 'Verify Admin' }, 'verify');
  await ticketEarningsHoldService.releaseAll(target5);
  await assert('no request about the order holds its earnings any more', async () => {
    eq(await holds(under), false, 'ticket.holds_earnings');
    eq((await pauseOf(order5))?.active, false, 'pause.active');
  });
  await ticketEarningsHoldService.reconcile(target5);
  await assert('and nothing pauses it again behind their back', async () => {
    eq((await pauseOf(order5))?.active, false, 'pause.active');
  });

  // ── 11: a booking ──────────────────────────────────────────────────────────
  console.log('\n11. A booking');
  const bookingId = new Types.ObjectId();
  bookings.push(bookingId);
  await Booking.collection.insertOne({
    _id: bookingId,
    bookingNumber: `VERIFY-${bookingId.toString()}`,
    userId: alice.userId,
    vendorId: new Types.ObjectId(),
  });
  const bk = await report(alice, EntityType.BOOKING, bookingId.toString(), TicketType.BOOKING_ISSUE);
  await assert('a report by the booking\'s own customer pauses the booking', async () => {
    const pause = await earningsPauseService.currentPause({ kind: 'booking', id: bookingId.toString() });
    eq(pause?.active, true, 'pause.active');
    eq(pause?.reason, 'customer_problem_reported', 'pause.reason');
    eq(await holds(bk), true, 'ticket.holds_earnings');
  });
  const notMine = await report(bob, EntityType.BOOKING, bookingId.toString(), TicketType.BOOKING_ISSUE);
  await assert('another customer\'s request about it holds nothing', async () => {
    eq(await holds(notMine), false, 'ticket.holds_earnings');
  });
}

async function cleanup(): Promise<void> {
  // Raw, here and for the timeline: both models refuse deletes (they are immutable histories).
  await TicketNoteModel.collection.deleteMany({ ticket_id: { $in: tickets } });
  await TicketModel.deleteMany({ _id: { $in: tickets } });
  await OrderTimelineModel.collection.deleteMany({ order_id: { $in: orders } });
  await EarningsAllocationModel.deleteMany({ source_id: { $in: orders } });
  await ShipmentModel.deleteMany({ _id: { $in: shipments } });
  await OrderModel.deleteMany({ _id: { $in: orders } });
  await Booking.deleteMany({ _id: { $in: bookings } });
}

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log('verify:problem-report-hold');
  try {
    await run();
  } finally {
    await cleanup().catch((error) => console.error('cleanup failed:', error));
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
