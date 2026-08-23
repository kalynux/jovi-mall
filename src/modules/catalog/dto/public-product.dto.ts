/**
 * The product shapes served to unauthenticated callers — the storefront.
 *
 * ⚠️ **This file is the security boundary of the public catalog.** `/api/public/*` has no
 * auth guard anywhere above or below it, so every field named here is world-readable and
 * every field NOT named here is not. Adding a field to `Product` or `ProductVariant` does
 * **not** publish it — that is a deliberate edit here, exactly as
 * `billing/dto/public-plan.dto.ts` says of the plan catalogue.
 *
 * ── Why this is a hand-written projection and not `EnrichedProduct` ──────────
 *
 * `read-models/enrich-product-detail.ts` already builds a rich product view, and reusing it
 * would look like the DRY choice. It is not, and the reason is structural rather than
 * stylistic: `EnrichedProduct` is `Omit<Product, 'fileIds'> & {...}`, i.e. a **spread of the
 * entire domain object**. Everything the model gains, it publishes — today that includes
 *
 *   - `vendorId`, which the storefront deliberately never exposes (it addresses a seller by
 *     store slug, so that an internal id never becomes a public identifier);
 *   - the whole `suspension` block, whose `note` is free vendor-facing text ("storage rent
 *     unpaid") written by an agency about a business it warehouses for;
 *   - `delivery.pickup_location`, whose two ids point at a vendor's home or warehouse
 *     address and an agency's depot;
 *   - `vectorisationEnabled` / `vectorisationStatus` / `vectorisedDataId`, internal
 *     pipeline state;
 *   - `deletedAt` / `purgeAt`.
 *
 * A spread also means the *next* field somebody adds to the model is published by whoever
 * adds it, silently, without touching this file or thinking about it. An explicit
 * projection makes publication a decision that shows up in a diff.
 *
 * (`EnrichedProduct` is also N+1 on files and issues one digital-asset query per variant,
 * so it would be the wrong choice for a public list even if it leaked nothing.)
 *
 * ── Conventions ─────────────────────────────────────────────────────────────
 *
 * Optional keys are **omitted, not nulled** (`...(x ? { k: x } : {})`), following
 * `blog/dto/public-article.dto.ts`. The exceptions are the handful of fields where
 * *absent* is a state the UI renders — `compareAtPrice`, `image` — which carry an explicit
 * `null` so a client can tell "not discounted" from "we forgot to send it".
 */
import { Product } from '../repositories/mappers/product.mapper';
import { Variant } from '../repositories/mappers/variant.mapper';
import { FileDetail } from '../read-models/product-detail.read-model';
import type { RatingBreakdownDto, RatingSummaryDto } from '../../reviews/dto/review.dto';

// ─────────────────────────────────────────────────────────────────────────────
//  Store, as it appears nested on a product
// ─────────────────────────────────────────────────────────────────────────────

/** The seller, as a shopper sees them from a product row. Never carries `vendorId`. */
export interface PublicProductStoreDto {
    slug: string;
    name: string;
    /**
     * Vendor vacation mode (`store.is_open`).
     *
     * A closed store's products are still listed and still resolve — `is_open` does not
     * suspend anything, and hiding them would break every live link and sitemap entry for
     * the duration of a holiday. The flag is here so the UI can say so and disable the buy
     * button. See BACKEND-SHOP-REQUIREMENTS §2.7e.
     */
    isOpen: boolean;
}

/**
 * The buyer-facing half of a vendor's return policy.
 *
 * ⚠️ Published as **structured terms, not prose**. §2.2 of the requirements sketched
 * `returnPolicy` as a string, but `IVendorReturnPolicy` is a structured document and there
 * is no prose field anywhere to render from — so a string would have had to be generated
 * here, in one language, for a five-locale storefront. Shipping the facts lets the frontend
 * phrase them in the reader's language and lets a comparison view sort on them.
 *
 * `inspector` is deliberately absent: it is admin-controlled, never vendor input, and says
 * who adjudicates a dispute internally.
 */
export interface PublicReturnPolicyDto {
    eligible: boolean;
    windowDays: number;
    refundType: 'full' | 'partial' | 'none';
    refundPercentage: number | null;
    returnShippingPayer: 'vendor' | 'customer' | 'customer_reimbursed_if_defect';
    refundProcessingDays: number;
    conditionNotes: string | null;
}

export interface PublicCancellationPolicyDto {
    cancellable: boolean;
    deadline: string | null;
    deadlineDays: number | null;
    feeType: string | null;
    feeValue: number | null;
    lateRefundType: string | null;
    lateRefundValue: number | null;
}

/**
 * The seller card on a product page — richer than the list's, because this is where a
 * shopper decides whether to trust the seller.
 *
 * `city` is the **only** address component published. A vendor's `business_addresses[]`
 * entries are the places they ship from — a home or a warehouse, with a street line and
 * exact coordinates. A shopper needs the city; the rest is a private address.
 */
export interface PublicProductDetailStoreDto {
    slug: string;
    name: string;
    logo: FileDetail | null;
    isOpen: boolean;
    /** `vendor.kyc_details.legit_verified`. Never the KYC document behind it. */
    verified: boolean;
    city: string | null;
    country: string | null;
    supportWhatsapp: string | null;
    policies: {
        returnPolicy: PublicReturnPolicyDto | null;
        cancellationPolicy: PublicCancellationPolicyDto | null;
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  List row
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicProductListItemDto {
    id: string;
    slug: string;
    title: string;
    type: 'physical' | 'digital' | 'service';
    category: string;
    tags: string[];

    /**
     * Resolved from the default variant — the product itself has no price.
     * On a **service** product this is a UNIT RATE; see `priceUnit` on the detail DTO.
     */
    price: number;
    /** `null` when not discounted. Explicit, because absent is a state the UI renders. */
    compareAtPrice: number | null;
    currency: string;
    /** Omitted entirely when every sellable variant is the same price. */
    priceRange?: { min: number; max: number };

    /**
     * Boolean, never a count — and that is a correctness decision, not brevity.
     * Until stock reservation is wired nothing in the order path decrements
     * `variant.stock`, so publishing "3 left" would be a promise the platform cannot
     * keep. See BACKEND-SHOP-REQUIREMENTS §3.1.
     */
    inStock: boolean;

    /** Thumbnail only. `null` when the product has no usable image. */
    image: FileDetail | null;

    /**
     * Customer rating, or **`null` when there are none** — never `{ average: 0,
     * count: 0 }`.
     *
     * ⚠ That null is a contract, not a convenience, and it is what closes the
     * `aggregateRating` question this DTO's neighbours have carried since the
     * storefront shipped. `src/lib/seo/jsonld.ts` on the frontend omits
     * `aggregateRating` deliberately, because publishing invented review counts is a
     * Google review-snippet spam-policy violation that earns a manual action. Now
     * that real aggregates exist, the rule becomes: **emit `aggregateRating` if and
     * only if this field is non-null.** A client cannot get that wrong if the server
     * never sends a zero-count summary, which is why the shape is nullable rather
     * than always-present. See `api-doc/public/catalog.md`.
     */
    rating: RatingSummaryDto | null;

    store: PublicProductStoreDto;

    freeDelivery: boolean;
    /** Needed by the frontend's `sitemap.ts` for a real `lastModified`. */
    updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Detail
// ─────────────────────────────────────────────────────────────────────────────

/** One selectable value of one option — what the chips render from. */
export interface PublicOptionValueDto {
    id: string;
    value: string;
}

export interface PublicProductOptionDto {
    id: string;
    name: string;
    position: number;
    values: PublicOptionValueDto[];
}

/** A variant's option selection, pre-joined so the client reconstructs nothing. */
export interface PublicVariantOptionDto {
    optionId: string;
    optionName: string;
    valueId: string;
    value: string;
}

export interface PublicVariantDto {
    id: string;
    /**
     * Published deliberately. `ProductVariant.sku` is already globally unique and already
     * shown to this same customer on their cart lines and order history, so it is not a
     * secret — and JSON-LD's `Offer` wants a stable identifier for rich results.
     */
    sku: string;
    name: string;
    price: number;
    compareAtPrice: number | null;
    currency: string;
    inStock: boolean;

    /**
     * ⚠️ **The selection key. Never key a variant lookup on `optionSignature`.**
     *
     * `optionSignature` is a lowercased string like `"size:large|color:red"`, and renaming
     * an option value is documented as a *safe* operation that deliberately does not
     * rewrite it (`vendor-products.routes.ts`). So after a rename the stored signature
     * still says `color:red` while every screen says `crimson`, and a client that rebuilds
     * the signature from displayed text fails to find a variant that exists.
     *
     * `optionValueIds` cannot go stale that way, which is why it is what ships — together
     * with `options` below, so the client never has to join anything itself.
     */
    optionValueIds: string[];
    options: PublicVariantOptionDto[];

    /** Variant media. Omitted when the variant has none (the product gallery applies). */
    images?: FileDetail[];

    /** Digital variants only — terms of sale, safe to publish. Never the asset itself. */
    digital?: {
        maxDownloads: number | null;
        expiresAfterDays: number | null;
    };

    /**
     * Service variants only.
     *
     * ⚠️ `price` above is a **unit rate**, not a total: it is the price per
     * `durationMinutes`, prorated by the actual elapsed duration and then surcharged by
     * peak hours. A storefront that prints it as "the price" misquotes the customer, so
     * two derived fields ship beside it — `priceUnit` (a label, e.g. `"per 60 min"`) and
     * `priceFrom` (the least a booking of the minimum duration can cost). Render
     * "from {priceFrom} · {priceUnit}" and the quote is never wrong.
     */
    service?: {
        durationMinutes: number;
        bookingMode: 'calendar' | 'manual' | 'capacity';
        bufferBeforeMinutes: number;
        bufferAfterMinutes: number;
        priceUnit: string;
        priceFrom: number;
    };
}

export interface PublicProductDetailDto {
    id: string;
    slug: string;
    title: string;
    description: string;
    type: 'physical' | 'digital' | 'service';
    category: string;
    tags: string[];
    seo?: { title?: string; description?: string };

    /** Full gallery, thumbnail first. */
    images: FileDetail[];

    /** Empty on a simple-mode product — the frontend skips the picker entirely. */
    options: PublicProductOptionDto[];
    variants: PublicVariantDto[];
    defaultVariantId: string | null;

    /**
     * Which language the vendor authored this text in.
     *
     * `title`/`description`/`category`/`tags`/`seo.*` are plain strings with no
     * `Accept-Language` handling, in an app that ships five locales. Rather than pretend
     * otherwise, the platform's position is that product text is **vendor-authored in one
     * language** and this field says which, so the UI can label it honestly instead of
     * presenting French copy as though it were the Portuguese translation.
     * See BACKEND-SHOP-REQUIREMENTS §3.7.
     */
    contentLanguage: string;

    /**
     * Customer rating with its 1–5 histogram, or `null` when there are none.
     *
     * Same rule as the list row's `rating` and the same reason — see there. The
     * detail carries the breakdown as well because the product page renders the bar
     * chart above the review list, and asking for it separately would be a second
     * request for data this response already had to read.
     */
    rating: RatingBreakdownDto | null;

    store: PublicProductDetailStoreDto;

    freeDelivery: boolean;
    createdAt: string;
    updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mappers — pure, so `test:public-catalog` can assert them without Mongo
// ─────────────────────────────────────────────────────────────────────────────

/** A sellable variant is an active, non-deleted one. Archived variants never ship. */
export function isSellableVariant(variant: Variant): boolean {
    return variant.status === 'active' && !variant.deletedAt;
}

/**
 * Whether a variant can be bought right now.
 *
 * `isInfiniteStock` and `allowOversell` both mean "yes regardless of the counter" — the
 * first because nothing is being counted, the second because the vendor has said they will
 * source it. Everything else is `stock > 0`.
 */
export function variantInStock(variant: Variant): boolean {
    if (variant.isInfiniteStock || variant.allowOversell) return true;
    return variant.stock > 0;
}

/**
 * The price band across a product's sellable variants.
 *
 * Returns `undefined` when every variant costs the same, so the caller can omit the key
 * rather than send a degenerate `{ min: x, max: x }` the UI would have to special-case.
 */
export function priceRangeOf(variants: Variant[]): { min: number; max: number } | undefined {
    const prices = variants.filter(isSellableVariant).map((v) => v.price);
    if (prices.length === 0) return undefined;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return min === max ? undefined : { min, max };
}

/** `"per 60 min"` / `"per 1 h 30 min"` — the unit a service variant's rate is quoted in. */
export function servicePriceUnit(durationMinutes: number): string {
    if (durationMinutes < 60) return `per ${durationMinutes} min`;
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    return minutes === 0 ? `per ${hours} h` : `per ${hours} h ${minutes} min`;
}

/**
 * The least a booking of this variant can cost.
 *
 * `price` is the rate for exactly one `durationMinutes` block, and a booking cannot be
 * shorter than that, so the floor is the rate itself. Peak hours only ever *add*
 * (`priceType` is a fixed amount or a percentage on top), so they cannot lower this — which
 * is what makes "from" truthful rather than optimistic.
 */
export function servicePriceFrom(variant: Variant): number {
    return variant.price;
}

/**
 * Project a vendor's return policy down to the buyer-facing terms.
 *
 * `null` in, `null` out — a vendor who has not configured one has no terms to publish, and
 * inventing defaults here would state a return window the vendor never agreed to.
 */
export function toPublicReturnPolicyDto(
    policy: {
        return_eligible: boolean;
        return_window_days: number;
        refund_type: 'full' | 'partial' | 'none';
        refund_percentage: number | null;
        return_shipping_payer: 'vendor' | 'customer' | 'customer_reimbursed_if_defect';
        refund_processing_days: number;
        return_condition_notes: string | null;
    } | null | undefined,
): PublicReturnPolicyDto | null {
    if (!policy) return null;
    return {
        eligible: policy.return_eligible,
        windowDays: policy.return_window_days,
        refundType: policy.refund_type,
        refundPercentage: policy.refund_percentage ?? null,
        returnShippingPayer: policy.return_shipping_payer,
        refundProcessingDays: policy.refund_processing_days,
        conditionNotes: policy.return_condition_notes ?? null,
    };
}

export function toPublicCancellationPolicyDto(
    policy: {
        cancellable: boolean;
        cancellation_deadline: string | null;
        cancellation_deadline_days: number | null;
        cancellation_fee_type: string | null;
        cancellation_fee_value: number | null;
        late_cancellation_refund_type: string | null;
        late_cancellation_refund_value: number | null;
    } | null | undefined,
): PublicCancellationPolicyDto | null {
    if (!policy) return null;
    return {
        cancellable: policy.cancellable,
        deadline: policy.cancellation_deadline ?? null,
        deadlineDays: policy.cancellation_deadline_days ?? null,
        feeType: policy.cancellation_fee_type ?? null,
        feeValue: policy.cancellation_fee_value ?? null,
        lateRefundType: policy.late_cancellation_refund_type ?? null,
        lateRefundValue: policy.late_cancellation_refund_value ?? null,
    };
}

export function toPublicVariantDto(
    variant: Variant,
    currency: string,
    optionsById: Map<string, { id: string; name: string }>,
    valuesById: Map<string, { id: string; optionId: string; value: string }>,
    images: FileDetail[],
): PublicVariantDto {
    const options: PublicVariantOptionDto[] = variant.optionValueIds
        .map((valueId) => {
            const value = valuesById.get(valueId);
            if (!value) return null;
            const option = optionsById.get(value.optionId);
            if (!option) return null;
            return {
                optionId: option.id,
                optionName: option.name,
                valueId: value.id,
                value: value.value,
            };
        })
        .filter((o): o is PublicVariantOptionDto => o !== null);

    return {
        id: variant.id,
        sku: variant.sku,
        // A vendor-set name wins; otherwise build one from the selection ("Size: M, Colour:
        // Red"), and fall back to the SKU for a simple-mode variant that has neither.
        name: variant.name ?? (options.map((o) => `${o.optionName}: ${o.value}`).join(', ') || variant.sku),
        price: variant.price,
        compareAtPrice: variant.compareAtPrice ?? null,
        currency,
        inStock: variantInStock(variant),
        optionValueIds: [...variant.optionValueIds],
        options,
        ...(images.length > 0 ? { images } : {}),
        ...(variant.digitalConfig
            ? {
                digital: {
                    maxDownloads: variant.digitalConfig.maxDownloads ?? null,
                    expiresAfterDays: variant.digitalConfig.expiresAfterDays ?? null,
                },
            }
            : {}),
        ...(variant.serviceConfig
            ? {
                service: {
                    durationMinutes: variant.serviceConfig.durationMinutes,
                    bookingMode: variant.serviceConfig.bookingMode,
                    bufferBeforeMinutes: variant.serviceConfig.bufferBeforeMinutes,
                    bufferAfterMinutes: variant.serviceConfig.bufferAfterMinutes,
                    priceUnit: servicePriceUnit(variant.serviceConfig.durationMinutes),
                    priceFrom: servicePriceFrom(variant),
                },
            }
            : {}),
    };
}

export interface PublicProductDetailInput {
    product: Product;
    variants: Variant[];
    options: Array<{ id: string; name: string; position: number }>;
    optionValues: Array<{ id: string; optionId: string; value: string }>;
    productImages: FileDetail[];
    /** Keyed by variant id. Absent means "no variant media" — the gallery applies. */
    variantImages: Map<string, FileDetail[]>;
    currency: string;
    contentLanguage: string;
    store: PublicProductDetailStoreDto;
    /**
     * Already reduced to the DTO shape by the caller (`toRatingBreakdownDto`), so
     * this mapper stays pure and `test:public-catalog` can assert it without a
     * database. `null` means "no published reviews", and this function passes that
     * through unchanged rather than re-deciding it.
     */
    rating: RatingBreakdownDto | null;
}

export function toPublicProductDetailDto(input: PublicProductDetailInput): PublicProductDetailDto {
    const { product, options, optionValues, currency } = input;

    const optionsById = new Map(options.map((o) => [o.id, { id: o.id, name: o.name }]));
    const valuesById = new Map(optionValues.map((v) => [v.id, v]));

    const sellable = input.variants.filter(isSellableVariant);

    const valuesByOption = new Map<string, PublicOptionValueDto[]>();
    for (const value of optionValues) {
        const list = valuesByOption.get(value.optionId) ?? [];
        list.push({ id: value.id, value: value.value });
        valuesByOption.set(value.optionId, list);
    }

    return {
        id: product.id,
        slug: product.slug,
        title: product.title,
        description: product.description ?? '',
        type: product.type,
        category: product.category,
        tags: [...(product.tags ?? [])],
        ...(product.seo?.title || product.seo?.description
            ? {
                seo: {
                    ...(product.seo.title ? { title: product.seo.title } : {}),
                    ...(product.seo.description ? { description: product.seo.description } : {}),
                },
            }
            : {}),
        images: input.productImages,
        options: [...options]
            .sort((a, b) => a.position - b.position)
            .map((o) => ({
                id: o.id,
                name: o.name,
                position: o.position,
                values: valuesByOption.get(o.id) ?? [],
            })),
        variants: sellable.map((v) =>
            toPublicVariantDto(v, currency, optionsById, valuesById, input.variantImages.get(v.id) ?? []),
        ),
        // Only report a default the shopper can actually buy — a default pointing at an
        // archived variant would have the picker open on something that is not for sale.
        defaultVariantId:
            product.defaultVariantId && sellable.some((v) => v.id === product.defaultVariantId)
                ? product.defaultVariantId
                : null,
        contentLanguage: input.contentLanguage,
        rating: input.rating,
        store: input.store,
        freeDelivery: product.delivery?.freeDelivery ?? false,
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
    };
}
