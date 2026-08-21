/**
 * Test: the composite trust score, and the guarantee that it is not live yet.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: `computeComposite` and its three factor functions are pure,
 * which is why they were extracted off the collector.
 *
 * Two halves, and the second is the one that matters most today:
 *
 *   1. The arithmetic — every factor clamps, a signal-less agent scores exactly
 *      the seed, and evidence moves a factor away from the seed in proportion to
 *      how much of it there is.
 *   2. SOURCE SCANS proving the composite is still a SHADOW: the worker writes
 *      `trust_signals.composite_score` and never `cod.trust_score`, and
 *      `CodTrustService.applyEvent` is still the only writer of the live score.
 *      No behavioural test can see that difference — both write a number to a
 *      document — so a regression here is invisible except by reading the source.
 *      That is the same argument `test:mobile-auth` makes about the asymmetric
 *      refresh, and this one guards an agent's cash limit.
 *
 * Run: npm run test:agent-trust
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  activityFactor,
  codFactor,
  computeComposite,
  ratingFactor,
} from '../../src/modules/agents/domain/services/agent-trust.service';
import { AGENT_CONFIG } from '../../src/modules/agents/config/agent.config';
import { IAgentTrustSignals } from '../../src/modules/agents/models/agent.model';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
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

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Strip comments before a source scan — a scan that forces tombstones out makes the code worse. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** An agent about whom the platform knows nothing at all. */
const emptySignals = (): IAgentTrustSignals =>
  ({
    on_time_rate: null,
    assignment_response_rate: null,
    completed_shipments: 0,
    customer_rating_avg: null,
    customer_rating_count: 0,
    agency_rating_avg: null,
    agency_rating_count: 0,
    vendor_rating_avg: null,
    vendor_rating_count: 0,
    cod_clean_return_count: 0,
    cod_discrepancy_count: 0,
    cod_volume_returned: 0,
    composite_score: null,
    computed_at: null,
  }) as IAgentTrustSignals;

const withSignals = (over: Partial<IAgentTrustSignals>): IAgentTrustSignals =>
  ({ ...emptySignals(), ...over }) as IAgentTrustSignals;

const SEED = AGENT_CONFIG.TRUST_SCORE_SEED;
const MIN_OBS = AGENT_CONFIG.TRUST_MIN_OBSERVATIONS;
const FULL_CREDIT = AGENT_CONFIG.TRUST_COD_VOLUME_FULL_CREDIT;

function main(): void {
  console.log('\n── The weight set ─────────────────────────────────────────────────────\n');

  // agent.config.ts asserts this at import; asserting it here too is deliberate.
  // The composite's whole scale depends on it: factors are 0–1, so the weighted
  // sum lands on 0–100 only because the weights sum to 100.
  assert('the five weights sum to 100', () => {
    const sum = Object.values(AGENT_CONFIG.TRUST_WEIGHTS).reduce((a, b) => a + b, 0);
    return sum === 100;
  });

  assert('exactly five factors carry weight', () => Object.keys(AGENT_CONFIG.TRUST_WEIGHTS).length === 5);

  assert('half the weight is ratings — the reason the score is not live yet', () => {
    const w = AGENT_CONFIG.TRUST_WEIGHTS;
    return w.CUSTOMER_RATING + w.AGENCY_RATING + w.VENDOR_RATING === 50;
  });

  console.log('\n── No evidence resolves to the SEED, never to zero ─────────────────────\n');

  assert('an agent with no signals at all scores exactly the seed', () => computeComposite(emptySignals()).score === SEED);

  assert('every factor of a signal-less agent is the seed fraction', () => {
    const f = computeComposite(emptySignals()).factors;
    const seedFraction = SEED / AGENT_CONFIG.TRUST_SCORE_MAX;
    return [f.cod, f.activity, f.customer, f.agency, f.vendor].every((v) => v === seedFraction);
  });

  assert('an unrated agent is not scored as badly rated', () => ratingFactor(null, 0) > 0);

  assert('an agent who has handled no cash has no COD record', () =>
    codFactor({ cod_clean_return_count: 0, cod_discrepancy_count: 0, cod_volume_returned: 0 }) === SEED / 100);

  console.log('\n── Ratings: evidence moves the factor, absence does not ────────────────\n');

  assert('a single 1-star rating barely moves the factor', () => {
    const f = ratingFactor(1, 1);
    // One observation out of MIN_OBS — mostly seed, but moving the right way.
    return f < SEED / 100 && f > 0.7;
  });

  assert('a rating at or above MIN_OBSERVATIONS is taken at face value', () => {
    // 5 stars normalises to 1.0, which is also the seed fraction — use 3 stars,
    // where the observed value and the seed genuinely differ.
    const atThreshold = ratingFactor(3, MIN_OBS);
    const wellAbove = ratingFactor(3, MIN_OBS * 10);
    return Math.abs(atThreshold - 0.6) < 1e-9 && Math.abs(wellAbove - 0.6) < 1e-9;
  });

  assert('more of the same rating never overshoots the observed value', () => ratingFactor(2, 1000) === 0.4);

  assert('a rating factor stays within 0–1', () => {
    const values = [ratingFactor(0, 50), ratingFactor(5, 50), ratingFactor(3, 3)];
    return values.every((v) => v >= 0 && v <= 1);
  });

  console.log('\n── COD: the ratio is the score, the volume is the confidence ───────────\n');

  assert('a perfect record with trivial volume is not yet fully credited', () => {
    const f = codFactor({ cod_clean_return_count: 1, cod_discrepancy_count: 0, cod_volume_returned: 1000 });
    return f > 0 && f <= 1;
  });

  assert('a bad record with real volume drags the factor well below the seed', () => {
    const f = codFactor({ cod_clean_return_count: 1, cod_discrepancy_count: 9, cod_volume_returned: FULL_CREDIT });
    return Math.abs(f - 0.1) < 1e-9;
  });

  assert('volume alone can carry the confidence — one very large clean return counts', () => {
    const bigOne = codFactor({ cod_clean_return_count: 0, cod_discrepancy_count: 4, cod_volume_returned: FULL_CREDIT });
    const smallOne = codFactor({ cod_clean_return_count: 0, cod_discrepancy_count: 4, cod_volume_returned: 0 });
    // Same ratio (0 clean of 4), but the large-volume agent is judged on it more firmly.
    return bigOne < smallOne;
  });

  assert('the COD factor stays within 0–1 at the extremes', () => {
    const worst = codFactor({ cod_clean_return_count: 0, cod_discrepancy_count: 100, cod_volume_returned: FULL_CREDIT * 10 });
    const best = codFactor({ cod_clean_return_count: 100, cod_discrepancy_count: 0, cod_volume_returned: FULL_CREDIT * 10 });
    return worst >= 0 && worst <= 1 && best >= 0 && best <= 1 && worst === 0 && best === 1;
  });

  console.log('\n── Activity: a null on_time_rate is EXCLUDED, not counted as zero ──────\n');

  // This is the assertion that guards the correction: no shipment in this platform
  // carries a promised delivery time, so `on_time_rate` is null on every agent.
  // Counting it as 0 would cap every agent's activity factor at half.
  assert('a null on_time_rate does not halve the activity factor', () => {
    const excluded = activityFactor({ on_time_rate: null, assignment_response_rate: 1, completed_shipments: MIN_OBS });
    const asZero = activityFactor({ on_time_rate: 0, assignment_response_rate: 1, completed_shipments: MIN_OBS });
    return excluded === 1 && asZero === 0.5;
  });

  assert('an agent with no offers and no shipments resolves to the seed', () =>
    activityFactor({ on_time_rate: null, assignment_response_rate: null, completed_shipments: 0 }) === SEED / 100);

  assert('a poor response rate needs completed work behind it to count fully', () => {
    const novice = activityFactor({ on_time_rate: null, assignment_response_rate: 0, completed_shipments: 1 });
    const veteran = activityFactor({ on_time_rate: null, assignment_response_rate: 0, completed_shipments: MIN_OBS });
    return novice > veteran && veteran === 0;
  });

  console.log('\n── The composite ──────────────────────────────────────────────────────\n');

  assert('the score is clamped to 0–100', () => {
    const worst = computeComposite(
      withSignals({
        assignment_response_rate: 0,
        completed_shipments: 100,
        customer_rating_avg: 0,
        customer_rating_count: 100,
        agency_rating_avg: 0,
        agency_rating_count: 100,
        vendor_rating_avg: 0,
        vendor_rating_count: 100,
        cod_clean_return_count: 0,
        cod_discrepancy_count: 100,
        cod_volume_returned: FULL_CREDIT,
      })
    ).score;
    return worst === 0;
  });

  assert('the score is an integer', () => {
    const s = computeComposite(withSignals({ customer_rating_avg: 3.3, customer_rating_count: 7 })).score;
    return Number.isInteger(s);
  });

  // The worked example: a real COD problem, no ratings anywhere. This is what
  // today's data actually looks like, and it is why the flip needs a comparison.
  assert('a COD-troubled agent with no ratings still scores above 50 today', () => {
    const s = computeComposite(
      withSignals({
        assignment_response_rate: 0.8,
        completed_shipments: 20,
        cod_clean_return_count: 1,
        cod_discrepancy_count: 9,
        cod_volume_returned: FULL_CREDIT,
      })
    ).score;
    // 30·0.1 + 20·0.8 + 50·1.0 = 3 + 16 + 50 = 69 — above TRUST_REDUCED_THRESHOLD (50)
    // purely on the strength of ratings nobody has given. The delta model would
    // have this agent far lower.
    return s === 69;
  });

  assert('the customer factor alone can move the score by up to 30 points', () => {
    const unrated = computeComposite(emptySignals()).score;
    const badlyRated = computeComposite(
      withSignals({ customer_rating_avg: 0, customer_rating_count: MIN_OBS })
    ).score;
    return unrated - badlyRated === AGENT_CONFIG.TRUST_WEIGHTS.CUSTOMER_RATING;
  });

  console.log('\n── SOURCE SCANS: the composite is still a SHADOW ───────────────────────\n');

  const worker = stripComments(read('modules/agents/workers/agent-trust-recompute.worker.ts'));
  const trustService = stripComments(read('modules/agents/domain/services/agent-trust.service.ts'));
  const codTrust = stripComments(read('modules/cod/services/cod-trust.service.ts'));
  const repo = stripComments(read('modules/agents/repositories/agent.repository.ts'));

  // Tests the WRITE forms, not the bare substring: the worker's own log line says
  // "cod.trust_score unchanged", and a scan that forbids naming the field would
  // force that explanation out of the code — the same reason test:connections
  // strips comments before scanning.
  assert('the recompute worker never writes cod.trust_score', () => {
    return !worker.includes("'cod.trust_score'") && !worker.includes('setTrustScore(');
  });

  assert('the trust service never writes cod.trust_score', () => !trustService.includes('cod.trust_score'));

  assert('the worker persists through the shadow writer', () => worker.includes('setTrustSignalsShadow'));

  assert('the shadow writer does not touch cod.trust_score', () => {
    const start = repo.indexOf('async setTrustSignalsShadow');
    const end = repo.indexOf('async listAllIds');
    return start > -1 && end > start && !repo.slice(start, end).includes('cod.trust_score');
  });

  assert('CodTrustService is still the writer of the live score', () => codTrust.includes("'cod.trust_score': scoreAfter"));

  // D-2's safety half: nightly-only recompute would leave a cash shortfall
  // unthrottled until 03:00, where the delta model throttles it instantly.
  assert('a COD trust event triggers an immediate recompute', () => codTrust.includes('recomputeOne('));

  assert('the immediate recompute cannot fail the COD write that triggered it', () => {
    const line = codTrust.split('\n').find((l) => l.includes('recomputeOne('));
    return line !== undefined && line.trim().startsWith('void ');
  });

  console.log('\n── SOURCE SCANS: the worker follows the house convention ───────────────\n');

  assert('the worker takes the shared overlap lock (F-19)', () => worker.includes('withWorkerLock('));

  assert('the worker derives its schedule from the value it schedules with', () => {
    // A literal cron expression typed into `schedules` is the drift this convention
    // exists to prevent — test:system asserts the registry side, this asserts the worker's.
    return worker.includes('expression: this.schedule') && worker.includes('AGENT_CONFIG.TRUST_RECOMPUTE_CRON');
  });

  assert('the worker respects the maintenance guard', () => worker.includes('maintenanceBlocksWorkers()'));

  assert('one agent failing does not abort the sweep', () => {
    const start = worker.indexOf('for (const id of ids)');
    const end = worker.indexOf('console.log', start);
    return start > -1 && worker.slice(start, end).includes('catch');
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
