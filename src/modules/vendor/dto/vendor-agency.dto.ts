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
     * Agency rating, 0–5, from its **customers'** delivery reviews. `null` when
     * nobody has rated it — never `0`, which would read as "rated one star by
     * everybody".
     *
     * ── Which reviews feed this, and why only those ──────────────────────────
     * Three roles can review a delivery, and this number is the **customer**
     * average alone. Mixing the three would produce a figure that answers no
     * question — a vendor's rating of a carrier and a recipient's rating of the
     * same delivery are measuring different things — and the customers' is both the
     * largest sample and the one that describes what the agency actually sells.
     * An agency's own reviews of its agents never appear here at all; `targetsOf`
     * drops the agency target for `author_role: 'agency'` precisely so a business's
     * public score cannot be self-reported.
     */
    rating: number | null;
    /**
     * How many customer delivery reviews `rating` is an average of. `0` when there
     * are none.
     *
     * On the wire beside the average rather than folded into an object, so this
     * stays a purely **additive** change: `rating` keeps its type and its meaning,
     * and a client that never read a count still works. A rating shown without its
     * count is not renderable honestly — 5.0 from one delivery and 4.6 from two
     * hundred are not the same claim — so a card that prints the stars should print
     * this too.
     */
    ratingCount: number;
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
        /**
         * This agency's customer delivery-review aggregate, batch-resolved by the
         * caller. Optional and defaulting to nothing so the mapper stays usable
         * from a call site that has not resolved one — the truthful answer there is
         * the same `null` the field has always carried.
         */
        rating: { average: number; count: number } | null = null,
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
            // Closed by Phase 6 Step 10 (6.E.4). The TODO that stood here said "always
            // null — there is no ratings system"; there is one now, and this is its
            // customer aggregate. It is still `null` for an agency nobody has reviewed,
            // which is the same truthful answer for a different reason — an average of
            // zero reviews is not a rating, and rendering `0` would be the fabricated
            // placeholder the TODO was written to refuse.
            rating: rating && rating.count > 0 ? rating.average : null,
            ratingCount: rating?.count ?? 0,
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
