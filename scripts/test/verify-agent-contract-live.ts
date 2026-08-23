/**
 * verify:agent-contract — the seven scenarios the agent-contract refactor owed,
 * against REAL Mongo. **NEEDS Mongo, and needs it as a REPLICA SET** (three of
 * the seven run inside a transaction; `rs0` is what dev already runs).
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 *
 * `AGENT-CONTRACT-REFACTOR.md` has carried two open verification items since the
 * build finished: *"the 7 named scenarios, incl. the §1 worked example and the
 * concurrent-allocation race"* and *"E2E against live Mongo"*. This is the first;
 * `verify:agent-e2e` is the second. Together they are the last thing holding the
 * refactor banner in `CLAUDE.md`, other than the trust cutover.
 *
 * `test:agent-domain` is green at 211 and covers none of this. It is **DB-free by
 * construction** — its repositories are stubs — so every guard below that is
 * enforced by a *query filter* rather than by an `if` is, to that suite,
 * invisible. Those guards are exactly the ones that hold money:
 *
 *   - `tryReserveCapacity` is one `findOneAndUpdate` with `$expr: {$lt: [...]}`.
 *     A stub returns whatever it was told to. Only a real concurrent race can
 *     say whether the counter admits N or N+3.
 *   - `adjustOutstandingBalance` and `recordSettlement` guard on
 *     `{$gte: amount}` in the FILTER. A stub cannot fail that filter.
 *   - `debitInSession` guards on `balance: {$gte: amount}` in the filter, and
 *     `appendLedger` runs after it in the same transaction. Whether a rejected
 *     debit leaves a ledger row behind is a property of the transaction, not of
 *     the code path.
 *
 * ── What "the 7 scenarios" are ────────────────────────────────────────────────
 *
 * The enumerations the doc points at (its §7 and §8) were rewritten away long
 * before the items were built, so these are reconstructed from the invariants the
 * refactor actually locked, in `AGENT-CONTRACT-REFACTOR.md` § "Decisions locked"
 * and the three docstring invariants at the head of `AgentContractService`:
 *
 *   1. The concurrent-allocation race — capacity admits exactly `max`.
 *   2. The shared pool cannot be over-committed, from EITHER direction.
 *   3. Lowering a threshold below what is held is a hard rejection with NO
 *      side effects.
 *   4. The COD cash chain: collect raises, deposit lowers, and the two
 *      invariants that hold exactly (balance == Σ ledger; Σ slices == pot).
 *   5. Termination cannot strand cash or wages, and the re-check at approval is
 *      what closes the settlement-vs-deactivation race.
 *   6. Pausing does NOT free the pool — so reactivation can never fail.
 *   7. Platform ban is an override, not a cascade.
 *
 * ⚠ Number 5's second half and number 7 are the two the refactor doc lists under
 * "Known-and-accepted, not tracked as refactor debt" as *unverified*. They are
 * verified here.
 *
 * ── The §1 worked example ─────────────────────────────────────────────────────
 *
 * Scenario 2 IS it, with the numbers: an agent with a 1 000 000 pool and three
 * agencies each wanting 1 000 000. The pre-refactor model (`cod.max_exposure_override`,
 * an independent per-agency cap) granted all three, and the platform discovered
 * 3 000 000 of real exposure when the cash went missing. A pool cannot be
 * over-committed by construction, and this asserts that in the database.
 *
 * ── Safety ────────────────────────────────────────────────────────────────────
 *
 * Every id is freshly minted and references nothing. The suite writes only
 * documents it created and deletes them in a `finally`, pass or fail. It never
 * reads or writes a real agent, agency, contract, collection or ledger row.
 *
 * Run: npm run verify:agent-contract
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';
import { DeliveryAgentModel } from '../../src/modules/agents/models/agent.model';
import { AgentAgencyContractModel } from '../../src/modules/agents/models/agent-agency-membership.model';
import { CodCashAccountModel } from '../../src/modules/cod/models/cod-cash-account.model';
import { CodCashLedgerModel } from '../../src/modules/cod/models/cod-cash-ledger.model';
import { agentCapacityService } from '../../src/modules/agents/domain/services/agent-capacity.service';
import { agentCodThresholdService } from '../../src/modules/agents/domain/services/agent-cod-threshold.service';
import { agentContractService } from '../../src/modules/agents/domain/services/agent-contract.service';
import { agentGateService } from '../../src/modules/agents/domain/services/agent-gate.service';
import { agentContractRepository } from '../../src/modules/agents/repositories/agent-contract.repository';
import { codCashAccountService } from '../../src/modules/cod/services/cod-cash-account.service';
import { codExposureService } from '../../src/modules/cod/services/cod-exposure.service';
import { codTrustService } from '../../src/modules/cod/services/cod-trust.service';
import { CodTrustEventModel } from '../../src/modules/cod/models/cod-trust-event.model';
import { agentRepository } from '../../src/modules/agents/repositories/agent.repository';
import { transactionManager } from '../../src/core/database/transaction.manager';
import { ERROR_CODES } from '../../src/core/error-codes';

let passed = 0;
let failed = 0;

function assert(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`);
    failed++;
  }
}

/** Run `fn` and report the AppError code it threw, or null if it did not throw. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}

// ── Fixtures. Every id is minted here and referenced by nothing real. ────────
const AGENT = new Types.ObjectId();
const AGENCY_A = new Types.ObjectId();
const AGENCY_B = new Types.ObjectId();
const AGENCY_C = new Types.ObjectId();
const USER = new Types.ObjectId();
const ACTOR_USER = new Types.ObjectId();

/** A platform-source actor stamp — the ban writes three fields from one call. */
const BAN_ACTOR = { userId: ACTOR_USER.toString(), source: 'platform' as const, role: 'admin', name: 'verify:agent-contract' };

/**
 * An ADMIN-source stamp, for the trust override.
 *
 * ⚠ The two sources are not interchangeable and this fixture pair is the point:
 * `source` says which DATABASE the id resolves in. An administrator holds no row
 * in jovi-mall at all, so an override stamped 'platform' sends a future reader
 * looking for a `users` document that was never there.
 */
const ADMIN_ACTOR = { userId: ACTOR_USER.toString(), source: 'admin' as const, role: 'admin', name: 'An Administrator' };

const MINTED_AGENCIES = [AGENCY_A, AGENCY_B, AGENCY_C];

/** A million, the §1 worked example's number. */
const POOL = 1_000_000;

async function makeAgent(overrides: Record<string, unknown> = {}): Promise<void> {
  await DeliveryAgentModel.deleteOne({ _id: AGENT });
  await DeliveryAgentModel.create({
    _id: AGENT,
    user_id: USER,
    name: 'verify:agent-contract fixture',
    status: 'active',
    kyc: { status: 'verified', verified_at: new Date() },
    capacity: { max_active_shipments: 3, active_shipment_count: 0 },
    cod: { trust_score: 100, max_threshold: POOL },
    ...overrides,
  });
}

async function makeContract(
  agencyId: Types.ObjectId,
  status: 'pending' | 'active' | 'paused' | 'suspended' | 'deactivated',
  threshold: number
): Promise<string> {
  const contract = await agentContractRepository.create({
    agentId: AGENT.toString(),
    agencyId: agencyId.toString(),
    status,
    origin: 'admin',
    codThreshold: threshold,
  });
  return contract._id.toString();
}

async function cleanup(): Promise<void> {
  await DeliveryAgentModel.deleteOne({ _id: AGENT });
  await AgentAgencyContractModel.deleteMany({ agent_id: AGENT });
  await CodCashAccountModel.deleteMany({ owner_id: { $in: [AGENT.toString(), ...MINTED_AGENCIES.map((a) => a.toString())] } });
  await CodCashLedgerModel.deleteMany({ owner_id: { $in: [AGENT.toString(), ...MINTED_AGENCIES.map((a) => a.toString())] } });
  await CodTrustEventModel.deleteMany({ agent_id: AGENT });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The concurrent-allocation race
// ─────────────────────────────────────────────────────────────────────────────
async function scenario1Race(): Promise<void> {
  console.log('\n── 1 · The concurrent-allocation race ──────────────────────────────────\n');
  console.log('   The one `test:agent-domain` names in its own header as out of reach.\n');

  await makeAgent({ capacity: { max_active_shipments: 3, active_shipment_count: 0 } });

  // Ten simultaneous reservations against a cap of three. A read-then-write
  // would let most of them through: every reader sees 0 < 3.
  const ATTEMPTS = 10;
  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, () => agentCapacityService.tryReserve(AGENT.toString()))
  );
  const admitted = results.filter(Boolean).length;

  assert(
    `${ATTEMPTS} simultaneous reservations against a cap of 3 admit EXACTLY 3`,
    admitted === 3,
    `admitted ${admitted}`
  );

  const afterRace = await DeliveryAgentModel.findById(AGENT);
  assert(
    '…and the counter reads 3, not 10 — the $expr guard is what refuses, not a re-read',
    afterRace?.capacity?.active_shipment_count === 3,
    `counter = ${afterRace?.capacity?.active_shipment_count}`
  );

  // The mirror image: releases must not drive the counter below zero, because a
  // negative counter hands the agent free capacity forever.
  await Promise.all(
    Array.from({ length: 6 }, () => agentCapacityService.release(AGENT.toString(), 'delivered'))
  );
  const afterRelease = await DeliveryAgentModel.findById(AGENT);
  assert(
    '6 concurrent releases against 3 held slots floor the counter at 0, never negative',
    afterRelease?.capacity?.active_shipment_count === 0,
    `counter = ${afterRelease?.capacity?.active_shipment_count}`
  );

  // reconcile() is the backstop for drift, and drift is the only thing it may
  // touch: an agent whose counter already agrees with reality must come out
  // unchanged rather than "corrected".
  await DeliveryAgentModel.updateOne({ _id: AGENT }, { $set: { 'capacity.active_shipment_count': 2 } });
  const drifted = await agentCapacityService.reconcile(AGENT.toString());
  assert('reconcile() reports the drift it found', drifted.before === 2 && drifted.drifted === true);
  const clean = await agentCapacityService.reconcile(AGENT.toString());
  assert('…and a second run is a no-op — reconcile does not oscillate', clean.drifted === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · The shared pool cannot be over-committed — the §1 worked example
// ─────────────────────────────────────────────────────────────────────────────
async function scenario2Pool(): Promise<void> {
  console.log('\n── 2 · The §1 worked example — three agencies, one pool ────────────────\n');
  console.log('   Pre-refactor: three independent caps of 1 000 000 each = 3 000 000 of');
  console.log('   real exposure the platform only discovered when the cash went missing.\n');

  await makeAgent();
  await AgentAgencyContractModel.deleteMany({ agent_id: AGENT });

  const contractA = await makeContract(AGENCY_A, 'active', 0);
  const contractB = await makeContract(AGENCY_B, 'active', 0);
  const contractC = await makeContract(AGENCY_C, 'active', 0);

  // Agency A takes the whole pool.
  await agentCodThresholdService.setContractThreshold(AGENT.toString(), contractA, POOL);
  const afterA = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert('agency A allocates the whole 1 000 000 pool', afterA.allocated === POOL);
  assert('…leaving zero headroom', afterA.headroom === 0);

  // B and C ask for the same million. Under the old model both were granted.
  const codeB = await codeOf(() =>
    agentCodThresholdService.setContractThreshold(AGENT.toString(), contractB, POOL)
  );
  assert(
    'agency B asking for the same 1 000 000 is REFUSED',
    codeB === ERROR_CODES.CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM,
    `got ${codeB}`
  );
  const codeC = await codeOf(() =>
    agentCodThresholdService.setContractThreshold(AGENT.toString(), contractC, 1)
  );
  assert('…and so is agency C asking for 1', codeC === ERROR_CODES.CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM);

  const afterRefusals = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert('the total exposure is still 1 000 000, not 2 000 001', afterRefusals.allocated === POOL);

  // The other direction — the agent lowering their own pool beneath what is
  // already allocated. Same invariant, opposite actor.
  const codeLower = await codeOf(() => agentCodThresholdService.setAgentThreshold(AGENT.toString(), POOL - 1));
  assert(
    'the AGENT lowering the pool below what is allocated is refused too',
    codeLower === ERROR_CODES.AGENT_COD_THRESHOLD_BELOW_ALLOCATED,
    `got ${codeLower}`
  );

  const agentAfter = await DeliveryAgentModel.findById(AGENT);
  assert('…and the refusal wrote NOTHING — the pool is untouched', agentAfter?.cod?.max_threshold === POOL);

  // ⚠ A contract can never exceed CONTRACT_COD_THRESHOLD_MAX (1 000 000) however
  // large the pool is — the per-contract ceiling and the pool are two separate
  // bounds, and `assertContractThresholdAllowed` checks the ceiling FIRST. So the
  // §1 example above is simultaneously the pool being full and one contract at
  // its own maximum, which is worth knowing before reading the next assertions.
  const ceilingCode = await codeOf(() =>
    agentCodThresholdService.setContractThreshold(AGENT.toString(), contractA, POOL + 1)
  );
  assert(
    'a contract above the per-contract ceiling is refused for THAT reason, not for headroom',
    ceilingCode === ERROR_CODES.CONTRACT_COD_THRESHOLD_OUT_OF_BOUNDS,
    `got ${ceilingCode}`
  );

  // Raising the pool is what unblocks the other agencies.
  await agentCodThresholdService.setAgentThreshold(AGENT.toString(), 1_200_000);
  await agentCodThresholdService.setContractThreshold(AGENT.toString(), contractA, 600_000);
  await agentCodThresholdService.setContractThreshold(AGENT.toString(), contractB, 200_000);
  const shared = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert('a raised pool lets a second agency in', shared.allocated === 800_000 && shared.headroom === 400_000);

  // A contract's own slice must NOT compete with itself. Raising A from 600k to
  // 900k needs 300k of headroom — and under a naive rule that counts A's own
  // 600k against it, the headroom would read 400k and this would be refused.
  await agentCodThresholdService.setContractThreshold(AGENT.toString(), contractA, 900_000);
  const afterRaise = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert(
    'raising a contract does not treat its own slice as competing with itself',
    afterRaise.allocated === 1_100_000 && afterRaise.headroom === 100_000,
    `allocated ${afterRaise.allocated} headroom ${afterRaise.headroom}`
  );

  // …and the pool still binds: 100k of headroom, so C may take 100k and not 101k.
  const overCode = await codeOf(() =>
    agentCodThresholdService.setContractThreshold(AGENT.toString(), contractC, 100_001)
  );
  assert('one shilling past the headroom is still refused', overCode === ERROR_CODES.CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM);
  const exact = await agentCodThresholdService.setContractThreshold(AGENT.toString(), contractC, 100_000);
  assert('…and exactly the headroom is allowed', exact.threshold === 100_000 && exact.headroomAfter === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Lowering below what is HELD is refused, with no side effects
// ─────────────────────────────────────────────────────────────────────────────
async function scenario3BelowOutstanding(): Promise<void> {
  console.log('\n── 3 · A threshold beneath the cash already in hand ────────────────────\n');

  await makeAgent();
  await AgentAgencyContractModel.deleteMany({ agent_id: AGENT });
  const contract = await makeContract(AGENCY_A, 'active', 500_000);

  // The agent is holding 300 000 of this agency's cash.
  await agentContractRepository.adjustOutstandingBalance(contract, 300_000);

  const code = await codeOf(() => agentCodThresholdService.setContractThreshold(AGENT.toString(), contract, 200_000));
  assert(
    'lowering the contract threshold below its outstanding balance is refused',
    code === ERROR_CODES.CONTRACT_COD_THRESHOLD_BELOW_OUTSTANDING,
    `got ${code}`
  );

  const after = await AgentAgencyContractModel.findById(contract);
  assert('…and NOTHING was written — the threshold is unchanged', after?.cod?.threshold === 500_000);
  assert('…and the balance is unchanged', after?.cod?.outstanding_balance === 300_000);

  // Lowering to exactly what is held is allowed — the boundary, which an `if
  // (threshold < outstanding)` and an `if (threshold <= outstanding)` disagree
  // about and no DB-free stub can settle.
  const ok = await agentCodThresholdService.setContractThreshold(AGENT.toString(), contract, 300_000);
  assert('lowering to EXACTLY the outstanding balance is allowed', ok.threshold === 300_000);

  // And the balance guard itself: a settlement larger than the balance must fail
  // the FILTER, not write a negative.
  const over = await agentContractRepository.recordSettlement(contract, 300_001);
  assert('a settlement larger than the balance matches nothing (returns null)', over === null);
  const stillThere = await AgentAgencyContractModel.findById(contract);
  assert('…and the balance did not go negative', stillThere?.cod?.outstanding_balance === 300_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · The COD cash chain, and the two invariants that hold EXACTLY
// ─────────────────────────────────────────────────────────────────────────────
async function scenario4CashChain(): Promise<void> {
  console.log('\n── 4 · The cash chain: collect raises, deposit lowers ──────────────────\n');
  console.log('   ⚠ Asserting the two invariants the refactor doc says hold exactly —');
  console.log('   NOT the re-derivation sum(collected) − sum(deposits), which it warns');
  console.log('   disagrees with the application because the ledger is append-only.\n');

  await makeAgent();
  await AgentAgencyContractModel.deleteMany({ agent_id: AGENT });
  await CodCashAccountModel.deleteMany({ owner_type: 'agent', owner_id: AGENT.toString() });
  await CodCashLedgerModel.deleteMany({ owner_id: AGENT.toString() });

  const contractA = await makeContract(AGENCY_A, 'active', 400_000);
  const contractB = await makeContract(AGENCY_B, 'active', 400_000);

  // Two collections under A, one under B — the agent's pot is the person's,
  // across every agency; the slices are per-contract.
  await transactionManager.runInTransaction(async (session) => {
    await codCashAccountService.creditInSession(
      'agent', AGENT.toString(), 120_000, 'XAF', 'collection', 'cash_collection', new Types.ObjectId().toString(), session
    );
    await agentContractRepository.adjustOutstandingBalance(contractA, 120_000, session);
  });
  await transactionManager.runInTransaction(async (session) => {
    await codCashAccountService.creditInSession(
      'agent', AGENT.toString(), 80_000, 'XAF', 'collection', 'cash_collection', new Types.ObjectId().toString(), session
    );
    await agentContractRepository.adjustOutstandingBalance(contractA, 80_000, session);
  });
  await transactionManager.runInTransaction(async (session) => {
    await codCashAccountService.creditInSession(
      'agent', AGENT.toString(), 50_000, 'XAF', 'collection', 'cash_collection', new Types.ObjectId().toString(), session
    );
    await agentContractRepository.adjustOutstandingBalance(contractB, 50_000, session);
  });

  const potAfterCollect = await codCashAccountService.getBalance('agent', AGENT.toString());
  assert('the pot holds 250 000 across both agencies', potAfterCollect.balance === 250_000);

  // Invariant 1: balance == Σ its ledger rows.
  const ledgerRows = await CodCashLedgerModel.find({ owner_type: 'agent', owner_id: AGENT.toString() });
  const ledgerSum = ledgerRows.reduce((sum, row) => sum + row.amount, 0);
  assert(
    'INVARIANT · cod_cash_accounts.balance == Σ its ledger rows',
    ledgerSum === potAfterCollect.balance,
    `ledger Σ ${ledgerSum} vs balance ${potAfterCollect.balance}`
  );

  // Invariant 2: Σ contract slices == the agent's pot.
  const allocation = await agentCodThresholdService.getAllocation(AGENT.toString());
  const sliceSum = allocation.contracts.reduce((sum, c) => sum + c.outstandingBalance, 0);
  assert(
    'INVARIANT · Σ contract slices == the agent\'s pot',
    sliceSum === potAfterCollect.balance,
    `slices Σ ${sliceSum} vs pot ${potAfterCollect.balance}`
  );

  // Settle 200 000 of A. Both halves move, in one transaction.
  await transactionManager.runInTransaction(async (session) => {
    await codCashAccountService.debitInSession(
      'agent', AGENT.toString(), 200_000, 'deposit', 'agent_deposit', new Types.ObjectId().toString(), session
    );
    const settled = await agentContractRepository.recordSettlement(contractA, 200_000, session);
    if (!settled) throw new Error('settlement filter did not match');
  });

  const potAfterDeposit = await codCashAccountService.getBalance('agent', AGENT.toString());
  assert('a 200 000 deposit draws the pot down to 50 000', potAfterDeposit.balance === 50_000);

  const contractAAfter = await AgentAgencyContractModel.findById(contractA);
  assert("…contract A's slice is back to zero", contractAAfter?.cod?.outstanding_balance === 0);
  assert('…and lifetime_settled recorded the 200 000', contractAAfter?.cod?.lifetime_settled === 200_000);

  const contractBAfter = await AgentAgencyContractModel.findById(contractB);
  assert("…while agency B's 50 000 is untouched — slices are per-contract", contractBAfter?.cod?.outstanding_balance === 50_000);

  const rowsAfter = await CodCashLedgerModel.find({ owner_type: 'agent', owner_id: AGENT.toString() });
  assert(
    'INVARIANT · balance == Σ ledger still holds after the debit',
    rowsAfter.reduce((sum, r) => sum + r.amount, 0) === potAfterDeposit.balance
  );

  // The guard that matters most: an over-deposit is REFUSED, and — because the
  // ledger append runs after the guarded update in the same transaction — it
  // must leave no row behind.
  const rowsBefore = rowsAfter.length;
  const overCode = await codeOf(() =>
    transactionManager.runInTransaction(async (session) => {
      await codCashAccountService.debitInSession(
        'agent', AGENT.toString(), 50_001, 'deposit', 'agent_deposit', new Types.ObjectId().toString(), session
      );
    })
  );
  assert('depositing more than is held is refused', overCode === ERROR_CODES.COD_DEPOSIT_EXCEEDS_BALANCE, `got ${overCode}`);

  const rowsAfterRefusal = await CodCashLedgerModel.countDocuments({ owner_type: 'agent', owner_id: AGENT.toString() });
  assert('…and the refused debit left NO ledger row behind', rowsAfterRefusal === rowsBefore);

  const potAfterRefusal = await codCashAccountService.getBalance('agent', AGENT.toString());
  assert('…and the balance is untouched', potAfterRefusal.balance === 50_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Termination cannot strand cash or wages — and the race at approval
// ─────────────────────────────────────────────────────────────────────────────
async function scenario5Termination(): Promise<void> {
  console.log('\n── 5 · Termination, and the settlement-vs-deactivation race ────────────\n');
  console.log('   The refactor doc lists this race under "Known-and-accepted … unverified".\n');

  await makeAgent();
  await AgentAgencyContractModel.deleteMany({ agent_id: AGENT });
  const contractA = await makeContract(AGENCY_A, 'active', 400_000);
  const contractB = await makeContract(AGENCY_B, 'active', 400_000);

  // Agent holds 90 000 under A; owed 15 000 by B.
  await agentContractRepository.adjustOutstandingBalance(contractA, 90_000);
  await agentContractRepository.adjustOutstandingPayment(contractB, 15_000);

  const a = await AgentAgencyContractModel.findById(contractA);
  const b = await AgentAgencyContractModel.findById(contractB);

  const blockersA = await agentContractService.evaluateDeactivationBlockers(a!);
  assert('cash held under A blocks A', blockersA.clear === false && blockersA.outstandingCod === 90_000);

  const blockersB = await agentContractService.evaluateDeactivationBlockers(b!);
  assert('wages owed by B block B — a different condition, same gate', blockersB.clear === false && blockersB.outstandingPayment === 15_000);

  // Contract-scoped, not global: cash owed to A is none of B's business, and
  // this is §1's resolution replacing the old global block.
  assert("…and A's cash does NOT appear in B's blockers", blockersB.outstandingCod === 0);
  assert("…nor B's wages in A's", blockersA.outstandingPayment === 0);

  // ── The race. This is the sequence the doc says is handled "in principle".
  //
  // A deactivation request is raised while the contract is clear. Cash is then
  // collected before anyone approves it. The re-check at approval time is the
  // only thing standing between that and a contract terminated while the agent
  // holds the agency's money.
  await agentContractRepository.recordSettlement(contractA, 90_000);
  const clearedA = await AgentAgencyContractModel.findById(contractA);
  const clearBlockers = await agentContractService.evaluateDeactivationBlockers(clearedA!);
  assert('with both at zero the contract is terminable', clearBlockers.clear === true);

  const { request } = await agentContractService.requestTransition(
    contractA,
    'deactivate',
    'agent',
    { userId: ACTOR_USER.toString(), role: 'agent' }
  );
  const requestId = request._id.toString();

  assert('a deactivation request is accepted while the contract is clear', request.state === 'pending');
  assert(
    '…and records NO blocking conditions, because there were none',
    request.blocking_conditions === null || request.blocking_conditions === undefined
  );

  const stillActive = await AgentAgencyContractModel.findById(contractA);
  assert('…and the contract is still active — deactivate requires the counterparty', stillActive?.status === 'active');

  // …and now the cash arrives, between the request and its approval.
  await agentContractRepository.adjustOutstandingBalance(contractA, 45_000);

  const raceCode = await codeOf(() =>
    agentContractService.resolveRequest(requestId, 'approve', { userId: ACTOR_USER.toString(), role: 'agency' })
  );
  assert(
    'RACE · approving it now is REFUSED — the blockers are re-checked at approval',
    raceCode === ERROR_CODES.CONTRACT_HAS_OUTSTANDING_COD,
    `got ${raceCode}`
  );

  const survived = await AgentAgencyContractModel.findById(contractA);
  assert('…and the contract survived — no termination stranded the cash', survived?.status === 'active');

  const reRead = await agentContractService.evaluateDeactivationBlockers(survived!);
  assert('…with the 45 000 named as what is in the way', reRead.outstandingCod === 45_000);

  // Settle it and the same request goes through — the guard is a condition, not
  // a permanent refusal.
  await agentContractRepository.recordSettlement(contractA, 45_000);
  const { contract: terminated } = await agentContractService.resolveRequest(
    requestId,
    'approve',
    { userId: ACTOR_USER.toString(), role: 'agency' }
  );
  assert('once the cash is settled the SAME request approves', terminated?.status === 'deactivated');

  // And the pool consequence: a deactivated contract stops allocating, which it
  // can only do safely because termination required zero.
  const allocationAfter = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert(
    "…and the terminated contract's slice left the pool",
    allocationAfter.contracts.every((c) => c.contractId !== contractA)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Pausing does NOT free the pool
// ─────────────────────────────────────────────────────────────────────────────
async function scenario6Pause(): Promise<void> {
  console.log('\n── 6 · Pausing keeps its slice, so reactivation can never fail ─────────\n');

  await makeAgent();
  await AgentAgencyContractModel.deleteMany({ agent_id: AGENT });

  const contractA = await makeContract(AGENCY_A, 'active', 600_000);
  const contractB = await makeContract(AGENCY_B, 'active', 400_000);

  const before = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert('both contracts allocate — 1 000 000 of a 1 000 000 pool', before.allocated === POOL && before.headroom === 0);

  // Pause A. Under a naive "only active allocates" rule this frees 600 000.
  await AgentAgencyContractModel.updateOne({ _id: contractA }, { $set: { status: 'paused' } });
  const paused = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert('a PAUSED contract still allocates — the pool did not move', paused.allocated === POOL);
  assert('…so there is still no headroom for anyone else', paused.headroom === 0);

  // Suspended too.
  await AgentAgencyContractModel.updateOne({ _id: contractA }, { $set: { status: 'suspended' } });
  const suspended = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert('a SUSPENDED contract still allocates', suspended.allocated === POOL);

  // …and the consequence that follows: reactivating cannot fail a headroom
  // check, because the slice never left the sum.
  await AgentAgencyContractModel.updateOne({ _id: contractA }, { $set: { status: 'active' } });
  const reactivated = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert('reactivating is arithmetically free — the slice never left', reactivated.allocated === POOL);

  // The two that do NOT allocate, for contrast.
  await AgentAgencyContractModel.updateOne({ _id: contractB }, { $set: { status: 'pending' } });
  const pending = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert('a PENDING contract does not allocate — it was never approved', pending.allocated === 600_000);

  await AgentAgencyContractModel.updateOne({ _id: contractB }, { $set: { status: 'deactivated' } });
  const deactivated = await agentCodThresholdService.getAllocation(AGENT.toString());
  assert('a DEACTIVATED contract does not allocate — termination required zero', deactivated.allocated === 600_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7 · Platform ban is an override, not a cascade
// ─────────────────────────────────────────────────────────────────────────────
async function scenario7Ban(): Promise<void> {
  console.log('\n── 7 · Platform ban overrides; it does not walk the contracts ──────────\n');
  console.log('   A cascade is lossy: un-banning could not restore which were already paused.\n');

  await makeAgent();
  await AgentAgencyContractModel.deleteMany({ agent_id: AGENT });
  const contractA = await makeContract(AGENCY_A, 'active', 300_000);
  const contractB = await makeContract(AGENCY_B, 'paused', 300_000);

  const gateBefore = await agentGateService.evaluate(AGENT.toString());
  assert('an unbanned, KYC-verified agent passes the gate', gateBefore.passed === true);

  await agentGateService.setPlatformBan(AGENT.toString(), true, 'verify:agent-contract fixture', BAN_ACTOR);

  const gateAfter = await agentGateService.evaluate(AGENT.toString());
  assert('the banned agent fails the gate', gateAfter.passed === false && gateAfter.banned === true);
  assert('…with `platform_banned` named as the failure', gateAfter.failures.includes('platform_banned'));

  // The cascade that must NOT have happened.
  const aAfter = await AgentAgencyContractModel.findById(contractA);
  const bAfter = await AgentAgencyContractModel.findById(contractB);
  assert('the ACTIVE contract is still active — no cascade', aAfter?.status === 'active');
  assert('the PAUSED contract is still paused — its state is preserved, not overwritten', bAfter?.status === 'paused');

  // Reactivating while banned WRITES active, and the agent stays unusable. This
  // is the locked decision stated exactly: the write succeeds, the gate refuses.
  await AgentAgencyContractModel.updateOne({ _id: contractB }, { $set: { status: 'active' } });
  const reactivatedWhileBanned = await AgentAgencyContractModel.findById(contractB);
  assert('a contract reactivated while banned WRITES active', reactivatedWhileBanned?.status === 'active');

  const gateStill = await agentGateService.evaluate(AGENT.toString());
  assert('…and the agent is still unusable — the gate consults the flag, not the contracts', gateStill.passed === false);

  const banCode = await codeOf(() => agentGateService.assertCanHoldContract(AGENT.toString()));
  assert('assertCanHoldContract refuses a banned agent', banCode === ERROR_CODES.AGENT_PLATFORM_BANNED, `got ${banCode}`);

  // Un-banning restores exactly what was there — which a cascade could not do.
  await agentGateService.setPlatformBan(AGENT.toString(), false, null, BAN_ACTOR);
  const gateRestored = await agentGateService.evaluate(AGENT.toString());
  assert('un-banning restores the agent', gateRestored.passed === true);

  const aRestored = await AgentAgencyContractModel.findById(contractA);
  assert('…and every contract is exactly where it was', aRestored?.status === 'active');

  // KYC is the other half of the same gate, and it is evaluated independently.
  await DeliveryAgentModel.updateOne({ _id: AGENT }, { $set: { 'kyc.status': 'rejected' } });
  const kycGate = await agentGateService.evaluate(AGENT.toString());
  assert('an unverified KYC fails the gate on its own', kycGate.passed === false && kycGate.failures.includes('kyc_not_verified'));
  assert('…and does NOT report a ban it does not have', kycGate.banned === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8 · The administrator's persistent trust override (O-7)
// ─────────────────────────────────────────────────────────────────────────────
async function scenario8TrustOverride(): Promise<void> {
  console.log('\n── 8 · The trust override outranks the computed score ──────────────────\n');
  console.log('   O-7\'s answer, and the thing that makes the trust cutover safe: a');
  console.log('   recompute may write anything it likes, and an administrator\'s pin');
  console.log('   still decides. Asserted against real persistence because the whole');
  console.log('   claim is about what SURVIVES a write.\n');

  await makeAgent();

  const full = await DeliveryAgentModel.findById(AGENT);
  assert(
    'an agent with no override is at their computed score',
    codExposureService.effectiveLimit(full!, 500_000) === 500_000,
    'a trust of 100 should scale the agency cap by 1',
  );

  // Pin them into the BLOCKED tier while the computed score stays at 100 — the
  // exact shape of the case Phase 6 Step 11 measured and refused to flip on.
  await codTrustService.setOverride({
    agentId: AGENT.toString(),
    score: 35,
    reason: 'verify:agent-contract — cash shortfall under investigation',
    actor: ADMIN_ACTOR,
  });

  const pinned = await DeliveryAgentModel.findById(AGENT);
  assert(
    'the computed score is UNTOUCHED by pinning — the two are separate axes',
    pinned?.cod?.trust_score === 100,
    `trust_score = ${pinned?.cod?.trust_score}`,
  );
  assert('…and the override is stored with its reason', pinned?.cod?.trust_override?.score === 35);
  assert(
    '…and an actor stamp, because an administrator resolves in no table here',
    pinned?.cod?.trust_override?.set_by_source === 'admin',
    `set_by_source = ${pinned?.cod?.trust_override?.set_by_source}`,
  );

  assert(
    'the exposure limit collapses to ZERO — the pin, not the computed 100, decides',
    codExposureService.effectiveLimit(pinned!, 500_000) === 0,
    `limit = ${codExposureService.effectiveLimit(pinned!, 500_000)}`,
  );

  const refusal = await codeOf(() => codExposureService.assertCanTakeCodShipment(pinned!, 1, 500_000));
  assert(
    'a COD assignment is refused for trust, on the pinned number',
    refusal === ERROR_CODES.COD_AGENT_TRUST_TOO_LOW,
    `got ${refusal}`,
  );

  // ⚠ THE PROPERTY THE CUTOVER DEPENDS ON. A recompute writes the computed score;
  // the override must be untouched by it. Simulated with the real repository
  // method the worker calls, so this is the actual write path.
  await agentRepository.setTrustScore(AGENT.toString(), 100, {});
  const afterRecompute = await DeliveryAgentModel.findById(AGENT);
  assert(
    'a RECOMPUTE writing 100 does not erase the pin — this is what O-7 asked for',
    afterRecompute?.cod?.trust_override?.score === 35,
    `override = ${JSON.stringify(afterRecompute?.cod?.trust_override ?? null)}`,
  );
  assert(
    '…so the agent is still blocked afterwards',
    codExposureService.effectiveLimit(afterRecompute!, 500_000) === 0,
  );

  // Releasing returns them to what the platform thinks TODAY, not to what it
  // thought when they were pinned.
  await codTrustService.setOverride({
    agentId: AGENT.toString(),
    score: null,
    reason: 'verify:agent-contract — investigation closed',
    actor: ADMIN_ACTOR,
  });
  const released = await DeliveryAgentModel.findById(AGENT);
  assert('releasing clears the override', (released?.cod?.trust_override ?? null) === null);
  assert(
    '…and the agent returns to the CURRENT computed score, not the pinned one',
    codExposureService.effectiveLimit(released!, 500_000) === 500_000,
  );

  // An override is not a floor: it works upward too, which a clamping
  // implementation would silently break.
  await agentRepository.setTrustScore(AGENT.toString(), 40, {});
  const dropped = await DeliveryAgentModel.findById(AGENT);
  assert('a computed 40 puts the agent in the reduced tier', codExposureService.effectiveLimit(dropped!, 500_000) < 500_000);

  await codTrustService.setOverride({
    agentId: AGENT.toString(),
    score: 90,
    reason: 'verify:agent-contract — discrepancy resolved in their favour',
    actor: ADMIN_ACTOR,
  });
  const raised = await DeliveryAgentModel.findById(AGENT);
  assert(
    'an override ABOVE the computed score restores full exposure — it is not a floor',
    codExposureService.effectiveLimit(raised!, 500_000) === 500_000,
  );

  // The audit trail. An override changes cash standing more decisively than any
  // delta, so it must be in the same append-only log.
  const events = await CodTrustEventModel.find({ agent_id: AGENT }).sort({ created_at: 1 });
  assert('every override write appended a trust event', events.length >= 3, `${events.length} event(s)`);
  assert(
    '…recording a delta of ZERO, because the COMPUTED score genuinely did not move',
    events.every((e) => e.delta === 0),
    'a fictional delta here would corrupt the log that reconstructs the computed score',
  );
  assert(
    '…and naming the pinned value in the note',
    events.some((e) => (e.note ?? '').includes('SET to 35')) && events.some((e) => (e.note ?? '').includes('RELEASED')),
  );
}

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall');

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  verify:agent-contract — the seven scenarios, against real Mongo');
  console.log('═══════════════════════════════════════════════════════════════════════');

  try {
    await cleanup();
    await scenario1Race();
    await scenario2Pool();
    await scenario3BelowOutstanding();
    await scenario4CashChain();
    await scenario5Termination();
    await scenario6Pause();
    await scenario7Ban();
    await scenario8TrustOverride();
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
