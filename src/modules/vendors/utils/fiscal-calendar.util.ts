/**
 * Fiscal calendar utilities
 * 
 * CRITICAL: Only 'gregorian' calendar is supported
 * Hard validation prevents false expectations
 */

import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Validate fiscal calendar parameter
 * 
 * Throws error for any value other than 'gregorian'
 */
export function validateFiscalCalendar(calendar: string): void {
    if (calendar !== 'gregorian') {
        throw createAppError(
            ERROR_CODES.VENDOR_UNSUPPORTED_FISCAL_CALENDAR,
            400,
            `Fiscal calendar '${calendar}' is not supported. ` +
            `Only 'gregorian' calendar is currently available.`,
            { calendar }
        );
    }
}

/**
 * Get fiscal period (pass-through for gregorian)
 * 
 * For gregorian calendar, fiscal period is same as the date
 */
export function getFiscalPeriod(date: Date, calendar: 'gregorian'): { start: Date; end: Date } {
    // Validation already enforced by type
    return { start: date, end: date };
}
