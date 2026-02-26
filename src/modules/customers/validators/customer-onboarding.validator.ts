import { z } from 'zod';
import { GeoPointZodSchema } from '../../../core/types/geo.types';

// ─── Re-usable sub-schemas ────────────────────────────────────────────────────

const SavedAddressSchema = z.object({
    label: z.string().min(1).max(50).trim(),
    address_line1: z.string().min(1).max(200).trim(),
    address_line2: z.string().max(200).trim().nullable().optional(),
    city: z.string().min(1).max(100).trim(),
    state: z.string().max(100).trim().nullable().optional(),
    country: z.string().length(2).toUpperCase().default('CM'),
    is_default: z.boolean().default(false),
    location: GeoPointZodSchema.nullable().optional(),
});

const PreferencesSchema = z.object({
    language: z.string().min(2).max(10).trim().optional(),      // BCP-47
    currency: z.string().length(3).trim().toUpperCase().optional(), // ISO-4217
    marketing_opt_in: z.boolean().optional(),
    ai_tone: z.array(z.string().trim().min(1)).optional(),
    ads_compact_mode: z.boolean().optional(),
    compact_mode: z.boolean().optional(),
});

/**
 * Payment methods are gateway-managed. We record display metadata only.
 * The provider manages all tokenization on their end.
 */
const SavedPaymentMethodSchema = z.object({
    provider: z.string().min(1).trim(),
    gateway_customer_id: z.string().min(1).trim(),
    gateway_instrument_id: z.string().min(1).trim(),
    display_label: z.string().min(1).max(100).trim(),
    method_type: z.enum(['card', 'mobile_money', 'bank_transfer']),
    is_default: z.boolean().default(false),
});

// ─── General Profile Update ───────────────────────────────────────────────────

export const UpdateCustomerProfileSchema = z.object({
    name: z.string().min(1).max(100).trim().optional(),
    avatarUrl: z.string().url('avatarUrl must be a valid URL').nullable().optional(),
    bio: z.string().max(500).trim().nullable().optional(),
    dateOfBirth: z.coerce.date().nullable().optional(),
    recentProductCode: z.string().trim().nullable().optional(),
    preferences: PreferencesSchema.optional(),
});

export type UpdateCustomerProfileInput = z.infer<typeof UpdateCustomerProfileSchema>;

// ─── Add Address ──────────────────────────────────────────────────────────────

export const AddCustomerAddressSchema = SavedAddressSchema;
export type AddCustomerAddressInput = z.infer<typeof AddCustomerAddressSchema>;

// ─── Add Payment Method ───────────────────────────────────────────────────────

export const AddCustomerPaymentMethodSchema = SavedPaymentMethodSchema;
export type AddCustomerPaymentMethodInput = z.infer<typeof AddCustomerPaymentMethodSchema>;
