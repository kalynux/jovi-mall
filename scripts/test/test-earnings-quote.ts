/**
 * Test: the delivery-fee arithmetic both sides of a shipment are quoted from.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: every function under test is pure, which is exactly why
 * they were extracted onto `EarningsQuoteService` — the agent's offer-time
 * estimate, the agency's estimate, and the allocations `EarningsSplitService`
 * actually writes all run these same four functions, so they cannot drift.
 *
 * The last section is the point of the file: it re-derives what
 * `splitCodCollection` / `splitShipmentDelivery` allocate and asserts the fee
 * divides exactly, with nothing invented and nothing lost.
 *
 * Run: npm run test:earnings-quote
 */
import {
  applyFeeSplit,
  computeAgencyCut,
  computeCodHandlingFee,
  resolveEarnedFee,
} from '../../src/modules/earnings/services/earnings-quote.service';
import { IAgencyPolicies, ICodHandlingFee } from '../../src/modules/delivery/delivery-agency.model';
import { IContractFeeSplit } from '../../src/modules/agents/models/agent-agency-membership.model';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok = false;
  try {
    ok = fn();
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const percentageSplit = (percent: number): IContractFeeSplit => ({
  model: 'percentage',
  agent_share_percent: percent,
  agent_flat_fee: null,
  currency: 'XAF',
});

const flatSplit = (amount: number): IContractFeeSplit => ({
  model: 'flat',
  agent_share_percent: null,
  agent_flat_fee: amount,
  currency: 'XAF',
});

/** The schema default on a fresh contract — a percentage model with no share. */
const unconfiguredSplit: IContractFeeSplit = {
  model: 'percentage',
  agent_share_percent: null,
  agent_flat_fee: null,
  currency: 'XAF',
};

const policiesWithRto = (rtoFee: number): IAgencyPolicies =>
  ({ pricing: { additional_fees: { rto_fee: rtoFee } } }) as unknown as IAgencyPolicies;

const percentageCodFee = (percent: number): ICodHandlingFee => ({ type: 'percentage', value: percent });
const fixedCodFee = (amount: number): ICodHandlingFee => ({ type: 'fixed', value: amount });

function main(): void {
  console.log('\n▶ computeCodHandlingFee — the agency-only charge on cash deliveries');

  assert('percentage of the cash collected, floored', () =>
    computeCodHandlingFee(percentageCodFee(2), 12_500) === 250);
  assert('percentage never rounds up (250.5 → 250)', () =>
    computeCodHandlingFee(percentageCodFee(2), 12_525) === 250);
  assert('fixed ignores the amount collected', () =>
    computeCodHandlingFee(fixedCodFee(300), 12_500) === 300);
  assert('no config configured → no fee', () => computeCodHandlingFee(null, 12_500) === 0);
  assert('undefined config → no fee', () => computeCodHandlingFee(undefined, 12_500) === 0);
  // A prepaid shipment passes 0 here; a fixed fee must not appear out of thin air.
  assert('nothing collected → no fee, even on a fixed config', () =>
    computeCodHandlingFee(fixedCodFee(300), 0) === 0);
  assert('negative collected amount is not a fee', () =>
    computeCodHandlingFee(percentageCodFee(2), -100) === 0);

  console.log('\n▶ resolveEarnedFee — what a run earns out of the fee reserved for it');

  assert('delivered → the whole reserved fee', () =>
    resolveEarnedFee('delivered', 1500, policiesWithRto(400)) === 1500);
  assert('returned → the agency rto_fee, not the delivery fee', () =>
    resolveEarnedFee('returned', 1500, policiesWithRto(400)) === 400);
  assert('returned clamps rto_fee to the reserved fee', () =>
    resolveEarnedFee('returned', 300, policiesWithRto(400)) === 300);
  assert('returned with no policies → nothing earned', () =>
    resolveEarnedFee('returned', 1500, null) === 0);
  assert('no fee reserved → nothing earned, whatever the outcome', () =>
    resolveEarnedFee('delivered', 0, policiesWithRto(400)) === 0);

  console.log('\n▶ computeAgencyCut — the complement of applyFeeSplit');

  assert('prepaid: fee minus the agent cut', () => computeAgencyCut(1500, 450) === 1050);
  assert('COD: the handling fee is added whole, never shared', () =>
    computeAgencyCut(1500, 450, 250) === 1300);
  assert('an agent taking the whole fee leaves the agency nothing', () =>
    computeAgencyCut(1500, 1500) === 0);
  // The no-live-contract case: computeAgentCut logs and returns 0, and the whole
  // fee stays with the agency. A real answer, not an error — this is why
  // 'no_contract' is absent from AgencyEarningUnavailableReason.
  assert('no contract (cut 0) → the agency keeps the whole fee', () =>
    computeAgencyCut(1500, applyFeeSplit(null, 1500)) === 1500);
  assert('an unconfigured fee_split also leaves the whole fee', () =>
    computeAgencyCut(1500, applyFeeSplit(unconfiguredSplit, 1500)) === 1500);

  console.log('\n▶ The two halves always add back up to the fee');

  const conserves = (split: IContractFeeSplit | null, fee: number): boolean => {
    const agentCut = applyFeeSplit(split, fee);
    return agentCut + computeAgencyCut(fee, agentCut) === fee;
  };

  assert('percentage split conserves the fee', () => conserves(percentageSplit(30), 1500));
  assert('flat split conserves the fee', () => conserves(flatSplit(450), 1500));
  assert('an over-large flat split is clamped, and still conserves', () =>
    conserves(flatSplit(9999), 1500));
  assert('a 100% split conserves (agency gets 0)', () => conserves(percentageSplit(100), 1500));
  assert('a 0% split conserves (agency gets everything)', () => conserves(percentageSplit(0), 1500));
  assert('an absent contract conserves', () => conserves(null, 1500));
  assert('a zero fee conserves', () => conserves(percentageSplit(30), 0));
  assert('rounding loss lands with the agency, never unallocated', () => {
    // 33% of 1000 is 330.0 exactly; 33% of 1001 is 330.33 → floored to 330, and
    // the remainder must go somewhere rather than evaporating.
    const agentCut = applyFeeSplit(percentageSplit(33), 1001);
    return agentCut === 330 && computeAgencyCut(1001, agentCut) === 671;
  });

  console.log('\n▶ The estimate matches what the split actually allocates');

  // splitCodCollection: agency = deliveryFee - agentCut + codFee, agent = agentCut,
  // and the vendor is charged deliveryFee + codFee. Re-derived here from the same
  // helpers the split now calls, so a change to either side breaks this.
  assert('COD: agency + agent equals what the vendor was charged', () => {
    const gross = 12_500;
    const deliveryFee = 1500;
    const codFee = computeCodHandlingFee(percentageCodFee(2), gross);
    const agentCut = applyFeeSplit(percentageSplit(30), deliveryFee);
    const agencyCut = computeAgencyCut(deliveryFee, agentCut, codFee);
    return agentCut === 450 && agencyCut === 1300 && agencyCut + agentCut === deliveryFee + codFee;
  });

  // splitShipmentDelivery: agency = earnedFee - agentCut, agent = agentCut, and
  // the vendor is refunded reservedFee - earnedFee.
  assert('prepaid delivered: nothing is refunded to the vendor', () => {
    const reservedFee = 1500;
    const earnedFee = resolveEarnedFee('delivered', reservedFee, policiesWithRto(400));
    const agentCut = applyFeeSplit(percentageSplit(30), earnedFee);
    return computeAgencyCut(earnedFee, agentCut) + agentCut + (reservedFee - earnedFee) === reservedFee;
  });

  assert('prepaid returned: the unspent remainder goes back to the vendor', () => {
    const reservedFee = 1500;
    const earnedFee = resolveEarnedFee('returned', reservedFee, policiesWithRto(400));
    const agentCut = applyFeeSplit(percentageSplit(30), earnedFee);
    const agencyCut = computeAgencyCut(earnedFee, agentCut);
    const vendorRefund = reservedFee - earnedFee;
    return (
      earnedFee === 400 &&
      agentCut === 120 &&
      agencyCut === 280 &&
      vendorRefund === 1100 &&
      agencyCut + agentCut + vendorRefund === reservedFee
    );
  });

  // The agency's `agentCut` field and the agent's own `earning.amount` are the
  // same call on the same numbers — the two views of one shipment must agree.
  assert('the agency quote reports exactly what the agent is quoted', () => {
    const earnedFee = resolveEarnedFee('delivered', 1500, policiesWithRto(400));
    return applyFeeSplit(percentageSplit(30), earnedFee) === applyFeeSplit(percentageSplit(30), 1500);
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
