import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * ONE review collection, TWO subjects — and that is the decision this module exists
 * to carry (Phase 6 plan, O-1).
 *
 * It looks as though "reviews & ratings" is a storefront feature. It is not only
 * that. `DeliveryAgent.trust_signals` carries three rating factors worth **50 of the
 * composite trust score's 100 weight**, and nothing in the platform has ever written
 * one — so every agent's rating factors blend to the seed and the composite can only
 * ever raise a score. Building the product half alone would leave that permanently
 * true, and Step 11 (the flip) permanently unreachable.
 *
 * A product review and a delivery review are genuinely different things — different
 * subjects, different eligibility rules, different aggregates — but they are the same
 * *object*: a rating, optionally some prose, by one identified person, about one
 * identified thing, moderated once. So they share a collection, a moderation
 * pipeline and an aggregate mechanism, and are told apart by `subject_type`.
 */
export type ReviewSubjectType = 'product' | 'delivery';

export const REVIEW_SUBJECT_TYPES: ReviewSubjectType[] = ['product', 'delivery'];

/**
 * Who wrote it. Three roles, and on a DELIVERY all three rate the same shipment while
 * feeding three *different* trust factors — see `review-targets.ts`.
 *
 * The customer is the one role that never learns which agent carried their parcel
 * (`orders/dto/customer-shipment.dto.ts` withholds the agent's identity deliberately),
 * and that stays true: they rate the *delivery*, and the attribution to an agent
 * happens here, on the server, from the shipment.
 */
export type ReviewAuthorRole = 'customer' | 'vendor' | 'agency';

export const REVIEW_AUTHOR_ROLES: ReviewAuthorRole[] = ['customer', 'vendor', 'agency'];

/**
 * `pending` → an administrator must look at it. `published` → it counts.
 * `rejected` → it counts for **nothing**, including its star.
 *
 * A rejected review is excluded from the aggregate entirely rather than having its
 * prose hidden and its rating kept. The two are one act of authorship: a review
 * rejected for being abusive is not evidence of anything, and keeping the number
 * would let the abuse land anyway.
 */
export type ReviewStatus = 'pending' | 'published' | 'rejected';

export const REVIEW_STATUSES: ReviewStatus[] = ['pending', 'published', 'rejected'];

/** Who moderated it, when, and why. Null until somebody does. */
export interface IReviewModeration {
  by_user_id: Types.ObjectId | null;
  /** Which identity space `by_user_id` belongs to. `admin` ids resolve nowhere here. */
  by_source: 'platform' | 'admin';
  at: Date;
  /** Required on a rejection, null on a publish. Never shown to the public. */
  reason: string | null;
}

export interface IReview extends IBaseDocument {
  subject_type: ReviewSubjectType;
  /** `Product._id` for a product review, `Shipment._id` for a delivery review. */
  subject_id: Types.ObjectId;

  /**
   * The `users` row, deliberately — not the role entity.
   *
   * One person is one author whichever hat they were wearing, and the unique index
   * below is `(subject_type, subject_id, author_user_id)`. Keying on the role entity
   * would let somebody holding both a customer and a vendor role review one delivery
   * twice.
   */
  author_user_id: Types.ObjectId;
  author_role: ReviewAuthorRole;

  /** 1–5, integer. There is no half-star and there will not be one. */
  rating: number;
  title: string | null;
  body: string | null;

  status: ReviewStatus;
  /** Set when the row first reaches `published`; never cleared by a later rejection. */
  published_at: Date | null;
  moderation: IReviewModeration | null;

  // ── Provenance: the evidence that made this author eligible ────────────────
  // Snapshotted rather than re-derived, so a later change (an order refunded, a
  // shipment reassigned) cannot retroactively invalidate a review that was
  // legitimately earned at the time.
  /** Product reviews: the completed order that proved the purchase. */
  order_id: Types.ObjectId | null;
  /** Delivery reviews: identical to `subject_id`, carried for query convenience. */
  shipment_id: Types.ObjectId | null;

  // ── Targets: what this review's rating is ABOUT ────────────────────────────
  // The *subject* is what was reviewed; the *targets* are what carries the score.
  // For a product they are the same thing. For a delivery the subject is a shipment
  // and the targets are the agent and the agency, both snapshotted here at write
  // time — a reassignment afterwards must not move somebody else's reputation.
  target_product_id: Types.ObjectId | null;
  target_agent_id: Types.ObjectId | null;
  target_agency_id: Types.ObjectId | null;
  /**
   * The seller, on a product review. **Recorded, not aggregated** — no surface reads
   * a vendor's rating today, and writing an aggregate nobody reads is a second thing
   * to keep correct for nothing. It is here so the day one is wanted, the history is
   * already attributable.
   */
  target_vendor_id: Types.ObjectId | null;
}

const ModerationSchema = new Schema<IReviewModeration>(
  {
    by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    by_source: { type: String, enum: ['platform', 'admin'], required: true },
    at: { type: Date, required: true, default: Date.now },
    reason: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const ReviewSchema = new Schema<IReview>(
  {
    subject_type: { type: String, enum: REVIEW_SUBJECT_TYPES, required: true },
    subject_id: { type: Schema.Types.ObjectId, required: true },

    author_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    author_role: { type: String, enum: REVIEW_AUTHOR_ROLES, required: true },

    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: null, trim: true, maxlength: 120 },
    body: { type: String, default: null, trim: true, maxlength: 2000 },

    status: { type: String, enum: REVIEW_STATUSES, required: true, default: 'pending' },
    published_at: { type: Date, default: null },
    moderation: { type: ModerationSchema, default: null },

    order_id: { type: Schema.Types.ObjectId, ref: MODELS.ORDER, default: null },
    shipment_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT, default: null },

    target_product_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, default: null },
    target_agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, default: null },
    target_agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, default: null },
    target_vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, default: null },

    ...BaseSchemaFields,
  },
  BaseSchemaOptions,
);

/**
 * One review per author per subject.
 *
 * ⚠ **This is the only thing that makes "one review each" true**, and it must be
 * built for real — `autoIndex` is off in production, so `migrate:review-indexes`
 * is what creates it. The service pre-checks as well, but a pre-check is a race:
 * two submissions in the same millisecond both read "none" and both insert.
 */
ReviewSchema.index(
  { subject_type: 1, subject_id: 1, author_user_id: 1 },
  { unique: true, name: 'review_one_per_author_per_subject' },
);

/** The public list on a product page: published rows for one subject, newest first. */
ReviewSchema.index({ subject_type: 1, subject_id: 1, status: 1, createdAt: -1 }, { name: 'review_by_subject' });

/**
 * The moderation queue: everything `pending`, OLDEST first.
 *
 * Ascending on purpose — a queue is worked front to back, and the row that has been
 * waiting longest is the one that matters. Every other list here is newest-first.
 */
ReviewSchema.index({ status: 1, createdAt: 1 }, { name: 'review_moderation_queue' });

/** "My reviews", for every author role. */
ReviewSchema.index({ author_user_id: 1, createdAt: -1 }, { name: 'review_by_author' });

/**
 * The two aggregate recomputes. Both are `(target, author_role, status)` because an
 * aggregate row is per (target, author role) — an agent carries three separate
 * averages, one per role that rated them, and they feed three different trust factors.
 */
ReviewSchema.index({ target_agent_id: 1, author_role: 1, status: 1 }, { name: 'review_by_agent_target' });
ReviewSchema.index({ target_agency_id: 1, author_role: 1, status: 1 }, { name: 'review_by_agency_target' });

export const ReviewModel = model<IReview>(MODELS.REVIEW, ReviewSchema, COLLECTIONS.REVIEW);
