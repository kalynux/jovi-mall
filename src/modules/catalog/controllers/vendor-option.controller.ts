import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, NotFoundError, ForbiddenError, ValidationError } from '../../../core/errors';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { OptionRepositoryMongo } from '../repositories/mongo/option.repository.mongo';
import { OptionValueRepositoryMongo } from '../repositories/mongo/option-value.repository.mongo';
import {
    CreateOptionSchema,
    UpdateOptionSchema,
    ReorderOptionsSchema,
    CreateOptionValueSchema,
    UpdateOptionValueSchema,
    BulkCreateOptionValuesSchema,
} from '../validators/option.validator';

const productRepository = new ProductRepositoryMongo();
const optionRepository = new OptionRepositoryMongo();
const optionValueRepository = new OptionValueRepositoryMongo();

/**
 * VendorOptionController
 * 
 * Manages product options and option values for physical products.
 * Options define variant attributes (Size, Color, Material).
 * Option values define specific choices (S, M, L for Size).
 */
export class VendorOptionController {
    //==========================================================================
    // PRODUCT OPTION ENDPOINTS
    //==========================================================================

    /**
     * POST /api/vendor/products/:productId/options
     * Create a new option for a product
     */
    static async createOption(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId } = req.params;

            // Validate product exists, belongs to vendor, and is physical type
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Product not found' },
                });
                return;
            }

            if (product.type !== 'physical') {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'INVALID_PRODUCT_TYPE',
                        message: 'Only physical products can have options',
                    },
                });
                return;
            }

            // Validate input
            const input = CreateOptionSchema.parse(req.body);

            // Auto-assign position if not provided
            const position = input.position ?? (await optionRepository.countByProduct(productId)) + 1;

            // Create option
            const option = await optionRepository.create({
                productId,
                name: input.name,
                position,
                deletedAt: null,
                purgeAt: null,
            });

            res.status(201).json({
                success: true,
                data: option,
                message: 'Option created successfully',
            });
        } catch (error) {
            VendorOptionController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/products/:productId/options
     * List all options for a product
     */
    static async listOptions(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Product not found' },
                });
                return;
            }

            // Fetch options (sorted by position)
            const options = await optionRepository.findByProduct(productId);

            res.json({
                success: true,
                data: options,
                meta: { total: options.length },
            });
        } catch (error) {
            VendorOptionController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/products/:productId/options/:optionId
     * Update an option's name or position
     */
    static async updateOption(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId, optionId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Product not found' },
                });
                return;
            }

            // Validate option exists and belongs to product
            const option = await optionRepository.findById(optionId);
            if (!option || option.productId !== productId) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Option not found' },
                });
                return;
            }

            // Validate input
            const input = UpdateOptionSchema.parse(req.body);

            // Update option
            const updatedOption = await optionRepository.update(optionId, input);

            res.json({
                success: true,
                data: updatedOption,
                message: 'Option updated successfully',
            });
        } catch (error) {
            VendorOptionController.handleError(error, res);
        }
    }

    /**
     * PUT /api/vendor/products/:productId/options/reorder
     * Reorder options by providing an array of option IDs in desired order
     */
    static async reorderOptions(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Product not found' },
                });
                return;
            }

            // Validate input
            const input = ReorderOptionsSchema.parse(req.body);

            // Fetch all options for product to validate
            const existingOptions = await optionRepository.findByProduct(productId);
            const existingOptionIds = existingOptions.map(opt => opt.id);

            // Validate all provided IDs exist for this product
            for (const optionId of input.optionIds) {
                if (!existingOptionIds.includes(optionId)) {
                    res.status(400).json({
                        success: false,
                        error: {
                            code: 'INVALID_OPTION_ID',
                            message: `Option ID ${optionId} does not belong to this product`,
                        },
                    });
                    return;
                }
            }

            // Update positions
            const updatePromises = input.optionIds.map((optionId, index) =>
                optionRepository.update(optionId, { position: index + 1 })
            );

            await Promise.all(updatePromises);

            // Fetch updated options
            const updatedOptions = await optionRepository.findByProduct(productId);

            res.json({
                success: true,
                data: updatedOptions,
                message: 'Options reordered successfully',
            });
        } catch (error) {
            VendorOptionController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/vendor/products/:productId/options/:optionId
     * Delete an option (and cascade delete its values)
     */
    static async deleteOption(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId, optionId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Product not found' },
                });
                return;
            }

            // Validate option exists and belongs to product
            const option = await optionRepository.findById(optionId);
            if (!option || option.productId !== productId) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Option not found' },
                });
                return;
            }

            // CASCADE DELETE: Delete all option values first
            await optionValueRepository.deleteByOption(optionId);

            // Delete the option
            await optionRepository.delete(optionId);

            res.json({
                success: true,
                message: 'Option and all its values deleted successfully',
            });
        } catch (error) {
            VendorOptionController.handleError(error, res);
        }
    }

    //==========================================================================
    // OPTION VALUE ENDPOINTS
    //==========================================================================

    /**
     * POST /api/vendor/products/:productId/options/:optionId/values
     * Create a new option value
     */
    static async createOptionValue(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId, optionId } = req.params;

            // Validate product and option
            await VendorOptionController.validateOptionOwnership(productId, optionId, vendorId, res);
            if (res.headersSent) return;

            // Validate input
            const input = CreateOptionValueSchema.parse(req.body);

            // Create option value
            const optionValue = await optionValueRepository.create({
                optionId,
                value: input.value,
                deletedAt: null,
                purgeAt: null,
            });

            res.status(201).json({
                success: true,
                data: optionValue,
                message: 'Option value created successfully',
            });
        } catch (error) {
            VendorOptionController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/products/:productId/options/:optionId/values/bulk
     * Bulk create option values
     */
    static async bulkCreateOptionValues(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId, optionId } = req.params;

            // Validate product and option
            await VendorOptionController.validateOptionOwnership(productId, optionId, vendorId, res);
            if (res.headersSent) return;

            // Validate input
            const input = BulkCreateOptionValuesSchema.parse(req.body);

            // Create option values
            const optionValues = await optionValueRepository.createMany(
                input.values.map(value => ({
                    optionId,
                    value,
                    deletedAt: null,
                    purgeAt: null,
                }))
            );

            res.status(201).json({
                success: true,
                data: optionValues,
                message: `${optionValues.length} option values created successfully`,
                meta: { created: optionValues.length },
            });
        } catch (error) {
            VendorOptionController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/products/:productId/options/:optionId/values
     * List all values for an option
     */
    static async listOptionValues(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId, optionId } = req.params;

            // Validate product and option
            await VendorOptionController.validateOptionOwnership(productId, optionId, vendorId, res);
            if (res.headersSent) return;

            // Fetch option values
            const optionValues = await optionValueRepository.findByOption(optionId);

            res.json({
                success: true,
                data: optionValues,
                meta: { total: optionValues.length },
            });
        } catch (error) {
            VendorOptionController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/vendor/products/:productId/options/:optionId/values/:valueId
     * Delete an option value
     */
    static async deleteOptionValue(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { productId, optionId, valueId } = req.params;

            // Validate product and option
            await VendorOptionController.validateOptionOwnership(productId, optionId, vendorId, res);
            if (res.headersSent) return;

            // Validate value exists and belongs to option
            const optionValue = await optionValueRepository.findById(valueId);
            if (!optionValue || optionValue.optionId !== optionId) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Option value not found' },
                });
                return;
            }

            // Delete the option value
            await optionValueRepository.delete(valueId);

            res.json({
                success: true,
                message: 'Option value deleted successfully',
            });
        } catch (error) {
            VendorOptionController.handleError(error, res);
        }
    }

    //==========================================================================
    // HELPER METHODS
    //==========================================================================

    /**
     * Validate that an option exists, belongs to the product, and the product belongs to the vendor
     */
    private static async validateOptionOwnership(
        productId: string,
        optionId: string,
        vendorId: string,
        res: Response
    ): Promise<boolean> {
        // Validate product exists and belongs to vendor
        const product = await productRepository.findById(productId, vendorId);
        if (!product) {
            res.status(404).json({
                success: false,
                error: { code: 'NOT_FOUND', message: 'Product not found' },
            });
            return false;
        }

        // Validate option exists and belongs to product
        const option = await optionRepository.findById(optionId);
        if (!option || option.productId !== productId) {
            res.status(404).json({
                success: false,
                error: { code: 'NOT_FOUND', message: 'Option not found' },
            });
            return false;
        }

        return true;
    }

    /**
     * Centralized error handler
     */
    private static handleError(error: any, res: Response): void {
        // Handle Zod validation errors
        if (error instanceof ZodError) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid input',
                    details: error.errors.map(e => ({
                        path: e.path.join('.'),
                        message: e.message,
                    })),
                },
            });
            return;
        }

        // Handle known app errors
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

        // Handle Mongoose duplicate key errors
        if (error.code === 11000) {
            res.status(409).json({
                success: false,
                error: {
                    code: 'DUPLICATE_ERROR',
                    message: 'An option with this name already exists for this product',
                },
            });
            return;
        }

        // Unexpected errors
        console.error('[VendorOptionController] Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred',
            },
        });
    }
}
