import mongoose, { Schema, Document, Types } from 'mongoose';
import { PayoutMethodSchema, IPayoutMethod } from '../../core/types/payout.types';
import { ActorSource, actorStampFields } from '../../core/types/actor-source.types';
import { AgencyOnboardingStep } from '../../core/constants/onboarding-steps';
import { SUPPORTED_LANGUAGES, Language } from '../../core/constants/languages';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

// ─── Policies Sub-Schemas ─────────────────────────────────────────────────────

const StorageBasedPricingSchema = new Schema(
  {
    enabled: { type: Boolean, required: true, default: true },
    monthly_storage_fee_per_sku: { type: Number, required: true, min: 0 },
    pick_pack_fee_per_order: { type: Number, required: true, min: 0 },
    local_delivery_fee: { type: Number, required: true, min: 0 },
    out_of_region_delivery_fee: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const PickupBasedPricingSchema = new Schema(
  {
    enabled: { type: Boolean, required: true, default: true },
    base_rate_first_kg: { type: Number, required: true, min: 0 },
    additional_per_kg: { type: Number, required: true, min: 0 },
    out_of_region_surcharge: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const CodHandlingFeeSchema = new Schema(
  {
    type: { type: String, enum: ['percentage', 'fixed'], required: true },
    value: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const AdditionalFeesSchema = new Schema(
  {
    cod_handling_fee: { type: CodHandlingFeeSchema, required: true },
    failed_delivery_fee: { type: Number, required: true, min: 0 },
    rto_fee: { type: Number, required: true, min: 0 },
    peak_season_surcharge: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const AgencyPoliciesPricingSchema = new Schema(
  {
    storage_based: { type: StorageBasedPricingSchema, required: true },
    pickup_based: { type: PickupBasedPricingSchema, required: true },
    additional_fees: { type: AdditionalFeesSchema, required: true },
    notes: { type: String, default: null, maxlength: 700, trim: true },
  },
  { _id: false }
);

const AgencyPoliciesReturnsSchema = new Schema(
  {
    payer: { type: String, enum: ['vendor', 'agency', 'customer'], required: true },
    handling_fee: { type: Number, required: true, min: 0 },
    return_window_days: { type: Number, required: true, min: 0 },
    notes: { type: String, default: null, maxlength: 700, trim: true },
  },
  { _id: false }
);

const AgencyPoliciesDamageSchema = new Schema(
  {
    claim_deadline_days: { type: Number, required: true, min: 0 },
    max_refund_per_item: { type: Number, required: true, min: 0 },
    /** Admin-controlled. Defaults to 'agency' and can only be changed by an admin. */
    inspector: { type: String, enum: ['agency', 'vendor', 'admin'], default: 'admin' },
    /** Admin-controlled. Defaults to 1000 and can only be changed by an admin. */
    investigation_fee: { type: Number, default: 1000, min: 0 },
    notes: { type: String, default: null, maxlength: 700, trim: true },
  },
  { _id: false }
);

const AgencyPoliciesCodSchema = new Schema(
  {
    /** Whether this agency handles cash-on-delivery orders at all. */
    enabled: { type: Boolean, required: true, default: false },
    /**
     * Optional cap on a single COD order's total (minor units). Checkout
     * rejects COD orders above it. null = no per-order cap.
     */
    max_order_amount: { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

const AgencyPoliciesSchema = new Schema(
  {
    pricing: { type: AgencyPoliciesPricingSchema, required: true },
    returns: { type: AgencyPoliciesReturnsSchema, required: true },
    damage: { type: AgencyPoliciesDamageSchema, required: true },
    /**
     * COD participation. Fee charged per COD collection is configured in
     * `pricing.additional_fees.cod_handling_fee`; this block only gates
     * eligibility. Defaults to disabled — agencies opt in explicitly.
     */
    cod: {
      type: AgencyPoliciesCodSchema,
      required: true,
      default: () => ({ enabled: false, max_order_amount: null }),
    },
    /**
     * Up to 2 supporting document URLs (e.g. PDFs) covering additional terms
     * that don't fit the structured fields above.
     */
    documents: {
      type: [String],
      default: [],
      validate: {
        validator: (docs: string[]) => docs.length <= 2,
        message: 'Maximum 2 policy documents allowed',
      },
    },
  },
  { _id: false }
);

// ─── KYC Details Sub-Schema ───────────────────────────────────────────────────

const AgencyKycDetailsSchema = new Schema(
  {
    registration_number: { type: String, default: null, trim: true },
    transport_license_id: { type: String, default: null, trim: true },
    /**
     * Verification flag. Only Admin can set this to true.
     * Agencies submit kyc data; admin controls legit_verified.
     */
    legit_verified: { type: Boolean, default: false },
    /**
     * Who approved the verification, and when (Phase 9).
     *
     * Until then the flag was written by nothing — `setLegitVerified` had no caller — so
     * there was nothing to stamp. `POST /api/admin/delivery-agencies/:id/verify` is the
     * one writer, and the actor is usually an administrator whose id resolves in the
     * wi-admin database and nowhere here, which is exactly what the `_source`/`_name`
     * companions from `actorStampFields` exist to make legible.
     */
    verified_at: { type: Date, default: null },
    verified_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    ...actorStampFields('verified_by'),
  },
  { _id: false }
);

// Coverage areas + headquarters addresses (the agency's logistics footprint)
// live on the Magazin — the agency's business surface — not here. See
// `src/modules/magazin/models/magazin.model.ts`.

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface IStorageBasedPricing {
  enabled: boolean;
  monthly_storage_fee_per_sku: number;
  pick_pack_fee_per_order: number;
  local_delivery_fee: number;
  out_of_region_delivery_fee: number;
}

export interface IPickupBasedPricing {
  enabled: boolean;
  base_rate_first_kg: number;
  additional_per_kg: number;
  out_of_region_surcharge: number;
}

export interface ICodHandlingFee {
  type: 'percentage' | 'fixed';
  value: number;
}

export interface IAdditionalFees {
  cod_handling_fee: ICodHandlingFee;
  failed_delivery_fee: number;
  rto_fee: number;
  peak_season_surcharge?: number;
}

export interface IAgencyPoliciesPricing {
  storage_based: IStorageBasedPricing;
  pickup_based: IPickupBasedPricing;
  additional_fees: IAdditionalFees;
  notes?: string | null;
}

export interface IAgencyPoliciesReturns {
  payer: 'vendor' | 'agency' | 'customer';
  handling_fee: number;
  return_window_days: number;
  notes?: string | null;
}

export interface IAgencyPoliciesDamage {
  claim_deadline_days: number;
  max_refund_per_item: number;
  /** Admin-controlled preset. Never set by the frontend. Defaults to 'agency'. */
  inspector?: 'agency' | 'vendor' | 'admin';
  /** Admin-controlled preset. Never set by the frontend. Defaults to 1000. */
  investigation_fee?: number;
  notes?: string | null;
}

export interface IAgencyPoliciesCod {
  enabled: boolean;
  max_order_amount: number | null;
}

export interface IAgencyPolicies {
  pricing: IAgencyPoliciesPricing;
  returns: IAgencyPoliciesReturns;
  damage: IAgencyPoliciesDamage;
  cod: IAgencyPoliciesCod;
  /** Up to 2 supporting document URLs (e.g. PDFs) for terms not covered above. */
  documents?: string[];
}

export interface IAgencyKycDetails {
  registration_number: string | null;
  transport_license_id: string | null;
  legit_verified: boolean;
  /** Stamped by `POST /api/admin/delivery-agencies/:id/verify` (Phase 9). */
  verified_at?: Date | null;
  verified_by_user_id?: Types.ObjectId | string | null;
  verified_by_source?: ActorSource;
  verified_by_name?: string | null;
}

/**
 * Auto-assignment participation. When enabled, a shipment handed to this agency
 * is auto-offered to the top-ranked eligible agent (closest to pickup, free
 * capacity, trust, COD-clearable) instead of waiting for a manual pick. Defaults
 * OFF — an agency opts in explicitly. The offer TIMEOUT is a platform default,
 * not configured here.
 */
export interface IAgencyAssignmentSettings {
  auto_assign_enabled: boolean;
}

export interface IDeliveryAgency extends Document {
  user_id: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  /**
   * Personal/contact display name for this agency account. The public BUSINESS
   * name lives on the agency's Magazin (see `src/modules/magazin/`), not here —
   * mirroring how a vendor's business name lives on their Store.
   */
  display_name?: string;
  /**
   * Personal profile avatar, held as a File reference (not a URL) so it registers
   * in `file_references` and is deletion-protected — distinct from the business
   * logo on the Magazin.
   */
  avatar_file_id: mongoose.Types.ObjectId | null;
  /**
   * ISO-2 country the agency operates in (e.g. "CM"). Set once during
   * onboarding Step 1 and immutable afterwards — it anchors the Magazin's
   * coverage areas (must be regions of this country) and headquarters-address
   * geo policy. Null only on legacy documents that predate the field.
   */
  country: string | null;
  // NOTE: coverage_areas + headquarters_addresses live on the Magazin, not here.
  /**
   * Ordered list of payout methods. The FIRST entry is the preferred / default method.
   * Min 1 entry when onboarding is complete.
   */
  payout_details: IPayoutMethod[];
  kyc_details: IAgencyKycDetails;
  policies: IAgencyPolicies | null;
  /** Auto-assignment participation for the agent-acceptance workflow. */
  assignment_settings: IAgencyAssignmentSettings;
  /**
   * Incremented every time `policies` changes. Distinct from `version` (optimistic
   * concurrency) — this one is watched by the agency-connections module to detect
   * a policy edit and pause any active connections that need reapproval.
   */
  policy_version: number;
  /** @deprecated Use kyc_details.legit_verified. Kept for backward compat. */
  legit_verified: boolean;
  wa?: {
    name?: string;
    wa_phone_id?: string;
    verified: boolean;
    bound_at?: Date;
    last_seen_at?: Date;
  };
  timezone: string;
  /** Preferred language for notifications/messaging (ISO 639-1). */
  preferred_language: Language;
  status: 'active' | 'pending_verification' | 'inactive';
  /**
   * Onboarding progress. See AgencyOnboardingStep constants.
   * Recalculated from field presence after every write.
   */
  onboarding_step: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

// ─── Mongoose Schema ──────────────────────────────────────────────────────────

const DeliveryAgencySchema = new Schema<IDeliveryAgency>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true, unique: true },
    email: { type: String, trim: true, lowercase: true },
    email_verified: { type: Boolean, default: false },
    phone: { type: String, trim: true },
    phone_verified: { type: Boolean, default: false },
    display_name: { type: String },
    avatar_file_id: { type: Schema.Types.ObjectId, ref: MODELS.FILE, default: null },
    country: { type: String, default: null, trim: true, uppercase: true },
    // coverage_areas + headquarters_addresses moved to the Magazin.
    payout_details: { type: [PayoutMethodSchema], default: [] },
    kyc_details: {
      type: AgencyKycDetailsSchema,
      default: () => ({
        registration_number: null,
        transport_license_id: null,
        legit_verified: false,
      }),
    },
    policies: { type: AgencyPoliciesSchema, default: null },
    assignment_settings: {
      type: new Schema<IAgencyAssignmentSettings>(
        { auto_assign_enabled: { type: Boolean, required: true, default: false } },
        { _id: false }
      ),
      required: true,
      default: () => ({ auto_assign_enabled: false }),
    },
    policy_version: { type: Number, default: 0 },
    /** @deprecated */
    legit_verified: { type: Boolean, default: false },
    wa: {
      name: String,
      wa_phone_id: String,
      verified: { type: Boolean, default: false },
      bound_at: Date,
      last_seen_at: Date,
    },
    timezone: { type: String, default: 'Africa/Douala', required: true },
    preferred_language: { type: String, enum: SUPPORTED_LANGUAGES, default: 'en' },
    status: {
      type: String,
      enum: ['active', 'pending_verification', 'inactive'],
      default: 'pending_verification',
    },
    onboarding_step: {
      type: Number,
      default: AgencyOnboardingStep.LOGISTICS_SETUP,
      min: 0,
    },
    version: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// HQ geospatial indexes moved to the Magazin schema (coverage/HQ live there now).

// ── The administrative directory (wi-admin `GET /api/v1/agencies`) ──────────
//
// Until Phase 9 this schema declared NO index at all beyond the unique `user_id`
// its field definition creates — including none behind `findAllForAdmin`, which
// filters on `status` and pages. That was survivable only because the collection
// is small; it is still a collection scan plus a blocking sort.
//
// Both forms, for the same reason as the agent directory: a single-field index is
// walkable in either direction, a compound one only in the declared one.
//
// Note what is deliberately NOT indexed: the business name. It lives on the
// Magazin, and both admin list queries sort or search it AFTER a `$lookup`, where
// no index on the joined collection is reachable. Making it indexable means
// driving the pipeline from `agency_magazins`, which loses every agency that has
// not been provisioned one.
DeliveryAgencySchema.index({ created_at: -1 });
DeliveryAgencySchema.index({ status: 1, created_at: -1 });

export const DeliveryAgencyModel = mongoose.model<IDeliveryAgency>(MODELS.DELIVERY_AGENCY, DeliveryAgencySchema, COLLECTIONS.DELIVERY_AGENCY);
