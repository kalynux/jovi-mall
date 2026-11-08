import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { getStorageProvider } from '../../../../core/storage/storage.instance';
import { LISTING_REVEAL_FIRST_COST, LISTING_REVEAL_NEXT_COST } from '../../../billing/config/credit.config';
import { categoryCatalogCache } from '../../../categories/services/category-catalog.cache';
import { categoryResolutionService } from '../../../categories/services/category-resolution.service';
import { FileRepositoryMongo } from '../../../catalog/repositories/mongo/file.repository.mongo';
import { resolveFileDetails } from '../../../catalog/read-models/file-detail.resolver';
import { isRenderableImage } from '../../../catalog/read-models/product-image.resolver';
import type { FileDetail } from '../../../catalog/read-models/product-detail.read-model';
import { listingRepository, ListingRepository, ListingRow } from '../../repositories/listing.repository';
import { reviewAggregateRepository } from '../../../reviews/repositories/review-aggregate.repository';
import type { ReviewAggregateView } from '../../../reviews/repositories/review-aggregate.repository';
import type { PublicListingListQuery } from '../../validators/listing.validator';
import {
  PublicListingCard,
  PublicListingContext,
  PublicListingDetail,
  PublicListingRating,
  toPublicListingCard,
  toPublicListingDetail,
} from '../../dto/public-listing.dto';

/**
 * The storefront's and the bot's read side for listings (SERVICE-LISTINGS-PLAN § C-3 "Public").
 * World-readable: every read goes through `ListingRepository`'s public pipeline, which applies
 * the ONE predicate in `domain/public-listing.filter.ts`, and every answer is an explicit DTO.
 *
 * It reads `listings` only. `listing_contacts` is not reachable from here — not filtered out,
 * absent: nothing in this file can name it.
 */
export class PublicListingService {
  constructor(
    private readonly repo: ListingRepository = listingRepository,
    private readonly fileRepo: FileRepositoryMongo = new FileRepositoryMongo(),
    private readonly ratings: ListingRatingReader = reviewAggregateRepository,
  ) {}

  async list(query: PublicListingListQuery): Promise<{ data: PublicListingCard[]; meta: { total: number; page: number; limit: number; pages: number } }> {
    let categoryId: string | undefined;
    if (query.category) {
      const ref = await categoryResolutionService.resolveFilter(query.category);
      // An unknown category is an empty shelf, never "ignore the filter".
      if (!ref) return { data: [], meta: { total: 0, page: query.page, limit: query.limit, pages: 0 } };
      categoryId = ref.id;
    }
    const { data, total } = await this.repo.searchPublishable({
      q: query.q,
      categoryId,
      country: query.country,
      city: query.city,
      area: query.area,
      page: query.page,
      limit: query.limit,
    });
    return {
      data: await this.cards(data),
      meta: { total, page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) },
    };
  }

  /** The bot's freshness gate: cards in the order asked, `missing` for anything not publishable. */
  async byIds(ids: string[]): Promise<{ data: PublicListingCard[]; missing: string[] }> {
    const rows = await this.repo.findPublishableByIds(ids);
    const cards = await this.cards(rows);
    const byId = new Map(cards.map((c) => [c.id, c]));
    return {
      data: ids.map((id) => byId.get(id)).filter((c): c is PublicListingCard => !!c),
      missing: ids.filter((id) => !byId.has(id)),
    };
  }

  async bySlug(slug: string): Promise<PublicListingDetail> {
    const row = await this.repo.findPublishableBySlug(slug);
    if (!row) throw createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');
    const [ctx] = await this.contexts([row], false);
    return toPublicListingDetail(row, ctx);
  }

  private async cards(rows: ListingRow[]): Promise<PublicListingCard[]> {
    const ctxs = await this.contexts(rows, true);
    return rows.map((row, i) => toPublicListingCard(row, ctxs[i]));
  }

  /** Categories, renderable photos (first only for a card), costs and the rating, batched. */
  private async contexts(rows: ListingRow[], firstPhotoOnly: boolean): Promise<PublicListingContext[]> {
    // Every photo is resolved even for a card: the first may be quota-blocked or not an image,
    // and the card shows the first one that renders.
    const photoIds = rows.flatMap((r) => (r.published?.photo_file_ids ?? []).map((id) => id.toString()));
    // One query for the whole page's ratings, the product grid's rule (no query per card).
    const [details, ratings] = await Promise.all([
      resolveFileDetails(photoIds, this.fileRepo, getStorageProvider()),
      rows.length ? this.ratings.findMany('listing', rows.map((r) => r._id.toString()), 'customer') : Promise.resolve(new Map()),
    ]);
    const out: PublicListingContext[] = [];
    for (const r of rows) {
      const photos = (r.published?.photo_file_ids ?? [])
        .map((id) => details.get(id.toString()))
        .filter((f): f is FileDetail => isRenderableImage(f));
      out.push({
        categories: await categoryCatalogCache.refsFor(r.published?.category_ids ?? []),
        photos: firstPhotoOnly ? photos.slice(0, 1) : photos,
        revealCosts: { first: LISTING_REVEAL_FIRST_COST, next: LISTING_REVEAL_NEXT_COST },
        rating: listingRatingOf(ratings.get(r._id.toString())),
      });
    }
    return out;
  }
}

/** The one read of the reviews module this service needs: a page of listings' ratings at once. */
export interface ListingRatingReader {
  findMany(targetType: 'listing', ids: string[], authorRole: 'customer'): Promise<Map<string, ReviewAggregateView>>;
}

/**
 * A listing's public rating (2026-11-08, was the wave-1 seam): the customers' published reviews,
 * or `null` when there are none. Null rather than `{ 0, 0 }` is the product card's contract: a
 * client draws no stars for "nobody has said anything".
 */
export function listingRatingOf(aggregate: ReviewAggregateView | undefined): PublicListingRating | null {
  if (!aggregate || aggregate.count <= 0) return null;
  return { average: aggregate.average, count: aggregate.count };
}

export const publicListingService = new PublicListingService();
