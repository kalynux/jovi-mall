import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { reviewService } from '../services/review.service';
import { reviewAggregateRepository } from '../repositories/review-aggregate.repository';
import { toPublicReviewDto, toRatingBreakdownDto } from '../dto/review.dto';
import { ProductIdParamSchema, PublicReviewQuerySchema } from '../validators/review.validator';

/**
 * The storefront's review reader — unauthenticated, like every other `/api/public`
 * route, and subject to the same rule: only data a vendor has deliberately put on
 * sale, or that a moderator has deliberately published.
 *
 * ⚠ **Product reviews only.** There is no public route to a delivery review and there
 * must not be one: a delivery review names an agent (server-side) and is written by
 * three parties who each see a different slice of one transaction. Its aggregate
 * reaches the agency directory as a business's service rating; the rows do not leave
 * the platform. Adding a `subjectType` parameter to this handler would be the
 * shortest possible way to publish an individual courier's performance record.
 */

/** The catalogue's window, for the same reason — see `public-catalog.controller.ts`. */
const PUBLIC_CACHE_SECONDS = 300;

function cacheable(res: Response): Response {
  return res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);
}

export class PublicReviewController {
  /**
   * GET /api/public/products/:productId/reviews
   *
   * Published rows, newest first, plus the rating breakdown in `meta.rating` so the
   * histogram above the list needs no second request. `meta.rating` is **null** when
   * nothing is published — see `toRatingSummaryDto` for why that null is a contract
   * and not a convenience.
   *
   * An unknown or unpublished product answers an empty page rather than a 404. This
   * endpoint's question is "what has been said about this id", and "nothing" is a
   * truthful answer to it; a 404 here would additionally make the route an existence
   * oracle for draft products, which `public-catalog.filter.ts` exists to prevent.
   */
  static listForProduct = asyncHandler(async (req: Request, res: Response) => {
    const { productId } = ProductIdParamSchema.parse(req.params);
    const query = PublicReviewQuerySchema.parse(req.query);

    const [page, aggregate] = await Promise.all([
      reviewService.listPublicForProduct(productId, query.page, query.limit),
      reviewAggregateRepository.find({ targetType: 'product', targetId: productId, authorRole: 'customer' }),
    ]);

    cacheable(res).json({
      success: true,
      data: page.data.map(toPublicReviewDto),
      meta: {
        total: page.meta.total,
        page: page.meta.page,
        limit: page.meta.limit,
        totalPages: page.meta.pages,
        rating: toRatingBreakdownDto(aggregate),
      },
    });
  });
}
