/**
 * Reviews & ratings — the module's public surface.
 *
 * ⚠ **Routes are deliberately NOT re-exported here.** The API layer imports each
 * router from `routes/*` directly, for the reason `agents/index.ts` records: routers
 * pull in `auth.middleware` → `auth.service` → a module barrel, and re-exporting a
 * router from a barrel closes a require cycle that crashes at boot.
 */
export {
  ReviewModel,
  REVIEW_AUTHOR_ROLES,
  REVIEW_STATUSES,
  REVIEW_SUBJECT_TYPES,
} from './models/review.model';
export type { IReview, ReviewAuthorRole, ReviewStatus, ReviewSubjectType } from './models/review.model';

export { ReviewAggregateModel, REVIEW_TARGET_TYPES } from './models/review-aggregate.model';
export type { IReviewAggregate, IReviewRatingDistribution, ReviewTargetType } from './models/review-aggregate.model';

export { averageOf, initialStatusOf, roleMayReview, targetsOf } from './domain/review-targets';
export type { ReviewTarget, ReviewTargetInput } from './domain/review-targets';

export {
  EMPTY_AGGREGATE,
  ReviewAggregateRepository,
  reviewAggregateRepository,
} from './repositories/review-aggregate.repository';
export type { AggregateKey, ReviewAggregateView } from './repositories/review-aggregate.repository';

export { ReviewRepository, reviewRepository } from './repositories/review.repository';
export { ReviewService, reviewService } from './services/review.service';
export {
  ReviewEligibilityService,
  reviewEligibilityService,
} from './domain/services/review-eligibility.service';
export type { ReviewAuthor, ReviewEligibility } from './domain/services/review-eligibility.service';

export {
  toAdminReviewDto,
  toAuthorReviewDto,
  toPublicReviewDto,
  toRatingBreakdownDto,
  toRatingSummaryDto,
} from './dto/review.dto';
export type {
  AdminReviewDto,
  AuthorReviewDto,
  PublicReviewDto,
  RatingBreakdownDto,
  RatingSummaryDto,
} from './dto/review.dto';
