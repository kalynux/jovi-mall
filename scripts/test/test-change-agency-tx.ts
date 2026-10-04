/**
 * Test: the change of agency is ONE transaction (ADR-A11 D-12, workstream W-E2). DB-free;
 * plain ts-node, hand-rolled asserts.
 *
 * `VendorOrderService.moveItemsToAgency` (the vendor's `updateDeliveryAgency` is a one-item
 * wrapper; the administrator's `move-agency` passes every item of a shipment) writes up to a
 * dozen documents in five collections. What is pinned here, and why:
 *
 *   1. The pure rules the transaction decides with — an item must still be where the pre-check
 *      saw it (the concurrency and retry guard), "whole shipment" judged over the BATCH, an
 *      accepted agent's shipment never deleted from under them, the vendor's worst case on an
 *      increase.
 *   2. `ChangeAgencyFeeService` driven against fakes: every read and write receives THE caller's
 *      session object, nothing is emitted or notified, a refusal raises no proposal, the batch
 *      interim fee is not double-counted.
 *   3. Source scans for what no DB-free behaviour can see: every awaited call inside the
 *      transaction passes `session`; every repository method the path calls actually HANDS it
 *      to Mongo (a method that accepts a session and ignores it writes outside the transaction,
 *      silently); inserts use the ARRAY form; no publish / notify / refund / ticket / nested
 *      transaction inside the callback; side effects run after the commit, once.
 *
 * NOT covered here (needs a replica set): the rollback itself and the race between two real
 * transactions — that is `npm run verify:change-agency-tx`.
 *
 * Run: npm run test:change-agency-tx
 */
import { readFileSync } from 'fs';
import path from 'path';
import { ClientSession, Types } from 'mongoose';
import {
  checkItemStillWhereSeen,
  groupMovesBySource,
  isWholeShipmentMove,
  MOVABLE_SOURCE_SHIPMENT_STATUSES,
  REASSIGNABLE_ITEM_STATUSES,
  wholeMoveBlockedByAgent,
} from '../../src/modules/orders/domain/change-agency-move.rules';
import { planWholeMove } from '../../src/modules/delivery-fee-proposals/domain/customer-fee-change.rules';
import {
  ChangeAgencyFeeService,
  increaseCoverWorstCase,
  WholeMoveContext,
} from '../../src/modules/delivery-fee-proposals/services/change-agency-fee.service';
import { ShipmentModel } from '../../src/modules/shipments/shipment.model';
import { OrderModel } from '../../src/modules/orders/order.model';
import { ERROR_CODES } from '../../src/core/error-codes';

let passed = 0;
let failed = 0;
async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);
const ROOT = path.join(__dirname, '../..');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const src = (rel: string) => stripComments(readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'));
const between = (text: string, from: string, to: string) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} … ${to}`);
  return text.slice(a, b);
};

/** The argument text of every `await <callee>(…)` in `body`, balanced on parentheses. */
function awaitedCalls(body: string): Array<{ callee: string; args: string }> {
  const out: Array<{ callee: string; args: string }> = [];
  const re = /await\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    let i = m.index + m[0].length;
    let callee = '';
    while (i < body.length && /[\w.$!]/.test(body[i])) callee += body[i++];
    if (body[i] !== '(' || !callee) continue;
    let depth = 0;
    const start = i;
    for (; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')' && --depth === 0) break;
    }
    out.push({ callee, args: body.slice(start + 1, i) });
  }
  return out;
}

/** A refusal thrown by the code under test, as `{ code, statusCode }`. */
async function refusalOf(p: Promise<unknown>): Promise<{ code: string; statusCode: number } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; statusCode?: number };
    return { code: String(e.code), statusCode: Number(e.statusCode) };
  }
}

// ─── fakes for ChangeAgencyFeeService ────────────────────────────────────────

const SESSION = { id: 'the-callers-session' } as unknown as ClientSession;
const oid = () => new Types.ObjectId();

interface World {
  order: any;
  source: any;
  destination: any | null;
  /** Every Mongo call the service made, with the options it passed. */
  calls: Array<{ op: string; opts: unknown }>;
  updates: Array<{ filter: any; update: any }>;
}

function installModelFakes(world: World): void {
  const S = ShipmentModel as any;
  const O = OrderModel as any;
  S.findOne = async (filter: any, _p: unknown, opts: unknown) => {
    world.calls.push({ op: 'Shipment.findOne', opts });
    return filter?.agency_id && world.destination && String(world.destination.agency_id) === String(filter.agency_id) ? world.destination : null;
  };
  S.findById = async (id: unknown, _p: unknown, opts: unknown) => {
    world.calls.push({ op: 'Shipment.findById', opts });
    if (world.destination && String(world.destination._id) === String(id)) return world.destination;
    if (world.source && String(world.source._id) === String(id)) return world.source;
    return null;
  };
  S.updateOne = async (filter: any, update: any, opts: unknown) => {
    world.calls.push({ op: 'Shipment.updateOne', opts });
    world.updates.push({ filter, update });
    const hit = world.destination && String(world.destination._id) === String(filter._id);
    return { matchedCount: hit ? 1 : 0, modifiedCount: hit ? 1 : 0 };
  };
  O.findById = async (_id: unknown, _p: unknown, opts: unknown) => {
    world.calls.push({ op: 'Order.findById', opts });
    return world.order;
  };
}

function makeWorld(opts: {
  payer?: 'customer' | 'vendor';
  paymentMethod?: string;
  paymentStatus?: string;
  sourceItems?: number;
  sourceFee?: number;
  customerFee?: number;
  destination?: { items: number; fee: number; customerFee: number; override?: boolean; pendingProposal?: boolean } | null;
}): World {
  const order = {
    _id: oid(),
    vendor_id: oid(),
    delivery_payer: opts.payer ?? 'customer',
    payment_method: opts.paymentMethod ?? 'cash_on_delivery',
    payment_status: opts.paymentStatus ?? 'pending',
    items: [] as any[],
  };
  const mkItems = (n: number) =>
    Array.from({ length: n }, () => {
      const id = oid();
      order.items.push({ _id: id, price: 1000, quantity: 1 });
      return { order_item_id: id, quantity: 1 };
    });
  const source = {
    _id: oid(),
    agency_id: oid(),
    status: 'assigned',
    delivery_payer: opts.payer ?? 'customer',
    items: mkItems(opts.sourceItems ?? 1),
    delivery_fee_snapshot: opts.sourceFee ?? 1000,
    customer_delivery_fee: opts.customerFee ?? 1000,
    customer_fee_refundable: 0,
  };
  const destAgency = oid();
  const destination = opts.destination
    ? {
        _id: oid(),
        agency_id: destAgency,
        status: 'pending',
        delivery_payer: opts.payer ?? 'customer',
        items: mkItems(opts.destination.items),
        delivery_fee_snapshot: opts.destination.fee,
        customer_delivery_fee: opts.destination.customerFee,
        customer_fee_refundable: 0,
        delivery_fee_override: opts.destination.override ? { amount: opts.destination.fee } : null,
        pending_delivery_fee_proposal_id: opts.destination.pendingProposal ? oid() : null,
      }
    : null;
  return { order, source, destination: destination ?? (null as any), calls: [], updates: [], ...{ destAgency } } as World & { destAgency: Types.ObjectId };
}

/** A fee-application fake: effective fee = override → snapshot; formula = 700 × items. */
function makeFeeApp(vendorNet: number, seen: { vendorNetSession?: unknown; vendorNetCalls: number }) {
  return {
    modeOf: (o: any) => (o.payment_method === 'cash_on_delivery' ? 'cod' : 'online'),
    effectiveFee: (s: any) => s.delivery_fee_override?.amount ?? s.delivery_fee_snapshot ?? 700 * s.items.length,
    formulaFee: (s: any) => 700 * s.items.length,
    vendorNetWithBorne: async (_o: unknown, _s: unknown, _b: number, _w: number, session: unknown) => {
      seen.vendorNetCalls++;
      seen.vendorNetSession = session;
      return vendorNet;
    },
  } as any;
}

function makeProposals(record: { calls: Array<{ input: any; session: unknown }>; afterCommitRuns: number }) {
  return {
    raiseSystemProposalInSession: async (input: any, session: unknown) => {
      record.calls.push({ input, session });
      return { proposal: { _id: oid() }, afterCommit: () => { record.afterCommitRuns++; } };
    },
  } as any;
}

function makeAgencies(record: { sessions: unknown[] }) {
  return {
    findById: async (_id: string, session: unknown) => {
      record.sessions.push(session);
      return { policies: null };
    },
  } as any;
}

async function main(): Promise<void> {
  // ───────────────────────────────────────────────────────────────────────────
  section('1. The pure rules the transaction decides with');
  const seenA = { itemId: 'i1', shipmentId: 's1', agencyId: 'A' };
  await assert('an item still where the pre-check saw it may move', () =>
    checkItemStillWhereSeen(seenA, { shipmentId: 's1', agencyId: 'A', status: 'assigned' }) === null);
  await assert('an item gone from the order → item_not_found', () =>
    checkItemStillWhereSeen(seenA, null)?.code === 'item_not_found');
  await assert('⭐ an item a concurrent (or this retried) move already took → moved_meanwhile, never moved twice', () =>
    checkItemStillWhereSeen(seenA, { shipmentId: 's2', agencyId: 'B', status: 'pending' })?.code === 'moved_meanwhile');
  await assert('same agency, different shipment (regrouped meanwhile) is also moved_meanwhile', () =>
    checkItemStillWhereSeen(seenA, { shipmentId: 's9', agencyId: 'A', status: 'assigned' })?.code === 'moved_meanwhile');
  await assert('picked up since the pre-check → not_reassignable', () =>
    checkItemStillWhereSeen(seenA, { shipmentId: 's1', agencyId: 'A', status: 'picked_up' })?.code === 'not_reassignable');
  await assert('the item statuses that may move are exactly pending / assigned / pending_agency_reassignment', () =>
    JSON.stringify([...REASSIGNABLE_ITEM_STATUSES].sort()) === JSON.stringify(['assigned', 'pending', 'pending_agency_reassignment']));
  await assert('the source shipment statuses that may lose items: pending / assigned / rejected / pending_agency_reassignment', () =>
    JSON.stringify([...MOVABLE_SOURCE_SHIPMENT_STATUSES].sort()) === JSON.stringify(['assigned', 'pending', 'pending_agency_reassignment', 'rejected'])
    && !MOVABLE_SOURCE_SHIPMENT_STATUSES.includes('handing_over') && !MOVABLE_SOURCE_SHIPMENT_STATUSES.includes('picked_up'));
  await assert('the batch is grouped by source shipment, in order, duplicates dropped', () => {
    const g = groupMovesBySource([
      { itemId: 'a', shipmentId: 's1', agencyId: 'A' },
      { itemId: 'b', shipmentId: 's2', agencyId: 'A' },
      { itemId: 'c', shipmentId: 's1', agencyId: 'A' },
      { itemId: 'a', shipmentId: 's1', agencyId: 'A' },
      { itemId: 'd', shipmentId: null, agencyId: null },
    ]);
    return g.length === 3 && g[0].sourceShipmentId === 's1' && g[0].itemIds.join() === 'a,c'
      && g[1].itemIds.join() === 'b' && g[2].sourceShipmentId === null && g[2].itemIds.join() === 'd';
  });
  await assert('⭐ whole = EVERY item of the source is in the batch (judged over the batch, not per item)', () =>
    isWholeShipmentMove(['a', 'b'], ['b', 'a']) && !isWholeShipmentMove(['a', 'b'], ['a'])
    && isWholeShipmentMove(['a'], ['a', 'x']) && !isWholeShipmentMove([], ['a']));
  await assert('an accepted agent blocks a WHOLE move of an `assigned` shipment', () =>
    wholeMoveBlockedByAgent({ status: 'assigned', agent_id: 'ag' }, true));
  await assert('…but not a partial move, an unbound shipment, or a REJECTED one (its agent was already released)', () =>
    !wholeMoveBlockedByAgent({ status: 'assigned', agent_id: 'ag' }, false)
    && !wholeMoveBlockedByAgent({ status: 'assigned', agent_id: null }, true)
    && !wholeMoveBlockedByAgent({ status: 'rejected', agent_id: 'ag' }, true));
  await assert('the vendor’s worst case on an increase = it bears new fee − what the customer paid', () => {
    const plan = planWholeMove({ mode: 'cod', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: null, newAgencyFee: 1500 });
    const w = increaseCoverWorstCase(plan);
    return !!w && w.borneBefore === 0 && w.borneWorst === 500;
  });
  await assert('no worst case for a decrease or no change', () =>
    increaseCoverWorstCase(planWholeMove({ mode: 'cod', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: null, newAgencyFee: 800 })) === null
    && increaseCoverWorstCase(planWholeMove({ mode: 'cod', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: null, newAgencyFee: 1000 })) === null);
  await assert('⭐ why "whole" must be judged over the batch: per item, the interim double-counts and an INCREASE reads as a decrease', () => {
    // Source S: 2 items, snapshot 1000, customer paid 1000. New agency: 700/item → 1400 for both.
    // Per-item (the old way): item 1 moves first as a PARTIAL (vendor-paid 700 on the new row),
    // then item 2 is "whole" against a destination already holding 700.
    const perItem = planWholeMove({ mode: 'cod', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: { fee: 700, customerFee: 0, refundable: 0 }, newAgencyFee: 1400 });
    const batch = planWholeMove({ mode: 'cod', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: null, newAgencyFee: 1400 });
    return perItem.interimFee === 1700 && perItem.difference.kind === 'decrease'
      && batch.interimFee === 1000 && batch.difference.kind === 'increase';
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('2. ChangeAgencyFeeService against fakes — the caller’s session everywhere, no side effects');
  const prepareWith = async (w: World & { destAgency?: Types.ObjectId }, itemIds: string[], vendorNet = 10_000) => {
    installModelFakes(w);
    const agencies = { sessions: [] as unknown[] };
    const seen = { vendorNetCalls: 0 } as { vendorNetSession?: unknown; vendorNetCalls: number };
    const record = { calls: [] as Array<{ input: any; session: unknown }>, afterCommitRuns: 0 };
    const svc = new ChangeAgencyFeeService(makeFeeApp(vendorNet, seen), makeProposals(record), makeAgencies(agencies));
    const destAgencyId = String(w.destination?.agency_id ?? w.destAgency ?? oid());
    const ctx = await svc.prepareWholeMoveInSession({ order: w.order, source: w.source, itemIds, destinationAgencyId: destAgencyId }, SESSION);
    return { svc, ctx, agencies, seen, record };
  };
  const allItems = (w: World) => w.source.items.map((i: any) => String(i.order_item_id));

  await assert('no source / vendor payer / partial batch / nothing the customer paid → null (stays vendor-paid)', async () => {
    const a = makeWorld({});
    const r1 = await (await prepareWith({ ...a, source: null } as any, [])).ctx;
    const r2 = (await prepareWith(makeWorld({ payer: 'vendor' }), allItems(makeWorld({ payer: 'vendor' })))).ctx;
    const two = makeWorld({ sourceItems: 2 });
    const r3 = (await prepareWith(two, [allItems(two)[0]])).ctx;
    const unpaid = makeWorld({ customerFee: 0 });
    const r4 = (await prepareWith(unpaid, allItems(unpaid))).ctx;
    return r1 === null && r2 === null && r3 === null && r4 === null;
  });
  await assert('a 2-item batch covering the source is WHOLE: interim = the source’s fee, priced against both items', async () => {
    const w = makeWorld({ sourceItems: 2, sourceFee: 1000, customerFee: 1000 });
    const { ctx } = await prepareWith(w, allItems(w));
    return !!ctx && ctx.plan.interimFee === 1000 && ctx.plan.carriedCustomerFee === 1000
      && ctx.plan.difference.kind === 'increase' && (ctx.plan.difference as any).newFee === 1400 && !ctx.destinationExisted;
  });
  await assert('merging into an existing destination sums both (interim = S + D) and prices the composition', async () => {
    const w = makeWorld({ sourceItems: 1, sourceFee: 1000, customerFee: 1000, destination: { items: 1, fee: 900, customerFee: 900 } });
    const { ctx } = await prepareWith(w, allItems(w));
    return !!ctx && ctx.destinationExisted && ctx.plan.interimFee === 1900 && ctx.plan.carriedCustomerFee === 1900
      && ctx.plan.difference.kind === 'decrease' && (ctx.plan.difference as any).newFee === 1400;
  });
  await assert('an agreed override on the destination keeps its price (skipDifference)', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 900, customerFee: 900, override: true } });
    const { ctx } = await prepareWith(w, allItems(w));
    return !!ctx && ctx.skipDifference && ctx.plan.difference.kind === 'none';
  });
  await assert('online + not simply paid + a difference to settle → 422 ORDER_NOT_PAID (inside the transaction)', async () => {
    const w = makeWorld({ paymentMethod: 'mobile_money', paymentStatus: 'partially_refunded' });
    const r = await refusalOf(prepareWith(w, allItems(w)));
    return r?.code === ERROR_CODES.DELIVERY_FEE_PROPOSAL_ORDER_NOT_PAID && r.statusCode === 422;
  });
  await assert('COD with a difference is not payment-gated', async () => {
    const w = makeWorld({ paymentMethod: 'cash_on_delivery', paymentStatus: 'pending' });
    return !!(await prepareWith(w, allItems(w))).ctx;
  });
  await assert('⭐ every Mongo read in prepare received THE caller’s session object; agency reads too', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 900, customerFee: 900 } });
    const { agencies } = await prepareWith(w, allItems(w));
    return w.calls.length > 0 && w.calls.every((c) => (c.opts as any)?.session === SESSION)
      && agencies.sessions.length === 2 && agencies.sessions.every((s) => s === SESSION);
  });

  const ctxOf = (w: World, plan: ReturnType<typeof planWholeMove>, skip = false): WholeMoveContext => ({
    orderId: String(w.order._id), sourceShipmentId: String(w.source._id), destinationExisted: !!w.destination, plan, skipDifference: skip,
  });
  const inc = planWholeMove({ mode: 'cod', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: null, newAgencyFee: 1400 });
  const dec = planWholeMove({ mode: 'cod', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: null, newAgencyFee: 800 });
  const none = planWholeMove({ mode: 'cod', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: null, newAgencyFee: 1000 });

  await assert('carry writes payer / customer fee / refundable / snapshot in the session — and NOT fee_components', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 0, customerFee: 0 } });
    const { svc } = await prepareWith(w, allItems(w));
    w.calls.length = 0;
    await svc.carryInSession(ctxOf(w, inc), String(w.destination._id), SESSION);
    const set = w.updates[0]?.update?.$set ?? {};
    return set.delivery_payer === 'customer' && set.customer_delivery_fee === 1000 && set.delivery_fee_snapshot === 1000
      && set.customer_fee_refundable === 0 && !('fee_components' in set) && !('delivery_fee_override.amount' in set)
      && w.calls.every((c) => (c.opts as any)?.session === SESSION);
  });
  await assert('carry follows an agreed override (its amount = interim)', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 900, customerFee: 900, override: true } });
    const { svc } = await prepareWith(w, allItems(w));
    await svc.carryInSession(ctxOf(w, inc), String(w.destination._id), SESSION);
    return w.updates[0]?.update?.$set?.['delivery_fee_override.amount'] === 1000;
  });
  await assert('carry onto a vanished destination throws (rolling the move back), never a silent no-op', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 0, customerFee: 0 } });
    const { svc } = await prepareWith(w, allItems(w));
    const r = await refusalOf(svc.carryInSession(ctxOf(w, inc), String(oid()), SESSION));
    return r?.code === ERROR_CODES.SHIPMENT_NOT_FOUND;
  });
  await assert('no difference / an agreed override → no proposal, no reads', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 0, customerFee: 0 } });
    const { svc, record } = await prepareWith(w, allItems(w));
    w.calls.length = 0;
    await svc.raiseDifferenceInSession(ctxOf(w, none), String(w.destination._id), SESSION);
    await svc.raiseDifferenceInSession(ctxOf(w, inc, true), String(w.destination._id), SESSION);
    return record.calls.length === 0 && w.calls.length === 0;
  });
  await assert('a destination already carrying a pending proposal → none raised beside it', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 0, customerFee: 0, pendingProposal: true } });
    const { svc, record } = await prepareWith(w, allItems(w));
    await svc.raiseDifferenceInSession(ctxOf(w, inc), String(w.destination._id), SESSION);
    return record.calls.length === 0;
  });
  await assert('⭐ an increase the vendor could not cover → 422 VENDOR_NET_NOT_POSITIVE and NO proposal raised', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 0, customerFee: 0 } });
    const { svc, record, seen } = await prepareWith(w, allItems(w), 0);
    const r = await refusalOf(svc.raiseDifferenceInSession(ctxOf(w, inc), String(w.destination._id), SESSION));
    return r?.code === ERROR_CODES.DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE && r.statusCode === 422
      && record.calls.length === 0 && seen.vendorNetCalls === 1 && seen.vendorNetSession === SESSION;
  });
  await assert('an increase the vendor can cover → raised IN the session (origin change_agency, the new fee); its afterCommit is returned, NOT run', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 0, customerFee: 0 } });
    const { svc, record } = await prepareWith(w, allItems(w), 5000);
    const effect = await svc.raiseDifferenceInSession(ctxOf(w, inc), String(w.destination._id), SESSION);
    const call = record.calls[0];
    const before = record.afterCommitRuns;
    effect();
    return record.calls.length === 1 && call.session === SESSION && call.input.origin === 'change_agency'
      && call.input.proposedFee === 1400 && before === 0 && record.afterCommitRuns === 1;
  });
  await assert('a decrease needs no vendor check and is raised in the session', async () => {
    const w = makeWorld({ destination: { items: 1, fee: 0, customerFee: 0 } });
    const { svc, record, seen } = await prepareWith(w, allItems(w), 0);
    await svc.raiseDifferenceInSession(ctxOf(w, dec), String(w.destination._id), SESSION);
    return record.calls.length === 1 && record.calls[0].input.proposedFee === 800 && seen.vendorNetCalls === 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('3. Source scans — the transaction boundary');
  const vos = src('src/modules/orders/vendor-order.service.ts');
  const wrapper = between(vos, 'async updateDeliveryAgency(', 'async moveItemsToAgency(');
  const moveFn = between(vos, 'async moveItemsToAgency(', 'private async moveGroupInSession(');
  const groupFn = between(vos, 'private async moveGroupInSession(', 'async reassignItemsFromDefaultAgency(');
  const callback = between(moveFn, 'runInTransactionWithRetry(async (session) => {', 'return { afterCommit, destination };');
  const caf = src('src/modules/delivery-fee-proposals/services/change-agency-fee.service.ts');
  const cafClass = between(caf, 'export class ChangeAgencyFeeService', 'export const changeAgencyFeeService');

  await assert('updateDeliveryAgency is a thin wrapper over moveItemsToAgency (one item)', () =>
    wrapper.includes('this.moveItemsToAgency(orderId, vendorId, [itemId], deliveryAgencyId, opts)'));
  await assert('the change opens exactly ONE transaction, with retry (runInTransactionWithRetry), and no other', () =>
    (moveFn.match(/runInTransaction/g) ?? []).length === 1 && moveFn.includes('transactionManager.runInTransactionWithRetry(')
    && !groupFn.includes('runInTransaction') && !cafClass.includes('transactionManager'));
  await assert('every source group moves inside that one callback', () => callback.includes('this.moveGroupInSession('));
  for (const [label, body] of [
    ['the transaction callback', callback],
    ['moveGroupInSession', groupFn],
    ['ChangeAgencyFeeService', cafClass],
  ] as const) {
    const calls = awaitedCalls(body);
    const missing = calls.filter((c) => !/\bsession\b/.test(c.args)).map((c) => c.callee);
    await assert(`⭐ every awaited call in ${label} passes the session (${calls.length} calls)${missing.length ? ' — MISSING: ' + missing.join(', ') : ''}`, () =>
      calls.length > 0 && missing.length === 0);
  }
  await assert('the expected writes are all present in moveGroupInSession', () =>
    [
      'this.shipmentRepo.addItem(', 'this.shipmentRepo.create(', 'this.shipmentRepo.removeItem(',
      "deliveryFeeProposalService.withdrawPendingInSession(source, 'shipment_moved', session)",
      'shipmentAssignmentOfferRepository.cancelPendingForShipment(sourceShipmentId, session)',
      'shipmentAssignmentSessionRepository.deleteForShipment(sourceShipmentId, session)',
      'changeAgencyFeeService.carryInSession(', 'cashCollectionService.followItemMoveInSession(',
      'changeAgencyFeeService.raiseDifferenceInSession(', 'this.vendorOrderRepo.reassignItemDeliveryAgency(', 'this.timelineRepo.appendEvent(',
    ].every((n) => groupFn.includes(n)));
  await assert('the forced-COD stamp is written IN the transaction', () =>
    callback.includes('codLimitsService.markForced(') && /markForced\([\s\S]*?\}, session\)/.test(callback));
  await assert('order: re-validate → agent guard → prepare → move → detach → carry → COD → difference → repoint', () => {
    const steps = [
      'checkItemStillWhereSeen(', 'wholeMoveBlockedByAgent(', 'prepareWholeMoveInSession(', 'findGroupableByOrderAndAgency(',
      'this.shipmentRepo.removeItem(', 'carryInSession(', 'followItemMoveInSession(', 'raiseDifferenceInSession(', 'reassignItemDeliveryAgency(',
    ].map((n) => groupFn.indexOf(n));
    return steps.every((i, k) => i > 0 && (k === 0 || i > steps[k - 1]));
  });
  await assert('⭐ the repoint is a compare-and-set on the shipment the item is leaving', () =>
    /reassignItemDeliveryAgency\([\s\S]*?session,\s*sourceShipmentId\s*\)/.test(groupFn));
  await assert('⭐ no publish / notify / refund / ticket inside the callback, the group step or the fee service', () =>
    [callback, groupFn, cafClass].every((b) =>
      !b.includes('eventBus') && !b.includes('customerFeeNotifier') && !b.includes('refundOutstanding')
      && !b.includes('refundPayment') && !/ticket/i.test(b) && !b.includes('effect()')));
  await assert('the collected side effects run AFTER the commit, once, each isolated', () =>
    moveFn.indexOf('for (const effect of outcome.afterCommit)') > moveFn.indexOf('return { afterCommit, destination };')
    && moveFn.indexOf("eventBus.publish('shipment.cod_limit_forced'") > moveFn.indexOf('return { afterCommit, destination };')
    && callback.includes('const afterCommit: Array<() => void> = [];'));
  await assert('⛔ the ticket fallback is GONE (no completeWholeMove, no ticket service, no swallowed catch in the fee service)', () =>
    !caf.includes('completeWholeMove') && !vos.includes('completeWholeMove(') && !caf.includes('ticketService')
    && !caf.includes('createSystemTicket') && !cafClass.includes('catch ('));
  await assert('the change of agency writes NO tracking outbox row — and so may not delete a shipment an agent holds (guarded first)', () =>
    !groupFn.includes('trackingOutboxEmitter') && groupFn.indexOf('wholeMoveBlockedByAgent(') < groupFn.indexOf('this.shipmentRepo.removeItem('));
  await assert('the order and the source are re-read IN the session (never the pre-check snapshot)', () =>
    groupFn.includes('OrderModel.findOne({ _id: orderId, vendor_id: vendorId }, null, { session })')
    && groupFn.includes('ShipmentModel.findById(sourceShipmentId, null, { session })'));
  await assert('the vendor-cover check runs on the post-move state, inside the session, before the proposal', () => {
    const fn = between(cafClass, 'async raiseDifferenceInSession(', 'raiseSystemProposalInSession(');
    return fn.includes('vendorNetWithBorne(order, destination, worst.borneBefore, worst.borneWorst, session)')
      && fn.includes('DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE');
  });
  await assert('the two auto-reassign sweeps move per SOURCE parcel in one call (never item by item — that mis-prices a whole customer-paid move)', () => {
    const sweeps = between(vos, 'async reassignItemsFromDefaultAgency(', 'async getOrderEntitlements(');
    const step = between(sweeps, 'private async moveEligibleBySource(', '\n    }\n');
    return !sweeps.includes('this.updateDeliveryAgency(') && (sweeps.match(/this\.moveEligibleBySource\(/g) ?? []).length === 2
      && step.includes('this.moveItemsToAgency(orderId, vendorId, itemIds, toAgencyId)') && step.includes('item.delivery?.shipment_id');
  });
  await assert('the administrator’s whole-shipment move is ONE call (one transaction for every item)', () => {
    const adm = src('src/modules/shipments/admin-shipment-agency.service.ts');
    return adm.includes('this.vendorOrders.moveItemsToAgency(orderId, vendorId, itemIds, input.agencyId, {')
      && !adm.includes('this.vendorOrders.updateDeliveryAgency(');
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('4. Source scans — every repository method on the path HANDS the session to Mongo');
  const repo = src('src/modules/shipments/shipment.repository.ts');
  const fnOf = (text: string, sig: string) => {
    const a = text.indexOf(sig);
    if (a < 0) throw new Error(`not found: ${sig}`);
    const rest = text.slice(a + sig.length);
    const next = rest.search(/\n\s+(?:async|private|public|static)\s/);
    return text.slice(a, next < 0 ? undefined : a + sig.length + next);
  };
  await assert('ShipmentRepository.findGroupableByOrderAndAgency → findOne(…, { session })', () =>
    fnOf(repo, 'async findGroupableByOrderAndAgency(').includes('{ session: session ?? undefined }'));
  await assert('ShipmentRepository.addItem → findByIdAndUpdate(…, { session })', () =>
    fnOf(repo, 'async addItem(').includes('{ new: true, session: session ?? undefined }'));
  await assert('ShipmentRepository.removeItem → the $pull AND the delete both join the session', () => {
    const f = fnOf(repo, 'async removeItem(');
    return f.includes('{ new: true, session: session ?? undefined }') && f.includes('ShipmentModel.deleteOne({ _id: shipmentId }, { session: session ?? undefined })');
  });
  await assert('ShipmentRepository.create → ARRAY form under a session; the tracking-number probe reads in it', () => {
    const f = fnOf(repo, 'async create(');
    return f.includes('ShipmentModel.create([payload], { session })') && f.includes('TrackingNumberGenerator.generate(data.agency_id!.toString(), session)');
  });
  await assert('VendorOrderRepository.reassignItemDeliveryAgency → session + the optional $elemMatch CAS', () => {
    const f = fnOf(src('src/modules/orders/vendor-order.repository.ts'), 'async reassignItemDeliveryAgency(');
    return f.includes('{ new: true, session: session ?? undefined }') && f.includes('$elemMatch') && f.includes("'delivery.shipment_id'")
      && f.includes('expectedShipmentId === undefined');
  });
  await assert('OrderTimelineRepository.appendEvent → ARRAY form under a session (else Mongoose ignores it)', () =>
    /OrderTimelineModel\.create\(\[doc\], \{ session \}\)/.test(src('src/modules/orders/order-timeline.repository.ts')));
  await assert('CodLimitsService.markForced → updateOne(…, { session })', () =>
    fnOf(src('src/modules/cod/services/cod-limits.service.ts'), 'async markForced(').includes('{ session: session ?? undefined }'));
  await assert('the assignment offer cancel and the ranking delete both join the session', () =>
    fnOf(src('src/modules/shipment-assignment/repositories/shipment-assignment-offer.repository.ts'), 'async cancelPendingForShipment(').includes('{ session: session ?? undefined }')
    && fnOf(src('src/modules/shipment-assignment/repositories/shipment-assignment-session.repository.ts'), 'async deleteForShipment(').includes('{ session: session ?? undefined }'));
  await assert('the COD follow: read, cancel and re-price all in the session; a cancelled collection is history, not a refusal', () => {
    const cc = src('src/modules/cod/services/cash-collection.service.ts');
    const fn = between(cc, 'async followItemMoveInSession(', 'computeExpectedAmount(');
    const ccRepo = src('src/modules/cod/repositories/cash-collection.repository.ts');
    return fn.includes('findByShipmentId(shipmentId, session)') && fn.includes('cancelPendingByShipment(shipmentId, session)')
      && fn.includes("{ _id: collection._id, status: 'pending', expected_amount: collection.expected_amount }")
      && /updateOne\([\s\S]*?\{ session \}\s*\)/.test(fn)
      && fn.includes("collection.status === 'cancelled') return 'none'")
      && fnOf(ccRepo, 'async findByShipmentId(').includes('query.session(session)')
      && fnOf(ccRepo, 'async cancelPendingByShipment(').includes('...sessionOpt');
  });
  const pss = src('src/modules/delivery-fee-proposals/services/delivery-fee-proposal.service.ts');
  const prepo = src('src/modules/delivery-fee-proposals/repositories/delivery-fee-proposal.repository.ts');
  await assert('withdrawPendingInSession → transition + pointer release in the session', () => {
    const f = between(pss, 'async withdrawPendingInSession(', 'private async createCustomerPaidProposal(');
    return /transitionFromPending\([\s\S]*?session\s*\)/.test(f) && f.includes('releasePendingPointer(shipment._id as Types.ObjectId, pendingId, session)');
  });
  await assert('the proposal repository: insert is the ARRAY form; claim / transition / release / fresh read take the session', () =>
    prepo.includes('DeliveryFeeProposalModel.create([doc], { session })')
    && fnOf(prepo, 'async claimPendingPointer(').includes('{ new: true, session }')
    && fnOf(prepo, 'async transitionFromPending(').includes('{ new: true, session }')
    && fnOf(prepo, 'async releasePendingPointer(').includes('{ session }')
    && fnOf(prepo, 'async findShipmentInSession(').includes('{ session }'));
  await assert('createCustomerPaidProposalInSession opens no transaction and emits / notifies / refunds only inside afterCommit', () => {
    const inSession = between(pss, 'private async createCustomerPaidProposalInSession(', 'private async applyVendorCover(');
    const firstAfter = inSession.indexOf('afterCommit: () => {');
    return !inSession.includes('transactionManager') && firstAfter > 0
      && [inSession.indexOf('this.emit('), inSession.indexOf('customerFeeNotifier.'), inSession.indexOf('deliveryFeeRefundService.refundOutstanding(')]
        .every((i) => i > firstAfter);
  });
  await assert('every awaited call in createCustomerPaidProposalInSession and raiseSystemProposalInSession passes the session (or is a config read)', () => {
    const bodies = [
      between(pss, 'async raiseSystemProposalInSession(', 'async withdraw(actor'),
      between(pss, 'private async createCustomerPaidProposalInSession(', 'private async applyVendorCover('),
    ];
    // Reads of configuration nobody in this transaction writes are allowed outside it.
    const allowed = new Set(['this.agencies.findById', 'this.effectiveFee', 'this.proposals.countCountedForShipment']);
    return bodies.every((b) => awaitedCalls(b).every((c) => allowed.has(c.callee) || /\bsession\b/.test(c.args)));
  });
  await assert('raiseSystemProposal (combined requests) = its own transaction + afterCommit, over the same in-session path', () => {
    const fn = between(pss, 'async raiseSystemProposal(', 'async raiseSystemProposalInSession(');
    return fn.includes('runInTransactionWithRetry((session) => this.raiseSystemProposalInSession(input, session))') && fn.includes('raised.afterCommit();');
  });
  await assert('applyInSession: every write (shipment CAS, COD collection, order totals, allocation, account + ledger) joins the session', () => {
    const fa = src('src/modules/delivery-fee-proposals/services/customer-fee-application.service.ts');
    const f = between(fa, 'async applyInSession(', 'payerOf(order: IOrder');
    return awaitedCalls(f).every((c) => /\bsession\b/.test(c.args));
  });
  await assert('EarningsAllocationRepository.existsForSource takes an optional session (read in the decrease path)', () =>
    fnOf(src('src/modules/earnings/repositories/earnings-allocation.repository.ts'), 'async existsForSource(').includes('if (session) query.session(session)'));
  await assert('the ledger row of a held-amount adjustment is the ARRAY form', () =>
    /EarningsLedgerModel\.create\(\s*\[/.test(src('src/modules/earnings/repositories/earnings-ledger.repository.ts')));

  // ───────────────────────────────────────────────────────────────────────────
  section('5. The retry primitive — runInTransactionWithRetry');
  const tm = src('src/core/database/transaction.manager.ts');
  const retry = between(tm, 'async runInTransactionWithRetry<T>(', 'export const transactionManager');
  await assert('it delegates to the driver’s withTransaction (retries a TransientTransactionError, retries an unknown commit result)', () =>
    retry.includes('session.withTransaction(async () => fn(session))'));
  await assert('it never aborts after a commit by hand (the masked-commit-error bug cannot recur here)', () =>
    !retry.includes('abortTransaction') && !retry.includes('commitTransaction') && retry.includes('session.endSession()'));

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
