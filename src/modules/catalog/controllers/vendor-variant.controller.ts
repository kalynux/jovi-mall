import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
import {
    CreateVariantSchema,
    UpdateVariantSchema,
    VariantQuerySchema,
} from '../validators/variant.validator';

const productRepository = new ProductRepositoryMongo();
const variantRepository = new VariantRepositoryMongo();

/**
 * VendorVariantController
 * 
 * HTTP layer for vendor variant management.
 * Vendors can create, read, update, and archive variants for their products.
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

        if (product.type !== 'physical')
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Only physical products can have variants');

        const input = CreateVariantSchema.parse(req.body);

        if (input.deliveryAgencyId !== undefined && product.type !== 'physical')
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Delivery agency can only be set for physical products');

        const existingVariant = await variantRepository.findBySku(input.sku);
        if (existingVariant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS, 409, undefined, { sku: input.sku });

        const optionSignature = input.optionValueIds.length > 0
            ? input.optionValueIds.sort().join('|')
            : '';

        const variant = await variantRepository.create({
            productId,
            sku: input.sku,
            status: 'active',
            optionSignature,
            price: input.price,
            compareAtPrice: input.compareAtPrice,
            stock: input.stock,
            isInfiniteStock: input.isInfiniteStock,
            lowStockThreshold: null,
            allowOversell: false,
            weight: input.weight,
            length: input.length,
            width: input.width,
            height: input.height,
            optionValueIds: input.optionValueIds,
            fileIds: [],
            deliveryAgencyId: input.deliveryAgencyId,
            deletedAt: null,
            purgeAt: null,
        });

        res.status(201).json({ success: true, data: variant, message: 'Variant created successfully' });
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

        res.json({ success: true, data: paginatedVariants, meta: { total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) } });
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

        res.json({ success: true, data: variant });
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

        if (input.deliveryAgencyId !== undefined && product.type !== 'physical')
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Delivery agency can only be set for physical products');

        const existingVariant = await variantRepository.findById(variantId);
        if (!existingVariant || existingVariant.productId !== productId)
            throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);

        if (input.sku && input.sku !== existingVariant.sku) {
            const skuInUse = await variantRepository.findBySku(input.sku);
            if (skuInUse) throw createAppError(ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS, 409, undefined, { sku: input.sku });
        }

        const updatedVariant = await variantRepository.update(variantId, input);
        res.json({ success: true, data: updatedVariant, message: 'Variant updated successfully' });
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
        res.json({ success: true, message: 'Variant archived successfully' });
    });
}
