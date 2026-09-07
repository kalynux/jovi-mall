import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import {
  RecentlyViewedRepository,
  recentlyViewedRepository,
} from '../repositories/recently-viewed.repository';
import { CustomerRepository } from '../customer.repository';
import { CUSTOMER_CATALOG_CONFIG } from '../config/customer-catalog.config';
import {
  CustomerCatalogEntryDto,
  hydrateCustomerCatalogEntries,
} from '../dto/customer-catalog.dto';
import { PublicCatalogService, publicCatalogService } from '../../catalog/services/public-catalog.service';

/**
 * The products a customer has looked at, most recent first (Phase 6 · 6.E.2).
 *
 * ── O-2, answered: `Customer.recent_product_code` is KEPT, and this write path maintains it ──
 *
 * That field is a single client-set string, written through `PATCH /api/customer/profile`
 * and returned by the profile DTO as `recentProductCode`. It cannot hold a list, so it is
 * not what this feature extends — but retiring it would break a client that reads it, so
 * `record()` keeps it current as a genuine "last viewed" convenience.
 *
 * ⚠ **One honest consequence, and it is a narrowing rather than a break.** The field never
 * had a defined vocabulary: nothing in this service ever read it, `api-doc/customer/profile.md`
 * documents only "trimmed, clearable", and `BACKEND-SHOP-REQUIREMENTS.md` calls it unused.
 * A server-side writer has to choose a value, and the only handle this platform guarantees
 * for a product is its **id** — a slug is unique per vendor, not globally, which is why the
 * canonical storefront URL nests products under their store. So `record()` writes the
 * product id, the `PATCH` route still accepts anything, and clients wanting more than one
 * entry should read this list instead. Documented in `api-doc/customer/saved-and-viewed.md` —
 * one page covering both lists. (This said `recently-viewed.md`, which has never existed,
 * until 2026-09-07; DOC-PROGRAM F-33.)
 *
 * ── The three properties `test:recently-viewed` pins ─────────────────────────
 *
 * 1. **Re-viewing moves an entry to the head** rather than duplicating it. The unique index
 *    is what forbids the duplicate; `$set: { viewed_at }` is what does the moving.
 * 2. **The cap evicts the oldest.** Enforced on write, never by a TTL — see the config.
 * 3. **The list survives a product going unpublished.** The row stays and the read degrades
 *    it to `product: null`; nothing cascades into this collection.
 */
export class RecentlyViewedService {
  constructor(
    private readonly repo: RecentlyViewedRepository = recentlyViewedRepository,
    private readonly catalog: PublicCatalogService = publicCatalogService,
    private readonly customerRepo: CustomerRepository = new CustomerRepository(),
    private readonly cap: number = CUSTOMER_CATALOG_CONFIG.RECENTLY_VIEWED_CAP
  ) {}

  /**
   * Record that a customer opened a product.
   *
   * The publishability check runs first and refuses a 404, for the same reason the wishlist
   * add does: a product a shopper cannot see must not become a durable row pointing at it.
   * Once recorded, the row survives the product going away — the read degrades it.
   *
   * ⚠ **`viewedAt` is the SERVER clock and there is no client-supplied alternative.** The
   * list is ordered by this value and capped by it, so a client-chosen timestamp is a
   * client-chosen position: a caller could pin an entry at the head forever, or evict
   * everything real by claiming a time in the future. The validator carries no timestamp
   * field at all, so this cannot be relaxed by accident.
   */
  async record(customerId: string, productId: string): Promise<CustomerCatalogEntryDto> {
    const card = (await this.catalog.listByIds([productId])).get(productId);
    if (!card) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

    const viewedAt = new Date();
    const { inserted } = await this.repo.touch(customerId, productId, viewedAt);

    // Only an INSERT can push the list over the cap. Re-viewing something already in it
    // reorders and nothing more, so the common case pays for no eviction query.
    if (inserted) await this.repo.evictBeyondCap(customerId, this.cap);

    await this.maintainRecentProductCode(customerId, productId);

    return { productId, at: viewedAt, product: card };
  }

  /** One page, most recently viewed first. `at` is when the product was **last** opened. */
  async list(
    customerId: string,
    page: number,
    limit: number
  ): Promise<{ data: CustomerCatalogEntryDto[]; meta: { total: number; page: number; limit: number; pages: number } }> {
    const { rows, total } = await this.repo.listPage(customerId, page, limit);

    const data = await hydrateCustomerCatalogEntries(
      rows.map((row) => ({ productId: row.product_id.toString(), at: row.viewed_at })),
      this.catalog
    );

    return {
      data,
      meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /**
   * Forget everything.
   *
   * A history a customer cannot clear is a history they did not agree to keep, and this one
   * has no TTL. `recent_product_code` is cleared with it — leaving it set would make the
   * profile still answer "the last thing you looked at" after the person asked for exactly
   * that to be forgotten.
   */
  async clear(customerId: string): Promise<{ removed: number }> {
    const removed = await this.repo.clear(customerId);
    await this.maintainRecentProductCode(customerId, null);
    return { removed };
  }

  /**
   * Keep the legacy single-value field current (O-2).
   *
   * Best-effort and deliberately non-fatal: it is a convenience mirror of a list that is
   * already correctly stored, so a failure here must not turn a recorded view into an error
   * the customer sees. The list is the source of truth; this field is a courtesy to
   * whatever still reads it.
   */
  private async maintainRecentProductCode(customerId: string, productId: string | null): Promise<void> {
    try {
      await this.customerRepo.updateProfile(customerId, { recent_product_code: productId } as never);
    } catch (error) {
      console.error('[RecentlyViewedService] failed to maintain recent_product_code', error);
    }
  }
}

export const recentlyViewedService = new RecentlyViewedService();
