import { GeocodingConfig, GeocodingProviderType } from './geocoding.config';
import { IGeocodingProvider } from './geocoding-provider.interface';
import { createGeocodingProvider } from './geocoding.factory';

/**
 * Centralized Geocoding Configuration
 *
 * Single source of truth for geocoding provider config, loaded once at startup
 * from environment variables (mirrors `core/storage/storage.instance.ts`).
 *
 * ENVIRONMENT VARIABLES:
 * - GEO_PROVIDER            : 'nominatim' | 'google' | 'mapbox' | 'here' | 'geoapify' (default 'nominatim')
 * - GEO_REQUEST_TIMEOUT_MS  : per-request timeout (default 5000)
 * - GEO_DEFAULT_LIMIT       : default search result count (default 5)
 * - GEO_DEFAULT_COUNTRY_CODES: comma-separated ISO-2 bias, e.g. 'cm' (default 'cm')
 * - GEO_NOMINATIM_BASE_URL  : Nominatim endpoint (default public OSM instance)
 * - GEO_NOMINATIM_USER_AGENT: REQUIRED-by-policy identifying UA
 * - GEO_NOMINATIM_EMAIL     : optional contact email
 */

function parseCountryCodes(raw: string | undefined): string[] {
    if (raw == null || raw.trim() === '') return [];
    return raw
        .split(',')
        .map(c => c.trim().toLowerCase())
        .filter(Boolean);
}

function loadGeocodingConfig(): GeocodingConfig {
    const provider = (process.env.GEO_PROVIDER || 'nominatim') as GeocodingProviderType;

    const config: GeocodingConfig = {
        provider,
        requestTimeoutMs: Number(process.env.GEO_REQUEST_TIMEOUT_MS) || 5000,
        defaultLimit: Number(process.env.GEO_DEFAULT_LIMIT) || 5,
        // Default-bias to Cameroon (the platform's market); override to '' for worldwide.
        defaultCountryCodes: parseCountryCodes(process.env.GEO_DEFAULT_COUNTRY_CODES ?? 'cm'),
    };

    // Nominatim is always configured (it is the keyless default fallback).
    config.nominatim = {
        baseUrl: process.env.GEO_NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org',
        userAgent:
            process.env.GEO_NOMINATIM_USER_AGENT ||
            'jovi-mall/1.0 (+https://jovimall.com; geocoding)',
        email: process.env.GEO_NOMINATIM_EMAIL || undefined,
    };

    // Future adapters: only populate their block when a key is present.
    if (process.env.GEO_GOOGLE_API_KEY) {
        config.google = { apiKey: process.env.GEO_GOOGLE_API_KEY, baseUrl: process.env.GEO_GOOGLE_BASE_URL };
    }
    if (process.env.GEO_MAPBOX_TOKEN) {
        config.mapbox = { apiKey: process.env.GEO_MAPBOX_TOKEN, baseUrl: process.env.GEO_MAPBOX_BASE_URL };
    }

    return config;
}

/** Global geocoding configuration (loaded once at startup). */
export const geocodingConfig = loadGeocodingConfig();

/** Singleton geocoding provider instance (lazy-initialized). */
let geocodingProviderInstance: IGeocodingProvider | null = null;

/**
 * Get the singleton geocoding provider. The recommended way to reach geocoding
 * throughout the app. Created lazily on first access and reused thereafter.
 */
export function getGeocodingProvider(): IGeocodingProvider {
    if (!geocodingProviderInstance) {
        geocodingProviderInstance = createGeocodingProvider(geocodingConfig);
        console.log(`[Geocoding] Initialized ${geocodingConfig.provider} geocoding provider`);
    }
    return geocodingProviderInstance;
}

/** Current active provider type — for debugging / conditional logic. */
export function getGeocodingProviderType(): GeocodingProviderType {
    return geocodingConfig.provider;
}

/** Reset the singleton (tests only). */
export function resetGeocodingProvider(): void {
    geocodingProviderInstance = null;
}
