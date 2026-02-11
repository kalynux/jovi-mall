import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, NotFoundError, ValidationError } from '../../../core/errors';
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
    static async createVariant(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id: productId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            // Validate product is physical type
            if (product.type !== 'physical') {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'INVALID_PRODUCT_TYPE',
                        message: 'Only physical products can have variants',
                    },
                });
                return;
            }

            // Validate request body
            const input = CreateVariantSchema.parse(req.body);

            // Check for SKU uniqueness
            const existingVariant = await variantRepository.findBySku(input.sku);
            if (existingVariant) {
                res.status(409).json({
                    success: false,
                    error: {
                        code: 'SKU_ALREADY_EXISTS',
                        message: `SKU "${input.sku}" is already in use`,
                    },
                });
                return;
            }

            // Generate option signature
            const optionSignature = input.optionValueIds.length > 0
                ? input.optionValueIds.sort().join('|')
                : '';

            // Create variant
            const variant = await variantRepository.create({
                productId,
                sku: input.sku,
                status: 'active',
                optionSignature,
                price: input.price,
                compareAtPrice: input.compareAtPrice,
                stock: input.stock,
                isInfiniteStock: input.isInfiniteStock,
                lowStockThreshold: null, // No alert threshold by default
                allowOversell: false, // Prevent negative stock by default
                weight: input.weight,
                length: input.length,
                width: input.width,
                height: input.height,
                optionValueIds: input.optionValueIds,
                mediaIds: [],
                deletedAt: null,
                purgeAt: null,
            });

            res.status(201).json({
                success: true,
                data: variant,
                message: 'Variant created successfully',
            });
        } catch (error) {
            VendorVariantController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/products/:id/variants
     * List all variants for a product
     */
    static async listVariants(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id: productId } = req.params;

            // Validate query parameters
            const query = VariantQuerySchema.parse(req.query);

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            // Get all variants for product
            let variants = await variantRepository.findByProduct(productId);

            // Filter by status if provided
            if (query.status) {
                variants = variants.filter(v => v.status === query.status);
            }

            // Pagination
            const total = variants.length;
            const start = (query.page - 1) * query.limit;
            const end = start + query.limit;
            const paginatedVariants = variants.slice(start, end);

            res.json({
                success: true,
                data: paginatedVariants,
                meta: {
                    total,
                    page: query.page,
                    limit: query.limit,
                    totalPages: Math.ceil(total / query.limit),
                },
            });
        } catch (error) {
            VendorVariantController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/products/:productId/variants/:variantId
     * Get a single variant
     */
    static async getVariant(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId, variantId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            // Get variant
            const variant = await variantRepository.findById(variantId);
            if (!variant || variant.productId !== productId) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Variant not found',
                    },
                });
                return;
            }

            res.json({
                success: true,
                data: variant,
            });
        } catch (error) {
            VendorVariantController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/products/:productId/variants/:variantId
     * Update a variant
     */
    static async updateVariant(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId, variantId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            // Validate request body
            const input = UpdateVariantSchema.parse(req.body);

            // Get existing variant
            const existingVariant = await variantRepository.findById(variantId);
            if (!existingVariant || existingVariant.productId !== productId) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Variant not found',
                    },
                });
                return;
            }

            // Check SKU uniqueness if changing SKU
            if (input.sku && input.sku !== existingVariant.sku) {
                const skuInUse = await variantRepository.findBySku(input.sku);
                if (skuInUse) {
                    res.status(409).json({
                        success: false,
                        error: {
                            code: 'SKU_ALREADY_EXISTS',
                            message: `SKU "${input.sku}" is already in use`,
                        },
                    });
                    return;
                }
            }

            // Update variant
            const updatedVariant = await variantRepository.update(variantId, input);

            res.json({
                success: true,
                data: updatedVariant,
                message: 'Variant updated successfully',
            });
        } catch (error) {
            VendorVariantController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/vendor/products/:productId/variants/:variantId
     * Archive a variant (soft delete)
     */
    static async archiveVariant(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId, variantId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            // Get variant
            const variant = await variantRepository.findById(variantId);
            if (!variant || variant.productId !== productId) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Variant not found',
                    },
                });
                return;
            }

            // Archive variant (set status to archived)
            await variantRepository.update(variantId, { status: 'archived' });

            res.json({
                success: true,
                message: 'Variant archived successfully',
            });
        } catch (error) {
            VendorVariantController.handleError(error, res);
        }
    }

    /**
     * Centralized error handler
     */
    private static handleError(error: any, res: Response): void {
        // Zod validation errors
        if (error instanceof ZodError) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Request validation failed',
                    details: error.errors.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                },
            });
            return;
        }

        // Application errors
        if (error instanceof AppError) {
            res.status(error.statusCode).json({
                success: false,
                error: {
                    code: error.code,
                    message: error.message,
                },
            });
            return;
        }

        // Unknown errors
        console.error('[VendorVariantController] Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred',
            },
        });
    }
}
