import mongoose, { PipelineStage, Types } from 'mongoose';
import { COLLECTIONS } from '../../../../core/database/collections';
import { ProductModel } from '../../models/product.model';
import { publishableProductFilter, VENDOR_PUBLISHABLE_MATCH } from '../../domain/services/public-catalog.filter';
import { RELATED_PRODUCTS_CONFIG } from '../../config/related-products.config';

/**
 * The two signals behind "customers also bought" (Phase 6 · 6.E.3).
 *
 * ── The rule this file is bound by: do not invent a metric ───────────────────
 *
 * The same rule the blog and the JSON-LD work follow. There is exactly one honest answer to
 * "what did people who bought this also buy", and it is **co-occurrence in past orders** —
 * a count of how many times another product appeared in an order alongside this one. That
 * is `coOccurring` below, and it returns a real `orders` count that the api-doc is allowed
 * to describe as what it is.
 *
 * `sameCategoryRecent` is the fallback, and it is deliberately NOT dressed up as the same
 * thing. It answers a different question — "what else is in this category and selling" — and
 * carries no count at all, because there is no co-occurrence to report. A young catalogue
 * has almost no order history, so without a fallback the strip would be empty on nearly
 * every product page for months; with a fallback that *pretended* to be behavioural, the
 * platform would be telling shoppers something untrue about other shoppers.
 *
 * `RelatedProductsService` labels which one it used, and the endpoint publishes the label.
 *
 * ── Both are ordered deterministically ──────────────────────────────────────
 * Every sort ends in `_id` as a tiebreaker, for the reason
 * `PublicCatalogRepositoryMongo.sortStage` gives: Mongo guarantees no order for equal sort
 * keys, so without it a strip reshuffles between two requests that computed the same
 * scores. That is invisible in a test and obvious to a person who reloads a page.
 */
export class RelatedProductsRepositoryMongo {
    private readonly products = ProductModel;

    /**
     * Products bought in the same orders as the subject, most co-purchased first.
     *
     * Reads `orders` rather than `products`: the signal lives in `items[]`, and there is
     * nothing on a product recording what it has been bought beside.
     *
     * ── The four bounds, and why the shape is `$match → $limit → $unwind` ────
     *
     * The pipeline narrows to the subject's own orders FIRST, caps how many of them to look
     * at, and only then explodes the line items. Reversed — unwinding before limiting — the
     * work would scale with how popular the subject is, which is precisely backwards: the
     * best-seller whose page is viewed most would be the slowest to answer.
     *
     *   1. `payment_status: 'paid'` — an unpaid or failed order is not evidence of anything.
     *      An abandoned checkout is a click, not a purchase.
     *   2. A `created_at` floor (`CO_OCCURRENCE_WINDOW_DAYS`), so the scan does not grow
     *      with the age of the platform.
     *   3. `CO_OCCURRENCE_ORDER_SAMPLE`, newest first — the cost ceiling. This makes the
     *      result a **sample**, and every caller and the api-doc say so.
     *   4. `MIN_CO_OCCURRENCE` — a floor under what counts as a pattern rather than a
     *      coincidence.
     *
     * ⚠ **Publishability is applied AFTER the grouping, never before**, and the ordering is
     * load-bearing in a way that is easy to get wrong. Filtering the candidates first would
     * mean the counts were computed over a set that excluded unpublishable products — which
     * is fine — but doing it by joining `products` into this pipeline before the `$group`
     * would multiply the join cost by every line item. Grouping first gives a short
     * candidate list, and only then is the publishable predicate applied to it.
     *
     * Returns ids and counts only. Hydration into cards is
     * `PublicCatalogService.listByIds`, which re-applies the same predicate — so this
     * result is a ranking, not a promise that every id in it is still on sale.
     */
    async coOccurring(productId: string, limit: number): Promise<Array<{ productId: string; orders: number }>> {
        if (!Types.ObjectId.isValid(productId)) return [];
        const subject = new Types.ObjectId(productId);

        const since = new Date(
            Date.now() - RELATED_PRODUCTS_CONFIG.CO_OCCURRENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        );

        const stages: PipelineStage[] = [
            // 1 · the subject's own PAID orders, within the window. Served by the existing
            //     `{ payment_status, created_at }` index on `orders`.
            {
                $match: {
                    'items.product_id': subject,
                    payment_status: 'paid',
                    created_at: { $gte: since },
                },
            },
            { $sort: { created_at: -1, _id: -1 } },
            { $limit: RELATED_PRODUCTS_CONFIG.CO_OCCURRENCE_ORDER_SAMPLE },

            // 2 · explode the line items of that bounded set, and drop the subject itself.
            //     "Never returns the subject product" is enforced here, at the source,
            //     rather than by filtering the answer afterwards — a later filter is one a
            //     new code path can skip.
            { $project: { _id: 1, 'items.product_id': 1 } },
            { $unwind: '$items' },
            { $match: { 'items.product_id': { $ne: subject } } },

            // 3 · count ORDERS, not line items. A customer buying three of something in one
            //     order is one piece of evidence, not three — `$addToSet` over the order id
            //     is what makes the published `orders` number mean what it says.
            { $group: { _id: '$items.product_id', orderIds: { $addToSet: '$_id' } } },
            { $project: { _id: 1, orders: { $size: '$orderIds' } } },
            { $match: { orders: { $gte: RELATED_PRODUCTS_CONFIG.MIN_CO_OCCURRENCE } } },
            { $sort: { orders: -1, _id: 1 } },

            // 4 · a generous candidate pool, not `limit`: some of these will turn out to be
            //     unpublishable at the next stage, and a pool the same size as the answer
            //     would return a short strip whenever one of them has been archived.
            { $limit: Math.max(limit * 4, limit) },
        ];

        const candidates = await mongoose.connection
            .collection(COLLECTIONS.ORDER)
            .aggregate<{ _id: Types.ObjectId; orders: number }>(stages as never)
            .toArray();

        if (candidates.length === 0) return [];

        // 5 · keep only what a shopper may actually see. The same predicate the storefront
        //     uses, including the vendor half — a suspended vendor's products must not
        //     appear in a strip any more than in the grid.
        const publishable = await this.publishableAmong(candidates.map((c) => c._id));

        return candidates
            .filter((c) => publishable.has(c._id.toString()))
            .slice(0, limit)
            .map((c) => ({ productId: c._id.toString(), orders: c.orders }));
    }

    /**
     * The fallback: other publishable products in the same category, most recently ordered
     * first.
     *
     * ⚠ **Carries no count and must never be presented as behavioural.** Nobody "also
     * bought" these — they are simply the neighbours. `lastOrderedAt` is a real maintained
     * field (stamped on every product of a freshly-paid order by `OrderService`, and read
     * by the file-cleanup inactivity sweep), so ordering by it is honest: it means "selling
     * recently", not "bought with this".
     *
     * `lastOrderedAt: null` sorts last rather than being excluded, so a category whose
     * products have never sold still produces a strip.
     */
    async sameCategoryRecent(
        productId: string,
        category: string,
        limit: number,
    ): Promise<string[]> {
        if (!Types.ObjectId.isValid(productId)) return [];

        const rows = await this.products
            .aggregate<{ id: string }>([
                {
                    $match: {
                        ...publishableProductFilter(),
                        category,
                        _id: { $ne: new Types.ObjectId(productId) },
                    },
                },
                ...this.vendorJoin(),
                // `$ifNull` to a fixed epoch so nulls sort last under a descending sort
                // rather than first, which is what Mongo would otherwise do.
                { $addFields: { _lastOrdered: { $ifNull: ['$lastOrderedAt', new Date(0)] } } },
                { $sort: { _lastOrdered: -1, _id: 1 } },
                { $limit: limit },
                { $project: { _id: 0, id: { $toString: '$_id' } } },
            ])
            .exec();

        return rows.map((r) => r.id);
    }

    /** Which of these ids are publishable right now — product predicate and vendor alike. */
    private async publishableAmong(ids: Types.ObjectId[]): Promise<Set<string>> {
        const rows = await this.products
            .aggregate<{ id: string }>([
                { $match: { _id: { $in: ids }, ...publishableProductFilter() } },
                ...this.vendorJoin(),
                { $project: { _id: 0, id: { $toString: '$_id' } } },
            ])
            .exec();

        return new Set(rows.map((r) => r.id));
    }

    /**
     * The vendor half of the publishable predicate.
     *
     * A local copy of the join because `PublicCatalogRepositoryMongo`'s is private and
     * projects five fields this file needs none of. What is NOT duplicated is the rule
     * itself — `VENDOR_PUBLISHABLE_MATCH` is imported from the one file that owns it, so
     * "not suspended, and specifically not `=== active`" cannot drift between the grid and
     * the strip.
     */
    private vendorJoin(): PipelineStage[] {
        return [
            {
                $lookup: {
                    from: COLLECTIONS.VENDOR,
                    localField: 'vendorId',
                    foreignField: '_id',
                    as: 'vendor',
                    pipeline: [{ $project: { _id: 1, status: 1 } }],
                },
            },
            { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: false } },
            { $match: { ...VENDOR_PUBLISHABLE_MATCH } },
        ];
    }
}

export const relatedProductsRepository = new RelatedProductsRepositoryMongo();
