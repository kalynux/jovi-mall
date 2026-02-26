import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint, PolygonSchema, IPolygon } from '../../core/types/geo.types';
import { PayoutDetailsSchema, IPayoutDetails } from '../../core/types/payout.types';
import { AgencyOnboardingStep } from '../../core/constants/onboarding-steps';

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
    address_line1: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true, uppercase: true },
    location: { type: GeoPointSchema, default: null },
    support_contact: { type: SupportContactSchema, required: true },
  },
  { _id: true }
);

// ─── Interfaces ───────────────────────────────────────────────────────────────

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
  address_line1: string;
  city: string;
  country: string;
  location: IGeoPoint | null;
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
   * GeoJSON polygons covering this agency's service areas.
   * Min 1 when onboarding is complete.
   */
  coverage_areas: IPolygon[];
  /**
   * Physical locations. Min 1 entry required.
   * First entry (index 0) is always the PRIMARY headquarters.
   */
  headquarters_addresses: IAgencyHeadquartersAddress[];
  payout_details: IPayoutDetails | null;
  kyc_details: IAgencyKycDetails;
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
    coverage_areas: { type: [PolygonSchema], default: [] },
    headquarters_addresses: { type: [HeadquartersAddressSchema], default: [] },
    payout_details: { type: PayoutDetailsSchema, default: null },
    kyc_details: {
      type: AgencyKycDetailsSchema,
      default: () => ({
        registration_number: null,
        transport_license_id: null,
        legit_verified: false,
      }),
    },
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

// Geospatial indexes
DeliveryAgencySchema.index({ 'coverage_areas': '2dsphere' }, { sparse: true });
DeliveryAgencySchema.index({ 'headquarters_addresses.location': '2dsphere' }, { sparse: true });

export const DeliveryAgencyModel = mongoose.model<IDeliveryAgency>('DeliveryAgency', DeliveryAgencySchema);
