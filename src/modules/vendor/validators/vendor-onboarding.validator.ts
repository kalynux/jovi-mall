import { z } from 'zod';
import { GeoPointZodSchema } from '../../../core/types/geo.types';
import { PayoutDetailsZodSchema } from '../../../core/types/payout.types';

// ─── Re-usable sub-schemas ────────────────────────────────────────────────────

const BusinessAddressSchema = z.object({
    label: z.string().min(1).max(50).trim(),
    address_line1: z.string().min(1).max(200).trim(),
    address_line2: z.string().max(200).trim().nullable().optional(),
    city: z.string().min(1).max(100).trim(),
    state: z.string().max(100).trim().nullable().optional(),
    location: GeoPointZodSchema.nullable().optional(),
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
    logo_url: z.string().url('logo_url must be a valid URL').nullable().optional(),
    cover_image_url: z.string().url('cover_image_url must be a valid URL').nullable().optional(),
});

const SocialLinksSchema = z.object({
    instagram: z.string().url().nullable().optional(),
    facebook: z.string().url().nullable().optional(),
    twitter: z.string().url().nullable().optional(),
});

const KycDetailsSchema = z.object({
    national_id_number: z.string().min(1).trim().nullable().optional(),
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
//   default_delivery_agency_id — skip if vendor sells services only

export const VendorOnboardingStep2Schema = z.object({
    /** Set to true to skip this step without selecting a delivery agency. */
    skip: z.boolean().optional().default(false),
    default_delivery_agency_id: z
        .string()
        .min(1, 'A delivery agency ID is required when not skipping')
        .trim()
        .optional(),
}).refine(
    (data) => data.skip || !!data.default_delivery_agency_id,
    {
        message: 'Either skip must be true or a default_delivery_agency_id must be provided',
        path: ['default_delivery_agency_id'],
    }
);

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
    return_condition_notes: z.string().max(500).trim().nullable().optional(),
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
    eligibility_notes: z.string().max(500).trim().nullable().optional(),
    required_info: z.array(z.enum(['order_number', 'product_photo_video', 'tracking_number'])).optional(),
    availability: z.enum(['24_7', 'business_hours', 'limited']).nullable().optional(),
    availability_description: z.string().max(200).trim().nullable().optional(),
    languages: z.array(z.string().min(1).max(50).trim()).max(20).optional(),
});

export const VendorOnboardingStep4Schema = z.object({
    /** Set to true to skip this step without providing policy data. */
    skip: z.boolean().optional().default(false),
    return_policy: ReturnPolicySchema.optional(),
    cancellation_policy: CancellationPolicySchema.optional(),
    support_policy: SupportPolicySchema.optional(),
});

export type VendorOnboardingStep4Input = z.infer<typeof VendorOnboardingStep4Schema>;

// ─── General Profile Update ───────────────────────────────────────────────────
//   For PATCH /profile — updates allowed outside of the onboarding flow

export const UpdateVendorProfileSchema = z.object({
    displayName: z.string().min(2).max(100).trim().optional(),
    businessDescription: z.string().max(1000).trim().nullable().optional(),
    email: z.string().email().optional(),
    phone: z.string().min(8).max(20).optional(),
    timezone: z.string().min(1).trim().optional(),
    country: z.string().length(2).toUpperCase().optional(),
    branding: BrandingSchema.optional(),
    business_addresses: z.array(BusinessAddressSchema).optional(),
    operating_hours: z.array(OperatingHoursSchema).optional(),
    payout_details: PayoutDetailsZodSchema.optional(),
    kyc_details: KycDetailsSchema.optional(),
    social_links: SocialLinksSchema.optional(),
    policies: z.object({
        return_policy: ReturnPolicySchema.nullable().optional(),
        cancellation_policy: CancellationPolicySchema.nullable().optional(),
        support_policy: SupportPolicySchema.nullable().optional(),
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

// ─── Password Update (used by vendor-profile.controller.ts) ──────────────────

export const PasswordStrengthSchema = z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
    .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const UpdatePasswordSchema = z.object({
    oldPassword: z.string().min(1, 'Current password is required'),
    newPassword: PasswordStrengthSchema,
});

export type UpdatePasswordInput = z.infer<typeof UpdatePasswordSchema>;
