import { VendorDailyMetricsModel, IVendorDailyMetrics } from '../models/vendor-daily-metrics.model';

/**
 * VendorDailyMetricsRepository - Data access layer for daily aggregations
 * 
 * Implements repository pattern for clean separation of concerns
 */

export class VendorDailyMetricsRepository {
    /**
     * Upsert daily metrics for a vendor
     */
    async upsert(
        vendorId: string,
        date: Date,
        metrics: Partial<IVendorDailyMetrics>
    ): Promise<IVendorDailyMetrics> {
        const result = await VendorDailyMetricsModel.findOneAndUpdate(
            { vendorId, date },
            {
                ...metrics,
                vendorId,
                date,
                lastCalculatedAt: new Date()
            },
            { upsert: true, new: true }
        );

        return result!;
    }

    /**
     * Find metrics by vendor and date range
     */
    async findByVendorAndDateRange(
        vendorId: string,
        from: Date,
        to: Date
    ): Promise<IVendorDailyMetrics[]> {
        return await VendorDailyMetricsModel.find({
            vendorId,
            date: { $gte: from, $lte: to }
        }).sort({ date: 1 });
    }

    /**
     * Find a single daily metric record
     */
    async findOne(
        vendorId: string,
        date: Date
    ): Promise<IVendorDailyMetrics | null> {
        return await VendorDailyMetricsModel.findOne({ vendorId, date });
    }

    /**
     * Find stale aggregations (for maintenance/recalculation)
     */
    async findStaleAggregations(olderThan: Date): Promise<IVendorDailyMetrics[]> {
        return await VendorDailyMetricsModel.find({
            lastCalculatedAt: { $lt: olderThan }
        });
    }
}
