import mongoose, { Schema, Document } from 'mongoose';
// No geo types needed
import { PayoutMethodSchema, IPayoutMethod } from '../../core/types/payout.types';
import { AgencyOnboardingStep } from '../../core/constants/onboarding-steps';

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

const AgencyPoliciesSchema = new Schema(
  {
    pricing: { type: AgencyPoliciesPricingSchema, required: true },
    returns: { type: AgencyPoliciesReturnsSchema, required: true },
    damage: { type: AgencyPoliciesDamageSchema, required: true },
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
  },
  { _id: false }
);

// ─── Headquarters Address Sub-Schema ─────────────────────────────────────────

const SupportContactSchema = new Schema(
  {
    phone: { type: String, required: true, trim: true },
    email: { type: String, default: null, trim: true, lowercase: true },
  },
  { _id: false }
);

const HeadquartersAddressSchema = new Schema(
  {
    region: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    address_description: { type: String, required: true, trim: true },
    support_contact: { type: SupportContactSchema, required: true },
  },
  { _id: true }
);

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

export interface IAgencyPolicies {
  pricing: IAgencyPoliciesPricing;
  returns: IAgencyPoliciesReturns;
  damage: IAgencyPoliciesDamage;
}

export interface IAgencyKycDetails {
  registration_number: string | null;
  transport_license_id: string | null;
  legit_verified: boolean;
}

export interface IAgencySupportContact {
  phone: string;
  email: string | null;
}

export interface IAgencyHeadquartersAddress {
  _id: mongoose.Types.ObjectId;
  region: string;
  city: string;
  address_description: string;
  support_contact: IAgencySupportContact;
}

export interface IDeliveryAgency extends Document {
  user_id: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  agency_name: string;
  logo_url: string | null;
  /**
   * Regions covering this agency's service areas.
   * Min 1 when onboarding is complete.
   */
  coverage_areas: string[];
  /**
   * Physical locations. Min 1 entry required.
   * First entry (index 0) is always the PRIMARY headquarters.
   */
  headquarters_addresses: IAgencyHeadquartersAddress[];
  /**
   * Ordered list of payout methods. The FIRST entry is the preferred / default method.
   * Min 1 entry when onboarding is complete.
   */
  payout_details: IPayoutMethod[];
  kyc_details: IAgencyKycDetails;
  policies: IAgencyPolicies | null;
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
  status: 'active' | 'pending_verification' | 'inactive';
  /**
   * Onboarding progress. See AgencyOnboardingStep constants.
   * Recalculated from field presence after every write.
   */
  onboarding_step: number;
  created_at: Date;
  updated_at: Date;
}

// ─── Mongoose Schema ──────────────────────────────────────────────────────────

const DeliveryAgencySchema = new Schema<IDeliveryAgency>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    email: { type: String, trim: true, lowercase: true },
    email_verified: { type: Boolean, default: false },
    phone: { type: String, trim: true },
    phone_verified: { type: Boolean, default: false },
    agency_name: { type: String, required: true },
    logo_url: { type: String, default: null },
    coverage_areas: { type: [String], default: [] },
    headquarters_addresses: { type: [HeadquartersAddressSchema], default: [] },
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
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Geospatial indexes were removed as location data is now string-based.

export const DeliveryAgencyModel = mongoose.model<IDeliveryAgency>('DeliveryAgency', DeliveryAgencySchema);
