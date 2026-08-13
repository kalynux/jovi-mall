import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { GeoPointSchema } from '../../../core/types/geo.types';
import { GeoAddressSchema } from '../../../core/types/geo-address.types';
import { IShipmentHandoverPickup } from '../../shipments/shipment.model';

/**
 * ShipmentAssignmentOffer — one attempt to place a shipment with an agent under
 * the agent-acceptance workflow.
 *
 * ── Why a separate collection (and NOT a new shipment status) ────────────────
 *
 * The shipment `status` enum is a cross-service contract: it is duplicated in
 * geo-tracker (`webhook/domain/entity.go`) and drives TRACKABLE_SHIPMENT_STATUSES,
 * ACTIVE_SHIPMENT_STATUSES and the validators. Modelling "awaiting acceptance"
 * as a shipment status would ripple into all of them and into the Go service.
 *
 * So the offer lives here. While an offer is `pending`, the shipment stays
 * `assigned` (to the agency) with `agent_id = null`; acceptance is the moment
 * `agent_id` is written — the existing "assigned to an agent" event. Because
 * `visible-agents.service.ts` filters `agent_id != null`, the agent is invisible
 * to the customer/agency until they accept, and becomes trackable the instant
 * they do (the shipment is already in a trackable status).
 *
 * ── The rows ARE the audit trail ─────────────────────────────────────────────
 *
 * One row per (shipment, agent) attempt, appended in sequence. Reading a
 * shipment's offers in order tells the whole story: who it was offered to, why
 * (score + breakdown), and what they did (accept / reject / ignore-timeout).
 *
 * ── Several offers can be live at once (auto-assignment) ──────────────────────
 *
 * Under the auto-assignment requirement a timed-out (ignored) agent KEEPS their
 * offer and can still accept while the shipment is unassigned. So for an AUTO
 * offer, a timeout does NOT move the offer off `pending` — the broadcast simply
 * also offers the next agent, and several `pending` offers accumulate for the
 * one shipment (linked by `session_id`). The single serialisation point is the
 * shipment-level bind CAS (`ShipmentRepository.bindAgentIfUnassigned`), not an
 * offer-uniqueness constraint — which is why the old one-pending-offer partial
 * unique index is gone. `expired` therefore applies only to MANUAL offers (which
 * remain one-shot). MANUAL offers still expire on timeout.
 */

export type OfferStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'expired' // a MANUAL offer the agent ignored past expires_at (auto offers stay pending)
  | 'cancelled' // the agency withdrew it, or the session was disposed of
  | 'superseded'; // another agent won the shipment; this standing offer is retired

/** How the offer was created. */
export type OfferOrigin = 'manual' | 'auto';

/**
 * A ranked candidate captured on an AUTO offer, so the timeout/reject branch can
 * walk to the next agent WITHOUT recomputing eligibility + scoring (the spec's
 * "assign the next agent in the previously computed list").
 */
export interface IOfferCandidate {
  agent_id: mongoose.Types.ObjectId;
  rank: number;
  score: number;
  /** Why this agent scored as they did — audit + explainability. */
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

export interface IShipmentAssignmentOffer extends Document {
  shipment_id: mongoose.Types.ObjectId;
  order_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;
  agent_id: mongoose.Types.ObjectId;

  status: OfferStatus;
  origin: OfferOrigin;

  /**
   * The auto-assignment session (temporary ranking) this offer belongs to, for
   * an AUTO offer. Null for a manual pick. Auto offers never expire on the sweep
   * — their lifecycle is driven by the session; only manual offers (null here)
   * are reaped on timeout.
   */
  session_id: mongoose.Types.ObjectId | null;
  /** Which broadcast round created (or last re-nudged) this offer. 0 for manual. */
  round: number;

  /**
   * Who created the offer. `system` for auto, `agency` for a manual pick, `admin` for a
   * platform intervention.
   *
   * `name` is a snapshot, and it exists for the `admin` case: that `user_id` belongs to
   * the wi-admin database and resolves to nothing here, so without it a reader sees an
   * offer placed by an unresolvable id. No `_source` field is needed — `role` IS the
   * discriminator (`actorSourceOfRole()`), and since the Phase 0.5 patch there is no way
   * to hold the `admin` role on a platform `users` row.
   */
  created_by: {
    role: 'agency' | 'system' | 'admin';
    user_id: mongoose.Types.ObjectId | null;
    name?: string | null;
  };

  /** now + ASSIGNMENT_CONFIG.OFFER_TIMEOUT_SECONDS at creation time. */
  expires_at: Date;
  /** When the agent accepted/rejected, or the sweep expired it. Null while pending. */
  responded_at: Date | null;
  /** The agent's declined reason (free-text-ish; short). */
  rejection_reason: string | null;

  /** This offer's own score (rank-0's score for manual; the chosen rank's for auto). */
  score: number | null;
  score_breakdown: IOfferCandidate['breakdown'];

  /** AUTO only — the ranked list this offer was drawn from. Empty for manual. */
  candidate_pool: IOfferCandidate[];
  /** Index into candidate_pool this offer corresponds to (auto). 0 for manual. */
  pool_index: number;

  /** COD snapshot at offer time (for the agent's decision + the audit). */
  is_cod: boolean;
  expected_cod_amount: number | null;
  currency: string | null;

  /**
   * Where to collect the shipment, for a REASSIGNMENT offer — the handover point
   * computed from the shipment's status when it was reassigned (see
   * IShipmentHandover). Null for an ordinary first-assignment offer, where the
   * agent uses the order's per-item pickup locations.
   */
  pickup_location: IShipmentHandoverPickup | null;

  created_at: Date;
  updated_at: Date;
}

const OfferCandidateSchema = new Schema<IOfferCandidate>(
  {
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    rank: { type: Number, required: true },
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

const ShipmentAssignmentOfferSchema = new Schema<IShipmentAssignmentOffer>(
  {
    shipment_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT, required: true },
    order_id: { type: Schema.Types.ObjectId, ref: MODELS.ORDER, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded'],
      default: 'pending',
      required: true,
    },
    origin: { type: String, enum: ['manual', 'auto'], required: true },
    session_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT_ASSIGNMENT_SESSION, default: null },
    round: { type: Number, default: 0 },
    created_by: {
      type: new Schema(
        {
          role: { type: String, enum: ['agency', 'system', 'admin'], required: true },
          user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
          name: { type: String, default: null, trim: true, maxlength: 200 },
        },
        { _id: false }
      ),
      required: true,
    },
    expires_at: { type: Date, required: true },
    responded_at: { type: Date, default: null },
    rejection_reason: { type: String, default: null, trim: true, maxlength: 500 },
    score: { type: Number, default: null },
    score_breakdown: {
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
    candidate_pool: { type: [OfferCandidateSchema], default: [] },
    pool_index: { type: Number, default: 0 },
    is_cod: { type: Boolean, default: false, required: true },
    expected_cod_amount: { type: Number, default: null },
    currency: { type: String, default: null },
    pickup_location: {
      type: new Schema<IShipmentHandoverPickup>(
        {
          source: {
            type: String,
            enum: ['previous_agent_location', 'original_pickup', 'agency_business', 'manual'],
            required: true,
          },
          label: { type: String, default: null, trim: true },
          address: {
            type: new Schema(
              {
                line1: { type: String, default: null, trim: true },
                line2: { type: String, default: null, trim: true },
                city: { type: String, default: null, trim: true },
                state: { type: String, default: null, trim: true },
                country: { type: String, default: null, trim: true },
              },
              { _id: false }
            ),
            default: null,
          },
          location: { type: GeoPointSchema, default: null },
          geo: { type: GeoAddressSchema, default: null },
          note: { type: String, default: null, trim: true, maxlength: 500 },
          is_fallback: { type: Boolean, default: false },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Agent work queue: "my offers", newest first.
ShipmentAssignmentOfferSchema.index({ agent_id: 1, status: 1, created_at: -1 });
// A shipment's offer history + the "supersede the losing standing offers" sweep.
ShipmentAssignmentOfferSchema.index({ shipment_id: 1, status: 1 });
// The accept path: this agent's standing offer for this shipment (there is at
// most one pending offer PER AGENT per shipment — the broadcast never re-offers
// the same agent twice; enforced in the repository, not with a unique index).
ShipmentAssignmentOfferSchema.index({ shipment_id: 1, agent_id: 1, status: 1 });
// The MANUAL-offer expiry sweep: pending manual (session_id: null) rows past
// their deadline. Auto offers never expire, so they are excluded by the query.
ShipmentAssignmentOfferSchema.index({ session_id: 1, status: 1, expires_at: 1 });
//
// NOTE: the old partial-unique index on `{ shipment_id }` where status:'pending'
// (one live offer per shipment) was DELETED on purpose. The auto-assignment
// requirement needs several standing offers per shipment at once (a timed-out
// agent keeps an acceptable offer); the single winner is now decided by the
// shipment-level bind CAS, not by an offer-uniqueness constraint.

export const ShipmentAssignmentOfferModel = mongoose.model<IShipmentAssignmentOffer>(
  MODELS.SHIPMENT_ASSIGNMENT_OFFER,
  ShipmentAssignmentOfferSchema,
  COLLECTIONS.SHIPMENT_ASSIGNMENT_OFFER
);
