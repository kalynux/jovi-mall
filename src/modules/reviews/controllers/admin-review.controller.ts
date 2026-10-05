import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { reviewService } from '../services/review.service';
import { toAdminReviewDto } from '../dto/review.dto';
import {
  AdminReviewQuerySchema,
  RepublishReviewSchema,
  ReviewIdParamSchema,
  ReviewModerationReasonSchema,
} from '../validators/review.validator';

/**
 * After-the-fact review moderation, served to **wi-admin** over
 * `/api/internal/admin/reviews`.
 *
 * Every review publishes on submission (owner decision, 2026-10-05); this surface is
 * how an administrator takes one down, puts it back, or deletes it.
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
  /** GET / — every live review, newest first, every status unless a filter narrows it. */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = AdminReviewQuerySchema.parse(req.query);
    const page = await reviewService.listForAdmin(query.page, query.limit, {
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

  /** GET /:id — one live review, with the eligibility evidence attached. */
  static getById = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ReviewIdParamSchema.parse(req.params);
    const review = await reviewService.getById(id);
    res.json({ success: true, data: toAdminReviewDto(review) });
  });

  /**
   * POST /:id/unpublish — body `{ reason }`, required. Takes a published review down.
   *
   * A compare-and-set on `published`: a second administrator gets
   * `409 REVIEW_STATUS_CONFLICT` rather than overwriting the first. The review counts
   * for nothing afterwards, star included.
   */
  static unpublish = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ReviewIdParamSchema.parse(req.params);
    const { reason } = ReviewModerationReasonSchema.parse(req.body ?? {});
    const review = await reviewService.unpublish(id, moderator(req), reason);
    res.json({ success: true, data: toAdminReviewDto(review) });
  });

  /** POST /:id/republish — body `{ reason? }`. Puts an unpublished review back. CAS on `unpublished`. */
  static republish = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ReviewIdParamSchema.parse(req.params);
    const { reason } = RepublishReviewSchema.parse(req.body ?? {});
    const review = await reviewService.republish(id, moderator(req), reason ?? null);
    res.json({ success: true, data: toAdminReviewDto(review) });
  });

  /**
   * DELETE /:id — body `{ reason }`, required. Any status.
   *
   * The review leaves every surface and every aggregate, and its author may write a new
   * one. There is no undelete; a 404 afterwards is the expected answer.
   */
  static remove = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ReviewIdParamSchema.parse(req.params);
    const { reason } = ReviewModerationReasonSchema.parse(req.body ?? {});
    const review = await reviewService.remove(id, moderator(req), reason);
    res.json({ success: true, data: toAdminReviewDto(review) });
  });
}
