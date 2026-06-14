import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../core/types/geo.types';
import { FixedOnboardingStep } from '../../core/constants/onboarding-steps';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

// ─── Saved Address Sub-Schema ─────────────────────────────────────────────────

const SavedAddressSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },         // e.g. "Home", "Work"
    address_line1: { type: String, required: true, trim: true },
    address_line2: { type: String, default: null, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, default: null, trim: true },
    country: { type: String, default: 'CM', trim: true, uppercase: true },
    is_default: { type: Boolean, default: false },
    location: { type: GeoPointSchema, default: null },
  },
  { _id: true }
);

// ─── Preferences Sub-Schema ───────────────────────────────────────────────────

const PreferencesSchema = new Schema(
  {
    language: { type: String, default: 'en', trim: true },        // BCP-47 e.g. "en", "fr"
    currency: { type: String, default: 'XAF', trim: true },       // ISO-4217
    marketing_opt_in: { type: Boolean, default: false },
    ai_tone: { type: [String], default: [] },                     // e.g. ["friendly", "concise"]
    ads_compact_mode: { type: Boolean, default: false },
    compact_mode: { type: Boolean, default: false },
  },
  { _id: false }
);

// ─── Saved Payment Method Sub-Schema ─────────────────────────────────────────

/**
 * Saved payment methods store a reference to a gateway-managed instrument.
 * No raw card/account numbers are stored here; the payment gateway handles
 * tokenization and PCI compliance. We store only the display metadata.
 */
const SavedPaymentMethodSchema = new Schema(
  {
    provider: { type: String, required: true, trim: true },       // "stripe", "paystack", "mtn_momo"
    gateway_customer_id: { type: String, required: true, trim: true }, // Gateway's customer/wallet ID
    gateway_instrument_id: { type: String, required: true, trim: true }, // Gateway's card/instrument ID
    display_label: { type: String, required: true, trim: true },  // e.g. "MTN •••• 1234" for UI
    method_type: {
      type: String,
      required: true,
      enum: ['card', 'mobile_money', 'bank_transfer'],
    },
    is_default: { type: Boolean, default: false },
  },
  { _id: true }
);

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ICustomerSavedAddress {
  _id: mongoose.Types.ObjectId;
  label: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string | null;
  country: string;
  is_default: boolean;
  location: IGeoPoint | null;
}

export interface ICustomerPreferences {
  language: string;
  currency: string;
  marketing_opt_in: boolean;
  ai_tone: string[];
  ads_compact_mode: boolean;
  compact_mode: boolean;
}

export interface ICustomerSavedPaymentMethod {
  _id: mongoose.Types.ObjectId;
  provider: string;
  gateway_customer_id: string;
  gateway_instrument_id: string;
  display_label: string;
  method_type: 'card' | 'mobile_money' | 'bank_transfer';
  is_default: boolean;
}

export interface ICustomer extends Document {
  user_id: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  name: string;
  avatar_url: string | null;
  bio: string | null;
  saved_addresses: ICustomerSavedAddress[];
  date_of_birth: Date | null;
  preferences: ICustomerPreferences;
  recent_product_code: string | null;
  saved_payment_methods: ICustomerSavedPaymentMethod[];
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
   * Always 0 for customers — no onboarding flow.
   * Stored for API consistency with other roles.
   */
  onboarding_step: number;
  created_at: Date;
  updated_at: Date;
}

// ─── Mongoose Schema ──────────────────────────────────────────────────────────

const CustomerSchema = new Schema<ICustomer>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true, unique: true },
    email: { type: String, trim: true, lowercase: true },
    email_verified: { type: Boolean, default: false },
    phone: { type: String, trim: true },
    phone_verified: { type: Boolean, default: false },
    name: { type: String, required: true },
    avatar_url: { type: String, default: null },
    bio: { type: String, default: null },
    saved_addresses: { type: [SavedAddressSchema], default: [] },
    date_of_birth: { type: Date, default: null },
    preferences: {
      type: PreferencesSchema,
      default: () => ({
        language: 'en',
        currency: 'XAF',
        marketing_opt_in: false,
        ai_tone: [],
        ads_compact_mode: false,
        compact_mode: false,
      }),
    },
    recent_product_code: { type: String, default: null },
    saved_payment_methods: { type: [SavedPaymentMethodSchema], default: [] },
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
      default: FixedOnboardingStep.COMPLETED,
      min: 0,
      max: 0, // Customers are always COMPLETED; enforced at app layer too
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Geospatial index for customer saved addresses
CustomerSchema.index({ 'saved_addresses.location': '2dsphere' }, { sparse: true });

export const CustomerModel = mongoose.model<ICustomer>(MODELS.CUSTOMER, CustomerSchema, COLLECTIONS.CUSTOMER);
