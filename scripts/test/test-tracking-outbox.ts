/**
 * Test: the tracking outbox is TRANSACTIONAL (plan step 3.A.4 — X-1).
 *
 * X-1 was not a bug in a function. It was a bug in a *boundary*: every write site
 * enqueued its outbox row AFTER its transaction had already committed, so a crash in
 * that window lost the lifecycle event permanently while the model's own docstring
 * promised crash-durability. Everything downstream (retry, HMAC, `eventId` dedup) was
 * always sound; the gap was the one hop with no retry.
 *
 * A boundary invariant cannot be asserted by calling a function — the call site is the
 * thing under test. So §1–§3 are deliberately **source scans**. That crudeness is the
 * point: this invariant regressed silently for a whole phase, and what catches a future
 * author moving an emit back out of its transaction is reading the file, not running it.
 *
 * §4–§5 are ordinary behaviour tests against fakes. §6 is the only real proof that the
 * crash window is closed (abort ⇒ no row, commit ⇒ exactly one) and needs the replica
 * set, so it is opt-in behind TRACKING_OUTBOX_DB=1 and skipped everywhere else.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free by default, so CI discovers and runs it like every other suite.
 *
 * Run: npx ts-node scripts/test/test-tracking-outbox.ts
 *      TRACKING_OUTBOX_DB=1 npx ts-node scripts/test/test-tracking-outbox.ts   # + §6
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { TrackingOutboxEmitter } from '../../src/modules/tracking-integration/services/tracking-outbox.emitter';
import { visibleAgentsService } from '../../src/modules/tracking-integration/services/visible-agents.service';
import { EnqueueInput } from '../../src/modules/tracking-integration/repositories/tracking-outbox.repository';
import { trackingAllowReconcileWorker } from '../../src/modules/agents/workers/tracking-allow-reconcile.worker';
import { trackingIntegrationEnabled } from '../../src/modules/tracking-integration/config/tracking-integration.config';

const SRC = join(__dirname, '..', '..', 'src');

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then((ok) => {
      if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
      } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
      }
    })
    .catch((err) => {
      console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
      failed++;
    });
}

function read(rel: string): string[] {
  return readFileSync(join(SRC, rel), 'utf8').split('\n');
}

// ── The source-scan machinery ────────────────────────────────────────────────
//
// A "transaction range" is the half-open span of lines between
// `transactionManager.runInTransaction[WithRetry](async (session) => {` and the line
// that closes it. The close is found by indentation, not by brace counting: the house
// style puts `});` at exactly the opening statement's indent, and matching on that is
// both simpler and harder to fool than a hand-rolled brace counter that string
// literals and comments would defeat.

const TXN_OPEN = /^(\s*)(?:await\s+)?transactionManager\.runInTransaction(?:WithRetry)?\(\s*async\s*\(\s*session\s*\)\s*=>\s*\{/;

interface Range { start: number; end: number; }

/**
 * Does `line` close a call opened at `indent`? i.e. `});` — a `}` sitting at exactly the
 * opening statement's indentation, followed by the call's closing paren.
 *
 * Written with string operations rather than an interpolated `new RegExp`, because the
 * repo bans bare `new RegExp()` outright (`core/utils/regex.util`). The ban is aimed at
 * `$regex` injection and it does not apply to a scan over the project's own source — but a
 * hard rule with a "this one is fine" exemption is a rule nobody enforces, and it is not
 * worth spending here.
 */
function closesAt(line: string, indent: string): boolean {
  if (line.length <= indent.length) return false;
  if (line.slice(0, indent.length).trim() !== '') return false;
  if (line[indent.length] !== '}') return false;
  return line.slice(indent.length + 1).trim().startsWith(')');
}

function transactionRanges(lines: string[]): Range[] {
  const ranges: Range[] = [];
  lines.forEach((line, i) => {
    const m = TXN_OPEN.exec(line);
    if (!m) return;
    const indent = m[1];
    for (let j = i + 1; j < lines.length; j++) {
      if (closesAt(lines[j], indent)) {
        ranges.push({ start: i, end: j });
        return;
      }
    }
    // Unclosed: record it as a zero-width range so any site "inside" it fails loudly
    // rather than being silently excused.
    ranges.push({ start: i, end: i });
  });
  return ranges;
}

/** The full text of a call that starts at `startLine`, up to its balanced closing paren. */
function callText(lines: string[], startLine: number): string {
  let depth = 0;
  let started = false;
  const out: string[] = [];
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    for (const ch of line) {
      if (ch === '(') { depth++; started = true; }
      else if (ch === ')') depth--;
    }
    if (started && depth <= 0) break;
  }
  return out.join('\n');
}

/** Every line index at which one of the outbox emitters is called. */
const EMIT_CALL = /(?:trackingOutboxEmitter|this\.emitter)\.emit[A-Z]\w*\(|agentActionAuditService\.emitShipmentTransition\(/;

function emitSites(lines: string[]): number[] {
  const sites: number[] = [];
  lines.forEach((line, i) => {
    // Skip prose: every one of these files documents the emitter in its comments, and a
    // docstring naming the call is not a call.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    if (EMIT_CALL.test(line)) sites.push(i);
  });
  return sites;
}

/**
 * The declared write sites. Crude on purpose — a scan that discovered its own targets
 * would pass on a file it forgot to look at.
 *
 * `sites` is the exact number of in-transaction emitter calls the file must contain. It
 * is asserted as an equality so that BOTH failures are caught: a site that moved out of
 * its transaction, and a tenth site added somewhere new without being declared here.
 */
const WRITE_SITES: Array<{ file: string; sites: number; what: string }> = [
  { file: 'modules/shipments/shipment.service.ts', sites: 7, what: 'transition core ×2, reject ×2, reassign, agent-cancel release, delivery confirmation' },
  { file: 'modules/cod/services/cash-collection.service.ts', sites: 2, what: 'collect(), autoCollectWithoutCode()' },
  { file: 'modules/agents/domain/services/agent-tracking-policy.service.ts', sites: 1, what: 'setTrackingAllowed()' },
  { file: 'modules/shipment-assignment/domain/services/shipment-assignment.service.ts', sites: 1, what: 'offer accept — the session-OPENING row' },
];

/**
 * The one emitter call in `src/` that is deliberately NOT in a transaction, named here so
 * that "every emit is transactional" stays a checkable statement with one written
 * exception rather than an approximation. A sweep re-states a decision that committed
 * long ago; there is no transaction for its row to join.
 */
const DECLARED_NON_TRANSACTIONAL = 'modules/agents/workers/tracking-allow-reconcile.worker.ts';

// An in-memory stand-in for the outbox repository — records rows AND the session it was
// handed, because "the session is forwarded" is half of what §4 exists to prove.
class FakeOutbox {
  rows: Array<{ input: EnqueueInput; session: unknown }> = [];
  async enqueue(input: EnqueueInput, session?: unknown): Promise<any> {
    this.rows.push({ input, session });
    return input;
  }
}

async function main(): Promise<void> {
  // ── §1 ─────────────────────────────────────────────────────────────────────
  console.log('\n▶ §1 — every outbox emit is INSIDE its transaction (X-1)');

  for (const site of WRITE_SITES) {
    const lines = read(site.file);
    const ranges = transactionRanges(lines);
    const calls = emitSites(lines);
    const name = site.file.split('/').pop();

    await assert(`${name} — has at least one transaction`, () => ranges.length > 0);

    await assert(`${name} — ${site.sites} emit site(s): ${site.what}`, () => {
      if (calls.length === site.sites) return true;
      console.error(
        `     expected ${site.sites} emitter call(s), found ${calls.length}` +
        ` at line(s) ${calls.map((l) => l + 1).join(', ')}`
      );
      return false;
    });

    await assert(`${name} — every emit sits between a runInTransaction* and its close`, () => {
      const outside = calls.filter((line) => !ranges.some((r) => line > r.start && line < r.end));
      if (outside.length === 0) return true;
      console.error(`     post-commit emit at line(s) ${outside.map((l) => l + 1).join(', ')}`);
      return false;
    });

    await assert(`${name} — every emit forwards the session`, () => {
      const naked = calls.filter((line) => !/\bsession\b/.test(callText(lines, line)));
      if (naked.length === 0) return true;
      console.error(`     session not passed at line(s) ${naked.map((l) => l + 1).join(', ')}`);
      return false;
    });
  }

  await assert('the ONLY undeclared emitter call in src/ is the reconcile sweep', () => {
    const declared = new Set([...WRITE_SITES.map((s) => s.file), DECLARED_NON_TRANSACTIONAL]);
    const stray: string[] = [];
    walk(SRC, (abs, rel) => {
      if (!rel.endsWith('.ts')) return;
      if (rel === 'modules/tracking-integration/services/tracking-outbox.emitter.ts') return;
      if (declared.has(rel)) return;
      if (emitSites(readFileSync(abs, 'utf8').split('\n')).length > 0) stray.push(rel);
    });
    if (stray.length === 0) return true;
    console.error(`     undeclared emitter call site(s): ${stray.join(', ')}`);
    return false;
  });

  await assert('the reconcile sweep emits with NO session, and says why', () => {
    const lines = read(DECLARED_NON_TRANSACTIONAL);
    const calls = emitSites(lines);
    const src = lines.join('\n');
    return (
      calls.length === 1 &&
      transactionRanges(lines).length === 0 &&
      // The exception is only an exception if it is written down at the site.
      /No session: a sweep is not a state change/.test(src)
    );
  });

  // ── §2 ─────────────────────────────────────────────────────────────────────
  console.log('\n▶ §2 — enqueue uses the ARRAY form of create() (or the session is ignored)');

  const repoSrc = readFileSync(
    join(SRC, 'modules/tracking-integration/repositories/tracking-outbox.repository.ts'),
    'utf8'
  );

  await assert('enqueue calls TrackingOutboxModel.create([ … ], { session })', () =>
    /TrackingOutboxModel\.create\(\[/.test(repoSrc) && /\}\]\s*,\s*\{\s*session\s*\}\)/.test(repoSrc));

  await assert('no non-array TrackingOutboxModel.create( anywhere in src/', () => {
    const bad: string[] = [];
    walk(SRC, (abs, rel) => {
      if (!rel.endsWith('.ts')) return;
      const text = readFileSync(abs, 'utf8');
      // `create(` not immediately followed by `[` — the form that silently drops { session }.
      if (/TrackingOutboxModel\.create\(\s*(?!\[)/.test(text)) bad.push(rel);
    });
    if (bad.length === 0) return true;
    console.error(`     non-array create() in ${bad.join(', ')}`);
    return false;
  });

  await assert('enqueue takes session as its second parameter', () =>
    /async enqueue\(\s*input: EnqueueInput,\s*session\?: ClientSession\s*\)/.test(repoSrc));

  // ── §3 ─────────────────────────────────────────────────────────────────────
  console.log('\n▶ §3 — no outbox write remains on the in-memory event bus');

  await assert('TrackingEventSubscriber is gone (the bus cannot carry a session)', () =>
    !existsSync(join(SRC, 'modules/tracking-integration/services/tracking-event-subscriber.ts')));

  await assert('nothing registers a tracking-event subscriber at boot', () => {
    const boot = readFileSync(join(SRC, 'server.ts'), 'utf8')
      + readFileSync(join(SRC, 'lifecycle.ts'), 'utf8');
    return !/TrackingEventSubscriber|trackingEventSubscriber/.test(boot);
  });

  await assert('no file that calls eventBus.subscribe reaches the outbox', () => {
    const offenders: string[] = [];
    walk(SRC, (abs, rel) => {
      if (!rel.endsWith('.ts')) return;
      const text = readFileSync(abs, 'utf8');
      if (!/eventBus\.subscribe\(/.test(text)) return;
      if (/TrackingOutboxRepository|trackingOutboxEmitter|outbox\.enqueue/.test(text)) offenders.push(rel);
    });
    if (offenders.length === 0) return true;
    console.error(`     outbox reachable from a bus subscriber in ${offenders.join(', ')}`);
    return false;
  });

  await assert('the emitter itself never imports the event bus', () => {
    const emitterSrc = readFileSync(
      join(SRC, 'modules/tracking-integration/services/tracking-outbox.emitter.ts'),
      'utf8'
    );
    return !/from '.*core\/events/.test(emitterSrc);
  });

  // ── §4 ─────────────────────────────────────────────────────────────────────
  console.log('\n▶ §4 — the verdicts the emitter writes');

  // `shipmentTrackability` is left REAL: the whole point of the emitter is that the
  // trackable/terminal policy comes from the one source of truth. Only the two DB reads
  // are stubbed, and their stubs record the session so forwarding can be asserted.
  const realHasActive = visibleAgentsService.agentHasActiveShipment.bind(visibleAgentsService);
  const realStatus = visibleAgentsService.shipmentStatus.bind(visibleAgentsService);
  const seen: { hasActiveSession: unknown; statusSession: unknown } = {
    hasActiveSession: undefined,
    statusSession: undefined,
  };
  let stubHasActive = true;
  let stubStatus: any = 'in_transit';
  (visibleAgentsService as any).agentHasActiveShipment = async (_id: string, session?: unknown) => {
    seen.hasActiveSession = session;
    return stubHasActive;
  };
  (visibleAgentsService as any).shipmentStatus = async (_id: string, session?: unknown) => {
    seen.statusSession = session;
    return stubStatus;
  };

  const SESSION = { __fake: 'session' } as any;

  try {
    await assert('a terminal status ⇒ shipmentTerminal set, shipmentTrackable false', async () => {
      const outbox = new FakeOutbox();
      const emitter = new TrackingOutboxEmitter(outbox as any);
      stubHasActive = false;
      await emitter.emitShipmentStatusChanged(
        { shipmentId: 's1', agentId: 'a1', agencyId: 'g1', customerId: 'c1', status: 'delivered' },
        SESSION
      );
      const { input, session } = outbox.rows[0];
      return (
        outbox.rows.length === 1 &&
        input.type === 'shipment.status_changed' &&
        input.shipmentTrackable === false &&
        input.shipmentTerminal === 'delivered' &&
        input.agentHasActiveShipment === false &&
        session === SESSION &&
        seen.hasActiveSession === SESSION
      );
    });

    await assert('a trackable status ⇒ trackable true, terminal null', async () => {
      const outbox = new FakeOutbox();
      const emitter = new TrackingOutboxEmitter(outbox as any);
      stubHasActive = true;
      await emitter.emitShipmentStatusChanged(
        { shipmentId: 's1', agentId: 'a1', agencyId: 'g1', customerId: null, status: 'picked_up' },
        SESSION
      );
      const { input } = outbox.rows[0];
      return input.shipmentTrackable === true
        && input.shipmentTerminal === null
        && input.agentHasActiveShipment === true;
    });

    await assert('handing_over is trackable and NOT terminal (a release, not an ending)', async () => {
      const outbox = new FakeOutbox();
      const emitter = new TrackingOutboxEmitter(outbox as any);
      await emitter.emitShipmentStatusChanged(
        { shipmentId: 's1', agentId: 'a1', agencyId: 'g1', customerId: null, status: 'handing_over' },
        SESSION
      );
      const { input } = outbox.rows[0];
      return input.shipmentTrackable === true && input.shipmentTerminal === null;
    });

    await assert('no agent ⇒ agentHasActiveShipment is null, not false', async () => {
      const outbox = new FakeOutbox();
      const emitter = new TrackingOutboxEmitter(outbox as any);
      await emitter.emitShipmentStatusChanged(
        { shipmentId: 's1', agentId: null, agencyId: 'g1', customerId: null, status: 'pending' },
        SESSION
      );
      return outbox.rows[0].input.agentHasActiveShipment === null;
    });

    await assert('a release ⇒ trackable false, terminal null, aggregate still honest', async () => {
      const outbox = new FakeOutbox();
      const emitter = new TrackingOutboxEmitter(outbox as any);
      stubHasActive = true;
      await emitter.emitAgentReleased(
        { shipmentId: 's1', agentId: 'a1', agencyId: 'g1', customerId: null },
        SESSION
      );
      const { input, session } = outbox.rows[0];
      return (
        // The type stays `shipment.status_changed` — geo-tracker branches on the verdicts.
        input.type === 'shipment.status_changed' &&
        input.shipmentTrackable === false &&
        input.shipmentTerminal === null &&
        input.agentHasActiveShipment === true &&
        session === SESSION
      );
    });

    await assert('COD collection reads the status back THROUGH the session', async () => {
      const outbox = new FakeOutbox();
      const emitter = new TrackingOutboxEmitter(outbox as any);
      stubStatus = 'delivered';
      stubHasActive = false;
      await emitter.emitCodCollectionRecorded(
        { shipmentId: 's1', agentId: 'a1', agencyId: 'g1', customerId: null },
        SESSION
      );
      const { input, session } = outbox.rows[0];
      return (
        input.type === 'cod.collection.recorded' &&
        input.shipmentTerminal === 'delivered' &&
        input.shipmentTrackable === false &&
        session === SESSION &&
        // This is the assertion that matters: session-less, the read returns the
        // PRE-collection status and a finished delivery is reported as in flight.
        seen.statusSession === SESSION
      );
    });

    await assert('tracking-allow ⇒ ALL THREE shipment verdicts null, trackingAllowed set', async () => {
      const outbox = new FakeOutbox();
      const emitter = new TrackingOutboxEmitter(outbox as any);
      await emitter.emitTrackingAllowChanged(
        { agentId: 'a1', allowed: false, reason: 'kyc lapsed', actorRole: 'admin' },
        SESSION
      );
      const { input, session } = outbox.rows[0];
      return (
        input.type === 'agent.tracking_allow_changed' &&
        input.trackingAllowed === false &&
        input.reason === 'kyc lapsed' &&
        input.actorRole === 'admin' &&
        // Null is the point, not an omission: this event says nothing about any shipment,
        // so it must not close a delivery jovi-mall still considers in flight.
        (input.shipmentTrackable ?? null) === null &&
        (input.shipmentTerminal ?? null) === null &&
        (input.agentHasActiveShipment ?? null) === null &&
        session === SESSION
      );
    });

    await assert('tracking-allow without an agent is a no-op', async () => {
      const outbox = new FakeOutbox();
      const emitter = new TrackingOutboxEmitter(outbox as any);
      await emitter.emitTrackingAllowChanged({ agentId: '', allowed: false }, SESSION);
      return outbox.rows.length === 0;
    });

    await assert('the session is optional on every path (the sweep has none)', async () => {
      const outbox = new FakeOutbox();
      const emitter = new TrackingOutboxEmitter(outbox as any);
      await emitter.emitTrackingAllowChanged({ agentId: 'a1', allowed: false });
      return outbox.rows.length === 1 && outbox.rows[0].session === undefined;
    });
  } finally {
    (visibleAgentsService as any).agentHasActiveShipment = realHasActive;
    (visibleAgentsService as any).shipmentStatus = realStatus;
  }

  // ── §5 ─────────────────────────────────────────────────────────────────────
  console.log('\n▶ §5 — TrackingAllowReconcileWorker (the one event with no other recovery path)');

  // Read rather than imported. `worker-registry` pulls in all fifteen workers — and with
  // them the WhatsApp handler graph — which quadruples this suite's run time for one
  // membership check that `test:system` already makes properly (it asserts the inventory
  // and the worker-source scan against each other). What is NOT asserted there is that the
  // registered worker is this one and that it is startable, which is what follows.
  const registrySrc = readFileSync(join(SRC, 'modules/dev-tools/worker-registry.ts'), 'utf8');

  await assert('it is registered in worker-registry.ts', () =>
    /'tracking-allow-reconcile':\s*\{/.test(registrySrc)
    && /trackingAllowReconcileWorker/.test(registrySrc));

  await assert('it is started by lifecycle.ts (or it never runs)', () => {
    const lifecycle = readFileSync(join(SRC, 'lifecycle.ts'), 'utf8');
    return /trackingAllowReconcileWorker\.start\(\)/.test(lifecycle);
  });

  await assert('its schedule reports the env var that actually drives it', () => {
    const schedules = trackingAllowReconcileWorker.schedules;
    return schedules.length === 1
      && schedules[0].kind === 'interval'
      && schedules[0].source === 'TRACKING_ALLOW_RECONCILE_INTERVAL_MS'
      && (schedules[0].everyMs ?? 0) > 0;
  });

  await assert('`enabled` is REPORTED from the integration config, not assumed', () =>
    trackingAllowReconcileWorker.enabled === trackingIntegrationEnabled());

  await assert('start() schedules nothing when GEO_TRACKER_BASE_URL is unset', () => {
    const { worker, enabled } = loadReconcileWorker('');
    if (enabled) return false;
    worker.start();
    const scheduled = worker.scheduled;
    worker.stop();
    return scheduled === false;
  });

  await assert('…and sweep() guards too, so the dev-tools trigger is inert as well', () => {
    // Behavioural: the trigger path bypasses start(), so the guard has to be in sweep().
    // Asserted at the source because running it would need the worker lock's Redis layer.
    const src = readFileSync(
      join(SRC, 'modules/agents/workers/tracking-allow-reconcile.worker.ts'),
      'utf8'
    );
    const sweep = src.slice(src.indexOf('private async sweep('));
    const guard = sweep.indexOf('if (!trackingIntegrationEnabled())');
    const listRead = sweep.indexOf('listTrackingRevoked');
    return guard > -1 && listRead > -1 && guard < listRead
      // `skipped`, not `success` — a worker that legitimately did nothing must not
      // advance worker_last_success_timestamp_seconds.
      && /recordWorkerRun\('tracking-allow-reconcile', 'scheduled', 'skipped'/.test(sweep);
  });

  await assert('it sweeps ONLY revocations (a lost grant fails safe and self-heals)', () => {
    const src = readFileSync(
      join(SRC, 'modules/agents/workers/tracking-allow-reconcile.worker.ts'),
      'utf8'
    );
    return /listTrackingRevoked\(/.test(src) && /allowed: false/.test(src);
  });

  await assert('a sweep re-push is attributed to the system, not to a request', async () => {
    const outbox = new FakeOutbox();
    const emitter = new TrackingOutboxEmitter(outbox as any);
    await emitter.emitTrackingAllowChanged({
      agentId: 'a1', allowed: false, reason: 'admin revoked', actorRole: 'system',
    });
    const { input } = outbox.rows[0];
    return input.actorRole === 'system' && input.trackingAllowed === false;
  });

  // ── §6 ─────────────────────────────────────────────────────────────────────
  if (process.env.TRACKING_OUTBOX_DB === '1') {
    await integrationCase();
  } else {
    console.log('\n▶ §6 — abort/commit proof: SKIPPED (set TRACKING_OUTBOX_DB=1 with a replica set)');
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} Tracking outbox: ${passed} passed, ${failed} failed\n`);
  // Exit explicitly, as `test:system` does. Importing the worker reaches the Redis factory
  // and the metrics registry, both of which hold the event loop open — without this the
  // suite prints its result and then hangs forever, which in CI reads as a broken build
  // rather than a passing one.
  process.exit(failed > 0 ? 1 : 0);
}

/**
 * §6 — the only assertion that actually proves the crash window is closed.
 *
 * §1 proves the call sits inside the transaction in the source. That is necessary and not
 * sufficient: Mongoose ignores `{ session }` on the non-array `create()` form, which is
 * exactly how a row can look transactional and not be. This writes one, aborts, and
 * checks the collection.
 *
 * Needs a replica set (transactions do). Opt-in, so CI stays DB-free.
 */
async function integrationCase(): Promise<void> {
  console.log('\n▶ §6 — abort ⇒ no row; commit ⇒ exactly one row (needs the replica set)');

  const mongoose = await import('mongoose');
  await import('dotenv/config');
  const { TrackingOutboxRepository } = await import(
    '../../src/modules/tracking-integration/repositories/tracking-outbox.repository'
  );
  const { TrackingOutboxModel } = await import(
    '../../src/modules/tracking-integration/models/tracking-outbox.model'
  );

  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';
  await mongoose.default.connect(uri);
  console.log(`  (connected: ${uri})`);

  const repo = new TrackingOutboxRepository();
  const marker = `outbox-test-${Date.now()}`;

  try {
    await assert('an ABORTED transaction leaves no outbox row', async () => {
      const session = await mongoose.default.startSession();
      try {
        await session.withTransaction(async () => {
          await repo.enqueue(
            { type: 'shipment.status_changed', shipmentId: marker, shipmentTrackable: true },
            session
          );
          // Abort by throwing — the row must go with it.
          throw new Error('deliberate abort');
        });
      } catch {
        /* expected */
      } finally {
        await session.endSession();
      }
      return (await TrackingOutboxModel.countDocuments({ shipment_id: marker })) === 0;
    });

    await assert('a COMMITTED transaction leaves exactly one', async () => {
      const session = await mongoose.default.startSession();
      try {
        await session.withTransaction(async () => {
          await repo.enqueue(
            { type: 'shipment.status_changed', shipmentId: marker, shipmentTrackable: true },
            session
          );
        });
      } finally {
        await session.endSession();
      }
      return (await TrackingOutboxModel.countDocuments({ shipment_id: marker })) === 1;
    });
  } finally {
    await TrackingOutboxModel.deleteMany({ shipment_id: marker });
    await mongoose.default.disconnect();
  }
}

/**
 * Re-require the worker with a chosen GEO_TRACKER_BASE_URL.
 *
 * The integration config is `Object.freeze`d at module load, so "inert when the URL is
 * unset" cannot be tested by assigning to `process.env` — the value was already read. The
 * module cache is purged instead, which is contained because only three modules are
 * involved and the fresh copies are used for one assertion and dropped.
 */
function loadReconcileWorker(baseUrl: string): { worker: any; enabled: boolean } {
  const previous = process.env.GEO_TRACKER_BASE_URL;
  process.env.GEO_TRACKER_BASE_URL = baseUrl;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('tracking-integration.config')
      || key.includes('tracking-outbox.emitter')
      || key.includes('tracking-allow-reconcile.worker')) {
      delete require.cache[key];
    }
  }
  try {
    // `require`, not `import`: an ES import is hoisted and cached, and re-reading a frozen
    // config after changing the environment is the entire point of this function. The two
    // disables are the narrowest form — one line each, with this comment as the reason.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../src/modules/agents/workers/tracking-allow-reconcile.worker');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require('../../src/modules/tracking-integration/config/tracking-integration.config');
    return { worker: mod.trackingAllowReconcileWorker, enabled: cfg.trackingIntegrationEnabled() };
  } finally {
    if (previous === undefined) delete process.env.GEO_TRACKER_BASE_URL;
    else process.env.GEO_TRACKER_BASE_URL = previous;
  }
}

/** Walk src/, calling back with (absolutePath, pathRelativeToSrc). */
function walk(dir: string, fn: (abs: string, rel: string) => void, base = dir): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, fn, base);
    else fn(abs, abs.slice(base.length + 1).split('\\').join('/'));
  }
}

void main();
