import { VendorDailyMetricsRepository } from '../repositories/vendor-daily-metrics.repository';
import { VendorVariantDailyMetricsRepository } from '../repositories/vendor-variant-daily-metrics.repository';
import { AggregationNotReadyError } from '../../../core/errors';

/**
 * VendorAnalyticsService - Read-only analytics query service
 * 
 * CRITICAL: Explicit data availability contracts
 * - Throws AggregationNotReadyError if no data exists (no silent zeros)
 * - Returns max(lastCalculatedAt) across requested range
 * - All responses include fiscalCalendar: 'gregorian' in meta
 */

interface IDateRange {
    from: Date;
    to: Date;
}

export class VendorAnalyticsService {
    private metricsRepo: VendorDailyMetricsRepository;
    private variantMetricsRepo: VendorVariantDailyMetricsRepository;

    constructor() {
        this.metricsRepo = new VendorDailyMetricsRepository();
        this.variantMetricsRepo = new VendorVariantDailyMetricsRepository();
    }

    /**
     * Get dashboard overview metrics (aggregated across date range)
     */
    async getDashboardMetrics(vendorId: string, range: IDateRange) {
        const dailyMetrics = await this.metricsRepo.findByVendorAndDateRange(
            vendorId,
            range.from,
            range.to
        );

        // Explicit data availability contract
        if (!dailyMetrics || dailyMetrics.length === 0) {
            throw new AggregationNotReadyError(
                `No analytics data available for vendor ${vendorId} in range ${range.from.toISOString().split('T')[0]} to ${range.to.toISOString().split('T')[0]}. ` +
                `Aggregation may not have run yet or vendor has no data for this period.`
            );
        }

        // Aggregate across all days
        const totals = dailyMetrics.reduce(
            (acc, day) => ({
                gmv: acc.gmv + day.sales.gmv,
                refunds: acc.refunds + day.sales.refunds,
                netRevenue: acc.netRevenue + day.sales.netRevenue,
                orderCount: acc.orderCount + day.sales.orderCount,
                bookingCount: acc.bookingCount + day.bookings.count,
                bookingRevenue: acc.bookingRevenue + day.bookings.netRevenue
            }),
            { gmv: 0, refunds: 0, netRevenue: 0, orderCount: 0, bookingCount: 0, bookingRevenue: 0 }
        );

        // Calculate lastCalculatedAt (max of range)
        const lastCalculatedAt = new Date(
            Math.max(...dailyMetrics.map(d => d.lastCalculatedAt.getTime()))
        );

        return {
            data: {
                sales: {
                    gmv: totals.gmv,
                    refunds: totals.refunds,
                    netRevenue: totals.netRevenue,
                    orderCount: totals.orderCount,
                    aov: totals.orderCount > 0 ? totals.netRevenue / totals.orderCount : 0
                },
                bookings: {
                    count: totals.bookingCount,
                    revenue: totals.bookingRevenue
                }
            },
            meta: {
                from: range.from.toISOString(),
                to: range.to.toISOString(),
                lastCalculatedAt: lastCalculatedAt.toISOString(),
                fiscalCalendar: 'gregorian' as const
            }
        };
    }

    /**
     * Get sales metrics with optional daily breakdown
     */
    async getSalesMetrics(
        vendorId: string,
        range: IDateRange,
        breakdown: boolean = false
    ) {
        const dailyMetrics = await this.metricsRepo.findByVendorAndDateRange(
            vendorId,
            range.from,
            range.to
        );

        if (!dailyMetrics || dailyMetrics.length === 0) {
            throw new AggregationNotReadyError(
                `No sales data available for vendor ${vendorId} in range ${range.from.toISOString().split('T')[0]} to ${range.to.toISOString().split('T')[0]}.`
            );
        }

        const lastCalculatedAt = new Date(
            Math.max(...dailyMetrics.map(d => d.lastCalculatedAt.getTime()))
        );

        if (breakdown) {
            // Return daily breakdown
            return {
                data: {
                    daily: dailyMetrics.map(day => ({
                        date: day.date.toISOString().split('T')[0],
                        gmv: day.sales.gmv,
                        refunds: day.sales.refunds,
                        netRevenue: day.sales.netRevenue,
                        orderCount: day.sales.orderCount,
                        aov: day.sales.aov
                    }))
                },
                meta: {
                    from: range.from.toISOString(),
                    to: range.to.toISOString(),
                    lastCalculatedAt: lastCalculatedAt.toISOString(),
                    fiscalCalendar: 'gregorian' as const
                }
            };
        } else {
            // Return aggregated totals
            const totals = dailyMetrics.reduce(
                (acc, day) => ({
                    gmv: acc.gmv + day.sales.gmv,
                    refunds: acc.refunds + day.sales.refunds,
                    netRevenue: acc.netRevenue + day.sales.netRevenue,
                    orderCount: acc.orderCount + day.sales.orderCount
                }),
                { gmv: 0, refunds: 0, netRevenue: 0, orderCount: 0 }
            );

            return {
                data: {
                    gmv: totals.gmv,
                    refunds: totals.refunds,
                    netRevenue: totals.netRevenue,
                    orderCount: totals.orderCount,
                    aov: totals.orderCount > 0 ? totals.netRevenue / totals.orderCount : 0
                },
                meta: {
                    from: range.from.toISOString(),
                    to: range.to.toISOString(),
                    lastCalculatedAt: lastCalculatedAt.toISOString(),
                    fiscalCalendar: 'gregorian' as const
                }
            };
        }
    }

    /**
     * Get product performance metrics (top N by revenue or quantity)
     */
    async getProductMetrics(
        vendorId: string,
        range: IDateRange,
        limit: number = 5
    ) {
        const topByRevenue = await this.variantMetricsRepo.findTopByRevenue(
            vendorId,
            range.from,
            range.to,
            limit
        );

        const topByQuantity = await this.variantMetricsRepo.findTopByQuantity(
            vendorId,
            range.from,
            range.to,
            limit
        );

        if (topByRevenue.length === 0 && topByQuantity.length === 0) {
            throw new AggregationNotReadyError(
                `No product data available for vendor ${vendorId} in range ${range.from.toISOString().split('T')[0]} to ${range.to.toISOString().split('T')[0]}.`
            );
        }

        return {
            data: {
                topByRevenue,
                topByQuantity
            },
            meta: {
                from: range.from.toISOString(),
                to: range.to.toISOString(),
                limit,
                fiscalCalendar: 'gregorian' as const
            }
        };
    }

    /**
     * Get customer metrics
     */
    async getCustomerMetrics(vendorId: string, range: IDateRange) {
        const dailyMetrics = await this.metricsRepo.findByVendorAndDateRange(
            vendorId,
            range.from,
            range.to
        );

        if (!dailyMetrics || dailyMetrics.length === 0) {
            throw new AggregationNotReadyError(
                `No customer data available for vendor ${vendorId} in range ${range.from.toISOString().split('T')[0]} to ${range.to.toISOString().split('T')[0]}.`
            );
        }

        // Aggregate customer metrics
        const totals = dailyMetrics.reduce(
            (acc, day) => ({
                total: acc.total + day.customers.total,
                repeat: acc.repeat + day.customers.repeat
            }),
            { total: 0, repeat: 0 }
        );

        const repeatRate = totals.total > 0 ? (totals.repeat / totals.total) * 100 : 0;

        const lastCalculatedAt = new Date(
            Math.max(...dailyMetrics.map(d => d.lastCalculatedAt.getTime()))
        );

        return {
            data: {
                total: totals.total,
                repeat: totals.repeat,
                repeatRate
            },
            meta: {
                from: range.from.toISOString(),
                to: range.to.toISOString(),
                lastCalculatedAt: lastCalculatedAt.toISOString(),
                fiscalCalendar: 'gregorian' as const
            }
        };
    }
}
