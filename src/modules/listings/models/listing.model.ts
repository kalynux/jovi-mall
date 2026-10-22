import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { actorStampFields } from '../../../core/types/actor-source.types';
import type { VectorisationStatus, IVectorisationJob } from '../../catalog/models/product.model';
import {
  LISTING_STATUSES,
  LISTING_SUSPENSION_REASONS,
  LISTING_REVIEW_STATES,
  LISTING_DECISIONS,
  LISTING_MAX_CATEGORIES,
  LISTING_MAX_PHOTOS,
  LISTING_CONTACT_FIELDS,
  ListingContactField,
  ListingStatus,
  ListingSuspensionReason,
  ListingReviewState,
  ListingDecision,
  ListingOpeningHours,
} from '../domain/listing.types';

/**
 * Listing — a provider vendor's informational service listing (SERVICE-LISTINGS-PLAN § C-2).
 *
 * ⛔ **This collection holds PUBLIC fields only, and that is the whole privacy design.**
 * The WhatsApp number, phone, email, links, exact pin and video live in `listing_contacts`,
 * a different collection. So a `find().lean()` here, any DTO, the vectoriser payload and the
 * admin list cannot carry a contact, because there is none in the document. Do not add a
 * contact-shaped field to this schema, ever — `test:service-listings` scans for it.
 *
 * Two copies of the content:
 *   - `published` — what customers see; null until the first approval.
 *   - `pending`   — the provider's working copy: a first draft, or a revision of a live
 *                   listing (L-5). `review` describes it. Approval copies it to `published`
 *                   (and the contacts' `pending` to their `published`) in ONE transaction.
 *
 * `status` ∈ { draft, pending_review, rejected } only while `published` is null; a live
 * listing being revised stays `live` and carries the revision in `pending` + `review`.
 */

export interface IListingContentDoc {
  title: string;
  company_name: string;
  category_ids: Types.ObjectId[];
  country: string;
  city: string;
  area: string;
  description: string;
  description_rich: unknown | null;
  photo_file_ids: Types.ObjectId[];
  opening_hours: ListingOpeningHours[] | null;
}

export interface IListingSuspension {
  reason: ListingSuspensionReason;
  previous_status: ListingStatus;
  at: Date;
  note: string | null;
  by_user_id: Types.ObjectId | null;
  by_source: 'platform' | 'admin';
  by_name: string | null;
}

/** A text pre-flag (O-15): help for the reviewer, never a decision. */
export interface IListingPreflag {
  kind: 'phone' | 'email' | 'url';
  field: string;   // which public field it was found in
  excerpt: string; // the matched text, as typed
}

export interface IListingReview {
  state: ListingReviewState;
  submitted_at: Date | null;
  decided_at: Date | null;
  decided_by_user_id: Types.ObjectId | null;
  decided_by_source: 'platform' | 'admin';
  decided_by_name: string | null;
  reasons: string[];
  preflags: IListingPreflag[];
  /** The ledger row of the indexing fee taken at submission (O-18); refunded on reject/withdraw. */
  index_fee_ref: string | null;
}

export interface IListingDecision {
  decision: ListingDecision;
  at: Date;
  by_user_id: Types.ObjectId | null;
  by_source: 'platform' | 'admin';
  by_name: string | null;
  reasons: string[];
}

export interface IListing extends Document {
  vendor_id: Types.ObjectId;
  slug: string;
  status: ListingStatus;
  suspension: IListingSuspension | null;
  published: IListingContentDoc | null;
  pending: IListingContentDoc | null;
  review: IListingReview | null;
  last_decision: IListingDecision | null;
  /**
   * WHICH contact fields the published version has — names only, never a value. Written by the
   * approve path from `listing_contacts.published`, so a public card can draw one button per
   * field (and price it) without any public read ever touching the sensitive collection.
   */
  available_fields: ListingContactField[];
  published_at: Date | null;
  archived_at: Date | null;
  vectorisation_status: VectorisationStatus;
  vectorised_data_id: string | null;
  vectorisation_job: IVectorisationJob | null;
  created_at: Date;
  updated_at: Date;
}

const OpeningHoursSchema = new Schema(
  {
    day: {
      type: String,
      required: true,
      enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    },
    open_time: { type: String, required: true },
    close_time: { type: String, required: true },
    is_closed: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * One content copy. Nothing is `required` here: a draft is saved half-written, and
 * completeness is judged at SUBMIT (`LISTING_INCOMPLETE`), not on every save.
 */
const ListingContentSchema = new Schema<IListingContentDoc>(
  {
    title: { type: String, trim: true, maxlength: 120, default: '' },
    company_name: { type: String, trim: true, maxlength: 120, default: '' },
    category_ids: {
      type: [{ type: Schema.Types.ObjectId, ref: MODELS.PRODUCT_CATEGORY }],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= LISTING_MAX_CATEGORIES, message: 'At most 5 categories' },
    },
    country: { type: String, trim: true, uppercase: true, maxlength: 2, default: '' },
    city: { type: String, trim: true, maxlength: 80, default: '' },
    area: { type: String, trim: true, maxlength: 80, default: '' },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    description_rich: { type: Schema.Types.Mixed, default: null },
    photo_file_ids: {
      type: [{ type: Schema.Types.ObjectId, ref: MODELS.FILE }],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= LISTING_MAX_PHOTOS, message: 'At most 10 photos' },
    },
    opening_hours: { type: [OpeningHoursSchema], default: null },
  },
  { _id: false },
);

const SuspensionSchema = new Schema<IListingSuspension>(
  {
    reason: { type: String, enum: LISTING_SUSPENSION_REASONS, required: true },
    previous_status: { type: String, enum: LISTING_STATUSES, required: true },
    at: { type: Date, required: true, default: Date.now },
    note: { type: String, default: null, trim: true, maxlength: 500 },
    by_user_id: { type: Schema.Types.ObjectId, default: null },
    ...actorStampFields('by'),
  },
  { _id: false },
);

const PreflagSchema = new Schema<IListingPreflag>(
  {
    kind: { type: String, enum: ['phone', 'email', 'url'], required: true },
    field: { type: String, required: true },
    excerpt: { type: String, required: true, maxlength: 200 },
  },
  { _id: false },
);

const ReviewSchema = new Schema<IListingReview>(
  {
    state: { type: String, enum: LISTING_REVIEW_STATES, required: true },
    submitted_at: { type: Date, default: null },
    decided_at: { type: Date, default: null },
    decided_by_user_id: { type: Schema.Types.ObjectId, default: null },
    ...actorStampFields('decided_by'),
    reasons: { type: [String], default: [] },
    preflags: { type: [PreflagSchema], default: [] },
    index_fee_ref: { type: String, default: null },
  },
  { _id: false },
);

const DecisionSchema = new Schema<IListingDecision>(
  {
    decision: { type: String, enum: LISTING_DECISIONS, required: true },
    at: { type: Date, required: true },
    by_user_id: { type: Schema.Types.ObjectId, default: null },
    ...actorStampFields('by'),
    reasons: { type: [String], default: [] },
  },
  { _id: false },
);

const VectorisationJobSchema = new Schema<IVectorisationJob>(
  {
    jobId: { type: String, required: true },
    billed: { type: Boolean, required: true, default: false },
    requestedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const ListingSchema = new Schema<IListing>(
  {
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    status: { type: String, enum: LISTING_STATUSES, required: true, default: 'draft' },
    suspension: { type: SuspensionSchema, default: null },
    published: { type: ListingContentSchema, default: null },
    pending: { type: ListingContentSchema, default: null },
    review: { type: ReviewSchema, default: null },
    last_decision: { type: DecisionSchema, default: null },
    available_fields: { type: [{ type: String, enum: LISTING_CONTACT_FIELDS }], default: [] },
    published_at: { type: Date, default: null },
    archived_at: { type: Date, default: null },
    vectorisation_status: {
      type: String,
      enum: ['not_started', 'pending', 'completed', 'failed', 'skipped_no_credits'],
      default: 'not_started',
    },
    vectorised_data_id: { type: String, default: null },
    vectorisation_job: { type: VectorisationJobSchema, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

// The public URL is `/api/public/listings/:slug`, so the slug is unique platform-wide.
ListingSchema.index({ slug: 1 }, { unique: true, name: 'listing_slug_unique' });
// The provider's own list, and the plan-quota slot ordering (oldest first, `_id` tie-break).
ListingSchema.index({ vendor_id: 1, status: 1, created_at: 1 }, { name: 'listing_vendor_status_created' });
// The review queue: what is waiting, oldest submission first.
ListingSchema.index({ 'review.state': 1, 'review.submitted_at': 1 }, { name: 'listing_review_queue' });
// Public browse by place and shelf.
ListingSchema.index(
  { status: 1, 'published.country': 1, 'published.city': 1, 'published.category_ids': 1 },
  { name: 'listing_public_browse' },
);
// Storefront search. One text index per collection; `none` so French and English both match.
ListingSchema.index(
  { 'published.title': 'text', 'published.company_name': 'text', 'published.description': 'text' },
  { name: 'listing_public_text', default_language: 'none', weights: { 'published.title': 5, 'published.company_name': 3, 'published.description': 1 } },
);

export const ListingModel = mongoose.model<IListing>(MODELS.LISTING, ListingSchema, COLLECTIONS.LISTING);
