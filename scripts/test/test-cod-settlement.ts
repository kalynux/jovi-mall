/**
 * Test: the COD coverage queue (REFUND-FLOW-PLAN R-6, § 5, § 11.4 — 2026-10-05).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: the FIFO is pure (`cod/domain/cod-fifo.ts`), the settlement service is driven
 * through a stubbed model read, and the wiring no behavioural test can reach is pinned by
 * source scans.
 *
 *   1. `deliveredAtOf` — the agent's `agent_delivered` mark, read from status_history.
 *   2. Ordering — oldest DELIVERY first, whatever `collected_at` says.
 *   3. The `_id` tie-break — same data, same outcome.
 *   4. Half-cover carry-forward — at most one partial, met first by the next deposit.
 *   5. Fee-only collections are in the queue like any other.
 *   6. The service — the sort it asks Mongo for, what it writes, what it returns.
 *   7. `cod.collections.settled` — payload shape; nothing published when nothing settled.
 *   8. Coverage projection (§ 11.2).
 *   9. SOURCE SCANS — event after commit from BOTH confirm paths; delivered_at stamped on
 *      BOTH collect paths; index, migration and registry wiring.
 *
 * Run: npm run test:cod-settlement
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Types } from 'mongoose';
import {
  FIFO_SORT,
  FifoRow,
  compareFifo,
  deliveredAtOf,
  planFifoSettlement,
} from '../../src/modules/cod/domain/cod-fifo';
import {
  COD_COLLECTIONS_SETTLED_EVENT,
  coverageOf,
  isCovered,
} from '../../src/modules/cod/domain/cod-coverage';
import { CodSettlementService } from '../../src/modules/cod/services/cod-settlement.service';
import { CashCollectionModel } from '../../src/modules/cod/models/cash-collection.model';
import { codCoverageService } from '../../src/modules/cod/services/cod-coverage.service';
import { eventBus, DomainEvent } from '../../src/core/events/event-bus';
import { MIGRATIONS } from '../migrate';

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
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const section = (title: string): void => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}\n`);

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const readRoot = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The index just past the `)` matching the `(` that ends `opener` at/after `from`. */
function closeOfCall(src: string, opener: string, from = 0): number {
  const start = src.indexOf(opener, from);
  if (start < 0) return -1;
  let i = start + opener.length - 1; // at the '('
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** A method's body: from its signature to the next method signature at class level. */
function methodSlice(src: string, signature: string, nextSignature: string): string {
  const start = src.indexOf(signature);
  const end = src.indexOf(nextSignature, start + signature.length);
  return start < 0 ? '' : src.slice(start, end < 0 ? undefined : end);
}

const D = (iso: string): Date => new Date(iso);
const oid = (n: number): string => n.toString(16).padStart(24, '0');
const row = (id: number, deliveredAt: string | null, expectedAmount: number, settledAmount = 0): FifoRow =>
  ({ id: oid(id), deliveredAt: deliveredAt ? D(deliveredAt) : null, expectedAmount, settledAmount });
const h = (status: string, at: string) => ({ status, changed_at: D(at) });

async function main(): Promise<void> {
  // ═══ 1 ═══════════════════════════════════════════════════════════════════
  section('1 · deliveredAtOf — when the agent marked the parcel delivered');

  const collectedAt = D('2026-10-08T10:00:00Z');

  await assert('agent_delivered → delivered: the agent_delivered mark, not the confirmation', () =>
    deliveredAtOf(
      [h('assigned', '2026-10-01T08:00:00Z'), h('picked_up', '2026-10-01T09:00:00Z'), h('in_transit', '2026-10-01T09:30:00Z'),
        h('agent_delivered', '2026-10-01T11:00:00Z'), h('delivered', '2026-10-08T10:00:00Z')],
      collectedAt
    )?.toISOString() === '2026-10-01T11:00:00.000Z');

  await assert('read BEFORE the delivered write (history ends at agent_delivered): that mark', () =>
    deliveredAtOf([h('in_transit', '2026-10-01T09:30:00Z'), h('agent_delivered', '2026-10-01T11:00:00Z')], collectedAt)
      ?.toISOString() === '2026-10-01T11:00:00.000Z');

  await assert('a code submitted from in_transit (no agent_delivered): collected_at — the code WAS the delivery', () =>
    deliveredAtOf([h('picked_up', '2026-10-01T09:00:00Z'), h('in_transit', '2026-10-01T09:30:00Z'), h('delivered', '2026-10-01T12:00:00Z')], collectedAt)
      === collectedAt);

  await assert('a failed first attempt is NOT the delivery: agent_delivered → failed → in_transit → delivered uses collected_at', () =>
    deliveredAtOf(
      [h('agent_delivered', '2026-10-01T11:00:00Z'), h('failed', '2026-10-01T12:00:00Z'), h('in_transit', '2026-10-02T09:00:00Z'), h('delivered', '2026-10-02T10:00:00Z')],
      collectedAt
    ) === collectedAt);

  await assert('…and with a second mark, the SECOND agent_delivered (the one right before the delivery)', () =>
    deliveredAtOf(
      [h('agent_delivered', '2026-10-01T11:00:00Z'), h('failed', '2026-10-01T12:00:00Z'), h('in_transit', '2026-10-02T09:00:00Z'),
        h('agent_delivered', '2026-10-02T10:00:00Z'), h('delivered', '2026-10-09T10:00:00Z')],
      collectedAt
    )?.toISOString() === '2026-10-02T10:00:00.000Z');

  await assert('empty / missing history → the fallback; a string changed_at is accepted (raw-driver rows)', () =>
    deliveredAtOf([], collectedAt) === collectedAt && deliveredAtOf(undefined, null) === null
    && deliveredAtOf([{ status: 'agent_delivered', changed_at: '2026-10-01T11:00:00Z' }, { status: 'delivered', changed_at: '2026-10-02T11:00:00Z' }], null)
      ?.toISOString() === '2026-10-01T11:00:00.000Z');

  await assert('an agent_delivered entry with no usable date → the fallback, never Invalid Date', () =>
    deliveredAtOf([{ status: 'agent_delivered', changed_at: 'not a date' }], collectedAt) === collectedAt
    && deliveredAtOf([{ status: 'agent_delivered', changed_at: null }], collectedAt) === collectedAt);

  // ═══ 2 ═══════════════════════════════════════════════════════════════════
  section('2 · Ordering — oldest DELIVERY first (R-6)');

  await assert('FIFO_SORT is exactly { delivered_at: 1, _id: 1 }, in that key order', () =>
    JSON.stringify(FIFO_SORT) === JSON.stringify({ delivered_at: 1, _id: 1 }));

  {
    // A: delivered day 1, auto-collected day 8 (_id minted early — irrelevant).
    // B: delivered + coded day 3.  C: delivered + coded day 5.
    // Old order (collected_at) was B, C, A. The deposit of 10 000 covers one of them.
    const rows = [row(3, '2026-10-05T00:00:00Z', 10_000), row(1, '2026-10-01T00:00:00Z', 10_000), row(2, '2026-10-03T00:00:00Z', 10_000)];
    const plan = planFifoSettlement(rows, 10_000);
    await assert('the auto-collected delivery of day 1 is covered before the coded ones of days 3 and 5', () =>
      plan.steps.length === 1 && plan.steps[0].id === oid(1) && plan.steps[0].fullySettled && plan.applied === 10_000);
    const all = planFifoSettlement(rows, 30_000);
    await assert('with enough cash, coverage proceeds day 1 → day 3 → day 5 whatever order the rows arrive in', () =>
      all.steps.map((s) => s.id).join(',') === [oid(1), oid(2), oid(3)].join(','));
  }

  await assert('a row the backfill has not reached (delivered_at null) sorts FIRST, as Mongo sorts null lowest', () =>
    [row(9, '2026-10-01T00:00:00Z', 1), row(8, null, 1)].sort(compareFifo)[0].id === oid(8));

  // ═══ 3 ═══════════════════════════════════════════════════════════════════
  section('3 · The _id tie-break');

  {
    const same = '2026-10-02T12:00:00Z';
    const forward = planFifoSettlement([row(5, same, 1_000), row(4, same, 1_000), row(6, same, 1_000)], 1_500);
    const reversed = planFifoSettlement([row(6, same, 1_000), row(4, same, 1_000), row(5, same, 1_000)], 1_500);
    await assert('equal delivery instants: the lower _id is covered first', () =>
      forward.steps[0].id === oid(4) && forward.steps[0].fullySettled && forward.steps[1].id === oid(5) && !forward.steps[1].fullySettled);
    await assert('…and the outcome does not depend on the order the rows arrived in', () =>
      JSON.stringify(forward) === JSON.stringify(reversed));
    await assert('ObjectId hex order is creation order (the tie-break agrees with Mongo’s _id sort)', () => {
      const a = new Types.ObjectId('650000000000000000000001').toString();
      const b = new Types.ObjectId('650000000000000000000002').toString();
      return compareFifo({ id: a, deliveredAt: null, expectedAmount: 0, settledAmount: 0 }, { id: b, deliveredAt: null, expectedAmount: 0, settledAmount: 0 }) < 0;
    });
  }

  // ═══ 4 ═══════════════════════════════════════════════════════════════════
  section('4 · Half-cover carry-forward');

  {
    const queue = [row(1, '2026-10-01T00:00:00Z', 10_000), row(2, '2026-10-02T00:00:00Z', 8_000), row(3, '2026-10-03T00:00:00Z', 5_000)];
    const first = planFifoSettlement(queue, 14_000);
    await assert('14 000 over 10 000 / 8 000 / 5 000: the first covered, the second half-covered (4 000), the third untouched', () =>
      first.steps.length === 2
      && first.steps[0].id === oid(1) && first.steps[0].fullySettled && first.steps[0].applied === 10_000
      && first.steps[1].id === oid(2) && !first.steps[1].fullySettled && first.steps[1].settledAmount === 4_000
      && first.applied === 14_000);
    await assert('at most ONE collection is left partly covered', () =>
      first.steps.filter((s) => !s.fullySettled).length <= 1);

    // Apply the first deposit's result, then a second deposit.
    const after = queue.map((r) => {
      const step = first.steps.find((s) => s.id === r.id);
      return step ? { ...r, settledAmount: step.settledAmount } : r;
    });
    const second = planFifoSettlement(after, 6_000);
    await assert('the next deposit meets the half-covered one FIRST, finishing it with its remainder (4 000), then moves on', () =>
      second.steps[0].id === oid(2) && second.steps[0].applied === 4_000 && second.steps[0].fullySettled
      && second.steps[1].id === oid(3) && second.steps[1].applied === 2_000 && !second.steps[1].fullySettled);
    await assert('a covered row is skipped, never over-settled', () =>
      second.steps.every((s) => s.id !== oid(1)));
    await assert('cash beyond the queue is not applied (applied = what the queue could take)', () => {
      const p = planFifoSettlement([row(1, '2026-10-01T00:00:00Z', 1_000, 400)], 5_000);
      return p.applied === 600 && p.steps[0].settledAmount === 1_000 && p.steps[0].fullySettled;
    });
    await assert('zero or negative cash applies nothing', () =>
      planFifoSettlement(queue, 0).steps.length === 0 && planFifoSettlement(queue, -5).applied === 0);
  }

  // ═══ 5 ═══════════════════════════════════════════════════════════════════
  section('5 · Fee-only collections are in the queue');

  {
    // A fee-only collection (W-F) is just another row — the FIFO has no notion of kind.
    const plan = planFifoSettlement([row(1, '2026-10-01T00:00:00Z', 1_500), row(2, '2026-10-02T00:00:00Z', 20_000)], 1_500);
    await assert('a 1 500 fee-only collection delivered first is covered first, like any other', () =>
      plan.steps.length === 1 && plan.steps[0].id === oid(1) && plan.steps[0].fullySettled);
    await assert('the FIFO row carries no kind (the queue cannot tell cash apart, by design)', () =>
      !/\bkind\b/.test(stripComments(read('modules/cod/domain/cod-fifo.ts'))));
    await assert('the settlement service neither filters nor reads the kind (test:cash-delivery-fee pins the same)', () =>
      !/kind/.test(stripComments(read('modules/cod/services/cod-settlement.service.ts'))));
  }

  // ═══ 6 ═══════════════════════════════════════════════════════════════════
  section('6 · CodSettlementService.applyFifoInSession (stubbed read)');

  {
    const orderA = new Types.ObjectId();
    const orderB = new Types.ObjectId();
    const mk = (n: number, orderId: Types.ObjectId, deliveredAt: string, expected: number, extra: Record<string, unknown> = {}) => {
      const doc: any = {
        _id: new Types.ObjectId(oid(n)),
        order_id: orderId,
        delivered_at: D(deliveredAt),
        collected_at: D('2026-10-09T00:00:00Z'),
        expected_amount: expected,
        settled_amount: 0,
        settled_at: null,
        saved: 0,
        ...extra,
      };
      doc.save = async () => { doc.saved++; };
      return doc;
    };
    const docs = [
      mk(3, orderB, '2026-10-03T00:00:00Z', 5_000),
      mk(1, orderA, '2026-10-01T00:00:00Z', 4_000),
      mk(2, orderA, '2026-10-02T00:00:00Z', 1_000, { kind: 'delivery_fee' }),
    ];
    let askedSort: unknown = null;
    let askedFilter: any = null;
    const originalFind = CashCollectionModel.find;
    (CashCollectionModel as any).find = (filter: unknown) => {
      askedFilter = filter;
      return { sort: (s: unknown) => { askedSort = s; return { session: async () => docs }; } };
    };
    const unlocked: string[] = [];
    const svc = new CodSettlementService({
      markCashSettledBySource: async (type: string, id: string) => { if (type === 'cod_collection') unlocked.push(id); },
    } as never);
    let result: Awaited<ReturnType<CodSettlementService['applyFifoInSession']>>;
    try {
      result = await svc.applyFifoInSession(oid(77), 7_000, {} as never);
    } finally {
      (CashCollectionModel as any).find = originalFind;
    }

    await assert('it asks Mongo for FIFO_SORT, over collected, not-yet-covered rows of the agency', () =>
      askedSort === FIFO_SORT && askedFilter.status === 'collected' && askedFilter.agency_id === oid(77)
      && JSON.stringify(askedFilter.$expr) === JSON.stringify({ $lt: ['$settled_amount', '$expected_amount'] }));
    await assert('7 000: day-1 (4 000) and the day-2 FEE-ONLY row (1 000) covered, day-3 half-covered (2 000)', () =>
      docs[1].settled_amount === 4_000 && docs[1].settled_at instanceof Date
      && docs[2].settled_amount === 1_000 && docs[2].settled_at instanceof Date
      && docs[0].settled_amount === 2_000 && docs[0].settled_at === null);
    await assert('every touched row is saved once; the covered ones unlock their earnings rows', () =>
      docs.every((d) => d.saved === 1) && unlocked.join(',') === [oid(1), oid(2)].join(','));
    await assert('the result: applied, the settled ids in FIFO order, their orders DE-DUPLICATED, one settledAt', () =>
      result!.applied === 7_000
      && result!.settledCollectionIds.join(',') === [oid(1), oid(2)].join(',')
      && result!.settledOrderIds.join(',') === orderA.toString()
      && result!.settledAt.getTime() === docs[1].settled_at.getTime());
  }

  // ═══ 7 ═══════════════════════════════════════════════════════════════════
  section('7 · cod.collections.settled (§ 11.4)');

  {
    const seen: DomainEvent[] = [];
    eventBus.subscribe(COD_COLLECTIONS_SETTLED_EVENT, (e) => { seen.push(e); }, 'test:cod-settlement');
    const svc = new CodSettlementService({} as never);
    const settledAt = D('2026-10-05T09:00:00Z');

    svc.publishCollectionsSettled({ settledCollectionIds: [], settledOrderIds: [], settledAt }, 'rem-0');
    svc.publishCollectionsSettled(null, 'dep-0');
    svc.publishCollectionsSettled({ settledCollectionIds: ['c1', 'c2'], settledOrderIds: ['o1'], settledAt }, 'rem-1');
    await new Promise((r) => setImmediate(r));

    await assert('the event name is exactly cod.collections.settled', () =>
      COD_COLLECTIONS_SETTLED_EVENT === 'cod.collections.settled');
    await assert('nothing is published when nothing became FULLY settled (a half-cover covers no shipment — R-5)', () =>
      seen.length === 1);
    await assert('payload is exactly { collectionIds, orderIds, settledAt } with settledAt an ISO string', () => {
      const e = seen[0];
      return !!e && e.eventType === 'cod.collections.settled' && e.aggregateId === 'rem-1'
        && JSON.stringify(Object.keys(e.payload).sort()) === '["collectionIds","orderIds","settledAt"]'
        && e.payload.collectionIds.join(',') === 'c1,c2' && e.payload.orderIds.join(',') === 'o1'
        && e.payload.settledAt === '2026-10-05T09:00:00.000Z';
    });
  }

  // ═══ 8 ═══════════════════════════════════════════════════════════════════
  section('8 · Coverage projection (§ 11.2)');

  {
    const base = { _id: new Types.ObjectId(oid(1)), shipment_id: new Types.ObjectId(oid(2)), expected_amount: 9_000 };
    const legacy = coverageOf({ ...base, status: 'collected' });
    await assert('a pre-W-F row (no kind, no settled_amount) reads as order cash, settled 0, not covered', () =>
      legacy.kind === 'order' && legacy.settled === 0 && legacy.settledAt === null && !isCovered(legacy)
      && legacy.collectionId === oid(1) && legacy.shipmentId === oid(2) && legacy.expected === 9_000);
    const at = D('2026-10-05T00:00:00Z');
    const fee = coverageOf({ ...base, kind: 'delivery_fee', settled_amount: 9_000, settled_at: at, status: 'collected' });
    await assert('a covered fee-only row: kind delivery_fee, settled = expected, settledAt set, covered', () =>
      fee.kind === 'delivery_fee' && fee.settled === 9_000 && fee.settledAt === at && isCovered(fee));
    await assert('the projection has exactly the § 11.2 fields', () =>
      JSON.stringify(Object.keys(fee).sort())
        === '["collectionId","expected","kind","settled","settledAt","shipmentId","status"]');
    await assert('a malformed order id is an empty list, without touching the database', async () =>
      (await codCoverageService.coverageForOrder('not-an-id')).length === 0);
  }

  // ═══ 9 ═══════════════════════════════════════════════════════════════════
  section('9 · Source scans');

  const remit = stripComments(read('modules/cod/services/agency-remittance.service.ts'));
  const deposit = stripComments(read('modules/cod/services/agent-deposit.service.ts'));
  const settle = stripComments(read('modules/cod/services/cod-settlement.service.ts'));
  const collect = stripComments(read('modules/cod/services/cash-collection.service.ts'));

  {
    const confirm = methodSlice(remit, 'async confirm(', 'async reject(');
    const txEnd = closeOfCall(confirm, 'transactionManager.runInTransaction(');
    const pub = confirm.indexOf('this.settlement.publishCollectionsSettled(');
    await assert('remittance confirm: FIFO inside the transaction, the event published AFTER it commits', () =>
      txEnd > 0 && confirm.indexOf('applyFifoInSession(') < txEnd && pub > txEnd);
  }
  {
    const confirm = methodSlice(deposit, 'async confirm(', 'async reject(');
    const txEnd = closeOfCall(confirm, 'transactionManager.runInTransaction(');
    const pub = confirm.indexOf('this.settlement.publishCollectionsSettled(settlement');
    await assert('deposit confirm: settlement captured inside the transaction, published AFTER it commits', () =>
      txEnd > 0 && confirm.indexOf('settlement = await this.applyInSession(') < txEnd && pub > txEnd);

    const record = methodSlice(deposit, 'async record(', 'private async applyInSession(');
    const recTxEnd = closeOfCall(record, 'transactionManager.runInTransaction(');
    const recPub = record.indexOf('this.settlement.publishCollectionsSettled(settlement');
    await assert('deposit record (admin-recorded platform payment): published AFTER the commit too', () =>
      recTxEnd > 0 && record.indexOf('settlement = await this.applyInSession(') < recTxEnd && recPub > recTxEnd);

    const apply = methodSlice(deposit, 'private async applyInSession(', 'private async assertDepositable(');
    await assert('an agency-recipient deposit covers NOTHING: it returns null before the FIFO; platform returns the FIFO result', () =>
      /if \(deposit\.recipient !== 'platform'\) return null;/.test(apply)
      && apply.indexOf("return null;") < apply.indexOf('return await this.settlement.applyFifoInSession(')
      && !apply.includes('publishCollectionsSettled'));
  }
  await assert('the FIFO itself never publishes (it runs INSIDE the transaction)', () => {
    const fifo = methodSlice(settle, 'async applyFifoInSession(', 'publishCollectionsSettled(');
    return fifo.length > 0 && !fifo.includes('eventBus');
  });
  await assert('the FIFO sorts with FIFO_SORT and plans with planFifoSettlement — no collected_at ordering left', () =>
    settle.includes('.sort(FIFO_SORT)') && settle.includes('planFifoSettlement(') && !settle.includes('collected_at'));
  await assert('publication is fire-and-forget with a logged catch (the bus convention)', () =>
    /void eventBus\s*\.publish\(COD_COLLECTIONS_SETTLED_EVENT/.test(settle) && /\.catch\(/.test(settle));

  {
    const coded = methodSlice(collect, 'async collect(', 'async autoCollectWithoutCode(');
    const codedTxEnd = closeOfCall(coded, 'transactionManager.runInTransaction(');
    const ship = coded.indexOf('const deliveredShipment = await this.shipmentRepo.applyStatusChange(');
    const stamp = coded.indexOf('await this.stampDeliveredAtInSession(claimed, deliveredShipment, session);');
    await assert('coded collect: delivered_at stamped in the claiming transaction, from the shipment write it just made', () =>
      ship > 0 && stamp > ship && stamp < codedTxEnd && coded.indexOf('claimCollected(') < stamp);

    const auto = methodSlice(collect, 'async autoCollectWithoutCode(', 'private async stampDeliveredAtInSession(');
    const autoTxEnd = closeOfCall(auto, 'transactionManager.runInTransaction(');
    const confirm = auto.indexOf('applyCustomerConfirmation(');
    const autoStamp = auto.indexOf('await this.stampDeliveredAtInSession(claim, delivered, session);');
    await assert('auto-collect without a code: delivered_at stamped in the claiming transaction too, after the guarded delivery', () =>
      confirm > 0 && autoStamp > confirm && autoStamp < autoTxEnd && auto.indexOf('if (!delivered)') < autoStamp);

    const helper = methodSlice(collect, 'private async stampDeliveredAtInSession(', 'protected async splitEarnings(');
    await assert('the stamp reads status_history through deliveredAtOf, falling back to collected_at', () =>
      helper.includes('deliveredAtOf(deliveredShipment?.status_history, claim.collected_at)')
      && helper.includes('this.collectionRepo.stampDeliveredAt('));
  }

  {
    const model = stripComments(read('modules/cod/models/cash-collection.model.ts'));
    await assert('the model declares delivered_at and the {agency_id, status, delivered_at} index, not the collected_at one', () =>
      /delivered_at: \{ type: Date, default: null \}/.test(model)
      && model.includes('CashCollectionSchema.index({ agency_id: 1, status: 1, delivered_at: 1 });')
      && !model.includes('CashCollectionSchema.index({ agency_id: 1, status: 1, collected_at: 1 });'));

    const names = MIGRATIONS.map((m) => m.name);
    const mine = names.indexOf('migrate:cod-collection-delivered-at');
    await assert('migrate:cod-collection-delivered-at is registered, dry-runnable, BEFORE migrate:declared-indexes', () =>
      mine >= 0 && mine < names.indexOf('migrate:declared-indexes') && MIGRATIONS[mine].dryRun === true);
    const pkg = JSON.parse(readRoot('package.json'));
    await assert('…with its npm binding, and this suite has one', () =>
      pkg.scripts['migrate:cod-collection-delivered-at'] === 'ts-node scripts/migrate-cod-collection-delivered-at.ts'
      && pkg.scripts['test:cod-settlement'] === 'ts-node scripts/test/test-cod-settlement.ts');

    const migration = stripComments(readRoot('scripts/migrate-cod-collection-delivered-at.ts'));
    await assert('the migration backfills through the SAME deliveredAtOf, builds the new key and drops the old by key shape', () =>
      migration.includes("from '../src/modules/cod/domain/cod-fifo'") && migration.includes('deliveredAtOf(history, fallback)')
      && migration.includes('createIndex(') && migration.includes('dropIndex(')
      && /OLD_INDEX_KEY = \{ agency_id: 1, status: 1, collected_at: 1 \}/.test(migration)
      && migration.indexOf('createIndex(') < migration.indexOf('dropIndex('));
    await assert('…and it never touches settled_amount / settled_at (nothing already covered is recalculated)', () =>
      !/settled_amount|settled_at/.test(migration));
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
