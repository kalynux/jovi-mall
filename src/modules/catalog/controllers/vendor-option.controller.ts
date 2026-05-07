import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
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
    static createOption = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        if (product.type !== 'physical')
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Only physical products can have options');

        const input = CreateOptionSchema.parse(req.body);
        const position = input.position ?? (await optionRepository.countByProduct(productId)) + 1;
        const option = await optionRepository.create({ productId, name: input.name, position, deletedAt: null, purgeAt: null });
        res.status(201).json({ success: true, data: option, message: 'Option created successfully' });
    });

    /**
     * GET /api/vendor/products/:productId/options
     * List all options for a product
     */
    static listOptions = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId } = req.params;
        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        const options = await optionRepository.findByProduct(productId);
        res.json({ success: true, data: options, meta: { total: options.length } });
    });

    /**
     * PATCH /api/vendor/products/:productId/options/:optionId
     * Update an option's name or position
     */
    static updateOption = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, optionId } = req.params;
        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        const option = await optionRepository.findById(optionId);
        if (!option || option.productId !== productId) throw createAppError(ERROR_CODES.CATALOG_OPTION_NOT_FOUND, 404);
        const input = UpdateOptionSchema.parse(req.body);
        const updatedOption = await optionRepository.update(optionId, input);
        res.json({ success: true, data: updatedOption, message: 'Option updated successfully' });
    });

    /**
     * PUT /api/vendor/products/:productId/options/reorder
     * Reorder options by providing an array of option IDs in desired order
     */
    static reorderOptions = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId } = req.params;
        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        const input = ReorderOptionsSchema.parse(req.body);
        const existingOptions = await optionRepository.findByProduct(productId);
        const existingOptionIds = existingOptions.map(opt => opt.id);
        for (const optId of input.optionIds) {
            if (!existingOptionIds.includes(optId))
                throw createAppError(ERROR_CODES.CATALOG_INVALID_OPTION_ID, 400, undefined, { optionId: optId });
        }
        await Promise.all(input.optionIds.map((optId, index) => optionRepository.update(optId, { position: index + 1 })));
        const updatedOptions = await optionRepository.findByProduct(productId);
        res.json({ success: true, data: updatedOptions, message: 'Options reordered successfully' });
    });

    /**
     * DELETE /api/vendor/products/:productId/options/:optionId
     * Delete an option (and cascade delete its values)
     */
    static deleteOption = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, optionId } = req.params;
        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        const option = await optionRepository.findById(optionId);
        if (!option || option.productId !== productId) throw createAppError(ERROR_CODES.CATALOG_OPTION_NOT_FOUND, 404);
        await optionValueRepository.deleteByOption(optionId);
        await optionRepository.delete(optionId);
        res.json({ success: true, message: 'Option and all its values deleted successfully' });
    });

    //==========================================================================
    // OPTION VALUE ENDPOINTS
    //==========================================================================

    /**
     * POST /api/vendor/products/:productId/options/:optionId/values
     * Create a new option value
     */
    static createOptionValue = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, optionId } = req.params;
        await VendorOptionController.validateOptionOwnership(productId, optionId, vendorId);
        const input = CreateOptionValueSchema.parse(req.body);
        const optionValue = await optionValueRepository.create({ optionId, value: input.value, deletedAt: null, purgeAt: null });
        res.status(201).json({ success: true, data: optionValue, message: 'Option value created successfully' });
    });

    /**
     * POST /api/vendor/products/:productId/options/:optionId/values/bulk
     * Bulk create option values
     */
    static bulkCreateOptionValues = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, optionId } = req.params;
        await VendorOptionController.validateOptionOwnership(productId, optionId, vendorId);
        const input = BulkCreateOptionValuesSchema.parse(req.body);
        const optionValues = await optionValueRepository.createMany(input.values.map(value => ({ optionId, value, deletedAt: null, purgeAt: null })));
        res.status(201).json({ success: true, data: optionValues, message: `${optionValues.length} option values created successfully`, meta: { created: optionValues.length } });
    });

    /**
     * GET /api/vendor/products/:productId/options/:optionId/values
     * List all values for an option
     */
    static listOptionValues = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, optionId } = req.params;
        await VendorOptionController.validateOptionOwnership(productId, optionId, vendorId);
        const optionValues = await optionValueRepository.findByOption(optionId);
        res.json({ success: true, data: optionValues, meta: { total: optionValues.length } });
    });

    /**
     * DELETE /api/vendor/products/:productId/options/:optionId/values/:valueId
     * Delete an option value
     */
    static deleteOptionValue = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, optionId, valueId } = req.params;
        await VendorOptionController.validateOptionOwnership(productId, optionId, vendorId);
        const optionValue = await optionValueRepository.findById(valueId);
        if (!optionValue || optionValue.optionId !== optionId) throw createAppError(ERROR_CODES.CATALOG_OPTION_NOT_FOUND, 404, 'Option value not found');
        await optionValueRepository.delete(valueId);
        res.json({ success: true, message: 'Option value deleted successfully' });
    });

    //==========================================================================
    // HELPER METHODS
    //==========================================================================

    private static async validateOptionOwnership(productId: string, optionId: string, vendorId: string): Promise<void> {
        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        const option = await optionRepository.findById(optionId);
        if (!option || option.productId !== productId) throw createAppError(ERROR_CODES.CATALOG_OPTION_NOT_FOUND, 404);
    }
}
