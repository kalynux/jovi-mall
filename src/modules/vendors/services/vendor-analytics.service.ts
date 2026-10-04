import { Types } from 'mongoose';
import { EarningsAllocationModel } from '../../earnings/models/earnings-allocation.model';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { customerDeliveryFeeOf, deliveryFeeShares } from '../../orders/domain/delivery-payer';
import { OrderModel } from '../../orders/order.model';
import { RefundTransactionModel } from '../../payments/models/refund-transaction.model';
import {
    AnalyticsPeriod,
    NET_FORMULA,
    VendorSaleBreakdown,
    daysOf,
    localDay,
    toAnalyticsPeriod,
    vendorSaleBreakdown,
} from '../analytics/net-revenue';
import { DayFacts, DayLine, MoneyTotals, VendorMoneyDailyModel } from '../models/vendor-money-daily.model';

/**
 * Vendor analytics — rebuilt 2026-09-27 on the earnings allocations.
 *
 * ── The numbers ───────────────────────────────────────────────────────────────
 *  - **A sale is dated when the money was RECEIVED** (owner decision O-2): the allocation's
 *    `created_at` — the split runs at payment for a prepaid order and at collection for COD.
 *  - **Net revenue is what reached the wallet** (O-1): the vendor allocation, every deduction
 *    read from its sibling allocations — see `analytics/net-revenue.ts`.
 *  - **An empty period is zeros, not a 503.**
 *
 * ── Where the work happens (owner decision, 2026-09-27) ───────────────────────
 * FINISHED days are computed at night by the `analytics-aggregation` worker and stored in
 * `vendor_money_daily`; a dashboard read loads those rows and computes only what is not stored
 * — normally just TODAY — live. That keeps the heavy part off the daytime path. It is safe
 * because a finished day cannot change (see the model's header). A day the job has not covered
 * yet (first deploy, a timezone the vendor just switched to) is simply computed live: the store
 * is an optimisation, never a source of different numbers. The old `vendor_daily_metrics` rows
 * are neither written nor read any more.
 *
 * Record: `PRODUCTION-READINESS/ACCOUNT-STATEMENTS-AND-ANALYTICS-PLAN.md`.
 */

type Id = Types.ObjectId;

interface AllocationLean {
    _id: Id;
    source_type: 'order' | 'booking' | 'cod_collection' | 'shipment';
    source_id: Id;
    beneficiary_type: string;
    gross_snapshot: number;
    amount: number;
    currency: string;
    created_at: Date;
    reversed_at?: Date | null;
}

export interface SaleFact {
    orderId: string;
    sourceType: 'order' | 'cod_collection';
    receivedAt: Date;
    breakdown: VendorSaleBreakdown;
}

interface VendorMoney {
    sales: SaleFact[];
    bookings: { receivedAt: Date; gross: number; commission: number; net: number }[];
    deliveryCredits: { at: Date; amount: number }[];
    reversals: { at: Date; amount: number }[];
    currency: string | null;
}

const sum = <T>(rows: T[], pick: (row: T) => number | null) => rows.reduce((s, r) => s + (pick(r) ?? 0), 0);

export interface SalesTotals extends MoneyTotals {
    orderCount: number;
    /** Average GROSS per order — what a customer spent, not what the vendor kept. */
    aov: number;
}

/** Exported for `test:vendor-analytics`. */
export function totalsOf(sales: SaleFact[]): SalesTotals {
    const money = moneyOf(sales);
    const orderCount = new Set(sales.map((s) => s.orderId)).size;
    return { ...money, orderCount, aov: orderCount > 0 ? Math.round(money.grossSales / orderCount) : 0 };
}

function moneyOf(sales: SaleFact[]): MoneyTotals {
    const unsplit = sales.some((s) => s.breakdown.deliveryFee === null);
    return {
        grossSales: sum(sales, (s) => s.breakdown.gross),
        bargainFee: sum(sales, (s) => s.breakdown.bargainFee),
        commission: sum(sales, (s) => s.breakdown.commission),
        deliveryFee: unsplit ? null : sum(sales, (s) => s.breakdown.deliveryFee),
        codFee: unsplit ? null : sum(sales, (s) => s.breakdown.codFee),
        deliveryAndCodFees: sum(sales, (s) => s.breakdown.deliveryAndCod),
        netRevenue: sum(sales, (s) => s.breakdown.net),
    };
}

/** Sum money totals across days; a `null` split on any day nulls the split. Exported for tests. */
export function addMoney(days: MoneyTotals[]): MoneyTotals {
    const unsplit = days.some((d) => d.deliveryFee === null || d.codFee === null);
    return {
        grossSales: sum(days, (d) => d.grossSales),
        bargainFee: sum(days, (d) => d.bargainFee),
        commission: sum(days, (d) => d.commission),
        deliveryFee: unsplit ? null : sum(days, (d) => d.deliveryFee),
        codFee: unsplit ? null : sum(days, (d) => d.codFee),
        deliveryAndCodFees: sum(days, (d) => d.deliveryAndCodFees),
        netRevenue: sum(days, (d) => d.netRevenue),
    };
}

/**
 * Merge per-day facts into one period's answer. Pure — exported for `test:vendor-analytics`,
 * which asserts that stored days and a live computation of the same days give the same totals.
 *
 * Orders, customers and product lines are DE-DUPLICATED across days: a COD order collected on
 * two days is one order, and its items are sold once.
 */
export function mergeFacts(days: DayFacts[]) {
    const orders = new Map<string, string>();
    for (const d of days) for (const o of d.orders) orders.set(o.orderId, o.customerId);
    const lines = new Map<string, DayLine>();
    for (const d of days) for (const l of d.lines) {
        const k = `${l.orderId}:${l.variantId}`;
        if (!lines.has(k)) lines.set(k, l);
    }
    const money = addMoney(days.map((d) => d.sales));
    const orderCount = orders.size;
    return {
        sales: { ...money, orderCount, aov: orderCount > 0 ? Math.round(money.grossSales / orderCount) : 0 } as SalesTotals,
        orders,
        lines: [...lines.values()],
        bookings: {
            count: sum(days, (d) => d.bookings.count),
            grossRevenue: sum(days, (d) => d.bookings.grossRevenue),
            commission: sum(days, (d) => d.bookings.commission),
            netRevenue: sum(days, (d) => d.bookings.netRevenue),
        },
        adjustments: {
            deliveryFeesReturned: sum(days, (d) => d.adjustments.deliveryFeesReturned),
            earningsReversed: sum(days, (d) => d.adjustments.earningsReversed),
        },
        refunds: { count: sum(days, (d) => d.refunds.count), amount: sum(days, (d) => d.refunds.amount) },
        currency: days.find((d) => d.currency)?.currency ?? null,
    };
}

export class VendorAnalyticsService {
    // ─────────────────────────────────────────────────────────────────────────
    // Computing facts from the source records
    // ─────────────────────────────────────────────────────────────────────────

    /** Every money movement onto this vendor's earnings in the period, with its breakdown. */
    async loadMoney(vendorId: string, period: Pick<AnalyticsPeriod, 'start' | 'end'>): Promise<VendorMoney> {
        const vendor = new Types.ObjectId(vendorId);
        const window = { $gte: period.start, $lt: period.end };

        const [created, reversed] = await Promise.all([
            EarningsAllocationModel.find({ beneficiary_type: 'vendor', beneficiary_id: vendor, created_at: window })
                .select('source_type source_id beneficiary_type gross_snapshot amount currency created_at')
                .lean<AllocationLean[]>(),
            EarningsAllocationModel.find({ beneficiary_type: 'vendor', beneficiary_id: vendor, reversed_at: window })
                .select('amount reversed_at')
                .lean<AllocationLean[]>(),
        ]);

        const saleRows = created.filter((a) => a.source_type === 'order' || a.source_type === 'cod_collection');
        const bookingRows = created.filter((a) => a.source_type === 'booking');
        const priced = [...saleRows, ...bookingRows];

        const byType = (type: string) => priced.filter((a) => a.source_type === type).map((a) => a.source_id);
        const [siblings, collections] = await Promise.all([
            priced.length
                ? EarningsAllocationModel.find({
                      beneficiary_type: { $in: ['platform', 'platform_ai'] },
                      $or: ['order', 'cod_collection', 'booking']
                          .map((t) => ({ source_type: t, source_id: { $in: byType(t) } }))
                          .filter((c) => c.source_id.$in.length > 0),
                  })
                      .select('source_type source_id beneficiary_type amount')
                      .lean<AllocationLean[]>()
                : Promise.resolve([] as AllocationLean[]),
            CashCollectionModel.find({ _id: { $in: byType('cod_collection') } })
                .select('order_id shipment_id')
                .lean<{ _id: Id; order_id: Id; shipment_id: Id }[]>(),
        ]);
        const shipments = await ShipmentModel.find({ _id: { $in: collections.map((c) => c.shipment_id) } })
            .select('delivery_fee_snapshot delivery_payer customer_delivery_fee')
            .lean<{
                _id: Id;
                delivery_fee_snapshot?: number | null;
                delivery_payer?: 'vendor' | 'customer' | null;
                customer_delivery_fee?: number | null;
            }[]>();

        const key = (type: string, id: Id) => `${type}:${id.toString()}`;
        const siblingAmount = new Map<string, number>();
        for (const s of siblings) {
            const k = `${key(s.source_type, s.source_id)}:${s.beneficiary_type}`;
            siblingAmount.set(k, (siblingAmount.get(k) ?? 0) + s.amount);
        }
        const collectionById = new Map(collections.map((c) => [c._id.toString(), c]));
        // The VENDOR-BORNE part of each fee (ADR-A11): the whole fee when the vendor pays, what
        // the customer's cash did not cover when the customer pays (normally 0). That — not the
        // agency's fee — is what the vendor allocation's residual contains, so NET_FORMULA's
        // `deliveryFee` term stays exact for both payers.
        const feeByShipment = new Map(
            shipments.map((s) => {
                const snapshot = s.delivery_fee_snapshot ?? null;
                if (snapshot === null) return [s._id.toString(), null] as const;
                const vendorBorne = deliveryFeeShares(snapshot, customerDeliveryFeeOf(null, s)).vendorBorne;
                return [s._id.toString(), vendorBorne] as const;
            }),
        );

        const sales: SaleFact[] = saleRows.map((a) => {
            const k = key(a.source_type, a.source_id);
            const collection = a.source_type === 'cod_collection' ? collectionById.get(a.source_id.toString()) : undefined;
            return {
                orderId: (collection ? collection.order_id : a.source_id).toString(),
                sourceType: a.source_type as 'order' | 'cod_collection',
                receivedAt: a.created_at,
                breakdown: vendorSaleBreakdown({
                    sourceType: a.source_type as 'order' | 'cod_collection',
                    gross: a.gross_snapshot,
                    net: a.amount,
                    commission: siblingAmount.get(`${k}:platform`) ?? 0,
                    bargainFee: siblingAmount.get(`${k}:platform_ai`) ?? 0,
                    deliveryFeeSnapshot: collection ? feeByShipment.get(collection.shipment_id.toString()) ?? null : null,
                }),
            };
        });

        return {
            sales,
            bookings: bookingRows.map((a) => ({
                receivedAt: a.created_at,
                gross: a.gross_snapshot,
                commission: siblingAmount.get(`${key('booking', a.source_id)}:platform`) ?? 0,
                net: a.amount,
            })),
            deliveryCredits: created.filter((a) => a.source_type === 'shipment').map((a) => ({ at: a.created_at, amount: a.amount })),
            reversals: reversed.filter((a) => a.reversed_at).map((a) => ({ at: a.reversed_at as Date, amount: a.amount })),
            currency: created[0]?.currency ?? null,
        };
    }

    /**
     * Per-day facts for every local day of `period`, computed from the source records. Used by the
     * nightly worker (to store) and by reads (for days not stored yet — normally only today).
     */
    async computeFacts(vendorId: string, period: AnalyticsPeriod): Promise<DayFacts[]> {
        const [money, refunds] = await Promise.all([
            this.loadMoney(vendorId, period),
            RefundTransactionModel.find({
                vendorId: new Types.ObjectId(vendorId),
                status: 'completed',
                completedAt: { $gte: period.start, $lt: period.end },
            })
                .select('refundAmount completedAt')
                .lean<{ refundAmount: number; completedAt: Date }[]>(),
        ]);

        const orderIds = [...new Set(money.sales.map((s) => s.orderId))].map((id) => new Types.ObjectId(id));
        const orders = orderIds.length
            ? await OrderModel.find({ _id: { $in: orderIds } })
                  .select('customer_id items.variant_id items.product_id items.title items.sku items.price items.quantity')
                  .lean<{
                      _id: Id;
                      customer_id: Id;
                      items: { variant_id: Id; product_id: Id; title?: string; sku?: string; price: number; quantity: number }[];
                  }[]>()
            : [];
        const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

        const tz = period.timezone;
        const dayOf = (d: Date) => localDay(d, tz);
        return daysOf(period).map((day) => {
            const sales = money.sales.filter((s) => dayOf(s.receivedAt) === day);
            const dayOrders = [...new Set(sales.map((s) => s.orderId))];
            const bookings = money.bookings.filter((b) => dayOf(b.receivedAt) === day);
            const dayRefunds = refunds.filter((r) => dayOf(r.completedAt) === day);
            return {
                day,
                sales: moneyOf(sales),
                orders: dayOrders.map((orderId) => ({
                    orderId,
                    customerId: orderById.get(orderId)?.customer_id.toString() ?? '',
                })),
                lines: dayOrders.flatMap((orderId) =>
                    (orderById.get(orderId)?.items ?? []).map((i) => ({
                        orderId,
                        variantId: i.variant_id.toString(),
                        productId: i.product_id?.toString() ?? '',
                        title: i.title ?? 'Untitled product',
                        sku: i.sku ?? null,
                        quantity: i.quantity,
                        revenue: i.price * i.quantity,
                    })),
                ),
                bookings: {
                    count: bookings.length,
                    grossRevenue: sum(bookings, (b) => b.gross),
                    commission: sum(bookings, (b) => b.commission),
                    netRevenue: sum(bookings, (b) => b.net),
                },
                adjustments: {
                    deliveryFeesReturned: sum(money.deliveryCredits.filter((c) => dayOf(c.at) === day), (c) => c.amount),
                    earningsReversed: sum(money.reversals.filter((r) => dayOf(r.at) === day), (r) => r.amount),
                },
                refunds: { count: dayRefunds.length, amount: sum(dayRefunds, (r) => r.refundAmount) },
                currency: money.currency,
            };
        });
    }

    /**
     * The facts for a period: stored finished days where the nightly job has them, the rest
     * computed live — normally only today. Never a different number from a fully live read.
     */
    async factsFor(vendorId: string, period: AnalyticsPeriod): Promise<DayFacts[]> {
        const today = localDay(new Date(), period.timezone);
        const days = daysOf(period);
        const finished = days.filter((d) => d < today);

        const [stored, markers] = finished.length
            ? await Promise.all([
                  VendorMoneyDailyModel.find({
                      vendor_id: new Types.ObjectId(vendorId),
                      timezone: period.timezone,
                      day: { $gte: finished[0], $lt: today },
                  }).lean<DayFacts[]>(),
                  VendorMoneyDailyModel.find({
                      vendor_id: null,
                      timezone: period.timezone,
                      day: { $gte: finished[0], $lt: today },
                  })
                      .select('day')
                      .lean<{ day: string }[]>(),
              ])
            : [[], []];

        const storedByDay = new Map(stored.map((s) => [s.day, s]));
        const covered = new Set(markers.map((m) => m.day));
        const known = new Map<string, DayFacts>();
        for (const day of finished) {
            const row = storedByDay.get(day);
            if (row) known.set(day, row);
            else if (covered.has(day)) known.set(day, emptyDay(day));
        }

        const missing = days.filter((d) => !known.has(d));
        if (missing.length) {
            // One live computation spanning the missing days; only those days are taken from it.
            const live = await this.computeFacts(vendorId, toAnalyticsPeriod(missing[0], missing[missing.length - 1], period.timezone));
            for (const f of live) if (missing.includes(f.day)) known.set(f.day, f);
        }
        return days.map((d) => known.get(d) ?? emptyDay(d));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reads
    // ─────────────────────────────────────────────────────────────────────────

    private meta(period: AnalyticsPeriod, extra: Record<string, unknown> = {}) {
        return {
            from: period.from,
            to: period.to,
            timezone: period.timezone,
            computedAt: new Date().toISOString(),
            netFormula: NET_FORMULA,
            fiscalCalendar: 'gregorian' as const,
            ...extra,
        };
    }

    /** GET /api/vendor/analytics/dashboard */
    async getDashboardMetrics(vendorId: string, period: AnalyticsPeriod) {
        const m = mergeFacts(await this.factsFor(vendorId, period));
        return {
            data: {
                sales: m.sales,
                bookings: m.bookings,
                adjustments: m.adjustments,
                /** What the period added to the vendor's earnings, net of everything. */
                netEarnings:
                    m.sales.netRevenue + m.bookings.netRevenue + m.adjustments.deliveryFeesReturned - m.adjustments.earningsReversed,
                refunds: m.refunds,
            },
            meta: this.meta(period, { currency: m.currency ?? 'XAF' }),
        };
    }

    /** GET /api/vendor/analytics/sales */
    async getSalesMetrics(vendorId: string, period: AnalyticsPeriod, breakdown: boolean) {
        const days = await this.factsFor(vendorId, period);
        const totals = mergeFacts(days).sales;
        if (!breakdown) return { data: { totals }, meta: this.meta(period, { breakdown: 'none' }) };
        return {
            data: { totals, daily: days.map((d) => ({ date: d.day, ...mergeFacts([d]).sales })) },
            meta: this.meta(period, { breakdown: 'daily' }),
        };
    }

    /**
     * GET /api/vendor/analytics/products — top variants by revenue and by quantity.
     *
     * An order's lines count ONCE in a period however many days its money arrived on. Revenue
     * is the line's gross at the price the customer paid (negotiated when bargained); deductions
     * are order-level and live on `/sales`.
     */
    async getProductMetrics(vendorId: string, period: AnalyticsPeriod, limit: number) {
        const { lines } = mergeFacts(await this.factsFor(vendorId, period));
        const variants = new Map<string, { variantId: string; productId: string; productTitle: string; sku: string | null; revenue: number; quantity: number; orders: Set<string> }>();
        for (const l of lines) {
            const v = variants.get(l.variantId) ?? {
                variantId: l.variantId,
                productId: l.productId,
                productTitle: l.title,
                sku: l.sku,
                revenue: 0,
                quantity: 0,
                orders: new Set<string>(),
            };
            v.revenue += l.revenue;
            v.quantity += l.quantity;
            v.orders.add(l.orderId);
            variants.set(l.variantId, v);
        }
        const rows = [...variants.values()].map(({ orders, ...rest }) => ({ ...rest, orderCount: orders.size }));
        return {
            data: {
                topByRevenue: [...rows].sort((a, b) => b.revenue - a.revenue).slice(0, limit),
                topByQuantity: [...rows].sort((a, b) => b.quantity - a.quantity).slice(0, limit),
            },
            meta: this.meta(period, { limit }),
        };
    }

    /**
     * GET /api/vendor/analytics/customers — DISTINCT customers over the whole period; `repeat` =
     * customers with two or more orders whose money arrived in the period.
     */
    async getCustomerMetrics(vendorId: string, period: AnalyticsPeriod) {
        const { orders } = mergeFacts(await this.factsFor(vendorId, period));
        const perCustomer = new Map<string, number>();
        for (const customerId of orders.values()) {
            if (customerId) perCustomer.set(customerId, (perCustomer.get(customerId) ?? 0) + 1);
        }
        const total = perCustomer.size;
        const repeat = [...perCustomer.values()].filter((n) => n >= 2).length;
        return {
            data: { total, repeat, repeatRate: total > 0 ? Math.round((repeat / total) * 1000) / 10 : 0 },
            meta: this.meta(period),
        };
    }
}

export function emptyDay(day: string): DayFacts {
    return {
        day,
        sales: { grossSales: 0, bargainFee: 0, commission: 0, deliveryFee: 0, codFee: 0, deliveryAndCodFees: 0, netRevenue: 0 },
        orders: [],
        lines: [],
        bookings: { count: 0, grossRevenue: 0, commission: 0, netRevenue: 0 },
        adjustments: { deliveryFeesReturned: 0, earningsReversed: 0 },
        refunds: { count: 0, amount: 0 },
        currency: null,
    };
}

/** True when a computed day carries nothing worth storing. */
export function isEmptyDay(d: DayFacts): boolean {
    return (
        d.orders.length === 0 &&
        d.bookings.count === 0 &&
        d.refunds.count === 0 &&
        d.adjustments.deliveryFeesReturned === 0 &&
        d.adjustments.earningsReversed === 0
    );
}
