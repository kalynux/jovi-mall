import { IVendor, IVendorBranding, IVendorBusinessAddress, IVendorOperatingHours, IVendorKycDetails, IVendorSocialLinks, IVendorPolicies } from '../../vendors/vendor.model';
import { IPayoutDetails } from '../../../core/types/payout.types';
import { UpdateVendorProfileInput } from '../validators/vendor-onboarding.validator';
import { VendorOnboardingStep } from '../../../core/constants/onboarding-steps';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface VendorPayoutDetailsSanitized {
  method: 'mobile_money' | 'bank';
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
}

export interface GetVendorProfileResponseDto {
  id: string;
  email: string;
  emailVerified: boolean;
  phone: string;
  phoneVerified: boolean;
  businessName: string;
  displayName?: string;
  businessDescription: string | null;
  country: string | null;
  branding: IVendorBranding;
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
  if (!payout) return null;
  return {
    method: payout.method,
    mobile_money: payout.mobile_money
      ? {
        provider: payout.mobile_money.provider,
        phone_number_masked: maskPhoneNumber(payout.mobile_money.phone_number),
        account_name: payout.mobile_money.account_name,
      }
      : null,
    bank: payout.bank
      ? {
        bank_name: payout.bank.bank_name,
        account_number_masked: maskAccountNumber(payout.bank.account_number),
        account_name: payout.bank.account_name,
        country: payout.bank.country,
      }
      : null,
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
  static toResponseDto(vendor: IVendor): GetVendorProfileResponseDto {
    return {
      id: vendor._id.toString(),
      email: vendor.email ?? '',
      emailVerified: vendor.email_verified,
      phone: vendor.phone ?? '',
      phoneVerified: vendor.phone_verified,
      businessName: vendor.business_name,
      displayName: vendor.display_name,
      businessDescription: vendor.business_description,
      country: vendor.country ?? null,
      branding: vendor.branding,
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
      { step: 1, label: 'Basic Setup',                 required: true  },
      { step: 2, label: 'Delivery Linking (Optional)', required: false },
      { step: 3, label: 'Branding (Optional)',         required: false },
      { step: 4, label: 'Policy Setup (Optional)',     required: false },
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
    if (vendor.payout_details) completedFields.push('payout_details'); else missingFields.push('payout_details');
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
    if (input.businessDescription !== undefined) payload.business_description = input.businessDescription as string | null;
    if (input.email !== undefined) payload.email = input.email;
    if (input.phone !== undefined) payload.phone = input.phone;
    if (input.timezone !== undefined) payload.timezone = input.timezone;
    if (input.country !== undefined) payload.country = input.country;
    if (input.branding !== undefined) payload.branding = input.branding as IVendorBranding;
    if (input.business_addresses !== undefined) payload.business_addresses = input.business_addresses as IVendorBusinessAddress[];
    if (input.operating_hours !== undefined) payload.operating_hours = input.operating_hours as IVendorOperatingHours[];
    if (input.payout_details !== undefined) payload.payout_details = input.payout_details as IPayoutDetails;
    if (input.kyc_details !== undefined) {
      payload.kyc_details = {
        national_id_number: input.kyc_details.national_id_number ?? null,
        legit_verified: false, // legit_verified is admin-only; never set from user input
      };
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
