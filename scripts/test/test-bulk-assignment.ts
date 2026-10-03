/**
 * Test: Bulk assignment (2026-10-03) — an agency offers ONE agent up to ten shipments in one
 * call, and the agent accepts up to ten offers in one call.
 *
 * DB-free by construction, following the scripts/test convention (plain ts-node, hand-rolled
 * asserts, no framework). `ShipmentAssignmentService` takes every collaborator by constructor,
 * so the bulk path runs against fakes; the one static it reaches past them
 * (`OrderModel.findById`) is stubbed below.
 *
 * What it pins, in the order the owner decided them:
 *   1. partial success — one item per id, in request order, each failure projected exactly as
 *      the global error handler would project it;
 *   2. capacity refused UPFRONT for the whole batch, counted on the shipments that pass the
 *      shipment-level gates — and nothing offered when it refuses;
 *   3. ONE grouped notification — per-offer events carry `batchId`, the agent handler skips
 *      them, and a batch of one falls back to the ordinary single-offer notification;
 *   4. the agent's bulk accept — each offer through the single `accept`, in order.
 *
 * Run: npx ts-node scripts/test/test-bulk-assignment.ts   (npm run test:bulk-assignment)
 */
import * as fs from 'fs';
import * as path from 'path';
import { Types } from 'mongoose';
import { ShipmentAssignmentService } from '../../src/modules/shipment-assignment/domain/services/shipment-assignment.service';
import {
  BulkAcceptOffersSchema,
  BulkOfferAgentSchema,
  BULK_ASSIGNMENT_MAX,
} from '../../src/modules/shipment-assignment/validators/assignment.validator';
import { OrderModel } from '../../src/modules/orders/order.model';
import { eventBus, DomainEvent } from '../../src/core/events/event-bus';
import { createAppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { projectItemError } from '../../src/core/error-detail-policy';
import {
  assertAgentCatalogComplete,
  renderAgentButton,
  renderAgentInApp,
} from '../../src/modules/notifications/catalog/agent-notification-catalog';
import {
  AGENT_AGGREGATE_TYPES,
  AGENT_NOTIFICATION_TYPES,
} from '../../src/modules/notifications/models/agent-notification.model';
import { AgentNotificationEventHandler } from '../../src/modules/notifications/services/agent-notification-event-handler.service';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  try {
    if (await fn()) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name}`);
      failed++;
    }
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
  }
}

async function throwsCode(fn: () => Promise<unknown>, code: string): Promise<{ ok: boolean; err: any }> {
  try {
    await fn();
    return { ok: false, err: null };
  } catch (err: any) {
    return { ok: err?.code === code, err };
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const oid = () => new Types.ObjectId().toString();

// ─── Fixture world ──────────────────────────────────────────────────────────────

const AGENCY = oid();
const AGENT = oid();

interface World {
  shipments: Map<string, any>;
  /** shipment id → pending offer already standing for AGENT */
  pendingFor: Set<string>;
  /** shipment id → contract-policy refusal */
  policyRefuses: Set<string>;
  eligibility: { activeShipmentCount: number; maxConcurrentShipments: number } | 'ineligible';
  created: any[];
}

function shipmentDoc(opts: { agentId?: string | null; status?: string } = {}) {
  const id = new Types.ObjectId();
  return {
    _id: id,
    order_id: new Types.ObjectId(),
    agency_id: new Types.ObjectId(AGENCY),
    agent_id: opts.agentId ? new Types.ObjectId(opts.agentId) : null,
    status: opts.status ?? 'assigned',
    assignment: { state: 'unassigned' },
  };
}

function buildService(w: World): ShipmentAssignmentService {
  const offers = {
    findPendingForShipmentAndAgent: async (shipmentId: string) => (w.pendingFor.has(shipmentId) ? { _id: 'x' } : null),
    create: async (doc: any) => {
      const row = { ...doc, _id: new Types.ObjectId(), created_at: new Date() };
      w.created.push(row);
      return row;
    },
  };
  const shipments = {
    findByIdAndAgency: async (id: string, agencyId: string) => {
      const s = w.shipments.get(id);
      return s && s.agency_id.toString() === agencyId ? s : null;
    },
    findById: async (id: string) => w.shipments.get(id) ?? null,
    markOffered: async () => undefined,
  };
  const agents = {
    findById: async (id: string) => ({ _id: new Types.ObjectId(id), settings: { auto_accept_assignments: false } }),
  };
  const eligibility = {
    assertEligible: async (agentId: string, agencyId: string) => {
      if (w.eligibility === 'ineligible') {
        throw createAppError(ERROR_CODES.AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT, 422, undefined, { agentId, agencyId });
      }
      return { agentId, agencyId, eligible: true, reasons: [], rules: [], ...w.eligibility };
    },
  };
  const contractPolicy = {
    assert: async (_agent: unknown, _agencyId: string, shipment: any) => {
      if (w.policyRefuses.has(shipment._id.toString())) {
        throw createAppError(ERROR_CODES.CONTRACT_COVERAGE_REGION_NOT_COVERED, 422);
      }
      return { coverageForced: false };
    },
  };
  const cashCollection = { computeExpectedAmount: () => null };
  const none = {} as any;
  return new ShipmentAssignmentService(
    offers as any,
    none,
    shipments as any,
    agents as any,
    eligibility as any,
    none,
    none,
    none,
    cashCollection as any,
    contractPolicy as any,
    none,
    none,
    none,
    none
  );
}

function freshWorld(): World {
  return {
    shipments: new Map(),
    pendingFor: new Set(),
    policyRefuses: new Set(),
    eligibility: { activeShipmentCount: 0, maxConcurrentShipments: 20 },
    created: [],
  };
}

function addShipment(w: World, opts: { agentId?: string | null; status?: string } = {}): string {
  const s = shipmentDoc(opts);
  w.shipments.set(s._id.toString(), s);
  return s._id.toString();
}

// Every order resolves to a prepaid order; the bulk path never needs more.
(OrderModel as any).findById = async (id: unknown) => ({
  _id: id,
  order_number: 'ORD-TEST',
  payment_method: 'prepaid',
  currency: 'XAF',
});

// Capture the two events the bulk path publishes.
const captured: { created: DomainEvent[]; batch: DomainEvent[] } = { created: [], batch: [] };
eventBus.subscribe('shipment.offer_created', async (e) => void captured.created.push(e), 'test:offer_created');
eventBus.subscribe('shipment.offer_batch_created', async (e) => void captured.batch.push(e), 'test:offer_batch_created');
function resetCaptured() {
  captured.created.length = 0;
  captured.batch.length = 0;
}

const CREATOR = { role: 'agency' as const, userId: oid() };

async function run(): Promise<void> {
  console.log('\n🧪 Bulk assignment — agency bulk offer + agent bulk accept\n');

  // ── 1. Validators ─────────────────────────────────────────────────────────────
  console.log('§1 validators');
  const ids = (n: number) => Array.from({ length: n }, oid);
  await check('the limit is 10', () => BULK_ASSIGNMENT_MAX === 10);
  await check('10 shipments parse', () => BulkOfferAgentSchema.safeParse({ agentId: oid(), shipmentIds: ids(10) }).success);
  await check('11 shipments are refused', () => !BulkOfferAgentSchema.safeParse({ agentId: oid(), shipmentIds: ids(11) }).success);
  await check('an empty list is refused', () => !BulkOfferAgentSchema.safeParse({ agentId: oid(), shipmentIds: [] }).success);
  await check('a duplicate is refused, case-insensitively', () => {
    const a = oid();
    return !BulkOfferAgentSchema.safeParse({ agentId: oid(), shipmentIds: [a, a.toUpperCase()] }).success;
  });
  await check('a malformed id is refused', () => !BulkOfferAgentSchema.safeParse({ agentId: oid(), shipmentIds: ['nope'] }).success);
  await check('bulk accept: 10 parse, 11 refused', () =>
    BulkAcceptOffersSchema.safeParse({ offerIds: ids(10) }).success && !BulkAcceptOffersSchema.safeParse({ offerIds: ids(11) }).success
  );

  // ── 2. Partial success ────────────────────────────────────────────────────────
  console.log('\n§2 partial success');
  {
    const w = freshWorld();
    const ok1 = addShipment(w);
    const missing = oid();
    const taken = addShipment(w, { agentId: oid() });
    const refused = addShipment(w);
    const ok2 = addShipment(w);
    w.policyRefuses.add(refused);
    resetCaptured();
    const svc = buildService(w);
    const result = await svc.offerManyToAgent(AGENCY, [ok1, missing, taken, refused, ok2], AGENT, CREATOR);
    await tick();

    await check('one item per id, in request order', () =>
      result.items.map((i) => i.shipmentId).join() === [ok1, missing, taken, refused, ok2].join()
    );
    await check('counts: 5 requested, 2 offered, 3 failed', () =>
      result.requested === 5 && result.offered === 2 && result.failed === 3 && result.autoAccepted === 0
    );
    const codeOf = (i: number) => (result.items[i] as any).error?.code;
    await check('an unknown shipment reports SHIPMENT_NOT_FOUND', () => codeOf(1) === ERROR_CODES.SHIPMENT_NOT_FOUND);
    await check('a shipment with an agent reports SHIPMENT_ALREADY_HAS_AGENT', () => codeOf(2) === ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT);
    await check('a contract refusal is reported in its own item', () => (result.items[3] as any).ok === false && (result.items[3] as any).error.statusCode === 422);
    await check('each failed item carries a category', () => [1, 2, 3].every((i) => typeof (result.items[i] as any).error.category === 'string'));
    await check('only the two offerable shipments became offers', () => w.created.length === 2);
    await check('every per-offer event carries the batch id', () =>
      captured.created.length === 2 && captured.created.every((e) => e.payload.batchId === result.batchId)
    );
    await check('exactly ONE batch event, listing the two pending offers', () =>
      captured.batch.length === 1 && captured.batch[0].payload.count === 2 && captured.batch[0].payload.offers.length === 2
    );
    await check('the batch event names the agent and the agency', () =>
      captured.batch[0].payload.agentId === AGENT && captured.batch[0].payload.agencyId === AGENCY
    );
  }

  // ── 3. Capacity, upfront ──────────────────────────────────────────────────────
  console.log('\n§3 capacity');
  {
    const w = freshWorld();
    w.eligibility = { activeShipmentCount: 18, maxConcurrentShipments: 20 };
    const list = [addShipment(w), addShipment(w), addShipment(w)];
    resetCaptured();
    const { ok, err } = await throwsCode(() => buildService(w).offerManyToAgent(AGENCY, list, AGENT, CREATOR), ERROR_CODES.AGENT_AT_CAPACITY);
    await tick();
    await check('3 offerable shipments into 2 free slots → 422 AGENT_AT_CAPACITY', () => ok && err.statusCode === 422);
    await check('the refusal carries freeSlots and requested', () => err?.details?.freeSlots === 2 && err?.details?.requested === 3);
    await check('NOTHING was offered', () => w.created.length === 0 && captured.created.length === 0 && captured.batch.length === 0);
  }
  {
    const w = freshWorld();
    w.eligibility = { activeShipmentCount: 18, maxConcurrentShipments: 20 };
    const good = [addShipment(w), addShipment(w)];
    const bad = [addShipment(w, { agentId: oid() }), oid()];
    const result = await buildService(w).offerManyToAgent(AGENCY, [...good, ...bad], AGENT, CREATOR);
    await check('capacity counts only shipments that pass the shipment gates (2 of 4 fit 2 slots)', () =>
      result.offered === 2 && result.failed === 2
    );
  }
  {
    const w = freshWorld();
    w.eligibility = { activeShipmentCount: 20, maxConcurrentShipments: 20 };
    const list = [addShipment(w, { agentId: oid() })];
    const result = await buildService(w).offerManyToAgent(AGENCY, list, AGENT, CREATOR);
    await check('a full agent with NO offerable shipment is not a capacity refusal', () => result.offered === 0 && result.failed === 1);
  }
  {
    const w = freshWorld();
    const pending = addShipment(w);
    w.pendingFor.add(pending);
    const result = await buildService(w).offerManyToAgent(AGENCY, [pending], AGENT, CREATOR);
    await check('a shipment already offered to this agent reports SHIPMENT_ALREADY_HAS_PENDING_OFFER', () =>
      (result.items[0] as any).error?.code === ERROR_CODES.SHIPMENT_ALREADY_HAS_PENDING_OFFER
    );
  }

  // ── 4. Agent-level refusals fail the whole call ───────────────────────────────
  console.log('\n§4 agent-level refusal');
  {
    const w = freshWorld();
    w.eligibility = 'ineligible';
    const list = [addShipment(w), addShipment(w)];
    resetCaptured();
    const { ok } = await throwsCode(
      () => buildService(w).offerManyToAgent(AGENCY, list, AGENT, CREATOR),
      ERROR_CODES.AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT
    );
    await tick();
    await check('an ineligible agent refuses the whole batch', () => ok && w.created.length === 0);
    await check('…and publishes nothing', () => captured.created.length === 0 && captured.batch.length === 0);
  }
  {
    const w = freshWorld();
    resetCaptured();
    const result = await buildService(w).offerManyToAgent(AGENCY, [oid()], AGENT, CREATOR);
    await tick();
    await check('a batch that places nothing publishes no batch event', () => result.offered === 0 && captured.batch.length === 0);
  }

  // ── 5. Bulk accept ────────────────────────────────────────────────────────────
  console.log('\n§5 bulk accept');
  {
    const svc = buildService(freshWorld());
    const calls: string[] = [];
    const [a, b, c, d] = [oid(), oid(), oid(), oid()];
    (svc as any).accept = async (agentId: string, offerId: string) => {
      calls.push(offerId);
      if (offerId === b) throw createAppError(ERROR_CODES.AGENT_AT_CAPACITY, 422, undefined, { maxActiveShipments: 3 });
      if (offerId === c) throw new Error('mongo exploded: connection string mongodb://user:pw@host');
      return { offer: { id: offerId }, shipment: { id: 's-' + offerId, agentId } };
    };
    const origError = console.error;
    console.error = () => undefined; // the unknown throw is logged by design; keep the run readable
    const result = await svc.acceptMany(AGENT, [a, b, c, d]);
    console.error = origError;

    await check('every offer goes through the single accept, in order', () => calls.join() === [a, b, c, d].join());
    await check('counts: 4 requested, 2 accepted, 2 failed', () => result.requested === 4 && result.accepted === 2 && result.failed === 2);
    await check('a business refusal keeps its code and details', () => {
      const e = (result.items[1] as any).error;
      return e.code === ERROR_CODES.AGENT_AT_CAPACITY && e.details?.maxActiveShipments === 3;
    });
    await check('an unknown throw is masked as internal — no message leaks', () => {
      const e = (result.items[2] as any).error;
      return e.code === ERROR_CODES.INTERNAL_SERVER_ERROR && e.category === 'internal' && !/mongo|pw@/.test(e.message) && !e.details;
    });
    await check('accepted items carry the shipment', () => (result.items[3] as any).ok && (result.items[3] as any).shipment.id === 's-' + d);
  }

  // ── 6. The item-error projection mirrors the boundary ─────────────────────────
  console.log('\n§6 projectItemError');
  await check('a 5xx AppError gets the registry message and no details', () => {
    const p = projectItemError(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'secret internals', { cause: 'x' }));
    return p.category === 'internal' && p.message !== 'secret internals' && p.details === undefined;
  });
  await check('a business AppError keeps message and details', () => {
    const p = projectItemError(createAppError(ERROR_CODES.AGENT_AT_CAPACITY, 422, 'full', { freeSlots: 0 }));
    return p.message === 'full' && (p.details as any)?.freeSlots === 0 && p.statusCode === 422;
  });

  // ── 7. The grouped notification ───────────────────────────────────────────────
  console.log('\n§7 notification');
  await check('the agent catalog is complete in all five languages', () => {
    assertAgentCatalogComplete();
    return true;
  });
  await check('the situation is in the derived enum', () => AGENT_NOTIFICATION_TYPES.includes('shipment.offer.batch_received'));
  await check('offer_batch is a valid aggregate type', () => AGENT_AGGREGATE_TYPES.includes('offer_batch'));
  await check('the copy names the agency and the count', () => {
    const r = renderAgentInApp('shipment.offer.batch_received', 'en', { agencyName: 'Rapid', count: '7', forcedLine: '' });
    return r.message.includes('Rapid') && r.message.includes('7 deliveries') && !r.message.endsWith(' ');
  });
  await check('the button lands on the offers LIST', () => {
    const b = renderAgentButton('shipment.offer.batch_received', 'en', {}, 'https://agent.example');
    return b?.urlSuffix === 'offers';
  });

  {
    const handler = new AgentNotificationEventHandler() as any;
    const sent: any[] = [];
    handler.dispatch = async (p: any) => void sent.push(p);
    handler.preferenceRepo = { getByAgent: async () => ({ preferences: { assignmentOffers: true } }) };
    handler.resolveAgencyName = async () => 'Rapid';
    handler.resolveAgentLanguage = async () => 'en';
    handler.orderNumberOf = async (p: any) => p.orderNumber ?? 'ORD-' + p.orderId;
    const base = { agentId: AGENT, agencyId: AGENCY };
    const entry = (forced = false) => ({ offerId: oid(), orderId: oid(), codLimitForced: forced, expectedCodAmount: 1000, currency: 'XAF' });

    await handler.handleOfferReceived({ payload: { ...base, offerId: oid(), batchId: oid() } });
    await check('a per-offer event carrying batchId is NOT notified', () => sent.length === 0);

    await handler.handleOfferReceived({ payload: { ...base, offerId: oid(), orderNumber: 'ORD-1' } });
    await check('a single offer is still notified as shipment.offer.received', () =>
      sent.length === 1 && sent[0].situation === 'shipment.offer.received'
    );

    sent.length = 0;
    const one = entry();
    await handler.handleOfferBatchReceived({ payload: { ...base, batchId: oid(), offers: [one] } });
    await check('a batch of ONE falls back to the single-offer situation, on that offer', () =>
      sent.length === 1 && sent[0].situation === 'shipment.offer.received' && sent[0].aggregateId === one.offerId
    );

    sent.length = 0;
    const batchId = oid();
    await handler.handleOfferBatchReceived({ payload: { ...base, batchId, offers: [entry(), entry(true), entry(true)] } });
    await check('a batch of three is ONE notification', () => sent.length === 1 && sent[0].situation === 'shipment.offer.batch_received');
    await check('…aggregated on the batch, not on an offer', () => sent[0].aggregateType === 'offer_batch' && sent[0].aggregateId === batchId);
    await check('…counting three, with the forced line naming two', () =>
      sent[0].context.count === '3' && /\b2\b/.test(sent[0].context.forcedLine)
    );
    await check('…idempotent on the batch id', () => sent[0].idempotencyKey === `shipment.offer.batch_received:${batchId}`);

    sent.length = 0;
    handler.preferenceRepo = { getByAgent: async () => ({ preferences: { assignmentOffers: false } }) };
    await handler.handleOfferBatchReceived({ payload: { ...base, batchId: oid(), offers: [entry(), entry()] } });
    await check('the assignmentOffers preference gates the batch too', () => sent.length === 0);
  }

  // ── 8. Wiring (source scans) ──────────────────────────────────────────────────
  console.log('\n§8 wiring');
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');
  await check('POST /api/agency/shipments/assign-agent is routed', () =>
    /router\.post\('\/shipments\/assign-agent',\s*AgencyAssignmentController\.offerAgentBulk\)/.test(read('modules/delivery/agency.routes.ts'))
  );
  await check('POST /api/agent/offers/accept is routed', () =>
    /router\.post\('\/offers\/accept',\s*AgentOfferController\.acceptMany\)/.test(read('modules/delivery/agent.routes.ts'))
  );
  await check('the agent consumer subscribes the batch event', () =>
    /subscribe\('shipment\.offer_batch_created',\s*handler\.handleOfferBatchReceived/.test(read('modules/notifications/agent-notification-event-consumer.ts'))
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
