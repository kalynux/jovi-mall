import { fromZonedTime } from 'date-fns-tz';

/**
 * Vendor net revenue — READ from the allocations the earnings split wrote, never recomputed.
 *
 * ── Why this file exists (2026-09-27) ─────────────────────────────────────────
 * Vendor analytics used to report `netRevenue = Σ order.total_amount − refunds` from a nightly
 * snapshot. It never subtracted commission, the bargain fee, the delivery fee or the COD fee,
 * so it could never match the wallet. Owner decision O-1: net revenue is what reached the
 * vendor's earnings, with each deduction shown. Record:
 * `PRODUCTION-READINESS/ACCOUNT-STATEMENTS-AND-ANALYTICS-PLAN.md`.
 *
 * Every figure is an amount `EarningsSplitService` persisted, or the residual of those:
 *   - `bargainFee` — the `platform_ai` allocation on the same source
 *   - `commission` — the `platform` allocation on the same source
 *   - `net`        — the vendor's own allocation
 *   - `deliveryFee + codFee` = `gross − bargainFee − commission − net`, exact because the split
 *     is `vendorNet = gross − aiMargin − commission − deliveryFee − codFee`. The residual is
 *     divided with `shipments.delivery_fee_snapshot`; a prepaid order has no COD fee.
 *
 * ⚠ **NET_FORMULA is a contract copy.** wi-admin's account statements
 * (`admin/src/modules/statements/domain/money-breakdown.ts`) state the same literal, and both
 * repos' tests assert it — there is no shared package to import it from (ADR-016 pattern). A
 * vendor comparing their dashboard to the statement an administrator emailed them must see the
 * same net.
 */
export const NET_FORMULA = 'net = gross - bargainFee - commission - deliveryFee - codFee';

export interface VendorSaleInput {
    sourceType: 'order' | 'cod_collection';
    gross: number;
    net: number;
    commission: number;
    bargainFee: number;
    /** Σ `delivery_fee_snapshot` for the shipment(s) this source paid for; `null` when none. */
    deliveryFeeSnapshot: number | null;
}

export interface VendorSaleBreakdown {
    gross: number;
    bargainFee: number;
    commission: number;
    /** `null` only when the residual cannot be split (COD with no fee snapshot). */
    deliveryFee: number | null;
    codFee: number | null;
    deliveryAndCod: number;
    net: number;
}

export function vendorSaleBreakdown(input: VendorSaleInput): VendorSaleBreakdown {
    const deliveryAndCod = input.gross - input.bargainFee - input.commission - input.net;
    const base = {
        gross: input.gross,
        bargainFee: input.bargainFee,
        commission: input.commission,
        deliveryAndCod,
        net: input.net,
    };
    if (input.sourceType === 'order') return { ...base, deliveryFee: deliveryAndCod, codFee: 0 };

    const snapshot = input.deliveryFeeSnapshot;
    if (snapshot === null || snapshot < 0 || snapshot > deliveryAndCod) {
        return { ...base, deliveryFee: null, codFee: null };
    }
    return { ...base, deliveryFee: snapshot, codFee: deliveryAndCod - snapshot };
}

// ─────────────────────────────────────────────────────────────────────────────
// The period — local calendar days, end EXCLUSIVE
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyticsPeriod {
    from: string;
    to: string;
    timezone: string;
    /** Local midnight at the start of `from`. */
    start: Date;
    /** Local midnight AFTER `to`. Query with `$lt`. */
    end: Date;
}

/**
 * `from`/`to` are the vendor's LOCAL calendar days, both inclusive.
 *
 * The old validator parsed `to` with `new Date('YYYY-MM-DD')` — UTC midnight at the START of
 * that day — and the repository filtered `$lte`, so the last day of every range was silently
 * dropped. Here `end` is the local midnight after `to`, compared with `$lt`.
 */
export function toAnalyticsPeriod(from: string, to: string, timezone: string): AnalyticsPeriod {
    return {
        from,
        to,
        timezone,
        start: fromZonedTime(`${from}T00:00:00`, timezone),
        end: fromZonedTime(`${nextDay(to)}T00:00:00`, timezone),
    };
}

export function nextDay(day: string): string {
    return addDays(day, 1);
}

/** Calendar arithmetic on a `YYYY-MM-DD` string (negative `n` goes back). */
export function addDays(day: string, n: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** The instant's calendar day in `timezone`, as `YYYY-MM-DD`. */
export function localDay(instant: Date, timezone: string): string {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
        instant,
    );
}

/** Every local day of the period, in order — so a day with no sales is a zero row, not a gap. */
export function daysOf(period: Pick<AnalyticsPeriod, 'from' | 'to'>): string[] {
    const days: string[] = [];
    for (let d = period.from; d <= period.to; d = nextDay(d)) days.push(d);
    return days;
}
