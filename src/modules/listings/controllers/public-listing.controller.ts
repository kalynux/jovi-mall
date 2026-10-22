import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { publicListingService } from '../domain/services/public-listing.service';
import {
  PublicListingListQuerySchema,
  PublicListingsByIdsQuerySchema,
  PublicListingSlugParamSchema,
} from '../validators/listing.validator';

/**
 * Unauthenticated reads of published listings — `/api/public/listings*` (§ C-3 "Public").
 * Read-only, no identity, five-minute cache: the storefront catalogue's convention and reason
 * (`catalog/controllers/public-catalog.controller.ts`).
 */
const PUBLIC_CACHE_SECONDS = 300;
const cacheable = (res: Response): Response => res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);

export class PublicListingController {
  /** GET /api/public/listings?q&category&country&city&area&page&limit → page of PublicListingCard */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = PublicListingListQuerySchema.parse(req.query);
    const page = await publicListingService.list(query);
    cacheable(res).json({ success: true, data: page.data, meta: page.meta });
  });

  /**
   * GET /api/public/listings/by-ids?ids=a,b → `{ data: PublicListingCard[], missing[] }`, in the
   * order asked. The bot's freshness gate: an id the index still holds but that is no longer
   * publishable comes back in `missing`, never as a card.
   */
  static byIds = asyncHandler(async (req: Request, res: Response) => {
    const { ids } = PublicListingsByIdsQuerySchema.parse(req.query);
    const { data, missing } = await publicListingService.byIds(ids);
    cacheable(res).json({ success: true, data, missing });
  });

  /** GET /api/public/listings/:slug → PublicListingDetail */
  static bySlug = asyncHandler(async (req: Request, res: Response) => {
    const { slug } = PublicListingSlugParamSchema.parse(req.params);
    cacheable(res).json({ success: true, data: await publicListingService.bySlug(slug) });
  });
}
