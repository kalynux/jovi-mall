import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
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
const variantRepository = new VariantRepositoryMongo();
const slugService = new SlugService(productRepository);
const productDraftService = new ProductDraftService(productRepository, slugService);
const productUpdateService = new ProductUpdateService(productRepository, variantRepository, slugService);
const productArchiveService = new ProductArchiveService(productRepository);
const productListService = new ProductListService(productRepository);
const productDuplicateService = new ProductDuplicateService(productRepository, slugService);
const productStatusValidationService = new ProductStatusValidationService(variantRepository);
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
    static getProduct = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        const product = await productRepository.findById(id, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        res.json({ success: true, data: product });
    });

    /**
     * GET /api/vendor/products
     * List products with filters, search, and sorting
     */
    static listProducts = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const query = ProductQuerySchema.parse(req.query);
        const result = await productListService.execute(vendorId, { type: query.type, status: query.status, searchQuery: query.q }, { page: query.page, limit: query.limit }, { sortBy: query.sortBy, sortOrder: query.sortOrder });
        res.json({ success: true, data: result.data, meta: result.meta });
    });

    /**
     * POST /api/vendor/products
     * Create a new product
     */
    static createProduct = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const input = CreateProductSchema.parse(req.body);
        const product = await productDraftService.execute({ vendorId, type: input.type, title: input.title, category: input.category, tags: input.tags });
        res.status(201).json({ success: true, data: product, message: 'Product created successfully' });
    });

    /**
     * PATCH /api/vendor/products/:id
     * Update product (images replace full array)
     */
    static updateProduct = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        const input = UpdateProductSchema.parse(req.body);
        const product = await productUpdateService.execute(id, vendorId, { title: input.title, description: input.description, category: input.category, tags: input.tags, seoTitle: input.seoTitle, seoDescription: input.seoDescription, digitalConfig: input.digitalConfig, serviceConfig: input.serviceConfig });
        res.json({ success: true, data: product, message: 'Product updated successfully' });
    });

    /**
     * PATCH /api/vendor/products/:id/status
     * Change product status with validation
     */
    static changeStatus = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        const input = ChangeProductStatusSchema.parse(req.body);
        const product = await productRepository.findById(id, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        productStatusValidationService.validate(product, input.status);
        const updatedProduct = await productRepository.update(id, vendorId, { status: input.status });
        res.json({ success: true, data: updatedProduct, message: `Product status changed to ${input.status}` });
    });

    /**
     * POST /api/vendor/products/:id/duplicate
     * Duplicate product with slug collision prevention
     */
    static duplicateProduct = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        const duplicatedProduct = await productDuplicateService.execute(id, vendorId);
        res.status(201).json({ success: true, data: duplicatedProduct, message: 'Product duplicated successfully' });
    });

    /**
     * DELETE /api/vendor/products/:id
     * Archive product (soft delete)
     */
    static archiveProduct = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        await productArchiveService.execute(id, vendorId);
        res.json({ success: true, message: 'Product archived successfully' });
    });

    /**
     * POST /api/vendor/products/bulk/archive
     * Bulk archive products
     */
    static bulkArchive = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const input = BulkArchiveSchema.parse(req.body);
        const result = await productBulkOperationsService.bulkArchive(input.productIds, vendorId);
        res.json({ success: true, data: result, message: `Archived ${result.success} of ${result.total} products` });
    });

    /**
     * POST /api/vendor/products/bulk/status
     * Bulk status change
     */
    static bulkStatusChange = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const input = BulkStatusChangeSchema.parse(req.body);
        const result = input.status === 'active'
            ? await productBulkOperationsService.bulkStatusChangeWithValidation(input.productIds, vendorId, input.status)
            : await productBulkOperationsService.bulkStatusChange(input.productIds, vendorId, input.status);
        res.json({ success: true, data: result, message: `Updated ${result.success} of ${result.total} products` });
    });
}
