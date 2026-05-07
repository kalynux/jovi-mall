import { z } from 'zod';
import { validateFiscalCalendar } from '../utils/fiscal-calendar.util';
import { validateTimezone } from '../utils/timezone.util';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Base analytics query schema (without refinements)
 */
const AnalyticsQueryBaseSchema = z.object({
    from: z.string().transform((val) => {
        const date = new Date(val);
        if (isNaN(date.getTime())) {
            throw createAppError(ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE, 400, `Invalid 'from' date: ${val}`);
        }
        return date;
    }),
    to: z.string().transform((val) => {
        const date = new Date(val);
        if (isNaN(date.getTime())) {
            throw createAppError(ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE, 400, `Invalid 'to' date: ${val}`);
        }
        return date;
    }),
    timezone: z.string().optional(),
    fiscalCalendar: z.enum(['gregorian']).default('gregorian')
});

/**
 * Base analytics query schema with validation refinements
 */
export const AnalyticsQuerySchema = AnalyticsQueryBaseSchema.refine((data) => {
    // Validate from <= to
    if (data.from > data.to) {
        throw createAppError(ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE, 400, 'Start date must be before or equal to end date');
    }

    // Validate date range not exceeding 365 days
    const daysDiff = (data.to.getTime() - data.from.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 365) {
        throw createAppError(ERROR_CODES.ANALYTICS_DATE_RANGE_EXCEEDED, 400, 'Date range cannot exceed 365 days');
    }

    // Validate timezone if provided
    if (data.timezone && !validateTimezone(data.timezone)) {
        throw createAppError(ERROR_CODES.ANALYTICS_UNSUPPORTED_TIMEZONE, 400, undefined, { timezone: data.timezone });
    }

    // Validate fiscal calendar (hard check for gregorian)
    validateFiscalCalendar(data.fiscalCalendar);

    return true;
});

/**
 * Sales metrics query schema (extends base with breakdown option)
 */
export const SalesQuerySchema = AnalyticsQueryBaseSchema.extend({
    breakdown: z.enum(['daily', 'none']).default('none')
}).refine((data) => {
    // Apply the same validations as base schema
    if (data.from > data.to) {
        throw createAppError(ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE, 400, 'Start date must be before or equal to end date');
    }

    const daysDiff = (data.to.getTime() - data.from.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 365) {
        throw createAppError(ERROR_CODES.ANALYTICS_DATE_RANGE_EXCEEDED, 400, 'Date range cannot exceed 365 days');
    }

    if (data.timezone && !validateTimezone(data.timezone)) {
        throw createAppError(ERROR_CODES.ANALYTICS_UNSUPPORTED_TIMEZONE, 400, undefined, { timezone: data.timezone });
    }

    validateFiscalCalendar(data.fiscalCalendar);

    return true;
});

/**
 * Product metrics query schema (extends base with limit option)
 */
export const ProductQuerySchema = AnalyticsQueryBaseSchema.extend({
    limit: z.string().transform((val) => {
        const num = parseInt(val, 10);
        if (isNaN(num) || num < 1 || num > 50) {
            return 5; // Default to 5
        }
        return num;
    }).default('5')
}).refine((data) => {
    // Apply the same validations as base schema
    if (data.from > data.to) {
        throw createAppError(ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE, 400, 'Start date must be before or equal to end date');
    }

    const daysDiff = (data.to.getTime() - data.from.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 365) {
        throw createAppError(ERROR_CODES.ANALYTICS_DATE_RANGE_EXCEEDED, 400, 'Date range cannot exceed 365 days');
    }

    if (data.timezone && !validateTimezone(data.timezone)) {
        throw createAppError(ERROR_CODES.ANALYTICS_UNSUPPORTED_TIMEZONE, 400, undefined, { timezone: data.timezone });
    }

    validateFiscalCalendar(data.fiscalCalendar);

    return true;
});

export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;
export type SalesQuery = z.infer<typeof SalesQuerySchema>;
export type ProductQuery = z.infer<typeof ProductQuerySchema>;
