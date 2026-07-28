import { IVendor } from '../../vendors/vendor.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface AgencyVendorAddressDto {
  label: string;
  addressLine1: string;
  city: string;
  state: string | null;
}

export interface AgencyVendorPolicySummaryDto {
  returnPolicy: {
    returnEligible: boolean;
    returnWindowDays: number;
    refundType: 'full' | 'partial' | 'none';
  } | null;
  cancellationPolicy: {
    cancellable: boolean;
    cancellationDeadline: string | null;
  } | null;
  supportPolicy: {
    availability: '24_7' | 'business_hours' | 'limited' | null;
    languages: string[];
  } | null;
}

export interface AgencyVendorListItemDto {
  id: string;
  businessName: string;
  displayName: string | null;
  logo: FileDetail | null;
  /** Whether admin has verified the vendor's KYC (business legitimacy). */
  kycVerified: boolean;
  /** Primary business address (index 0 of the vendor's addresses). Null if none on file. */
  primaryAddress: AgencyVendorAddressDto | null;
  /** Vendor's policy summary — return/cancellation/support terms. Null if not yet set. */
  policies: AgencyVendorPolicySummaryDto | null;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class AgencyVendorMapper {
  /**
   * Map a vendor document to the agency-facing list item DTO.
   *
   * SECURITY (mirrors VendorAgencyMapper.toListItemDto's privacy scoping):
   * - KYC national_id_number is NEVER returned
   * - Payout details are NEVER returned
   * - Support channel contact values (email/phone/whatsapp handles) are NEVER returned
   * - Only the primary business address (index 0) is exposed
   */
  static toListItemDto(
    vendor: IVendor,
    businessName: string,
    logo: FileDetail | null = null,
  ): AgencyVendorListItemDto {
    const primary = vendor.business_addresses?.[0] ?? null;

    return {
      id: vendor._id.toString(),
      businessName,
      displayName: vendor.display_name ?? null,
      logo,
      kycVerified: vendor.kyc_details?.legit_verified ?? false,
      primaryAddress: primary
        ? {
          label: primary.label,
          addressLine1: primary.address_line1,
          city: primary.city,
          state: primary.state,
        }
        : null,
      policies: vendor.policies
        ? {
          returnPolicy: vendor.policies.return_policy
            ? {
              returnEligible: vendor.policies.return_policy.return_eligible,
              returnWindowDays: vendor.policies.return_policy.return_window_days,
              refundType: vendor.policies.return_policy.refund_type,
            }
            : null,
          cancellationPolicy: vendor.policies.cancellation_policy
            ? {
              cancellable: vendor.policies.cancellation_policy.cancellable,
              cancellationDeadline: vendor.policies.cancellation_policy.cancellation_deadline,
            }
            : null,
          supportPolicy: vendor.policies.support_policy
            ? {
              availability: vendor.policies.support_policy.availability,
              languages: vendor.policies.support_policy.languages,
            }
            : null,
        }
        : null,
    };
  }
}
