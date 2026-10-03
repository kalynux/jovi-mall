import { IVendor } from '../../vendors/vendor.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface AgencyVendorAddressDto {
  label: string;
  addressLine1: string;
  city: string;
  state: string | null;
}

/**
 * The vendor's policies as an agency sees them before connecting.
 *
 * Every structured field the vendor filled in is here (2026-10-03 — it used to
 * be three or four fields per policy, so an agency approving a vendor could not
 * read the fees, refund rules or return conditions it was agreeing to carry).
 * The fields added that day are all additive. The one thing still withheld is
 * the support channels' contact values: only which KINDS of channel exist.
 */
export interface AgencyVendorPolicySummaryDto {
  returnPolicy: {
    returnEligible: boolean;
    returnWindowDays: number;
    refundType: 'full' | 'partial' | 'none';
    /** `partial` refunds only. */
    refundPercentage: number | null;
    returnShippingPayer: 'vendor' | 'customer' | 'customer_reimbursed_if_defect' | null;
    refundProcessingDays: number | null;
    returnConditionNotes: string | null;
    inspector: 'admin' | 'vendor' | 'platform' | null;
  } | null;
  cancellationPolicy: {
    cancellable: boolean;
    cancellationDeadline: string | null;
    /** `anytime_until_days_before_delivery` only. */
    cancellationDeadlineDays: number | null;
    cancellationFeeType: 'none' | 'fixed' | 'percentage' | 'full_non_refundable' | null;
    cancellationFeeValue: number | null;
    lateCancellationRefundType: 'fixed' | 'percentage' | 'full_non_refundable' | null;
    lateCancellationRefundValue: number | null;
  } | null;
  supportPolicy: {
    availability: '24_7' | 'business_hours' | 'limited' | null;
    availabilityDescription: string | null;
    languages: string[];
    /** Channel KINDS only — contact values are never exposed here. */
    channelTypes: Array<'email' | 'phone' | 'whatsapp' | 'telegram'>;
    requiredInfo: Array<'order_number' | 'product_photo_video' | 'tracking_number'>;
    eligibilityNotes: string | null;
  } | null;
  /** Up to 2 supporting documents (URLs) for terms the structured fields don't cover. */
  documents: string[];
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
              refundPercentage: vendor.policies.return_policy.refund_percentage ?? null,
              returnShippingPayer: vendor.policies.return_policy.return_shipping_payer ?? null,
              refundProcessingDays: vendor.policies.return_policy.refund_processing_days ?? null,
              returnConditionNotes: vendor.policies.return_policy.return_condition_notes ?? null,
              inspector: vendor.policies.return_policy.inspector ?? null,
            }
            : null,
          cancellationPolicy: vendor.policies.cancellation_policy
            ? {
              cancellable: vendor.policies.cancellation_policy.cancellable,
              cancellationDeadline: vendor.policies.cancellation_policy.cancellation_deadline,
              cancellationDeadlineDays: vendor.policies.cancellation_policy.cancellation_deadline_days ?? null,
              cancellationFeeType: vendor.policies.cancellation_policy.cancellation_fee_type ?? null,
              cancellationFeeValue: vendor.policies.cancellation_policy.cancellation_fee_value ?? null,
              lateCancellationRefundType: vendor.policies.cancellation_policy.late_cancellation_refund_type ?? null,
              lateCancellationRefundValue: vendor.policies.cancellation_policy.late_cancellation_refund_value ?? null,
            }
            : null,
          supportPolicy: vendor.policies.support_policy
            ? {
              availability: vendor.policies.support_policy.availability,
              availabilityDescription: vendor.policies.support_policy.availability_description ?? null,
              languages: vendor.policies.support_policy.languages,
              // De-duplicated kinds; the contact values stay private (see above).
              channelTypes: [...new Set((vendor.policies.support_policy.channels ?? []).map((c) => c.type))],
              requiredInfo: vendor.policies.support_policy.required_info ?? [],
              eligibilityNotes: vendor.policies.support_policy.eligibility_notes ?? null,
            }
            : null,
          documents: vendor.policies.documents ?? [],
        }
        : null,
    };
  }
}
