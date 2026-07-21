import { IGeoPoint } from '../types/geo.types';
import { GeoProviderName, IGeoAddressComponents } from '../types/geo-address.types';

/**
 * ─── Geocoding Provider abstraction ──────────────────────────────────────────
 *
 * The ONE seam between jovi-mall and any geocoding backend (Nominatim, Google,
 * Mapbox, HERE, Geoapify, …). Business logic depends only on this interface and
 * on {@link GeoCandidate}; it must never import a concrete provider. Swapping the
 * active provider is a config change (`GEO_PROVIDER`), never a code change —
 * mirroring the storage provider abstraction in `core/storage/`.
 *
 * Only Nominatim has an adapter in this build; the factory throws a clear error
 * for a provider that is selected but unimplemented, so the seam stays visible.
 */

/**
 * A provider-neutral geocoding result. This is exactly what the frontend receives
 * from `GET /api/geo/search` and what it sends back (plus the user's `raw_input`)
 * to be stored as an {@link IGeoAddress} — see `toGeoAddress`. It intentionally
 * omits `raw_input` and `resolved_at`, which are assigned when the address is
 * stored, not when it is searched.
 */
export interface GeoCandidate {
    formatted_address: string;
    coordinates: IGeoPoint;
    provider: GeoProviderName;
    provider_place_id: string | null;
    components: IGeoAddressComponents;
}

/** Optional biasing/limiting for a forward-geocode search. */
export interface GeoSearchOptions {
    /** Max candidates to return. Provider clamps to its own ceiling. */
    limit?: number;
    /** ISO-3166-1 alpha-2 codes to bias/restrict results to (e.g. ['cm']). */
    countryCodes?: string[];
    /** Preferred result language (BCP-47, e.g. 'fr'). */
    language?: string;
}

export interface IGeocodingProvider {
    /** Which provider this instance is. Matches the `provider` on its candidates. */
    readonly name: GeoProviderName;

    /**
     * Forward geocode / autocomplete: turn free-form text into ranked candidates.
     * Returns `[]` for no matches. Throws `createAppError` on provider failure
     * (never a bare Error).
     */
    search(query: string, opts?: GeoSearchOptions): Promise<GeoCandidate[]>;

    /**
     * Reverse geocode: turn a coordinate into its best-matching address, or
     * `null` if the provider has none for that point.
     */
    reverse(lat: number, lng: number): Promise<GeoCandidate | null>;
}
