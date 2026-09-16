/**
 * Cross-vendor catalogue reads for the public storefront.
 *
 * ⚠️ **Every method here is deliberately unscoped**, and that is why they live in their own
 * class rather than beside the twenty vendor-scoped reads on `ProductRepositoryMongo`.
 *
 * Scoping in that class is pure convention — a `vendorId` key spelled out by hand in every
 * filter, with nothing in `BaseRepository` enforcing it (the base applies only
 * `deletedAt: null`). A public read added there would look identical to its neighbours while
 * being the one method with no owner predicate, and the next person to copy-paste a method
 * would not know which one they had copied. Here the class name says it.
 *
 * What replaces owner scoping is the publishable predicate — `publishableProductFilter()`
 * plus `VENDOR_PUBLISHABLE_MATCH` from `domain/services/public-catalog.filter.ts`. It is
 * applied by **every** method below, always as the first `$match` so it is the indexed part
 * of the pipeline, and it is never spelled out inline.
 *
 * ── Two things not copied from the vendor repository ─────────────────────────
 *
 * 1. **Regex search at all.** `searchListView` and `searchAndFilter` on the vendor repository
 *    match with `$regex`; search here goes through `$text` instead (see `search()`), which is
 *    indexed, carries a relevance score and takes no regex to escape in the first place.
 *
 *    ⚠ Until 2026-09-09 this note said something sharper — that those two built
 *    `{ $regex: filters.searchQuery }` **without `escapeRegex`**, which `regex.util.ts`
 *    explicitly says every query string must pass through, and that being vendor-scoped and
 *    behind auth merely bounded the blast radius. That was true and is now fixed at source
 *    (both sites pass `buildSearchRegex`). The reason to prefer `$text` here is no longer
 *    the escaping — it is the index and the score.
 * 2. **`enrichProduct` / `EnrichedProduct`.** N+1 on files, one digital-asset query per
 *    variant, and a spread of the whole domain object. See `dto/public-product.dto.ts`.
 */
import { PipelineStage, Types } from 'mongoose';
import { COLLECTIONS } from '../../../../core/database/collections';
import { buildSearchRegex } from '../../../../core/utils/regex.util';
import { ProductModel, ProductVariantModel } from '../../models';
import { ProductType } from '../../models/product.model';
import {
    publishableProductFilter,
    VENDOR_PUBLISHABLE_MATCH,
} from '../../domain/services/public-catalog.filter';
import {
    bargainEffectiveExpr,
    displayCompareAtPriceExpr,
    displayPriceExpr,
} from '../../read-models/public-display-price';

/** One row of the browse grid, before file resolution and DTO mapping. */
export interface PublicProductListRow {
    id: string;
    slug: string;
    title: string;
    type: ProductType;
    category: string;
    tags: string[];
    /**
     * The **displayed** price of the default variant — its ask when it is bargainable, its
     * `price` otherwise. Not the vendor's floor. See `read-models/public-display-price.ts`.
     */
    price: number;
    compareAtPrice: number | null;
    /** Min/max of the **displayed** prices across sellable variants, same rule as `price`. */
    priceMin: number;
    priceMax: number;
    inStock: boolean;
    /**
     * Is the DEFAULT variant's bargain window live — `vectorisationEnabled && bargain != null`,
     * the same predicate `price` above already branched on.
     *
     * ⚠ **It says a window EXISTS, never what is in it.** `bargain.minPrice` — the vendor's
     * floor — is not projected into this pipeline at all, so nothing downstream can leak it.
     * A shopper learns only that haggling is on the table, which is what the bot needs to
     * label its purchase button (`bot-surface/domain/purchase-affordance.ts`).
     */
    negotiable: boolean;
    /** Product-level media ids, thumbnail-first resolution happens above. */
    fileIds: string[];
    defaultVariantId: string | null;
    storeSlug: string;
    storeName: string;
    storeIsOpen: boolean;
    freeDelivery: boolean;
    updatedAt: Date;
}

export interface PublicProductQuery {
    q?: string;
    category?: string;
    types?: ProductType[];
    storeSlug?: string;
    minPrice?: number;
    maxPrice?: number;
    inStock?: boolean;
    sort: 'newest' | 'price_asc' | 'price_desc' | 'relevance';
    page: number;
    limit: number;
}

export interface PublicStoreListRow {
    slug: string;
    name: string;
    description: string | null;
    logoFileId: string | null;
    bannerFileId: string | null;
    isOpen: boolean;
    supportEmail: string | null;
    supportPhone: string | null;
    supportWhatsapp: string | null;
    vendorStatus: string;
    vendorCountry: string | null;
    vendorVerified: boolean;
    vendorCity: string | null;
    vendorPreferredLanguage: string | null;
    /**
     * Buyer-facing terms, raw from `vendor.policies`. Only the return and cancellation
     * blocks are carried — `support_policy` holds contact channels the store's own
     * `support_*` fields already cover, and `documents` holds vendor-uploaded URLs.
     *
     * Optional because the **directory** does not fetch it: `listStores` renders cards, and
     * a card does not show terms. Only the single-store reads (`findOneStore`) project it,
     * so the directory pays nothing for a field it would not use.
     */
    vendorPolicies?: {
        return_policy: Record<string, unknown> | null;
        cancellation_policy: Record<string, unknown> | null;
    } | null;
    productCount: number;
    createdAt: Date;
}

export interface PublicCategoryRow {
    name: string;
    productCount: number;
}

/**
 * One SKU resolution — the variant, its product and its store, before naming (GAP-003).
 *
 * Deliberately NOT a `PublicProductListRow`: that row is a product card quoting the DEFAULT
 * variant's price, and a SKU names one specific variant which is frequently not the default.
 * Returning a list row here would answer with the wrong price for exactly the customer who
 * typed a precise code.
 */
export interface PublicSkuResolutionRow {
    productId: string;
    variantId: string;
    sku: string;
    title: string;
    /** The vendor's own variant name, when they set one. Null on an option-derived variant. */
    variantName: string | null;
    /** Resolved to option/value names by the service — see `buildVariantDisplayName`. */
    optionValueIds: string[];
    price: number;
    inStock: boolean;
    storeSlug: string;
    storeName: string;
}

export class PublicCatalogRepositoryMongo {
    private readonly model = ProductModel;

    /**
     * Join the vendor and drop anything a shopper may not see.
     *
     * Emitted by every pipeline here, immediately after the product-level `$match`, so
     * "publishable" can never mean two different things on two endpoints. The vendor is
     * projected down to the five facts `PublicStoreVendorFacts` allows — the document also
     * carries payout destinations, KYC and contact details, and a `$lookup` with no
     * projection would carry all of it through the rest of the pipeline where a later
     * `$project` could pick it up by accident.
     */
    private vendorJoinStages(): PipelineStage[] {
        return [
            {
                $lookup: {
                    from: COLLECTIONS.VENDOR,
                    localField: 'vendorId',
                    foreignField: '_id',
                    as: 'vendor',
                    pipeline: [
                        {
                            $project: {
                                _id: 1,
                                status: 1,
                                country: 1,
                                preferred_language: 1,
                                verified: { $ifNull: ['$kyc_details.legit_verified', false] },
                                // `business_addresses[0].city` — CITY ONLY. The rest of the
                                // sub-document is a home or warehouse address with coordinates.
                                city: { $ifNull: [{ $first: '$business_addresses.city' }, null] },
                            },
                        },
                    ],
                },
            },
            { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: false } },
            { $match: { ...VENDOR_PUBLISHABLE_MATCH } },
        ];
    }

    /**
     * Join the seller's store and drop products whose vendor has none.
     *
     * A store is auto-provisioned per vendor, so `preserveNullAndEmptyArrays: false` should
     * never actually drop anything — but a product with no store cannot be linked to (the
     * storefront addresses products as `/stores/:storeSlug/products/:productSlug`), so
     * surfacing it in a grid would produce a row whose only link 404s.
     */
    private storeJoinStages(): PipelineStage[] {
        return [
            {
                $lookup: {
                    from: COLLECTIONS.STORE,
                    localField: 'vendorId',
                    foreignField: 'vendor_id',
                    as: 'store',
                    pipeline: [{ $project: { _id: 0, slug: 1, name: 1, is_open: 1 } }],
                },
            },
            { $unwind: { path: '$store', preserveNullAndEmptyArrays: false } },
        ];
    }

    /**
     * Join sellable variants and derive the product's price facts from them.
     *
     * The product carries no price of its own — it is resolved from the variants, and the
     * *default* variant is what a list row quotes. Products whose variants have all been
     * archived are dropped: `status: 'active'` cannot have happened without at least one
     * sellable variant, but a later archive does not demote the product, so this is the
     * one activation-gate invariant that can go stale underneath us.
     *
     * `inStock` is derived here rather than published as a count — see the DTO.
     *
     * ── EVERY PRICE FACT BELOW IS THE **DISPLAYED** PRICE ───────────────────
     *
     * A bargainable variant is shelved at its ask, not at `variant.price` (D-1). Rather than
     * flip the four call sites downstream — the row's `price`, `_priceMin`, `_priceMax` and
     * the filter band's `$match`, which is exactly the set that ships broken if one is missed
     * — each sellable variant is decorated **once** with `displayPrice` (and its companion
     * `displayCompareAtPrice`) in a stage of its own, and everything after that reads those.
     * The sort needs no change at all: it runs after `listProjectionStage`, on the projected
     * `price`, which is now the displayed one.
     *
     * ⚠ The decoration must be its OWN `$addFields`. `$addFields` computes every field
     * against the stage's *input* document, so `_priceMin` in the same stage would still see
     * the undecorated array and quote floors.
     */
    private variantJoinStages(): PipelineStage[] {
        // The variant fields are reached through the `$map` variable; `vectorisationEnabled`
        // lives on the product, which is the root document of this pipeline.
        const displayPaths = {
            vectorisationEnabled: '$vectorisationEnabled',
            bargainMaxPrice: '$$v.bargain.maxPrice',
            price: '$$v.price',
            compareAtPrice: '$$v.compareAtPrice',
        };

        return [
            {
                $lookup: {
                    from: COLLECTIONS.PRODUCT_VARIANT,
                    let: { pid: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: { $eq: ['$productId', '$$pid'] },
                                status: 'active',
                                deletedAt: null,
                            },
                        },
                        {
                            $project: {
                                _id: 1,
                                price: 1,
                                compareAtPrice: 1,
                                // ⚠ The ASK ALONE, never `bargain: 1`. `bargain.minPrice` is
                                // the vendor's floor — their reserve in a negotiation the
                                // shopper is the other side of — and projecting the whole
                                // sub-document would carry it through the rest of the
                                // pipeline, where a later `$project` could pick it up by
                                // accident. That is the argument `vendorJoinStages` makes
                                // about the vendor document, applied to a number.
                                //
                                // ⚠ Do not confuse this `minPrice` with `PublicProductQuery`'s
                                // above: that one is the SHOPPER's filter floor and is
                                // published in the query string. Two meanings, one word.
                                'bargain.maxPrice': 1,
                                stock: 1,
                                isInfiniteStock: 1,
                                allow_oversell: 1,
                            },
                        },
                    ],
                    as: 'sellableVariants',
                },
            },
            { $match: { 'sellableVariants.0': { $exists: true } } },
            {
                $addFields: {
                    sellableVariants: {
                        $map: {
                            input: '$sellableVariants',
                            as: 'v',
                            in: {
                                $mergeObjects: [
                                    '$$v',
                                    {
                                        displayPrice: displayPriceExpr(displayPaths),
                                        displayCompareAtPrice: displayCompareAtPriceExpr(displayPaths),
                                        // ⚠ The SAME predicate `displayPrice` already branches
                                        // on, projected as a value rather than recomputed by the
                                        // mapper — which could not recompute it anyway, because
                                        // `bargain.minPrice` is deliberately not projected above
                                        // and only `maxPrice` survives into this stage.
                                        //
                                        // It is published so the bot can offer "Bargain" instead
                                        // of "Add to cart" on a row (`purchase-affordance.ts`).
                                        // Cheap here and nowhere else: the expression is already
                                        // built for the two fields above, so this adds a boolean
                                        // to a `$mergeObjects` that was already running.
                                        negotiable: bargainEffectiveExpr(displayPaths),
                                    },
                                ],
                            },
                        },
                    },
                },
            },
            {
                $addFields: {
                    // The default variant is what the row quotes; fall back to the first
                    // sellable one when the default has been archived out from under it.
                    _defaultVariant: {
                        $ifNull: [
                            {
                                $first: {
                                    $filter: {
                                        input: '$sellableVariants',
                                        as: 'v',
                                        cond: { $eq: ['$$v._id', '$defaultVariantId'] },
                                    },
                                },
                            },
                            { $first: '$sellableVariants' },
                        ],
                    },
                    // Over the DISPLAYED prices, so the band a shopper is shown is the band
                    // the grid's own prices fall inside.
                    _priceMin: { $min: '$sellableVariants.displayPrice' },
                    _priceMax: { $max: '$sellableVariants.displayPrice' },
                    _inStock: {
                        $anyElementTrue: {
                            $map: {
                                input: '$sellableVariants',
                                as: 'v',
                                in: {
                                    $or: [
                                        { $eq: ['$$v.isInfiniteStock', true] },
                                        { $eq: ['$$v.allow_oversell', true] },
                                        { $gt: ['$$v.stock', 0] },
                                    ],
                                },
                            },
                        },
                    },
                },
            },
        ];
    }

    /** The shared `$project` producing a `PublicProductListRow`. */
    private listProjectionStage(): PipelineStage {
        return {
            $project: {
                _id: 0,
                id: { $toString: '$_id' },
                slug: 1,
                title: 1,
                type: 1,
                category: 1,
                tags: { $ifNull: ['$tags', []] },
                // The DISPLAYED price and its companion "was" price, decorated onto every
                // sellable variant by `variantJoinStages`. Never `_defaultVariant.price`,
                // which is the vendor's floor on a bargainable variant.
                price: '$_defaultVariant.displayPrice',
                compareAtPrice: { $ifNull: ['$_defaultVariant.displayCompareAtPrice', null] },
                priceMin: '$_priceMin',
                priceMax: '$_priceMax',
                inStock: '$_inStock',
                // ⚠ The DEFAULT variant's window, not the product's — a product may have a
                // bargainable variant and a fixed-price one, and the row quotes the default.
                // `$ifNull` because a product whose default was archived out from under it has
                // no `_defaultVariant` at all, and an absent boolean must read as "no".
                negotiable: { $ifNull: ['$_defaultVariant.negotiable', false] },
                fileIds: { $ifNull: ['$fileIds', []] },
                defaultVariantId: { $ifNull: [{ $toString: '$_defaultVariant._id' }, null] },
                storeSlug: '$store.slug',
                storeName: '$store.name',
                storeIsOpen: '$store.is_open',
                freeDelivery: { $ifNull: ['$delivery.free_delivery', false] },
                updatedAt: 1,
            },
        };
    }

    /**
     * The browse grid, search, filters and sort.
     *
     * Price filtering runs **after** the variant join, because the price it filters on is
     * derived from the variants rather than stored on the product. That costs index
     * selectivity, which is why the publishable `$match` is first and unconditional: the
     * compound `{status, deletedAt, createdAt}` / `{status, deletedAt, category}` indexes
     * narrow the set before any of the joins run.
     */
    async search(query: PublicProductQuery): Promise<{ rows: PublicProductListRow[]; total: number }> {
        const productMatch: Record<string, unknown> = { ...publishableProductFilter() };

        if (query.category) productMatch.category = query.category;
        if (query.types && query.types.length > 0) productMatch.type = { $in: query.types };

        // `$text` rather than `$regex`: it is indexed, it carries a relevance score (which
        // is what makes `sort=relevance` meaningful at all), and it cannot be injected.
        // The trade is whole-word matching — "dres" does not match "dress" — documented on
        // the index in product.model.ts and in api-doc/public/catalog.md.
        if (query.q) productMatch.$text = { $search: query.q };

        const stages: PipelineStage[] = [{ $match: productMatch }];

        if (query.q && query.sort === 'relevance') {
            stages.push({ $addFields: { _score: { $meta: 'textScore' } } });
        }

        stages.push(...this.vendorJoinStages(), ...this.storeJoinStages());

        if (query.storeSlug) stages.push({ $match: { 'store.slug': query.storeSlug } });

        stages.push(...this.variantJoinStages());

        if (query.inStock === true) stages.push({ $match: { _inStock: true } });
        if (query.minPrice !== undefined || query.maxPrice !== undefined) {
            const priceMatch: Record<string, number> = {};
            if (query.minPrice !== undefined) priceMatch.$gte = query.minPrice;
            if (query.maxPrice !== undefined) priceMatch.$lte = query.maxPrice;
            // Matched against the price the row actually quotes, so a filtered result can
            // never show a price outside the band the shopper asked for. ⚠ That is
            // `displayPrice`, not `price`: on a bargainable variant the two differ, and
            // filtering on the floor while quoting the ask is precisely how "under 40 000"
            // returns a product displaying 45 000.
            stages.push({ $match: { '_defaultVariant.displayPrice': priceMatch } });
        }

        stages.push(this.listProjectionStage());
        stages.push({ $sort: this.sortStage(query) });

        const skip = (query.page - 1) * query.limit;
        stages.push({
            $facet: {
                data: [{ $skip: skip }, { $limit: query.limit }],
                total: [{ $count: 'value' }],
            },
        });

        const [result] = await this.model.aggregate<{
            data: PublicProductListRow[];
            total: Array<{ value: number }>;
        }>(stages).exec();

        return {
            rows: result?.data ?? [],
            total: result?.total?.[0]?.value ?? 0,
        };
    }

    /**
     * `_id` is the tiebreaker on every sort, and it is not decoration.
     *
     * Without a total ordering, two products sharing a `createdAt` (or a price — far more
     * likely) can land on either side of a page boundary between requests, so paging shows
     * one twice and skips another. Mongo gives no stable order for equal sort keys.
     */
    private sortStage(query: PublicProductQuery): Record<string, 1 | -1 | { $meta: 'textScore' }> {
        switch (query.sort) {
            case 'price_asc':
                return { price: 1, _id: 1 };
            case 'price_desc':
                return { price: -1, _id: 1 };
            case 'relevance':
                // Relevance without a search term is meaningless; fall back to newest
                // rather than returning an arbitrary order the client would trust.
                return query.q ? { _score: { $meta: 'textScore' }, _id: 1 } : { updatedAt: -1, _id: 1 };
            case 'newest':
            default:
                return { updatedAt: -1, _id: 1 };
        }
    }

    /**
     * Hydrate a SET of product ids into list rows, dropping anything unpublishable.
     *
     * The read behind wishlists, recently-viewed and related products (Phase 6 · 6.E). It
     * runs the same publishable predicate and the same joins as `search`, so a product that
     * has been unpublished, suspended, soft-deleted or whose vendor was suspended simply
     * **is not in the result** — the caller sees a shorter array and degrades that entry,
     * rather than 500ing or, far worse, rendering something that is off sale.
     *
     * ⚠ **The order of the result is NOT the order of the argument**, and every caller has
     * its own ordering to impose (a wishlist is newest-saved-first, recently-viewed is by
     * view time, related is by score). No `$sort` is applied here at all; callers reorder
     * from the id list they already hold. Adding one would be a second opinion about
     * ordering, silently wrong for two of the three.
     *
     * Bounded by the caller: this is fed a page of ids, never a whole collection.
     */
    async findPublishableByIds(productIds: string[]): Promise<PublicProductListRow[]> {
        const ids = productIds
            .filter((id) => Types.ObjectId.isValid(id))
            .map((id) => new Types.ObjectId(id));
        if (ids.length === 0) return [];

        return this.model
            .aggregate<PublicProductListRow>([
                { $match: { _id: { $in: ids }, ...publishableProductFilter() } },
                ...this.vendorJoinStages(),
                ...this.storeJoinStages(),
                ...this.variantJoinStages(),
                this.listProjectionStage(),
            ])
            .exec();
    }

    /** Resolve one publishable product id — the deep-link route. */
    async findPublishableId(productId: string): Promise<{ id: string; vendorId: string } | null> {
        if (!Types.ObjectId.isValid(productId)) return null;
        const [row] = await this.model
            .aggregate<{ id: string; vendorId: Types.ObjectId }>([
                { $match: { _id: new Types.ObjectId(productId), ...publishableProductFilter() } },
                ...this.vendorJoinStages(),
                { $project: { _id: 0, id: { $toString: '$_id' }, vendorId: 1 } },
            ])
            .exec();
        return row ? { id: row.id, vendorId: row.vendorId.toString() } : null;
    }

    /**
     * Resolve `(storeSlug, productSlug)` — the canonical product URL.
     *
     * `Product.slug` is unique per VENDOR (`{ vendorId: 1, slug: 1 }`), not globally, so a
     * bare slug lookup is both ambiguous and a collection scan. Resolving the store first
     * turns this into an exact hit on that existing compound index, which is the whole
     * reason the storefront nests products under their store.
     */
    async findPublishableBySlugs(
        storeSlug: string,
        productSlug: string,
    ): Promise<{ id: string; vendorId: string } | null> {
        const [row] = await this.model
            .aggregate<{ id: string; vendorId: Types.ObjectId }>([
                // Start from the store: its slug is globally unique and indexed.
                { $match: { slug: productSlug, ...publishableProductFilter() } },
                ...this.vendorJoinStages(),
                ...this.storeJoinStages(),
                { $match: { 'store.slug': storeSlug } },
                { $project: { _id: 0, id: { $toString: '$_id' }, vendorId: 1 } },
            ])
            .exec();
        return row ? { id: row.id, vendorId: row.vendorId.toString() } : null;
    }

    /**
     * Resolve a product code to its variant — GAP-003, `GET /api/public/variants/by-sku/:sku`.
     *
     * ── WHY THIS PIPELINE STARTS AT THE VARIANT ─────────────────────────────
     * `ProductVariant.sku` carries a **unique** index, so this is a point lookup. Every other
     * read here starts at the product because that is where the publishable predicate is
     * indexed; starting there for a SKU would mean joining every product's variants and
     * filtering afterwards — a collection scan on a world-readable endpoint.
     *
     * ⚠ **The join stages above are NOT reused, and that is not drift.** They are written
     * against a pipeline whose root document is a *product* (`localField: 'vendorId'`); here
     * the root is a variant and the vendor id lives at `product.vendorId`. What must not
     * differ is the PREDICATE, and it does not: `publishableProductFilter()` and
     * `VENDOR_PUBLISHABLE_MATCH` are the same two imports every other method applies. Never
     * spell a status filter out inline here.
     *
     * ⚠ **`candidates` is an `$in` of case variants, never a case-insensitive regex.** A
     * `$options: 'i'` match cannot use the unique index — it scans the whole collection, on
     * an unauthenticated route, for every code that does not exist. Two or three exact values
     * stay a point lookup. The caller decides which spellings to try and which wins.
     *
     * Returns every match (at most one per candidate spelling) rather than one row: picking
     * between `abc` and `ABC` is the service's decision, and a repository that silently chose
     * would make "the code you typed wins" impossible to state.
     */
    async findPublishableVariantsBySku(candidates: string[]): Promise<PublicSkuResolutionRow[]> {
        const skus = [...new Set(candidates.map((s) => s.trim()).filter(Boolean))];
        if (skus.length === 0) return [];

        return ProductVariantModel
            .aggregate<PublicSkuResolutionRow>([
                // A sellable variant only. An archived one is not offered anywhere else on
                // this surface, and `variantJoinStages` applies exactly this pair.
                { $match: { sku: { $in: skus }, status: 'active', deletedAt: null } },
                {
                    $lookup: {
                        from: COLLECTIONS.PRODUCT,
                        let: { pid: '$productId' },
                        pipeline: [
                            {
                                $match: {
                                    $expr: { $eq: ['$_id', '$$pid'] },
                                    ...publishableProductFilter(),
                                },
                            },
                            // `vectorisationEnabled` is here for one reason: it is half of
                            // the bargainable predicate, and this route quotes a price. A
                            // SKU resolution that answered with the floor while the product
                            // page answered with the ask would be the same defect as the
                            // filter band's, on the surface a customer reaches by typing a
                            // code off a package.
                            { $project: { _id: 1, title: 1, vendorId: 1, vectorisationEnabled: 1 } },
                        ],
                        as: 'product',
                    },
                },
                { $unwind: { path: '$product', preserveNullAndEmptyArrays: false } },
                {
                    $lookup: {
                        from: COLLECTIONS.VENDOR,
                        let: { vid: '$product.vendorId' },
                        // Projected to `status` alone. This read publishes no vendor facts at
                        // all — it needs the vendor only to apply the predicate — so carrying
                        // more would be carrying payout details and KYC into a pipeline whose
                        // output is world-readable.
                        pipeline: [
                            { $match: { $expr: { $eq: ['$_id', '$$vid'] } } },
                            { $project: { _id: 0, status: 1 } },
                        ],
                        as: 'vendor',
                    },
                },
                { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: false } },
                { $match: { ...VENDOR_PUBLISHABLE_MATCH } },
                {
                    $lookup: {
                        from: COLLECTIONS.STORE,
                        let: { vid: '$product.vendorId' },
                        pipeline: [
                            { $match: { $expr: { $eq: ['$vendor_id', '$$vid'] } } },
                            { $project: { _id: 0, slug: 1, name: 1 } },
                        ],
                        as: 'store',
                    },
                },
                // A product whose vendor has no store cannot be addressed by the storefront's
                // own URL scheme, so it is not resolvable — same rule as `storeJoinStages`.
                { $unwind: { path: '$store', preserveNullAndEmptyArrays: false } },
                {
                    $project: {
                        _id: 0,
                        productId: { $toString: '$product._id' },
                        variantId: { $toString: '$_id' },
                        sku: 1,
                        title: '$product.title',
                        variantName: { $ifNull: ['$name', null] },
                        optionValueIds: {
                            $map: {
                                input: { $ifNull: ['$optionValueIds', []] },
                                as: 'v',
                                in: { $toString: '$$v' },
                            },
                        },
                        // The DISPLAYED price. Same rule as the browse grid, different paths:
                        // the root here is the VARIANT, so the window is at `$bargain` and
                        // the product's flag comes through the `$lookup` above.
                        price: displayPriceExpr({
                            vectorisationEnabled: '$product.vectorisationEnabled',
                            bargainMaxPrice: '$bargain.maxPrice',
                            price: '$price',
                        }),
                        // The same three-way rule `variantJoinStages` derives `_inStock` from,
                        // and `variantInStock` states for a domain object. Note the document
                        // spells it `allow_oversell` while the domain type says `allowOversell`.
                        inStock: {
                            $or: [
                                { $eq: ['$isInfiniteStock', true] },
                                { $eq: ['$allow_oversell', true] },
                                { $gt: ['$stock', 0] },
                            ],
                        },
                        storeSlug: '$store.slug',
                        storeName: '$store.name',
                    },
                },
            ])
            .exec();
    }

    /**
     * Distinct categories with counts, over exactly the browse filter.
     *
     * A category whose every product is a draft must not appear — which is why this groups
     * over the same predicate rather than running `distinct()` on the column.
     */
    async listCategories(): Promise<PublicCategoryRow[]> {
        return this.model
            .aggregate<PublicCategoryRow>([
                { $match: publishableProductFilter() },
                ...this.vendorJoinStages(),
                { $group: { _id: '$category', productCount: { $sum: 1 } } },
                { $project: { _id: 0, name: '$_id', productCount: 1 } },
                { $sort: { productCount: -1, name: 1 } },
            ])
            .exec();
    }

    /**
     * The store directory, and the sitemap's source of store URLs.
     *
     * Aggregated **from products, not from stores**, for one reason: a store with zero
     * publishable products must not appear. An empty storefront is a soft-404 to a crawler,
     * and emitting its URL in a sitemap asks Google to index a dead page. Grouping products
     * by vendor gives that exclusion and `productCount` in the same pass.
     */
    async listStores(params: {
        q?: string;
        city?: string;
        page: number;
        limit: number;
    }): Promise<{ rows: PublicStoreListRow[]; total: number }> {
        const stages: PipelineStage[] = [
            { $match: publishableProductFilter() },
            ...this.vendorJoinStages(),
            { $group: { _id: '$vendorId', productCount: { $sum: 1 }, vendor: { $first: '$vendor' } } },
            {
                $lookup: {
                    from: COLLECTIONS.STORE,
                    localField: '_id',
                    foreignField: 'vendor_id',
                    as: 'store',
                },
            },
            { $unwind: { path: '$store', preserveNullAndEmptyArrays: false } },
        ];

        if (params.city) {
            // Case-insensitive exact match. Not a regex: the value is user-supplied and
            // `$regex` here would be both injectable and unindexable.
            stages.push({
                $match: {
                    $expr: {
                        $eq: [{ $toLower: { $ifNull: ['$vendor.city', ''] } }, params.city.toLowerCase()],
                    },
                },
            });
        }

        if (params.q) {
            // Store names have no text index, so this is a substring match — and therefore
            // the one place a regex is unavoidable here. `buildSearchRegex` escapes it;
            // building the RegExp by hand would be regex injection plus a ReDoS on an
            // endpoint anyone on the internet can call.
            stages.push({ $match: { 'store.name': buildSearchRegex(params.q) } });
        }

        stages.push(
            {
                $project: {
                    _id: 0,
                    slug: '$store.slug',
                    name: '$store.name',
                    description: { $ifNull: ['$store.description', null] },
                    logoFileId: { $ifNull: [{ $toString: '$store.logo_file_id' }, null] },
                    bannerFileId: { $ifNull: [{ $toString: '$store.banner_file_id' }, null] },
                    isOpen: '$store.is_open',
                    supportEmail: { $ifNull: ['$store.support_email', null] },
                    supportPhone: { $ifNull: ['$store.support_phone', null] },
                    supportWhatsapp: { $ifNull: ['$store.support_whatsapp', null] },
                    vendorStatus: '$vendor.status',
                    vendorCountry: { $ifNull: ['$vendor.country', null] },
                    vendorVerified: { $ifNull: ['$vendor.verified', false] },
                    vendorCity: { $ifNull: ['$vendor.city', null] },
                    vendorPreferredLanguage: { $ifNull: ['$vendor.preferred_language', null] },
                    productCount: 1,
                    createdAt: '$store.created_at',
                },
            },
            { $sort: { productCount: -1, slug: 1 } },
            {
                $facet: {
                    data: [{ $skip: (params.page - 1) * params.limit }, { $limit: params.limit }],
                    total: [{ $count: 'value' }],
                },
            },
        );

        const [result] = await this.model.aggregate<{
            data: PublicStoreListRow[];
            total: Array<{ value: number }>;
        }>(stages).exec();

        return { rows: result?.data ?? [], total: result?.total?.[0]?.value ?? 0 };
    }

    /**
     * One store by slug, with its publishable product count.
     *
     * Unlike `listStores` this starts from the store, because a store with no publishable
     * products still has a page — a shopper following a link from an order or a search
     * result should see "no products right now", not a 404. The zero-product exclusion is a
     * *directory and sitemap* rule, not a visibility rule.
     */
    async findStoreBySlug(slug: string): Promise<PublicStoreListRow | null> {
        return this.findOneStore({ slug });
    }

    /**
     * The seller card on a product page.
     *
     * Keyed on `vendor_id` rather than the slug because the caller already holds the vendor
     * id from the publishability check, and re-deriving the slug to look it back up would
     * be a second query for something already in hand.
     */
    async findStoreForVendor(vendorId: string): Promise<PublicStoreListRow | null> {
        if (!Types.ObjectId.isValid(vendorId)) return null;
        return this.findOneStore({ vendor_id: new Types.ObjectId(vendorId) });
    }

    /**
     * One store, by whatever identifies it, with its publishable product count.
     *
     * Unlike `listStores` this starts from the store, because a store with no publishable
     * products still has a page — a shopper following a link from an order or a search
     * result should see "no products right now", not a 404. The zero-product exclusion is a
     * *directory and sitemap* rule (don't ask a crawler to index a dead page), not a
     * visibility rule.
     */
    private async findOneStore(match: Record<string, unknown>): Promise<PublicStoreListRow | null> {
        // Driven off the raw `stores` collection rather than `StoreModel`, deliberately:
        // `store/dto/store-profile.dto.ts` already imports from this module, so importing
        // the store model here would close a require cycle — the same class of boot-time
        // failure documented on the agents barrel ("AuthService is not a constructor").
        const rows = await ProductModel.db
            .collection(COLLECTIONS.STORE)
            .aggregate<PublicStoreListRow>([
                { $match: match },
                {
                    $lookup: {
                        from: COLLECTIONS.VENDOR,
                        localField: 'vendor_id',
                        foreignField: '_id',
                        as: 'vendor',
                        // Projected down to the publishable facts. The vendor document also
                        // carries payout destinations, KYC detail, contact identifiers and
                        // the suspension block; a `$lookup` with no projection would carry
                        // all of it into the pipeline where a later stage could emit it.
                        pipeline: [
                            {
                                $project: {
                                    _id: 0,
                                    status: 1,
                                    country: 1,
                                    preferred_language: 1,
                                    verified: { $ifNull: ['$kyc_details.legit_verified', false] },
                                    city: { $ifNull: [{ $first: '$business_addresses.city' }, null] },
                                    policies: {
                                        return_policy: { $ifNull: ['$policies.return_policy', null] },
                                        cancellation_policy: { $ifNull: ['$policies.cancellation_policy', null] },
                                    },
                                },
                            },
                        ],
                    },
                },
                { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: false } },
                { $match: { ...VENDOR_PUBLISHABLE_MATCH } },
                {
                    $lookup: {
                        from: COLLECTIONS.PRODUCT,
                        let: { vid: '$vendor_id' },
                        pipeline: [
                            {
                                $match: {
                                    $expr: { $eq: ['$vendorId', '$$vid'] },
                                    ...publishableProductFilter(),
                                },
                            },
                            { $count: 'value' },
                        ],
                        as: 'productCounts',
                    },
                },
                {
                    $project: {
                        _id: 0,
                        slug: 1,
                        name: 1,
                        description: { $ifNull: ['$description', null] },
                        logoFileId: { $ifNull: [{ $toString: '$logo_file_id' }, null] },
                        bannerFileId: { $ifNull: [{ $toString: '$banner_file_id' }, null] },
                        isOpen: '$is_open',
                        supportEmail: { $ifNull: ['$support_email', null] },
                        supportPhone: { $ifNull: ['$support_phone', null] },
                        supportWhatsapp: { $ifNull: ['$support_whatsapp', null] },
                        vendorStatus: '$vendor.status',
                        vendorCountry: { $ifNull: ['$vendor.country', null] },
                        vendorVerified: { $ifNull: ['$vendor.verified', false] },
                        vendorCity: { $ifNull: ['$vendor.city', null] },
                        vendorPreferredLanguage: { $ifNull: ['$vendor.preferred_language', null] },
                        vendorPolicies: { $ifNull: ['$vendor.policies', null] },
                        productCount: { $ifNull: [{ $first: '$productCounts.value' }, 0] },
                        createdAt: '$created_at',
                    },
                },
            ])
            .toArray();

        return rows[0] ?? null;
    }
}

export const publicCatalogRepository = new PublicCatalogRepositoryMongo();
