/**
 * Test: the `monthly_salary` pay model on the agent↔agency contract (2026-10-02).
 *
 * Owner decisions this pins:
 *  1. A third `fee_split.model`, `monthly_salary`, carrying `agent_monthly_salary`
 *     (minor units, integer > 0). Percentage and flat are unchanged.
 *  2. Under it the platform pays the agent NOTHING per delivery — cut 0, the agency
 *     keeps the whole fee (plus the COD handling fee, as ever) — and NO zero-amount
 *     agent allocation row is written. The salary is paid by the agency off-platform
 *     and is stored only so both parties see what they agreed.
 *  3. It is negotiated exactly like the other fee_split terms, by either party.
 *  4. Every reader of fee_split understands it (quote basis, DTOs, analytics).
 *
 * Plain ts-node, hand-rolled asserts, no framework, no DB.
 *
 * Run: npm run test:contract-salary
 */
import fs from 'fs';
import path from 'path';
import {
  applyFeeSplit,
  basisOf,
  computeAgencyCut,
  salaryOf,
  EarningsQuoteService,
} from '../../src/modules/earnings/services/earnings-quote.service';
import { EarningsSplitService } from '../../src/modules/earnings/services/earnings-split.service';
import { AgentContractService } from '../../src/modules/agents/domain/services/agent-contract.service';
import { AgentMembershipMapper } from '../../src/modules/agents/dto/agent-membership.dto';
import {
  FEE_SPLIT_MODELS,
  FEE_SPLIT_FIELD_BY_MODEL,
  IContractFeeSplit,
  AGENT_NEGOTIABLE_TERM_GROUPS,
  AgentAgencyContractModel,
} from '../../src/modules/agents/models/agent-agency-membership.model';
import {
  AgentNegotiableTermsSchema,
  AgencyNegotiableTermsSchema,
  RequestAgentContractSchema,
  RequestToJoinSchema,
  ProposeTermsChangeAsAgentSchema,
  UpdateContractTermsSchema,
} from '../../src/modules/agents/validators/agent.validator';
import { AppError } from '../../src/core/errors';

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

const SRC = path.resolve(__dirname, '../../src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const salarySplit = (amount: number | null, stale: Partial<IContractFeeSplit> = {}): IContractFeeSplit => ({
  model: 'monthly_salary',
  agent_share_percent: null,
  agent_flat_fee: null,
  agent_monthly_salary: amount,
  currency: 'XAF',
  ...stale,
});
const percentSplit = (p: number): IContractFeeSplit => ({
  model: 'percentage',
  agent_share_percent: p,
  agent_flat_fee: null,
  agent_monthly_salary: null,
  currency: 'XAF',
});

function makeContract(fee_split: IContractFeeSplit, overrides: Record<string, any> = {}): any {
  return {
    _id: { toString: () => 'contract-1' },
    agent_id: { toString: () => 'agent-1' },
    agency_id: { toString: () => 'agency-1' },
    status: 'active',
    origin: 'invitation',
    is_primary: true,
    employment: { employment_type: 'contractor', employee_ref: null, started_at: null, ends_at: null },
    cod: { threshold: 0, outstanding_balance: 0, lifetime_settled: 0, last_settled_at: null },
    payment: { outstanding_to_agent: 0, lifetime_paid: 0, last_paid_at: null },
    fee_split,
    terms_proposed_by: 'agency',
    terms_version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Same construction test:agent-domain uses for its coherence cases. */
function makeTermsService(contract: any) {
  const contracts: any = { findById: async () => contract, updateTerms: async () => contract };
  const events: any = { append: async () => undefined };
  return new AgentContractService(
    { findById: async () => null } as any,
    contracts,
    events,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { findNameByAgencyId: async () => 'Test Agency' } as any
  );
}

function coherenceCode(patch: Partial<IContractFeeSplit>, current: IContractFeeSplit): string | null {
  try {
    (makeTermsService(makeContract(current)) as any).assertFeeSplitCoherent(patch, current);
    return null;
  } catch (err) {
    return (err as AppError).code ?? 'THREW_NON_APP_ERROR';
  }
}

async function main(): Promise<void> {
  // ─── 1. The model vocabulary ──────────────────────────────────────────────
  console.log('\n── 1. Model vocabulary ─────────────────────────────────────────────');

  await assert('three models, percentage and flat unchanged', () =>
    JSON.stringify(FEE_SPLIT_MODELS) === JSON.stringify(['percentage', 'flat', 'monthly_salary'])
  );
  await assert('each model maps to exactly its own amount field', () =>
    FEE_SPLIT_FIELD_BY_MODEL.percentage === 'agent_share_percent' &&
    FEE_SPLIT_FIELD_BY_MODEL.flat === 'agent_flat_fee' &&
    FEE_SPLIT_FIELD_BY_MODEL.monthly_salary === 'agent_monthly_salary'
  );
  await assert('the Mongoose enum is the shared list', () => {
    const p = AgentAgencyContractModel.schema.path('fee_split.model') as any;
    return JSON.stringify(p.enumValues) === JSON.stringify([...FEE_SPLIT_MODELS]);
  });
  await assert('the schema default for agent_monthly_salary is null, min 1', () => {
    const p = AgentAgencyContractModel.schema.path('fee_split.agent_monthly_salary') as any;
    const doc = new AgentAgencyContractModel({});
    return (doc as any).fee_split.agent_monthly_salary === null && p.options.min === 1;
  });
  await assert('fee_split stays agent-negotiable (the agent may propose a salary)', () =>
    (AGENT_NEGOTIABLE_TERM_GROUPS as readonly string[]).includes('fee_split')
  );

  // ─── 2. Pay arithmetic ────────────────────────────────────────────────────
  console.log('\n── 2. Pay arithmetic ───────────────────────────────────────────────');

  await assert('salary model: agent cut is 0', () => applyFeeSplit(salarySplit(150_000), 2_000) === 0);
  await assert('salary model ignores a STALE share/flat fee left from an earlier model', () =>
    applyFeeSplit(salarySplit(150_000, { agent_share_percent: 70, agent_flat_fee: 900 }), 2_000) === 0
  );
  await assert('salary model: the agency keeps the whole fee plus the COD handling fee', () =>
    computeAgencyCut(2_000, applyFeeSplit(salarySplit(150_000), 2_000), 300) === 2_300
  );
  await assert('salary model: the salary itself never leaks into the per-delivery cut (salary > fee)', () =>
    applyFeeSplit(salarySplit(10_000_000), 2_000) === 0
  );
  await assert('percentage unchanged', () => applyFeeSplit(percentSplit(20), 1_000) === 200);
  await assert('flat unchanged (clamped)', () =>
    applyFeeSplit({ ...percentSplit(0), model: 'flat', agent_flat_fee: 5_000 }, 2_000) === 2_000
  );

  await assert('EarningsSplitService.computeAgentCut → 0 for a salaried contract', async () => {
    const contracts = { findLive: async () => makeContract(salarySplit(150_000)) } as any;
    const split = new EarningsSplitService(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      contracts,
      new EarningsQuoteService({} as any, contracts)
    );
    return (await (split as any).computeAgentCut('agent-1', 'agency-1', 2_000)) === 0;
  });

  // "No zero-amount agent allocation row" rests on persist() skipping <= 0. Pin it.
  await assert('persist() still skips zero-value allocation rows (no 0 agent row under salary)', () => {
    const src = read('modules/earnings/services/earnings-split.service.ts');
    const at = src.indexOf('private async persist(');
    return at > 0 && /if \(input\.amount <= 0\) continue;/.test(src.slice(at, at + 600));
  });

  // ─── 3. Quote basis + salary echo ─────────────────────────────────────────
  console.log('\n── 3. Quote basis ──────────────────────────────────────────────────');

  await assert("basisOf(salary) === 'contract_salary'", () => basisOf(salarySplit(150_000)) === 'contract_salary');
  await assert('basisOf unchanged for percentage / flat / missing', () =>
    basisOf(percentSplit(10)) === 'contract_percentage' &&
    basisOf({ ...percentSplit(0), model: 'flat' }) === 'contract_flat' &&
    basisOf(null) === 'contract_percentage'
  );
  await assert('salaryOf echoes amount, currency and who pays', () => {
    const s = salaryOf(salarySplit(150_000));
    return !!s && s.monthlyAmount === 150_000 && s.currency === 'XAF' && s.paidBy === 'agency_off_platform';
  });
  await assert('salaryOf is null for the per-delivery models', () =>
    salaryOf(percentSplit(10)) === null && salaryOf(null) === null
  );
  await assert('both agent quote paths set `salary` beside `basis`', () => {
    const src = read('modules/earnings/services/earnings-quote.service.ts');
    return (src.match(/salary: salaryOf\(/g) ?? []).length >= 2;
  });

  // ─── 4. Validators: model/field consistency in one body ───────────────────
  console.log('\n── 4. Validators ───────────────────────────────────────────────────');

  const ok = (schema: any, body: unknown) => schema.safeParse(body).success;

  await assert('agency may invite on a salary', () =>
    ok(RequestAgentContractSchema, {
      agentId: 'a'.repeat(24),
      terms: { fee_split: { model: 'monthly_salary', agent_monthly_salary: 150_000 } },
    })
  );
  await assert('agent may apply asking for a salary', () =>
    ok(RequestToJoinSchema, {
      agencyId: 'b'.repeat(24),
      terms: { fee_split: { model: 'monthly_salary', agent_monthly_salary: 150_000 } },
    })
  );
  await assert('agent may propose a salary on a live contract', () =>
    ok(ProposeTermsChangeAsAgentSchema, {
      terms: { fee_split: { model: 'monthly_salary', agent_monthly_salary: 120_000, currency: 'xaf' } },
    })
  );
  await assert('agency counter / terms patch accepts a salary', () =>
    ok(AgencyNegotiableTermsSchema, { fee_split: { model: 'monthly_salary', agent_monthly_salary: 1 } }) &&
    ok(UpdateContractTermsSchema, { fee_split: { model: 'monthly_salary', agent_monthly_salary: 1 } })
  );
  await assert('salary 0 is refused (must be > 0)', () =>
    !ok(AgentNegotiableTermsSchema, { fee_split: { model: 'monthly_salary', agent_monthly_salary: 0 } })
  );
  await assert('fractional salary is refused (minor units are integers)', () =>
    !ok(AgentNegotiableTermsSchema, { fee_split: { model: 'monthly_salary', agent_monthly_salary: 100.5 } })
  );
  await assert('salary model + a share in the same body → 400', () =>
    !ok(AgentNegotiableTermsSchema, {
      fee_split: { model: 'monthly_salary', agent_monthly_salary: 100_000, agent_share_percent: 20 },
    })
  );
  await assert('percentage model + a salary in the same body → 400', () =>
    !ok(AgencyNegotiableTermsSchema, {
      fee_split: { model: 'percentage', agent_share_percent: 20, agent_monthly_salary: 100_000 },
    })
  );
  await assert('flat model + a salary in the same body → 400', () =>
    !ok(UpdateContractTermsSchema, {
      fee_split: { model: 'flat', agent_flat_fee: 500, agent_monthly_salary: 100_000 },
    })
  );
  await assert('other models\' fields may be sent as explicit null', () =>
    ok(AgentNegotiableTermsSchema, {
      fee_split: { model: 'monthly_salary', agent_monthly_salary: 100_000, agent_share_percent: null, agent_flat_fee: null },
    })
  );
  await assert('a body naming no model may still set the salary (merged later in the service)', () =>
    ok(AgentNegotiableTermsSchema, { fee_split: { agent_monthly_salary: 100_000 } })
  );
  await assert('an unknown model is refused', () =>
    !ok(AgentNegotiableTermsSchema, { fee_split: { model: 'hourly' } })
  );
  await assert('existing percentage / flat bodies still parse', () =>
    ok(AgentNegotiableTermsSchema, { fee_split: { model: 'percentage', agent_share_percent: 60 } }) &&
    ok(AgentNegotiableTermsSchema, { fee_split: { model: 'flat', agent_flat_fee: 500 } })
  );

  // ─── 5. Service coherence (merged over the stored split) ──────────────────
  console.log('\n── 5. Service coherence ────────────────────────────────────────────');

  await assert('salary model with no salary → CONTRACT_FEE_SPLIT_INVALID', () =>
    coherenceCode({ model: 'monthly_salary' }, percentSplit(20)) === 'CONTRACT_FEE_SPLIT_INVALID'
  );
  await assert('salary model with explicit null salary → CONTRACT_FEE_SPLIT_INVALID', () =>
    coherenceCode({ model: 'monthly_salary', agent_monthly_salary: null }, percentSplit(20)) ===
    'CONTRACT_FEE_SPLIT_INVALID'
  );
  await assert('salary model with a salary is coherent', () =>
    coherenceCode({ model: 'monthly_salary', agent_monthly_salary: 150_000 }, percentSplit(20)) === null
  );
  await assert('switching to salary when the stored split already carries one is coherent', () =>
    coherenceCode({ model: 'monthly_salary' }, { ...percentSplit(20), agent_monthly_salary: 90_000 }) === null
  );
  await assert('a stored salary split is approvable (empty patch) …', () =>
    coherenceCode({}, salarySplit(150_000)) === null
  );
  await assert('… and a stored salary split with no figure is not', () =>
    coherenceCode({}, salarySplit(null)) === 'CONTRACT_FEE_SPLIT_INVALID'
  );
  await assert('switching salary → percentage without a share is still refused', () =>
    coherenceCode({ model: 'percentage' }, salarySplit(150_000)) === 'CONTRACT_FEE_SPLIT_INVALID'
  );

  await assert('end to end: an agency counter on a pending contract with a bare salary model is refused', async () => {
    try {
      await makeTermsService(makeContract(percentSplit(20), { status: 'pending' })).updateTerms(
        'agency-1',
        'contract-1',
        { fee_split: { model: 'monthly_salary' } } as any,
        { userId: 'user-1', role: 'agency' } as any
      );
      return false;
    } catch (err) {
      return (err as AppError).code === 'CONTRACT_FEE_SPLIT_INVALID';
    }
  });

  // ─── 6. DTO ───────────────────────────────────────────────────────────────
  console.log('\n── 6. DTO ──────────────────────────────────────────────────────────');

  await assert('membership DTO exposes agentMonthlySalary', () => {
    const dto: any = AgentMembershipMapper.toDto(makeContract(salarySplit(150_000)) as any);
    return dto.feeSplit?.model === 'monthly_salary' && dto.feeSplit.agentMonthlySalary === 150_000;
  });
  await assert('membership DTO renders null salary on a legacy split without the key', () => {
    const legacy: any = { model: 'percentage', agent_share_percent: 30, agent_flat_fee: null, currency: 'XAF' };
    const dto: any = AgentMembershipMapper.toDto(makeContract(legacy) as any);
    return dto.feeSplit?.agentMonthlySalary === null;
  });

  // ─── 7. Analytics attribution ─────────────────────────────────────────────
  console.log('\n── 7. Delivery analytics ───────────────────────────────────────────');

  await assert('analytics attributes a run with no agent row to shipment.agent_id', () => {
    const src = read('modules/earnings/analytics/delivery-analytics.service.ts');
    return src.includes("select('delivery_fee_snapshot agent_id')") && src.includes('agentOfShipment.get(');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
