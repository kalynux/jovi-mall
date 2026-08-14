import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
import { FileRepositoryMongo } from '../repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../repositories/mongo/file-reference.repository.mongo';
import { getStorageProvider } from '../../../core/storage';
import { enrichVariant, enrichVariants } from '../read-models/enrich-product-detail';
import { resolveBargainWrite } from '../domain/services/bargain-price.rule';
import { ProductStatusValidationService } from '../domain/services/ProductStatusValidationService';
import { FileReferenceService } from '../domain/services/media/FileReferenceService';
import { assertVariantImageLimit } from '../domain/services/media/image-limits';
import { assertNotSimpleMode } from '../domain/services/simple/mode-guard';
import { DEFAULT_VARIANT_SIGNATURE } from '../domain/services/variants/constants';
import { Variant } from '../repositories/mappers/variant.mapper';
// Concrete file, not the module barrel: stock-requests imports catalog repositories.
import { stockChangeGate } from '../../stock-requests/services/stock-change-gate';
import {
    ChangeVariantStatusSchema,
    CreateVariantSchema,
    UpdateVariantSchema,
    UpdateVariantServiceConfigSchema,
    VariantQuerySchema,
} from '../validators/variant.validator';

const productRepository = new ProductRepositoryMongo();
const variantRepository = new VariantRepositoryMongo();
const fileRepository = new FileRepositoryMongo();
const fileReferenceRepository = new FileReferenceRepositoryMongo();
const storageProvider = getStorageProvider();
const productStatusValidationService = new ProductStatusValidationService(productRepository, variantRepository);
const fileReferenceService = new FileReferenceService(fileRepository, fileReferenceRepository);

/**
 * VendorVariantController
 *
 * HTTP layer for vendor variant management.
 * Vendors can create, read, update, and archive variants for their products.
 *
 * Supported product types for variants:
 *   - physical: Full variant support (options, dimensions, delivery agency)
 *   - digital:  Pricing variants only (no options, no dimensions, no delivery agency)
 *   - service:  Not supported here — service pricing is managed via booking config
 */
export class VendorVariantController {
    /**
     * POST /api/vendor/products/:id/variants
     * Create a new variant for a product
     */
    static createVariant = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        // A simple product's one variant is created by POST /products/simple, so
        // anything reaching here is a second variant by definition.
        assertNotSimpleMode(product, 'adding another variant');

        const input = CreateVariantSchema.parse(req.body);

        // Cap variant images per parent product type (physical 3 / digital 1).
        if (input.fileIds) assertVariantImageLimit(product.type, input.fileIds.length);

        // serviceConfig is only valid on service products.
        if (product.type !== 'service' && input.serviceConfig)
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'serviceConfig only applies to service products',
            );

        // Service products: pricing + scheduling live on a single mandatory variant.
        // It carries serviceConfig, must be the lone 'default' variant, and cannot have
        // options, dimensions, a delivery agency, or digitalConfig.
        if (product.type === 'service') {
            if (!input.serviceConfig)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'Service products require serviceConfig on their variant',
                );
            if (input.optionValueIds && input.optionValueIds.length > 0)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'Service products cannot have option-based variants',
                );
            if (input.deliveryAgencyId)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'Delivery agency only applies to physical products',
                );
            if (input.weight || input.length || input.width || input.height)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'Dimensions (weight, length, width, height) only apply to physical products',
                );
            if (input.digitalConfig)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'digitalConfig only applies to digital products',
                );

            // Exactly one variant per service product.
            const existingForProduct = await variantRepository.findByProduct(productId);
            if (existingForProduct.length > 0)
                throw createAppError(ERROR_CODES.CATALOG_SERVICE_VARIANT_EXISTS, 409);
        }

        // Digital product restrictions — only pricing variants, no physical attributes
        if (product.type === 'digital') {
            if (input.optionValueIds && input.optionValueIds.length > 0)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'Digital products cannot have option-based variants'
                );
            if (input.deliveryAgencyId)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'Delivery agency only applies to physical products'
                );
            if (input.weight || input.length || input.width || input.height)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'Dimensions (weight, length, width, height) only apply to physical products'
                );

            // Cap: a digital product may have at most 5 variants (active or pending-asset).
            // We count all non-deleted variants (active + archived-without-asset) since a
            // vendor can re-upload to revive an asset-less archived variant.
            const existingForProduct = await variantRepository.findByProduct(productId);
            if (existingForProduct.length >= 5) {
                throw createAppError(
                    ERROR_CODES.CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED,
                    400,
                );
            }
        } else if (input.digitalConfig) {
            // digitalConfig only applies to digital products
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'digitalConfig only applies to digital products',
            );
        }

        // Bargainable pricing. Resolved here rather than inline so create and update
        // share one definition of the `minPrice === price` invariant; it also refuses
        // a window on a service product, alongside the per-type bans above.
        const bargain = resolveBargainWrite({
            mode: 'create',
            productType: product.type,
            price: input.price,
            bargain: input.bargain,
            variantLabel: input.name || input.sku,
        });

        const existingVariant = await variantRepository.findBySku(input.sku);
        if (existingVariant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS, 409, undefined, { sku: input.sku });

        // Option-based variants get a deterministic signature from their option values.
        // Service products have exactly one variant, so it takes the canonical 'default'
        // signature that BookingPriceResolver looks up. Option-less variants (digital, plus
        // physical products without options) fall back to the SKU: it's required and globally
        // unique, so it satisfies both the schema's `required` constraint and the unique
        // { productId, optionSignature } index — the latter being why a constant like '' or
        // 'default' can't be used when a product is allowed multiple option-less variants.
        const optionSignature = product.type === 'service'
            ? DEFAULT_VARIANT_SIGNATURE
            : input.optionValueIds && input.optionValueIds.length > 0
                ? input.optionValueIds.sort().join('|')
                : input.sku;

        // Digital variants start as 'archived' — they cannot be active until an asset is
        // uploaded (which transitions them to 'active' via VariantDigitalService).
        const initialStatus: 'active' | 'archived' = product.type === 'digital' ? 'archived' : 'active';

        let variant = await variantRepository.create({
            productId,
            sku: input.sku,
            name: input.name,
            status: initialStatus,
            optionSignature,
            price: input.price,
            compareAtPrice: input.compareAtPrice,
            // `resolveBargainWrite` returns undefined (no window) or a complete pair;
            // `null` is an update-only signal and cannot reach here.
            bargain: bargain ?? undefined,
            stock: input.stock,
            isInfiniteStock: input.isInfiniteStock,
            lowStockThreshold: null,
            allowOversell: false,
            weight: product.type === 'physical' ? input.weight : undefined,
            length: product.type === 'physical' ? input.length : undefined,
            width: product.type === 'physical' ? input.width : undefined,
            height: product.type === 'physical' ? input.height : undefined,
            optionValueIds: input.optionValueIds ?? [],
            // Media is attached after the variant exists, but only once the files are
            // authorized — never persist an unauthorized reference (mirrors product create).
            fileIds: [],
            deliveryAgencyId: product.type === 'physical' ? input.deliveryAgencyId : undefined,
            digitalConfig: product.type === 'digital' && input.digitalConfig
                ? {
                    maxDownloads: input.digitalConfig.maxDownloads ?? null,
                    expiresAfterDays: input.digitalConfig.expiresAfterDays ?? null,
                }
                : undefined,
            serviceConfig: product.type === 'service' && input.serviceConfig
                ? {
                    durationMinutes: input.serviceConfig.durationMinutes,
                    bufferBeforeMinutes: input.serviceConfig.bufferBeforeMinutes,
                    bufferAfterMinutes: input.serviceConfig.bufferAfterMinutes,
                    bookingMode: input.serviceConfig.bookingMode,
                    maxBookings: input.serviceConfig.maxBookings,
                    peakHours: input.serviceConfig.peakHours,
                }
                : undefined,
            deletedAt: null,
            purgeAt: null,
        });

        // Attach media: authorize + register references (throws on unauthorized files
        // before they are persisted), then write the fileIds onto the variant.
        if (input.fileIds && input.fileIds.length > 0) {
            await fileReferenceService.reconcile({
                previousFileIds: [],
                nextFileIds: input.fileIds,
                actor: { type: 'vendor', id: vendorId },
                entityType: 'variant',
                entityId: variant.id,
            });
            variant = (await variantRepository.update(variant.id, { fileIds: input.fileIds })) ?? variant;
        }

        // Auto-set defaultVariantId on the product when this is the first variant.
        // For digital, defaultVariantId can still point to an asset-less archived variant —
        // ProductStatusValidationService will block activation until it has an asset.
        if (!product.hasVariants || !product.defaultVariantId) {
            await productRepository.update(productId, vendorId, {
                hasVariants: true,
                defaultVariantId: variant.id,
            });
        }

        const detail = await enrichVariant(variant, fileRepository, storageProvider, product);
        res.status(201).json({ success: true, data: detail, message: 'Variant created successfully' });
    });

    /**
     * GET /api/vendor/products/:id/variants
     * List all variants for a product
     */
    static listVariants = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;
        const query = VariantQuerySchema.parse(req.query);

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        let variants = await variantRepository.findByProduct(productId);
        if (query.status) variants = variants.filter(v => v.status === query.status);

        const total = variants.length;
        const start = (query.page - 1) * query.limit;
        const paginatedVariants = variants.slice(start, start + query.limit);

        const enrichedVariants = await enrichVariants(paginatedVariants, fileRepository, storageProvider, product);

        res.json({
            success: true,
            data: enrichedVariants,
            meta: { total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) },
        });
    });

    /**
     * GET /api/vendor/products/:productId/variants/:variantId
     * Get a single variant
     */
    static getVariant = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, variantId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        const variant = await variantRepository.findById(variantId);
        if (!variant || variant.productId !== productId) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

        const detail = await enrichVariant(variant, fileRepository, storageProvider, product);
        res.json({ success: true, data: detail });
    });

    /**
     * PATCH /api/vendor/products/:productId/variants/:variantId
     * Update a variant
     */
    static updateVariant = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, variantId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        const input = UpdateVariantSchema.parse(req.body);

        // serviceConfig is only valid on service products; digitalConfig only on digital.
        if (product.type !== 'service' && input.serviceConfig)
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'serviceConfig only applies to service products',
            );

        // Block physical-only fields for digital/service products
        if (product.type === 'digital' || product.type === 'service') {
            if (input.deliveryAgencyId)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'Delivery agency only applies to physical products'
                );
            if (input.weight !== undefined || input.length !== undefined || input.width !== undefined || input.height !== undefined)
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                    400,
                    'Dimensions only apply to physical products'
                );
        }
        if (product.type !== 'digital' && input.digitalConfig) {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'digitalConfig only applies to digital products',
            );
        }

        const existingVariant = await variantRepository.findById(variantId);
        if (!existingVariant || existingVariant.productId !== productId)
            throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

        // Bargainable pricing, resolved BEFORE any side effect below. A 422 raised
        // after `stockChangeGate.intercept` would leave an approval request sitting
        // in an agency's queue for a PATCH that failed, and one after
        // `fileReferenceService.reconcile` would leave orphaned file references.
        // `test:bargain-price` asserts this ordering by source scan.
        //
        // Three cases: undefined = leave the field alone, null = clear it, an object
        // = a complete pair (including the auto-sync when only `price` moved).
        const nextBargain = resolveBargainWrite({
            mode: 'update',
            productType: product.type,
            current: { price: existingVariant.price, bargain: existingVariant.bargain },
            price: input.price,
            bargain: input.bargain,
            variantLabel: input.name || existingVariant.name || existingVariant.sku,
        });

        if (input.sku && input.sku !== existingVariant.sku) {
            const skuInUse = await variantRepository.findBySku(input.sku);
            if (skuInUse) throw createAppError(ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS, 409, undefined, { sku: input.sku });
        }

        // Keep file references in sync with the replaced variant media array, and
        // reject unauthorized file references before they are persisted.
        if (input.fileIds !== undefined) {
            // Cap variant images per parent product type (physical 3 / digital 1).
            assertVariantImageLimit(product.type, input.fileIds.length);
            await fileReferenceService.reconcile({
                previousFileIds: existingVariant.fileIds ?? [],
                nextFileIds: input.fileIds,
                actor: { type: 'vendor', id: vendorId },
                entityType: 'variant',
                entityId: variantId,
            });
        }

        // ── The stock gate ────────────────────────────────────────────────────
        // On a SKU an agency warehouses, `stock` / `isInfiniteStock` are not the
        // vendor's to set alone: the change becomes a request the agency must
        // approve. The two fields are stripped from THIS write and everything else
        // in the PATCH applies as normal, so a vendor editing a price and a quantity
        // in one call gets the price immediately and the quantity queued.
        //
        // Intercepting here rather than adding a separate "propose" endpoint is the
        // point: leave this path writing directly and the rule is advisory.
        const stockIntent = await stockChangeGate.intercept({
            productId,
            variantId,
            vendorId,
            userId: req.auth!.user._id.toString(),
            quantity: input.stock,
            isInfiniteStock: input.isInfiniteStock,
        });

        // Build the persistence payload. serviceConfig is merged over the existing config so
        // a partial PATCH doesn't drop untouched fields (the repository $set replaces the whole
        // sub-document). A null peakHours clears the surcharge.
        //
        // `bargain` is destructured OUT deliberately: the raw input may be a partial
        // `{ maxPrice }` with no minPrice, and the repository $sets this field whole,
        // so letting it through the spread would wipe the stored minPrice. Only the
        // rule's complete pair is written, below.
        const { serviceConfig: scInput, bargain: _rawBargain, ...restInput } = input;
        const updates: Partial<Variant> = { ...restInput };
        if (nextBargain !== undefined) updates.bargain = nextBargain;
        if (stockIntent) {
            delete updates.stock;
            delete updates.isInfiniteStock;
        }
        if (scInput) {
            const existing = existingVariant.serviceConfig;
            updates.serviceConfig = {
                durationMinutes: scInput.durationMinutes ?? existing?.durationMinutes ?? 0,
                bufferBeforeMinutes: scInput.bufferBeforeMinutes ?? existing?.bufferBeforeMinutes ?? 0,
                bufferAfterMinutes: scInput.bufferAfterMinutes ?? existing?.bufferAfterMinutes ?? 0,
                bookingMode: scInput.bookingMode ?? existing?.bookingMode ?? 'calendar',
                maxBookings: scInput.maxBookings ?? existing?.maxBookings,
                peakHours: scInput.peakHours === null
                    ? undefined
                    : (scInput.peakHours ?? existing?.peakHours),
            };
        }

        const updatedVariant = await variantRepository.update(variantId, updates);
        if (!updatedVariant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

        // Variant fields like price feed into the product's active-state gate
        // (e.g. ProductStatusValidationService rejects active variants with
        // price <= 0). Re-check and demote the product to draft if it slipped.
        await productStatusValidationService.revalidateActiveStatus(productId, vendorId);

        const detail = await enrichVariant(updatedVariant, fileRepository, storageProvider, product);
        // One status code — 200 — whether or not the stock change was queued. A 202
        // here would make a client branch on the code for a response whose body it
        // has to read either way; `data.stock` still shows the UNCHANGED quantity and
        // `meta.stockAdjustment` says what is pending on it.
        res.json({
            success: true,
            data: detail,
            ...(stockIntent
                ? { meta: { stockAdjustment: { status: 'pending_agency_approval', request: stockIntent } } }
                : {}),
            message: stockIntent
                ? 'Variant updated. The stock change is awaiting the storage agency’s approval.'
                : 'Variant updated successfully',
        });
    });

    /**
     * PATCH /api/vendor/products/:productId/variants/:variantId/status
     * Toggle a variant between `active` and `archived`.
     *
     * Vendor use-case: temporarily deactivate a variant during a stock shortage,
     * then re-activate it once restocked — without having to re-create the variant.
     *
     * Activation gate is enforced by ProductStatusValidationService.validateVariantActivation
     * (price > 0, digital variants require an uploaded asset, service variants require a
     * serviceConfig duration).
     *
     * Archiving is always allowed; same default-variant reassignment / product
     * demotion side-effects as DELETE.
     */
    static changeStatus = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, variantId } = req.params;
        const { status } = ChangeVariantStatusSchema.parse(req.body);

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        const variant = await variantRepository.findById(variantId);
        if (!variant || variant.productId !== productId)
            throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

        // Enriched, like every other variant response. Returning the raw domain
        // object here would ship `bargain` without `bargainable` — worse than
        // shipping neither, since a client could read a window and assume it is live.
        if (variant.status === status) {
            const unchanged = await enrichVariant(variant, fileRepository, storageProvider, product);
            res.json({ success: true, data: unchanged, message: `Variant is already ${status}` });
            return;
        }

        // Archiving the lone variant of a simple product would clear
        // defaultVariantId and hasVariants below, breaking the invariant and
        // leaving PATCH /:id/simple permanently unusable. Re-activating is
        // harmless, so this gates on the target status, not the operation.
        if (status === 'archived') {
            assertNotSimpleMode(product, 'archiving its only variant');
        }

        if (status === 'active') {
            await productStatusValidationService.validateVariantActivation(product, variant);
        }

        const updatedVariant = await variantRepository.update(variantId, { status });

        if (status === 'archived' && product.defaultVariantId === variantId) {
            const remaining = await variantRepository.findByProduct(productId);
            const nextActive = remaining.find(v => v.status === 'active' && v.id !== variantId);
            const activeCount = remaining.filter(v => v.status === 'active' && v.id !== variantId).length;
            await productRepository.update(productId, vendorId, {
                defaultVariantId: nextActive?.id,
                hasVariants: activeCount > 0,
            });
        }

        // Re-evaluate product status: archiving may leave it without a valid default
        // variant; re-activating one doesn't break invariants but is cheap to check.
        await productStatusValidationService.revalidateActiveStatus(productId, vendorId);

        const detail = updatedVariant
            ? await enrichVariant(updatedVariant, fileRepository, storageProvider, product)
            : null;
        res.json({ success: true, data: detail, message: `Variant status changed to ${status}` });
    });

    /**
     * DELETE /api/vendor/products/:productId/variants/:variantId
     * Archive a variant (soft delete)
     */
    static archiveVariant = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, variantId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        // Same reasoning as changeStatus: this is the lone variant, and archiving
        // it would leave a simple product that can never be edited or published
        // again. Archive the product itself instead.
        assertNotSimpleMode(product, 'archiving its only variant');

        const variant = await variantRepository.findById(variantId);
        if (!variant || variant.productId !== productId) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

        await variantRepository.update(variantId, { status: 'archived' });

        // If the archived variant was the default, reassign to another active variant
        if (product.defaultVariantId === variantId) {
            const remaining = await variantRepository.findByProduct(productId);
            const nextActive = remaining.find(v => v.status === 'active' && v.id !== variantId);
            const activeCount = remaining.filter(v => v.status === 'active' && v.id !== variantId).length;
            await productRepository.update(productId, vendorId, {
                defaultVariantId: nextActive?.id,
                hasVariants: activeCount > 0,
            });
        }

        // Archiving a variant may leave the product without a valid default
        // variant (or any active variants at all) — demote to draft if so.
        await productStatusValidationService.revalidateActiveStatus(productId, vendorId);

        res.json({ success: true, message: 'Variant archived successfully' });
    });

    /**
     * PATCH /api/vendor/products/:productId/variants/:variantId/service/config
     * Update the service variant's scheduling + peak-hours config (not the price —
     * use the variant update endpoint for that). Partial: omitted fields are kept;
     * a null `peakHours` clears the surcharge.
     */
    static updateServiceConfig = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, variantId } = req.params;
        const input = UpdateVariantServiceConfigSchema.parse(req.body);

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.type !== 'service')
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'serviceConfig only applies to service products',
            );

        const existingVariant = await variantRepository.findById(variantId);
        if (!existingVariant || existingVariant.productId !== productId)
            throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

        // Merge over the existing config so the repository's whole-object $set keeps
        // untouched fields. A null peakHours clears the surcharge.
        const existing = existingVariant.serviceConfig;
        const merged: Variant['serviceConfig'] = {
            durationMinutes: input.durationMinutes ?? existing?.durationMinutes ?? 0,
            bufferBeforeMinutes: input.bufferBeforeMinutes ?? existing?.bufferBeforeMinutes ?? 0,
            bufferAfterMinutes: input.bufferAfterMinutes ?? existing?.bufferAfterMinutes ?? 0,
            bookingMode: input.bookingMode ?? existing?.bookingMode ?? 'calendar',
            maxBookings: input.maxBookings ?? existing?.maxBookings,
            peakHours: input.peakHours === null
                ? undefined
                : (input.peakHours ?? existing?.peakHours),
        };

        const updated = await variantRepository.update(variantId, { serviceConfig: merged });
        if (!updated) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

        const detail = await enrichVariant(updated, fileRepository, storageProvider, product);
        res.json({ success: true, data: detail, message: 'Service config updated' });
    });
}
