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
import { ProductStatusValidationService } from '../domain/services/ProductStatusValidationService';
import { FileReferenceService } from '../domain/services/media/FileReferenceService';
import { assertVariantImageLimit } from '../domain/services/media/image-limits';
import {
    ChangeVariantStatusSchema,
    CreateVariantSchema,
    UpdateVariantSchema,
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

        // Service products manage pricing through booking configuration, not variants
        if (product.type === 'service')
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'Service products manage pricing through booking configuration, not variants'
            );

        const input = CreateVariantSchema.parse(req.body);

        // Cap variant images per parent product type (physical 3 / digital 1).
        if (input.fileIds) assertVariantImageLimit(product.type, input.fileIds.length);

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

        const existingVariant = await variantRepository.findBySku(input.sku);
        if (existingVariant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS, 409, undefined, { sku: input.sku });

        // Option-based variants get a deterministic signature from their option values.
        // Option-less variants (all digital variants, plus physical products without options)
        // fall back to the SKU: it's required and globally unique, so it satisfies both the
        // schema's `required` constraint and the unique { productId, optionSignature } index —
        // the latter being why a constant like '' or 'default' can't be used when a product
        // is allowed multiple option-less variants (digital products permit up to 5).
        const optionSignature = input.optionValueIds && input.optionValueIds.length > 0
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
            deletedAt: null,
            purgeAt: null,
        });

        // Attach media: authorize + register references (throws on unauthorized files
        // before they are persisted), then write the fileIds onto the variant.
        if (input.fileIds && input.fileIds.length > 0) {
            await fileReferenceService.reconcile({
                previousFileIds: [],
                nextFileIds: input.fileIds,
                vendorId,
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

        const detail = await enrichVariant(variant, fileRepository, storageProvider, product.title);
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

        const enrichedVariants = await enrichVariants(paginatedVariants, fileRepository, storageProvider, product.title);

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

        const detail = await enrichVariant(variant, fileRepository, storageProvider, product.title);
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

        // Block physical-only fields for digital products
        if (product.type === 'digital') {
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
        } else if (input.digitalConfig) {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'digitalConfig only applies to digital products',
            );
        }

        const existingVariant = await variantRepository.findById(variantId);
        if (!existingVariant || existingVariant.productId !== productId)
            throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

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
                vendorId,
                entityType: 'variant',
                entityId: variantId,
            });
        }

        const updatedVariant = await variantRepository.update(variantId, input);
        if (!updatedVariant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

        // Variant fields like price feed into the product's active-state gate
        // (e.g. ProductStatusValidationService rejects active variants with
        // price <= 0). Re-check and demote the product to draft if it slipped.
        await productStatusValidationService.revalidateActiveStatus(productId, vendorId);

        const detail = await enrichVariant(updatedVariant, fileRepository, storageProvider, product.title);
        res.json({ success: true, data: detail, message: 'Variant updated successfully' });
    });

    /**
     * PATCH /api/vendor/products/:productId/variants/:variantId/status
     * Toggle a variant between `active` and `archived`.
     *
     * Vendor use-case: temporarily deactivate a variant during a stock shortage,
     * then re-activate it once restocked — without having to re-create the variant.
     *
     * Activation gate is enforced by ProductStatusValidationService.validateVariantActivation
     * (price > 0, digital variants require an uploaded asset, no variants on service products).
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

        if (variant.status === status) {
            res.json({ success: true, data: variant, message: `Variant is already ${status}` });
            return;
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

        res.json({ success: true, data: updatedVariant, message: `Variant status changed to ${status}` });
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
}
