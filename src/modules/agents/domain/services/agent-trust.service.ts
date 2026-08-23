import { Types } from 'mongoose';
import { AGENT_CONFIG } from '../../config/agent.config';
import { IAgentTrustSignals } from '../../models/agent.model';
import { ShipmentModel } from '../../../shipments/shipment.model';
import { ShipmentAssignmentOfferModel } from '../../../shipment-assignment/models/shipment-assignment-offer.model';
import { AgentDepositModel } from '../../../cod/models/agent-deposit.model';
import { CodDiscrepancyModel } from '../../../cod/models/cod-discrepancy.model';
import { CodTrustEventModel } from '../../../cod/models/cod-trust-event.model';
import { reviewAggregateRepository } from '../../../reviews/repositories/review-aggregate.repository';

/**
 * AgentTrustService — the composite trust score.
 *
 * The design was locked with the product owner in `AGENT-CONTRACT-REFACTOR.md`
 * ("Decisions locked — do not re-litigate"): the score is a pure function of five
 * weighted factors, recomputed in a nightly batch, replacing the delta model in
 * which `CodTrustService.applyEvent` added and subtracted points.
 *
 * ── ⚠ IT IS NOT LIVE YET, AND THAT IS DELIBERATE ─────────────────────────────
 * This service writes `trust_signals.composite_score`. It does **not** write
 * `cod.trust_score`, which `CodTrustService.applyEvent` still owns and which
 * `CodExposureService` reads to set an agent's cash limit. Phase 6 D-2.
 *
 * ── ⚠ THE RATING FACTORS NOW HAVE A SOURCE (Phase 6 Step 10) ─────────────────
 * This block used to say "half the weight has no data source in this platform"
 * and it is no longer true. `modules/reviews` writes all three:
 *
 *   customer rating  30    a DELIVERY review by its recipient
 *   agency rating    10    a delivery review by the agent's own agency
 *   vendor rating    10    a delivery review by the seller whose goods they carried
 *   activity         20    partial — see `on_time_rate` below.
 *   COD              30    real, from settlements and discrepancies.
 *
 * All three rate the **same shipment** and land in three separate
 * `review_aggregates` rows keyed by `(agent, author_role)`, which is why one
 * delivery can move three different factors. Note what still would NOT do: a
 * *product* review. This is a rating of a delivery, not of an item.
 *
 * A factor with no reviews yet still resolves to the seed, so the shadow's
 * "every delta is ≥ 0" property holds until real ratings accumulate — it is now a
 * fact about the data rather than about the code.
 *
 * Flipping the live score onto a composite that is half seed would re-score every
 * agent at once, and the two numbers that move are `TRUST_FULL_THRESHOLD` (80)
 * and `TRUST_REDUCED_THRESHOLD` (50) — i.e. how much cash each agent may hold.
 * So the composite is computed and stored where it can be compared, and Step 11
 * flips it against a table of who crosses those thresholds.
 *
 * ── The one rule that keeps a missing signal honest ───────────────────────────
 * **A factor with no evidence resolves to the SEED, never to zero.** Zero would
 * mean "this agent is untrustworthy"; what is true is "we do not know". The
 * config already states the principle for ratings — *"one angry customer must not
 * define an agent's reputation"* — and the same blend covers every factor here.
 * An agent with no signals at all therefore scores exactly `TRUST_SCORE_SEED`,
 * which is what the previous delta model started everyone at.
 */

/** Each factor normalised to 0–1 before its weight is applied. */
export interface TrustFactors {
  cod: number;
  activity: number;
  customer: number;
  agency: number;
  vendor: number;
}

export interface TrustComposite {
  /** 0–100, on the same scale `cod.trust_score` uses. */
  score: number;
  factors: TrustFactors;
}

const { TRUST_WEIGHTS, TRUST_SCORE_MIN, TRUST_SCORE_MAX, TRUST_SCORE_SEED, TRUST_MIN_OBSERVATIONS, TRUST_COD_VOLUME_FULL_CREDIT } =
  AGENT_CONFIG;

/** The seed expressed on the 0–1 factor scale — what "no evidence" resolves to. */
const SEED_FRACTION = TRUST_SCORE_SEED / TRUST_SCORE_MAX;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Blend an observed value toward the seed by how much evidence stands behind it.
 * `confidence` 0 → the seed, 1 → the observation, and everything between is a
 * straight interpolation. This is the single mechanism the whole score uses to
 * express "we do not know yet", and every factor below goes through it.
 */
const blendTowardSeed = (observed: number, confidence: number): number =>
  clamp01(clamp01(confidence) * clamp01(observed) + (1 - clamp01(confidence)) * SEED_FRACTION);

/**
 * A 1–5 star average as a 0–1 factor, with confidence from the number of ratings.
 *
 * `avg === null` with `count === 0` is what "no evidence" looks like, and the blend
 * turns that into the seed rather than into a zero. That is the shape
 * `collectSignals` produces for an agent nobody has reviewed — deliberately not
 * `avg: 0`, which would mean "everybody rated them one star".
 */
export function ratingFactor(avg: number | null, count: number): number {
  if (avg === null || count <= 0) return SEED_FRACTION;
  return blendTowardSeed(avg / 5, count / TRUST_MIN_OBSERVATIONS);
}

/**
 * The COD track record: how much cash came back clean, weighted by how much cash
 * there was.
 *
 * Volume is the *confidence*, not the score — the spec asks for scale to weigh
 * positively, and returning 5 000 000 cleanly is stronger evidence of the same
 * ratio than returning 5 000. An agent who has handled no cash has no COD record
 * and resolves to the seed, which is why a brand-new agent is not locked out of
 * COD by their own emptiness.
 *
 * ── ⚠ `admin_adjustment` has no home in this score, and that is structural ────
 * `cod_discrepancy_count` counts settlement failures: discrepancy rows, plus
 * `late_deposit` / `deposit_shortfall` events raised without one. It does **not**
 * count `admin_adjustment`, and no factor here does.
 *
 * That is not an oversight to patch quietly. The locked design makes the score *a
 * pure function of five factors*, and a manual adjustment is by definition not a
 * function of anything observable — an administrator docking an agent for a lost
 * parcel or a complaint is recording a judgement, not a measurement. Under the
 * delta model that judgement persisted because the score itself was the ledger;
 * under a composite, **the next nightly recompute erases it**.
 *
 * Verified against the dev database on 2026-08-21: an agent sitting at a live 35
 * scores 100 here. (That particular row is seeded rather than adjusted — it has no
 * trust events at all — but it is exactly what a real adjustment would look like
 * after the flip.)
 *
 * ── ✅ Step 11 was TAKEN, and the answer was "not yet" (2026-08-21) ───────────
 * This paragraph used to say the question was "for Phase 6 Step 11". Step 11 has
 * now run its measurement, and **this is one of the two blockers that stopped the
 * flip**: a `blocked → full` transition on the only adjusted-looking row in the
 * roster. It is carried as **O-7** in `PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md`
 * § 5, and the position is unchanged: either administrators keep a persistent
 * override outside the composite, or manual adjustment stops being a thing that
 * survives. Both are product decisions, and **the flip may not land without one of
 * them answered in writing**. `npm run audit:trust-shadow` is how you re-measure.
 */
export function codFactor(signals: Pick<IAgentTrustSignals, 'cod_clean_return_count' | 'cod_discrepancy_count' | 'cod_volume_returned'>): number {
  const settlements = signals.cod_clean_return_count + signals.cod_discrepancy_count;
  if (settlements <= 0) return SEED_FRACTION;

  const cleanRatio = signals.cod_clean_return_count / settlements;

  // Two independent kinds of evidence: how MANY settlements, and how MUCH cash.
  // The stronger of the two carries the confidence — an agent who has returned
  // one very large sum cleanly is not "barely known".
  const byCount = settlements / TRUST_MIN_OBSERVATIONS;
  const byVolume = TRUST_COD_VOLUME_FULL_CREDIT > 0 ? signals.cod_volume_returned / TRUST_COD_VOLUME_FULL_CREDIT : 0;

  return blendTowardSeed(cleanRatio, Math.max(byCount, byVolume));
}

/**
 * Activity: does this agent take the work they are offered, and finish it.
 *
 * ⚠ **`on_time_rate` has no data source in this platform** and is null on every
 * agent. Verified 2026-08-21: a Shipment carries no promised, expected or due
 * delivery time anywhere in its schema, so "on time" has nothing to be on time
 * against. It is **excluded from the mean rather than counted as zero** — the
 * distinction matters, because counting it would cap every agent's activity
 * factor at half regardless of their behaviour. If a promised time is ever added,
 * this function starts using it with no other change.
 *
 * Confidence comes from completed shipments, so an agent who accepted their first
 * offer does not thereby earn a perfect response rate.
 */
export function activityFactor(
  signals: Pick<IAgentTrustSignals, 'on_time_rate' | 'assignment_response_rate' | 'completed_shipments'>
): number {
  const observed: number[] = [];
  if (signals.on_time_rate !== null) observed.push(clamp01(signals.on_time_rate));
  if (signals.assignment_response_rate !== null) observed.push(clamp01(signals.assignment_response_rate));

  if (observed.length === 0) return SEED_FRACTION;

  const mean = observed.reduce((a, b) => a + b, 0) / observed.length;
  return blendTowardSeed(mean, signals.completed_shipments / TRUST_MIN_OBSERVATIONS);
}

/**
 * The composite. **Pure** — no I/O, no clock, no randomness — because this is the
 * half a test can pin, and the half whose behaviour decides an agent's cash limit.
 *
 * Weights sum to 100 (asserted at import in `agent.config.ts`) and every factor is
 * 0–1, so the weighted sum lands on the 0–100 scale directly. All-seed inputs
 * therefore produce exactly `TRUST_SCORE_SEED`.
 */
export function computeComposite(signals: IAgentTrustSignals): TrustComposite {
  const factors: TrustFactors = {
    cod: codFactor(signals),
    activity: activityFactor(signals),
    customer: ratingFactor(signals.customer_rating_avg, signals.customer_rating_count),
    agency: ratingFactor(signals.agency_rating_avg, signals.agency_rating_count),
    vendor: ratingFactor(signals.vendor_rating_avg, signals.vendor_rating_count),
  };

  const weighted =
    factors.cod * TRUST_WEIGHTS.COD_TRACK_RECORD +
    factors.activity * TRUST_WEIGHTS.ACTIVITY +
    factors.customer * TRUST_WEIGHTS.CUSTOMER_RATING +
    factors.agency * TRUST_WEIGHTS.AGENCY_RATING +
    factors.vendor * TRUST_WEIGHTS.VENDOR_RATING;

  const score = Math.round(Math.max(TRUST_SCORE_MIN, Math.min(TRUST_SCORE_MAX, weighted)));

  return { score, factors };
}

export class AgentTrustService {
  /**
   * Gather one agent's signals from the collections that own them.
   *
   * Deliberately separate from `computeComposite` so the arithmetic stays
   * testable without a database — the same split `deriveWorkingState` and
   * `effectiveLimit` already follow in this module.
   *
   * ── The three rating fields, and the ONE path they arrive by ────────────────
   * They come from `review_aggregates`, read here and nowhere else. The chain is:
   * a delivery review is published → `ReviewService.refreshTargets` recomputes the
   * `(agent, author_role)` aggregate → this collector reads it → the worker writes
   * `trust_signals`. **One writer at every hop**, which is the rule the whole trust
   * design rests on. Nothing in `modules/reviews` touches `delivery_agents`, and
   * nothing here touches `reviews`.
   *
   * An agent nobody has reviewed reads `avg: null, count: 0` — not `avg: 0` — so
   * `ratingFactor` resolves to the seed rather than to "everybody rated them one
   * star". The keys are always present so the persisted document keeps its shape.
   */
  async collectSignals(agentId: string): Promise<IAgentTrustSignals> {
    const agentObjectId = new Types.ObjectId(agentId);

    const [completedShipments, offerCounts, deposits, discrepancyCount, discrepancyDepositIds, unlinkedPenalties, ratings] = await Promise.all([
      ShipmentModel.countDocuments({ agent_id: agentObjectId, status: 'delivered' }),

      // Response rate is offers ANSWERED over offers that reached a verdict.
      // `expired` counts as a non-answer (they were asked and said nothing);
      // `cancelled` and `superseded` do not count at all — those were withdrawn
      // by the platform, and holding an agent responsible for them would penalise
      // them for losing a race they were never told about.
      ShipmentAssignmentOfferModel.aggregate<{ _id: string; n: number }>([
        { $match: { agent_id: agentObjectId, status: { $in: ['accepted', 'rejected', 'expired'] } } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),

      AgentDepositModel.aggregate<{ _id: null; n: number; amount: number }>([
        { $match: { agent_id: agentObjectId, status: 'confirmed' } },
        { $group: { _id: null, n: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]),

      CodDiscrepancyModel.countDocuments({ agent_id: agentObjectId }),

      CodDiscrepancyModel.distinct('deposit_id', { agent_id: agentObjectId, deposit_id: { $ne: null } }),

      /**
       * COD penalties recorded ONLY in the trust log.
       *
       * The locked design says `CodTrustEvent` "stays as the append-only signal log
       * **feeding the COD factor**", and this is that feed. Counting discrepancy rows
       * alone misses any `late_deposit` / `deposit_shortfall` raised without one —
       * the composite would then silently forgive a penalty the delta model applied,
       * which is the one direction a successor score must never move in.
       *
       * `ref_type: 'cod_discrepancy'` events are EXCLUDED because the discrepancy row
       * they point at is already counted above; including them would double-penalise
       * a single incident.
       *
       * `admin_adjustment` is excluded on different grounds — see the note in
       * `codFactor`. It is an override, not a track record.
       */
      CodTrustEventModel.countDocuments({
        agent_id: agentObjectId,
        event_type: { $in: ['late_deposit', 'deposit_shortfall'] },
        ref_type: { $ne: 'cod_discrepancy' },
      }),

      /**
       * All three rating rows in one query — customer, agency and vendor.
       *
       * Read together rather than separately because the composite weights them
       * differently and needs all three to produce one score; three round trips
       * would buy nothing and would make a partial read possible.
       */
      reviewAggregateRepository.findAgentRatings(agentId),
    ]);

    const byStatus = new Map(offerCounts.map((row) => [row._id, row.n]));
    const accepted = byStatus.get('accepted') ?? 0;
    const answered = accepted + (byStatus.get('rejected') ?? 0);
    const reachedVerdict = answered + (byStatus.get('expired') ?? 0);

    const confirmedDeposits = deposits[0]?.n ?? 0;
    const confirmedAmount = deposits[0]?.amount ?? 0;

    // A clean return is a confirmed deposit no discrepancy points at. Counting
    // "confirmed deposits" alone would credit an agent for cash that arrived late
    // or short, which is precisely what the discrepancy records.
    const disputedDeposits = discrepancyDepositIds.length;
    const cleanReturns = Math.max(0, confirmedDeposits - disputedDeposits);

    return {
      on_time_rate: null, // no source — see activityFactor
      assignment_response_rate: reachedVerdict > 0 ? accepted / reachedVerdict : null,
      completed_shipments: completedShipments,

      // `null` when nobody has rated — never `0`. See the docstring above and
      // `ratingFactor`: the two mean opposite things to the composite.
      customer_rating_avg: ratings.customer.count > 0 ? ratings.customer.average : null,
      customer_rating_count: ratings.customer.count,
      agency_rating_avg: ratings.agency.count > 0 ? ratings.agency.average : null,
      agency_rating_count: ratings.agency.count,
      vendor_rating_avg: ratings.vendor.count > 0 ? ratings.vendor.average : null,
      vendor_rating_count: ratings.vendor.count,

      cod_clean_return_count: cleanReturns,
      // Discrepancy rows PLUS any COD penalty recorded only in the trust log —
      // see the query above for why the two cannot simply be added without the
      // `ref_type` exclusion.
      cod_discrepancy_count: discrepancyCount + unlinkedPenalties,
      cod_volume_returned: confirmedAmount,

      composite_score: null, // set by the caller from computeComposite
      computed_at: null,
    };
  }

  /** Collect, compute, and hand both back. The worker persists; this does not. */
  async recompute(agentId: string): Promise<{ signals: IAgentTrustSignals; composite: TrustComposite }> {
    const signals = await this.collectSignals(agentId);
    const composite = computeComposite(signals);
    return { signals: { ...signals, composite_score: composite.score }, composite };
  }
}

export const agentTrustService = new AgentTrustService();
