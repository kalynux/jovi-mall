/**
 * Template Constants
 * 
 * Centralized template names and structures.
 * NO MAGIC STRINGS in business code!
 */

/**
 * Template Names
 * 
 * These must match exactly with templates registered in WhatsApp Business Manager
 */
export const TEMPLATE_NAMES = {
    // Booking-related templates
    BOOKING_CONFIRMATION: 'booking_confirmation',
    BOOKING_REMINDER: 'booking_reminder',
    BOOKING_CANCELLED: 'booking_cancelled',

    // Order-related templates
    ORDER_CONFIRMATION: 'order_confirmation',
    ORDER_STATUS_UPDATE: 'order_status_update',
    ORDER_DELIVERY_UPDATE: 'order_delivery_update',

    // Payment templates
    PAYMENT_CONFIRMATION: 'payment_confirmation',
    PAYMENT_FAILED: 'payment_failed',

    // Vendor templates
    VENDOR_NEW_BOOKING: 'vendor_new_booking',
    VENDOR_NEW_ORDER: 'vendor_new_order',

    // Authentication templates
    VERIFICATION_CODE: 'verification_code',

} as const;

/**
 * Template Languages
 */
export const TEMPLATE_LANGUAGES = {
    ENGLISH: 'en',
    ENGLISH_US: 'en_US',
    FRENCH: 'fr',
    // Add more as needed
} as const;

/**
 * Template Component Types
 */
export const TEMPLATE_COMPONENT_TYPES = {
    HEADER: 'header',
    BODY: 'body',
    BUTTON: 'button',
    FOOTER: 'footer',
} as const;

/**
 * Template Parameter Types
 */
export const TEMPLATE_PARAMETER_TYPES = {
    TEXT: 'text',
    CURRENCY: 'currency',
    DATE_TIME: 'date_time',
    IMAGE: 'image',
    DOCUMENT: 'document',
    VIDEO: 'video',
} as const;
