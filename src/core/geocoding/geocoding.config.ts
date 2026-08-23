import { GeoProviderName } from '../types/geo-address.types';

/**
 * Geocoding Provider Configuration
 *
 * Shapes the config for every geocoding provider. Only the active provider
 * (`provider`) is used; the rest of the blocks are advisory until their adapter
 * is implemented. Loaded from environment variables in `geocoding.instance.ts`,
 * mirroring `core/storage/storage.instance.ts`.
 */

export type GeocodingProviderType = GeoProviderName;

/** OpenStreetMap Nominatim. Keyless, but the usage policy REQUIRES a User-Agent. */
export interface NominatimConfig {
    /** API base, e.g. 'https://nominatim.openstreetmap.org' (or a self-hosted mirror). */
    baseUrl: string;
    /**
     * Identifying User-Agent sent on every request — mandatory under Nominatim's
     * usage policy. A generic/absent UA gets the caller blocked.
     */
    userAgent: string;
    /** Optional contact email, appended as `email=` (also part of the policy). */
    email?: string;
}

/** Reserved for future adapters — present so the seam is explicit in config. */
export interface ApiKeyProviderConfig {
    apiKey: string;
    baseUrl?: string;
}

/**
 * The result cache (ADR-A04 D-1). Provider-independent by construction — it decorates
 * `IGeocodingProvider`, so it applies to whichever adapter is active and to the paid one when
 * it lands.
 */
export interface GeocodingCacheConfig {
    /** Off switch. The cache is an optimisation, so an operator must be able to take it out. */
    enabled: boolean;
    /** Seconds a resolved result is kept. */
    ttlSeconds: number;
    /** Seconds an empty result is kept — shorter, so a newly-mapped street is not hidden. */
    negativeTtlSeconds: number;
    /** Decimal places a reverse-geocode coordinate is rounded to (~11 m at 4). */
    reversePrecision: number;
}

export interface GeocodingConfig {
    /** Active provider. Default 'nominatim'. */
    provider: GeocodingProviderType;
    /** Per-request timeout (ms) enforced via AbortController. */
    requestTimeoutMs: number;
    /** Default number of candidates a search returns when the caller gives none. */
    defaultLimit: number;
    /** ISO-2 country codes to bias results toward (e.g. ['cm']). Empty = worldwide. */
    defaultCountryCodes: string[];
    /** Result caching. Always present; `enabled: false` is how it is switched off. */
    cache: GeocodingCacheConfig;

    nominatim?: NominatimConfig;
    google?: ApiKeyProviderConfig;
    mapbox?: ApiKeyProviderConfig;
    here?: ApiKeyProviderConfig;
    geoapify?: ApiKeyProviderConfig;
}
