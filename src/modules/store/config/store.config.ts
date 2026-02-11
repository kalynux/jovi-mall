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
   */
  PUBLIC_URL_BASE: process.env.STORE_PUBLIC_URL_BASE || 'https://yourdomain.com/store',

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
