import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { ProductShippingService } from '../domain/services/shipping/ProductShippingService';

const productRepository = new ProductRepositoryMongo();
const shippingService = new ProductShippingService();

// Zod schema for shipping config
const ShippingConfigSchema = z.object({
    weight: z.number().min(0, 'Weight must be positive'),
    length: z.number().min(0, 'Length must be positive'),
    width: z.number().min(0, 'Width must be positive'),
    height: z.number().min(0, 'Height must be positive'),
    originZipCode: z.string().min(1, 'Origin zip code is required').max(20),
    handlingDays: z.number().int().min(0, 'Handling days must be non-negative').default(1),
    shippingEnabled: z.boolean().default(true),
});

/**
 * VendorShippingController
 *
 * Manages shipping configuration for physical products.
 *
 * Errors are raised with createAppError and propagated to the global error
 * handler via asyncHandler — never written inline.
 */
export class VendorShippingController {
    /**
     * POST /api/vendor/products/:id/shipping
     * Create or update shipping configuration
     */
    static upsertShippingConfig = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        // Validate product exists and belongs to vendor
        const product = await productRepository.findById(productId, vendorId);
        if (!product) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
        }

        // Validate product is physical type
        if (product.type !== 'physical') {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Only physical products can have shipping configuration');
        }

        // Validate request body
        const input = ShippingConfigSchema.parse(req.body);

        // Create or update shipping config
        const shippingConfig = await shippingService.createOrUpdateShippingConfig(
            productId,
            vendorId,
            input
        );

        res.status(200).json({
            success: true,
            data: shippingConfig,
            message: 'Shipping configuration saved successfully',
        });
    });

    /**
     * GET /api/vendor/products/:id/shipping
     * Get shipping configuration
     */
    static getShippingConfig = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        // Validate product exists and belongs to vendor
        const product = await productRepository.findById(productId, vendorId);
        if (!product) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
        }

        // Get shipping config
        const shippingConfig = await shippingService.getShippingConfig(productId, vendorId);

        if (!shippingConfig) {
            throw createAppError(ERROR_CODES.CATALOG_SHIPPING_NOT_FOUND, 404, 'Shipping configuration not found');
        }

        res.json({
            success: true,
            data: shippingConfig,
        });
    });

    /**
     * DELETE /api/vendor/products/:id/shipping
     * Delete shipping configuration
     */
    static deleteShippingConfig = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        // Validate product exists and belongs to vendor
        const product = await productRepository.findById(productId, vendorId);
        if (!product) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
        }

        // Delete shipping config
        await shippingService.deleteShippingConfig(productId, vendorId);

        res.json({
            success: true,
            message: 'Shipping configuration deleted successfully',
        });
    });
}
