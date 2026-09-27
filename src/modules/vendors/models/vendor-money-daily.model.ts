import mongoose, { Schema, Document } from 'mongoose';
import { COLLECTIONS, MODELS } from '../../../core/database/collections';

/**
 * One FINISHED day of a vendor's money, pre-computed at night so the dashboard does little
 * work while people are using the platform (owner decision, 2026-09-27).
 *
 * ── Why a finished day can be stored safely (and why the old snapshot could not) ─
 * The old `vendor_daily_metrics` dated a sale by ORDER PLACEMENT and counted it only if it was
 * "paid" at 02:00 — so anything settled later (every COD order) was lost forever. Here a sale is
 * dated by the allocation's `created_at`, i.e. when the money ARRIVED, and allocations are never
 * back-dated or re-amounted; reversals are dated by `reversed_at` and refunds by `completedAt`.
 * So once a local day has ended, nothing can change it. The nightly worker still recomputes the
 * last two days, as margin for a transaction that committed across midnight.
 *
 * ── Why orders and lines are LISTS, not counts ────────────────────────────────
 * Money sums across days; "distinct orders", "distinct customers" and "units per product" do
 * not — a COD order collected on two days would be counted twice. So each day keeps the ids,
 * and the reader de-duplicates across the requested range. Same answer as a live computation,
 * which is what `test:vendor-analytics` pins.
 *
 * `day` is a `YYYY-MM-DD` STRING in `timezone`, never a Date: the old model keyed days by
 * timestamp and a cron row and a backfill row for the same day became two rows.
 *
 * A row with `vendor_id: null` is a COVERAGE MARKER: "the nightly job has computed every vendor
 * in this timezone for this day". A covered day with no vendor row is a genuine zero, and the
 * reader need not compute it live.
 */

export interface MoneyTotals {
    grossSales: number;
    bargainFee: number;
    commission: number;
    deliveryFee: number | null;
    codFee: number | null;
    deliveryAndCodFees: number;
    netRevenue: number;
}

export interface DayLine {
    orderId: string;
    variantId: string;
    productId: string;
    title: string;
    sku: string | null;
    quantity: number;
    revenue: number;
}

export interface DayFacts {
    day: string;
    sales: MoneyTotals;
    orders: { orderId: string; customerId: string }[];
    lines: DayLine[];
    bookings: { count: number; grossRevenue: number; commission: number; netRevenue: number };
    adjustments: { deliveryFeesReturned: number; earningsReversed: number };
    refunds: { count: number; amount: number };
    currency: string | null;
}

export interface IVendorMoneyDaily extends Document, DayFacts {
    vendor_id: mongoose.Types.ObjectId | null;
    timezone: string;
    computed_at: Date;
}

const schema = new Schema<IVendorMoneyDaily>(
    {
        vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, default: null },
        day: { type: String, required: true },
        timezone: { type: String, required: true },
        sales: { type: Schema.Types.Mixed, default: null },
        orders: { type: [{ orderId: String, customerId: String, _id: false }], default: [] },
        lines: { type: Schema.Types.Mixed, default: [] },
        bookings: { type: Schema.Types.Mixed, default: null },
        adjustments: { type: Schema.Types.Mixed, default: null },
        refunds: { type: Schema.Types.Mixed, default: null },
        currency: { type: String, default: null },
        computed_at: { type: Date, required: true },
    },
    { versionKey: false }
);

// One row per (vendor | coverage marker, day, timezone). The reader's range query is this index.
schema.index({ vendor_id: 1, timezone: 1, day: 1 }, { unique: true });

export const VendorMoneyDailyModel = mongoose.model<IVendorMoneyDaily>(
    MODELS.VENDOR_MONEY_DAILY,
    schema,
    COLLECTIONS.VENDOR_MONEY_DAILY
);
