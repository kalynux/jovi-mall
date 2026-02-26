import { z } from 'zod';
import { GeoPointZodSchema, PolygonZodSchema } from '../../../core/types/geo.types';
import { PayoutDetailsZodSchema } from '../../../core/types/payout.types';

// ─── Re-usable sub-schemas ────────────────────────────────────────────────────

const SupportContactSchema = z.object({
    phone: z.string().min(6).max(20).trim(),
    email: z.string().email().nullable().optional(),
});

const HeadquartersAddressSchema = z.object({
    address_line1: z.string().min(1).max(200).trim(),
    city: z.string().min(1).max(100).trim(),
    country: z.string().length(2).toUpperCase(),
    location: GeoPointZodSchema.nullable().optional(),
    support_contact: SupportContactSchema,
});

const KycDetailsSchema = z.object({
    registration_number: z.string().min(1).trim().nullable().optional(),
    transport_license_id: z.string().min(1).trim().nullable().optional(),
});

// ─── Step 1: Logistics Setup (REQUIRED) ───────────────────────────────────────
//   coverage_areas (min 1), headquarters_addresses (min 1, first = primary)

export const AgencyOnboardingStep1Schema = z.object({
    coverage_areas: z
        .array(PolygonZodSchema)
        .min(1, 'At least one coverage area (polygon) is required'),
    headquarters_addresses: z
        .array(HeadquartersAddressSchema)
        .min(1, 'At least one headquarters address is required. The first entry is the primary.'),
});

export type AgencyOnboardingStep1Input = z.infer<typeof AgencyOnboardingStep1Schema>;

// ─── Step 2: Payout Setup (REQUIRED) ─────────────────────────────────────────

export const AgencyOnboardingStep2Schema = z.object({
    payout_details: PayoutDetailsZodSchema,
});

export type AgencyOnboardingStep2Input = z.infer<typeof AgencyOnboardingStep2Schema>;

// ─── Step 3: Branding (OPTIONAL / SKIPPABLE) ──────────────────────────────────

export const AgencyOnboardingStep3Schema = z.object({
    /** Set to true to skip this step without providing branding data. */
    skip: z.boolean().optional().default(false),
    logo_url: z.string().url('logo_url must be a valid URL').nullable().optional(),
    timezone: z.string().min(1).trim().optional(),
});

export type AgencyOnboardingStep3Input = z.infer<typeof AgencyOnboardingStep3Schema>;

// ─── General Profile Update ───────────────────────────────────────────────────

export const UpdateAgencyProfileSchema = z.object({
    agency_name: z.string().min(1).max(200).trim().optional(),
    logo_url: z.string().url().nullable().optional(),
    timezone: z.string().min(1).trim().optional(),
    coverage_areas: z.array(PolygonZodSchema).min(1).optional(),
    headquarters_addresses: z.array(HeadquartersAddressSchema).min(1).optional(),
    payout_details: PayoutDetailsZodSchema.optional(),
    kyc_details: KycDetailsSchema.optional(),
});

export type UpdateAgencyProfileInput = z.infer<typeof UpdateAgencyProfileSchema>;
