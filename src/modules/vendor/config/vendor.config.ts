/**
 * Vendor Module Configuration
 * 
 * Centralized configuration for vendor profile management features.
 * All feature flags and business rules are defined here.
 */

export const VendorConfig = {
  /**
   * Email Change Lock
   * 
   * When false, vendors cannot change their email address.
   * This is useful for:
   * - Preventing spam/abuse
   * - Maintaining email verification integrity
   * - Compliance with certain business rules
   */
  ALLOW_EMAIL_CHANGE: process.env.ALLOW_EMAIL_CHANGE === 'true',

  /**
   * WhatsApp Notifications Feature Flag
   * 
   * HARDCODED to false for initial release.
   * This creates a clear upgrade path for premium pricing tiers.
   */
  ENABLE_WHATSAPP_NOTIFICATIONS: false,

  /**
   * Phone Notifications Feature Flag
   * 
   * HARDCODED to false for initial release.
   * This creates a clear upgrade path for premium pricing tiers.
   */
  ENABLE_PHONE_NOTIFICATIONS: false,

  /**
   * Password Strength Requirements
   */
  PASSWORD: {
    MIN_LENGTH: parseInt(process.env.VENDOR_PASSWORD_MIN_LENGTH || '8', 10),
    REQUIRE_UPPERCASE: true,
    REQUIRE_LOWERCASE: true,
    REQUIRE_NUMBER: true,
    REQUIRE_SPECIAL_CHAR: true,
  },
};
