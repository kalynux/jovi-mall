import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * ShipmentAssignmentSession — the TEMPORARY RANKING that drives one shipment's
 * auto-assignment broadcast.
 *
 * ── Why this exists (and why it is separate from the offer) ──────────────────
 *
 * The requirement calls the ranking "temporary runtime data" that lives only to
 * support the assignment / rejection / timeout / reassignment cycle and is
 * disposed of when the shipment's lifecycle finishes. It also demands things the
 * old single-offer model could not express:
 *
 *   • Several agents may hold an acceptable offer at once — a timed-out (ignored)
 *     agent KEEPS their offer and can still accept while the shipment is
 *     unassigned; "first valid approval wins".
 *   • The broadcast walks the ranking across up to TWO rounds.
 *   • A mid-delivery cancellation RESUMES from where the broadcast had reached
 *     (the `cursor`), never from the top.
 *
 * So the ordered candidate list, the broadcast cursor and the round counter live
 * here — one document per shipment — while the per-agent notification+acceptance
 * records stay on `ShipmentAssignmentOffer`. Whether an agent rejected or merely
 * ignored is DERIVED from their offer's status (`rejected` vs still `pending`),
 * so this document never duplicates that state.
 *
 * ── Concurrency ──────────────────────────────────────────────────────────────
 *
 * The document is advanced by a polling sweep that may run on several server
 * instances at once. Advancement is an OPTIMISTIC compare-and-set: the sweep
 * reads (status, round, cursor, renudge_index, frontier_at) and writes the next
 * state only if all of them are unchanged (`advanceState` in the repository), so
 * two instances cannot both advance the same session. There is no separate lock.
 *
 * ── Lifecycle (`status`) ─────────────────────────────────────────────────────
 *
 *   active    — the broadcast is running (or paused between frontier ticks, or
 *               resuming after a cancellation). `frontier_at` is the next tick.
 *   assigned  — an agent accepted; advancement stops (`frontier_at = null`) but
 *               the session is KEPT: a later cancellation flips it back to
 *               `active` and resumes from `cursor`.
 *   exhausted — both rounds finished with nobody bound; the agency was notified.
 *               Standing (ignored) offers remain acceptable, and a cancellation
 *               of a subsequently-assigned agent can still resume it.
 *   closed    — the shipment reached a terminal outcome (or was permanently
 *               cancelled); the ranking is now disposable.
 */

export type AssignmentSessionStatus = 'active' | 'assigned' | 'exhausted' | 'closed';

/** How the final ranking order was produced — pure observability. */
export type RankingSource = 'geo_matrix' | 'haversine';

/** One ranked candidate. Immutable once the session is created. */
export interface ISessionCandidate {
  agent_id: mongoose.Types.ObjectId;
  rank: number;
  /** Road distance/duration when ranked via the geo provider; null on fallback. */
  distance_m: number | null;
  duration_s: number | null;
  /** The weighted score + breakdown kept for explainability (audit only). */
  score: number;
  breakdown: {
    distance_km: number | null;
    distance_score: number;
    free_capacity: number;
    capacity_score: number;
    trust_score: number;
    trust_score_norm: number;
    weighted: number;
  } | null;
}

export interface IShipmentAssignmentSession extends Document {
  shipment_id: mongoose.Types.ObjectId;
  order_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;

  status: AssignmentSessionStatus;
  ranking_source: RankingSource;

  /** The ordered candidate list — the temporary ranking itself. */
  ranking: ISessionCandidate[];

  /**
   * How far round 1 has broadcast: the number of candidates already offered, and
   * therefore the index of the NEXT one to offer. Also the high-water mark a
   * cancellation resumes from (the requirement's "resume from where it reached").
   */
  cursor: number;

  /** Which pass over the ranking we are on (1..MAX_ROUNDS). */
  round: number;
  /** Position of the round-2 re-nudge pass over the ignored candidates. */
  renudge_index: number;

  /** COD snapshot, so the broadcast doesn't re-read the order every tick. */
  is_cod: boolean;
  expected_cod_amount: number | null;
  currency: string | null;

  /** The agent who accepted, while `status === 'assigned'`. */
  assigned_agent_id: mongoose.Types.ObjectId | null;

  /**
   * When the current frontier candidate's response window closes and the sweep
   * should advance to the next candidate. Null when the session is not actively
   * broadcasting (`assigned` / `exhausted` / `closed`). This is what the sweep
   * queries on, and the value it compare-and-sets to claim an advance.
   */
  frontier_at: Date | null;

  created_at: Date;
  updated_at: Date;
}

const SessionCandidateSchema = new Schema<ISessionCandidate>(
  {
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    rank: { type: Number, required: true },
    distance_m: { type: Number, default: null },
    duration_s: { type: Number, default: null },
    score: { type: Number, required: true },
    breakdown: {
      type: new Schema(
        {
          distance_km: { type: Number, default: null },
          distance_score: { type: Number, required: true },
          free_capacity: { type: Number, required: true },
          capacity_score: { type: Number, required: true },
          trust_score: { type: Number, required: true },
          trust_score_norm: { type: Number, required: true },
          weighted: { type: Number, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { _id: false }
);

const ShipmentAssignmentSessionSchema = new Schema<IShipmentAssignmentSession>(
  {
    shipment_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT, required: true },
    order_id: { type: Schema.Types.ObjectId, ref: MODELS.ORDER, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    status: {
      type: String,
      enum: ['active', 'assigned', 'exhausted', 'closed'],
      default: 'active',
      required: true,
    },
    ranking_source: { type: String, enum: ['geo_matrix', 'haversine'], default: 'haversine', required: true },
    ranking: { type: [SessionCandidateSchema], default: [] },
    cursor: { type: Number, default: 0, required: true },
    round: { type: Number, default: 1, required: true },
    renudge_index: { type: Number, default: 0, required: true },
    is_cod: { type: Boolean, default: false, required: true },
    expected_cod_amount: { type: Number, default: null },
    currency: { type: String, default: null },
    assigned_agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, default: null },
    frontier_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// One live session per shipment. Partial-unique on the non-closed statuses so a
// disposed (`closed`) session can coexist with — or be replaced by — a fresh one
// if the shipment is ever re-opened, while two concurrent auto-assign triggers
// for the same shipment cannot create two live rankings (duplicate-key instead).
ShipmentAssignmentSessionSchema.index(
  { shipment_id: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['active', 'assigned', 'exhausted'] } } }
);
// The sweep: sessions actively broadcasting whose frontier tick is due.
ShipmentAssignmentSessionSchema.index({ status: 1, frontier_at: 1 });

export const ShipmentAssignmentSessionModel = mongoose.model<IShipmentAssignmentSession>(
  MODELS.SHIPMENT_ASSIGNMENT_SESSION,
  ShipmentAssignmentSessionSchema,
  COLLECTIONS.SHIPMENT_ASSIGNMENT_SESSION
);
