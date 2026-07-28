import { z } from 'zod';
import { GeoPointZodSchema } from '../../../core/types/geo.types';
import { GeoAddressZodSchema } from '../../../core/types/geo-address.types';
import { clearable } from '../../../core/validation/zod.helpers';

// ─── Re-usable sub-schemas ────────────────────────────────────────────────────

const SavedAddressSchema = z.object({
    label: z.string().min(1).max(50).trim(),
    address_line1: z.string().min(1).max(200).trim(),
    address_line2: clearable(z.string().max(200).trim()),
    city: z.string().min(1).max(100).trim(),
    state: clearable(z.string().max(100).trim()),
    country: z.string().length(2).toUpperCase().default('CM'),
    is_default: z.boolean().default(false),
    /** @deprecated Prefer `geo`; kept for backward compatibility. */
    location: GeoPointZodSchema.nullable().optional(),
    /** Selected address-search result — the canonical geospatial address. */
    geo: GeoAddressZodSchema.nullable().optional(),
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
    // Canonical avatar: id of a file uploaded via POST /api/files/upload ('' / null clears it).
    avatarFileId: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'avatarFileId must be a valid file id')),
    /** @deprecated Prefer avatarFileId. Accepted for backward compatibility. */
    avatarUrl: clearable(z.string().url('avatarUrl must be a valid URL')),
    bio: clearable(z.string().max(500).trim()),
    dateOfBirth: z.coerce.date().nullable().optional(),
    recentProductCode: clearable(z.string().trim()),
    preferences: PreferencesSchema.optional(),
});

export type UpdateCustomerProfileInput = z.infer<typeof UpdateCustomerProfileSchema>;

// ─── Add Address ──────────────────────────────────────────────────────────────

export const AddCustomerAddressSchema = SavedAddressSchema;
export type AddCustomerAddressInput = z.infer<typeof AddCustomerAddressSchema>;

// ─── Add Payment Method ───────────────────────────────────────────────────────

export const AddCustomerPaymentMethodSchema = SavedPaymentMethodSchema;
export type AddCustomerPaymentMethodInput = z.infer<typeof AddCustomerPaymentMethodSchema>;
