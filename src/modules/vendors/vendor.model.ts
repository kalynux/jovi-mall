import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../core/types/geo.types';
import { GeoAddressSchema, IGeoAddress } from '../../core/types/geo-address.types';
import { PayoutMethodSchema, IPayoutDetails } from '../../core/types/payout.types';
import { VendorOnboardingStep } from '../../core/constants/onboarding-steps';
import { SUPPORTED_LANGUAGES, Language } from '../../core/constants/languages';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

// ─── Vendor Policy Sub-Schemas ────────────────────────────────────────────────

const VendorReturnPolicySchema = new Schema(
  {
    return_eligible: { type: Boolean, required: true, default: true },
    return_window_days: { type: Number, required: true, min: 0, max: 180, default: 14 },
    refund_type: { type: String, enum: ['full', 'partial', 'none'], required: true, default: 'full' },
    refund_percentage: { type: Number, min: 0, max: 100, default: null },
    return_shipping_payer: {
      type: String,
      enum: ['vendor', 'customer', 'customer_reimbursed_if_defect'],
      required: true,
      default: 'customer',
    },
    refund_processing_days: { type: Number, required: true, min: 1, max: 30, default: 7 },
    return_condition_notes: { type: String, default: null, maxlength: 500, trim: true },
    /** Admin-controlled. Defaults to 'admin'. Vendors cannot change this. */
    inspector: { type: String, enum: ['admin', 'vendor', 'platform'], default: 'admin' },
  },
  { _id: false },
);

const VendorCancellationPolicySchema = new Schema(
  {
    cancellable: { type: Boolean, required: true, default: true },
    cancellation_deadline: {
      type: String,
      enum: [
        'within_1_hour',
        'within_24_hours',
        'before_vendor_confirmation',
        'before_service_start',
        'anytime_until_days_before_delivery',
      ],
      default: null,
    },
    cancellation_deadline_days: { type: Number, min: 0, default: null },
    cancellation_fee_type: {
      type: String,
      enum: ['none', 'fixed', 'percentage', 'full_non_refundable'],
      default: 'none',
    },
    cancellation_fee_value: { type: Number, min: 0, default: null },
    late_cancellation_refund_type: {
      type: String,
      enum: ['fixed', 'percentage', 'full_non_refundable'],
      default: null,
    },
    late_cancellation_refund_value: { type: Number, min: 0, default: null },
  },
  { _id: false },
);

const VendorSupportChannelSchema = new Schema(
  {
    type: { type: String, enum: ['email', 'phone', 'whatsapp', 'telegram'], required: true },
    contact: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const VendorSupportPolicySchema = new Schema(
  {
    channels: { type: [VendorSupportChannelSchema], default: [] },
    eligibility_notes: { type: String, default: null, maxlength: 500, trim: true },
    required_info: {
      type: [String],
      enum: ['order_number', 'product_photo_video', 'tracking_number'],
      default: [],
    },
    availability: {
      type: String,
      enum: ['24_7', 'business_hours', 'limited'],
      default: null,
    },
    availability_description: { type: String, default: null, maxlength: 200, trim: true },
    languages: { type: [String], default: [] },
  },
  { _id: false },
);

const VendorPoliciesSchema = new Schema(
  {
    return_policy: { type: VendorReturnPolicySchema, default: null },
    cancellation_policy: { type: VendorCancellationPolicySchema, default: null },
    support_policy: { type: VendorSupportPolicySchema, default: null },
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
  { _id: false },
);

// ─── Operating Hours Sub-Schema ───────────────────────────────────────────────

const OperatingHoursSchema = new Schema(
  {
    day: {
      type: String,
      required: true,
      enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    },
    open_time: { type: String, required: true },   // "HH:MM" format
    close_time: { type: String, required: true },  // "HH:MM" format
    is_closed: { type: Boolean, default: false },
  },
  { _id: false }
);

// ─── Business Address Sub-Schema ─────────────────────────────────────────────

const BusinessAddressSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },         // e.g. "Main Shop", "Warehouse"
    address_line1: { type: String, required: true, trim: true },
    address_line2: { type: String, default: null, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, default: null, trim: true },
    /** @deprecated Bare coordinate kept for backward compatibility. Prefer `geo`. */
    location: { type: GeoPointSchema, default: null },
    /**
     * Canonical geospatial address (formatted address + coordinates + provider
     * place id + admin components). Populated when the vendor selects an
     * address-search result; null on legacy/plain-text entries.
     */
    geo: { type: GeoAddressSchema, default: null },
  },
  { _id: true }
);

// ─── KYC Details Sub-Schema ───────────────────────────────────────────────────

const VendorKycDetailsSchema = new Schema(
  {
    national_id_number: { type: String, default: null, trim: true },
    /**
     * Verification flag. Only Admin can set this to true.
     * Vendors can submit their national_id_number, but legit_verified
     * is admin-controlled.
     */
    legit_verified: { type: Boolean, default: false },
  },
  { _id: false }
);

// ─── Social Links Sub-Schema ──────────────────────────────────────────────────

const SocialLinksSchema = new Schema(
  {
    instagram: { type: String, default: null, trim: true },
    facebook: { type: String, default: null, trim: true },
    twitter: { type: String, default: null, trim: true },
  },
  { _id: false }
);

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface IVendorReturnPolicy {
  return_eligible: boolean;
  return_window_days: number;
  refund_type: 'full' | 'partial' | 'none';
  refund_percentage: number | null;
  return_shipping_payer: 'vendor' | 'customer' | 'customer_reimbursed_if_defect';
  refund_processing_days: number;
  return_condition_notes: string | null;
  /** Admin-controlled. Never set by vendor input. Defaults to 'admin'. */
  inspector?: 'admin' | 'vendor' | 'platform';
}

export interface IVendorCancellationPolicy {
  cancellable: boolean;
  cancellation_deadline: 'within_1_hour' | 'within_24_hours' | 'before_vendor_confirmation' | 'before_service_start' | 'anytime_until_days_before_delivery' | null;
  cancellation_deadline_days: number | null;
  cancellation_fee_type: 'none' | 'fixed' | 'percentage' | 'full_non_refundable' | null;
  cancellation_fee_value: number | null;
  late_cancellation_refund_type: 'fixed' | 'percentage' | 'full_non_refundable' | null;
  late_cancellation_refund_value: number | null;
}

export interface IVendorSupportChannel {
  type: 'email' | 'phone' | 'whatsapp' | 'telegram';
  contact: string;
}

export interface IVendorSupportPolicy {
  channels: IVendorSupportChannel[];
  eligibility_notes: string | null;
  required_info: Array<'order_number' | 'product_photo_video' | 'tracking_number'>;
  availability: '24_7' | 'business_hours' | 'limited' | null;
  availability_description: string | null;
  languages: string[];
}

export interface IVendorPolicies {
  return_policy: IVendorReturnPolicy | null;
  cancellation_policy: IVendorCancellationPolicy | null;
  support_policy: IVendorSupportPolicy | null;
  /** Up to 2 supporting document URLs (e.g. PDFs) for terms not covered above. */
  documents?: string[];
}

export interface IVendorBusinessAddress {
  _id: mongoose.Types.ObjectId;
  label: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string | null;
  /** @deprecated Prefer `geo.coordinates`. */
  location: IGeoPoint | null;
  /** Canonical geospatial address; null on legacy/plain-text entries. */
  geo: IGeoAddress | null;
}

export interface IVendorOperatingHours {
  day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  open_time: string;
  close_time: string;
  is_closed: boolean;
}

export interface IVendorKycDetails {
  national_id_number: string | null;
  legit_verified: boolean;
}

export interface IVendorSocialLinks {
  instagram: string | null;
  facebook: string | null;
  twitter: string | null;
}

export interface IVendor extends Document {
  user_id: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  /**
   * Personal/display name for the vendor account. The public BUSINESS name,
   * description, logo and banner all live on the vendor's Store (the single
   * source of truth) — see `src/modules/store/`.
   */
  display_name?: string;
  country: string;                                         // ISO-2 e.g. "CM"
  /**
   * Vendor's personal profile avatar, held as a File reference (not a URL) so it
   * registers in `file_references` and is deletion-protected — distinct from the
   * business logo/banner, which live on the Store.
   */
  avatar_file_id: mongoose.Types.ObjectId | null;
  business_addresses: IVendorBusinessAddress[];
  operating_hours: IVendorOperatingHours[];
  payout_details: IPayoutDetails | null;
  kyc_details: IVendorKycDetails;
  social_links: IVendorSocialLinks;
  policies: IVendorPolicies | null;
  /**
   * Incremented every time `policies` changes. Distinct from `version` (optimistic
   * concurrency) — this one is watched by the agency-connections module to detect
   * a policy edit and pause any active connections that need reapproval.
   */
  policy_version: number;
  /** @deprecated Use kyc_details.legit_verified instead. Kept for query backward compatibility during migration. */
  legit_verified: boolean;
  default_delivery_agency_id?: mongoose.Types.ObjectId | null;
  wa?: {
    verified: boolean;
    wa_phone_id?: string;
    name?: string;
    bound_at?: Date;
    last_seen_at?: Date;
  };
  notification_preferences: {
    email: boolean;
    whatsapp: boolean;
    phone: boolean;
  };
  two_factor_enabled: boolean;
  version: number;
  timezone: string;
  /** Preferred language for notifications/messaging (ISO 639-1). */
  preferred_language: Language;
  status: 'active' | 'pending_verification' | 'inactive';
  /**
   * Onboarding progress. See VendorOnboardingStep constants.
   * 0 = completed, 1+ = step to complete.
   * Recalculated from field presence after every profile write.
   */
  onboarding_step: number;
  created_at: Date;
  updated_at: Date;
}

// ─── Mongoose Schema ──────────────────────────────────────────────────────────

const VendorSchema = new Schema<IVendor>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true, unique: true },
    display_name: { type: String },
    country: { type: String, default: null, trim: true, uppercase: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    email_verified: { type: Boolean, default: false },
    phone_verified: { type: Boolean, default: false },
    avatar_file_id: { type: Schema.Types.ObjectId, ref: MODELS.FILE, default: null },
    business_addresses: { type: [BusinessAddressSchema], default: [] },
    operating_hours: { type: [OperatingHoursSchema], default: [] },
    // Ordered array of payout methods (max 3). The FIRST entry is the preferred one.
    // A vendor may have multiple mobile_money and/or bank entries.
    payout_details: { type: [PayoutMethodSchema], default: [] },
    kyc_details: {
      type: VendorKycDetailsSchema,
      default: () => ({ national_id_number: null, legit_verified: false }),
    },
    social_links: {
      type: SocialLinksSchema,
      default: () => ({ instagram: null, facebook: null, twitter: null }),
    },
    policies: { type: VendorPoliciesSchema, default: null },
    policy_version: { type: Number, default: 0 },
    /**
     * @deprecated Kept for backward compatibility. Always mirrors kyc_details.legit_verified.
     * The single source of truth is kyc_details.legit_verified.
     * Remove this field after all existing reads are updated.
     */
    // legit_verified: { type: Boolean, default: false },
    default_delivery_agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, default: null },
    wa: {
      verified: { type: Boolean, default: false },
      wa_phone_id: { type: String },
      name: { type: String },
      bound_at: { type: Date },
      last_seen_at: { type: Date },
    },
    notification_preferences: {
      email: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: false },
      phone: { type: Boolean, default: false },
    },
    two_factor_enabled: { type: Boolean, default: false },
    version: { type: Number, default: 0 },
    timezone: { type: String, default: 'Africa/Douala', required: true },
    preferred_language: { type: String, enum: SUPPORTED_LANGUAGES, default: 'en' },
    status: {
      type: String,
      enum: ['active', 'pending_verification', 'inactive'],
      default: 'pending_verification',
    },
    onboarding_step: {
      type: Number,
      default: VendorOnboardingStep.BASIC_SETUP,
      min: 0,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Geospatial indexes for vendor business addresses (legacy bare point + GeoAddress)
VendorSchema.index({ 'business_addresses.location': '2dsphere' }, { sparse: true });
VendorSchema.index({ 'business_addresses.geo.coordinates': '2dsphere' }, { sparse: true });

export const VendorModel = mongoose.model<IVendor>(MODELS.VENDOR, VendorSchema, COLLECTIONS.VENDOR);
