import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { PublicProductListItemDto } from '../dto/public-product.dto';
import { RELATED_PRODUCTS_CONFIG } from '../config/related-products.config';
import {
    RelatedProductsRepositoryMongo,
    relatedProductsRepository,
} from '../repositories/mongo/related-products.repository.mongo';
import { PublicCatalogService, publicCatalogService } from './public-catalog.service';
import { RelatedProductsCache, relatedProductsCache, CachedRelatedRanking } from './related-products.cache';

/**
 * "Customers also bought" (Phase 6 · 6.E.3).
 *
 * ── It is a READ. Nothing here writes anything. ─────────────────────────────
 * No new counter, no new column, no view-tracking side effect — the signal is computed from
 * order history that already exists. That is the plan's own constraint (9.2) and it is what
 * makes the endpoint safe to put on an unauthenticated, world-readable route: there is no
 * state for an anonymous caller to move.
 *
 * ── Two signals, and the client is told which one it got ────────────────────
 *
 * `co_purchase` is the honest answer — a count of orders in which another product appeared
 * alongside this one. `same_category` is the fallback for a product nobody has bought
 * alongside anything yet, which on a young catalogue is most of them.
 *
 * **`source` is published rather than hidden**, and that is the "do not invent a metric"
 * rule in practice. A strip headed "customers also bought" that is silently ordered by
 * category recency tells shoppers something untrue about other shoppers. With the label,
 * the frontend can head one strip "Frequently bought together" and the other "More in this
 * category", which is both truthful and better copy.
 *
 * `orders` is `null` on every `same_category` entry, structurally — there is no
 * co-occurrence to report, so there is no number to show.
 *
 * ── Staleness is a feature here, within limits ──────────────────────────────
 * The ranking is cached (six hours by default); the **cards are not**. Price, stock and
 * store state move far faster than the ranking does, so hydration runs on every request
 * against the live catalogue. A product that goes off sale therefore disappears from the
 * strip immediately, even though the cached ranking still names it — the hydration drops
 * it, exactly as it drops one from a wishlist.
 */
export interface RelatedProductDto {
    product: PublicProductListItemDto;
    /**
     * How many past orders contained BOTH products. `null` under `same_category`, where no
     * such number exists.
     *
     * ⚠ Derived from a bounded SAMPLE of the subject's recent paid orders
     * (`CO_OCCURRENCE_ORDER_SAMPLE`), not from all of history. It is evidence of a pattern,
     * not an audited total, and `api-doc/public/catalog.md` says so.
     */
    orders: number | null;
}

export interface RelatedProductsResult {
    source: CachedRelatedRanking['source'];
    data: RelatedProductDto[];
}

export class RelatedProductsService {
    constructor(
        private readonly repo: RelatedProductsRepositoryMongo = relatedProductsRepository,
        private readonly catalog: PublicCatalogService = publicCatalogService,
        private readonly cache: RelatedProductsCache = relatedProductsCache,
    ) {}

    /**
     * Products related to `productId`.
     *
     * The subject must itself be publishable — a `404 CATALOG_PRODUCT_NOT_FOUND` otherwise,
     * the same answer and for the same reason as every other public product read: a 403
     * would confirm that a draft id is real, which turns the endpoint into an oracle for a
     * competitor enumerating an unreleased catalogue.
     */
    async forProduct(productId: string, limit = RELATED_PRODUCTS_CONFIG.LIMIT): Promise<RelatedProductsResult> {
        const subject = (await this.catalog.listByIds([productId])).get(productId);
        if (!subject) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        const ranking =
            (await this.cache.read(productId))
            ?? (await this.computeAndCache(productId, subject.category, limit));

        return {
            source: ranking.source,
            data: await this.hydrate(productId, ranking, limit),
        };
    }

    /**
     * Compute a ranking and store it. The cache write is best-effort — see the cache header.
     *
     * ⚠ The co-occurrence branch is tried **first and unconditionally**, and the fallback
     * runs only when it comes back empty. Reversing that — deciding by "does this product
     * have enough orders" — would need a second query to answer, and would encode a
     * threshold nobody has evidence for. "Did the honest signal produce anything?" is the
     * only question that needs asking, and running the query IS the answer.
     */
    private async computeAndCache(
        productId: string,
        category: string,
        limit: number,
    ): Promise<CachedRelatedRanking> {
        const coPurchased = await this.repo.coOccurring(productId, limit);

        const ranking: CachedRelatedRanking =
            coPurchased.length > 0
                ? {
                      source: 'co_purchase',
                      entries: coPurchased.map((row) => ({ productId: row.productId, orders: row.orders })),
                  }
                : { source: 'same_category', entries: await this.categoryFallback(productId, category, limit) };

        await this.cache.write(productId, ranking);
        return ranking;
    }

    /**
     * The fallback ranking: same category, most recently ordered first, no counts.
     *
     * The category comes from the card `forProduct` has **already** loaded, rather than a
     * second read of the product — and note where it is passed: into the computation, never
     * into the cached value. A category can be edited, and a cached copy of one would go on
     * driving a strip for six hours after the product left it. What is cached is the
     * resulting ranking, which the next expiry recomputes from the live category.
     */
    private async categoryFallback(
        productId: string,
        category: string,
        limit: number,
    ): Promise<CachedRelatedRanking['entries']> {
        if (!category) return [];

        const ids = await this.repo.sameCategoryRecent(productId, category, limit);
        return ids.map((id) => ({ productId: id, orders: null }));
    }

    /**
     * Turn a ranking into cards, in the ranking's order, dropping anything no longer on sale.
     *
     * ⚠ **Dropped, not degraded** — the opposite of what a wishlist does with the same
     * situation, and the difference is who chose the entry. A customer chose to save a
     * product, so an unavailable one is information they are owed ("this is no longer
     * available"). Nobody chose this list; it is a suggestion, and suggesting something that
     * cannot be bought is just a broken card.
     *
     * The subject is filtered out again here even though the aggregation already excludes
     * it. Belt and braces, and cheap: a stale cached ranking written before that exclusion
     * existed would otherwise recommend the page you are already on.
     */
    private async hydrate(
        subjectId: string,
        ranking: CachedRelatedRanking,
        limit: number,
    ): Promise<RelatedProductDto[]> {
        const entries = ranking.entries.filter((e) => e.productId !== subjectId).slice(0, limit);
        if (entries.length === 0) return [];

        const cards = await this.catalog.listByIds(entries.map((e) => e.productId));

        return entries
            .map((entry) => {
                const product = cards.get(entry.productId);
                return product ? { product, orders: entry.orders } : null;
            })
            .filter((row): row is RelatedProductDto => row !== null);
    }
}

export const relatedProductsService = new RelatedProductsService();
