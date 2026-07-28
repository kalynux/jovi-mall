import { IDeliveryAgency } from '../../delivery/delivery-agency.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface VendorAgencyHQAddressDto {
    region: string;
    city: string;
    address_description: string;
}

export interface VendorAgencyPolicySummaryDto {
    pricing: {
        /** Whether this agency offers warehouse + ship-from-stock fulfilment. */
        storage_based_enabled: boolean;
        /** Whether this agency offers pickup-from-vendor + deliver fulfilment. */
        pickup_based_enabled: boolean;
        /** Free-text pricing notes from the agency. */
        notes: string | null;
    };
    returns: {
        /** Who bears the cost of return shipping. */
        payer: 'vendor' | 'agency' | 'customer';
        /** Days after delivery within which a return may be initiated. 0 = no returns. */
        return_window_days: number;
        /** Additional return conditions. */
        notes: string | null;
    };
    damage: {
        /** Days after delivery within which a damage claim must be filed. */
        claim_deadline_days: number;
        /** Maximum compensation the agency will pay per damaged item (XAF). */
        max_refund_per_item: number;
        /** Additional damage policy notes. */
        notes: string | null;
    };
}

export interface VendorAgencyListItemDto {
    id: string;
    agencyName: string;
    logo: FileDetail | null;
    /** Whether admin has verified the agency's KYC (business legitimacy). */
    kycVerified: boolean;
    /**
     * Primary headquarters address (index 0 of the agency's addresses).
     * Null if the agency has no address on file (should not happen for completed agencies).
     */
    headquartersAddress: VendorAgencyHQAddressDto | null;
    /** Coverage regions this agency can serve. Values are region keys from locations.json. */
    coverageAreas: string[];
    /**
     * Agency rating (0–5 scale).
     * Null until the rating system is implemented.
     * @future Populate from ratings aggregation once available.
     */
    rating: number | null;
    /**
     * Agency's policy summary — pricing models, return policy, damage policy.
     * Null only if the agency somehow has no policies (blocked by onboarding; should never be null for step-0 agencies).
     */
    policies: VendorAgencyPolicySummaryDto | null;
}

export interface AgencyListMeta {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class VendorAgencyMapper {
    /**
     * Map a delivery agency document to the vendor-facing list item DTO.
     *
     * SECURITY:
     * - KYC registration_number and transport_license_id are NEVER returned
     * - Payout details are NEVER returned
     * - Per-location support contacts are NEVER returned
     * - Only the primary HQ address (index 0) is exposed — no branch addresses
     */
    static toListItemDto(
        agency: IDeliveryAgency,
        agencyName: string,
        logo: FileDetail | null = null,
    ): VendorAgencyListItemDto {
        const primaryHQ = agency.headquarters_addresses?.[0] ?? null;

        return {
            id: agency._id.toString(),
            agencyName,
            logo,
            kycVerified: agency.kyc_details?.legit_verified ?? false,
            headquartersAddress: primaryHQ
                ? {
                      region: primaryHQ.region,
                      city: primaryHQ.city,
                      address_description: primaryHQ.address_description,
                  }
                : null,
            coverageAreas: agency.coverage_areas ?? [],
            // TODO: populate from ratings system when implemented
            rating: null,
            policies: agency.policies
                ? {
                      pricing: {
                          storage_based_enabled: agency.policies.pricing.storage_based.enabled,
                          pickup_based_enabled: agency.policies.pricing.pickup_based.enabled,
                          notes: agency.policies.pricing.notes ?? null,
                      },
                      returns: {
                          payer: agency.policies.returns.payer,
                          return_window_days: agency.policies.returns.return_window_days,
                          notes: agency.policies.returns.notes ?? null,
                      },
                      damage: {
                          claim_deadline_days: agency.policies.damage.claim_deadline_days,
                          max_refund_per_item: agency.policies.damage.max_refund_per_item,
                          notes: agency.policies.damage.notes ?? null,
                      },
                  }
                : null,
        };
    }
}
