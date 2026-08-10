import { z } from 'zod';
import { PayoutDetailsZodSchema } from '../../../core/types/payout.types';
import { SUPPORTED_LANGUAGES } from '../../../core/constants/languages';
import { clearable } from '../../../core/validation/zod.helpers';
// Coverage areas + HQ addresses live on the Magazin — reuse its geocoded HQ shape
// (client sends a `/api/geo/search` result as `geo`; `location` is derived on write)
// and its array schema, which carries the duplicate-id guard both paths need.
import { MagazinHeadquartersAddressArraySchema } from '../../magazin/validators/magazin.validator';

// ─── Agency Creation ──────────────────────────────────────────────────────────

export const CreateAgencySchema = z.object({
    agency_name: z.string().min(1, 'Agency name is required').max(200).trim(),
});

export type CreateAgencyInput = z.infer<typeof CreateAgencySchema>;

const KycDetailsSchema = z.object({
    registration_number: clearable(z.string().min(1).trim()),
    transport_license_id: clearable(z.string().min(1).trim()),
});

// ─── Step 1: Logistics Setup (REQUIRED) ───────────────────────────────────────
//   country, coverage_areas (min 1), headquarters_addresses (min 1, first = primary)

export const AgencyOnboardingStep1Schema = z.object({
    // ISO-2, e.g. "CM". Set once here; immutable after onboarding completes.
    // Headquarters addresses must geocode inside this country.
    country: z.string().length(2, 'Country must be an ISO-2 code (e.g. "CM")').toUpperCase(),
    coverage_areas: z
        .array(z.string().min(1).trim())
        .min(1, 'At least one coverage area (region) is required'),
    headquarters_addresses: MagazinHeadquartersAddressArraySchema,
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
    // Id of a file uploaded via POST /api/files/upload ('' or null clears it).
    logo_file_id: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'logo_file_id must be a valid file id')),
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

// COD participation. The per-collection fee itself lives in
// pricing.additional_fees.cod_handling_fee; this block only gates eligibility.
const AgencyPoliciesCodZodSchema = z.object({
    enabled: z.boolean(),
    max_order_amount: z.number().min(0).nullable().optional().default(null),
});

const AgencyPoliciesZodSchema = z.object({
    pricing: AgencyPoliciesPricingZodSchema,
    returns: AgencyPoliciesReturnsZodSchema,
    damage: AgencyPoliciesDamageZodSchema,
    cod: AgencyPoliciesCodZodSchema.optional().default({ enabled: false, max_order_amount: null }),
    // Additional terms that don't fit the structured fields above (e.g. a signed PDF addendum).
    documents: z.array(z.string().url()).max(2, 'Maximum 2 documents allowed').optional(),
});

export const AgencyOnboardingStep4Schema = z.object({
    policies: AgencyPoliciesZodSchema,
});

export type AgencyOnboardingStep4Input = z.infer<typeof AgencyOnboardingStep4Schema>;

// ─── General Profile Update ───────────────────────────────────────────────────

export const UpdateAgencyProfileSchema = z.object({
    // Personal/contact display name. The BUSINESS name lives on the Magazin
    // (PATCH /api/agency/magazin), not here — mirroring the vendor Store split.
    displayName: z.string().min(2).max(100).trim().optional(),
    // Personal profile avatar as a File reference ('' / null clears it). The
    // business logo lives on the Magazin.
    avatarFileId: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'avatarFileId must be a valid file id')),
    timezone: z.string().min(1).trim().optional(),
    preferred_language: z.enum(SUPPORTED_LANGUAGES).optional(),
    // SET-ONCE: accepted only while the profile has no country yet (legacy
    // rows) or as an idempotent echo of the current value — changes are
    // rejected by the service (PROFILE_COUNTRY_IMMUTABLE).
    country: z.string().length(2, 'Country must be an ISO-2 code (e.g. "CM")').toUpperCase().optional(),
    // coverage_areas + headquarters_addresses moved to the Magazin
    // (PATCH /api/agency/magazin), where they are validated against `country`.
    payout_details: PayoutDetailsZodSchema.optional(), // array of IPayoutMethod
    kyc_details: KycDetailsSchema.optional(),
    policies: AgencyPoliciesZodSchema.optional(),
});

export type UpdateAgencyProfileInput = z.infer<typeof UpdateAgencyProfileSchema>;
