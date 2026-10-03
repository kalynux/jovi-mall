import { createAppError } from '../errors';
import { ERROR_CODES } from '../error-codes';
import { GeoAddressInput, IGeoAddress } from '../types/geo-address.types';
import {
    isKnownCountry,
    listCountryRegions,
    matchCountryRegion,
    regionDisplayName,
    regionKeyForCity,
} from '../constants/locations.helper';

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
 * carries a geocoded `geo` inside the registered country; unchanged entries are
 * grandfathered. Shared by the agency onboarding flow and the Magazin update
 * endpoint.
 *
 * An entry counts as unchanged when its geocoded place is equal AND either:
 * - it carries an `id` matching an existing entry (the entry says which row it
 *   is), or
 * - its `address_description` matches an existing entry (the content route).
 *
 * Both routes are kept. HQ entries only recently gained a client-supplied `id`,
 * so going id-only would treat every legacy row — and every entry from a client
 * that has not shipped the echo — as brand new, demanding a re-geocode of the
 * whole list just to re-save it. The id route only ADDS the case content-matching
 * misses: correcting a typo in `address_description` while the pin stays put.
 *
 * `geoAddressEquals` is mandatory on BOTH routes. Same id with a moved pin is a
 * move, and a move into another country is exactly what this guards.
 *
 * Deliberately excluded from the comparison:
 * - `region` / `city`, because they are now DERIVED from `geo` rather than typed.
 *   A client that omits them (as it should) would otherwise make every legacy
 *   plain-text row look edited and demand a re-geocode just to re-save the list.
 * - `label`, because naming a location is not moving it. Legacy rows have no
 *   label, so the first save that adds one would otherwise trip the same trap.
 * Both are safe to ignore: neither can change *where* the entry is, which is all
 * this assertion protects.
 */
export function assertHeadquartersInCountry(
    incoming: Array<{ id?: string | null; label?: string | null; address_description: string; geo?: GeoAddressInput | null }>,
    existing: Array<{ _id?: { toString(): string }; address_description: string; geo?: IGeoAddress | null }> | undefined,
    country: string | null | undefined,
): void {
    const previous = existing ?? [];
    incoming.forEach((entry, index) => {
        const unchanged = previous.some(
            (p) =>
                geoAddressEquals(entry.geo, p.geo) &&
                (entry.address_description === p.address_description ||
                    (!!entry.id && entry.id === p._id?.toString())),
        );
        if (unchanged) return;
        assertGeoInCountry(entry.geo, country, { index, label: entry.label ?? null });
        // A headquarters is a pickup point (the `agency_business` handover), so its region
        // must name one of the country's regions too, as a customer's drop-off must.
        canonicalizeAddressRegion(entry.geo!, { index, label: entry.label ?? null });
    });
}

/**
 * Pin a customer address's region to one of its country's regions, or refuse it.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * A drop-off's `components.region` is what an agency's contract coverage is
 * matched against. It used to be stored exactly as the geocoder (or the client)
 * sent it, so a delivery could sit in "Centre Region" while every contract said
 * `centre`, and no agent was ever offered it.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * - The region is matched leniently (`matchCountryRegion`: "Centre Region",
 *   "Région du Centre", "Center" → `centre`); failing that, the city is looked up
 *   in the country's city lists (`regionKeyForCity`: Yaoundé → `centre`).
 * - A match is written back as the region's canonical English name, so every
 *   stored drop-off of one region carries one spelling.
 * - No match → `ADDRESS_REGION_INVALID` (400), with the country's regions in
 *   `details.allowedRegions`. The client resends with `components.region` set to
 *   the picked key.
 * - A country the dataset has no regions for, or no country code at all, is left
 *   untouched: there is no list to check against, and refusing would block every
 *   address there.
 *
 * Returns a copy; the input is not mutated. Works on both the wire shape and the
 * stored shape, so a legacy saved address can be checked at checkout too.
 */
export function canonicalizeAddressRegion<T extends GeoAddressInput | IGeoAddress>(
    geo: T,
    context: { addressId?: string | null; index?: number; label?: string | null } = {},
): T {
    const components = geo.components ?? {};
    const country = components.country_code ?? null;
    if (!country || !isKnownCountry(country)) return geo;

    const key =
        matchCountryRegion(components.region, country) ??
        regionKeyForCity(components.city, country) ??
        regionKeyForCity(components.neighbourhood, country);

    if (!key) {
        throw createAppError(
            ERROR_CODES.ADDRESS_REGION_INVALID,
            400,
            `This address is not in a recognised region of ${country.toUpperCase()}. Pick its region and send it as components.region.`,
            {
                ...(context.addressId ? { addressId: context.addressId } : {}),
                // Set for a full-replace address LIST (vendor business addresses, agency
                // headquarters), where the entry is named by its position, as in
                // ADDRESS_GEO_REQUIRED / ADDRESS_COUNTRY_MISMATCH.
                ...(context.index !== undefined ? { index: context.index, label: context.label ?? null } : {}),
                region: components.region ?? null,
                city: components.city ?? null,
                countryCode: country.toUpperCase(),
                allowedRegions: listCountryRegions(country),
            },
        );
    }

    return {
        ...geo,
        components: { ...components, region: regionDisplayName(key, country) },
    };
}

/**
 * {@link canonicalizeAddressRegion} without the refusal: pin the region when it (or the
 * city) names one, leave the address untouched otherwise.
 *
 * For the PERSIST step of a full-replace address list, which maps every entry, including
 * legacy ones the assertion step grandfathered. An untouched old row must still save; it
 * just gets the canonical spelling when one can be found. New and edited rows have already
 * been through the strict check by then.
 */
export function pinAddressRegionIfKnown<T extends GeoAddressInput | IGeoAddress>(geo: T): T {
    try {
        return canonicalizeAddressRegion(geo);
    } catch {
        return geo;
    }
}
