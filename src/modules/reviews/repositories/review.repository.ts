import { Types } from 'mongoose';
import {
  IReview,
  ReviewAuthorRole,
  ReviewModel,
  ReviewModerationAction,
  ReviewStatus,
  ReviewSubjectType,
} from '../models/review.model';

/** Who performed a moderation action, and why. Stamped onto `moderation`. */
export interface ModerationStamp {
  userId: string | null;
  source: 'platform' | 'admin';
  reason: string | null;
}

/** The administrators' list filters. Every one optional; none means "every live review". */
export interface AdminReviewFilters {
  status?: ReviewStatus;
  subjectType?: ReviewSubjectType;
  authorRole?: ReviewAuthorRole;
}

export interface ReviewPage {
  data: IReview[];
  meta: { total: number; page: number; limit: number; pages: number };
}

export interface CreateReviewInput {
  subjectType: ReviewSubjectType;
  subjectId: string;
  authorUserId: string;
  authorRole: ReviewAuthorRole;
  rating: number;
  title: string | null;
  body: string | null;
  orderId: string | null;
  shipmentId: string | null;
  targetProductId: string | null;
  targetAgentId: string | null;
  targetAgencyId: string | null;
  targetVendorId: string | null;
}

const oid = (id: string | null): Types.ObjectId | null => (id ? new Types.ObjectId(id) : null);

export class ReviewRepository {
  async create(input: CreateReviewInput): Promise<IReview> {
    return await ReviewModel.create({
      subject_type: input.subjectType,
      subject_id: new Types.ObjectId(input.subjectId),
      author_user_id: new Types.ObjectId(input.authorUserId),
      author_role: input.authorRole,
      rating: input.rating,
      title: input.title,
      body: input.body,
      // Every review publishes on submission (2026-10-05) — there is no held state.
      // `published_at` is stamped here rather than in a hook, and a later unpublish or
      // republish never rewrites it: it says when this text first became visible.
      status: 'published' as ReviewStatus,
      published_at: new Date(),
      moderation: null,
      order_id: oid(input.orderId),
      shipment_id: oid(input.shipmentId),
      target_product_id: oid(input.targetProductId),
      target_agent_id: oid(input.targetAgentId),
      target_agency_id: oid(input.targetAgencyId),
      target_vendor_id: oid(input.targetVendorId),
    });
  }

  async findById(id: string): Promise<IReview | null> {
    return await ReviewModel.findOne({ _id: id, deletedAt: null });
  }

  /** The one-per-author pre-check. The unique index is what actually enforces it. */
  async findByAuthorAndSubject(
    subjectType: ReviewSubjectType,
    subjectId: string,
    authorUserId: string,
  ): Promise<IReview | null> {
    return await ReviewModel.findOne({
      subject_type: subjectType,
      subject_id: new Types.ObjectId(subjectId),
      author_user_id: new Types.ObjectId(authorUserId),
      deletedAt: null,
    });
  }

  /** The public list on a product page — published rows only, newest first. */
  async listPublishedForSubject(
    subjectType: ReviewSubjectType,
    subjectId: string,
    page: number,
    limit: number,
  ): Promise<ReviewPage> {
    const filter = {
      subject_type: subjectType,
      subject_id: new Types.ObjectId(subjectId),
      status: 'published' as ReviewStatus,
      deletedAt: null,
    };
    return await this.paginate(filter, page, limit, { createdAt: -1 });
  }

  /**
   * "My reviews", for any author role. Every status — an author sees their own review
   * marked `unpublished` when an administrator took it down (owner decision: shown as
   * hidden, with no reason given). A DELETED review is gone from this list too.
   */
  async listByAuthor(authorUserId: string, page: number, limit: number, status?: ReviewStatus): Promise<ReviewPage> {
    const filter: Record<string, unknown> = {
      author_user_id: new Types.ObjectId(authorUserId),
      deletedAt: null,
      ...(status ? { status } : {}),
    };
    return await this.paginate(filter, page, limit, { createdAt: -1 });
  }

  /**
   * Every live review, for administrators — **newest first**, every status unless a
   * filter narrows it.
   *
   * This was the moderation queue (`pending`, oldest first) until 2026-10-05. Nothing
   * is held any more, so there is no queue to work front to back; what an administrator
   * needs is "what was written lately", which is newest-first like every other list.
   * Deleted reviews are never listed — delete is the one verb that removes a review
   * from every surface, this one included.
   */
  async listForAdmin(page: number, limit: number, filters: AdminReviewFilters): Promise<ReviewPage> {
    const filter: Record<string, unknown> = {
      deletedAt: null,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.subjectType ? { subject_type: filters.subjectType } : {}),
      ...(filters.authorRole ? { author_role: filters.authorRole } : {}),
    };
    return await this.paginate(filter, page, limit, { createdAt: -1 });
  }

  /**
   * Move a live review from one status to the other, as a compare-and-set on `from`.
   *
   * `null` back is a **conflict, never a not-found**: the row exists and is no longer
   * in `from` — another administrator acted first, or it was already in the target
   * state. Same shape as `StockAdjustmentRequestRepository`'s resolve: without the
   * filter on `from`, two administrators can unpublish and republish the same review
   * and the loser's aggregate recompute still runs, against a status nobody chose.
   *
   * `published_at` says when the text first became visible, so a later unpublish leaves
   * it alone and a republish keeps it — EXCEPT on a row that was never visible. A review
   * rejected under the old held-for-moderation rule was migrated to `unpublished` with
   * `published_at: null`; republishing it stamps now, or the storefront would show a
   * public review with no "reviewed on" date. Hence a pipeline update with `$ifNull`.
   *
   * ⚠ `moderation` goes through `$literal` in that pipeline. In an aggregation `$set` a
   * string beginning with `$` is a FIELD PATH, and `reason` is free text an administrator
   * typed — `"$body"` would copy the review's prose into the moderation record.
   */
  async setStatusIf(
    id: string,
    from: ReviewStatus,
    to: ReviewStatus,
    action: Exclude<ReviewModerationAction, 'deleted'>,
    stamp: ModerationStamp,
  ): Promise<IReview | null> {
    return await ReviewModel.findOneAndUpdate(
      { _id: id, status: from, deletedAt: null },
      [
        {
          $set: {
            status: to,
            moderation: { $literal: this.moderationOf(action, stamp) },
            ...(to === 'published' ? { published_at: { $ifNull: ['$published_at', '$$NOW'] } } : {}),
          },
        },
      ],
      { new: true },
    );
  }

  /**
   * Soft-delete a live review, as a compare-and-set on `deletedAt: null`.
   *
   * Soft, so the row survives for the record — but it leaves every surface (public,
   * author, admin list, every aggregate) AND frees the author's slot, because the
   * one-review-per-author index is partial on `deletedAt: null`. That last effect is
   * the owner's decision and the reason delete exists beside unpublish: a deleted
   * review's author may write again; an unpublished review's author may not.
   */
  async softDeleteIfLive(id: string, stamp: ModerationStamp): Promise<IReview | null> {
    return await ReviewModel.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: { deletedAt: new Date(), moderation: this.moderationOf('deleted', stamp) } },
      { new: true },
    );
  }

  private moderationOf(action: ReviewModerationAction, stamp: ModerationStamp): Record<string, unknown> {
    return {
      action,
      by_user_id: stamp.userId ? new Types.ObjectId(stamp.userId) : null,
      by_source: stamp.source,
      at: new Date(),
      reason: stamp.reason,
    };
  }

  private async paginate(
    filter: Record<string, unknown>,
    page: number,
    limit: number,
    sort: Record<string, 1 | -1>,
  ): Promise<ReviewPage> {
    const [total, data] = await Promise.all([
      ReviewModel.countDocuments(filter),
      ReviewModel.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit),
    ]);
    return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }
}

export const reviewRepository = new ReviewRepository();
