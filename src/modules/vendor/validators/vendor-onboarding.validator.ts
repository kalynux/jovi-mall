import { z } from 'zod';
import { GeoPointZodSchema } from '../../../core/types/geo.types';
import { GeoAddressZodSchema } from '../../../core/types/geo-address.types';
import { PayoutDetailsZodSchema } from '../../../core/types/payout.types';
import { SUPPORTED_LANGUAGES } from '../../../core/constants/languages';
import { clearable } from '../../../core/validation/zod.helpers';

// ─── Re-usable sub-schemas ────────────────────────────────────────────────────

const BusinessAddressSchema = z.object({
    // Optional — omit when adding a new address (a fresh id is generated).
    // Include the id you were given on read when re-submitting an existing
    // address unchanged (or edited) in this full-replace array, so physical
    // products pointing at it via `delivery.pickupLocation.vendorAddressId`
    // don't get invalidated by an id that changed for no real reason.
    _id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId').optional(),
    label: z.string().min(1).max(50).trim(),
    address_line1: z.string().min(1).max(200).trim(),
    address_line2: clearable(z.string().max(200).trim()),
    city: z.string().min(1).max(100).trim(),
    state: clearable(z.string().max(100).trim()),
    /** @deprecated Prefer `geo`; kept for backward compatibility. */
    location: GeoPointZodSchema.nullable().optional(),
    /** Selected address-search result — the canonical geospatial address. */
    geo: GeoAddressZodSchema.nullable().optional(),
});

const OperatingHoursSchema = z.object({
    day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
    open_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/, 'open_time must be in HH:MM format'),
    close_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/, 'close_time must be in HH:MM format'),
    is_closed: z.boolean().default(false),
});

const BrandingSchema = z.object({
    logo_file_id: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'logo_file_id must be a valid MongoDB ObjectId')),
    cover_image_file_id: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'cover_image_file_id must be a valid MongoDB ObjectId')),
});

const SocialLinksSchema = z.object({
    instagram: clearable(z.string().url()),
    facebook: clearable(z.string().url()),
    twitter: clearable(z.string().url()),
});

const KycDetailsSchema = z.object({
    national_id_number: clearable(z.string().min(1).trim()),
});

// ─── Step 1: Basic Setup (REQUIRED) ──────────────────────────────────────────
//   country, timezone, payout_details

export const VendorOnboardingStep1Schema = z.object({
    country: z
        .string()
        .length(2, 'country must be a valid ISO-2 code (e.g. "CM")')
        .toUpperCase(),
    timezone: z
        .string()
        .min(1, 'timezone is required')
        .trim(),
    payout_details: PayoutDetailsZodSchema,
});

export type VendorOnboardingStep1Input = z.infer<typeof VendorOnboardingStep1Schema>;

// ─── Step 2: Delivery Linking (OPTIONAL / SKIPPABLE) ──────────────────────────
//   Pure step-advance — agency selection now happens exclusively through the
//   agency-connections endpoints (search/request), independent of this step.
//   `skip` is accepted but no longer changes behavior (kept for backward
//   compatibility with existing frontend calls); the vendor's default agency
//   is set automatically the first time any connection is approved.

export const VendorOnboardingStep2Schema = z.object({
    /** @deprecated No longer changes behavior — kept for backward compatibility. */
    skip: z.boolean().optional().default(false),
});

export type VendorOnboardingStep2Input = z.infer<typeof VendorOnboardingStep2Schema>;


// ─── Step 3: Branding (OPTIONAL / SKIPPABLE) ─────────────────────────────────
//   branding, business_addresses

export const VendorOnboardingStep3Schema = z.object({
    /** Set to true to skip this step without providing branding data. */
    skip: z.boolean().optional().default(false),
    branding: BrandingSchema.optional(),
    business_addresses: z.array(BusinessAddressSchema).optional(),
});

export type VendorOnboardingStep3Input = z.infer<typeof VendorOnboardingStep3Schema>;

// ─── Step 4: Policy Setup (OPTIONAL / SKIPPABLE) ─────────────────────────────
//   return_policy, cancellation_policy, support_policy

const ReturnPolicySchema = z.object({
    return_eligible: z.boolean().default(true),
    return_window_days: z.number().int().min(0).max(180).default(14),
    refund_type: z.enum(['full', 'partial', 'none']).default('full'),
    refund_percentage: z.number().min(0).max(100).nullable().optional(),
    return_shipping_payer: z.enum(['vendor', 'customer', 'customer_reimbursed_if_defect']).default('customer'),
    refund_processing_days: z.number().int().min(1).max(30).default(7),
    return_condition_notes: clearable(z.string().max(500).trim()),
}).refine(
    (data) => data.refund_type !== 'partial' || (data.refund_percentage !== undefined && data.refund_percentage !== null),
    { message: 'refund_percentage is required when refund_type is "partial"', path: ['refund_percentage'] },
);

const CancellationPolicySchema = z.object({
    cancellable: z.boolean().default(true),
    cancellation_deadline: z.enum([
        'within_1_hour',
        'within_24_hours',
        'before_vendor_confirmation',
        'before_service_start',
        'anytime_until_days_before_delivery',
    ]).nullable().optional(),
    cancellation_deadline_days: z.number().int().min(0).nullable().optional(),
    cancellation_fee_type: z.enum(['none', 'fixed', 'percentage', 'full_non_refundable']).nullable().optional(),
    cancellation_fee_value: z.number().min(0).nullable().optional(),
    late_cancellation_refund_type: z.enum(['fixed', 'percentage', 'full_non_refundable']).nullable().optional(),
    late_cancellation_refund_value: z.number().min(0).nullable().optional(),
}).refine(
    (data) => {
        if (data.cancellation_deadline === 'anytime_until_days_before_delivery') {
            return data.cancellation_deadline_days !== undefined && data.cancellation_deadline_days !== null;
        }
        return true;
    },
    { message: 'cancellation_deadline_days is required when deadline is "anytime_until_days_before_delivery"', path: ['cancellation_deadline_days'] },
).refine(
    (data) => {
        if (data.cancellation_fee_type === 'fixed' || data.cancellation_fee_type === 'percentage') {
            return data.cancellation_fee_value !== undefined && data.cancellation_fee_value !== null;
        }
        return true;
    },
    { message: 'cancellation_fee_value is required when fee type is "fixed" or "percentage"', path: ['cancellation_fee_value'] },
).refine(
    (data) => {
        if (data.late_cancellation_refund_type === 'fixed' || data.late_cancellation_refund_type === 'percentage') {
            return data.late_cancellation_refund_value !== undefined && data.late_cancellation_refund_value !== null;
        }
        return true;
    },
    { message: 'late_cancellation_refund_value is required when refund type is "fixed" or "percentage"', path: ['late_cancellation_refund_value'] },
);

const SupportChannelSchema = z.object({
    type: z.enum(['email', 'phone', 'whatsapp', 'telegram']),
    contact: z.string().min(1).max(200).trim(),
});

const SupportPolicySchema = z.object({
    channels: z.array(SupportChannelSchema).max(4).optional(),
    eligibility_notes: clearable(z.string().max(500).trim()),
    required_info: z.array(z.enum(['order_number', 'product_photo_video', 'tracking_number'])).optional(),
    availability: z.enum(['24_7', 'business_hours', 'limited']).nullable().optional(),
    availability_description: clearable(z.string().max(200).trim()),
    languages: z.array(z.string().min(1).max(50).trim()).max(20).optional(),
});

export const VendorOnboardingStep4Schema = z.object({
    /** Set to true to skip this step without providing policy data. */
    skip: z.boolean().optional().default(false),
    return_policy: ReturnPolicySchema.optional(),
    cancellation_policy: CancellationPolicySchema.optional(),
    support_policy: SupportPolicySchema.optional(),
    // Additional terms that don't fit the structured fields above (e.g. a signed PDF addendum).
    documents: z.array(z.string().url()).max(2, 'Maximum 2 documents allowed').optional(),
});

export type VendorOnboardingStep4Input = z.infer<typeof VendorOnboardingStep4Schema>;

// ─── General Profile Update ───────────────────────────────────────────────────
//   For PATCH /profile — updates allowed outside of the onboarding flow

export const UpdateVendorProfileSchema = z.object({
    displayName: z.string().min(2).max(100).trim().optional(),
    // NOTE: the business name/description/logo/banner are edited on the Store
    // (PATCH /api/vendor/store), not here — the Store is their source of truth.
    email: z.string().email().optional(),
    phone: z.string().min(8).max(20).optional(),
    timezone: z.string().min(1).trim().optional(),
    preferred_language: z.enum(SUPPORTED_LANGUAGES).optional(),
    country: z.string().length(2).toUpperCase().optional(),
    // Personal profile avatar as a File reference ('' / null clears it).
    avatarFileId: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'avatarFileId must be a valid file id')),
    business_addresses: z.array(BusinessAddressSchema).optional(),
    operating_hours: z.array(OperatingHoursSchema).optional(),
    payout_details: PayoutDetailsZodSchema.optional(),
    kyc_details: KycDetailsSchema.optional(),
    social_links: SocialLinksSchema.optional(),
    policies: z.object({
        return_policy: ReturnPolicySchema.nullable().optional(),
        cancellation_policy: CancellationPolicySchema.nullable().optional(),
        support_policy: SupportPolicySchema.nullable().optional(),
        // Additional terms that don't fit the structured fields above (e.g. a signed PDF addendum).
        documents: z.array(z.string().url()).max(2, 'Maximum 2 documents allowed').optional(),
    }).nullable().optional(),
    notificationPreferences: z
        .object({
            email: z.boolean().optional(),
            whatsapp: z.boolean().optional(),
            phone: z.boolean().optional(),
        })
        .optional(),
    version: z.number().int().min(0),
});

export type UpdateVendorProfileInput = z.infer<typeof UpdateVendorProfileSchema>;

// ─── Password Update ─────────────────────────────────────────────────────────
// Canonical definitions live in the users module (the password is account-level,
// not vendor-level — see /api/me/password). Re-exported for backward compatibility.

export {
    PasswordStrengthSchema,
    UpdatePasswordSchema,
    type UpdatePasswordInput,
} from '../../users/user.validator';
