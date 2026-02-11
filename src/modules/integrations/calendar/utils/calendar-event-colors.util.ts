/**
 * Google Calendar Event Color Mapping Utility
 * 
 * Provides centralized, deterministic status-to-color mapping for calendar events.
 * Google Calendar API only accepts numeric colorId values (1-11), not hex codes.
 * 
 * COLOR REFERENCE:
 * ┌────────────┬───────────┬─────────┬───────────┐
 * │ Status     │ Color     │ colorId │ Hex       │
 * ├────────────┼───────────┼─────────┼───────────┤
 * │ paid       │ Basil     │ 10      │ #51b749   │
 * │ unpaid     │ Tomato    │ 11      │ #dc2127   │
 * │ pending    │ Banana    │ 5       │ #fbd75b   │
 * │ done       │ Blueberry │ 9       │ #5484ed   │
 * │ cancelled  │ Graphite  │ 8       │ #e1e1e1   │
 * │ refunded   │ Flamingo  │ 4       │ #ff887c   │
 * │ default    │ Lavender  │ 1       │ #a4bdfc   │
 * └────────────┴───────────┴─────────┴───────────┘
 */

export type CalendarEventColorId =
    | '1'  // Lavender
    | '2'  // Sage
    | '3'  // Grape
    | '4'  // Flamingo
    | '5'  // Banana
    | '6'  // Tangerine
    | '7'  // Peacock
    | '8'  // Graphite
    | '9'  // Blueberry
    | '10' // Basil
    | '11' // Tomato

/**
 * Google Calendar color constants
 */
export const CALENDAR_COLOR = {
    LAVENDER: '1' as CalendarEventColorId,   // Default / Unknown
    SAGE: '2' as CalendarEventColorId,
    GRAPE: '3' as CalendarEventColorId,
    FLAMINGO: '4' as CalendarEventColorId,   // Refunded
    BANANA: '5' as CalendarEventColorId,     // Pending
    TANGERINE: '6' as CalendarEventColorId,
    PEACOCK: '7' as CalendarEventColorId,
    GRAPHITE: '8' as CalendarEventColorId,   // Cancelled
    BLUEBERRY: '9' as CalendarEventColorId,  // Done
    BASIL: '10' as CalendarEventColorId,     // Paid
    TOMATO: '11' as CalendarEventColorId,    // Unpaid
    DEFAULT: '1' as CalendarEventColorId,    // Alias for Lavender
} as const;

/**
 * Get Google Calendar colorId based on booking status
 * 
 * Accepts any status string (payment status, booking status, or custom)
 * and returns the appropriate Google Calendar color ID.
 * 
 * @param status - Status string (case-insensitive)
 * @returns Google Calendar colorId (1-11)
 * 
 * @example
 * ```typescript
 * getCalendarColorIdByStatus('paid')      // '10' (Basil/Green)
 * getCalendarColorIdByStatus('unpaid')    // '11' (Tomato/Red)
 * getCalendarColorIdByStatus('pending')   // '5'  (Banana/Yellow)
 * getCalendarColorIdByStatus('CANCELLED') // '8'  (Graphite/Gray)
 * getCalendarColorIdByStatus('unknown')   // '1'  (Lavender/Default)
 * ```
 */
export function getCalendarColorIdByStatus(status: string): CalendarEventColorId {
    // Normalize to lowercase for consistent matching
    const normalizedStatus = status?.toLowerCase() || '';

    // Status-to-color mapping
    const statusColorMap: Record<string, CalendarEventColorId> = {
        // Payment statuses
        'paid': CALENDAR_COLOR.BASIL,        // Green
        'unpaid': CALENDAR_COLOR.TOMATO,     // Red
        'pending': CALENDAR_COLOR.BANANA,    // Yellow
        'refunded': CALENDAR_COLOR.FLAMINGO, // Pink/Salmon
        'failed': CALENDAR_COLOR.TOMATO,     // Red (same as unpaid)

        // Booking statuses
        'confirmed': CALENDAR_COLOR.BASIL,   // Green (same as paid)
        'cancelled': CALENDAR_COLOR.GRAPHITE, // Gray
        'canceled': CALENDAR_COLOR.GRAPHITE,  // Gray (alternative spelling)

        // Extended statuses
        'done': CALENDAR_COLOR.BLUEBERRY,    // Blue
        'completed': CALENDAR_COLOR.BLUEBERRY, // Blue (alias)
        'complete': CALENDAR_COLOR.BLUEBERRY,  // Blue (alias)
    };

    // Return mapped color or default
    return statusColorMap[normalizedStatus] || CALENDAR_COLOR.DEFAULT;
}

/**
 * Status prefix mapping for event titles
 * 
 * @param status - Status string
 * @returns Status prefix for event title (e.g., '[PAID]', '[UNPAID]')
 */
export function getStatusPrefix(status: string): string {
    const normalizedStatus = status?.toLowerCase() || '';

    const prefixMap: Record<string, string> = {
        'unpaid': '[UNPAID]',
        'pending': '[PENDING]',
        'paid': '[PAID]',
        'failed': '[FAILED]',
        'refunded': '[REFUNDED]',
        'cancelled': '[CANCELLED]',
        'canceled': '[CANCELLED]',
        'confirmed': '[CONFIRMED]',
        'done': '[DONE]',
        'completed': '[COMPLETED]',
    };

    return prefixMap[normalizedStatus] || '[UNKNOWN]';
}
