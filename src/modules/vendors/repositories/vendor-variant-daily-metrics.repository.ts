import { VendorVariantDailyMetricsModel, IVendorVariantDailyMetrics } from '../models/vendor-variant-daily-metrics.model';
import { Types } from 'mongoose';

/**
 * VendorVariantDailyMetricsRepository - Data access for variant-level metrics
 * 
 * Enables flexible top-N queries without schema migrations
 */

interface IVariantMetricsInput {
    variantId: string;
    sku: string;
    productTitle: string;
    variantTitle?: string;
    revenue: number;
    quantity: number;
    orderCount: number;
}

export class VendorVariantDailyMetricsRepository {
    /**
     * Upsert variant metrics for a specific day (bulk operation)
     */
    async upsertVariantMetrics(
        vendorId: string,
        date: Date,
        variantMetrics: IVariantMetricsInput[]
    ): Promise<void> {
        const bulkOps = variantMetrics.map(variant => ({
            updateOne: {
                filter: {
                    vendorId: new Types.ObjectId(vendorId),
                    date,
                    variantId: new Types.ObjectId(variant.variantId)
                },
                update: {
                    $set: {
                        ...variant,
                        variantId: new Types.ObjectId(variant.variantId),
                        vendorId: new Types.ObjectId(vendorId),
                        date,
                        lastCalculatedAt: new Date(),
                        aggregationVersion: 1
                    }
                },
                upsert: true
            }
        }));

        if (bulkOps.length > 0) {
            await VendorVariantDailyMetricsModel.bulkWrite(bulkOps);
        }
    }

    /**
     * Find top variants by revenue (aggregated across date range)
     */
    async findTopByRevenue(
        vendorId: string,
        from: Date,
        to: Date,
        limit: number = 5
    ): Promise<IVendorVariantDailyMetrics[]> {
        return await VendorVariantDailyMetricsModel.aggregate([
            {
                $match: {
                    vendorId: new Types.ObjectId(vendorId),
                    date: { $gte: from, $lte: to }
                }
            },
            {
                $group: {
                    _id: '$variantId',
                    sku: { $first: '$sku' },
                    productTitle: { $first: '$productTitle' },
                    variantTitle: { $first: '$variantTitle' },
                    revenue: { $sum: '$revenue' },
                    quantity: { $sum: '$quantity' },
                    orderCount: { $sum: '$orderCount' }
                }
            },
            {
                $sort: { revenue: -1 }
            },
            {
                $limit: limit
            },
            {
                $project: {
                    variantId: '$_id',
                    sku: 1,
                    productTitle: 1,
                    variantTitle: 1,
                    revenue: 1,
                    quantity: 1,
                    _id: 0
                }
            }
        ]);
    }

    /**
     * Find top variants by quantity (aggregated across date range)
     */
    async findTopByQuantity(
        vendorId: string,
        from: Date,
        to: Date,
        limit: number = 5
    ): Promise<IVendorVariantDailyMetrics[]> {
        return await VendorVariantDailyMetricsModel.aggregate([
            {
                $match: {
                    vendorId: new Types.ObjectId(vendorId),
                    date: { $gte: from, $lte: to }
                }
            },
            {
                $group: {
                    _id: '$variantId',
                    sku: { $first: '$sku' },
                    productTitle: { $first: '$productTitle' },
                    variantTitle: { $first: '$variantTitle' },
                    revenue: { $sum: '$revenue' },
                    quantity: { $sum: '$quantity' },
                    orderCount: { $sum: '$orderCount' }
                }
            },
            {
                $sort: { quantity: -1 }
            },
            {
                $limit: limit
            },
            {
                $project: {
                    variantId: '$_id',
                    sku: 1,
                    productTitle: 1,
                    variantTitle: 1,
                    revenue: 1,
                    quantity: 1,
                    _id: 0
                }
            }
        ]);
    }

    /**
     * Find variant metrics by vendor and date range (all variants)
     */
    async findByVendorAndDateRange(
        vendorId: string,
        from: Date,
        to: Date
    ): Promise<IVendorVariantDailyMetrics[]> {
        return await VendorVariantDailyMetricsModel.find({
            vendorId: new Types.ObjectId(vendorId),
            date: { $gte: from, $lte: to }
        });
    }
}
