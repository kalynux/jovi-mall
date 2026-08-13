import mongoose from 'mongoose';
import { IVendor, IVendorBusinessAddress, IVendorOperatingHours, IVendorKycDetails, IVendorSocialLinks, IVendorPolicies } from '../../vendors/vendor.model';
import { withGeoAddress } from '../../../core/types/geo-address.types';
import {
  CardBrand,
  formatMaskedCardNumber,
  IPayoutDetails,
  PayoutMethodKind,
} from '../../../core/types/payout.types';
import { UpdateVendorProfileInput } from '../validators/vendor-onboarding.validator';
import { VendorOnboardingStep } from '../../../core/constants/onboarding-steps';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { IStorageProvider } from '../../../core/storage';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface VendorPayoutDetailsSanitized {
  method: PayoutMethodKind;
  mobile_money: {
    provider: string;
    phone_number_masked: string; // e.g. "+237 •••• •• 34"
    account_name: string;
  } | null;
  bank: {
    bank_name: string;
    account_number_masked: string; // e.g. "•••• •••• 1234"
    account_name: string;
    country: string;
  } | null;
  /**
   * Nothing is redacted here — only `last4` was ever stored (no PAN, no CVV).
   * `number_masked` is rendered from it so a client can print all three method
   * kinds through one code path.
   */
  card: {
    brand: CardBrand;
    last4: string;
    number_masked: string; // e.g. "•••• •••• •••• 4242"
    card_holder_name: string;
    expiry_month: number;
    expiry_year: number;
    issuing_bank: string | null;
    country: string;
  } | null;
}

export interface GetVendorProfileResponseDto {
  id: string;
  email: string;
  emailVerified: boolean;
  phone: string;
  phoneVerified: boolean;
  displayName?: string;
  country: string | null;
  /** Personal profile avatar, resolved from its File reference. Null when unset. */
  avatar: FileDetail | null;
  businessAddresses: IVendorBusinessAddress[];
  operatingHours: IVendorOperatingHours[];
  payoutDetails: VendorPayoutDetailsSanitized | null;
  /** KYC number is never returned. Only the verified flag is exposed. */
  kycVerified: boolean;
  socialLinks: IVendorSocialLinks;
  policies: IVendorPolicies | null;
  notificationPreferences: {
    email: boolean;
    whatsapp: boolean;
    phone: boolean;
  };
  twoFactorEnabled: boolean;
  preferredLanguage: string;
  status: string;
  onboardingStep: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VendorCompletionStatusDto {
  onboardingStep: number;
  isComplete: boolean;
  missingFields: string[];
  stepLabel: string;
}

export interface VendorOnboardingStatusDto {
  currentStep: number;
  currentStepLabel: string;
  isComplete: boolean;
  progressPercent: number;
  completedFields: string[];
  missingFields: string[];
  steps: Array<{
    step: number;
    label: string;
    status: 'completed' | 'current' | 'pending';
    required: boolean;
  }>;
  warnings: string[];
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

function maskPhoneNumber(phone: string): string {
  if (phone.length <= 4) return '••••';
  return phone.slice(0, -4).replace(/\d/g, '•') + phone.slice(-4);
}

function maskAccountNumber(account: string): string {
  if (account.length <= 4) return '••••';
  return '•'.repeat(account.length - 4) + account.slice(-4);
}

function sanitizePayoutDetails(payout: IPayoutDetails | null): VendorPayoutDetailsSanitized | null {
  // payout_details is an ordered array of methods; the FIRST entry is the preferred one.
  if (!payout || payout.length === 0) return null;
  const preferred = payout[0];
  return {
    method: preferred.method,
    mobile_money: preferred.mobile_money
      ? {
        provider: preferred.mobile_money.provider,
        phone_number_masked: maskPhoneNumber(preferred.mobile_money.phone_number),
        account_name: preferred.mobile_money.account_name,
      }
      : null,
    bank: preferred.bank
      ? {
        bank_name: preferred.bank.bank_name,
        account_number_masked: maskAccountNumber(preferred.bank.account_number),
        account_name: preferred.bank.account_name,
        country: preferred.bank.country,
      }
      : null,
    card: preferred.card
      ? {
        brand: preferred.card.brand,
        last4: preferred.card.last4,
        number_masked: formatMaskedCardNumber(preferred.card.last4),
        card_holder_name: preferred.card.card_holder_name,
        expiry_month: preferred.card.expiry_month,
        expiry_year: preferred.card.expiry_year,
        issuing_bank: preferred.card.issuing_bank ?? null,
        country: preferred.card.country,
      }
      : null,
  };
}

/**
 * Resolve the vendor's personal avatar File reference into a full file detail.
 * Missing/deleted files resolve to null, matching branding behavior.
 */
async function buildAvatarDetail(
  avatarFileId: mongoose.Types.ObjectId | null | undefined,
  fileRepo: FileRepositoryMongo,
  storage: IStorageProvider,
): Promise<FileDetail | null> {
  const id = avatarFileId?.toString();
  if (!id) return null;
  const files = await fileRepo.findManyByIds([id]);
  const f = files[0];
  if (!f) return null;
  return {
    id: f.id,
    key: f.key,
    url: storage.getPublicUrl(f.key),
    mimeType: f.mimeType,
    size: f.size,
    originalName: f.originalName,
  };
}

export class VendorProfileMapper {
  /**
   * Map Vendor domain model to sanitized response DTO.
   *
   * SECURITY:
   * - KYC national_id_number is NEVER included
   * - Payout account numbers are masked
   * - version included for optimistic locking on client
   */
  static async toResponseDto(
    vendor: IVendor,
    fileRepo: FileRepositoryMongo,
    storage: IStorageProvider,
  ): Promise<GetVendorProfileResponseDto> {
    return {
      id: vendor._id.toString(),
      email: vendor.email ?? '',
      emailVerified: vendor.email_verified,
      phone: vendor.phone ?? '',
      phoneVerified: vendor.phone_verified,
      displayName: vendor.display_name,
      country: vendor.country ?? null,
      avatar: await buildAvatarDetail(vendor.avatar_file_id, fileRepo, storage),
      businessAddresses: vendor.business_addresses,
      operatingHours: vendor.operating_hours,
      payoutDetails: sanitizePayoutDetails(vendor.payout_details),
      kycVerified: vendor.kyc_details?.legit_verified ?? false,
      socialLinks: vendor.social_links,
      policies: vendor.policies ?? null,
      notificationPreferences: {
        email: vendor.notification_preferences.email,
        whatsapp: vendor.notification_preferences.whatsapp,
        phone: vendor.notification_preferences.phone,
      },
      twoFactorEnabled: vendor.two_factor_enabled,
      preferredLanguage: vendor.preferred_language,
      status: vendor.status,
      onboardingStep: vendor.onboarding_step,
      version: vendor.version,
      createdAt: vendor.created_at,
      updatedAt: vendor.updated_at,
    };
  }

  static toOnboardingStatusDto(vendor: IVendor): VendorOnboardingStatusDto {
    const step = vendor.onboarding_step;

    const stepDefs = [
      { step: 1, label: 'Basic Setup', required: true },
      { step: 2, label: 'Delivery Linking (Optional)', required: false },
      { step: 3, label: 'Branding (Optional)', required: false },
      { step: 4, label: 'Policy Setup (Optional)', required: false },
    ];

    const stepStatus = (n: number): 'completed' | 'current' | 'pending' => {
      if (step === VendorOnboardingStep.COMPLETED) return 'completed';
      if (step > n) return 'completed';
      if (step === n) return 'current';
      return 'pending';
    };

    const completedCount = step === VendorOnboardingStep.COMPLETED ? 4 : step - 1;
    const progressPercent = Math.round((completedCount / 4) * 100);

    const completedFields: string[] = [];
    const missingFields: string[] = [];

    if (vendor.country) completedFields.push('country'); else missingFields.push('country');
    if (vendor.timezone) completedFields.push('timezone');
    if (vendor.payout_details?.length) completedFields.push('payout_details'); else missingFields.push('payout_details');
    if (vendor.default_delivery_agency_id) completedFields.push('default_delivery_agency_id');

    const stepLabels: Record<number, string> = {
      0: 'Onboarding Complete',
      1: 'Basic Setup',
      2: 'Delivery Linking (Optional)',
      3: 'Branding (Optional)',
      4: 'Policy Setup (Optional)',
    };

    const warnings: string[] = [];
    if (!(vendor.kyc_details?.legit_verified)) {
      warnings.push('KYC verification is pending. Your account may have limited functionality until verified by admin.');
    }

    return {
      currentStep: step,
      currentStepLabel: stepLabels[step] ?? `Step ${step}`,
      isComplete: step === VendorOnboardingStep.COMPLETED,
      progressPercent,
      completedFields,
      missingFields,
      steps: stepDefs.map((s) => ({ ...s, status: stepStatus(s.step) })),
      warnings,
    };
  }

  /**
   * Map update input to a safe partial domain payload.
   * Explicit field mapping — prevents mass assignment.
   */
  static toUpdatePayload(input: UpdateVendorProfileInput): Partial<IVendor> {
    const payload: Partial<IVendor> = {};

    if (input.displayName !== undefined) payload.display_name = input.displayName;
    if (input.email !== undefined) payload.email = input.email;
    if (input.phone !== undefined) payload.phone = input.phone;
    if (input.timezone !== undefined) payload.timezone = input.timezone;
    if (input.preferred_language !== undefined) payload.preferred_language = input.preferred_language;
    if (input.country !== undefined) payload.country = input.country;
    if (input.avatarFileId !== undefined) {
      payload.avatar_file_id = input.avatarFileId ? new mongoose.Types.ObjectId(input.avatarFileId) : null;
    }
    // `_id` (when provided) is a hex string here — Mongoose casts it to ObjectId
    // on write, preserving the address's identity instead of minting a new one.
    if (input.business_addresses !== undefined) payload.business_addresses = input.business_addresses.map(withGeoAddress) as unknown as IVendorBusinessAddress[];
    if (input.operating_hours !== undefined) payload.operating_hours = input.operating_hours as IVendorOperatingHours[];
    if (input.payout_details !== undefined) payload.payout_details = input.payout_details as IPayoutDetails;
    if (input.kyc_details !== undefined) {
      /**
       * A DOTTED path, deliberately — not a `kyc_details` object.
       *
       * Assigning the sub-document whole REPLACES it, which is how this used to force
       * `legit_verified: false` on every profile save that carried a KYC field. That was
       * an artefact of the replacement rather than a rule: re-submitting the same number
       * un-verified the vendor too. Now that the block also carries the admin's verdict
       * (`status`, `verified_at`, `rejection_reason`, the reviewer stamp), a whole-object
       * write would erase a verification decision from a vendor's own profile edit.
       *
       * Mongoose lifts a top-level dotted key into `$set`, so exactly the one field the
       * vendor owns is written and the admin-owned siblings are untouched. Setting
       * `legit_verified` from user input remains impossible — it is simply never named.
       */
      (payload as Record<string, unknown>)['kyc_details.national_id_number'] =
        input.kyc_details.national_id_number ?? null;
    }
    if (input.social_links !== undefined) payload.social_links = input.social_links as IVendorSocialLinks;
    if (input.policies !== undefined) payload.policies = input.policies as IVendorPolicies;
    if (input.notificationPreferences !== undefined) {
      payload.notification_preferences = {
        email: input.notificationPreferences.email ?? true,
        whatsapp: input.notificationPreferences.whatsapp ?? false,
        phone: input.notificationPreferences.phone ?? false,
      };
    }

    return payload;
  }
}
