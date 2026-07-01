import { VendorDailyMetricsRepository } from '../repositories/vendor-daily-metrics.repository';
import { VendorVariantDailyMetricsRepository } from '../repositories/vendor-variant-daily-metrics.repository';
import { getDateBoundaries } from '../utils/timezone.util';
import { OrderModel } from '../../orders/order.model';
import { RefundTransactionModel } from '../../payments/models/refund-transaction.model';
import { Booking } from '../../booking/models/booking.model';
import { BookingStatus } from '../../booking/types/booking.types';
import { Types } from 'mongoose';

/**
 * VendorAnalyticsAggregationService - Daily metrics aggregation
 * 
 * CRITICAL PRINCIPLES:
 * - Idempotency: 6-hour threshold prevents double aggregation
 * - Immutability: GMV/orderCount never change retroactively
 * - Timezone-aware: Date boundaries calculated in vendor's timezone
 * - Refund grouping: By completedAt, not original order date
 */

const RECALC_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

export class VendorAnalyticsAggregationService {
    private metricsRepo: VendorDailyMetricsRepository;
    private variantMetricsRepo: VendorVariantDailyMetricsRepository;

    constructor() {
        this.metricsRepo = new VendorDailyMetricsRepository();
        this.variantMetricsRepo = new VendorVariantDailyMetricsRepository();
    }

    /**
     * Aggregate daily metrics for a vendor on a specific date
     * 
     * @param vendorId - Vendor ObjectId
     * @param date - Date to aggregate (YYYY-MM-DD in vendor timezone)
     * @param timezone - Vendor's timezone (IANA)
     * @param force - Force recalculation even if recently aggregated
     */
    async aggregateDailyMetrics(
        vendorId: string,
        date: Date,
        timezone: string,
        force: boolean = false
    ): Promise<void> {
        // Idempotency guard: check if recently aggregated
        if (!force) {
            const existing = await this.metricsRepo.findOne(vendorId, date);
            if (existing && existing.lastCalculatedAt) {
                const timeSinceLastCalc = Date.now() - existing.lastCalculatedAt.getTime();
                if (timeSinceLastCalc < RECALC_THRESHOLD_MS) {
                    console.log(
                        `[Aggregation] Skipping recent aggregation for vendor ${vendorId} on ${date.toISOString().split('T')[0]} ` +
                        `(last calculated ${Math.round(timeSinceLastCalc / 1000 / 60)} minutes ago)`
                    );
                    return;
                }
            }
        }

        console.log(`[Aggregation] Starting aggregation for vendor ${vendorId} on ${date.toISOString().split('T')[0]}`);

        // Calculate timezone-aware date boundaries
        const { start, end } = getDateBoundaries(date, timezone);

        // Aggregate sales metrics
        const salesMetrics = await this.aggregateSalesMetrics(vendorId, start, end);

        // Aggregate booking metrics
        const bookingMetrics = await this.aggregateBookingMetrics(vendorId, start, end);

        // Aggregate customer metrics
        const customerMetrics = await this.aggregateCustomerMetrics(vendorId, start, end);

        // Aggregate variant metrics (separate table)
        await this.aggregateVariantMetrics(vendorId, date, start, end);

        // Upsert daily metrics
        await this.metricsRepo.upsert(vendorId, date, {
            timezone,
            fiscalCalendar: 'gregorian',
            sales: salesMetrics,
            bookings: bookingMetrics,
            customers: customerMetrics,
            aggregationVersion: 1
        } as any);

        console.log(`[Aggregation] Completed aggregation for vendor ${vendorId} on ${date.toISOString().split('T')[0]}`);
    }

    /**
     * Aggregate sales metrics
     * 
     * CRITICAL: GMV = sum of paid orders at aggregation time (immutable)
     * Refunds grouped by completedAt, not original order date
     */
    private async aggregateSalesMetrics(
        vendorId: string,
        start: Date,
        end: Date
    ) {
        const vendorObjectId = new Types.ObjectId(vendorId);

        // Query orders with payment_status = 'paid' (snapshot at aggregation time)
        const paidOrders = await OrderModel.find({
            vendor_id: vendorObjectId,
            created_at: { $gte: start, $lte: end },
            payment_status: 'paid'
        });

        // Calculate GMV (no retroactive exclusions)
        const gmv = paidOrders.reduce((sum, order) => sum + order.total_amount, 0);
        const orderCount = paidOrders.length;

        // Query refunds completed on this day
        const completedRefunds = await RefundTransactionModel.find({
            vendorId: vendorObjectId,
            status: 'completed',
            completedAt: { $gte: start, $lte: end }
        });

        const refunds = completedRefunds.reduce((sum, refund) => sum + refund.refundAmount, 0);

        // Calculate net revenue
        const netRevenue = gmv - refunds;

        // Calculate AOV
        const aov = orderCount > 0 ? netRevenue / orderCount : 0;

        return {
            gmv,
            refunds,
            netRevenue,
            orderCount,
            aov
        };
    }

    /**
     * Aggregate booking metrics
     *
     * Grouped by booking createdAt (immutable snapshot of bookings made this day),
     * consistent with how sales groups paid orders by created_at.
     *
     * - revenue: sum(priceSnapshot) where paymentStatus = 'paid'
     * - refunds: sum(priceSnapshot) where paymentStatus = 'refunded'
     * - conversionRate: (confirmed + completed) / count
     * - cancellationRate: (cancelled + no-show) / count
     */
    private async aggregateBookingMetrics(
        vendorId: string,
        start: Date,
        end: Date
    ) {
        const vendorObjectId = new Types.ObjectId(vendorId);

        const [totals] = await Booking.aggregate([
            {
                $match: {
                    vendorId: vendorObjectId,
                    createdAt: { $gte: start, $lte: end },
                    deletedAt: null
                }
            },
            {
                $group: {
                    _id: null,
                    count: { $sum: 1 },
                    revenue: {
                        $sum: {
                            $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$priceSnapshot', 0]
                        }
                    },
                    refunds: {
                        $sum: {
                            $cond: [{ $eq: ['$paymentStatus', 'refunded'] }, '$priceSnapshot', 0]
                        }
                    },
                    confirmedCount: {
                        $sum: {
                            $cond: [
                                { $in: ['$status', [BookingStatus.CONFIRMED, BookingStatus.COMPLETED]] },
                                1,
                                0
                            ]
                        }
                    },
                    cancelledCount: {
                        $sum: {
                            $cond: [
                                { $in: ['$status', [BookingStatus.CANCELLED, BookingStatus.NO_SHOW]] },
                                1,
                                0
                            ]
                        }
                    }
                }
            }
        ]);

        if (!totals || totals.count === 0) {
            return {
                count: 0,
                revenue: 0,
                refunds: 0,
                netRevenue: 0,
                conversionRate: 0,
                cancellationRate: 0
            };
        }

        const netRevenue = totals.revenue - totals.refunds;
        const conversionRate = (totals.confirmedCount / totals.count) * 100;
        const cancellationRate = (totals.cancelledCount / totals.count) * 100;

        return {
            count: totals.count,
            revenue: totals.revenue,
            refunds: totals.refunds,
            netRevenue,
            conversionRate,
            cancellationRate
        };
    }

    /**
     * Aggregate customer metrics
     */
    private async aggregateCustomerMetrics(
        vendorId: string,
        start: Date,
        end: Date
    ) {
        const vendorObjectId = new Types.ObjectId(vendorId);

        // Find all paid orders in this period
        const paidOrders = await OrderModel.find({
            vendor_id: vendorObjectId,
            created_at: { $gte: start, $lte: end },
            payment_status: 'paid'
        }).select('customer_id');

        // Get unique customers
        const uniqueCustomers = new Set(paidOrders.map(o => o.customer_id.toString()));
        const total = uniqueCustomers.size;

        // Find repeat customers (customers with ≥2 completed orders EVER)
        if (total === 0) {
            return { total: 0, repeat: 0, repeatRate: 0 };
        }

        const customerIds = Array.from(uniqueCustomers).map(id => new Types.ObjectId(id));

        const repeatCustomers = await OrderModel.aggregate([
            {
                $match: {
                    vendor_id: vendorObjectId,
                    customer_id: { $in: customerIds },
                    payment_status: 'paid'
                }
            },
            {
                $group: {
                    _id: '$customer_id',
                    orderCount: { $sum: 1 }
                }
            },
            {
                $match: {
                    orderCount: { $gte: 2 }
                }
            }
        ]);

        const repeat = repeatCustomers.length;
        const repeatRate = total > 0 ? (repeat / total) * 100 : 0;

        return {
            total,
            repeat,
            repeatRate
        };
    }

    /**
     * Aggregate variant metrics (stored in separate table)
     */
    private async aggregateVariantMetrics(
        vendorId: string,
        date: Date,
        start: Date,
        end: Date
    ) {
        const vendorObjectId = new Types.ObjectId(vendorId);

        // Aggregate per-variant metrics from order items
        const variantMetrics = await OrderModel.aggregate([
            {
                $match: {
                    vendor_id: vendorObjectId,
                    created_at: { $gte: start, $lte: end },
                    payment_status: 'paid'
                }
            },
            { $unwind: '$items' },
            {
                $group: {
                    _id: '$items.variant_id',
                    revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
                    quantity: { $sum: '$items.quantity' },
                    orderCount: { $sum: 1 },
                    // Denormalize variant identity
                    sku: { $first: '$items.sku' },
                    productTitle: { $first: '$items.product_title' },
                    variantTitle: { $first: '$items.variant_title' }
                }
            }
        ]);

        // Map to repository input format
        const variantInputs = variantMetrics.map(v => ({
            variantId: v._id.toString(),
            sku: v.sku || 'UNKNOWN',
            productTitle: v.productTitle || 'Unknown Product',
            variantTitle: v.variantTitle,
            revenue: v.revenue,
            quantity: v.quantity,
            orderCount: v.orderCount
        }));

        // Bulk upsert to VendorVariantDailyMetrics
        if (variantInputs.length > 0) {
            await this.variantMetricsRepo.upsertVariantMetrics(vendorId, date, variantInputs);
        }
    }
}
