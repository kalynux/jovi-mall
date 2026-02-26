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

// ─── Step 2: Delivery Linking (REQUIRED) ──────────────────────────────────────
//   default_delivery_agency_id

export const VendorOnboardingStep2Schema = z.object({
    default_delivery_agency_id: z
        .string()
        .min(1, 'A delivery agency must be selected')
        .trim(),
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
