import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { WishlistRepository, wishlistRepository } from '../repositories/wishlist.repository';
import {
  CustomerCatalogEntryDto,
  hydrateCustomerCatalogEntries,
} from '../dto/customer-catalog.dto';
import { PublicCatalogService, publicCatalogService } from '../../catalog/services/public-catalog.service';

/**
 * Saved products — a customer's wishlist (Phase 6 · 6.E.1).
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
    private readonly catalog: PublicCatalogService = publicCatalogService
  ) {}

  /**
   * One page of saved products, newest save first.
   *
   * `at` is when the product was **saved**. Re-saving does not move it — see the
   * repository's `$setOnInsert`.
   */
  async list(
    customerId: string,
    page: number,
    limit: number
  ): Promise<{ data: CustomerCatalogEntryDto[]; meta: { total: number; page: number; limit: number; pages: number } }> {
    const { rows, total } = await this.repo.listPage(customerId, page, limit);

    const data = await hydrateCustomerCatalogEntries(
      rows.map((row) => ({ productId: row.product_id.toString(), at: row.created_at })),
      this.catalog
    );

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

  /** Remove a save. A row that is not this customer's simply is not found. */
  async remove(customerId: string, productId: string): Promise<void> {
    const removed = await this.repo.remove(customerId, productId);
    if (!removed) throw createAppError(ERROR_CODES.WISHLIST_ITEM_NOT_FOUND, 404);
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
}

export const wishlistService = new WishlistService();
