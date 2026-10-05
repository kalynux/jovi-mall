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
import { ProductOptionModel } from '../../catalog/models/product-option.model';
import { ProductOptionValueModel } from '../../catalog/models/product-option-value.model';
import { DigitalAssetModel } from '../../digital-delivery/models/digital-asset.model';
import { isBargainEffective } from '../../catalog/domain/services/bargain-price.rule';
import { ProductMapper } from '../../catalog/repositories/mappers/product.mapper';
import { resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import {
    PickupLocationDetail,
    PickupLocationDetailResolver,
    pickupLocationDetailResolver,
} from '../../catalog/read-models/pickup-location-detail.resolver';
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
import { categoryCatalogCache, CategoryRef } from '../../categories/services/category-catalog.cache';

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

/** Stateless — the pickup resolver takes the domain `Product`, and this holds the document. */
const productMapper = new ProductMapper();

/** One variant, as an administrator needs to see it. */
export interface AdminProductVariantDto {
    id: string;
    name: string | null;
    sku: string;
    status: 'active' | 'archived';
    amount: number;
    compareAtAmount: number | null;
    /**
     * Which option values make this variant (`Size: M`, `Colour: Red`), in the
     * product's option order. `[]` on a variant with no options — a simple-mode
     * product, a digital format, a service.
     */
    optionValues: AdminProductVariantOptionValueDto[];
    /**
     * The haggling window the vendor configured, or `null` when none is. `minPrice`
     * IS `amount` (`bargain-price.rule.ts`); `maxPrice` is the ceiling. Returned
     * even when `bargainable` is false — the vectorisation flag makes a window
     * inert, it never deletes it.
     */
    bargain: { minPrice: number; maxPrice: number } | null;
    /** `product.vectorisationEnabled && bargain != null` — whether the window is live. */
    bargainable: boolean;
    /**
     * The variant's OWN measurements, each independently `null`. The whole object is
     * `null` when the vendor set none of the four, in which case the product's
     * `shipping` defaults apply.
     */
    dimensions: AdminProductDimensionsDto | null;
    /**
     * Every file attached to this variant itself, in the vendor's order — **unfiltered**:
     * any type, and quota-blocked ones too (`access` says which). `[]` when the variant
     * carries no media of its own, which is the normal case; the customer then sees the
     * product's gallery. Not the fallback gallery — that is `media.images`.
     */
    files: FileDetail[];
    /** Digital products only; `null` otherwise. */
    digital: {
        /** `null` until the vendor uploads the file. No URL — downloads are entitlement-gated. */
        asset: { id: string; originalName: string; mimeType: string; size: number } | null;
        /** `null` = unlimited. */
        maxDownloads: number | null;
        /** `null` = never expires. */
        expiresAfterDays: number | null;
    } | null;
    /** Service products only; `null` otherwise. `amount` is the price per `durationMinutes`. */
    service: {
        durationMinutes: number;
        bufferBeforeMinutes: number;
        bufferAfterMinutes: number;
        bookingMode: string;
        maxBookings: number | null;
        peakHours: {
            daysOfWeek: number[];
            startTime: string;
            endTime: string;
            priceType: string;
            value: number;
        } | null;
    } | null;
    inventory: AdminProductInventoryDto;
    /** Null when this product is not warehoused by an agency — see `storage` below. */
    storage: AdminProductStorageDto | null;
}

export interface AdminProductVariantOptionValueDto {
    optionId: string;
    /** `null` when the option row was deleted under the value — never invented. */
    optionName: string | null;
    valueId: string;
    value: string;
}

/** Grams and centimetres, as the vendor entered them. Each is independently `null`. */
export interface AdminProductDimensionsDto {
    weightG: number | null;
    lengthCm: number | null;
    widthCm: number | null;
    heightCm: number | null;
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
    /**
     * The plain-text description — the one the storefront renders. `null` when the
     * vendor wrote none (stored as `''`). The formatted copy used for sharing is not
     * carried; it is the same words.
     */
    description: string | null;
    /** The search-engine overrides. Each `null` when unset — the storefront then uses the title / description. */
    seo: { title: string | null; description: string | null };
    /**
     * The vendor's AI-search opt-in. Bargaining is only live when `enabled` is true,
     * so this is what explains a variant with a window and `bargainable: false`.
     */
    vectorisation: { enabled: boolean; status: string };
    /** The product's options in position order, each with its values. `[]` when it has none. */
    options: {
        id: string;
        name: string;
        position: number;
        values: { id: string; value: string }[];
    }[];
    /**
     * The product-level shipping defaults (`ShippingConfig`) — the size and weight a
     * variant falls back to when it states none of its own. `null` when the vendor never
     * saved any, which is normal for a digital or service product.
     */
    shipping: {
        weightG: number | null;
        lengthCm: number | null;
        widthCm: number | null;
        heightCm: number | null;
        originZipCode: string | null;
        handlingDays: number | null;
        shippingEnabled: boolean;
    } | null;
    /**
     * Where the delivery agency collects this product — the vendor's own address, or the
     * agency's depot (`agency_storage`, i.e. the agency HOSTS the stock). The address is
     * resolved; `null` on a digital/service product or a physical one not configured yet.
     * Under `agency_storage` the depot belongs to `deliveryAgency`.
     */
    pickup: PickupLocationDetail | null;
    /** Digital products only: the product-wide download switch. `null` otherwise. */
    digital: { isActive: boolean } | null;
    /** The product's categories, resolved, in the vendor's order. */
    categories: CategoryRef[];
    /** ⚠ DEPRECATED — `categories[0].name`, or null. */
    category: string | null;
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
        /**
         * The gallery a customer sees for the DEFAULT variant: thumbnail first, `image/*`
         * only, variant media first and the product's as the fallback. Empty when the
         * listing carries no picture. Other variants' pictures are on `variants[].files`.
         */
        images: FileDetail[];
        primaryImage: FileDetail | null;
        /**
         * Every file attached to the product itself, in the vendor's order —
         * **unfiltered** (any type, quota-blocked included). Together with
         * `variants[].files` this is all the media the listing holds.
         */
        files: FileDetail[];
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
        // The vendor editor's own resolver, so the admin sees the address the vendor
        // picked exactly as the vendor sees it — including the primary-depot fallback.
        private readonly pickups: PickupLocationDetailResolver = pickupLocationDetailResolver,
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

        const [images, reservedByVariant, shipping, agency, warehousedByVariant, options, filesById, assetsById, pickup] =
            await Promise.all([
                this.resolveImages(product, variants),
                reservedUnitsByVariant(variants.map((v) => String(v._id))),
                ShippingConfigModel.findOne({ productId: product._id, deletedAt: null }).lean().exec(),
                this.resolveAgency(product),
                // Step 14: the storage quote bills the agency's COUNTED shelf, so the depot rows
                // have to be read here. Batched by variant so a product with twenty variants is
                // one query rather than twenty.
                new AgencyStockLevelRepository().warehousedByVariant(variants.map((v) => String(v._id))),
                resolveOptions(product._id),
                // Every file on the product and on every variant, in ONE lookup — the raw
                // attachments, unfiltered, beside the customer-facing gallery above.
                resolveFileDetails(
                    [
                        ...(product.fileIds ?? []).map(String),
                        ...variants.flatMap((v) => (v.fileIds ?? []).map(String)),
                    ],
                    this.files,
                    getStorageProvider(),
                ),
                digitalAssetsById(variants),
                // Never throws — an unresolvable depot is `address: null`, not a failed read.
                this.pickups.resolve(productMapper.toDomain(product)),
            ]);

        const valueById = new Map(
            options.flatMap((option) =>
                option.values.map((value) => [value.id, { option, value }] as const),
            ),
        );

        const variantDtos = variants.map((variant) =>
            this.toVariantDto(
            variant,
            reservedByVariant.get(String(variant._id)) ?? 0,
            shipping,
            agency,
            warehousedByVariant,
            {
                vectorisationEnabled: product.vectorisationEnabled === true,
                valueById,
                filesById,
                assetsById,
            },
        ),
        );

        const categories = await categoryCatalogCache.refsFor(product.categoryIds);
        const filesOf = (ids: Types.ObjectId[] | undefined): FileDetail[] =>
            (ids ?? []).map((id) => filesById.get(String(id))).filter((f): f is FileDetail => !!f);

        return {
            id: String(product._id),
            vendorId: product.vendorId.toString(),
            title: product.title,
            slug: product.slug,
            description: blankToNull(product.description),
            seo: {
                title: blankToNull(product.seo?.title),
                description: blankToNull(product.seo?.description),
            },
            vectorisation: {
                enabled: product.vectorisationEnabled === true,
                status: product.vectorisationStatus ?? 'not_started',
            },
            options: options.map(({ id, name, position, values }) => ({ id, name, position, values })),
            shipping: shipping
                ? {
                    weightG: shipping.weight ?? null,
                    lengthCm: shipping.length ?? null,
                    widthCm: shipping.width ?? null,
                    heightCm: shipping.height ?? null,
                    originZipCode: blankToNull(shipping.originZipCode),
                    handlingDays: shipping.handlingDays ?? null,
                    shippingEnabled: shipping.shippingEnabled ?? true,
                }
                : null,
            pickup,
            digital: product.type === 'digital'
                ? { isActive: product.digitalConfig?.isActive ?? true }
                : null,
            categories,
            category: categories[0]?.name ?? null,
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
                files: filesOf(product.fileIds),
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
        lookups: VariantLookups,
    ): AdminProductVariantDto {
        const tracked = !variant.isInfiniteStock;
        const bargain = variant.bargain
            ? { minPrice: variant.bargain.minPrice, maxPrice: variant.bargain.maxPrice }
            : null;
        const service = variant.serviceConfig;
        const digital = variant.digitalConfig;

        return {
            id: String(variant._id),
            name: variant.name ?? null,
            sku: variant.sku,
            status: variant.status,
            amount: variant.price,
            compareAtAmount: variant.compareAtPrice ?? null,
            // Ordered by the OPTION's position, not by the array's — the array is
            // whatever order the last write happened to send.
            optionValues: (variant.optionValueIds ?? [])
                .map((id) => lookups.valueById.get(String(id)))
                .filter((hit): hit is NonNullable<typeof hit> => !!hit)
                .sort((a, b) => a.option.position - b.option.position)
                .map(({ option, value }) => ({
                    optionId: option.id,
                    optionName: option.name,
                    valueId: value.id,
                    value: value.value,
                })),
            bargain,
            bargainable: isBargainEffective(lookups.vectorisationEnabled, bargain),
            dimensions:
                variant.weight != null || variant.length != null || variant.width != null || variant.height != null
                    ? {
                        weightG: variant.weight ?? null,
                        lengthCm: variant.length ?? null,
                        widthCm: variant.width ?? null,
                        heightCm: variant.height ?? null,
                    }
                    : null,
            files: (variant.fileIds ?? [])
                .map((id) => lookups.filesById.get(String(id)))
                .filter((f): f is FileDetail => !!f),
            digital: digital
                ? {
                    asset: digital.assetId ? lookups.assetsById.get(String(digital.assetId)) ?? null : null,
                    maxDownloads: digital.maxDownloads ?? null,
                    expiresAfterDays: digital.expiresAfterDays ?? null,
                }
                : null,
            service: service
                ? {
                    durationMinutes: service.durationMinutes,
                    bufferBeforeMinutes: service.bufferBeforeMinutes ?? 0,
                    bufferAfterMinutes: service.bufferAfterMinutes ?? 0,
                    bookingMode: service.bookingMode,
                    maxBookings: service.maxBookings ?? null,
                    peakHours: service.peakHours
                        ? {
                            daysOfWeek: [...(service.peakHours.daysOfWeek ?? [])],
                            startTime: service.peakHours.startTime,
                            endTime: service.peakHours.endTime,
                            priceType: service.peakHours.priceType,
                            value: service.peakHours.value,
                        }
                        : null,
                }
                : null,
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

/** What `toVariantDto` reads beyond the variant itself — each built once per product. */
interface VariantLookups {
    vectorisationEnabled: boolean;
    valueById: Map<string, { option: ResolvedOption; value: { id: string; value: string } }>;
    filesById: Map<string, FileDetail>;
    assetsById: Map<string, NonNullable<AdminProductVariantDto['digital']>['asset']>;
}

interface ResolvedOption {
    id: string;
    name: string;
    position: number;
    values: { id: string; value: string }[];
}

/** `''` and whitespace are "not written" — the wire says `null` for absent data, never `""`. */
function blankToNull(value: string | null | undefined): string | null {
    return value != null && value.trim() !== '' ? value : null;
}

/** The product's options with their values — two queries whatever the option count. */
async function resolveOptions(productId: Types.ObjectId): Promise<ResolvedOption[]> {
    const options = await ProductOptionModel.find({ productId, deletedAt: null })
        .sort({ position: 1 })
        .lean()
        .exec();
    if (options.length === 0) return [];

    const values = await ProductOptionValueModel.find({
        optionId: { $in: options.map((o) => o._id) },
        deletedAt: null,
    })
        .sort({ createdAt: 1 })
        .lean()
        .exec();

    return options.map((option) => ({
        id: String(option._id),
        name: option.name,
        position: option.position,
        values: values
            .filter((v) => String(v.optionId) === String(option._id))
            .map((v) => ({ id: String(v._id), value: v.value })),
    }));
}

/** The uploaded file behind each digital variant, in one query. No URL, ever. */
async function digitalAssetsById(variants: IProductVariant[]): Promise<VariantLookups['assetsById']> {
    const ids = variants
        .map((v) => v.digitalConfig?.assetId)
        .filter((id): id is Types.ObjectId => !!id);
    if (ids.length === 0) return new Map();

    const docs = await DigitalAssetModel.find({ _id: { $in: ids }, deletedAt: null }).lean().exec();
    return new Map(
        docs.map((doc) => [
            String(doc._id),
            { id: String(doc._id), originalName: doc.originalName, mimeType: doc.mimeType, size: doc.size },
        ]),
    );
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
