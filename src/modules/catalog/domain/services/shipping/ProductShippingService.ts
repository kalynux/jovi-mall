import { Types } from 'mongoose';
import { IShippingConfig, ShippingConfigModel } from '../../../models/shipping-config.model';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';

/**
 * ProductShippingService
 * 
 * Business logic for shipping configuration management.
 * Enforces precedence rules: variant dimensions override product defaults.
 */
export class ProductShippingService {
    /**
     * Create or update shipping configuration for a product
     */
    async createOrUpdateShippingConfig(
        productId: string,
        vendorId: string,
        config: {
            weight: number;
            length: number;
            width: number;
            height: number;
            originZipCode: string;
            handlingDays: number;
            shippingEnabled: boolean;
        }
    ): Promise<IShippingConfig> {
        const existing = await ShippingConfigModel.findOne({
            productId: new Types.ObjectId(productId),
            deletedAt: null,
        });

        if (existing) {
            // Verify ownership
            if (existing.vendorId.toString() !== vendorId) {
                throw createAppError(ERROR_CODES.CATALOG_SHIPPING_ACCESS_DENIED, 403, 'Unauthorized: Shipping config belongs to another vendor');
            }

            // Update existing
            existing.weight = config.weight;
            existing.length = config.length;
            existing.width = config.width;
            existing.height = config.height;
            existing.originZipCode = config.originZipCode;
            existing.handlingDays = config.handlingDays;
            existing.shippingEnabled = config.shippingEnabled;

            await existing.save();
            return existing;
        }

        // Create new
        const shippingConfig = await ShippingConfigModel.create({
            productId: new Types.ObjectId(productId),
            vendorId: new Types.ObjectId(vendorId),
            ...config,
        });

        return shippingConfig;
    }

    /**
     * Get shipping configuration for a product
     */
    async getShippingConfig(
        productId: string,
        vendorId: string
    ): Promise<IShippingConfig | null> {
        const config = await ShippingConfigModel.findOne({
            productId: new Types.ObjectId(productId),
            deletedAt: null,
        });

        if (!config) return null;

        // Verify ownership
        if (config.vendorId.toString() !== vendorId) {
            throw createAppError(ERROR_CODES.CATALOG_SHIPPING_ACCESS_DENIED, 403, 'Unauthorized: Shipping config belongs to another vendor');
        }

        return config;
    }

    /**
     * Delete shipping configuration
     */
    async deleteShippingConfig(productId: string, vendorId: string): Promise<void> {
        const config = await ShippingConfigModel.findOne({
            productId: new Types.ObjectId(productId),
            deletedAt: null,
        });

        if (!config) {
            throw createAppError(ERROR_CODES.CATALOG_SHIPPING_NOT_FOUND, 404, 'Shipping config not found');
        }

        // Verify ownership
        if (config.vendorId.toString() !== vendorId) {
            throw createAppError(ERROR_CODES.CATALOG_SHIPPING_ACCESS_DENIED, 403, 'Unauthorized: Shipping config belongs to another vendor');
        }

        // Soft delete
        config.deletedAt = new Date();
        await config.save();
    }

    /**
     * Get effective shipping dimensions for a variant
     * 
     * PRECEDENCE:
     * 1. Variant dimensions (if set)
     * 2. Product shipping config (fallback)
     * 3. Error if neither exists and shipping is enabled
     */
    async getEffectiveDimensions(
        productId: string,
        variantId?: string
    ): Promise<{
        weight: number;
        length: number;
        width: number;
        height: number;
    } | null> {
        // If variant provided, check its dimensions first
        if (variantId) {
            const { ProductVariantModel } = await import('../../../models/product-variant.model');
            const variant = await ProductVariantModel.findById(variantId);

            if (variant && variant.weight && variant.length && variant.width && variant.height) {
                return {
                    weight: variant.weight,
                    length: variant.length,
                    width: variant.width,
                    height: variant.height,
                };
            }
        }

        // Fallback to product shipping config
        const config = await ShippingConfigModel.findOne({
            productId: new Types.ObjectId(productId),
            deletedAt: null,
        });

        if (!config) return null;

        return {
            weight: config.weight,
            length: config.length,
            width: config.width,
            height: config.height,
        };
    }
}
