/**
 * The catalogue reads behind the bargaining sub-agent's five tools.
 *
 * ── WHY THIS IS A SEPARATE CLASS AND NOT A METHOD ON THE PUBLIC REPOSITORY ──────
 *
 * `PublicCatalogRepositoryMongo` is the storefront's, and every method on it is written to
 * be world-readable — its header says so, and Stream D is currently flipping its display
 * price to the ask precisely because a shopper may never see the floor. A method that
 * returns `bargain.minPrice` does not belong in that class: it would sit beside twenty
 * methods whose defining property is that they are safe to serve to anybody, and the next
 * person to copy one would not know which one they had copied. Exactly the argument that
 * file makes for its own existence, applied one level further.
 *
 * So: same predicate, different class. `publishableProductFilter()` and
 * `VENDOR_PUBLISHABLE_MATCH` are imported from the one file that owns them rather than
 * re-expressed, so "publishable" cannot come to mean two things — a product the sub-agent
 * offers and the storefront has taken down is the failure that would produce.
 *
 * ⚠ **This class returns the FLOOR.** It is reachable only from
 * `/api/internal/negotiation/tools/*`, behind `requireServiceToken`. See
 * `domain/negotiation-tool-view.ts` for the disclosure decision (D-2) and
 * `internal-vectoriser.routes.ts` for the precedent it follows.
 */

import { PipelineStage, Types } from 'mongoose';
import { COLLECTIONS } from '../../../core/database/collections';
import { ProductModel, ProductVariantModel } from '../../catalog/models';
import { ProductType } from '../../catalog/models/product.model';
import {
    publishableProductFilter,
    VENDOR_PUBLISHABLE_MATCH,
} from '../../catalog/domain/services/public-catalog.filter';

/** One sellable variant, raw. Shaped into the wire view by `negotiation-tool-view.ts`. */
export interface NegotiationVariantRow {
    id: string;
    sku: string;
    name: string | null;
    price: number;
    compareAtPrice: number | null;
    bargain: { minPrice: number; maxPrice: number } | null;
    stock: number;
    isInfiniteStock: boolean;
    allow_oversell: boolean;
    optionValueIds: string[];
    fileIds: string[];
}

/** A product and everything the tools need about it, in one row. */
export interface NegotiationProductRow {
    id: string;
    slug: string;
    title: string;
    description: string;
    type: ProductType;
    category: string;
    tags: string[];
    vendorId: string;
    /** Gates whether a configured window is live at all — see `isBargainEffective`. */
    vectorisationEnabled: boolean;
    defaultVariantId: string | null;
    fileIds: string[];
    storeSlug: string;
    storeName: string;
    storeIsOpen: boolean;
    /** `delivery.agency_id`, the product's own override. Null = fall back to the vendor's. */
    deliveryAgencyId: string | null;
    variants: NegotiationVariantRow[];
    /**
     * The cheapest price any sellable variant could ever reach — `$min` of `variant.price`,
     * which is the minimum FLOOR. This is the field the budget bound compares against; see
     * `withinBudget` for why it is the floor and not the ask.
     */
    reachableFloor: number;
}

/** How a caller names one product. Any one identifier is enough. */
export interface NegotiationSubjectQuery {
    productId?: string;
    variantId?: string;
    sku?: string;
    slug?: string;
}

export interface NegotiationCandidateQuery {
    /** Free text, matched through the same `$text` index the storefront's search uses. */
    query?: string;
    category?: string;
    types?: ProductType[];
    /** The budget. Bounds the FLOOR — never the ask. */
    maxPrice?: number;
    /** Only products with at least one variant an order would be accepted for. */
    inStockOnly?: boolean;
    /** Kept out of its own results. */
    excludeProductId?: string;
    /** Restrict to one seller — how `find_complementary_products` keeps a bundle one order. */
    vendorId?: string;
    limit: number;
}

export class NegotiationCatalogRepositoryMongo {
    private readonly products = ProductModel;

    /**
     * Resolve any one of the four identifiers to a single product row.
     *
     * The resolution ORDER is `productId → variantId → sku → slug`, most specific first,
     * and it stops at the first identifier the caller supplied rather than combining them.
     * A model that sends a stale `productId` alongside a fresh `sku` is a real case, and
     * intersecting the two would answer "no such product" where taking the first answers
     * with something. The response echoes `resolvedBy` so the caller can see which was used.
     */
    async findSubject(
        subject: NegotiationSubjectQuery,
    ): Promise<{ row: NegotiationProductRow; resolvedBy: keyof NegotiationSubjectQuery } | null> {
        if (subject.productId) {
            const row = await this.findOne({ _id: this.asObjectId(subject.productId) });
            return row ? { row, resolvedBy: 'productId' } : null;
        }

        if (subject.variantId) {
            const productId = await this.productIdOfVariant(subject.variantId);
            const row = productId ? await this.findOne({ _id: productId }) : null;
            return row ? { row, resolvedBy: 'variantId' } : null;
        }

        if (subject.sku) {
            const productId = await this.productIdOfSku(subject.sku);
            const row = productId ? await this.findOne({ _id: productId }) : null;
            return row ? { row, resolvedBy: 'sku' } : null;
        }

        if (subject.slug) {
            const row = await this.findOne({ slug: subject.slug });
            return row ? { row, resolvedBy: 'slug' } : null;
        }

        return null;
    }

    /**
     * The substitute / bundle search kernel, shared by both search tools.
     *
     * ⚠ **The budget is matched against `reachableFloor`, and that is the whole rule.**
     * `withinBudget` in `domain/negotiation-tool-view.ts` states why, and this `$match` is
     * its Mongo dialect. Changing one without the other is how the tool starts hiding the
     * products the agent exists to negotiate down.
     *
     * The filter runs AFTER the variant join because the price it bounds is derived from
     * the variants — the same trade `PublicCatalogRepositoryMongo.search` makes, and for
     * the same reason: the publishable `$match` is first and unconditional, so the indexed
     * part of the pipeline still narrows the set before any join runs.
     */
    async findCandidates(query: NegotiationCandidateQuery): Promise<NegotiationProductRow[]> {
        const productMatch: Record<string, unknown> = { ...publishableProductFilter() };

        if (query.category) productMatch.category = query.category;
        if (query.types && query.types.length > 0) productMatch.type = { $in: query.types };
        if (query.vendorId && Types.ObjectId.isValid(query.vendorId)) {
            productMatch.vendorId = new Types.ObjectId(query.vendorId);
        }
        if (query.excludeProductId && Types.ObjectId.isValid(query.excludeProductId)) {
            productMatch._id = { $ne: new Types.ObjectId(query.excludeProductId) };
        }
        // `$text`, never `$regex` — indexed, injection-proof, and the same index the
        // storefront's search already uses. `regex.util.ts` bans a bare `new RegExp`, and a
        // phrase arriving here came out of a chat message.
        if (query.query) productMatch.$text = { $search: query.query };

        const stages: PipelineStage[] = [{ $match: productMatch }];

        if (query.query) stages.push({ $addFields: { _score: { $meta: 'textScore' } } });

        stages.push(...this.joinStages());

        if (query.inStockOnly === true) stages.push({ $match: { _sellable: true } });
        if (query.maxPrice !== undefined) {
            stages.push({ $match: { _reachableFloor: { $lte: query.maxPrice } } });
        }

        // Cheapest-reachable first when there is no relevance to sort by: a substitute
        // search is nearly always a budget search, and `_id` is the tiebreaker for the
        // reason `PublicCatalogRepositoryMongo.sortStage` gives — Mongo guarantees no order
        // for equal keys, so without it two identical calls can return different sets.
        stages.push({
            $sort: query.query
                ? { _score: { $meta: 'textScore' }, _reachableFloor: 1, _id: 1 }
                : { _reachableFloor: 1, _id: 1 },
        });
        stages.push({ $limit: query.limit });
        stages.push(this.projectionStage());

        return this.products.aggregate<NegotiationProductRow>(stages).exec();
    }

    /**
     * Hydrate a SET of ids into the same rows, dropping anything unpublishable.
     *
     * Feeds `find_complementary_products`, whose candidates come from real co-purchase
     * history rather than from a query. Unpublishable ids simply are not in the result — a
     * shorter array — which is what `PublicCatalogRepositoryMongo.findPublishableByIds`
     * does and for the same reason: the alternative is offering a customer something that
     * has been taken off sale.
     *
     * ⚠ **The result order is NOT the argument order.** The caller holds the ranking (a
     * co-occurrence count) and re-imposes it; a `$sort` here would be a second opinion.
     */
    async findPublishableByIds(productIds: string[]): Promise<NegotiationProductRow[]> {
        const ids = productIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
        if (ids.length === 0) return [];

        return this.products
            .aggregate<NegotiationProductRow>([
                { $match: { _id: { $in: ids }, ...publishableProductFilter() } },
                ...this.joinStages(),
                this.projectionStage(),
            ])
            .exec();
    }

    /** One publishable product by an arbitrary product-level match. */
    private async findOne(match: Record<string, unknown>): Promise<NegotiationProductRow | null> {
        if (match._id === null) return null;

        const rows = await this.products
            .aggregate<NegotiationProductRow>([
                { $match: { ...publishableProductFilter(), ...match } },
                ...this.joinStages(),
                { $limit: 1 },
                this.projectionStage(),
            ])
            .exec();

        return rows[0] ?? null;
    }

    /**
     * The vendor, store and sellable-variant joins, in the order every read here needs them.
     *
     * The vendor is projected to `status` alone. `PublicCatalogRepositoryMongo` projects
     * five fields because its DTOs publish them; this surface publishes none of them, and a
     * `$lookup` with no projection carries payout destinations and KYC through the rest of
     * the pipeline where a later `$project` could pick them up by accident.
     */
    private joinStages(): PipelineStage[] {
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
                                sku: 1,
                                name: 1,
                                price: 1,
                                compareAtPrice: 1,
                                // The window. This projection is the ONE place on the
                                // platform outside the vectoriser payload that carries it.
                                bargain: 1,
                                stock: 1,
                                isInfiniteStock: 1,
                                allow_oversell: 1,
                                optionValueIds: 1,
                                fileIds: 1,
                            },
                        },
                        // Cheapest first, so `variants[0]` is the entry point a budget-led
                        // pitch opens from and the caller needs no second sort.
                        { $sort: { price: 1, _id: 1 } },
                    ],
                    as: 'sellableVariants',
                },
            },
            // A product whose variants have all been archived is not offerable. `active`
            // cannot have happened without one, but a later archive does not demote the
            // product — the one activation-gate invariant that goes stale underneath us.
            { $match: { 'sellableVariants.0': { $exists: true } } },
            {
                $addFields: {
                    _reachableFloor: { $min: '$sellableVariants.price' },
                    _sellable: {
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

    private projectionStage(): PipelineStage {
        return {
            $project: {
                _id: 0,
                id: { $toString: '$_id' },
                slug: 1,
                title: 1,
                description: { $ifNull: ['$description', ''] },
                type: 1,
                category: 1,
                tags: { $ifNull: ['$tags', []] },
                vendorId: { $toString: '$vendorId' },
                vectorisationEnabled: { $ifNull: ['$vectorisationEnabled', false] },
                defaultVariantId: { $ifNull: [{ $toString: '$defaultVariantId' }, null] },
                fileIds: {
                    $map: { input: { $ifNull: ['$fileIds', []] }, as: 'f', in: { $toString: '$$f' } },
                },
                storeSlug: '$store.slug',
                storeName: '$store.name',
                storeIsOpen: '$store.is_open',
                deliveryAgencyId: { $ifNull: [{ $toString: '$delivery.agency_id' }, null] },
                reachableFloor: '$_reachableFloor',
                variants: {
                    $map: {
                        input: '$sellableVariants',
                        as: 'v',
                        in: {
                            id: { $toString: '$$v._id' },
                            sku: '$$v.sku',
                            name: { $ifNull: ['$$v.name', null] },
                            price: '$$v.price',
                            compareAtPrice: { $ifNull: ['$$v.compareAtPrice', null] },
                            bargain: { $ifNull: ['$$v.bargain', null] },
                            stock: { $ifNull: ['$$v.stock', 0] },
                            isInfiniteStock: { $ifNull: ['$$v.isInfiniteStock', false] },
                            allow_oversell: { $ifNull: ['$$v.allow_oversell', false] },
                            optionValueIds: {
                                $map: {
                                    input: { $ifNull: ['$$v.optionValueIds', []] },
                                    as: 'o',
                                    in: { $toString: '$$o' },
                                },
                            },
                            fileIds: {
                                $map: {
                                    input: { $ifNull: ['$$v.fileIds', []] },
                                    as: 'f',
                                    in: { $toString: '$$f' },
                                },
                            },
                        },
                    },
                },
            },
        };
    }

    /**
     * The product a variant belongs to.
     *
     * Deliberately does NOT require the variant to be `active`: an archived variant still
     * identifies its product, and a customer who pasted an old link should land on the
     * product page rather than on "no such thing". The publishable predicate then applies
     * to the PRODUCT, in `findOne`, which is where it belongs.
     */
    private async productIdOfVariant(variantId: string): Promise<Types.ObjectId | null> {
        if (!Types.ObjectId.isValid(variantId)) return null;
        const doc = await ProductVariantModel.findOne({ _id: variantId, deletedAt: null })
            .select('productId')
            .lean()
            .exec();
        return (doc?.productId as Types.ObjectId | undefined) ?? null;
    }

    /**
     * The product a SKU belongs to.
     *
     * `sku` is not unique across the catalogue — it is a vendor's own code — so an exact
     * match can legitimately hit more than one product. The first **active** variant wins,
     * and the caller is told which product it resolved to; the sub-agent's next move is to
     * confirm the title with the customer, which is what it would do anyway.
     */
    private async productIdOfSku(sku: string): Promise<Types.ObjectId | null> {
        const doc = await ProductVariantModel.findOne({ sku, status: 'active', deletedAt: null })
            .select('productId')
            .lean()
            .exec();
        return (doc?.productId as Types.ObjectId | undefined) ?? null;
    }

    /** `null` rather than a throw on a malformed id — "not found" is the honest answer. */
    private asObjectId(id: string): Types.ObjectId | null {
        return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
    }
}

export const negotiationCatalogRepository = new NegotiationCatalogRepositoryMongo();
