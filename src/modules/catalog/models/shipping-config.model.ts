import mongoose, { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

/**
 * ShippingConfig - Product-level shipping configuration
 * 
 * Provides default shipping dimensions and settings for physical products.
 * Variant dimensions override product defaults when present.
 * 
 * PRECEDENCE RULES:
 * - Variant dimensions (length, width, height, weight) take priority if set
 * - ShippingConfig provides fallback defaults
 * - If neither exists and shippingEnabled=true, error on rate calculation
 */
export interface IShippingConfig extends IBaseDocument {
    productId: Types.ObjectId;    // Product this configuration belongs to
    vendorId: Types.ObjectId;      // Owner vendor (for scoping)

    // Product-level default dimensions
    weight: number;                // Default weight in grams
    length: number;                // Default length in cm
    width: number;                 // Default width in cm
    height: number;                // Default height in cm

    // Shipping metadata
    originZipCode: string;         // Vendor's shipping origin zip code
    handlingDays: number;          // Days needed for order processing
    shippingEnabled: boolean;      // Whether shipping is enabled for this product
}

const ShippingConfigSchema = new Schema<IShippingConfig>({
    productId: {
        type: Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
        index: true,
        unique: true,
    },
    vendorId: {
        type: Schema.Types.ObjectId,
        ref: 'Vendor',
        required: true,
        index: true,
    },
    weight: {
        type: Number,
        required: true,
        min: 0,
    },
    length: {
        type: Number,
        required: true,
        min: 0,
    },
    width: {
        type: Number,
        required: true,
        min: 0,
    },
    height: {
        type: Number,
        required: true,
        min: 0,
    },
    originZipCode: {
        type: String,
        required: true,
    },
    handlingDays: {
        type: Number,
        required: true,
        min: 0,
        default: 1,
    },
    shippingEnabled: {
        type: Boolean,
        required: true,
        default: true,
    },

    ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
// ShippingConfigSchema.index({ productId: 1 }, { unique: true }); // One config per product
// ShippingConfigSchema.index({ vendorId: 1 }); // List vendor's shipping configs
// ShippingConfigSchema.index({ deletedAt: 1 }); // Soft delete queries

export const ShippingConfigModel =
    (mongoose.models.ShippingConfig as mongoose.Model<IShippingConfig>) ||
    model<IShippingConfig>('ShippingConfig', ShippingConfigSchema);
