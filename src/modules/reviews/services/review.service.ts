import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { agentTrustRecomputeWorker } from '../../agents/workers/agent-trust-recompute.worker';
import { IReview, ReviewAuthorRole, ReviewStatus, ReviewSubjectType } from '../models/review.model';
import { initialStatusOf, targetsOf } from '../domain/review-targets';
import {
  ReviewAuthor,
  ReviewEligibility,
  ReviewEligibilityService,
  reviewEligibilityService,
} from '../domain/services/review-eligibility.service';
import { ReviewPage, ReviewRepository, reviewRepository } from '../repositories/review.repository';
import {
  ReviewAggregateRepository,
  reviewAggregateRepository,
} from '../repositories/review-aggregate.repository';

export interface SubmitReviewInput {
  subjectType: ReviewSubjectType;
  subjectId: string;
  rating: number;
  title?: string | null;
  body?: string | null;
}

export interface ModerationActor {
  userId: string | null;
  source: 'platform' | 'admin';
}

/**
 * ReviewService — submission, moderation, and the aggregate refresh that follows
 * either of them.
 *
 * ── The one rule the rest of this file is arranged around ─────────────────────
 * **An aggregate is refreshed by exactly one function, and a trust score is refreshed
 * by exactly one path.** `refreshTargets` is that function; it recomputes every
 * aggregate a review contributes to and then, when an *agent* aggregate moved, asks
 * the trust worker to recompute that agent. Nothing here writes
 * `delivery_agents.trust_signals` — the worker does, from `collectSignals`, which
 * reads `review_aggregates`. So a delivery rating reaches an agent's trust score
 * through one path with one writer at each hop, which is what makes the composite's
 * inputs auditable at all.
 */
export class ReviewService {
  constructor(
    private readonly reviews: ReviewRepository = reviewRepository,
    private readonly aggregates: ReviewAggregateRepository = reviewAggregateRepository,
    private readonly eligibility: ReviewEligibilityService = reviewEligibilityService,
  ) {}

  // ─── Authoring ────────────────────────────────────────────────────────────

  /**
   * Answer "may I review this?" without writing anything.
   *
   * The form is worth showing only to somebody who can submit it, and the
   * alternative is letting a shopper write two paragraphs and then telling them no.
   * It reuses the same gate the write path runs — one implementation, so the button
   * and the endpoint cannot disagree — and additionally reports whether they have
   * already had their say, which eligibility itself does not know about.
   */
  async checkEligibility(
    author: ReviewAuthor,
    subjectType: ReviewSubjectType,
    subjectId: string,
  ): Promise<{ eligible: boolean; reason: string | null; existingReviewId: string | null }> {
    let resolved: ReviewEligibility;
    try {
      resolved = await this.eligibility.resolve(author, subjectType, subjectId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Only the domain's own verdicts become a `false`; anything else is a fault
      // and must surface as one rather than being reported as "not eligible".
      if (
        code === ERROR_CODES.REVIEW_NOT_ELIGIBLE ||
        code === ERROR_CODES.REVIEW_SUBJECT_NOT_REVIEWABLE ||
        code === ERROR_CODES.REVIEW_ROLE_NOT_ALLOWED
      ) {
        return { eligible: false, reason: code, existingReviewId: null };
      }
      throw error;
    }
    void resolved;

    const existing = await this.reviews.findByAuthorAndSubject(subjectType, subjectId, author.userId);
    if (existing) {
      return { eligible: false, reason: ERROR_CODES.REVIEW_ALREADY_EXISTS, existingReviewId: existing._id.toString() };
    }
    return { eligible: true, reason: null, existingReviewId: null };
  }

  /**
   * Submit a review. Eligibility, then one-per-author, then the write.
   *
   * The pre-check on "already reviewed" is a courtesy — it produces a clean 409
   * instead of a duplicate-key error — and it is **not** the enforcement. Two
   * submissions in the same instant both read "none" and both insert; the unique
   * index is what refuses the second, and its E11000 is translated to the same 409 so
   * the caller cannot tell which path caught them.
   */
  async submit(author: ReviewAuthor, input: SubmitReviewInput): Promise<IReview> {
    const resolved = await this.eligibility.resolve(author, input.subjectType, input.subjectId);

    const existing = await this.reviews.findByAuthorAndSubject(input.subjectType, input.subjectId, author.userId);
    if (existing) throw createAppError(ERROR_CODES.REVIEW_ALREADY_EXISTS, 409);

    const title = input.title?.trim() || null;
    const body = input.body?.trim() || null;

    let review: IReview;
    try {
      review = await this.reviews.create({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        authorUserId: author.userId,
        authorRole: author.role,
        rating: input.rating,
        title,
        body,
        status: initialStatusOf({ title, body }),
        orderId: resolved.orderId,
        shipmentId: resolved.shipmentId,
        targetProductId: resolved.productId,
        targetAgentId: resolved.agentId,
        targetAgencyId: resolved.agencyId,
        targetVendorId: resolved.vendorId,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw createAppError(ERROR_CODES.REVIEW_ALREADY_EXISTS, 409);
      }
      throw error;
    }

    // Only a row that actually published changes an aggregate. A `pending` one moves
    // nothing until a moderator says so, which is what makes the queue meaningful.
    if (review.status === 'published') await this.refreshTargets(review);

    return review;
  }

  /** This author's own reviews, every status — they can see their pending row. */
  async listMine(author: ReviewAuthor, page: number, limit: number, status?: ReviewStatus): Promise<ReviewPage> {
    return await this.reviews.listByAuthor(author.userId, page, limit, status);
  }

  // ─── Public reads ─────────────────────────────────────────────────────────

  /**
   * A product's published reviews, for the storefront.
   *
   * **Product reviews only.** There is deliberately no public read of a delivery
   * review: it is an internal quality signal about a named agent, written by three
   * parties who each see a different slice of the transaction, and publishing it
   * would put an agent's individual performance record on the open internet. The
   * derived *aggregate* reaches the agency directory (a business's service rating);
   * the rows themselves do not leave the platform.
   */
  async listPublicForProduct(productId: string, page: number, limit: number): Promise<ReviewPage> {
    return await this.reviews.listPublishedForSubject('product', productId, page, limit);
  }

  // ─── Moderation ───────────────────────────────────────────────────────────

  async listForModeration(
    page: number,
    limit: number,
    filters: { status?: ReviewStatus; subjectType?: ReviewSubjectType; authorRole?: ReviewAuthorRole },
  ): Promise<ReviewPage> {
    return await this.reviews.listForModeration(page, limit, filters);
  }

  async getById(id: string): Promise<IReview> {
    const review = await this.reviews.findById(id);
    if (!review) throw createAppError(ERROR_CODES.REVIEW_NOT_FOUND, 404);
    return review;
  }

  /** Publish a held review. Compare-and-set on `pending`; a miss is a 409. */
  async publish(id: string, actor: ModerationActor): Promise<IReview> {
    return await this.moderate(id, 'published', actor, null);
  }

  /**
   * Reject a held review. The reason is required and is **never shown to the public
   * or to the author** — it is the moderator's record of why, for the next person
   * looking at the same account.
   */
  async reject(id: string, actor: ModerationActor, reason: string): Promise<IReview> {
    return await this.moderate(id, 'rejected', actor, reason);
  }

  private async moderate(
    id: string,
    next: 'published' | 'rejected',
    actor: ModerationActor,
    reason: string | null,
  ): Promise<IReview> {
    const updated = await this.reviews.moderateIfPending(id, next, {
      userId: actor.userId,
      source: actor.source,
      reason,
    });

    if (!updated) {
      // Distinguish "no such review" from "somebody moderated it first". Both are
      // dead ends for this request, but only one of them means reload and look again.
      const exists = await this.reviews.findById(id);
      if (!exists) throw createAppError(ERROR_CODES.REVIEW_NOT_FOUND, 404);
      throw createAppError(ERROR_CODES.REVIEW_NOT_PENDING, 409, undefined, { status: exists.status });
    }

    // Both verdicts refresh, and the rejection branch is the load-bearing one: a
    // recompute over `status: 'published'` is what makes "a rejected review counts
    // for nothing, star included" true without anybody subtracting anything.
    await this.refreshTargets(updated);
    return updated;
  }

  // ─── The single aggregate-refresh path ────────────────────────────────────

  /**
   * Recompute every aggregate this review contributes to, then nudge the agent's
   * trust score if one of them was an agent's.
   *
   * The trust nudge is **fire-and-forget**, exactly as `CodTrustService.applyEvent`'s
   * is and for the same reason: a trust recompute must never fail the write that
   * triggered it, and the nightly sweep is the backstop. `recomputeOne` catches its
   * own errors; the `void` is here to say so at the call site.
   *
   * Why nudge at all, when a nightly sweep would pick it up: after Step 11 the
   * composite IS the live score, and a rating that only takes effect at 03:00 would
   * reintroduce exactly the delay D-2's immediate-recompute clause was taken to
   * remove. Before Step 11 it costs one shadow write and keeps the two paths
   * identical, so the flip changes nothing here.
   */
  private async refreshTargets(review: IReview): Promise<void> {
    const targets = targetsOf({
      subjectType: review.subject_type,
      authorRole: review.author_role,
      productId: review.target_product_id?.toString() ?? null,
      agentId: review.target_agent_id?.toString() ?? null,
      agencyId: review.target_agency_id?.toString() ?? null,
    });

    for (const target of targets) {
      await this.aggregates.recompute({
        targetType: target.type,
        targetId: target.id,
        authorRole: review.author_role,
      });
    }

    if (targets.some((t) => t.type === 'agent')) {
      void agentTrustRecomputeWorker.recomputeOne(review.target_agent_id!.toString());
    }
  }
}

export const reviewService = new ReviewService();
