import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../core/types/geo.types';
import { PayoutDetailsSchema, IPayoutDetails } from '../../core/types/payout.types';
import { VendorOnboardingStep } from '../../core/constants/onboarding-steps';

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
    location: { type: GeoPointSchema, default: null },
  },
  { _id: true }
);

// ─── Branding Sub-Schema ──────────────────────────────────────────────────────

const BrandingSchema = new Schema(
  {
    logo_url: { type: String, default: null },
    cover_image_url: { type: String, default: null },
  },
  { _id: false }
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

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IVendorBusinessAddress {
  _id: mongoose.Types.ObjectId;
  label: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string | null;
  location: IGeoPoint | null;
}

export interface IVendorBranding {
  logo_url: string | null;
  cover_image_url: string | null;
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
  business_name: string;
  display_name?: string;
  business_description: string | null;
  country: string;                                         // ISO-2 e.g. "CM"
  branding: IVendorBranding;
  business_addresses: IVendorBusinessAddress[];
  operating_hours: IVendorOperatingHours[];
  payout_details: IPayoutDetails | null;
  kyc_details: IVendorKycDetails;
  social_links: IVendorSocialLinks;
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
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    business_name: { type: String, required: true },
    display_name: { type: String },
    business_description: { type: String, default: null },
    country: { type: String, default: null, trim: true, uppercase: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    email_verified: { type: Boolean, default: false },
    phone_verified: { type: Boolean, default: false },
    branding: { type: BrandingSchema, default: () => ({ logo_url: null, cover_image_url: null }) },
    business_addresses: { type: [BusinessAddressSchema], default: [] },
    operating_hours: { type: [OperatingHoursSchema], default: [] },
    payout_details: { type: PayoutDetailsSchema, default: null },
    kyc_details: {
      type: VendorKycDetailsSchema,
      default: () => ({ national_id_number: null, legit_verified: false }),
    },
    social_links: {
      type: SocialLinksSchema,
      default: () => ({ instagram: null, facebook: null, twitter: null }),
    },
    /**
     * @deprecated Kept for backward compatibility. Always mirrors kyc_details.legit_verified.
     * The single source of truth is kyc_details.legit_verified.
     * Remove this field after all existing reads are updated.
     */
    legit_verified: { type: Boolean, default: false },
    default_delivery_agency_id: { type: Schema.Types.ObjectId, ref: 'DeliveryAgency', default: null },
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

// Geospatial index for vendor business address locations
VendorSchema.index({ 'business_addresses.location': '2dsphere' }, { sparse: true });

export const VendorModel = mongoose.model<IVendor>('Vendor', VendorSchema);
