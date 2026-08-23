import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getStorageProvider } from '../../../core/storage';
import {
    ProductModel,
    ProductVariantModel,
    IProduct,
    IProductVariant,
} from '../../catalog/models';
import { ShippingConfigModel } from '../../catalog/models/shipping-config.model';
import { StockReservationModel } from '../../catalog/models/stock-reservation.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { productImageKey, resolveProductImages } from '../../catalog/read-models/product-image.resolver';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { DeliveryAgencyModel, IStorageBasedPricing } from '../../delivery/delivery-agency.model';
import {
    StorageFeeQuote,
    StorageSize,
    quoteStorageFee,
    resolveStorageSize,
} from '../../inventory/domain/services/storage-fee.calculator';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { VendorModel } from '../vendor.model';
import { AgencyStockLevelRepository } from '../../inventory/repositories/agency-stock-level.repository';

/**
 * ── The administrative product detail ────────────────────────────────────────
 *
 * The dashboard's catalogue tab could only read a product by finding it in a page of
 * the list, and the list carries thirteen fields — no image, no price, no stock, no
 * storage charge, and the responsible agency as a bare id. This assembles the rest.
 *
 * ── Why this is DELEGATED rather than read directly by wi-admin ───────────────
 * ADR-009 D-1 says wi-admin reads records directly and delegates verdicts, and a
 * product is plainly a record. It is here anyway, and the reason is D-6: resolving a
 * `fileId` to a URL is storage-provider-aware, and wi-admin must not grow a storage
 * layer — duplicating `STORAGE_PROVIDER` across two services is exactly the drift the
 * split exists to prevent. The storage-fee arithmetic is the second reason: it lives
 * in `storage-fee.calculator.ts` and a copy would be a second opinion about what a
 * vendor owes. So: a record whose PROJECTION needs machinery this service owns is
 * delegated. That is a corollary of D-6, not an exception to D-1.
 *
 * ── What it deliberately does not compute ────────────────────────────────────
 * There is no "what the vendor owes for storing this product **this period**". The
 * platform does not track, invoice or act on storage payment — `storage-fee.calculator.ts`
 * says so in its own header, and `EarningsQuoteService` excludes the rate from every
 * split. `monthlyEstimate` is the agency's published rate multiplied by the quantity
 * both parties signed off on; anything further would be an invented invoice.
 *
 * Every lookup is batched across the product's variants, so a fifty-variant product
 * costs the same fixed number of queries as a one-variant one.
 */

/**
 * The account currency.
 *
 * A constant for the same reason `public-catalog.service.ts` keeps one: nothing in the
 * catalogue stores a currency, a variant's `price` is a bare number, and every cart,
 * plan and order is `XAF`. When multi-currency arrives this stops being a constant in
 * both places at once.
 */
const DEFAULT_CURRENCY = 'XAF';

/** One variant, as an administrator needs to see it. */
export interface AdminProductVariantDto {
    id: string;
    name: string | null;
    sku: string;
    status: 'active' | 'archived';
    amount: number;
    compareAtAmount: number | null;
    inventory: AdminProductInventoryDto;
    /** Null when this product is not warehoused by an agency — see `storage` below. */
    storage: AdminProductStorageDto | null;
}

export interface AdminProductInventoryDto {
    /**
     * **False means stock is not counted for this listing, not that it is zero.**
     * `available: 0` on a tracked listing is "sold out"; on an untracked one it is
     * meaningless. The two have opposite remedies, which is why this flag exists rather
     * than a nullable count.
     */
    tracked: boolean;
    /** `null` when `tracked` is false. */
    available: number | null;
    /** Units held mid-checkout. `null` when `tracked` is false. */
    reserved: number | null;
    /** `available - reserved`, floored at 0. `null` when `tracked` is false. */
    sellable: number | null;
    /** Vendor-set alert level. `null` = no alerting configured. */
    lowStockThreshold: number | null;
    allowOversell: boolean;
}

export interface AdminProductStorageDto {
    /** The only basis there is today; named so a volumetric one is additive. */
    basis: StorageFeeQuote['basis'];
    /**
     * `policies.pricing.storage_based.enabled`. **False means the agency does not offer
     * warehousing at all**, so the estimate is 0 by definition rather than by accident —
     * a screen must say so instead of printing a rate nobody agreed to.
     */
    storageBasedEnabled: boolean;
    monthlyRatePerSku: number;
    quantity: number;
    monthlyEstimate: number;
    currency: string;
    /**
     * Information for sanity-checking the rate, **never a multiplier** — the rate is flat
     * per SKU. `source` says whether the dimensions came from the variant or the
     * product's shipping defaults, because "we do not know how big this is" and
     * "30×20×12" must be distinguishable on a screen justifying a charge.
     */
    size: StorageSize | null;
}

export interface AdminProductDetailDto {
    id: string;
    vendorId: string;
    title: string;
    slug: string;
    category: string;
    tags: string[];
    type: 'physical' | 'digital' | 'service';
    status: string;
    mode: string;
    hasVariants: boolean;
    suspension: {
        reason: string;
        previousStatus: string;
        at: string;
        byAgencyId: string | null;
        note: string | null;
    } | null;
    media: {
        /** Thumbnail first, `image/*` only. Empty when the listing carries no picture. */
        images: FileDetail[];
        primaryImage: FileDetail | null;
    };
    /**
     * The default variant's price, and the spread when variants disagree. `null` on a
     * product with no variants at all — which is a broken listing, and saying so is the
     * point.
     */
    pricing: {
        amount: number;
        compareAtAmount: number | null;
        currency: string;
        range: { min: number; max: number } | null;
    } | null;
    /** Summed across active variants. Per-variant figures are on `variants`. */
    inventory: AdminProductInventoryDto;
    /**
     * The agency responsible for this listing — its own override if set, otherwise the
     * vendor's default (`resolveEffectiveAgencyId`'s rule). An object, not an id, so the
     * name arrives under `vendors.read` instead of requiring a second permission.
     */
    deliveryAgency: {
        id: string;
        businessName: string | null;
        status: string | null;
    } | null;
    /**
     * The product-level storage quote, summed over its variants' quantities.
     *
     * `null` when the listing is not warehoused by an agency — a digital product, or a
     * physical one shipped from the vendor's own address. `null` and "zero rent" are
     * different facts and must not both render as 0.
     */
    storage: AdminProductStorageDto | null;
    variants: AdminProductVariantDto[];
    lastOrderedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export class AdminProductDetailResolver {
    constructor(
        private readonly magazins: MagazinRepository = new MagazinRepository(),
        private readonly files: FileRepositoryMongo = new FileRepositoryMongo(),
    ) { }

    /**
     * @param vendorId scopes the lookup — the ownership IS the authorisation, so a
     *   product belonging to another vendor is a 404 rather than a 403. The caller must
     *   have already established the vendor exists, so this 404 can only mean the
     *   product.
     */
    async resolve(vendorId: string, productId: string): Promise<AdminProductDetailDto> {
        if (!Types.ObjectId.isValid(productId)) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
        }

        const product = await ProductModel.findOne({
            _id: productId,
            vendorId,
            deletedAt: null,
        }).exec();

        if (!product) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
        }

        // Archived variants are kept: a listing that went wrong is exactly what an
        // administrator opens this screen to understand, and hiding the archived unit
        // makes a product with one archived variant look like a product with none.
        const variants = await ProductVariantModel.find({ productId: product._id, deletedAt: null })
            .sort({ createdAt: 1 })
            .exec();

        const [images, reservedByVariant, shipping, agency, warehousedByVariant] = await Promise.all([
            this.resolveImages(product, variants),
            reservedUnitsByVariant(variants.map((v) => String(v._id))),
            ShippingConfigModel.findOne({ productId: product._id }).lean().exec(),
            this.resolveAgency(product),
            // Step 14: the storage quote bills the agency's COUNTED shelf, so the depot rows
            // have to be read here. Batched by variant so a product with twenty variants is
            // one query rather than twenty.
            new AgencyStockLevelRepository().warehousedByVariant(variants.map((v) => String(v._id))),
        ]);

        const variantDtos = variants.map((variant) =>
            this.toVariantDto(
            variant,
            reservedByVariant.get(String(variant._id)) ?? 0,
            shipping,
            agency,
            warehousedByVariant,
        ),
        );

        return {
            id: String(product._id),
            vendorId: product.vendorId.toString(),
            title: product.title,
            slug: product.slug,
            category: product.category,
            tags: product.tags ?? [],
            type: product.type,
            status: product.status,
            mode: product.mode ?? 'advanced',
            hasVariants: product.hasVariants,
            suspension: product.suspension
                ? {
                    reason: product.suspension.reason,
                    previousStatus: product.suspension.previousStatus,
                    at: product.suspension.suspendedAt.toISOString(),
                    byAgencyId: product.suspension.suspendedByAgencyId
                        ? product.suspension.suspendedByAgencyId.toString()
                        : null,
                    note: product.suspension.note ?? null,
                }
                : null,
            media: {
                images,
                primaryImage: images[0] ?? null,
            },
            pricing: productPricing(product, variants),
            inventory: rollUpInventory(variantDtos),
            deliveryAgency: agency
                ? { id: agency.id, businessName: agency.businessName, status: agency.status }
                : null,
            storage: rollUpStorage(variantDtos, agency),
            variants: variantDtos,
            lastOrderedAt: product.lastOrderedAt ? product.lastOrderedAt.toISOString() : null,
            createdAt: product.createdAt.toISOString(),
            updatedAt: product.updatedAt.toISOString(),
        };
    }

    /**
     * The gallery, resolved through the shared resolver so an administrator sees exactly
     * what a customer and a delivery agent see.
     *
     * Asked for against the DEFAULT variant, because that is what `resolveProductImages`
     * treats as "the thing being sold" — it falls back to the product's own media when
     * the variant carries none, which is the normal case.
     */
    private async resolveImages(product: IProduct, variants: IProductVariant[]): Promise<FileDetail[]> {
        const defaultVariantId =
            (product.defaultVariantId ? product.defaultVariantId.toString() : null) ??
            (variants[0] ? String(variants[0]._id) : null);

        const productId = String(product._id);
        const map = await resolveProductImages(
            [{ productId, variantId: defaultVariantId }],
            this.files,
            getStorageProvider(),
        );
        return map.get(productImageKey(productId, defaultVariantId)) ?? [];
    }

    /**
     * Which agency answers for this listing, and what it charges to shelve one SKU.
     *
     * The override-then-default precedence is `resolveEffectiveAgencyId`'s, restated
     * against the persistence shape because this resolver holds the document rather than
     * the domain entity. `pricing` is read ONCE here and passed down to every variant —
     * the rate is the same for all of them, and looking it up per variant would make a
     * product's detail a product's worth of queries.
     */
    private async resolveAgency(product: IProduct): Promise<ResolvedAgency | null> {
        const own = product.delivery?.agency_id ? product.delivery.agency_id.toString() : null;

        let agencyId = own;
        if (!agencyId) {
            const vendor = await VendorModel.findById(product.vendorId)
                .select('default_delivery_agency_id')
                .lean()
                .exec();
            agencyId = vendor?.default_delivery_agency_id
                ? vendor.default_delivery_agency_id.toString()
                : null;
        }
        if (!agencyId) return null;

        const [agency, names] = await Promise.all([
            DeliveryAgencyModel.findById(agencyId).select('status policies').lean().exec(),
            this.magazins.findNamesByAgencyIds([agencyId]),
        ]);

        return {
            id: agencyId,
            // Null rather than '' where the Magazin has none: an agency mid-onboarding
            // legitimately has no business name yet and must still be identifiable.
            businessName: names.get(agencyId)?.name ?? null,
            status: agency?.status ?? null,
            // `warehoused` decides whether a storage quote means anything at all. A
            // product shipped from the vendor's own address has an agency (it delivers)
            // and pays it no rent.
            warehoused:
                product.type === 'physical' &&
                product.delivery?.pickup_location?.source === 'agency_storage',
            // `lean()` widens the nested sub-document through `FlattenMaps`; the shape is
            // the schema's and the calculator only reads two scalars off it.
            pricing: (agency?.policies?.pricing?.storage_based as IStorageBasedPricing | undefined) ?? null,
        };
    }

    private toVariantDto(
        variant: IProductVariant,
        reserved: number,
        shipping: { weight?: number; length?: number; width?: number; height?: number } | null,
        agency: ResolvedAgency | null,
        warehousedByVariant: Map<string, number>,
    ): AdminProductVariantDto {
        const tracked = !variant.isInfiniteStock;

        return {
            id: String(variant._id),
            name: variant.name ?? null,
            sku: variant.sku,
            status: variant.status,
            amount: variant.price,
            compareAtAmount: variant.compareAtPrice ?? null,
            inventory: {
                tracked,
                available: tracked ? variant.stock : null,
                reserved: tracked ? reserved : null,
                sellable: tracked ? Math.max(0, variant.stock - reserved) : null,
                lowStockThreshold: variant.low_stock_threshold ?? null,
                allowOversell: variant.allow_oversell ?? false,
            },
            storage:
                agency && agency.warehoused
                    ? toStorageDto(
                        quoteStorageFee(
                            agency.pricing,
                            // The AGENCY's counted shelf, not `variant.stock` (Step 14). An
                            // administrator reading this screen is being shown what an agency
                            // is owed for warehousing; quoting the catalogue number would
                            // bill for units the agency may never have received.
                            {
                                onHand: warehousedByVariant.get(String(variant._id)) ?? 0,
                                isCounted: warehousedByVariant.has(String(variant._id)),
                            },
                            resolveStorageSize(variant, shipping),
                        ),
                    )
                    : null,
        };
    }
}

interface ResolvedAgency {
    id: string;
    businessName: string | null;
    status: string | null;
    warehoused: boolean;
    pricing: IStorageBasedPricing | null;
}

function toStorageDto(quote: StorageFeeQuote): AdminProductStorageDto {
    return {
        basis: quote.basis,
        storageBasedEnabled: quote.storageBasedEnabled,
        monthlyRatePerSku: quote.monthlyRatePerSku,
        quantity: quote.quantity,
        monthlyEstimate: quote.monthlyEstimate,
        currency: DEFAULT_CURRENCY,
        size: quote.size,
    };
}

/**
 * Units of each variant currently held mid-checkout, in ONE query for the whole
 * product.
 *
 * The filter matches `StockReservationRepositoryMongo.countActiveByVariant` exactly —
 * active, unexpired, not soft-deleted — because a reserved figure that disagreed with
 * the one checkout enforces would make an operator's "why can nobody buy this" answer
 * wrong in the direction of looking fine.
 */
async function reservedUnitsByVariant(variantIds: string[]): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();

    const rows = await StockReservationModel.aggregate<{ _id: Types.ObjectId; units: number }>([
        {
            $match: {
                variantId: { $in: variantIds.map((id) => new Types.ObjectId(id)) },
                status: 'active',
                expiresAt: { $gt: new Date() },
                deletedAt: null,
            },
        },
        { $group: { _id: '$variantId', units: { $sum: '$quantity' } } },
    ]).exec();

    return new Map(rows.map((row) => [row._id.toString(), row.units]));
}

/**
 * The headline price, and the spread when variants disagree.
 *
 * The default variant's price is the headline where there is one — that is the unit the
 * storefront quotes. `range` is omitted (null) when every active variant agrees, so a
 * client can render "4 500" rather than "4 500 – 4 500".
 */
function productPricing(
    product: IProduct,
    variants: IProductVariant[],
): AdminProductDetailDto['pricing'] {
    const sellable = variants.filter((v) => v.status === 'active');
    if (sellable.length === 0) return null;

    const defaultId = product.defaultVariantId ? product.defaultVariantId.toString() : null;
    const headline = sellable.find((v) => String(v._id) === defaultId) ?? sellable[0];

    const prices = sellable.map((v) => v.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);

    return {
        amount: headline.price,
        compareAtAmount: headline.compareAtPrice ?? null,
        currency: DEFAULT_CURRENCY,
        range: min === max ? null : { min, max },
    };
}

/**
 * The product-level inventory line.
 *
 * `tracked` is false when **any** active variant is infinite-stock: a product one of
 * whose units is uncounted has no honest total, and reporting the countable subset as
 * if it were the whole would understate availability. Archived variants are excluded —
 * they cannot be sold, so counting their stock would promise units nobody can buy.
 */
function rollUpInventory(variants: AdminProductVariantDto[]): AdminProductInventoryDto {
    const sellable = variants.filter((v) => v.status === 'active');
    const tracked = sellable.length > 0 && sellable.every((v) => v.inventory.tracked);

    if (!tracked) {
        return {
            tracked: false,
            available: null,
            reserved: null,
            sellable: null,
            lowStockThreshold: null,
            allowOversell: sellable.some((v) => v.inventory.allowOversell),
        };
    }

    const available = sellable.reduce((sum, v) => sum + (v.inventory.available ?? 0), 0);
    const reserved = sellable.reduce((sum, v) => sum + (v.inventory.reserved ?? 0), 0);

    return {
        tracked: true,
        available,
        reserved,
        sellable: Math.max(0, available - reserved),
        // A product-wide threshold would be a fiction — the alert is per SKU. Null here
        // sends a reader to the variant rows, which is where it is actually set.
        lowStockThreshold: null,
        allowOversell: sellable.some((v) => v.inventory.allowOversell),
    };
}

/**
 * The product's rent, summed across the variants that are actually shelved.
 *
 * The rate is per SKU, so the product-level estimate is the sum of its variants' — not
 * the rate itself. `quantity` is likewise the sum, which is the number the estimate
 * divides by, so the two stay checkable against each other.
 */
function rollUpStorage(
    variants: AdminProductVariantDto[],
    agency: ResolvedAgency | null,
): AdminProductStorageDto | null {
    if (!agency || !agency.warehoused) return null;

    const quoted = variants.map((v) => v.storage).filter((s): s is AdminProductStorageDto => s !== null);
    if (quoted.length === 0) return null;

    return {
        basis: quoted[0].basis,
        storageBasedEnabled: quoted[0].storageBasedEnabled,
        monthlyRatePerSku: quoted[0].monthlyRatePerSku,
        quantity: quoted.reduce((sum, s) => sum + s.quantity, 0),
        monthlyEstimate: quoted.reduce((sum, s) => sum + s.monthlyEstimate, 0),
        currency: DEFAULT_CURRENCY,
        // Deliberately absent at product level: a gallery of different-sized variants has
        // no single size, and inventing one would be the multiplication this figure's
        // whole design refuses.
        size: null,
    };
}

export const adminProductDetailResolver = new AdminProductDetailResolver();
