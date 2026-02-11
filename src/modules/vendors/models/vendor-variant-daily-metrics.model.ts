import mongoose, { Schema, Document } from 'mongoose';

/**
 * VendorVariantDailyMetrics - Per-variant daily metrics for flexible analytics
 * 
 * CRITICAL DESIGN PRINCIPLES:
 * - Separate from VendorDailyMetrics for flexibility
 * - Enables dynamic "top N" queries without schema migrations
 * - Denormalizes variant identity for query performance
 * 
 * RATIONALE:
 * - Storing "top 5 products" inside daily row is inflexible
 * - This pattern allows top 5, top 10, top 20 at query time
 * - Different sorting strategies without data migration
 * - Cheaper aggregation logic (just store per-variant metrics)
 * 
 * QUERY PATTERN:
 * - O(n_days × variants_per_day) still efficient for typical vendor scale
 * - Compound indexes enable fast top-N queries
 */

export interface IVendorVariantDailyMetrics extends Document {
    vendorId: mongoose.Types.ObjectId;    // Vendor owner
    variantId: mongoose.Types.ObjectId;   // Product variant
    date: Date;                           // YYYY-MM-DD (vendor timezone)

    // Denormalized variant identity (for performance)
    sku: string;
    productTitle: string;
    variantTitle?: string;

    // Daily metrics
    revenue: number;                      // Total revenue for this variant on this day
    quantity: number;                     // Total quantity sold
    orderCount: number;                   // Number of orders containing this variant

    lastCalculatedAt: Date;               // When this variant's metrics were aggregated
    aggregationVersion: number;           // Version tracking (default: 1)
}

const VendorVariantDailyMetricsSchema = new Schema<IVendorVariantDailyMetrics>(
    {
        vendorId: {
            type: Schema.Types.ObjectId,
            ref: 'Vendor',
            required: true,
            index: true
        },
        variantId: {
            type: Schema.Types.ObjectId,
            ref: 'Variant',
            required: true,
            index: true
        },
        date: {
            type: Date,
            required: true
        },
        sku: {
            type: String,
            required: true
        },
        productTitle: {
            type: String,
            required: true
        },
        variantTitle: {
            type: String
        },
        revenue: {
            type: Number,
            required: true,
            default: 0
        },
        quantity: {
            type: Number,
            required: true,
            default: 0
        },
        orderCount: {
            type: Number,
            required: true,
            default: 0
        },
        lastCalculatedAt: {
            type: Date,
            required: true
        },
        aggregationVersion: {
            type: Number,
            required: true,
            default: 1
        }
    },
    {
        timestamps: false // We manage lastCalculatedAt explicitly
    }
);

/**
 * Indexes for efficient queries
 */
// Primary pattern: unique per vendor, date, variant
VendorVariantDailyMetricsSchema.index(
    { vendorId: 1, date: 1, variantId: 1 },
    { unique: true }
);

// Top by revenue query
VendorVariantDailyMetricsSchema.index({ vendorId: 1, date: 1, revenue: -1 });

// Top by quantity query
VendorVariantDailyMetricsSchema.index({ vendorId: 1, date: 1, quantity: -1 });

export const VendorVariantDailyMetricsModel = mongoose.model<IVendorVariantDailyMetrics>(
    'VendorVariantDailyMetrics',
    VendorVariantDailyMetricsSchema
);
