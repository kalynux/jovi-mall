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
 * Nothing is mutated except an offer's own terminal transition + `responded_at`.
 */

export type OfferStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'expired' // agent ignored it past expires_at (the "Ignore" branch)
  | 'cancelled' // the agency withdrew it, or a reassignment superseded the shipment
  | 'superseded'; // defensive: another offer for the same shipment won the race

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

  /** Who created the offer. `system` for auto, `agency` for a manual pick. */
  created_by: {
    role: 'agency' | 'system';
    user_id: mongoose.Types.ObjectId | null;
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
    created_by: {
      type: new Schema(
        {
          role: { type: String, enum: ['agency', 'system'], required: true },
          user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
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
// A shipment's offer history / current live offer.
ShipmentAssignmentOfferSchema.index({ shipment_id: 1, status: 1 });
// The expiry sweep: pending rows past their deadline.
ShipmentAssignmentOfferSchema.index({ status: 1, expires_at: 1 });
// At most ONE live (pending) offer per shipment — the sequential invariant. A
// partial unique index enforces it at the storage layer, so a race between two
// offer-creators for the same shipment cannot produce two pending offers.
ShipmentAssignmentOfferSchema.index(
  { shipment_id: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);

export const ShipmentAssignmentOfferModel = mongoose.model<IShipmentAssignmentOffer>(
  MODELS.SHIPMENT_ASSIGNMENT_OFFER,
  ShipmentAssignmentOfferSchema,
  COLLECTIONS.SHIPMENT_ASSIGNMENT_OFFER
);
