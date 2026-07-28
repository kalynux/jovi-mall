import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
import { FileRepositoryMongo } from '../repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../repositories/mongo/file-reference.repository.mongo';
import { getStorageProvider } from '../../../core/storage';
import { enrichProduct } from '../read-models/enrich-product-detail';
import { ProductDraftService } from '../domain/services/ProductDraftService';
import { ProductUpdateService } from '../domain/services/ProductUpdateService';
import { ProductArchiveService } from '../domain/services/ProductArchiveService';
import { ProductListService } from '../domain/services/ProductListService';
import { ProductDuplicateService } from '../domain/services/ProductDuplicateService';
import { ProductStatusValidationService } from '../domain/services/ProductStatusValidationService';
import { ProductBulkOperationsService } from '../domain/services/ProductBulkOperationsService';
import { SlugService } from '../domain/services/SlugService';
import { FileReferenceService } from '../domain/services/media/FileReferenceService';
import {
    CreateProductSchema,
    UpdateProductSchema,
    VendorChangeProductStatusSchema,
    ProductQuerySchema,
    BulkArchiveSchema,
    VendorBulkStatusChangeSchema,
    SetVectorisationSchema,
} from '../validators/product.validator';
import { vectorisationService } from '../domain/services/VectorisationService';
import { entitlementService } from '../../billing/services/entitlement.service';
import { ProductDeliveryAgencySuspensionService } from '../domain/services/ProductDeliveryAgencySuspensionService';
import { VendorRepository } from '../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { VendorOrderService } from '../../orders/vendor-order.service';

const BulkVectoriseSchema = z.object({
    productIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId')).optional(),
});

const SetDefaultVariantSchema = z.object({
    variantId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId'),
});

// Initialize services
const productRepository = new ProductRepositoryMongo();
const variantRepository = new VariantRepositoryMongo();
const fileRepository = new FileRepositoryMongo();
const fileReferenceRepository = new FileReferenceRepositoryMongo();
const storageProvider = getStorageProvider();
const slugService = new SlugService(productRepository);
const fileReferenceService = new FileReferenceService(fileRepository, fileReferenceRepository);
const productDraftService = new ProductDraftService(productRepository, slugService, fileReferenceService);
const productUpdateService = new ProductUpdateService(productRepository, slugService, fileReferenceService);
const productArchiveService = new ProductArchiveService(productRepository);
const productListService = new ProductListService(productRepository, fileRepository, storageProvider);
const productDuplicateService = new ProductDuplicateService(productRepository, slugService, fileReferenceService);
const productStatusValidationService = new ProductStatusValidationService(productRepository, variantRepository);
const productBulkOperationsService = new ProductBulkOperationsService(
    productRepository,
    productStatusValidationService
);
const productDeliveryAgencySuspensionService = new ProductDeliveryAgencySuspensionService(productRepository);
const vendorRepository = new VendorRepository();
const deliveryAgencyRepository = new DeliveryAgencyRepository();
const vendorOrderService = new VendorOrderService();

/**
 * When a product's own delivery-agency override changes (set, changed, or cleared),
 * restore the product if it's now eligible again (no-op if it wasn't suspended for
 * this reason, or if it's still blocked by something else — e.g. the vendor's
 * default is also broken), and reassign any of its held/pending order items from
 * the old agency to the resolved new target: the new override if active, or the
 * vendor's current active default if the override was cleared.
 */
async function handleProductAgencyOverrideChange(
    productId: string,
    vendorId: string,
    previousAgencyId: string | null,
    newAgencyId: string | null,
): Promise<{ restored: boolean; reassignedCount: number }> {
    const { restored } = await productDeliveryAgencySuspensionService.restoreProductOwnAgency(productId, vendorId);

    if (!previousAgencyId) return { restored, reassignedCount: 0 };

    let targetAgencyId: string | null = null;
    if (newAgencyId) {
        const agency = await deliveryAgencyRepository.findById(newAgencyId);
        if (agency?.status === 'active') targetAgencyId = newAgencyId;
    } else {
        const vendor = await vendorRepository.findById(vendorId);
        const defaultId = vendor?.default_delivery_agency_id?.toString();
        if (defaultId) {
            const defaultAgency = await deliveryAgencyRepository.findById(defaultId);
            if (defaultAgency?.status === 'active') targetAgencyId = defaultId;
        }
    }

    if (!targetAgencyId) return { restored, reassignedCount: 0 };

    const { reassignedCount } = await vendorOrderService.reassignItemsForProduct(
        vendorId,
        productId,
        previousAgencyId,
        targetAgencyId,
    );
    return { restored, reassignedCount };
}

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
        const detail = await enrichProduct(product, fileRepository, storageProvider);
        res.json({ success: true, data: detail });
    });

    /**
     * GET /api/vendor/products
     * List products with filters, search, and sorting
     */
    static listProducts = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const query = ProductQuerySchema.parse(req.query);
        const result = await productListService.execute(
            vendorId,
            { type: query.type, status: query.status, searchQuery: query.q },
            { page: query.page, limit: query.limit },
            { sortBy: query.sortBy, sortOrder: query.sortOrder }
        );
        console.log({query, data: result.data})
        res.json({ success: true, data: result.data, meta: result.meta });
    });

    /**
     * POST /api/vendor/products
     * Create a new product
     */
    static createProduct = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const input = CreateProductSchema.parse(req.body);

        // Enforce the plan's active-product cap before creating.
        const activeCount = await productRepository.countActiveByVendor(vendorId);
        await entitlementService.assertCanAddProduct(vendorId, activeCount);

        const product = await productDraftService.execute({
            vendorId,
            type: input.type,
            title: input.title,
            description: input.description,
            category: input.category,
            tags: input.tags,
            seoTitle: input.seoTitle,
            seoDescription: input.seoDescription,
            fileIds: input.fileIds,
        });
        const detail = await enrichProduct(product, fileRepository, storageProvider);

        // Return response immediately — vectorisation is async and must not block
        res.status(201).json({ success: true, data: detail, message: 'Product created successfully' });

        // Fire-and-forget: run after response is sent
        void vectorisationService.vectoriseSingle(product.id);
    });

    /**
     * PATCH /api/vendor/products/:id
     * Update product — fileIds is a full array replacement.
     *
     * If the body includes `vectorisationEnabled`, the update routes through
     * vectorisationService.setEnabled after the content update so vendors can
     * toggle opt-in in the same request. Otherwise the existing re-vectorise-
     * if-eligible behaviour runs.
     */
    static updateProduct = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        const input = UpdateProductSchema.parse(req.body);

        const existingProduct = await productRepository.findById(id, vendorId);
        if (!existingProduct) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        const previousAgencyId = existingProduct.delivery?.agencyId ?? null;

        const product = await productUpdateService.execute(id, vendorId, {
            title: input.title,
            description: input.description,
            category: input.category,
            tags: input.tags,
            seoTitle: input.seoTitle,
            seoDescription: input.seoDescription,
            fileIds: input.fileIds,
            digitalConfig: input.digitalConfig,
            delivery: input.delivery,
        });

        // If the update broke the active-state invariant (description cleared,
        // delivery agency removed, serviceConfig dropped, …) demote to draft.
        const demoted = await productStatusValidationService.revalidateActiveStatus(id, vendorId);

        // If the product's own delivery-agency override changed, restore the
        // product if it's eligible again and reassign its held/pending order
        // items to the resolved new agency. See handleProductAgencyOverrideChange.
        let agencyFixup: { restored: boolean; reassignedCount: number } | null = null;
        if (input.delivery?.agencyId !== undefined && input.delivery.agencyId !== previousAgencyId) {
            agencyFixup = await handleProductAgencyOverrideChange(id, vendorId, previousAgencyId, input.delivery.agencyId);
        }

        const finalProduct = (demoted || agencyFixup?.restored)
            ? (await productRepository.findById(id, vendorId)) ?? product
            : product;
        const detail = await enrichProduct(finalProduct, fileRepository, storageProvider);

        const message = agencyFixup && agencyFixup.reassignedCount > 0
            ? `Product updated successfully. ${agencyFixup.reassignedCount} pending order item(s) reassigned to the new agency.`
            : 'Product updated successfully';

        // Return response immediately — vectorisation is async and must not block
        res.json({ success: true, data: detail, message });

        // Vectorisation side-effect, after response.
        if (input.vectorisationEnabled !== undefined) {
            try {
                const result = await vectorisationService.setEnabled(
                    id,
                    vendorId,
                    input.vectorisationEnabled,
                );
                if (result.outcome === 'enabled' && result.payload) {
                    void vectorisationService.executePreparedVectorisation(id, result.payload);
                } else if (result.outcome === 'disabled') {
                    void vectorisationService.deleteVectorisation(id);
                }
            } catch (err: any) {
                console.error(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    service: 'VendorProductController',
                    level: 'error',
                    message: 'updateProduct: post-response vectorisation toggle failed',
                    productId: id,
                    error: err?.message,
                }));
            }
        } else {
            // Content may have changed — re-vectorise if currently eligible.
            void vectorisationService.vectoriseSingle(product.id);
        }
    });

    /**
     * PATCH /api/vendor/products/:id/status
     * Change product status with validation
     */
    static changeStatus = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        const input = VendorChangeProductStatusSchema.parse(req.body);
        const product = await productRepository.findById(id, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        // Transition gate first (e.g. 'suspended' is a system lock a vendor can't
        // leave; activation only from 'draft'), then target-status requirements.
        productStatusValidationService.assertVendorTransition(product, input.status);
        await productStatusValidationService.validate(product, input.status);
        const updatedProduct = await productRepository.update(id, vendorId, { status: input.status });

        // Return response immediately
        res.json({ success: true, data: updatedProduct, message: `Product status changed to ${input.status}` });

        // Fire-and-forget: only metadata change — use the lighter status endpoint
        void vectorisationService.notifyStatusChange(id, input.status);
    });

    /**
     * PATCH /api/vendor/products/:id/default-variant
     * Set the default variant for a product (used for display and pricing)
     */
    static setDefaultVariant = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        const input = SetDefaultVariantSchema.parse(req.body);

        const product = await productRepository.findById(id, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        const variant = await variantRepository.findById(input.variantId);
        if (!variant || variant.productId !== id || variant.status !== 'active')
            throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404, 'Variant not found, archived, or does not belong to this product');

        await productRepository.update(id, vendorId, { defaultVariantId: input.variantId });
        res.json({ success: true, message: 'Default variant updated successfully' });
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
        const input = VendorBulkStatusChangeSchema.parse(req.body);
        const result = input.status === 'active'
            ? await productBulkOperationsService.bulkStatusChangeWithValidation(input.productIds, vendorId, input.status)
            : await productBulkOperationsService.bulkStatusChange(input.productIds, vendorId, input.status);

        // Return response immediately
        res.json({ success: true, data: result, message: `Updated ${result.success} of ${result.total} products` });

        // Fire-and-forget: notify vectoriser about each product's new status
        for (const productId of input.productIds) {
            void vectorisationService.notifyStatusChange(productId, input.status);
        }
    });

    /**
     * GET /api/vendor/products/:id/vectorisation/status
     * Read the current vectorisation snapshot for a product.
     */
    static getVectorisationStatus = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;

        const product = await productRepository.findById(id, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        res.json({
            success: true,
            data: {
                productId: product.id,
                vectorisationEnabled: product.vectorisationEnabled,
                vectorisationStatus: product.vectorisationStatus,
                vectorisedDataId: product.vectorisedDataId,
            },
        });
    });

    /**
     * PATCH /api/vendor/products/:id/vectorisation
     * Body: { enabled: boolean }
     *
     * Consolidated toggle — replaces the previous /enable and /disable routes.
     * Idempotent: sending the current state returns 200 with a no-op message.
     * For an enable that produces a payload, responds 202 and fires the upstream
     * vectoriser call after the response. For a disable, responds 202 and fires
     * the upstream delete after the response.
     */
    static setVectorisation = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;
        const { enabled } = SetVectorisationSchema.parse(req.body);

        const { outcome, state, payload } = await vectorisationService.setEnabled(
            id,
            vendorId,
            enabled,
        );

        if (outcome === 'noop') {
            res.json({
                success: true,
                data: { productId: id, ...state },
                message: `Vectorisation is already ${enabled ? 'enabled' : 'disabled'}.`,
            });
            return;
        }

        if (outcome === 'ineligible') {
            res.json({
                success: true,
                data: { productId: id, ...state },
                message:
                    'Product is not eligible for vectorisation. Vectorisation has been disabled — make the product active and ensure it has a title, description, and category, then re-enable.',
            });
            return;
        }

        res.status(202).json({
            success: true,
            data: { productId: id, ...state },
            message: outcome === 'enabled'
                ? 'Vectorisation enabled. The vectoriser is being called in the background.'
                : 'Vectorisation disabled. External cleanup is running in the background.',
        });

        if (outcome === 'enabled' && payload) {
            void vectorisationService.executePreparedVectorisation(id, payload);
        } else if (outcome === 'disabled') {
            void vectorisationService.deleteVectorisation(id);
        }
    });

    /**
     * POST /api/vendor/products/:id/vectorisation/retry
     *
     * Resubmit the full product payload to the vectoriser. Typically used after
     * a 'failed' status. The product must already be opted in.
     *
     * Flow:
     *  1. prepareForVectorisation runs the eligibility check + sets 'pending' +
     *     builds the payload. On ineligibility it disables vectorisation and
     *     returns a null payload.
     *  2. If no payload: return 422 — the retry can't proceed.
     *  3. Otherwise respond 202 with accurate state, then fire-and-forget the
     *     external call.
     */
    static retryVectorisation = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id } = req.params;

        const product = await productRepository.findById(id, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        const { payload, state } = await vectorisationService.prepareForVectorisation(id);

        if (!payload) {
            // prepareForVectorisation has already flipped vectorisationEnabled=false
            // (and reset status) if the product was ineligible — the state object
            // reflects the post-prep DB row.
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_VECTORISATION_NOT_ELIGIBLE,
                422,
                'Product is not eligible for vectorisation. Vectorisation has been disabled — ensure the product is active and has a title, description, and category, then re-enable vectorisation.',
                { state },
            );
        }

        res.status(202).json({
            success: true,
            data: { productId: id, ...state },
            message: 'Retry scheduled. The vectoriser is being called in the background.',
        });

        void vectorisationService.executePreparedVectorisation(id, payload);
    });

    /**
     * POST /api/admin/products/bulk-vectorise
     * Admin: Trigger bulk vectorisation for a list of product IDs.
     *
     * Body: { productIds?: string[] }
     *   - Omit productIds (or pass an empty array) to vectorise ALL eligible products
     *     across all vendors (use with caution on large catalogues).
     *
     * This endpoint AWAITS the result and returns a summary — it is intentionally
     * synchronous so the caller knows what happened.
     */
    static bulkVectorise = asyncHandler(async (req: Request, res: Response) => {
        const input = BulkVectoriseSchema.parse(req.body);

        let productIds: string[];

        if (input.productIds && input.productIds.length > 0) {
            productIds = input.productIds;
        } else {
            // No IDs provided — find all active, vectorisation-enabled, non-completed products
            const { ProductModel } = await import('../models/product.model');
            const docs = await ProductModel.find({
                status: 'active',
                vectorisationEnabled: true,
                vectorisationStatus: { $in: ['not_started', 'pending', 'failed'] },
                deletedAt: null,
            }).select('_id').lean();
            productIds = docs.map((d: any) => d._id.toString());
        }

        const result = await vectorisationService.vectoriseBulk(productIds);

        res.json({
            success: true,
            data: result,
            message: `Vectorisation complete: ${result.succeeded} succeeded, ${result.failed} failed out of ${result.total} total`,
        });
    });
}
