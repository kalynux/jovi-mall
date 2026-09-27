import { z } from 'zod';
import { validateFiscalCalendar } from '../utils/fiscal-calendar.util';
import { validateTimezone } from '../utils/timezone.util';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Vendor analytics query — rebuilt 2026-09-27 with the live service.
 *
 * `from` / `to` are the vendor's LOCAL calendar days, both INCLUSIVE, as `YYYY-MM-DD`. A full
 * ISO timestamp is still accepted for compatibility and read as its date part — the old
 * validator took `new Date(value)`, which turned `to=2026-09-30` into UTC midnight at the START
 * of that day and dropped it. The period itself is built by `toAnalyticsPeriod`, in the
 * timezone the controller resolves (query → vendor profile → Africa/Douala), which the old
 * endpoint echoed and never used.
 */

const MAX_DAYS = 366;

const Day = (field: 'from' | 'to') =>
    z.string().transform((value) => {
        const day = value.slice(0, 10);
        const ms = Date.parse(`${day}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
            throw createAppError(ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE, 400, `Invalid '${field}' date: ${value}`);
        }
        return day;
    });

const Base = z.object({
    from: Day('from'),
    to: Day('to'),
    timezone: z.string().optional(),
    fiscalCalendar: z.enum(['gregorian']).default('gregorian'),
});

function checkRange<T extends { from: string; to: string; timezone?: string; fiscalCalendar: 'gregorian' }>(data: T): true {
    if (data.from > data.to) {
        throw createAppError(ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE, 400, 'Start date must be before or equal to end date');
    }
    const days = (Date.parse(`${data.to}T00:00:00Z`) - Date.parse(`${data.from}T00:00:00Z`)) / 86_400_000 + 1;
    if (days > MAX_DAYS) {
        throw createAppError(ERROR_CODES.ANALYTICS_DATE_RANGE_EXCEEDED, 400, `Date range cannot exceed ${MAX_DAYS} days`);
    }
    if (data.timezone && !validateTimezone(data.timezone)) {
        throw createAppError(ERROR_CODES.ANALYTICS_UNSUPPORTED_TIMEZONE, 400, undefined, { timezone: data.timezone });
    }
    validateFiscalCalendar(data.fiscalCalendar);
    return true;
}

export const AnalyticsQuerySchema = Base.refine(checkRange);

export const SalesQuerySchema = Base.extend({
    breakdown: z.enum(['daily', 'none']).default('none'),
}).refine(checkRange);

export const ProductQuerySchema = Base.extend({
    limit: z
        .string()
        .transform((val) => {
            const num = parseInt(val, 10);
            return Number.isNaN(num) || num < 1 || num > 50 ? 5 : num;
        })
        .default('5'),
}).refine(checkRange);

export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;
export type SalesQuery = z.infer<typeof SalesQuerySchema>;
export type ProductQuery = z.infer<typeof ProductQuerySchema>;
