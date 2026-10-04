/**
 * verify:change-agency-tx — the change of agency against a REAL replica set (ADR-A11 D-12).
 *
 * `test:change-agency-tx` proves the boundary by source scan and the fee rules against fakes.
 * Three claims only a real transaction can make are the reason this exists:
 *
 *   - a failure AFTER the first writes leaves NOTHING behind — the source shipment keeps its
 *     items, no destination exists, the order item still points where it did, no timeline row,
 *     no proposal, the COD collection untouched (a claim about MongoDB transaction semantics);
 *   - two concurrent moves of one item cannot both succeed — one commits, the other is refused
 *     `409 SHIPMENT_REASSIGNMENT_CONFLICT`, and the item exists exactly once;
 *   - a transient error (a write conflict) re-runs the whole callback WITHOUT doubling anything:
 *     one copy of the item, one timeline row, the post-commit effects run exactly once.
 *
 * Plus the behaviours the transaction must keep: a partial move, a whole customer-paid move
 * (fee carried once over a 2-item batch, the difference settled), an accepted agent's shipment
 * refused, an agency-declined shipment with a cancelled COD code movable.
 *
 * ⚠ Writes fixtures. Run it ONLY against a disposable database: it REFUSES unless the database
 * name contains "verify" (e.g. MONGO_URI=mongodb://127.0.0.1:27118/change_agency_verify?replicaSet=rsverify).
 * It drops every collection it touched at the end, pass or fail.
 *
 * Run: MONGO_URI=… npm run verify:change-agency-tx
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { MongoServerError } from 'mongodb';

import { VendorOrderService } from '../../src/modules/orders/vendor-order.service';
import { changeAgencyFeeService } from '../../src/modules/delivery-fee-proposals/services/change-agency-fee.service';
import { customerFeeNotifier } from '../../src/modules/delivery-fee-proposals/services/customer-fee-notifier';
import { entitlementService } from '../../src/modules/billing/services/entitlement.service';
import { eventBus } from '../../src/core/events/event-bus';
import { createAppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { COLLECTIONS } from '../../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || '';

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  try {
    if (await fn()) {
      passed++;
      console.log(`  ✅ ${label}`);
    } else {
      failed++;
      console.log(`  ❌ FAIL: ${label}`);
    }
  } catch (err) {
    failed++;
    console.log(`  ❌ THROW: ${label} — ${(err as Error).message}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);
const db = () => mongoose.connection.db!;
const col = (name: string) => db().collection(name);

// ─── fixtures ────────────────────────────────────────────────────────────────

const AGENCY_A = new Types.ObjectId();
const AGENCY_B = new Types.ObjectId();
const AGENCY_C = new Types.ObjectId();

async function seedAgencies(): Promise<void> {
  const rows = [
    [AGENCY_A, 'Alpha Express'],
    [AGENCY_B, 'Bravo Courier'],
    [AGENCY_C, 'Charlie Delivery'],
  ] as const;
  for (const [id, name] of rows) {
    await col(COLLECTIONS.DELIVERY_AGENCY).insertOne({
      _id: id,
      user_id: new Types.ObjectId(),
      status: 'active',
      // C prices pickups at 5 000 (so a move onto it from a cheaper run is an INCREASE); A and B
      // have no policy and fall back to the flat fee (0 here), so a move onto them is a decrease.
      policies: id === AGENCY_C ? { pricing: { pickup_based: { base_rate_first_kg: 5000, additional_per_kg: 0, out_of_region_surcharge: 0 } } } : null,
    });
    await col(COLLECTIONS.AGENCY_MAGAZIN).insertOne({ _id: new Types.ObjectId(), agency_id: id, user_id: new Types.ObjectId(), name });
  }
}

interface Fixture {
  orderId: string;
  vendorId: string;
  itemIds: string[];
  sourceId: string;
}

let trackingSeq = 0;
async function seedOrder(opts: {
  items?: number;
  payer?: 'vendor' | 'customer';
  paymentMethod?: string;
  paymentStatus?: string;
  sourceStatus?: string;
  sourceFee?: number;
  customerFee?: number;
  agentId?: Types.ObjectId | null;
  collection?: 'pending' | 'cancelled' | null;
}): Promise<Fixture> {
  const orderId = new Types.ObjectId();
  const vendorId = new Types.ObjectId();
  const sourceId = new Types.ObjectId();
  const n = opts.items ?? 2;
  const payer = opts.payer ?? 'vendor';
  const itemStatus = opts.sourceStatus === 'rejected' ? 'pending_agency_reassignment' : (opts.sourceStatus ?? 'assigned');
  const items = Array.from({ length: n }, (_, k) => ({
    _id: new Types.ObjectId(),
    product_id: new Types.ObjectId(),
    variant_id: new Types.ObjectId(),
    title: `Verify item ${k + 1}`,
    price: 20_000,
    quantity: 1,
    delivery: { agency_id: AGENCY_A, shipment_id: sourceId, status: itemStatus, hold: null, pickup_location: { source: 'vendor_address', vendor_address_id: null, agency_address_id: null } },
  }));
  const customerFee = payer === 'customer' ? (opts.customerFee ?? 1500) : 0;
  await col(COLLECTIONS.ORDER).insertOne({
    _id: orderId,
    vendor_id: vendorId,
    customer_id: new Types.ObjectId(),
    order_number: `VER-${orderId.toString().slice(-6)}`,
    order_type: 'physical',
    fulfillment_status: 'processing',
    payment_method: opts.paymentMethod ?? 'cash_on_delivery',
    payment_status: opts.paymentStatus ?? 'pending',
    delivery_payer: payer,
    currency: 'XAF',
    items,
    price_breakdown: { base: 20_000 * n, delivery: customerFee, tax: 0, discount: 0, total: 20_000 * n + customerFee },
    total_amount: 20_000 * n + customerFee,
    created_at: new Date(),
    updated_at: new Date(),
  });
  await col(COLLECTIONS.SHIPMENT).insertOne({
    _id: sourceId,
    order_id: orderId,
    agency_id: AGENCY_A,
    agent_id: opts.agentId ?? null,
    status: opts.sourceStatus ?? 'assigned',
    items: items.map((i) => ({ order_item_id: i._id, product_id: i.product_id, variant_id: i.variant_id, quantity: 1 })),
    tracking_number: `VER-${Date.now()}-${trackingSeq++}`,
    delivery_payer: payer,
    delivery_fee_snapshot: opts.sourceFee ?? 1500,
    customer_delivery_fee: customerFee,
    customer_fee_refundable: 0,
    pending_delivery_fee_proposal_id: null,
    assignment: { state: 'unassigned', current_offer_id: null, offered_agent_id: null, updated_at: new Date() },
    created_at: new Date(),
    updated_at: new Date(),
  });
  if (opts.collection) {
    await col(COLLECTIONS.CASH_COLLECTION).insertOne({
      order_id: orderId,
      shipment_id: sourceId,
      agency_id: AGENCY_A,
      agent_id: opts.agentId ?? null,
      customer_id: new Types.ObjectId(),
      vendor_id: vendorId,
      expected_amount: 20_000 * n + customerFee,
      items_amount: 20_000 * n,
      delivery_fee_amount: customerFee,
      currency: 'XAF',
      status: opts.collection,
      code_hash: 'verify',
      code_attempts: 0,
      code_locked: false,
    });
  }
  return { orderId: orderId.toString(), vendorId: vendorId.toString(), itemIds: items.map((i) => i._id.toString()), sourceId: sourceId.toString() };
}

const shipmentsOf = (orderId: string) => col(COLLECTIONS.SHIPMENT).find({ order_id: new Types.ObjectId(orderId) }).toArray();
const orderOf = (orderId: string) => col(COLLECTIONS.ORDER).findOne({ _id: new Types.ObjectId(orderId) });
const timelineCount = (orderId: string) => col(COLLECTIONS.ORDER_TIMELINE).countDocuments({ order_id: new Types.ObjectId(orderId) });
const proposalsOf = (orderId: string) => col(COLLECTIONS.DELIVERY_FEE_PROPOSAL).find({ order_id: new Types.ObjectId(orderId) }).toArray();
const collectionOf = (shipmentId: string) => col(COLLECTIONS.CASH_COLLECTION).findOne({ shipment_id: new Types.ObjectId(shipmentId) });
const itemOf = (order: any, itemId: string) => order.items.find((i: any) => i._id.toString() === itemId);

async function refusal(p: Promise<unknown>): Promise<{ code: string; statusCode: number } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; statusCode?: number };
    return { code: String(e.code), statusCode: Number(e.statusCode) };
  }
}

/** A snapshot of everything the change of agency can write, for "nothing changed" checks. */
async function stateOf(f: Fixture): Promise<string> {
  const strip = (d: any) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'updated_at' ? undefined : v)));
  return JSON.stringify({
    shipments: strip(await shipmentsOf(f.orderId)),
    order: strip(await orderOf(f.orderId)),
    timeline: await timelineCount(f.orderId),
    proposals: strip(await proposalsOf(f.orderId)),
    collection: strip(await collectionOf(f.sourceId)),
  });
}

// ─── side-effect counters (the post-commit half) ─────────────────────────────

const effects = { lowered: 0, approvalNeeded: 0, created: 0 };
function installEffectCounters(): void {
  (customerFeeNotifier as any).lowered = () => { effects.lowered++; };
  (customerFeeNotifier as any).approvalNeeded = () => { effects.approvalNeeded++; };
  eventBus.subscribe('delivery_fee_proposal.created', async () => { effects.created++; });
  // Billing is configuration this suite does not seed: a 10 % commission plan.
  (entitlementService as any).getEntitlements = async () => ({ planCode: 'verify', maxActiveProducts: null, maxStorageBytes: 0, commissionPercent: 10 });
}

function transientOnce(): () => void {
  let thrown = false;
  return () => {
    if (thrown) return;
    thrown = true;
    throw new MongoServerError({
      message: 'simulated WriteConflict (verify:change-agency-tx)',
      code: 112,
      codeName: 'WriteConflict',
      errorLabels: ['TransientTransactionError'],
    } as any);
  };
}

async function main(): Promise<void> {
  if (!MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  const dbName = mongoose.connection.name;
  if (!/verify/i.test(dbName)) {
    console.log(`⛔ Refusing to run against database "${dbName}" — it writes fixtures and drops collections. Use a disposable database whose name contains "verify".`);
    await mongoose.disconnect();
    process.exit(2);
  }
  const hello = await db().admin().command({ hello: 1 });
  if (!hello.setName) {
    console.log('⛔ Not a replica set — transactions are unavailable.');
    await mongoose.disconnect();
    process.exit(2);
  }
  console.log(`database ${dbName} on replica set ${hello.setName}`);

  // Collections must exist before transactions write to them on a fresh database.
  for (const name of [COLLECTIONS.SHIPMENT, COLLECTIONS.ORDER, COLLECTIONS.ORDER_TIMELINE, COLLECTIONS.DELIVERY_FEE_PROPOSAL,
    COLLECTIONS.CASH_COLLECTION, COLLECTIONS.DELIVERY_AGENCY, COLLECTIONS.AGENCY_MAGAZIN, 'shipment_assignment_offers', 'shipment_assignment_sessions']) {
    await db().createCollection(name).catch(() => undefined);
  }
  // Let every model finish its index builds BEFORE the first transaction: a catalog change in the
  // middle of one aborts it (transiently), which would make the race in § 3 nondeterministic.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch(() => undefined)));
  await seedAgencies();
  installEffectCounters();

  try {
    // ─────────────────────────────────────────────────────────────────────────
    section('1. A partial move (vendor-paid)');
    {
      const f = await seedOrder({ items: 2, payer: 'vendor', paymentMethod: 'mobile_money', paymentStatus: 'paid' });
      const svc = new VendorOrderService();
      const r = await svc.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString());
      const ships = await shipmentsOf(f.orderId);
      const src = ships.find((s) => s._id.toString() === f.sourceId);
      const dest = ships.find((s) => s.agency_id.toString() === AGENCY_B.toString());
      const order = await orderOf(f.orderId);
      await check('the source keeps its other item; the moved one is on a new pending shipment at the new agency', () =>
        !!src && src.items.length === 1 && src.items[0].order_item_id.toString() === f.itemIds[1]
        && !!dest && dest.status === 'pending' && dest.items.length === 1 && dest.items[0].order_item_id.toString() === f.itemIds[0]
        && r.moved === 1 && r.destinationShipmentId === dest._id.toString());
      await check('the new run is vendor-paid (no customer fee invented)', () => !!dest && (dest.customer_delivery_fee ?? 0) === 0);
      await check('the order item points at the new agency + shipment, status pending; the other is untouched', () => {
        const moved = itemOf(order, f.itemIds[0]);
        const kept = itemOf(order, f.itemIds[1]);
        return moved.delivery.agency_id.toString() === AGENCY_B.toString() && moved.delivery.shipment_id.toString() === dest!._id.toString()
          && moved.delivery.status === 'pending' && kept.delivery.shipment_id.toString() === f.sourceId;
      });
      await check('one timeline row', async () => (await timelineCount(f.orderId)) === 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('2. ⭐ Rollback — a failure after the first writes leaves NOTHING behind');
    {
      const f = await seedOrder({ items: 2, payer: 'vendor', paymentMethod: 'mobile_money', paymentStatus: 'paid' });
      const before = await stateOf(f);
      const svc = new VendorOrderService();
      // The LAST write of the group (after the shipment create/merge, the $pull and the repoint).
      (svc as any).timelineRepo.appendEvent = async () => {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'injected failure (verify:change-agency-tx)');
      };
      const r = await refusal(svc.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString()));
      await check('the caller sees the error', () => r?.statusCode === 500);
      await check('the database is byte-for-byte as it was (no destination, source intact, order item unmoved, no timeline)', async () =>
        (await stateOf(f)) === before);
      const ships = await shipmentsOf(f.orderId);
      await check('…concretely: one shipment, still carrying both items, nothing at the new agency', () =>
        ships.length === 1 && ships[0].items.length === 2);
    }
    {
      // A whole customer-paid COD move, failing after the carry (the deepest point before the
      // difference): the source deletion, the carry and the collection cancel must all roll back.
      const f = await seedOrder({ items: 1, payer: 'customer', sourceFee: 1_000_000, customerFee: 1_000_000, collection: 'pending' });
      const before = await stateOf(f);
      const svc = new VendorOrderService();
      const original = changeAgencyFeeService.raiseDifferenceInSession.bind(changeAgencyFeeService);
      (changeAgencyFeeService as any).raiseDifferenceInSession = async () => {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'injected failure after the carry');
      };
      const r = await refusal(svc.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString()));
      (changeAgencyFeeService as any).raiseDifferenceInSession = original;
      await check('whole customer-paid move failing after delete + carry + collection cancel → error', () => r?.statusCode === 500);
      await check('…and the source shipment, its pending COD collection, the order and the proposals are exactly as before', async () =>
        (await stateOf(f)) === before);
      const coll = await collectionOf(f.sourceId);
      await check('…the COD code is still live (pending, original amount)', () => coll?.status === 'pending' && coll?.expected_amount === 1_020_000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('3. ⭐ Two concurrent moves of one item — exactly one wins');
    {
      const f = await seedOrder({ items: 1, payer: 'vendor', paymentMethod: 'mobile_money', paymentStatus: 'paid' });
      const first = new VendorOrderService();
      const second = new VendorOrderService();
      // Deterministic interleaving: the first move holds its transaction open (uncommitted writes
      // on the order and the source) until the second has passed its pre-check, so both read the
      // item on the source and both try to move it.
      let release!: () => void;
      const secondPreChecked = new Promise<void>((resolve) => { release = resolve; });
      const firstTimeline = (first as any).timelineRepo.appendEvent.bind((first as any).timelineRepo);
      (first as any).timelineRepo.appendEvent = async (...args: unknown[]) => {
        await secondPreChecked;
        return firstTimeline(...args);
      };
      const secondRead = (second as any).vendorOrderRepo.findByIdAndVendor.bind((second as any).vendorOrderRepo);
      (second as any).vendorOrderRepo.findByIdAndVendor = async (...args: unknown[]) => {
        const out = await secondRead(...args);
        setTimeout(release, 50);
        return out;
      };
      // How many times each callback body ran: a value ≥ 2 is the driver retrying after a
      // WriteConflict — the evidence of WHICH mechanism serialised the two.
      const attempts = { first: 0, second: 0 };
      for (const [svc, key] of [[first, 'first'], [second, 'second']] as const) {
        const group = (svc as any).moveGroupInSession.bind(svc);
        (svc as any).moveGroupInSession = async (...args: unknown[]) => { attempts[key]++; return group(...args); };
      }
      const results = await Promise.allSettled([
        first.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString()),
        second.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_C.toString()),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const ko = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      await check('one fulfilled, one rejected', () => ok.length === 1 && ko.length === 1);
      await check(`the loser's transaction hit a write conflict and was RE-RUN by the driver (attempts: ${attempts.first}/${attempts.second}) — its retry read the committed move and refused`, () =>
        Math.max(attempts.first, attempts.second) >= 2);
      await check('the loser is a 409 SHIPMENT_REASSIGNMENT_CONFLICT (not a 500, not a silent second move)', () =>
        ko[0]?.reason?.code === ERROR_CODES.SHIPMENT_REASSIGNMENT_CONFLICT && ko[0]?.reason?.statusCode === 409);
      const ships = await shipmentsOf(f.orderId);
      const order = await orderOf(f.orderId);
      // Usually the first (it wrote first) wins, but a transient abort of the first — e.g. a
      // catalog change — legitimately hands the win to the second. Either is correct; what is
      // never correct is two winners or an item that exists twice or not at all.
      const winner = (ok[0] as PromiseFulfilledResult<{ destinationShipmentId: string | null }> | undefined)?.value;
      const it = itemOf(order, f.itemIds[0]);
      const copies = ships.flatMap((s) => s.items.filter((i: any) => i.order_item_id.toString() === f.itemIds[0]).map(() => s));
      const exactlyOnce = ships.length === 1 && copies.length === 1 && !!winner
        && copies[0]._id.toString() === winner.destinationShipmentId && it.delivery.shipment_id.toString() === winner.destinationShipmentId
        && [AGENCY_B.toString(), AGENCY_C.toString()].includes(copies[0].agency_id.toString())
        && it.delivery.agency_id.toString() === copies[0].agency_id.toString();
      if (!exactlyOnce) {
        console.log('     state:', JSON.stringify({ results: results.map((r) => (r.status === 'rejected' ? (r as any).reason?.code : (r as any).value)), ships: ships.map((s) => ({ id: s._id, agency: s.agency_id, items: s.items.map((i: any) => i.order_item_id) })), item: it?.delivery }));
      }
      await check('the item exists exactly once, on the WINNER’s shipment and agency; the loser left no shipment behind', () => exactlyOnce);
      await check('one timeline row', async () => (await timelineCount(f.orderId)) === 1);
    }
    {
      // Same destination twice at once: the old code re-pushed the item and its $pull removed BOTH copies.
      const f = await seedOrder({ items: 2, payer: 'vendor', paymentMethod: 'mobile_money', paymentStatus: 'paid' });
      const a = new VendorOrderService();
      const b = new VendorOrderService();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const aTimeline = (a as any).timelineRepo.appendEvent.bind((a as any).timelineRepo);
      (a as any).timelineRepo.appendEvent = async (...args: unknown[]) => { await gate; return aTimeline(...args); };
      const bRead = (b as any).vendorOrderRepo.findByIdAndVendor.bind((b as any).vendorOrderRepo);
      (b as any).vendorOrderRepo.findByIdAndVendor = async (...args: unknown[]) => { const o = await bRead(...args); setTimeout(release, 50); return o; };
      const results = await Promise.allSettled([
        a.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString()),
        b.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString()),
      ]);
      const dest = (await shipmentsOf(f.orderId)).find((s) => s.agency_id.toString() === AGENCY_B.toString());
      await check('same item → same agency twice at once: one wins, the destination holds ONE copy and still exists', () =>
        results.filter((r) => r.status === 'fulfilled').length === 1 && !!dest && dest.items.length === 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('4. ⭐ A transient error re-runs the callback without doubling anything');
    {
      const f = await seedOrder({ items: 2, payer: 'vendor', paymentMethod: 'mobile_money', paymentStatus: 'paid' });
      const svc = new VendorOrderService();
      const boom = transientOnce();
      let attempts = 0;
      const original = (svc as any).timelineRepo.appendEvent.bind((svc as any).timelineRepo);
      (svc as any).timelineRepo.appendEvent = async (...args: unknown[]) => { attempts++; boom(); return original(...args); };
      const r = await svc.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString());
      const ships = await shipmentsOf(f.orderId);
      const dest = ships.find((s) => s.agency_id.toString() === AGENCY_B.toString());
      await check('the callback ran twice (the driver retried the TransientTransactionError)', () => attempts === 2);
      await check('…and committed ONE move: one destination, one copy, source keeps the other, one timeline row', async () =>
        r.moved === 1 && ships.length === 2 && !!dest && dest.items.length === 1 && (await timelineCount(f.orderId)) === 1);
    }
    {
      // Whole customer-paid COD move with a DECREASE: post-commit effects must run once despite the retry.
      const f = await seedOrder({ items: 1, payer: 'customer', sourceFee: 1_000_000, customerFee: 1_000_000, collection: null });
      const svc = new VendorOrderService();
      const boom = transientOnce();
      const original = (svc as any).timelineRepo.appendEvent.bind((svc as any).timelineRepo);
      (svc as any).timelineRepo.appendEvent = async (...args: unknown[]) => { boom(); return original(...args); };
      const before = { ...effects };
      await svc.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString());
      await new Promise((r) => setTimeout(r, 200)); // the event bus is fire-and-forget
      const proposals = await proposalsOf(f.orderId);
      await check('one proposal (approved by system — a decrease), not two', () =>
        proposals.length === 1 && proposals[0].status === 'approved' && proposals[0].origin === 'change_agency');
      await check('the customer was told once and the event published once', () =>
        effects.lowered - before.lowered === 1 && effects.created - before.created === 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('5. A WHOLE customer-paid move (D-10), batch of two items — the fee carried ONCE');
    {
      const f = await seedOrder({ items: 2, payer: 'customer', sourceFee: 1_000_000, customerFee: 1_000_000, collection: 'pending' });
      const svc = new VendorOrderService();
      const orderBefore = await orderOf(f.orderId);
      await svc.moveItemsToAgency(f.orderId, f.vendorId, f.itemIds, AGENCY_B.toString());
      const ships = await shipmentsOf(f.orderId);
      const dest = ships.find((s) => s.agency_id.toString() === AGENCY_B.toString());
      const proposals = await proposalsOf(f.orderId);
      const orderAfter = await orderOf(f.orderId);
      await check('the source is deleted; the destination carries both items', () =>
        ships.length === 1 && !!dest && dest.items.length === 2);
      await check('its COD code died with the source (cancelled)', async () => (await collectionOf(f.sourceId))?.status === 'cancelled');
      await check('the price difference was settled as ONE change_agency proposal measured from the source’s fee (not double-counted)', () =>
        proposals.length === 1 && proposals[0].origin === 'change_agency' && proposals[0].fee_before === 1_000_000);
      await check('a decrease: applied directly, the destination’s fee = the new price, the customer collects less, the order total shrank by the same', () => {
        const newFee = proposals[0].proposed_fee;
        return proposals[0].status === 'approved' && dest!.delivery_fee_snapshot === newFee && dest!.customer_delivery_fee === newFee
          && orderBefore!.total_amount - orderAfter!.total_amount === 1_000_000 - newFee && dest!.delivery_payer === 'customer';
      });
    }
    {
      // An INCREASE: the customer is asked; the destination's pointer names the proposal; the
      // carried money is unchanged until they answer.
      const f = await seedOrder({ items: 1, payer: 'customer', sourceFee: 1, customerFee: 1, collection: null });
      const svc = new VendorOrderService();
      const before = { ...effects };
      await svc.moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_C.toString());
      await new Promise((r) => setTimeout(r, 200));
      const dest = (await shipmentsOf(f.orderId))[0];
      const proposals = await proposalsOf(f.orderId);
      await check('an increase → a PENDING customer-approval proposal, pointer claimed on the destination', () =>
        proposals.length === 1 && proposals[0].status === 'pending' && proposals[0].approver === 'customer'
        && String(dest.pending_delivery_fee_proposal_id) === String(proposals[0]._id));
      await check('…the carried customer money is unchanged (1) and the interim fee is the source’s (1)', () =>
        dest.customer_delivery_fee === 1 && dest.delivery_fee_snapshot === 1);
      await check('…and the customer was asked once, after the commit', () => effects.approvalNeeded - before.approvalNeeded === 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('5b. The default-agency sweep moves a parcel WHOLE (one transaction per source), not item by item');
    {
      // Two items, customer paid 1; the new agency (C) charges 5 000 for the parcel → an INCREASE
      // the customer must answer. Item by item, the first would land as a vendor-paid 5 000 run and
      // the second would be priced against it (interim 5 001 → a silent "decrease" to 5 000).
      const f = await seedOrder({ items: 2, payer: 'customer', sourceFee: 1, customerFee: 1, collection: null });
      const r = await new VendorOrderService().reassignItemsFromDefaultAgency(f.vendorId, AGENCY_A.toString(), AGENCY_C.toString());
      const ships = await shipmentsOf(f.orderId);
      const proposals = await proposalsOf(f.orderId);
      await check('both items reassigned, nothing skipped, one parcel at the new agency', () =>
        r.reassignedCount === 2 && r.skipped.length === 0 && ships.length === 1 && ships[0].items.length === 2
        && ships[0].agency_id.toString() === AGENCY_C.toString());
      await check('ONE customer-approval proposal from the carried fee (1) to the new price — an increase, not a silent decrease', () =>
        proposals.length === 1 && proposals[0].fee_before === 1 && proposals[0].direction === 'increase'
        && proposals[0].status === 'pending' && ships[0].customer_delivery_fee === 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('6. Guards that refuse with nothing written');
    {
      const f = await seedOrder({ items: 1, payer: 'vendor', agentId: new Types.ObjectId(), collection: 'pending' });
      const before = await stateOf(f);
      const r = await refusal(new VendorOrderService().moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString()));
      await check('moving the LAST item of a shipment an agent accepted → 409 SHIPMENT_ALREADY_HAS_AGENT', () =>
        r?.code === ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT && r.statusCode === 409);
      await check('…and nothing changed', async () => (await stateOf(f)) === before);
    }
    {
      const f = await seedOrder({ items: 1, payer: 'vendor', sourceStatus: 'rejected', agentId: new Types.ObjectId(), collection: 'cancelled' });
      const r = await new VendorOrderService().moveItemsToAgency(f.orderId, f.vendorId, [f.itemIds[0]], AGENCY_B.toString());
      await check('an agency-DECLINED shipment (agent already released, COD code cancelled) still moves on', async () =>
        r.moved === 1 && (await collectionOf(f.sourceId))?.status === 'cancelled' && (await shipmentsOf(f.orderId)).length === 1);
    }
  } finally {
    for (const name of [COLLECTIONS.SHIPMENT, COLLECTIONS.ORDER, COLLECTIONS.ORDER_TIMELINE, COLLECTIONS.DELIVERY_FEE_PROPOSAL,
      COLLECTIONS.CASH_COLLECTION, COLLECTIONS.DELIVERY_AGENCY, COLLECTIONS.AGENCY_MAGAZIN, 'shipment_assignment_offers', 'shipment_assignment_sessions']) {
      await db().collection(name).drop().catch(() => undefined);
    }
    await mongoose.disconnect();
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
