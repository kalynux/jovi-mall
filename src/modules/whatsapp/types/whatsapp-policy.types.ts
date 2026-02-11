import { WhatsAppMessageType } from './whatsapp-message.types';

/**
 * WhatsApp Policy Constraints
 * 
 * Models WhatsApp's critical business and technical constraints
 */

/**
 * 24-Hour Window Policy
 * 
 * WhatsApp allows free-form messages within 24 hours of the last user message.
 * Outside this window, only template messages are allowed.
 */
export interface WindowPolicy {
    /** Whether the 24-hour window is open */
    isWithinWindow: boolean;

    /** Window expiration time (if open) */
    expiresAt?: Date;

    /** Last inbound message timestamp */
    lastInboundAt?: Date;
}

/**
 * Capability Policy
 * 
 * Different WhatsApp Business accounts have different capabilities based on:
 * - Account tier
 * - Region/country
 * - Business verification status
 */
export interface CapabilityPolicy {
    /** Interactive messages (buttons, lists) */
    hasInteractive: boolean;

    /** WhatsApp Flows */
    hasFlows: boolean;

    /** Product catalog */
    hasCatalog: boolean;

    /** Media carousel */
    hasMediaCarousel: boolean;

    /** Maximum buttons per interactive message */
    maxButtons?: number;

    /** Maximum products per list */
    maxProductsPerList?: number;
}

/**
 * Region Policy
 * 
 * Some features are region-specific
 */
export interface RegionPolicy {
    /** Country code (ISO 3166-1 alpha-2) */
    countryCode: string;

    /** Features restricted in this region */
    restrictedFeatures: WhatsAppMessageType[];

    /** Features available in this region */
    allowedFeatures: WhatsAppMessageType[];
}

/**
 * Complete Policy Context
 */
export interface PolicyContext {
    /** 24-hour window policy */
    window: WindowPolicy;

    /** Account capabilities */
    capabilities: CapabilityPolicy;

    /** Region-specific rules (optional) */
    region?: RegionPolicy;
}

/**
 * Policy Violation Type
 */
export type PolicyViolationReason =
    | 'OUTSIDE_24H_WINDOW'
    | 'MISSING_CAPABILITY'
    | 'REGION_RESTRICTED'
    | 'ACCOUNT_TIER_INSUFFICIENT'
    | 'TEMPLATE_NOT_APPROVED'
    | 'FLOW_NOT_PUBLISHED';
