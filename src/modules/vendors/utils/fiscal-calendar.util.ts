/**
 * Fiscal calendar utilities
 * 
 * CRITICAL: Only 'gregorian' calendar is supported
 * Hard validation prevents false expectations
 */

/**
 * Validate fiscal calendar parameter
 * 
 * Throws error for any value other than 'gregorian'
 */
export function validateFiscalCalendar(calendar: string): void {
    if (calendar !== 'gregorian') {
        throw new Error(
            `Fiscal calendar '${calendar}' is not supported. ` +
            `Only 'gregorian' calendar is currently available.`
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
