/**
 * Variant Matrix Engine Constants
 * 
 * These constants control variant generation limits and behavior
 */

// Maximum number of variants that can be generated per product
// Prevents cartesian explosion (e.g., 3 options × 50 values = 125,000 variants)
export const MAX_VARIANTS_PER_PRODUCT = 1000;

// Maximum number of options per product (Shopify-like behavior)
export const MAX_OPTIONS_PER_PRODUCT = 3;

// Default variant signature for products without options
export const DEFAULT_VARIANT_SIGNATURE = 'default';
