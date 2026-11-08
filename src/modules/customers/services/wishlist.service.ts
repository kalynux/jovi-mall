import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { WishlistRepository, wishlistRepository } from '../repositories/wishlist.repository';
import {
  CustomerCatalogEntryDto,
  SavedEntryDto,
  SavedListingEntryDto,
} from '../dto/customer-catalog.dto';
import { kindOfWishlistRow, WishlistItemKind } from '../models/wishlist-item.model';
import { PublicCatalogService, publicCatalogService } from '../../catalog/services/public-catalog.service';
import type { PublicListingCard } from '../../listings/dto/public-listing.dto';
import { publicListingService } from '../../listings/domain/services/public-listing.service';

/** The one read of the listings module this service needs: public cards by id, in the order asked. */
export interface SavedListingReader {
  byIds(ids: string[]): Promise<{ data: PublicListingCard[]; missing: string[] }>;
}

/**
 * Saved items — a customer's wishlist (Phase 6 · 6.E.1): products, and since 2026-11-08 service
 * listings in the same list (LISTING-REVIEWS-SAVES-REFERRALS-PLAN § 3.2, owner RS-1).
 *
 * Three verbs and no more: list, add, remove. `/shop/saved` in the storefront works from
 * `localStorage` today and does not survive a device change; this is the same list, kept
 * server-side.
 *
 * ── The three rules worth knowing before extending it ────────────────────────
 *
 * **1. Adding is idempotent, and the INDEX is what makes it so.** Not a `findOne` first —
 * see the repository. A second tap answers 200 with the same entry rather than a 409,
 * because from the customer's side "it is saved" was already true and telling them
 * otherwise is a bug report waiting to happen.
 *
 * **2. Saving does not validate that the product is on sale.** A customer can save
 * something that is temporarily out of stock or whose store is on holiday, and it should
 * still be there when it comes back. What the *read* does is degrade an entry it cannot
 * resolve — see `CustomerCatalogEntryDto`. The one thing add refuses is a product that has
 * never been publishable to this caller at all, which is a 404, the same answer the public
 * catalogue gives.
 *
 * **3. Another customer's row is NOT FOUND, never forbidden.** Every query is scoped by
 * `customer_id`, so a delete for somebody else's save simply matches nothing. A 403 would
 * confirm the row exists.
 */
export class WishlistService {
  constructor(
    private readonly repo: WishlistRepository = wishlistRepository,
    private readonly catalog: PublicCatalogService = publicCatalogService,
    private readonly listings: SavedListingReader = publicListingService
  ) {}

  /**
   * One page of saved items, newest save first — products and service listings interleaved by
   * when each was saved (owner RS-1), or one kind when `kind` is given.
   *
   * `at` is when the item was **saved**. Re-saving does not move it — see the repository's
   * `$setOnInsert`. Each kind is hydrated in ONE query, and an item that no longer resolves
   * degrades to a `null` card rather than vanishing (see `customer-catalog.dto.ts`).
   */
  async list(
    customerId: string,
    page: number,
    limit: number,
    kind?: WishlistItemKind
  ): Promise<{ data: SavedEntryDto[]; meta: { total: number; page: number; limit: number; pages: number } }> {
    const { rows, total } = await this.repo.listPage(customerId, page, limit, kind);

    const productIds = rows.filter((r) => kindOfWishlistRow(r) === 'product').map((r) => String(r.product_id));
    const listingIds = rows.filter((r) => kindOfWishlistRow(r) === 'listing').map((r) => String(r.listing_id));

    const [products, listingCards] = await Promise.all([
      productIds.length ? this.catalog.listByIds(productIds) : Promise.resolve(new Map()),
      listingIds.length ? this.listings.byIds(listingIds) : Promise.resolve({ data: [], missing: [] }),
    ]);
    const listings = new Map(listingCards.data.map((c) => [c.id, c]));

    const data: SavedEntryDto[] = rows.map((row) => {
      if (kindOfWishlistRow(row) === 'listing') {
        const listingId = String(row.listing_id);
        return { kind: 'listing', listingId, at: row.created_at, listing: listings.get(listingId) ?? null };
      }
      const productId = String(row.product_id);
      return { kind: 'product', productId, at: row.created_at, product: products.get(productId) ?? null };
    });

    return {
      data,
      meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /**
   * Save a product.
   *
   * The publishability check runs FIRST, and it is deliberately the only gate: a product a
   * shopper cannot see must not become a wishlist row, because that row would then be a
   * durable handle on a listing they were never shown. Once saved, the row survives the
   * product going away — that is rule 2 above, and the two are not in tension: one is about
   * what may ENTER the list, the other about what may stay in it.
   */
  async add(customerId: string, productId: string): Promise<CustomerCatalogEntryDto> {
    const card = (await this.catalog.listByIds([productId])).get(productId);
    if (!card) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

    const row = await this.repo.add(customerId, productId);
    return { productId, at: row.created_at, product: card };
  }

  /**
   * Save a service listing (2026-11-08). The same gate as a product: only a listing the public
   * can see may enter the list, so the row is never a handle on one this customer was not shown.
   *
   * ⛔ **Nothing reaches the provider** (owner RS-2): no count, no notification, no lead, and no
   * contact is revealed. A save is the customer's private bookmark.
   */
  async addListing(customerId: string, listingId: string): Promise<SavedListingEntryDto> {
    const { data } = await this.listings.byIds([listingId]);
    const card = data.find((c) => c.id === listingId);
    if (!card) throw createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');

    const row = await this.repo.addListing(customerId, listingId);
    return { kind: 'listing', listingId, at: row.created_at, listing: card };
  }

  /** Remove a save. A row that is not this customer's simply is not found. */
  async remove(customerId: string, productId: string): Promise<void> {
    const removed = await this.repo.remove(customerId, productId);
    if (!removed) throw createAppError(ERROR_CODES.WISHLIST_ITEM_NOT_FOUND, 404);
  }

  /** Remove a saved listing. Not this customer's is not found. */
  async removeListing(customerId: string, listingId: string): Promise<void> {
    const removed = await this.repo.removeListing(customerId, listingId);
    if (!removed) throw createAppError(ERROR_CODES.WISHLIST_ITEM_NOT_FOUND, 404);
  }

  /**
   * Remove a saved item by its id, whichever kind it is — the bot's `wishlist_remove`, which is
   * handed one id from `wishlist_list`. An ObjectId names one document platform-wide, so a product
   * id and a listing id cannot both match this customer's rows. Product first: the commoner case,
   * and what every id this tool received before 2026-11-08 was.
   */
  async removeAny(customerId: string, itemId: string): Promise<WishlistItemKind> {
    if (await this.repo.remove(customerId, itemId)) return 'product';
    if (await this.repo.removeListing(customerId, itemId)) return 'listing';
    throw createAppError(ERROR_CODES.WISHLIST_ITEM_NOT_FOUND, 404);
  }

  /**
   * Which of these products the customer has saved — for hearts on a grid.
   *
   * Returns ids rather than a boolean per card so one call serves a whole page. The caller
   * bounds the input; this is not a "give me everything" read.
   */
  async savedAmong(customerId: string, productIds: string[]): Promise<string[]> {
    const saved = await this.repo.savedIdsAmong(customerId, productIds);
    return [...saved];
  }

  /** Which of these listings the customer has saved — for hearts on a listing grid. */
  async savedListingsAmong(customerId: string, listingIds: string[]): Promise<string[]> {
    const saved = await this.repo.savedListingIdsAmong(customerId, listingIds);
    return [...saved];
  }
}

export const wishlistService = new WishlistService();
