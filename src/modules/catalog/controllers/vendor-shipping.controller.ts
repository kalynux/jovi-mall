import { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { AppError } from '../../../core/errors';
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
 *  Manages shipping configuration for physical products.
 */
export class VendorShippingController {
    /**
     * POST /api/vendor/products/:id/shipping
     * Create or update shipping configuration
     */
    static async upsertShippingConfig(req: Request, res: Response): Promise<void> {
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
                        message: 'Only physical products can have shipping configuration',
                    },
                });
                return;
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
        } catch (error) {
            VendorShippingController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/products/:id/shipping
     * Get shipping configuration
     */
    static async getShippingConfig(req: Request, res: Response): Promise<void> {
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

            // Get shipping config
            const shippingConfig = await shippingService.getShippingConfig(productId, vendorId);

            if (!shippingConfig) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Shipping configuration not found',
                    },
                });
                return;
            }

            res.json({
                success: true,
                data: shippingConfig,
            });
        } catch (error) {
            VendorShippingController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/vendor/products/:id/shipping
     * Delete shipping configuration
     */
    static async deleteShippingConfig(req: Request, res: Response): Promise<void> {
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

            // Delete shipping config
            await shippingService.deleteShippingConfig(productId, vendorId);

            res.json({
                success: true,
                message: 'Shipping configuration deleted successfully',
            });
        } catch (error) {
            VendorShippingController.handleError(error, res);
        }
    }

    /**
     * Centralized error handler
     */
    private static handleError(error: any, res: Response): void {
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

        console.error('[VendorShippingController] Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred',
            },
        });
    }
}
