import { z } from 'zod';
// No geo types exported here
import { PayoutDetailsZodSchema } from '../../../core/types/payout.types';
import { SUPPORTED_LANGUAGES } from '../../../core/constants/languages';

// ─── Re-usable sub-schemas ────────────────────────────────────────────────────

const SupportContactSchema = z.object({
    phone: z.string().min(6).max(20).trim().regex(/^\+?[0-9\s\-()]+$/, 'Invalid phone number format'),
    email: z.string().email('Invalid email format').nullable().optional(),
});

// ─── Agency Creation ──────────────────────────────────────────────────────────

export const CreateAgencySchema = z.object({
    agency_name: z.string().min(1, 'Agency name is required').max(200).trim(),
});

export type CreateAgencyInput = z.infer<typeof CreateAgencySchema>;

const HeadquartersAddressSchema = z.object({
    region: z.string().min(1).max(100).trim(),
    city: z.string().min(1).max(100).trim(),
    address_description: z.string().min(1).max(200).trim(),
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
        .array(z.string().min(1).trim())
        .min(1, 'At least one coverage area (region) is required'),
    headquarters_addresses: z
        .array(HeadquartersAddressSchema)
        .min(1, 'At least one headquarters address is required. The first entry is the primary.'),
});

export type AgencyOnboardingStep1Input = z.infer<typeof AgencyOnboardingStep1Schema>;

// ─── Step 2: Payout Setup (REQUIRED) ─────────────────────────────────────────────────────
//   payout_details: ordered array of payout methods (min 1, first = preferred)

export const AgencyOnboardingStep2Schema = z.object({
    payout_details: PayoutDetailsZodSchema, // array of IPayoutMethod
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

// ─── Step 4: Policy Setup (REQUIRED) ─────────────────────────────────────────
//   policies.pricing, policies.returns, policies.damage

const StorageBasedPricingZodSchema = z.object({
    enabled: z.boolean(),
    monthly_storage_fee_per_sku: z.number().min(0),
    pick_pack_fee_per_order: z.number().min(0),
    local_delivery_fee: z.number().min(0),
    out_of_region_delivery_fee: z.number().min(0),
});

const PickupBasedPricingZodSchema = z.object({
    enabled: z.boolean(),
    base_rate_first_kg: z.number().min(0),
    additional_per_kg: z.number().min(0),
    out_of_region_surcharge: z.number().min(0),
});

const CodHandlingFeeZodSchema = z.object({
    type: z.enum(['percentage', 'fixed']),
    value: z.number().min(0),
});

const AdditionalFeesZodSchema = z.object({
    cod_handling_fee: CodHandlingFeeZodSchema,
    failed_delivery_fee: z.number().min(0),
    rto_fee: z.number().min(0),
    peak_season_surcharge: z.number().min(0).optional().default(0),
});

const AgencyPoliciesPricingZodSchema = z.object({
    storage_based: StorageBasedPricingZodSchema,
    pickup_based: PickupBasedPricingZodSchema,
    additional_fees: AdditionalFeesZodSchema,
    notes: z.string().max(700).trim().optional(),
}).refine(
    (data) => data.storage_based.enabled || data.pickup_based.enabled,
    {
        message: 'At least one of storage_based or pickup_based must be enabled.',
        path: ['storage_based', 'enabled'],
    },
);

const AgencyPoliciesReturnsZodSchema = z.object({
    payer: z.enum(['vendor', 'agency', 'customer']),
    handling_fee: z.number().min(0),
    return_window_days: z.number().min(0),
    notes: z.string().max(700).trim().optional(),
});

// inspector and investigation_fee are admin-controlled presets — excluded from frontend input.
const AgencyPoliciesDamageZodSchema = z.object({
    claim_deadline_days: z.number().min(0),
    max_refund_per_item: z.number().min(0),
    notes: z.string().max(700).trim().optional(),
});

const AgencyPoliciesZodSchema = z.object({
    pricing: AgencyPoliciesPricingZodSchema,
    returns: AgencyPoliciesReturnsZodSchema,
    damage: AgencyPoliciesDamageZodSchema,
    // Additional terms that don't fit the structured fields above (e.g. a signed PDF addendum).
    documents: z.array(z.string().url()).max(2, 'Maximum 2 documents allowed').optional(),
});

export const AgencyOnboardingStep4Schema = z.object({
    policies: AgencyPoliciesZodSchema,
});

export type AgencyOnboardingStep4Input = z.infer<typeof AgencyOnboardingStep4Schema>;

// ─── General Profile Update ───────────────────────────────────────────────────

export const UpdateAgencyProfileSchema = z.object({
    agency_name: z.string().min(1).max(200).trim().optional(),
    logo_url: z.string().url().nullable().optional(),
    timezone: z.string().min(1).trim().optional(),
    preferred_language: z.enum(SUPPORTED_LANGUAGES).optional(),
    coverage_areas: z.array(z.string().min(1).trim()).min(1).optional(),
    headquarters_addresses: z.array(HeadquartersAddressSchema).min(1).optional(),
    payout_details: PayoutDetailsZodSchema.optional(), // array of IPayoutMethod
    kyc_details: KycDetailsSchema.optional(),
    policies: AgencyPoliciesZodSchema.optional(),
});

export type UpdateAgencyProfileInput = z.infer<typeof UpdateAgencyProfileSchema>;
