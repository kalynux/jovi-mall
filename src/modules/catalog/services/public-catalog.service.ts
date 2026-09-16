/**
 * The storefront's read side — browse, search, product detail, categories and stores.
 *
 * ⚠️ **Everything this service returns is world-readable.** `/api/public/*` is the one mount
 * with no auth guard anywhere above or below it, so there is no `req.auth` to scope by and
 * no second gate downstream. Two rules follow, and both are load-bearing:
 *
 *   1. **Visibility is decided in exactly one place** — `domain/services/public-catalog.filter.ts`,
 *      applied by every query in `PublicCatalogRepositoryMongo`. This service never re-decides
 *      it and never widens it.
 *   2. **Shape is decided in exactly one place** — the explicit projections in
 *      `dto/public-product.dto.ts` and `store/dto/public-store.dto.ts`. This service never
 *      returns a domain object or a repository row directly.
 *
 * ── Absent is 404, never 403 ────────────────────────────────────────────────
 *
 * A draft, archived, suspended or soft-deleted product returns
 * `404 CATALOG_PRODUCT_NOT_FOUND` — the same answer as one that never existed. A 403 would
 * confirm the id is real, which turns the endpoint into an oracle for a competitor
 * enumerating a vendor's unreleased catalogue.
 */
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getStorageProvider } from '../../../core/storage';
import { FileRepositoryMongo } from '../repositories/mongo/file.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
import { OptionRepositoryMongo } from '../repositories/mongo/option.repository.mongo';
import { OptionValueRepositoryMongo } from '../repositories/mongo/option-value.repository.mongo';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import {
    publicCatalogRepository,
    PublicProductListRow,
    PublicSkuResolutionRow,
    PublicStoreListRow,
} from '../repositories/mongo/public-catalog.repository.mongo';
import { resolveFileDetails } from '../read-models/file-detail.resolver';
import { isRenderableImage, productImageKey, resolveProductImages } from '../read-models/product-image.resolver';
import { FileDetail } from '../read-models/product-detail.read-model';
import {
    buildVariantDisplayName,
    PublicProductDetailDto,
    PublicProductListItemDto,
    PublicSkuResolutionDto,
    toPublicCancellationPolicyDto,
    toPublicProductDetailDto,
    toPublicReturnPolicyDto,
} from '../dto/public-product.dto';
import { pickSkuMatch, skuCandidates } from '../domain/services/sku-resolution';
import { PublicStoreDto, toPublicStoreDto } from '../../store/dto/public-store.dto';
import { PublicProductListQuery, PublicStoreListQuery } from '../validators/public-catalog.validator';
import { reviewAggregateRepository } from '../../reviews/repositories/review-aggregate.repository';
import { toRatingBreakdownDto, toRatingSummaryDto } from '../../reviews/dto/review.dto';

/**
 * The account currency.
 *
 * Matches the cart's and the order model's default. It is a constant rather than a per-
 * product field because nothing in the catalogue stores one — a variant's `price` is a bare
 * number, and every seeded plan, cart line and order is `XAF`. When multi-currency arrives
 * this is where it stops being a constant.
 */
const DEFAULT_CURRENCY = 'XAF';

/** The default language a vendor's catalogue text is assumed to be authored in. */
const DEFAULT_CONTENT_LANGUAGE = 'fr';

export interface PublicPage<T> {
    data: T[];
    meta: { total: number; page: number; limit: number; pages: number };
}

export class PublicCatalogService {
    constructor(
        private readonly repo = publicCatalogRepository,
        private readonly fileRepo = new FileRepositoryMongo(),
        private readonly productRepo = new ProductRepositoryMongo(),
        private readonly variantRepo = new VariantRepositoryMongo(),
        private readonly optionRepo = new OptionRepositoryMongo(),
        private readonly optionValueRepo = new OptionValueRepositoryMongo(),
    ) { }

    // ─────────────────────────────────────────────────────────────────────────
    //  Browse
    // ─────────────────────────────────────────────────────────────────────────

    async listProducts(query: PublicProductListQuery): Promise<PublicPage<PublicProductListItemDto>> {
        const { rows, total } = await this.repo.search({
            q: query.q,
            category: query.category,
            types: query.type,
            storeSlug: query.storeSlug,
            minPrice: query.minPrice,
            maxPrice: query.maxPrice,
            inStock: query.inStock,
            sort: query.sort,
            page: query.page,
            limit: query.limit,
        });

        return {
            data: await this.decorateRows(rows),
            meta: {
                total,
                page: query.page,
                limit: query.limit,
                pages: Math.ceil(total / query.limit),
            },
        };
    }

    /**
     * The same list rows, for a set of ids the caller already holds (Phase 6 · 6.E).
     *
     * Returned as a **Map keyed by product id**, not an array, and that is the whole point:
     * the three callers — wishlist, recently viewed, related — each have their own ordering
     * and each needs to know which ids came back *missing*, because a missing id is not an
     * error here. It is a product that has been unpublished, suspended or deleted since the
     * row referencing it was written, and the correct rendering is a degraded entry rather
     * than a 500 or, worse, a card for something that is off sale.
     *
     * Goes through `decorateRows`, so a wishlist card and a browse card are the same shape
     * built by the same code. Inventing a second product DTO for these surfaces is the
     * mistake `api-doc/public/catalog.md` warns about — its `inStock` is a boolean and never
     * a count, and a second shape is how that becomes two answers.
     */
    async listByIds(productIds: string[]): Promise<Map<string, PublicProductListItemDto>> {
        const withVariant = await this.listByIdsWithVariant(productIds);
        return new Map([...withVariant].map(([id, entry]) => [id, entry.item]));
    }

    /**
     * The same rows, plus the id of the variant a card's buttons would act on.
     *
     * ── WHY THIS IS A SECOND METHOD AND NOT A FIELD ON THE DTO ──────────────
     * The bot's product cards need something `PublicProductListItemDto` deliberately does not
     * carry: **which variant "Add to cart" adds**. `PublicProductListRow.defaultVariantId` has
     * always been there — it is what `decorateRows` resolves the thumbnail and the price
     * against — it simply never reached the list projection, because a browse grid links to a
     * page and lets the customer choose.
     *
     * Adding it to the DTO would have been the smaller diff and the wrong one. That shape is
     * the storefront's public contract (`api-doc/public/catalog.md`), consumed by an app in
     * another repository, and widening it for one internal caller is how a projection stops
     * being a decision and becomes an accumulation. `defaultVariantId` is not sensitive —
     * `PublicProductDetailDto` already publishes it — so this is about blast radius, not
     * secrecy.
     *
     * ⚠ **`decorateRows` maps 1:1 and in order**, which is what makes the zip below correct.
     * It is a `rows.map(...)` with no filter; if it ever grows one, this pairing silently
     * attaches the wrong variant to the wrong product, so change them together.
     */
    async listByIdsWithVariant(
        productIds: string[],
    ): Promise<Map<string, { item: PublicProductListItemDto; defaultVariantId: string | null }>> {
        const unique = [...new Set(productIds)];
        if (unique.length === 0) return new Map();

        const rows = await this.repo.findPublishableByIds(unique);
        const decorated = await this.decorateRows(rows);
        return new Map(
            decorated.map((item, index) => [
                item.id,
                { item, defaultVariantId: rows[index].defaultVariantId },
            ]),
        );
    }

    /**
     * Attach thumbnails to a page of rows in **one** file query.
     *
     * Resolved through `resolveProductImages` against the **default variant**, not the raw
     * product `fileIds`, so the picture matches the price: a row quotes the default variant's
     * price, and that resolver's rule is that variant media *replaces* product media rather
     * than merging with it. A red T-shirt row therefore shows the red one instead of whatever
     * the product-level gallery leads with. Most variants carry no media of their own, in
     * which case it falls back to the product's — identical to the naive approach in the
     * common case, and correct in the one that matters.
     *
     * `[0]` is the thumbnail by convention (the resolver returns galleries thumbnail-first),
     * and it drops non-images and soft-deleted files, so a product whose media was swept
     * resolves to `null` rather than a broken URL.
     */
    private async decorateRows(rows: PublicProductListRow[]): Promise<PublicProductListItemDto[]> {
        const storage = getStorageProvider();
        // Two batch reads for the page, never one per row. The ratings join is the
        // same shape as the images one and exists for the same reason: a grid renders
        // a rating on every card, so a per-card query is an N+1 on the busiest
        // unauthenticated endpoint the platform has.
        const [imagesByKey, ratingByProductId] = await Promise.all([
            resolveProductImages(
                rows.map((r) => ({ productId: r.id, variantId: r.defaultVariantId })),
                this.fileRepo,
                storage,
            ),
            reviewAggregateRepository.findMany('product', rows.map((r) => r.id), 'customer'),
        ]);

        return rows.map((row) => {
            const image = imagesByKey.get(productImageKey(row.id, row.defaultVariantId))?.[0] ?? null;

            return {
                id: row.id,
                slug: row.slug,
                title: row.title,
                type: row.type,
                category: row.category,
                tags: row.tags ?? [],
                price: row.price,
                compareAtPrice: row.compareAtPrice,
                currency: DEFAULT_CURRENCY,
                ...(row.priceMin !== row.priceMax
                    ? { priceRange: { min: row.priceMin, max: row.priceMax } }
                    : {}),
                inStock: row.inStock,
                // Read straight through from the pipeline — never recomputed here, because
                // the window this reports on was never projected out of Mongo. See the
                // field's docstring on `PublicProductListItemDto`.
                negotiable: row.negotiable ?? false,
                image,
                // `null` when nothing is published — see the field's docstring for why
                // that null is what keeps invented review counts out of the JSON-LD.
                rating: toRatingSummaryDto(ratingByProductId.get(row.id)),
                store: {
                    slug: row.storeSlug,
                    name: row.storeName,
                    isOpen: row.storeIsOpen,
                },
                freeDelivery: row.freeDelivery,
                updatedAt: new Date(row.updatedAt).toISOString(),
            };
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Detail
    // ─────────────────────────────────────────────────────────────────────────

    /** The deep-link route: `GET /api/public/products/:productId`. */
    async getProductById(productId: string): Promise<PublicProductDetailDto> {
        const hit = await this.repo.findPublishableId(productId);
        if (!hit) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        return this.buildDetail(hit.id, hit.vendorId);
    }

    /** The canonical route: `GET /api/public/stores/:storeSlug/products/:productSlug`. */
    async getProductBySlugs(storeSlug: string, productSlug: string): Promise<PublicProductDetailDto> {
        const hit = await this.repo.findPublishableBySlugs(storeSlug, productSlug);
        if (!hit) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        return this.buildDetail(hit.id, hit.vendorId);
    }

    /**
     * `GET /api/public/variants/by-sku/:sku` — a printed product code → its variant (GAP-003).
     *
     * The gap this closes: `?q=` is a `$text` search over title, tags and description, and it
     * does **not** index SKU — so a customer typing a code off a package matched nothing while
     * looking like a search that had simply found nothing.
     *
     * ── THREE SPELLINGS, ONE INDEXED LOOKUP ─────────────────────────────────
     * A code is typed by a person, from a package, on a phone keyboard that capitalises. So
     * the as-typed value, its uppercase and its lowercase forms are tried **together**, in one
     * `$in` on the unique index. The alternative — a case-insensitive regex — cannot use that
     * index and turns every miss into a collection scan on an unauthenticated route.
     *
     * ⚠ **The as-typed spelling wins when more than one matches.** `abc` and `ABC` are two
     * different SKUs as far as the unique index is concerned, so both can exist; answering
     * with the one the customer actually typed is the only defensible rule, and it is stated
     * here rather than left to the order a pipeline happened to return.
     */
    async resolveSku(sku: string): Promise<PublicSkuResolutionDto> {
        const rows = await this.repo.findPublishableVariantsBySku(skuCandidates(sku));
        const row = pickSkuMatch(rows, sku);
        // Unknown, archived, draft, suspended, or a suspended vendor — one answer for all of
        // them, exactly as the product reads do. See this file's header.
        if (!row) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        return {
            productId: row.productId,
            variantId: row.variantId,
            sku: row.sku,
            title: row.title,
            variantName: await this.nameVariant(row),
            price: row.price,
            currency: DEFAULT_CURRENCY,
            inStock: row.inStock,
            store: { slug: row.storeSlug, name: row.storeName },
        };
    }

    /**
     * The variant's display name, resolving its option selection when it needs one.
     *
     * ⚠ **The two option queries run only when they can change the answer** — a vendor-set
     * name wins outright, and a simple-mode variant carries no option values at all. So the
     * common case (quick-add products, digital variants) costs nothing, and the two extra
     * reads are paid only by a variant whose name genuinely *is* its selection.
     *
     * Naming itself is `buildVariantDisplayName`, shared with the product detail's variant
     * list — one rule, so a variant is called the same thing on both surfaces.
     */
    private async nameVariant(row: PublicSkuResolutionRow): Promise<string> {
        if (row.variantName || row.optionValueIds.length === 0) {
            return buildVariantDisplayName(row.variantName, [], row.sku);
        }

        const options = await this.optionRepo.findByProduct(row.productId);
        const values = options.length > 0
            ? await this.optionValueRepo.findByOptions(options.map((o) => o.id))
            : [];

        const optionsById = new Map(options.map((o) => [o.id, o]));
        const valuesById = new Map(values.map((v) => [v.id, v]));

        const pairs = row.optionValueIds
            .map((valueId) => {
                const value = valuesById.get(valueId);
                const option = value ? optionsById.get(value.optionId) : undefined;
                return option && value ? { optionName: option.name, value: value.value } : null;
            })
            .filter((pair): pair is { optionName: string; value: string } => pair !== null);

        return buildVariantDisplayName(null, pairs, row.sku);
    }

    /**
     * Assemble the detail DTO once visibility has already been decided.
     *
     * Takes an id the repository has **already** confirmed publishable, and re-reads the
     * product through the vendor-scoped `findById` — which is why `vendorId` is threaded
     * through rather than re-derived. Re-reading unscoped here would mean the publishable
     * check and the read could disagree if the product changed between them.
     */
    private async buildDetail(productId: string, vendorId: string): Promise<PublicProductDetailDto> {
        const [product, storeRow] = await Promise.all([
            this.productRepo.findById(productId, vendorId),
            this.repo.findStoreForVendor(vendorId),
        ]);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        // A product whose vendor has no store cannot be addressed by the storefront's own
        // URL scheme (`/stores/:storeSlug/products/:productSlug`), so it is not publishable
        // even though the product itself passed every check. Stores are auto-provisioned,
        // so this is a should-never-happen that fails as a 404 rather than a broken page.
        if (!storeRow) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        const [variants, options, rating] = await Promise.all([
            this.variantRepo.findByProduct(productId),
            this.optionRepo.findByProduct(productId),
            // The breakdown rather than the summary: the product page renders the 1–5
            // histogram above its review list, and reading it here saves the client a
            // second request for data this response already had to fetch.
            reviewAggregateRepository.find({ targetType: 'product', targetId: productId, authorRole: 'customer' }),
        ]);

        const optionValues =
            options.length > 0 ? await this.optionValueRepo.findByOptions(options.map((o) => o.id)) : [];

        const storage = getStorageProvider();

        // Product gallery and every variant's own media, resolved together: one File query
        // for the whole page rather than one per variant.
        const productFileIds = product.fileIds ?? [];
        const variantFileIds = variants.flatMap((v) => v.fileIds ?? []);
        const storeLogoId = storeRow.logoFileId;
        const fileById = await resolveFileDetails(
            [...productFileIds, ...variantFileIds, storeLogoId],
            this.fileRepo,
            storage,
        );

        // The SAME predicate the batch gallery resolver uses — genuine images only, and
        // never a quota-blocked one. A second copy here is how the storefront ends up
        // rendering a picture the vendor's plan no longer covers.
        const imagesOf = (ids: string[]): FileDetail[] =>
            ids.map((id) => fileById.get(id)).filter(isRenderableImage);

        const variantImages = new Map<string, FileDetail[]>();
        for (const variant of variants) {
            const own = imagesOf(variant.fileIds ?? []);
            if (own.length > 0) variantImages.set(variant.id, own);
        }

        return toPublicProductDetailDto({
            product,
            variants,
            options: options.map((o) => ({ id: o.id, name: o.name, position: o.position })),
            optionValues: optionValues.map((v) => ({ id: v.id, optionId: v.optionId, value: v.value })),
            productImages: imagesOf(productFileIds),
            variantImages,
            currency: DEFAULT_CURRENCY,
            contentLanguage: storeRow.vendorPreferredLanguage ?? DEFAULT_CONTENT_LANGUAGE,
            rating: toRatingBreakdownDto(rating),
            store: {
                slug: storeRow.slug,
                name: storeRow.name,
                logo: storeLogoId ? fileById.get(storeLogoId) ?? null : null,
                isOpen: storeRow.isOpen,
                verified: storeRow.vendorVerified,
                city: storeRow.vendorCity,
                country: storeRow.vendorCountry,
                supportWhatsapp: storeRow.supportWhatsapp,
                policies: {
                    returnPolicy: toPublicReturnPolicyDto(
                        storeRow.vendorPolicies?.return_policy as never,
                    ),
                    cancellationPolicy: toPublicCancellationPolicyDto(
                        storeRow.vendorPolicies?.cancellation_policy as never,
                    ),
                },
            },
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Categories
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * `Product.category` is a plain indexed string — there is no Category collection, model
     * or taxonomy anywhere in the codebase — so the chip list can only be derived, and it is
     * derived over exactly the browse filter. A category whose every product is a draft
     * therefore does not appear, which is the behaviour a shopper expects: a chip that leads
     * to an empty grid is worse than no chip.
     */
    async listCategories(): Promise<Array<{ name: string; productCount: number }>> {
        return this.repo.listCategories();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Stores
    // ─────────────────────────────────────────────────────────────────────────

    async listStores(query: PublicStoreListQuery): Promise<PublicPage<PublicStoreDto>> {
        const { rows, total } = await this.repo.listStores(query);
        return {
            data: await this.decorateStores(rows),
            meta: {
                total,
                page: query.page,
                limit: query.limit,
                pages: Math.ceil(total / query.limit),
            },
        };
    }

    async getStoreBySlug(slug: string): Promise<PublicStoreDto> {
        const row = await this.repo.findStoreBySlug(slug);
        if (!row) throw createAppError(ERROR_CODES.STORE_NOT_FOUND, 404);
        const [dto] = await this.decorateStores([row]);
        return dto;
    }

    /** Resolve every store's branding in one file query, then project. */
    private async decorateStores(rows: PublicStoreListRow[]): Promise<PublicStoreDto[]> {
        const storage = getStorageProvider();
        const fileIds = rows.flatMap((r) => [r.logoFileId, r.bannerFileId]);
        const fileById = await resolveFileDetails(fileIds, this.fileRepo, storage);

        return rows.map((row) =>
            toPublicStoreDto({
                store: {
                    slug: row.slug,
                    name: row.name,
                    description: row.description,
                    is_open: row.isOpen,
                    support_email: row.supportEmail,
                    support_phone: row.supportPhone,
                    support_whatsapp: row.supportWhatsapp,
                    created_at: row.createdAt,
                },
                vendor: {
                    status: row.vendorStatus,
                    country: row.vendorCountry,
                    verified: row.vendorVerified,
                    city: row.vendorCity,
                    preferredLanguage: row.vendorPreferredLanguage,
                },
                logo: row.logoFileId ? fileById.get(row.logoFileId) ?? null : null,
                banner: row.bannerFileId ? fileById.get(row.bannerFileId) ?? null : null,
                productCount: row.productCount,
            }),
        );
    }

    /** `GET /api/public/stores/:slug/products` — the store page's grid. */
    async listStoreProducts(
        slug: string,
        query: Omit<PublicProductListQuery, 'storeSlug'>,
    ): Promise<PublicPage<PublicProductListItemDto>> {
        // 404 the whole request when the store itself is not public, rather than returning
        // an empty grid — an empty grid says "this seller has nothing", which is a different
        // and wrong statement about a suspended vendor.
        const store = await this.repo.findStoreBySlug(slug);
        if (!store) throw createAppError(ERROR_CODES.STORE_NOT_FOUND, 404);

        return this.listProducts({ ...query, storeSlug: slug });
    }
}

export const publicCatalogService = new PublicCatalogService();
