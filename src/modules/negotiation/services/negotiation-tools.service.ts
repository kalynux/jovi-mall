/**
 * The five read tools the bargaining sub-agent calls.
 *
 * ── ONE PROPERTY BINDS ALL FIVE: THEY MAY ONLY REPORT WHAT IS STORED ────────────
 *
 * The playbook this service exists to serve is explicit about it — *"Every factual claim
 * (specs, availability, 'only 2 left') must come from here. Unknown = say you'll check, or
 * don't claim it"*, and *"Quote real terms from the tool; never invent delivery promises"*.
 * A tool that guesses is worse than a tool that is absent, because the model cannot tell
 * the difference and the customer is told the guess as a fact.
 *
 * That rule is why two of the five are smaller than they sound:
 *
 *   - **`quoteDelivery` reports no date.** The agency policy model has no lead-time field,
 *     so `eta` is `null` beside a stated reason. See `domain/delivery-promise.ts`.
 *   - **`checkPromotion` reports nothing at all.** There is no coupon model — `CartQuote`
 *     pins `discount` to a literal `0` — so the tool exists to be *asked*, and to answer
 *     "none", which is the only answer that stops a model inventing one.
 *
 * Neither is a stub awaiting a feature. Both are the honest shape of a question this
 * platform can answer today, and turning either into something that reports a number would
 * be the defect, not the fix.
 *
 * ── AND ONE THING NONE OF THEM MAY DO ───────────────────────────────────────────
 *
 * ⚠ **`absorbedByVendor` never appears in a response from this service** (D-7). It is what
 * the vendor pays the agency and it lives on `CartQuote` for the storefront; putting it in
 * front of a model negotiating with a customer invites *"delivery is costing me 2 000, meet
 * me halfway"* — a true number, deployed as a lever in a conversation it has no business
 * being in. `test:negotiation-tools` asserts by source scan that no file on this surface so
 * much as names it.
 */

import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getStorageProvider } from '../../../core/storage';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { ProductOptionModel, ProductOptionValueModel } from '../../catalog/models';
import { ProductType } from '../../catalog/models/product.model';
import { relatedProductsRepository } from '../../catalog/repositories/mongo/related-products.repository.mongo';
import { RELATED_PRODUCTS_CONFIG } from '../../catalog/config/related-products.config';
import { VendorRepository } from '../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import {
    buildDeliveryPromise,
    DeliveryAgencyFacts,
    DeliveryPromise,
} from '../domain/delivery-promise';
import {
    requireProductSubject,
    requireSearchSubject,
} from '../domain/negotiation-tool-subject';
import {
    askingPriceOf,
    compareAtPriceOf,
    NegotiationStock,
    NegotiationWindow,
    NEGOTIATION_TOOL_CURRENCY,
    stockOf,
    windowOf,
} from '../domain/negotiation-tool-view';
import {
    NegotiationCatalogRepositoryMongo,
    negotiationCatalogRepository,
    NegotiationProductRow,
    NegotiationVariantRow,
} from '../repositories/negotiation-catalog.repository';

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export interface NegotiationVariantView {
    id: string;
    sku: string;
    /** The vendor's own name for it, or null on an option-derived variant. */
    name: string | null;
    /** Name → option-derived label → product title. What to call it in a sentence. */
    displayName: string;
    options: Array<{ option: string | null; value: string }>;
    /** What the customer is quoted with no haggling — the ask for a bargainable variant. */
    askingPrice: number;
    /** Published only while strictly above `askingPrice`. See `compareAtPriceOf`. */
    compareAtPrice: number | null;
    bargainable: boolean;
    /** ⚠ Carries the vendor's FLOOR. Null when this variant is not bargainable. */
    window: NegotiationWindow | null;
    stock: NegotiationStock;
    images: FileDetail[];
}

export interface NegotiationProductView {
    id: string;
    slug: string;
    title: string;
    description: string;
    type: ProductType;
    category: string;
    tags: string[];
    currency: string;
    store: { slug: string; name: string; isOpen: boolean };
    images: FileDetail[];
    defaultVariantId: string | null;
    variants: NegotiationVariantView[];
}

/**
 * A search hit. Deliberately NOT a `NegotiationProductView`.
 *
 * A hit is a card in a shortlist, and the sub-agent's next move on any of them is to call
 * `get_product_details` — which the playbook already names as its truth source. Returning
 * the full variant list for every hit would duplicate that tool's job, multiply the
 * response, and give the model two shapes for one thing.
 *
 * What a hit *does* carry is the plan's requirement: **the bargainable flag and the window**
 * — of the ENTRY variant, the cheapest sellable one, which is the variant a budget-led
 * pitch opens from. `variantCount` says when there is more to ask about.
 */
export interface NegotiationSearchHit {
    id: string;
    slug: string;
    title: string;
    type: ProductType;
    category: string;
    currency: string;
    store: { slug: string; name: string; isOpen: boolean };
    image: FileDetail | null;
    variantCount: number;
    entry: {
        variantId: string;
        askingPrice: number;
        bargainable: boolean;
        /** ⚠ Carries the FLOOR. This is what lets the agent pivot into a fresh negotiation. */
        window: NegotiationWindow | null;
        stock: NegotiationStock;
    };
    /**
     * The cheapest and dearest price any sellable variant could reach — the floor band.
     * `floorMin` is what the budget bound compared against.
     */
    floorMin: number;
    floorMax: number;
    /**
     * How many co-purchases this pairing was seen in. Present only on
     * `find_complementary_products`, and only because it is a real count.
     */
    coPurchasedOrders?: number;
}

// ─── The service ─────────────────────────────────────────────────────────────

export class NegotiationToolsService {
    constructor(
        private readonly catalog: NegotiationCatalogRepositoryMongo = negotiationCatalogRepository,
        private readonly files = new FileRepositoryMongo(),
        private readonly vendors = new VendorRepository(),
        private readonly agencies = new DeliveryAgencyRepository(),
        private readonly magazins = new MagazinRepository(),
    ) { }

    /**
     * `get_product_details` — the truth source.
     *
     * Returns every sellable variant with its window, its real stock and its images. A
     * product that does not resolve is a `404`: telling the model "not found" is what makes
     * it say *"let me check that"* rather than answer from the hand-off it was given, which
     * a model composed and may have got wrong.
     */
    async productDetails(input: {
        productId?: string;
        variantId?: string;
        sku?: string;
        slug?: string;
    }): Promise<{ resolvedBy: string; product: NegotiationProductView }> {
        const subject = requireProductSubject(input, 'get_product_details');
        const found = await this.catalog.findSubject(subject);

        if (!found) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, undefined, {
                tool: 'get_product_details',
                subject,
            });
        }

        return {
            resolvedBy: found.resolvedBy,
            product: await this.toProductView(found.row),
        };
    }

    /**
     * `find_alternative_product` — the price-bounded substitute search.
     *
     * When a subject is named, its category and type become the default filters and it is
     * excluded from its own results; a bare `query` searches the whole publishable
     * catalogue. `maxPrice` bounds the FLOOR — the reasoning is in `withinBudget`, and it is
     * what makes this tool able to answer *"is there anything I could get them into for
     * 40 000"* rather than only *"what is already shelved under 40 000"*.
     */
    async findAlternatives(input: {
        productId?: string;
        variantId?: string;
        sku?: string;
        slug?: string;
        query?: string;
        maxPrice?: number;
        category?: string;
        type?: ProductType;
        inStockOnly?: boolean;
        limit?: number;
    }): Promise<{ basis: 'substitute'; subjectId: string | null; hits: NegotiationSearchHit[] }> {
        const subject = requireSearchSubject(input, 'find_alternative_product');
        const found = subject.productId || subject.variantId || subject.sku || subject.slug
            ? await this.catalog.findSubject(subject)
            : null;

        const rows = await this.catalog.findCandidates({
            query: subject.query,
            // An explicit filter wins over one inferred from the subject: a model that says
            // "same category" has said nothing, while one that names a category has made a
            // decision, and a customer pivoting from a phone to a phone case is naming it.
            category: input.category ?? found?.row.category,
            types: input.type ? [input.type] : found ? [found.row.type] : undefined,
            maxPrice: input.maxPrice,
            inStockOnly: input.inStockOnly,
            excludeProductId: found?.row.id,
            limit: clampLimit(input.limit),
        });

        return {
            basis: 'substitute',
            subjectId: found?.row.id ?? null,
            hits: await this.toSearchHits(rows),
        };
    }

    /**
     * `find_complementary_products` — bundle candidates, from real co-purchase history.
     *
     * ⚠ **"Complementary" is a claim about ORDERS, never about fit.** The name was chosen
     * over "compatibility" for exactly this reason: nothing in this database knows whether
     * a charger fits a phone, and a model handed a tool called `check_compatibility` will
     * treat the answer as an engineering verdict. What the platform genuinely knows is
     * `RelatedProductsRepositoryMongo.coOccurring` — how many past PAID orders contained
     * both products — and `coPurchasedOrders` on each hit is that count, unembellished.
     *
     * ⚠ **There is deliberately NO fallback.** `RelatedProductsService` falls back to
     * `sameCategoryRecent` when co-occurrence is thin, and that is right for a storefront
     * strip — but a same-category product is a **substitute**, and offering one as a bundle
     * is telling a customer to buy two of the same kind of thing while calling it
     * generosity. An empty result is the correct answer to "what goes with this", and the
     * sub-agent's response to an empty result is to sweeten some other way, which its
     * playbook already covers.
     */
    async findComplements(input: {
        productId?: string;
        variantId?: string;
        sku?: string;
        slug?: string;
        maxPrice?: number;
        inStockOnly?: boolean;
        limit?: number;
    }): Promise<{
        basis: 'co_purchased';
        subjectId: string;
        hits: NegotiationSearchHit[];
        note: string;
    }> {
        const subject = requireProductSubject(input, 'find_complementary_products');
        const found = await this.catalog.findSubject(subject);

        if (!found) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, undefined, {
                tool: 'find_complementary_products',
                subject,
            });
        }

        const limit = clampLimit(input.limit);
        // Over-fetch, because the price bound and the publishable predicate are both applied
        // after the ranking and either can thin the list.
        const pairs = await relatedProductsRepository.coOccurring(
            found.row.id,
            Math.min(limit * 3, RELATED_PRODUCTS_CONFIG.LIMIT * 3),
        );

        const ordersById = new Map(pairs.map((p) => [p.productId, p.orders]));
        const rows = await this.catalog.findPublishableByIds(pairs.map((p) => p.productId));

        const filtered = rows
            .filter((row) => input.maxPrice === undefined || row.reachableFloor <= input.maxPrice)
            .filter((row) => input.inStockOnly !== true || row.variants.some((v) => stockOf(v).sellable))
            // The repository returns no order; the ranking is the caller's, and it is the
            // co-occurrence count. `id` breaks ties so two identical calls agree.
            .sort((a, b) => (ordersById.get(b.id) ?? 0) - (ordersById.get(a.id) ?? 0) || a.id.localeCompare(b.id))
            .slice(0, limit);

        const hits = await this.toSearchHits(filtered);
        for (const hit of hits) hit.coPurchasedOrders = ordersById.get(hit.id) ?? 0;

        return {
            basis: 'co_purchased',
            subjectId: found.row.id,
            hits,
            note:
                'These are products bought in the same orders as this one, over a sample of recent '
                + 'paid orders. That is a fact about what other customers bought together — it is NOT '
                + 'a verified technical fit. Never tell a customer an item is compatible with, fits, '
                + 'or works with another; say it is often bought together with it.',
        };
    }

    /**
     * `quote_delivery` — the delivery PROMISE, not a fee.
     *
     * Re-scoped by D-7: there is no fee to quote, so this answers deliverable / by whom /
     * when. The "when" is always `null` — see `domain/delivery-promise.ts` for the
     * confirmation that the agency policy model carries no lead time.
     *
     * The agency is resolved exactly as checkout resolves it (`resolveEffectiveAgencyId`'s
     * rule: the product's own override, else the vendor's default), so the agency named here
     * is the agency that will actually carry the parcel.
     */
    async quoteDelivery(input: {
        productId?: string;
        variantId?: string;
        sku?: string;
        slug?: string;
        region?: string;
    }): Promise<{ productId: string; promise: DeliveryPromise }> {
        const subject = requireProductSubject(input, 'quote_delivery');
        const found = await this.catalog.findSubject(subject);

        if (!found) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, undefined, {
                tool: 'quote_delivery',
                subject,
            });
        }

        const row = found.row;
        const agency = row.type === 'physical' ? await this.resolveAgencyFacts(row) : null;

        return {
            productId: row.id,
            promise: buildDeliveryPromise({
                productType: row.type,
                currency: NEGOTIATION_TOOL_CURRENCY,
                agency,
                region: input.region,
            }),
        };
    }

    /**
     * `check_promotion` — the deliberate stub.
     *
     * ⚠ **This must never grow the ability to report a promotion, and the reason is not
     * "the feature is unbuilt".** There is no coupon model on this platform at all:
     * `CartQuoteService` pins `discount` to a literal `0` and documents that
     * `price_breakdown.discount` awaits one. A tool that returned anything else would be
     * describing a discount the cart will not apply, at checkout, to a customer who was
     * promised it. The playbook forbids mentioning promotions for the same reason; the tool
     * exists so the model has somewhere to *ask*, and gets a "no" it can say out loud.
     *
     * ── Why a CODE is refused rather than answered `false` ──────────────────────
     *
     * A customer saying *"I have code JOVI10"* is asking a question this platform cannot
     * answer. `{ available: false }` to that question reads as **"that code is not valid"* —
     * a verdict on a specific code nobody checked, and exactly the invented fact this tool
     * exists to prevent. `422 NEGOTIATION_PROMOTIONS_UNAVAILABLE` says the thing that is
     * true instead: there is no promotion system, so there is no code to check and none to
     * be valid. The registry message is worded to be unrenderable as "your code expired".
     */
    checkPromotion(input: { code?: string; productId?: string }): {
        available: false;
        promotions: never[];
        reason: 'no_promotion_system';
        guidance: string;
    } {
        const code = input.code?.trim();
        if (code) {
            throw createAppError(ERROR_CODES.NEGOTIATION_PROMOTIONS_UNAVAILABLE, 422, undefined, {
                tool: 'check_promotion',
                // The code itself is NOT echoed. Nothing here validates it, and putting it in
                // a `details` object is how it ends up quoted back at the customer.
                codeSupplied: true,
            });
        }

        return {
            available: false,
            promotions: [],
            reason: 'no_promotion_system',
            guidance:
                'This platform runs no promotions, coupons or discount codes of any kind. Say so '
                + 'plainly and move to what you CAN offer: your price, free delivery, or a bundle.',
        };
    }

    // ─── Enrichment ──────────────────────────────────────────────────────────

    private async toProductView(row: NegotiationProductRow): Promise<NegotiationProductView> {
        const storage = getStorageProvider();
        const fileIds = [...row.fileIds, ...row.variants.flatMap((v) => v.fileIds)];
        const fileMap = await resolveFileDetails(fileIds, this.files, storage);
        const optionMap = await this.resolveOptionValues(row.variants);

        return {
            id: row.id,
            slug: row.slug,
            title: row.title,
            description: row.description,
            type: row.type,
            category: row.category,
            tags: row.tags,
            currency: NEGOTIATION_TOOL_CURRENCY,
            store: { slug: row.storeSlug, name: row.storeName, isOpen: row.storeIsOpen },
            images: pickFiles(row.fileIds, fileMap),
            defaultVariantId: row.defaultVariantId,
            variants: row.variants.map((variant) => {
                const options = variant.optionValueIds
                    .map((id) => optionMap.get(id))
                    .filter((o): o is { option: string | null; value: string } => !!o);
                const window = windowOf(row.vectorisationEnabled, variant);

                return {
                    id: variant.id,
                    sku: variant.sku,
                    name: variant.name,
                    displayName: displayNameOf(variant, options, row.title),
                    options,
                    askingPrice: askingPriceOf(row.vectorisationEnabled, variant),
                    compareAtPrice: compareAtPriceOf(row.vectorisationEnabled, variant),
                    bargainable: window !== null,
                    window,
                    stock: stockOf(variant),
                    images: pickFiles(variant.fileIds, fileMap),
                };
            }),
        };
    }

    private async toSearchHits(rows: NegotiationProductRow[]): Promise<NegotiationSearchHit[]> {
        if (rows.length === 0) return [];

        const storage = getStorageProvider();
        // The card image only — the first product-level file. A shortlist does not need a
        // gallery, and resolving every variant's images for every hit is the N+1 the
        // storefront's own list DTO exists to avoid.
        const fileMap = await resolveFileDetails(
            rows.map((row) => row.fileIds[0]),
            this.files,
            storage,
        );

        return rows.map((row) => {
            // `variants` is sorted cheapest-first by the repository, so the entry variant is
            // the first one — the cheapest floor, which is what a budget-led pitch opens from.
            const entry = row.variants[0];
            const window = windowOf(row.vectorisationEnabled, entry);
            const firstImage = row.fileIds[0] ? fileMap.get(row.fileIds[0]) ?? null : null;

            return {
                id: row.id,
                slug: row.slug,
                title: row.title,
                type: row.type,
                category: row.category,
                currency: NEGOTIATION_TOOL_CURRENCY,
                store: { slug: row.storeSlug, name: row.storeName, isOpen: row.storeIsOpen },
                image: firstImage,
                variantCount: row.variants.length,
                entry: {
                    variantId: entry.id,
                    askingPrice: askingPriceOf(row.vectorisationEnabled, entry),
                    bargainable: window !== null,
                    window,
                    stock: stockOf(entry),
                },
                floorMin: row.reachableFloor,
                floorMax: Math.max(...row.variants.map((v) => v.price)),
            };
        });
    }

    /**
     * Option-value ids → `{ option, value }`, batched across the whole variant set.
     *
     * Two queries however many variants there are. The same shape `VectorisationService`
     * builds, for the same reason it gives: an id is not something a model can say to a
     * customer.
     */
    private async resolveOptionValues(
        variants: NegotiationVariantRow[],
    ): Promise<Map<string, { option: string | null; value: string }>> {
        const ids = [...new Set(variants.flatMap((v) => v.optionValueIds))];
        const map = new Map<string, { option: string | null; value: string }>();
        if (ids.length === 0) return map;

        const values = await ProductOptionValueModel.find({ _id: { $in: ids }, deletedAt: null })
            .select('optionId value')
            .lean()
            .exec();

        const optionIds = [...new Set(values.map((v) => v.optionId.toString()))];
        const options = await ProductOptionModel.find({ _id: { $in: optionIds }, deletedAt: null })
            .select('name')
            .lean()
            .exec();
        const nameById = new Map(options.map((o) => [o._id.toString(), o.name]));

        for (const value of values) {
            map.set(value._id.toString(), {
                option: nameById.get(value.optionId.toString()) ?? null,
                value: value.value,
            });
        }
        return map;
    }

    /**
     * Which agency carries this product, and what its customers can be told about it.
     *
     * The resolution order — the product's `delivery.agency_id`, else the vendor's
     * `default_delivery_agency_id` — is `resolveEffectiveAgencyId`'s rule, restated here
     * against the row shape this surface reads rather than the domain `Product` that helper
     * takes. Getting it wrong means naming one agency for another's parcel.
     *
     * ⚠ The NAME comes from the agency's **Magazin**, not from `DeliveryAgency`. That
     * document carries a personal `display_name` and no business name at all — business
     * identity lives on the Magazin, exactly as a vendor's lives on their Store.
     */
    private async resolveAgencyFacts(row: NegotiationProductRow): Promise<DeliveryAgencyFacts | null> {
        let agencyId = row.deliveryAgencyId;

        if (!agencyId) {
            const vendor = await this.vendors.findById(row.vendorId);
            agencyId = vendor?.default_delivery_agency_id?.toString() ?? null;
        }
        if (!agencyId) return null;

        const agency = await this.agencies.findById(agencyId);
        if (!agency) return null;

        const magazin = await this.magazins.findByAgencyIdOrNull(agencyId);

        return {
            id: agencyId,
            name: magazin?.name ?? null,
            coverageAreas: magazin?.coverage_areas ?? [],
        };
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Five by default, ten at most.
 *
 * Five matches `product_search`'s `p_match_count` default, which is what the main agent's
 * shortlists are already sized to — and a chat window cannot render more than a handful
 * without the model summarising them into something it made up. The ceiling is the same
 * judgement, enforced rather than requested.
 */
function clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return 5;
    return Math.max(1, Math.min(10, Math.trunc(limit)));
}

function pickFiles(ids: string[], map: Map<string, FileDetail>): FileDetail[] {
    return ids.map((id) => map.get(id)).filter((f): f is FileDetail => !!f);
}

/**
 * What to call this variant in a sentence.
 *
 * Vendor name → the option labels that define it ("Size M · Red") → the product's own
 * title. The last fallback matters more than it looks: a simple-mode product has exactly
 * one variant with no name and no options, and "the variant" is not a thing a customer
 * recognises. `enrichVariant` makes the same three-step choice.
 */
function displayNameOf(
    variant: NegotiationVariantRow,
    options: Array<{ option: string | null; value: string }>,
    productTitle: string,
): string {
    if (variant.name) return variant.name;
    if (options.length > 0) {
        return options.map((o) => (o.option ? `${o.option} ${o.value}` : o.value)).join(' · ');
    }
    return productTitle || variant.sku;
}

export const negotiationToolsService = new NegotiationToolsService();
