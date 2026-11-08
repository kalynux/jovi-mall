import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { reviewService } from '../services/review.service';
import { reviewAggregateRepository } from '../repositories/review-aggregate.repository';
import { toPublicReviewDto, toRatingBreakdownDto } from '../dto/review.dto';
import { ListingIdParamSchema, ProductIdParamSchema, PublicReviewQuerySchema } from '../validators/review.validator';
import { listingRepository } from '../../listings/repositories/listing.repository';
import { ReviewPage } from '../repositories/review.repository';
import { ReviewAggregateView } from '../repositories/review-aggregate.repository';

/** The list body every review reader answers: rows, page meta, and the breakdown in `meta.rating`. */
function reviewListBody(page: ReviewPage, aggregate: ReviewAggregateView) {
  return {
    success: true,
    data: page.data.map(toPublicReviewDto),
    meta: {
      total: page.meta.total,
      page: page.meta.page,
      limit: page.meta.limit,
      totalPages: page.meta.pages,
      rating: toRatingBreakdownDto(aggregate),
    },
  };
}

const EMPTY_PAGE = (page: number, limit: number): ReviewPage => ({ data: [], meta: { total: 0, page, limit, pages: 0 } });

/**
 * The storefront's review reader — unauthenticated, like every other `/api/public`
 * route, and subject to the same rule: only data a vendor has deliberately put on
 * sale, and that no administrator has taken down.
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

    cacheable(res).json(reviewListBody(page, aggregate));
  });

  /**
   * GET /api/public/listings/:listingId/reviews (2026-11-08)
   *
   * A service listing's published reviews, newest first, with `meta.rating`. Only for a listing
   * the public can see: a paused or archived one answers the EMPTY page, never a 404 and never
   * its reviews — the route must not tell a stranger that a listing exists, or that it was paused.
   * Rows carry no author identity (`toPublicReviewDto`), as for products.
   */
  static listForListing = asyncHandler(async (req: Request, res: Response) => {
    const { listingId } = ListingIdParamSchema.parse(req.params);
    const query = PublicReviewQuerySchema.parse(req.query);

    const [visible] = await listingRepository.findPublishableByIds([listingId]);
    if (!visible) {
      cacheable(res).json(reviewListBody(EMPTY_PAGE(query.page, query.limit), { count: 0, average: 0, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } }));
      return;
    }

    const [page, aggregate] = await Promise.all([
      reviewService.listPublishedForListing(listingId, query.page, query.limit),
      reviewAggregateRepository.find({ targetType: 'listing', targetId: listingId, authorRole: 'customer' }),
    ]);
    cacheable(res).json(reviewListBody(page, aggregate));
  });

  /**
   * GET /api/vendor/listings/:id/reviews — the PROVIDER's own listing (owner RS-12, 2026-11-08).
   *
   * Mounted on the provider router (`requireRole(['vendor'])` + `requireVendorKind('provider')`).
   * Their own listing in ANY status, paused and archived included — the reviews exist whether or
   * not the public can see them. Another vendor's listing is a 404. The same anonymous rows the
   * public sees: a provider learns what was said, never who said it (they reply nowhere, RS-8).
   */
  static listForOwnListing = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { listingId } = ListingIdParamSchema.parse({ listingId: id });
    const query = PublicReviewQuerySchema.parse(req.query);
    const vendorId = req.auth!.role_entity._id.toString();

    const owned = await listingRepository.findOwned(listingId, vendorId);
    if (!owned) throw createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');

    const [page, aggregate] = await Promise.all([
      reviewService.listPublishedForListing(listingId, query.page, query.limit),
      reviewAggregateRepository.find({ targetType: 'listing', targetId: listingId, authorRole: 'customer' }),
    ]);
    res.json(reviewListBody(page, aggregate));
  });
}
