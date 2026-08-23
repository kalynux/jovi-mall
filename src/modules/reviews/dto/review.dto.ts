import { IReview, ReviewAuthorRole, ReviewStatus, ReviewSubjectType } from '../models/review.model';
import { IReviewRatingDistribution } from '../models/review-aggregate.model';
import { ReviewAggregateView } from '../repositories/review-aggregate.repository';

/**
 * Three projections of one document, and the differences between them are the
 * access control — the same argument `public-product.dto.ts` makes about itself.
 *
 *   PublicReviewDto   the storefront. No author identity, no moderation record.
 *   AuthorReviewDto   "my reviews". Adds status, so the author can see it is held.
 *   AdminReviewDto    the moderation queue. Adds who wrote it and what was decided.
 *
 * Every one is a hand-written projection rather than a spread, for the reason that
 * file states at length: a spread publishes whatever the model gains next, silently.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Aggregate — the shape every rating slot on the platform renders from
// ─────────────────────────────────────────────────────────────────────────────

export interface RatingSummaryDto {
  average: number;
  count: number;
}

export interface RatingBreakdownDto extends RatingSummaryDto {
  distribution: IReviewRatingDistribution;
}

/**
 * `null` when nothing is published, and that null is a contract rather than a
 * convenience.
 *
 * The storefront's JSON-LD must omit `aggregateRating` entirely when there are no
 * reviews — emitting `{ ratingValue: 0, reviewCount: 0 }` is an invented rating, and
 * Google's review-snippet spam policy treats invented review data as grounds for a
 * manual action. A client cannot get that wrong if the backend never sends a
 * zero-count summary in the first place, so this function returns `null` and the
 * DTO carries `rating: null`. `api-doc/public/catalog.md` says the same thing from
 * the other side.
 */
export function toRatingSummaryDto(aggregate: ReviewAggregateView | undefined | null): RatingSummaryDto | null {
  if (!aggregate || aggregate.count <= 0) return null;
  return { average: aggregate.average, count: aggregate.count };
}

export function toRatingBreakdownDto(aggregate: ReviewAggregateView | undefined | null): RatingBreakdownDto | null {
  if (!aggregate || aggregate.count <= 0) return null;
  return { average: aggregate.average, count: aggregate.count, distribution: { ...aggregate.distribution } };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reviews
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicReviewDto {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  /** When it first became visible — the date a shopper reads as "reviewed on". */
  publishedAt: string | null;
}

export interface AuthorReviewDto extends PublicReviewDto {
  subjectType: ReviewSubjectType;
  subjectId: string;
  status: ReviewStatus;
  createdAt: string;
}

export interface AdminReviewDto extends AuthorReviewDto {
  authorUserId: string;
  authorRole: ReviewAuthorRole;
  /** What the rating attaches to. Present only for the subject type that has it. */
  targets: {
    productId: string | null;
    agentId: string | null;
    agencyId: string | null;
    vendorId: string | null;
  };
  /** The evidence eligibility resolved, so a moderator can check the claim. */
  evidence: { orderId: string | null; shipmentId: string | null };
  moderation: {
    byUserId: string | null;
    bySource: 'platform' | 'admin';
    at: string;
    reason: string | null;
  } | null;
}

/**
 * The storefront's row.
 *
 * ⚠ **It carries no author identity at all** — no name, no id, no initial. That is a
 * deliberate reduction rather than an omission to fill in later: this platform's
 * customers are largely passwordless accounts created from a phone number on first
 * bot contact, so the only "display name" available is frequently derived from that
 * number. Publishing a shopper's name beside their purchase history is a privacy
 * decision nobody has taken, and the honest default is not to. A "Verified purchase"
 * badge is implicit — eligibility means every published review is one.
 */
export function toPublicReviewDto(review: IReview): PublicReviewDto {
  return {
    id: review._id.toString(),
    rating: review.rating,
    title: review.title ?? null,
    body: review.body ?? null,
    publishedAt: review.published_at ? review.published_at.toISOString() : null,
  };
}

export function toAuthorReviewDto(review: IReview): AuthorReviewDto {
  return {
    ...toPublicReviewDto(review),
    subjectType: review.subject_type,
    subjectId: review.subject_id.toString(),
    status: review.status,
    createdAt: review.createdAt.toISOString(),
  };
}

export function toAdminReviewDto(review: IReview): AdminReviewDto {
  return {
    ...toAuthorReviewDto(review),
    authorUserId: review.author_user_id.toString(),
    authorRole: review.author_role,
    targets: {
      productId: review.target_product_id?.toString() ?? null,
      agentId: review.target_agent_id?.toString() ?? null,
      agencyId: review.target_agency_id?.toString() ?? null,
      vendorId: review.target_vendor_id?.toString() ?? null,
    },
    evidence: {
      orderId: review.order_id?.toString() ?? null,
      shipmentId: review.shipment_id?.toString() ?? null,
    },
    moderation: review.moderation
      ? {
          byUserId: review.moderation.by_user_id?.toString() ?? null,
          bySource: review.moderation.by_source,
          at: review.moderation.at.toISOString(),
          reason: review.moderation.reason ?? null,
        }
      : null,
  };
}
