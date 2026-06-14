import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * VendorDailyMetrics - Daily aggregation table for vendor analytics
 * 
 * CRITICAL DESIGN PRINCIPLES:
 * - Immutable snapshots: Metrics for a day never change retroactively
 * - Timezone-aware: Date boundaries calculated in vendor's timezone
 * - Refund grouping: Refunds grouped by completedAt date, NOT original order date
 * - Versioned: aggregationVersion enables future metric definition changes
 * 
 * PERFORMANCE:
 * - Pre-aggregated data for O(n_days) API queries
 * - No runtime joins with transactional tables
 * - Vendor-scoped indexes for fast lookups
 */

export interface ISalesMetrics {
    gmv: number;                          // Gross Merchandise Value (sum of paid orders at aggregation time)
    refunds: number;                      // Sum of completed refunds for this day (by completedAt)
    netRevenue: number;                   // GMV - refunds (may be negative if refunds > GMV)
    orderCount: number;                   // Count of paid orders at aggregation time (immutable)
    aov: number;                          // Average Order Value (netRevenue / orderCount)
}

export interface IBookingMetrics {
    count: number;                        // Total bookings (immutable count at aggregation time)
    revenue: number;                      // Sum of booking payments
    refunds: number;                      // Sum of booking refunds
    netRevenue: number;                   // revenue - refunds
    conversionRate: number;               // Confirmed / total (%)
    cancellationRate: number;             // Cancelled / total (%)
}

export interface ICustomerMetrics {
    total: number;                        // Total unique customers (with paid orders)
    repeat: number;                       // Customers with ≥2 completed orders
    repeatRate: number;                   // (repeat / total) * 100
}

export interface IVendorDailyMetrics extends Document {
    vendorId: mongoose.Types.ObjectId;    // Vendor owner
    date: Date;                           // YYYY-MM-DD (vendor timezone)
    timezone: string;                     // Timezone used for date boundary (IANA)
    fiscalCalendar: 'gregorian';          // LOCKED to 'gregorian' only

    sales: ISalesMetrics;
    bookings: IBookingMetrics;
    customers: ICustomerMetrics;

    /**
     * CRITICAL: lastCalculatedAt Semantics
     * - Timestamp when THIS specific daily aggregation was last computed
     * - Per-day, per-vendor granularity
     * - Used for: idempotency checks, staleness detection, API response metadata
     * - API returns: max(lastCalculatedAt) across all days in requested range
     */
    lastCalculatedAt: Date;

    /**
     * Aggregation versioning for future-proofing
     * - Version 1: Initial implementation (GMV, refunds, net revenue)
     * - Increment when metric definitions change
     * - Enables historical recalculation and migration tracking
     */
    aggregationVersion: number;
}

const SalesMetricsSchema = new Schema<ISalesMetrics>(
    {
        gmv: { type: Number, required: true, default: 0 },
        refunds: { type: Number, required: true, default: 0 },
        netRevenue: { type: Number, required: true, default: 0 },
        orderCount: { type: Number, required: true, default: 0 },
        aov: { type: Number, required: true, default: 0 }
    },
    { _id: false }
);

const BookingMetricsSchema = new Schema<IBookingMetrics>(
    {
        count: { type: Number, required: true, default: 0 },
        revenue: { type: Number, required: true, default: 0 },
        refunds: { type: Number, required: true, default: 0 },
        netRevenue: { type: Number, required: true, default: 0 },
        conversionRate: { type: Number, required: true, default: 0 },
        cancellationRate: { type: Number, required: true, default: 0 }
    },
    { _id: false }
);

const CustomerMetricsSchema = new Schema<ICustomerMetrics>(
    {
        total: { type: Number, required: true, default: 0 },
        repeat: { type: Number, required: true, default: 0 },
        repeatRate: { type: Number, required: true, default: 0 }
    },
    { _id: false }
);

const VendorDailyMetricsSchema = new Schema<IVendorDailyMetrics>(
    {
        vendorId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.VENDOR,
            required: true,
            index: true
        },
        date: {
            type: Date,
            required: true
        },
        timezone: {
            type: String,
            required: true
        },
        fiscalCalendar: {
            type: String,
            enum: ['gregorian'],
            required: true,
            default: 'gregorian'
        },
        sales: {
            type: SalesMetricsSchema,
            required: true
        },
        bookings: {
            type: BookingMetricsSchema,
            required: true
        },
        customers: {
            type: CustomerMetricsSchema,
            required: true
        },
        lastCalculatedAt: {
            type: Date,
            required: true,
            index: true // For identifying stale aggregations
        },
        aggregationVersion: {
            type: Number,
            required: true,
            default: 1,
            index: true // For future migration support
        }
    },
    {
        timestamps: false // We manage lastCalculatedAt explicitly
    }
);

/**
 * Indexes for efficient queries
 */
// Primary query pattern: vendor + date range
VendorDailyMetricsSchema.index({ vendorId: 1, date: 1 }, { unique: true });

// Staleness detection
// VendorDailyMetricsSchema.index({ lastCalculatedAt: 1 });

// Versioning (future migration support)
// VendorDailyMetricsSchema.index({ aggregationVersion: 1 });

export const VendorDailyMetricsModel = mongoose.model<IVendorDailyMetrics>(MODELS.VENDOR_DAILY_METRICS, VendorDailyMetricsSchema, COLLECTIONS.VENDOR_DAILY_METRICS);
