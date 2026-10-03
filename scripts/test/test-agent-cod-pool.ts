/**
 * Test: the agent's COD pool — KYC verdict × administrator pin × platform default.
 *
 * ⚠ AMENDED 2026-10-02 (owner decision): the plan no longer sets the pool. Every verified
 * agent without a pin gets AGENT_CONFIG.COD_POOL_DEFAULT (500 000), whatever their plan,
 * sourced `default` (which replaced `plan`). The plan-event consumer is deleted. The
 * sections below were rewritten to that rule; the 2026-09-21 notes that follow describe
 * the shape, with "plan" now read as "the default".
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free.
 *
 * The owner's rule, which every section below pins a part of:
 *
 *   - a KYC-VERIFIED agent's pool is their plan's `max_cod_pool` (Free 500 000,
 *     Plus 1 000 000, Pro 2 000 000) — set automatically, nobody has to act;
 *   - an UNVERIFIED agent's pool is 0, whatever their plan;
 *   - the agent may carry LESS than that ceiling, never more;
 *   - an administrator may PIN a pool that replaces the plan's value until released,
 *     and the pin survives plan changes but does not outrank KYC.
 *
 * Four halves:
 *
 *   1. The pure rule (`agent-cod-pool.ts`) — decision order, clamping, and the one
 *      subtle property: the agent's lower choice survives a no-op re-sync (a plan
 *      RENEWAL re-emits `plan.activated`) and is reset by a real change of ceiling.
 *   2. `AgentCodPoolService.sync` driven against stub repositories — it is the one
 *      writer path with no transaction, so it runs without Mongo. It proves the sync
 *      never writes the administrator's pin and retries a lost compare-and-set.
 *   3. The exposure gate — the pool caps every dispatch, and changes nothing while
 *      the slices fit inside it.
 *   4. SOURCE SCANS for the wiring no behavioural test can see: the KYC verdict
 *      syncs, `plan.activated` and in-place plan edits are consumed, the reconcile
 *      worker is started, the plan read never MINTS a plan, and the old unguarded
 *      writer is gone.
 *
 * Run: npm run test:agent-cod-pool
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  clampCodPool,
  codPoolInSync,
  describeCodPool,
  nextCodPoolValue,
  resolveCodPoolCeiling,
  storedCodPoolOf,
} from '../../src/modules/agents/domain/services/agent-cod-pool';
import { AgentCodPoolService } from '../../src/modules/agents/domain/services/agent-cod-pool.service';
import { CodExposureService } from '../../src/modules/cod/services/cod-exposure.service';
import { AgentCodThresholdService } from '../../src/modules/agents/domain/services/agent-cod-threshold.service';
import { AGENT_CONFIG } from '../../src/modules/agents/config/agent.config';
import { DeliveryAgentModel, IDeliveryAgent } from '../../src/modules/agents/models/agent.model';
import { SetAgentThresholdSchema, SetOwnCodPoolSchema } from '../../src/modules/agents/validators/agent.validator';
import { CreatePlanSchema } from '../../src/modules/billing/validators/billing.validators';

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

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Strip comments before a source scan — a scan that forces tombstones out makes the code worse. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DEFAULT_POOL = AGENT_CONFIG.COD_POOL_DEFAULT;

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A real Mongoose document, never saved — so schema defaults apply exactly as they do
 * to a document read from the database, which is what the "legacy agent" cases rely on.
 */
function agentDoc(cod: Record<string, unknown> = {}, kycStatus = 'verified'): IDeliveryAgent {
  return new DeliveryAgentModel({
    user_id: '64b000000000000000000001',
    name: 'test:agent-cod-pool',
    kyc: { status: kycStatus },
    cod: { trust_score: 100, max_threshold: 0, ...cod },
  }) as unknown as IDeliveryAgent;
}

const PIN = (amount: number) => ({
  amount,
  reason: 'test',
  set_at: new Date('2026-09-21T00:00:00Z'),
  set_by_user_id: 'admin-1',
  set_by_source: 'admin',
  set_by_name: 'An Administrator',
});

/**
 * Stub repositories around ONE mutable agent. `writeCodPool` honours the
 * compare-and-set key exactly as the Mongo filter does, and can be told to lose the
 * race a number of times first.
 */
function harness(initial: IDeliveryAgent) {
  let current = initial;
  let loseNext = 0;
  const writes: Array<Record<string, unknown>> = [];
  const agents = {
    findById: async () => current,
    listAllIds: async () => [String(current._id)],
    writeCodPool: async (_id: string, expected: Date | null, next: Record<string, unknown>) => {
      const token = current.cod?.pool_synced_at ?? null;
      const matches = (token?.getTime() ?? null) === (expected?.getTime() ?? null);
      if (loseNext > 0 || !matches) {
        if (loseNext > 0) {
          loseNext--;
          // A concurrent writer "won": bump the token so the loser must re-read.
          current = agentDoc({ ...plainCod(current), pool_synced_at: new Date(Date.now() - 1000) }, current.kyc.status);
        }
        return null;
      }
      writes.push(next);
      const cod: Record<string, unknown> = {
        ...plainCod(current),
        max_threshold: next.maxThreshold,
        pool_ceiling: next.ceiling,
        pool_source: next.source,
        pool_plan_code: next.planCode,
        pool_synced_at: next.syncedAt,
      };
      if (next.override !== undefined) cod.pool_override = next.override;
      current = agentDoc(cod, current.kyc.status);
      return current;
    },
  };
  const contracts = { listAllocating: async () => [] };
  const service = new AgentCodPoolService(agents as never, contracts as never);
  return {
    service,
    writes,
    get agent() { return current; },
    setAgent(next: IDeliveryAgent) { current = next; },
    loseRaces(n: number) { loseNext = n; },
  };
}

function plainCod(agent: IDeliveryAgent): Record<string, unknown> {
  const c = agent.cod;
  return {
    trust_score: c.trust_score,
    max_threshold: c.max_threshold,
    pool_ceiling: c.pool_ceiling,
    pool_source: c.pool_source,
    pool_plan_code: c.pool_plan_code,
    pool_synced_at: c.pool_synced_at,
    pool_override: c.pool_override ? { ...(c.pool_override as unknown as Record<string, unknown>) } : null,
  };
}

async function main(): Promise<void> {
  // ═══ 1 · The pure rule ═════════════════════════════════════════════════════
  console.log('\n── 1 · The rule: KYC, then the pin, then the platform default ─────────\n');

  await assert('the platform default is the owner\'s number: 500 000', () => DEFAULT_POOL === 500_000);

  await assert('an UNVERIFIED agent\'s ceiling is 0', () => {
    const c = resolveCodPoolCeiling({ kycStatus: 'pending', override: null });
    return c.amount === AGENT_CONFIG.COD_THRESHOLD_MIN && c.source === 'not_verified' && c.planCode === null;
  });

  await assert('…and every non-verified status counts: unverified, pending, rejected, absent', () =>
    ['unverified', 'pending', 'rejected', undefined, null].every(
      (s) => resolveCodPoolCeiling({ kycStatus: s, override: null }).source === 'not_verified'
    ));

  await assert('the pin does NOT outrank KYC — an unverified agent with a pin still gets 0', () => {
    const c = resolveCodPoolCeiling({ kycStatus: 'rejected', override: { amount: 900_000 } });
    return c.amount === 0 && c.source === 'not_verified';
  });

  await assert('a VERIFIED agent gets 500 000, sourced `default`, with no plan code — whatever their plan', () => {
    const c = resolveCodPoolCeiling({ kycStatus: 'verified', override: null });
    return c.amount === 500_000 && c.source === 'default' && c.planCode === null;
  });

  await assert('the rule takes NO plan input any more (the plan cannot move the pool)', () => {
    const src = stripComments(read('modules/agents/domain/services/agent-cod-pool.ts'));
    const start = src.indexOf('export interface CodPoolInputs');
    const body = src.slice(start, src.indexOf('}', start));
    return start > -1 && !body.includes('plan') && !src.includes('maxCodPool');
  });

  await assert('a pin outranks the default ABOVE it (a trusted agent)', () =>
    resolveCodPoolCeiling({ kycStatus: 'verified', override: { amount: 1_500_000 } }).amount === 1_500_000);

  await assert('…and BELOW it (a risky agent) — it is neither a floor nor a ceiling', () => {
    const c = resolveCodPoolCeiling({ kycStatus: 'verified', override: { amount: 100_000 } });
    return c.amount === 100_000 && c.source === 'override' && c.planCode === null;
  });

  await assert('a pin above the platform maximum is CLAMPED, not trusted', () =>
    resolveCodPoolCeiling({ kycStatus: 'verified', override: { amount: 99_000_000 } })
      .amount === AGENT_CONFIG.COD_THRESHOLD_MAX);

  await assert('clampCodPool floors fractions and refuses NaN to the minimum', () =>
    clampCodPool(1234.9) === 1234 && clampCodPool(Number.NaN) === AGENT_CONFIG.COD_THRESHOLD_MIN
    && clampCodPool(-5) === AGENT_CONFIG.COD_THRESHOLD_MIN);

  console.log('\n── 1b · The agent\'s own lower choice ──────────────────────────────────\n');

  const underDefault = { maxThreshold: 200_000, ceiling: 500_000, source: 'default' as const };

  await assert('the agent\'s choice SURVIVES a re-sync to the same ceiling (the nightly reconcile)', () =>
    nextCodPoolValue(underDefault, { amount: 500_000, source: 'default', planCode: null }) === 200_000);

  await assert('…and is RESET by a new ceiling amount (a changed default)', () =>
    nextCodPoolValue(underDefault, { amount: 1_000_000, source: 'default', planCode: null }) === 1_000_000);

  await assert('…and by the same amount from a new SOURCE (a pin equal to the default is still a new ceiling)', () =>
    nextCodPoolValue(underDefault, { amount: 500_000, source: 'override', planCode: null }) === 500_000);

  await assert('a revoked verdict takes the pool to 0 regardless of the choice', () =>
    nextCodPoolValue(underDefault, { amount: 0, source: 'not_verified', planCode: null }) === 0);

  await assert('codPoolInSync is false while a stale plan CODE is still stored (it is rewritten to null)', () =>
    !codPoolInSync({ maxThreshold: 500_000, ceiling: 500_000, source: 'default' },
      { amount: 500_000, source: 'default', planCode: null }, 'agent_free'));

  await assert('a brand-new agent document is ALREADY in sync (0, not_verified) — no write on first read', () => {
    const fresh = agentDoc({}, 'unverified');
    const stored = storedCodPoolOf(fresh);
    return codPoolInSync(stored, resolveCodPoolCeiling({ kycStatus: 'unverified', override: null }), null);
  });

  await assert('a LEGACY verified agent (no provenance fields) counts as out of sync and lands on the default', () => {
    const legacy = agentDoc({ max_threshold: 300_000 }, 'verified');
    const stored = storedCodPoolOf(legacy);
    const next = resolveCodPoolCeiling({ kycStatus: 'verified', override: null });
    return stored.source === 'not_verified' && nextCodPoolValue(stored, next) === 500_000;
  });

  await assert('an agent synced under the RETIRED plan rule (source `plan`, Plus 1 000 000) moves to the default', () => {
    const old = agentDoc({ max_threshold: 1_000_000, pool_ceiling: 1_000_000, pool_source: 'plan', pool_plan_code: 'agent_plus' }, 'verified');
    const stored = storedCodPoolOf(old);
    const next = resolveCodPoolCeiling({ kycStatus: 'verified', override: null });
    return !codPoolInSync(stored, next, 'agent_plus') && nextCodPoolValue(stored, next) === 500_000;
  });

  await assert('…and that legacy document still VALIDATES (the schema tolerates the retired `plan`)', () =>
    agentDoc({ pool_source: 'plan' }, 'verified').validateSync() === undefined);

  await assert('describeCodPool reports selfLimited, and never the pin\'s reason or author', () => {
    const view = describeCodPool(agentDoc({
      max_threshold: 100_000, pool_ceiling: 400_000, pool_source: 'override', pool_override: PIN(400_000),
    }));
    const keys = Object.keys(view);
    return view.selfLimited === true && view.source === 'override'
      && !keys.includes('reason') && !JSON.stringify(view).includes('An Administrator');
  });

  // ═══ 2 · The sync ══════════════════════════════════════════════════════════
  console.log('\n── 2 · AgentCodPoolService.sync against stub repositories ─────────────\n');

  {
    const h = harness(agentDoc({}, 'unverified'));
    const r = await h.service.sync('a', 'reconcile');
    await assert('an unverified agent already at 0 is read and NOT written', () =>
      r?.changed === false && h.writes.length === 0);
  }

  {
    const h = harness(agentDoc({}, 'unverified'));
    h.setAgent(agentDoc(plainCod(h.agent), 'verified'));
    const r = await h.service.sync('a', 'kyc_verdict');
    await assert('THE OWNER\'S CASE — verification opens the pool at the 500 000 default automatically', () =>
      r?.changed === true && r.to === 500_000 && h.agent.cod.max_threshold === 500_000
      && h.agent.cod.pool_source === 'default' && h.agent.cod.pool_plan_code === null);

    const again = await h.service.sync('a', 'reconcile');
    await assert('…and a second sync is a no-op (idempotent — the reconcile writes nothing)', () =>
      again?.changed === false && h.writes.length === 1);

    // The agent lowers their pool; the nightly reconcile re-syncs with the same ceiling.
    h.setAgent(agentDoc({ ...plainCod(h.agent), max_threshold: 150_000 }, 'verified'));
    await h.service.sync('a', 'reconcile');
    await assert('a same-ceiling re-sync leaves the agent\'s lower choice alone', () =>
      h.agent.cod.max_threshold === 150_000);

    h.setAgent(agentDoc(plainCod(h.agent), 'rejected'));
    await h.service.sync('a', 'kyc_verdict');
    await assert('a revoked verdict closes the pool to 0', () =>
      h.agent.cod.max_threshold === 0 && h.agent.cod.pool_source === 'not_verified');
  }

  {
    const h = harness(agentDoc({ pool_override: PIN(800_000) }, 'verified'));
    await h.service.sync('a', 'reconcile');
    await assert('a pin is honoured by the sync (800 000 over the 500 000 default)', () =>
      h.agent.cod.max_threshold === 800_000 && h.agent.cod.pool_source === 'override');

    await assert('…and the sync NEVER writes the pin itself', () =>
      h.writes.every((w) => !('override' in w)));

    h.setAgent(agentDoc(plainCod(h.agent), 'pending'));
    await h.service.sync('a', 'kyc_verdict');
    await assert('an unverified spell takes the pool to 0 but keeps the pin for later', () =>
      h.agent.cod.max_threshold === 0 && h.agent.cod.pool_override?.amount === 800_000);

    h.setAgent(agentDoc(plainCod(h.agent), 'verified'));
    await h.service.sync('a', 'kyc_verdict');
    await assert('…and re-verification brings the pinned value back', () =>
      h.agent.cod.max_threshold === 800_000);
  }

  {
    const h = harness(agentDoc({}, 'verified'));
    h.loseRaces(2);
    const r = await h.service.sync('a', 'reconcile');
    await assert('a sync that loses its compare-and-set re-reads and succeeds on a later attempt', () =>
      r?.to === 500_000 && h.agent.cod.max_threshold === 500_000);

    const h2 = harness(agentDoc({}, 'verified'));
    h2.loseRaces(10);
    const r2 = await h2.service.sync('a', 'reconcile');
    await assert('…and one that loses EVERY attempt gives up with null rather than looping', () =>
      r2 === null && h2.writes.length === 0);
  }

  // ═══ 3 · The exposure gate ════════════════════════════════════════════════
  console.log('\n── 3 · The pool caps every dispatch ───────────────────────────────────\n');

  const exposure = new CodExposureService({} as never, {} as never);

  await assert('while the slice fits inside the pool, NOTHING changes (base = slice)', () => {
    const b = exposure.limitBreakdown(agentDoc({ max_threshold: 500_000 }), 300_000);
    return b.base === 300_000 && b.poolBinds === false && b.effectiveLimit === 300_000;
  });

  await assert('an over-allocated agent (downgrade left a 1 000 000 slice) is capped at the POOL', () => {
    const b = exposure.limitBreakdown(agentDoc({ max_threshold: 500_000 }), 1_000_000);
    return b.base === 500_000 && b.poolBinds === true && b.effectiveLimit === 500_000;
  });

  await assert('a pool of 0 allows no COD at all', () =>
    exposure.limitBreakdown(agentDoc({ max_threshold: 0 }), 200_000).effectiveLimit === 0);

  await assert('the breakdown reports the pool beside the slice, so a dashboard can say which bound', () => {
    const b = exposure.limitBreakdown(agentDoc({ max_threshold: 500_000 }), 1_000_000);
    return b.agentPool === 500_000 && b.contractThreshold === 1_000_000;
  });

  // ═══ 3b · KYC withholds CASH, and only cash (owner decision, 2026-09-27) ═══
  // Contracts, dispatch and the directory stopped checking KYC, so this gate is the
  // ONLY thing between an unvetted agent and a customer's cash. It must read the
  // verdict itself: a pool of 0 is not enough, because an agent the sync has not
  // reached yet falls back to the slice. Both cases below short-circuit before any
  // cash read, so they need no database.
  console.log('\n── 3b · An unverified agent carries no COD, whatever the numbers say ──\n');

  const shortfallStub = { hasOpenShortfallForAgent: async () => false };
  const kycExposure = new CodExposureService({} as never, shortfallStub as never);

  for (const status of ['unverified', 'pending', 'rejected']) {
    await assert(`a ${status} agent with a FULL pool and full trust is refused on KYC`, async () => {
      const v = await kycExposure.evaluate(agentDoc({ max_threshold: 2_000_000 }, status), 10_000, 500_000);
      return v.allowed === false && v.blocker === 'kyc_not_verified' && v.kycStatus === status;
    });
  }

  await assert('KYC outranks trust — an unverified, untrusted agent is refused for KYC', async () => {
    const v = await kycExposure.evaluate(agentDoc({ max_threshold: 500_000, trust_score: 0 }, 'unverified'), 1, 500_000);
    return v.blocker === 'kyc_not_verified';
  });

  await assert('a VERIFIED agent is never refused on KYC (trust decides here)', async () => {
    const v = await kycExposure.evaluate(agentDoc({ max_threshold: 500_000, trust_score: 0 }, 'verified'), 1, 500_000);
    return v.blocker === 'trust_too_low';
  });

  await assert('the refusal throws AGENT_KYC_NOT_VERIFIED 422 with { kycStatus, hint }', async () => {
    try {
      await kycExposure.assertCanTakeCodShipment(agentDoc({ max_threshold: 500_000 }, 'pending'), 10_000, 500_000);
      return false;
    } catch (err) {
      const e = err as { code?: string; statusCode?: number; details?: { kycStatus?: string; hint?: string } };
      return e.code === 'AGENT_KYC_NOT_VERIFIED' && e.statusCode === 422
        && e.details?.kycStatus === 'pending' && typeof e.details?.hint === 'string';
    }
  });

  // The slice an unverified agent's contract carries is DORMANT: approvable now,
  // usable once verified. The headroom check would refuse it against a pool of 0.
  const thresholdFor = (agent: IDeliveryAgent) => new AgentCodThresholdService(
    { findById: async () => agent } as never,
    { listAllocating: async () => [] } as never,
  );

  await assert('an UNVERIFIED agent may hold a contract slice above their pool of 0 (dormant)', async () => {
    await thresholdFor(agentDoc({ max_threshold: 0 }, 'unverified'))
      .assertContractThresholdAllowed('a', null, 300_000, {} as never);
    return true;
  });

  await assert('a VERIFIED agent is still bounded by their pool', async () => {
    try {
      await thresholdFor(agentDoc({ max_threshold: 100_000 }, 'verified'))
        .assertContractThresholdAllowed('a', null, 300_000, {} as never);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM';
    }
  });

  await assert('the absolute per-contract bounds still apply to an unverified agent', async () => {
    try {
      await thresholdFor(agentDoc({ max_threshold: 0 }, 'unverified'))
        .assertContractThresholdAllowed('a', null, -1, {} as never);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'CONTRACT_COD_THRESHOLD_OUT_OF_BOUNDS';
    }
  });

  // ═══ 4 · Validators ═══════════════════════════════════════════════════════
  console.log('\n── 4 · Validators ─────────────────────────────────────────────────────\n');

  const parses = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;

  await assert('the agent\'s write accepts a number or null (null = back to the full ceiling)', () =>
    parses(SetOwnCodPoolSchema, { maxThreshold: 100_000 }) && parses(SetOwnCodPoolSchema, { maxThreshold: null }));

  await assert('…and refuses a fraction or a negative', () =>
    !parses(SetOwnCodPoolSchema, { maxThreshold: 10.5 }) && !parses(SetOwnCodPoolSchema, { maxThreshold: -1 }));

  await assert('the admin pin requires a reason, in both directions', () =>
    !parses(SetAgentThresholdSchema, { maxThreshold: 100_000 })
    && parses(SetAgentThresholdSchema, { maxThreshold: null, reason: 'back to the default' }));

  await assert('a plan can still CARRY max_cod_pool (dormant since 2026-10-02), and it may be null', () =>
    parses(CreatePlanSchema, { role: 'agent', code: 'agent_x', name: 'Agent X', price: 0, term_days: null, credit_allowance: 0, max_cod_pool: 750_000 })
    && parses(CreatePlanSchema, { role: 'agent', code: 'agent_y', name: 'Agent Y', price: 0, term_days: null, credit_allowance: 0, max_cod_pool: null }));

  // ═══ 5 · Source scans ═════════════════════════════════════════════════════
  console.log('\n── 5 · SOURCE SCANS: the wiring ───────────────────────────────────────\n');

  const gate = stripComments(read('modules/agents/domain/services/agent-gate.service.ts'));
  await assert('a KYC verdict syncs the pool, in setKycStatus', () => {
    const start = gate.indexOf('async setKycStatus');
    const end = gate.indexOf('async setPlatformBan');
    return start > -1 && gate.slice(start, end).includes("agentCodPoolService.sync(agentId, 'kyc_verdict')");
  });

  const lifecycle = stripComments(read('lifecycle.ts'));
  await assert('lifecycle starts the reconcile worker, and registers NO plan consumer any more', () =>
    lifecycle.includes('agentCodPoolReconcileWorker.start()') && !lifecycle.includes('registerAgentCodPoolConsumer'));

  await assert('the plan-event consumer file is GONE (plan events no longer move the pool)', () =>
    !existsSync(join(SRC, 'modules', 'agents', 'events', 'agent-plan-cod-pool.consumer.ts')));

  const entitlement = stripComments(read('modules/billing/services/entitlement.service.ts'));
  await assert('the pool\'s plan read is DELETED (nothing resolves a plan for the pool)', () =>
    !entitlement.includes('resolveAgentCodPool'));

  const poolService = stripComments(read('modules/agents/domain/services/agent-cod-pool.service.ts'));
  await assert('AgentCodPoolService no longer depends on billing at all', () =>
    !poolService.includes('entitlement') && !poolService.includes("'plan_activated'"));

  const repo = stripComments(read('modules/agents/repositories/agent.repository.ts'));
  await assert('writeCodPool is the ONLY writer of cod.max_threshold, and it is a compare-and-set', () => {
    const writes = repo.split("'cod.max_threshold'").length - 1;
    const start = repo.indexOf('async writeCodPool');
    const body = repo.slice(start, start + 1400);
    return writes === 1 && body.includes("'cod.max_threshold'") && body.includes("'cod.pool_synced_at': expectedSyncedAt");
  });

  await assert('the old unguarded writers are gone (setAgentThreshold, setCodMaxThreshold)', () => {
    const threshold = stripComments(read('modules/agents/domain/services/agent-cod-threshold.service.ts'));
    return !threshold.includes('setAgentThreshold(') && !repo.includes('setCodMaxThreshold(');
  });

  await assert('the pin schema DECLARES set_by_user_id (actorStampFields supplies only _source/_name)', () => {
    const model = stripComments(read('modules/agents/models/agent.model.ts'));
    const start = model.indexOf('const CodPoolOverrideSchema');
    return start > -1 && model.slice(start, start + 800).includes('set_by_user_id:');
  });

  const routes = stripComments(read('modules/delivery/agent.routes.ts'));
  await assert('the agent has a write: PUT /api/agent/cod/pool', () =>
    routes.includes("router.put('/cod/pool', AgentCodController.setPool)"));


  const exposureSrc = stripComments(read('modules/cod/services/cod-exposure.service.ts'));
  await assert('the exposure gate caps the slice at the pool', () =>
    exposureSrc.includes('Math.min(slice, agentPool)'));

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
