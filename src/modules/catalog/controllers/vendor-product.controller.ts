import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, NotFoundError, ForbiddenError } from '../../../core/errors';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { ProductDraftService } from '../domain/services/ProductDraftService';
import { ProductUpdateService } from '../domain/services/ProductUpdateService';
import { ProductArchiveService } from '../domain/services/ProductArchiveService';
import { ProductListService } from '../domain/services/ProductListService';
import { ProductDuplicateService } from '../domain/services/ProductDuplicateService';
import { ProductStatusValidationService } from '../domain/services/ProductStatusValidationService';
import { ProductBulkOperationsService } from '../domain/services/ProductBulkOperationsService';
import { SlugService } from '../domain/services/SlugService';
import {
    CreateProductSchema,
    UpdateProductSchema,
    ChangeProductStatusSchema,
    ProductQuerySchema,
    BulkArchiveSchema,
    BulkStatusChangeSchema,
} from '../validators/product.validator';

// Initialize services
const productRepository = new ProductRepositoryMongo();
const slugService = new SlugService(productRepository);
const productDraftService = new ProductDraftService(productRepository, slugService);
const productUpdateService = new ProductUpdateService(productRepository, slugService);
const productArchiveService = new ProductArchiveService(productRepository);
const productListService = new ProductListService(productRepository);
const productDuplicateService = new ProductDuplicateService(productRepository, slugService);
const productStatusValidationService = new ProductStatusValidationService();
const productBulkOperationsService = new ProductBulkOperationsService(
    productRepository,
    productStatusValidationService
);

/**
 * VendorProductController
 * 
 * HTTP layer for vendor product management.
 * All routes enforce vendor ownership via req.auth.role_entity._id
 */
export class VendorProductController {
    /**
     * GET /api/vendor/products/:id
     * Get single product
     */
    static async getProduct(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id } = req.params;

            const product = await productRepository.findById(id, vendorId);

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

            res.json({
                success: true,
                data: product,
            });
        } catch (error) {
            VendorProductController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/products
     * List products with filters, search, and sorting
     */
    static async listProducts(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();

            // Validate query parameters
            const query = ProductQuerySchema.parse(req.query);

            const result = await productListService.execute(
                vendorId,
                {
                    type: query.type,
                    status: query.status,
                    searchQuery: query.q,
                },
                {
                    page: query.page,
                    limit: query.limit,
                },
                {
                    sortBy: query.sortBy,
                    sortOrder: query.sortOrder,
                }
            );

            res.json({
                success: true,
                data: result.data,
                meta: result.meta,
            });
        } catch (error) {
            VendorProductController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/products
     * Create a new product
     */
    static async createProduct(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();

            // Validate request body
            const input = CreateProductSchema.parse(req.body);

            const product = await productDraftService.execute({
                vendorId,
                type: input.type,
                title: input.title,
            });

            res.status(201).json({
                success: true,
                data: product,
                message: 'Product created successfully',
            });
        } catch (error) {
            VendorProductController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/products/:id
     * Update product (images replace full array)
     */
    static async updateProduct(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id } = req.params;

            // Validate request body
            const input = UpdateProductSchema.parse(req.body);

            const product = await productUpdateService.execute(id, vendorId, {
                title: input.title,
                description: input.description,
                seoTitle: input.seoTitle,
                seoDescription: input.seoDescription,
                digitalConfig: input.digitalConfig,
                serviceConfig: input.serviceConfig,
            });

            res.json({
                success: true,
                data: product,
                message: 'Product updated successfully',
            });
        } catch (error) {
            VendorProductController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/products/:id/status
     * Change product status with validation
     */
    static async changeStatus(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id } = req.params;

            // Validate request body
            const input = ChangeProductStatusSchema.parse(req.body);

            // Fetch product
            const product = await productRepository.findById(id, vendorId);
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

            // Validate status transition
            productStatusValidationService.validate(product, input.status);

            // Update status
            const updatedProduct = await productRepository.update(id, vendorId, {
                status: input.status,
            });

            res.json({
                success: true,
                data: updatedProduct,
                message: `Product status changed to ${input.status}`,
            });
        } catch (error) {
            VendorProductController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/products/:id/duplicate
     * Duplicate product with slug collision prevention
     */
    static async duplicateProduct(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id } = req.params;

            const duplicatedProduct = await productDuplicateService.execute(id, vendorId);

            res.status(201).json({
                success: true,
                data: duplicatedProduct,
                message: 'Product duplicated successfully',
            });
        } catch (error) {
            VendorProductController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/vendor/products/:id
     * Archive product (soft delete)
     */
    static async archiveProduct(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id } = req.params;

            await productArchiveService.execute(id, vendorId);

            res.json({
                success: true,
                message: 'Product archived successfully',
            });
        } catch (error) {
            VendorProductController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/products/bulk/archive
     * Bulk archive products
     */
    static async bulkArchive(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();

            // Validate request body
            const input = BulkArchiveSchema.parse(req.body);

            const result = await productBulkOperationsService.bulkArchive(
                input.productIds,
                vendorId
            );

            res.json({
                success: true,
                data: result,
                message: `Archived ${result.success} of ${result.total} products`,
            });
        } catch (error) {
            VendorProductController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/products/bulk/status
     * Bulk status change
     */
    static async bulkStatusChange(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();

            // Validate request body
            const input = BulkStatusChangeSchema.parse(req.body);

            // Use validation version if activating
            const result = input.status === 'active'
                ? await productBulkOperationsService.bulkStatusChangeWithValidation(
                    input.productIds,
                    vendorId,
                    input.status
                )
                : await productBulkOperationsService.bulkStatusChange(
                    input.productIds,
                    vendorId,
                    input.status
                );

            res.json({
                success: true,
                data: result,
                message: `Updated ${result.success} of ${result.total} products`,
            });
        } catch (error) {
            VendorProductController.handleError(error, res);
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
        console.error('[VendorProductController] Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred. Please try again later.',
            },
        });
    }
}
