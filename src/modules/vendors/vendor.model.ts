import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../core/types/geo.types';
import { GeoAddressSchema, IGeoAddress } from '../../core/types/geo-address.types';
import { PayoutMethodSchema, IPayoutDetails } from '../../core/types/payout.types';
import { VendorOnboardingStep } from '../../core/constants/onboarding-steps';
import { SUPPORTED_LANGUAGES, Language } from '../../core/constants/languages';
import { ActorSource, actorStampFields } from '../../core/types/actor-source.types';
import { IKycDocumentFields, kycDocumentFields } from '../../core/types/kyc-documents.types';
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
    /**
     * @deprecated Bare coordinate kept for backward compatibility. Prefer `geo`.
     * ⚠ `default: undefined`, never `null` — this array is 2dsphere-indexed and a
     * stored null beside a real point makes the whole vendor document unwritable.
     * See `GeoPointSchema`.
     */
    location: { type: GeoPointSchema, default: undefined },
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

/**
 * Business verification — the verdict, and who reached it.
 *
 * ── Why `status` exists beside `legit_verified` ───────────────────────────────
 * The boolean alone cannot tell "never reviewed" from "reviewed and rejected": both
 * are `false`. A review queue is unbuildable over a field with that ambiguity, and an
 * administrator reopening a vendor has no way to see that a decision was already made.
 * `status` carries the verdict; `legit_verified` stays as its boolean projection,
 * because `agency-vendor-browse.dto.ts` reads it to render `kycVerified` to agencies.
 *
 * The two are written together by `VendorRepository.setKycVerdict` and never apart —
 * the same rule as the suspension stamp below.
 *
 * Shape mirrors `DeliveryAgent.kyc`, which is the platform's existing admin-reviewed
 * KYC block. `reviewed_by_user_id` carries NO `ref`: it holds a wi-admin
 * `admin_accounts._id`, which does not resolve in this database — see
 * `actor-source.types.ts` for why the companion `_source`/`_name` fields exist.
 */
const VendorKycDetailsSchema = new Schema(
  {
    national_id_number: { type: String, default: null, trim: true },
    /**
     * Verification flag. Only Admin can set this to true.
     * Vendors can submit their national_id_number, but legit_verified
     * is admin-controlled.
     */
    legit_verified: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: 'pending',
    },
    verified_at: { type: Date, default: null },
    rejection_reason: { type: String, default: null, trim: true, maxlength: 500 },
    reviewed_by_user_id: { type: Schema.Types.ObjectId, default: null },
    ...actorStampFields('reviewed_by'),

    /**
     * The EVIDENCE behind the verdict above — identity documents, the vendor's own home
     * address, and the hand-drawn location sketches. See `core/types/kyc-documents.types.ts`
     * for the whole design, including why none of it is required and why the backend grades
     * nothing.
     *
     * ⚠ `national_id_number` above predates this block and stays where it is. It is the same
     * claim the `id_card_front`/`id_card_back` scans corroborate, and moving it in here would
     * have been a rename of a field three DTOs and wi-admin's vendor read already carry — for
     * tidiness, against a live contract.
     */
    ...kycDocumentFields({ storeSketches: true }),
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
  /**
   * @deprecated Prefer `geo.coordinates`.
   * Optional because the key is OMITTED rather than stored null — see the schema.
   */
  location?: IGeoPoint | null;
  /** Canonical geospatial address; null on legacy/plain-text entries. */
  geo: IGeoAddress | null;
}

export interface IVendorOperatingHours {
  day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  open_time: string;
  close_time: string;
  is_closed: boolean;
}

export type VendorKycStatus = 'pending' | 'verified' | 'rejected';

/** The VERDICT half — who decided, when, and what they decided. */
export interface IVendorKycVerdict {
  national_id_number: string | null;
  /** The boolean projection of `status === 'verified'`. Written together, never apart. */
  legit_verified: boolean;
  status: VendorKycStatus;
  verified_at: Date | null;
  rejection_reason: string | null;
  /** A wi-admin `admin_accounts._id` — deliberately unref'd, see actor-source.types.ts. */
  reviewed_by_user_id: mongoose.Types.ObjectId | null;
  reviewed_by_source: ActorSource;
  reviewed_by_name: string | null;
}

/**
 * The vendor's KYC block: the verdict, and the evidence it was reached on.
 *
 * `store_address_sketch_file_ids` is present — a vendor may hold several `business_addresses`
 * and each can carry a hand-drawn sketch. `vehicle_with_agent_file_id` is not: a vendor has no
 * vehicle on this platform.
 */
export interface IVendorKycDetails
  extends IVendorKycVerdict,
    Omit<IKycDocumentFields, 'vehicle_with_agent_file_id' | 'store_address_sketch_file_ids'> {
  store_address_sketch_file_ids: mongoose.Types.ObjectId[];
}

/**
 * Whether this vendor may operate.
 *
 * A DIFFERENT axis from `User.status`, and deliberately not cascaded either way:
 * suspending the account blocks sign-in entirely, suspending the vendor blocks the
 * vendor role and its listings. Collapsing the two would make reinstatement guess
 * which of them was true before — see `admin-user.service.ts`.
 *
 * `inactive` is the administrative suspension (`AdminVendorService`);
 * `pending_verification` is the registration default, cleared by email verification.
 */
export type VendorStatus = 'active' | 'pending_verification' | 'inactive';

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
  default_delivery_agency_id?: mongoose.Types.ObjectId | null;
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
  status: VendorStatus;

  /**
   * Suspension provenance — written as a whole by `AdminVendorService`, never a field
   * at a time, or a reason outlives the suspension it describes.
   */
  suspended_at: Date | null;
  suspended_reason: string | null;
  /**
   * The status to return to on reinstatement — never a hardcoded `'active'`.
   *
   * `status` has three values, so restoring is not the boolean flip it is on `User`.
   * A fraudulent signup gets suspended while still `pending_verification`, and
   * reinstating it must put it back there rather than promote it past a verification
   * step it never passed. Same idea, and same reason, as `ProductSuspension.previousStatus`.
   */
  suspended_from_status: Exclude<VendorStatus, 'inactive'> | null;
  /** A wi-admin `admin_accounts._id`. No `ref` — it does not resolve in this database. */
  suspended_by_user_id: mongoose.Types.ObjectId | null;
  suspended_by_source: ActorSource;
  suspended_by_name: string | null;

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
    // `unique: true` on a raw-cased email is a trap: `A@x.com` and `a@x.com`
    // would be two vendors. Normalised here as well as in the Zod schema, to
    // match every other role's model (customer/agency/agent/admin) and to hold
    // for the paths that write outside a validated request (scripts, seeds).
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },
    email_verified: { type: Boolean, default: false },
    phone_verified: { type: Boolean, default: false },
    avatar_file_id: { type: Schema.Types.ObjectId, ref: MODELS.FILE, default: null },
    business_addresses: { type: [BusinessAddressSchema], default: [] },
    operating_hours: { type: [OperatingHoursSchema], default: [] },
    // Ordered array of payout methods (max 3). The FIRST entry is the preferred one.
    // A vendor may mix mobile_money, bank and card entries freely.
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
    default_delivery_agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, default: null },
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

    // Suspension provenance. Written together by AdminVendorService — never one at a
    // time, or a reason ends up describing a suspension that was lifted.
    suspended_at: { type: Date, default: null },
    suspended_reason: { type: String, default: null, trim: true, maxlength: 500 },
    suspended_from_status: {
      type: String,
      enum: ['active', 'pending_verification'],
      default: null,
    },
    suspended_by_user_id: { type: Schema.Types.ObjectId, default: null },
    ...actorStampFields('suspended_by'),

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

/**
 * The admin vendor directory sorts by `created_at` and filters on `status`.
 *
 * Until wi-admin's `/api/v1/vendors` existed, this collection carried nothing but its two
 * 2dsphere indexes — so any status-filtered page of the directory would scan it whole.
 * `status` leads because it is the more selective of the pair, and `created_at` closes
 * the index so the default `-createdAt` ordering is served from it rather than sorted in
 * memory. Same shape, and same reasoning, as `UserSchema.index({ status, roles, created_at })`.
 */
VendorSchema.index({ status: 1, created_at: -1 });

/** The KYC review queue: "every vendor still pending, oldest first". */
VendorSchema.index({ 'kyc_details.status': 1, created_at: -1 });

export const VendorModel = mongoose.model<IVendor>(MODELS.VENDOR, VendorSchema, COLLECTIONS.VENDOR);
