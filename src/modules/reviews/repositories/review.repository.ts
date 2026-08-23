import { Types } from 'mongoose';
import {
  IReview,
  ReviewAuthorRole,
  ReviewModel,
  ReviewStatus,
  ReviewSubjectType,
} from '../models/review.model';

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
  status: 'pending' | 'published';
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
      status: input.status,
      // Stamped here rather than in a hook: a review that lands `published` is
      // published AT its creation, and a later moderation never rewrites this.
      published_at: input.status === 'published' ? new Date() : null,
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

  /** "My reviews", for any author role. Every status — the author sees their own pending row. */
  async listByAuthor(authorUserId: string, page: number, limit: number, status?: ReviewStatus): Promise<ReviewPage> {
    const filter: Record<string, unknown> = {
      author_user_id: new Types.ObjectId(authorUserId),
      deletedAt: null,
      ...(status ? { status } : {}),
    };
    return await this.paginate(filter, page, limit, { createdAt: -1 });
  }

  /**
   * The moderation queue.
   *
   * Defaults to `pending` and **oldest first** — a queue is worked front to back, and
   * the row that has been waiting longest is the one a reviewer owes an answer to.
   * Every other listing here is newest-first; this one is the exception on purpose.
   */
  async listForModeration(
    page: number,
    limit: number,
    filters: { status?: ReviewStatus; subjectType?: ReviewSubjectType; authorRole?: ReviewAuthorRole },
  ): Promise<ReviewPage> {
    const filter: Record<string, unknown> = {
      deletedAt: null,
      status: filters.status ?? 'pending',
      ...(filters.subjectType ? { subject_type: filters.subjectType } : {}),
      ...(filters.authorRole ? { author_role: filters.authorRole } : {}),
    };
    return await this.paginate(filter, page, limit, { createdAt: 1 });
  }

  /**
   * Move a review out of `pending`, as a compare-and-set.
   *
   * `null` back is a **conflict, never a not-found**: the row exists, another
   * administrator simply decided first. Same shape and same reasoning as
   * `StockAdjustmentRequestRepository`'s resolve — without the filter on `pending`,
   * two moderators can publish and reject the same review and the loser's aggregate
   * recompute still runs, against a status nobody chose.
   */
  async moderateIfPending(
    id: string,
    next: 'published' | 'rejected',
    moderator: { userId: string | null; source: 'platform' | 'admin'; reason: string | null },
  ): Promise<IReview | null> {
    const now = new Date();
    const set: Record<string, unknown> = {
      status: next,
      moderation: {
        by_user_id: moderator.userId ? new Types.ObjectId(moderator.userId) : null,
        by_source: moderator.source,
        at: now,
        reason: moderator.reason,
      },
    };
    // `published_at` is stamped once and never cleared — it says when this text was
    // first visible, which stays true after a later rejection takes it down.
    if (next === 'published') set.published_at = now;

    return await ReviewModel.findOneAndUpdate(
      { _id: id, status: 'pending', deletedAt: null },
      { $set: set },
      { new: true },
    );
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
