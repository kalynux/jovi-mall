import { IDeliveryAgency } from '../../delivery/delivery-agency.model';
import { IAgencyHeadquartersAddress } from '../../magazin/models/magazin.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

/** The Magazin fields a vendor-facing agency list item needs (business surface). */
export interface AgencyMagazinSummary {
    name?: string;
    coverage_areas?: string[];
    headquarters_addresses?: IAgencyHeadquartersAddress[];
}

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface VendorAgencyHQAddressDto {
    /** Derived from the entry's geocode; null when it resolves no region. */
    region: string | null;
    /** Derived from the entry's geocode; null when it resolves no city. */
    city: string | null;
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
    /**
     * ISO-2 country the agency operates in, or null on legacy rows that predate
     * the field. It is what scopes `coverageAreas` — and, for an agent looking at
     * this row before requesting a contract, the region catalogue their coverage
     * picker must offer. Null means "no catalogue to scope to"; the server skips
     * the region check for those agencies rather than refusing every value.
     */
    country: string | null;
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

/**
 * One of an agency's physical locations, as a vendor sees it when choosing where
 * their agency-warehoused stock is held (`pickupLocation.agencyAddressId`).
 *
 * This is the ONE place a vendor sees past the primary HQ. Everything else about
 * an agency stays summarised at index 0 — see `toListItemDto`'s SECURITY note —
 * and the narrow exception is justified by the vendor needing to name a specific
 * depot. Per-location `support_contact` is still withheld: picking a warehouse
 * does not require its phone number, and it is customer-facing data.
 */
export interface VendorAgencyLocationDto {
    /** The depot's stable id — what a product's `agencyAddressId` stores. */
    id: string;
    /** The agency's own name for it ("Main depot"). Null on legacy entries. */
    label: string | null;
    region: string | null;
    city: string | null;
    addressDescription: string;
    /**
     * Whether this is the agency's primary depot (index 0). A product that names
     * no depot resolves here, so the picker should mark it as the default.
     */
    isPrimary: boolean;
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
     * SECURITY (this DTO — the agency BROWSE/LIST surface):
     * - KYC registration_number and transport_license_id are NEVER returned
     * - Payout details are NEVER returned
     * - Per-location support contacts are NEVER returned
     * - Only the primary HQ address (index 0) is exposed — no branch addresses
     *
     * The branch-address rule is scoped to this listing. `toLocationDto` below
     * deliberately exposes every location, on one connection-gated endpoint, so a
     * vendor can name which depot warehouses their stock — a choice they cannot
     * make from a single summarised address. Support contacts stay withheld on
     * both.
     */
    static toListItemDto(
        agency: IDeliveryAgency,
        magazin: AgencyMagazinSummary | null,
        logo: FileDetail | null = null,
    ): VendorAgencyListItemDto {
        // Business name, coverage areas and HQ addresses live on the Magazin.
        const primaryHQ = magazin?.headquarters_addresses?.[0] ?? null;

        return {
            id: agency._id.toString(),
            agencyName: magazin?.name ?? '',
            logo,
            kycVerified: agency.kyc_details?.legit_verified ?? false,
            headquartersAddress: primaryHQ
                ? {
                      region: primaryHQ.region,
                      city: primaryHQ.city,
                      address_description: primaryHQ.address_description,
                  }
                : null,
            country: agency.country ?? null,
            coverageAreas: magazin?.coverage_areas ?? [],
            // TODO(ratings, 2026-08-19, phase 6.E): always null — there is no ratings system,
            // so there is nothing to populate this from. This is a BACKLOG item, not debt: the
            // field is on the wire because the agency directory's card renders a rating slot,
            // and 6.E owns whether that number ever exists. Until it does, `null` is the
            // truthful answer and a computed placeholder would be a fabricated one.
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

    /**
     * Map one of an agency's headquarters entries to the vendor-facing depot DTO.
     * `index` decides `isPrimary` — primary-ness is positional here (index 0),
     * there is no `is_primary` flag on the stored entry.
     */
    static toLocationDto(hq: IAgencyHeadquartersAddress, index: number): VendorAgencyLocationDto {
        return {
            id: hq._id.toString(),
            label: hq.label ?? null,
            region: hq.region ?? null,
            city: hq.city ?? null,
            addressDescription: hq.address_description,
            isPrimary: index === 0,
        };
    }
}
