import { createAppError } from '../errors';
import { ERROR_CODES } from '../error-codes';
import { GeoAddressInput, IGeoAddress } from '../types/geo-address.types';

/**
 * Address ⇄ country policy helpers.
 *
 * Every profile that owns physical addresses (vendor `business_addresses`,
 * agency `headquarters_addresses`) is anchored to a single registered country,
 * chosen during onboarding and immutable afterwards. New or edited address
 * entries must carry a geocoded `geo` (a selected `/api/geo/search` result)
 * whose resolved country matches that anchor — untouched legacy entries are
 * grandfathered until their next edit (see the role services for the
 * "unchanged" classification, which is address-shape-specific).
 *
 * These helpers are the shared, shape-agnostic pieces: geo equality (used to
 * detect an untouched entry) and the geo-presence + country-match assertion.
 */

/**
 * Whether an incoming (zod-validated) geo refers to the same geocoded place as
 * a stored one. Identity is the provider's resolution — provider, place id,
 * formatted address and coordinates — not the mutable `resolved_at`.
 */
export function geoAddressEquals(
    incoming: GeoAddressInput | null | undefined,
    existing: IGeoAddress | null | undefined,
): boolean {
    const a = incoming ?? null;
    const b = existing ?? null;
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return (
        a.provider === b.provider &&
        (a.provider_place_id ?? null) === (b.provider_place_id ?? null) &&
        a.formatted_address === b.formatted_address &&
        a.coordinates.coordinates[0] === b.coordinates.coordinates[0] &&
        a.coordinates.coordinates[1] === b.coordinates.coordinates[1]
    );
}

/**
 * Assert a new/edited address entry carries a geocoded location inside the
 * registered country.
 *
 * - No `geo` at all → `ADDRESS_GEO_REQUIRED` (400).
 * - `country` set and the geo's ISO-2 country code missing or different →
 *   `ADDRESS_COUNTRY_MISMATCH` (400).
 * - `country` not set yet (profile still mid-onboarding) → only the geo
 *   presence is enforced; the country check waits for the anchor.
 */
export function assertGeoInCountry(
    geo: GeoAddressInput | null | undefined,
    country: string | null | undefined,
    context: { index: number; label: string | null },
): void {
    if (!geo) {
        throw createAppError(
            ERROR_CODES.ADDRESS_GEO_REQUIRED,
            400,
            'New or edited addresses must include a geocoded location (`geo`) selected from /api/geo/search.',
            { index: context.index, label: context.label },
        );
    }

    if (!country) return;

    const addressCountryCode = geo.components?.country_code?.toUpperCase() ?? null;
    if (addressCountryCode !== country.toUpperCase()) {
        throw createAppError(
            ERROR_CODES.ADDRESS_COUNTRY_MISMATCH,
            400,
            `Addresses must be located in your registered country (${country.toUpperCase()}). Pick the address again from /api/geo/search within that country.`,
            {
                index: context.index,
                label: context.label,
                addressCountryCode,
                requiredCountry: country.toUpperCase(),
            },
        );
    }
}

/**
 * Assert every NEW or EDITED headquarters/address entry in a full-replace array
 * carries a geocoded `geo` inside the registered country. HQ entries carry no
 * client `_id`, so "unchanged" is content-based — same `address_description` and
 * the same geocoded place — and those entries are grandfathered. Shared by the
 * agency onboarding flow and the Magazin update endpoint.
 *
 * Deliberately excluded from that comparison:
 * - `region` / `city`, because they are now DERIVED from `geo` rather than typed.
 *   A client that omits them (as it should) would otherwise make every legacy
 *   plain-text row look edited and demand a re-geocode just to re-save the list.
 * - `label`, because naming a location is not moving it. Legacy rows have no
 *   label, so the first save that adds one would otherwise trip the same trap.
 * Both are safe to ignore: neither can change *where* the entry is, which is all
 * this assertion protects.
 */
export function assertHeadquartersInCountry(
    incoming: Array<{ label?: string | null; address_description: string; geo?: GeoAddressInput | null }>,
    existing: Array<{ address_description: string; geo?: IGeoAddress | null }> | undefined,
    country: string | null | undefined,
): void {
    const previous = existing ?? [];
    incoming.forEach((entry, index) => {
        const unchanged = previous.some(
            (p) =>
                entry.address_description === p.address_description &&
                geoAddressEquals(entry.geo, p.geo),
        );
        if (unchanged) return;
        assertGeoInCountry(entry.geo, country, { index, label: entry.label ?? null });
    });
}
