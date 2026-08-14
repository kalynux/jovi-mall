/**
 * The store shape served to unauthenticated callers — the storefront's seller pages.
 *
 * ⚠️ **A security boundary, like `catalog/dto/public-product.dto.ts`.** `/api/public/*`
 * carries no auth guard, so every field named here is world-readable. Adding a field to
 * `Store` or `Vendor` does not publish it.
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 *
 * The starting point is `GetStoreProfileResponseDto`, whose own header says "all fields
 * are safe for public consumption". That is true of the *store* document — it holds
 * branding and support contacts and nothing else, by design (`store.model.ts` deliberately
 * carries no address, because physical locations are the vendor's). So the public shape is
 * that one minus two fields:
 *
 *   - **`vendorId`** — the storefront addresses a seller by store slug, and `Store.slug` is
 *     globally unique, lowercase and immutable through the vendor API. Publishing the
 *     internal vendor id would make it a public identifier by accident, and it is the join
 *     key to every private thing the vendor owns.
 *   - **`version`** — an optimistic-locking counter for the vendor's own PATCH. It is
 *     meaningless to a reader and would invite a client to send it back.
 *
 * and plus four the shopper needs, all sourced from the **vendor** document rather than the
 * store: `city`, `country`, `verified`, and the derived `productCount` / `memberSince`.
 *
 * ── The vendor document is the dangerous half ───────────────────────────────
 *
 * Everything above is drawn from a `Vendor` that also holds `user_id`, `email`, `phone`,
 * `payout_details` (bank and mobile-money destinations), the full `kyc_details` block
 * (national id number, reviewer identity, rejection reasons), `suspended_*`,
 * `default_delivery_agency_id`, `wa.*`, `notification_preferences` and `two_factor_enabled`.
 * None of it is published, and this mapper takes a **narrow input type** rather than the
 * whole vendor document so that the compiler — not a reviewer's attention — is what stops
 * a field from leaking here later.
 *
 * **`city` is the only address component published, and that is deliberate.** A vendor's
 * `business_addresses[]` entries are the places they ship from: a home, or a warehouse,
 * with `address_line1`, a geocoded coordinate pair and a provider place id. A shopper
 * needs to know which city a seller trades in; publishing the rest would put a private
 * residential address and its exact coordinates on a public page.
 */
import { IStore } from '../models/store.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

/**
 * The only vendor fields this DTO may ever see.
 *
 * Deliberately not `IVendor`. If the mapper took the whole document, publishing
 * `payout_details` would be a one-word typo away and would type-check; taking this instead
 * means a leak has to be introduced in two places, one of which is this comment's file.
 */
export interface PublicStoreVendorFacts {
    /** The vendor's own status. Only used to decide visibility — never published. */
    status: string;
    /** ISO-3166 alpha-2, from the vendor's top level. The store carries no country. */
    country: string | null;
    /** `kyc_details.legit_verified` — the boolean projection of `kyc.status === 'verified'`. */
    verified: boolean;
    /** `business_addresses[0].city`. CITY ONLY — see the header. */
    city: string | null;
    /** Which language this vendor authors their catalogue text in. */
    preferredLanguage: string | null;
}

export interface PublicStoreDto {
    slug: string;
    name: string;
    description: string | null;
    logo: FileDetail | null;
    banner: FileDetail | null;
    /** Vendor vacation mode. Products stay listed either way — see §2.7e. */
    isOpen: boolean;
    supportEmail: string | null;
    supportPhone: string | null;
    supportWhatsapp: string | null;
    country: string | null;
    city: string | null;
    verified: boolean;
    /** Active, publishable products only — the same predicate the browse grid uses. */
    productCount: number;
    /** `store.created_at`. */
    memberSince: string;
}

export interface PublicStoreMapperInput {
    store: Pick<
        IStore,
        'slug' | 'name' | 'description' | 'is_open' | 'support_email' | 'support_phone' | 'support_whatsapp' | 'created_at'
    >;
    vendor: PublicStoreVendorFacts;
    logo: FileDetail | null;
    banner: FileDetail | null;
    productCount: number;
}

/** Pure — `test:public-catalog` asserts the projection without touching Mongo. */
export function toPublicStoreDto(input: PublicStoreMapperInput): PublicStoreDto {
    const { store, vendor } = input;
    return {
        slug: store.slug,
        name: store.name,
        description: store.description ?? null,
        logo: input.logo,
        banner: input.banner,
        isOpen: store.is_open,
        supportEmail: store.support_email ?? null,
        supportPhone: store.support_phone ?? null,
        supportWhatsapp: store.support_whatsapp ?? null,
        country: vendor.country,
        city: vendor.city,
        verified: vendor.verified,
        productCount: input.productCount,
        memberSince: new Date(store.created_at).toISOString(),
    };
}
