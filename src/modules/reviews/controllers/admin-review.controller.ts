import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { reviewService } from '../services/review.service';
import { toAdminReviewDto } from '../dto/review.dto';
import {
  ModerationQueueQuerySchema,
  RejectReviewSchema,
  ReviewIdParamSchema,
} from '../validators/review.validator';

/**
 * The moderation queue, served to **wi-admin** over `/api/internal/admin/reviews`.
 *
 * ⚠ `req.auth` on this path is SYNTHESISED from headers by `requireAdminCaller` — the
 * administrator holds no `users` row in this database, so the id stamped into
 * `moderation.by_user_id` resolves to nothing here. That is the deliberate trade
 * ADR-004 D-1 records, and `moderation.by_source: 'admin'` is what makes the dangling
 * id legible rather than mysterious. Never add a `.populate()` on it.
 */
const moderator = (req: Request) => ({
  userId: req.auth?.user?._id ? req.auth.user._id.toString() : null,
  source: 'admin' as const,
});

export class AdminReviewController {
  /**
   * GET / — the queue. `pending`, oldest first, unless a filter says otherwise.
   *
   * Oldest-first is the one listing in this module that is not newest-first, and it
   * is deliberate: a queue is worked front to back, and the review that has been
   * waiting longest is the one somebody is owed an answer about.
   */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = ModerationQueueQuerySchema.parse(req.query);
    const page = await reviewService.listForModeration(query.page, query.limit, {
      status: query.status,
      subjectType: query.subjectType,
      authorRole: query.authorRole,
    });
    res.json({
      success: true,
      data: page.data.map(toAdminReviewDto),
      meta: {
        total: page.meta.total,
        page: page.meta.page,
        limit: page.meta.limit,
        totalPages: page.meta.pages,
      },
    });
  });

  /** GET /:id — one review, with the evidence eligibility resolved against it. */
  static getById = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ReviewIdParamSchema.parse(req.params);
    const review = await reviewService.getById(id);
    res.json({ success: true, data: toAdminReviewDto(review) });
  });

  /**
   * POST /:id/publish — let it through.
   *
   * A compare-and-set on `pending`: a losing moderator gets `409 REVIEW_NOT_PENDING`
   * rather than overwriting the winner, exactly as the agency KYC verdict and the
   * stock-request resolve do. Without it, two moderators can publish and reject the
   * same row and the loser's aggregate recompute still runs.
   */
  static publish = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ReviewIdParamSchema.parse(req.params);
    const review = await reviewService.publish(id, moderator(req));
    res.json({ success: true, data: toAdminReviewDto(review) });
  });

  /**
   * POST /:id/reject — body `{ reason }`, required.
   *
   * The rejected review counts for **nothing** afterwards, its star included: the
   * aggregate is recomputed over published rows only, so exclusion is a property of
   * the query rather than of a subtraction somebody has to remember.
   *
   * There is deliberately no un-reject and no re-open. The same position agency KYC
   * takes on its rejection: re-review is the other verb, and a two-way toggle on a
   * moderation verdict makes the audit trail ambiguous about what was ever live.
   */
  static reject = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ReviewIdParamSchema.parse(req.params);
    const { reason } = RejectReviewSchema.parse(req.body ?? {});
    const review = await reviewService.reject(id, moderator(req), reason);
    res.json({ success: true, data: toAdminReviewDto(review) });
  });
}
