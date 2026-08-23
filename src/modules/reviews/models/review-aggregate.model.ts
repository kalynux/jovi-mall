import { Schema, model, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { ReviewAuthorRole, REVIEW_AUTHOR_ROLES } from './review.model';

/**
 * What carries a score. Deliberately NOT the same axis as `ReviewSubjectType`.
 *
 * The *subject* is what a review is written about — a product, or one delivery.
 * The *target* is what the resulting number attaches to. For a product those
 * coincide. For a delivery they do not: nobody wants a shipment's rating, they want
 * the agent's and the agency's, accumulated across every shipment they ran.
 *
 * Keeping the two axes apart is what lets one delivery review move two aggregates
 * without either collection having to know about the other.
 */
export type ReviewTargetType = 'product' | 'agent' | 'agency';

export const REVIEW_TARGET_TYPES: ReviewTargetType[] = ['product', 'agent', 'agency'];

/** The 1–5 histogram, as the storefront's rating breakdown renders it. */
export interface IReviewRatingDistribution {
  '1': number;
  '2': number;
  '3': number;
  '4': number;
  '5': number;
}

export interface IReviewAggregate {
  _id: Types.ObjectId;
  target_type: ReviewTargetType;
  target_id: Types.ObjectId;
  /**
   * WHO rated. An agent has up to three of these rows and they are not
   * interchangeable — `customer` feeds `trust_signals.customer_rating_*` (weight 30),
   * `agency` feeds `agency_rating_*` (10) and `vendor` feeds `vendor_rating_*` (10).
   * Averaging them together would produce a number that answers no question.
   */
  author_role: ReviewAuthorRole;

  count: number;
  /** Sum of the ratings. Kept so `average` is a derivation rather than a stored opinion. */
  sum: number;
  /** `sum / count`, rounded to two decimals. `0` when `count` is 0. */
  average: number;
  distribution: IReviewRatingDistribution;

  computed_at: Date;
}

const DistributionSchema = new Schema<IReviewRatingDistribution>(
  {
    '1': { type: Number, default: 0, min: 0 },
    '2': { type: Number, default: 0, min: 0 },
    '3': { type: Number, default: 0, min: 0 },
    '4': { type: Number, default: 0, min: 0 },
    '5': { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/**
 * ReviewAggregate — a CACHE of an aggregation over `reviews`, never a second source
 * of truth.
 *
 * ── Why every write RECOMPUTES rather than increments ────────────────────────
 * An `$inc` is cheaper and is wrong here. A review's contribution has to be added on
 * publish and removed on rejection, and a moderator can flip a row either way; an
 * increment path has to get every one of those transitions right, forever, and a
 * single missed one leaves a permanently drifted average nobody can detect without
 * recomputing anyway. A recompute is idempotent by construction, and the volumes
 * involved (one product's reviews, one agent's deliveries) make the aggregation
 * cheap. It also makes "a rejected review counts for nothing" true because the
 * query says `status: 'published'`, not because a subtraction was remembered.
 *
 * There is no `deletedAt` here and no `BaseSchemaFields`: a derived row is rebuilt,
 * never soft-deleted.
 */
const ReviewAggregateSchema = new Schema<IReviewAggregate>(
  {
    target_type: { type: String, enum: REVIEW_TARGET_TYPES, required: true },
    target_id: { type: Schema.Types.ObjectId, required: true },
    author_role: { type: String, enum: REVIEW_AUTHOR_ROLES, required: true },

    count: { type: Number, required: true, default: 0, min: 0 },
    sum: { type: Number, required: true, default: 0, min: 0 },
    average: { type: Number, required: true, default: 0, min: 0, max: 5 },
    distribution: { type: DistributionSchema, required: true, default: () => ({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }) },

    computed_at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

/** The identity of an aggregate row, and what every upsert filters on. */
ReviewAggregateSchema.index(
  { target_type: 1, target_id: 1, author_role: 1 },
  { unique: true, name: 'review_aggregate_identity' },
);

export const ReviewAggregateModel = model<IReviewAggregate>(
  MODELS.REVIEW_AGGREGATE,
  ReviewAggregateSchema,
  COLLECTIONS.REVIEW_AGGREGATE,
);
