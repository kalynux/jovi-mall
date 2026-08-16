/**
 * Store Module Configuration
 * 
 * Centralized configuration for store profile management.
 */

export const StoreConfig = {
  /**
   * Public URL Base
   *
   * Base URL for store public pages.
   * Actual URL: `${PUBLIC_URL_BASE}/${slug}`
   *
   * Must match the storefront's own routing, which nests stores under /shop:
   * `/shop/stores/:storeSlug` (and products at `/shop/stores/:storeSlug/products/:productSlug`).
   * This used to end in `/store`, which is not a route the storefront serves — every
   * `publicUrl` it produced 404'd.
   */
  PUBLIC_URL_BASE: process.env.STORE_PUBLIC_URL_BASE || 'https://yourdomain.com/shop/stores',

  /**
   * Slug Validation Rules
   * 
   * Used for admin slug changes (future feature).
   * Vendor API does NOT allow slug changes.
   */
  SLUG: {
    MIN_LENGTH: 3,
    MAX_LENGTH: 50,
    PATTERN: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, // lowercase, numbers, hyphens only
  },
};
