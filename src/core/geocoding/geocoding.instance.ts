import { GeocodingConfig, GeocodingProviderType } from './geocoding.config';
import { GeoProviderName } from '../types/geo-address.types';
import { IGeocodingProvider } from './geocoding-provider.interface';
import { createGeocodingProvider } from './geocoding.factory';
import { CachedGeocodingProvider } from './geocoding.cache';

/**
 * Centralized Geocoding Configuration
 *
 * Single source of truth for geocoding provider config, loaded once at startup
 * from environment variables (mirrors `core/storage/storage.instance.ts`).
 *
 * ENVIRONMENT VARIABLES:
 * - GEO_PROVIDER            : 'chain' | 'nominatim' | 'geoapify' | 'locationiq' | 'google' |
 *                             'mapbox' | 'here' (default 'nominatim'). **'chain' is the
 *                             intended production setting** — see the factory.
 * - GEO_PROVIDER_CHAIN      : failover order for 'chain' (default 'geoapify,locationiq').
 *                             `nominatim` is always appended as the keyless last resort.
 * - GEO_REQUEST_TIMEOUT_MS  : per-request timeout (default 5000)
 * - GEO_DEFAULT_LIMIT       : default search result count (default 5)
 * - GEO_DEFAULT_COUNTRY_CODES: comma-separated ISO-2 bias, e.g. 'cm' (default 'cm')
 * - GEO_NOMINATIM_BASE_URL  : Nominatim endpoint (default public OSM instance)
 * - GEO_NOMINATIM_USER_AGENT: REQUIRED-by-policy identifying UA
 * - GEO_NOMINATIM_EMAIL     : optional contact email
 * - GEO_GEOAPIFY_API_KEY    : Geoapify key. Free tier 3 000/day @ 5 rps, SOFT limits
 * - GEO_GEOAPIFY_BASE_URL   : override (default https://api.geoapify.com/v1/geocode)
 * - GEO_LOCATIONIQ_API_KEY  : LocationIQ key. Free tier 5 000/day @ 2 rps, HARD limits
 * - GEO_LOCATIONIQ_BASE_URL : region host (default https://eu1.locationiq.com/v1; us1 also valid)
 * - GEO_CACHE_ENABLED       : result cache on/off (default true) — ADR-A04 D-1
 * - GEO_CACHE_TTL_SECONDS   : how long a resolved result is kept (default 86400)
 * - GEO_CACHE_NEGATIVE_TTL_SECONDS: how long an empty result is kept (default 600)
 * - GEO_CACHE_REVERSE_PRECISION   : decimals a reverse coordinate is rounded to (default 4)
 */

function parseCountryCodes(raw: string | undefined): string[] {
    if (raw == null || raw.trim() === '') return [];
    return raw
        .split(',')
        .map(c => c.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Parse `GEO_PROVIDER_CHAIN`. Returns undefined for an unset/blank value so the
 * factory applies its own default order rather than being handed an empty array.
 *
 * Names are NOT validated here — a typo must reach the factory, which refuses to
 * boot on it. Filtering unknown names out at parse time is how a deployment ends
 * up silently running on its fallback while believing it runs on its primary.
 */
function parseChain(raw: string | undefined): GeoProviderName[] | undefined {
    if (raw == null || raw.trim() === '') return undefined;
    const names = raw.split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
    return names.length > 0 ? (names as GeoProviderName[]) : undefined;
}

function loadGeocodingConfig(): GeocodingConfig {
    const provider = (process.env.GEO_PROVIDER || 'nominatim') as GeocodingProviderType;

    const config: GeocodingConfig = {
        provider,
        requestTimeoutMs: Number(process.env.GEO_REQUEST_TIMEOUT_MS) || 5000,
        defaultLimit: Number(process.env.GEO_DEFAULT_LIMIT) || 5,
        // Default-bias to Cameroon (the platform's market); override to '' for worldwide.
        defaultCountryCodes: parseCountryCodes(process.env.GEO_DEFAULT_COUNTRY_CODES ?? 'cm'),
        // Order matters and the default is not arbitrary: Geoapify first because its
        // limits are SOFT and its burst ceiling is the higher (5 rps vs 2), LocationIQ
        // second because its daily allowance is the larger (5 000 vs 3 000) and it is
        // therefore the better reserve. Putting LocationIQ first would 429 on ordinary
        // autocomplete typing — three keystrokes in a second is over its limit.
        chain: parseChain(process.env.GEO_PROVIDER_CHAIN),
        cache: {
            // ON by default, unlike most optional infrastructure here. The cache is what makes
            // the keyless Nominatim default survivable — its public instance permits roughly one
            // request per second — so shipping it off would leave the common configuration in
            // exactly the state ADR-A04 was written about. It fails open, so "on" costs nothing
            // when Redis is absent.
            enabled: process.env.GEO_CACHE_ENABLED !== 'false',
            ttlSeconds: Number(process.env.GEO_CACHE_TTL_SECONDS) || 86_400,
            negativeTtlSeconds: Number(process.env.GEO_CACHE_NEGATIVE_TTL_SECONDS) || 600,
            // `??` rather than `||`, so a deliberate 0 (round to whole degrees) is not silently
            // replaced by the default. `Number('')` is 0, hence the explicit undefined check.
            reversePrecision:
                process.env.GEO_CACHE_REVERSE_PRECISION !== undefined
                && process.env.GEO_CACHE_REVERSE_PRECISION !== ''
                    ? Number(process.env.GEO_CACHE_REVERSE_PRECISION)
                    : 4,
        },
    };

    // Nominatim is always configured (it is the keyless default fallback).
    config.nominatim = {
        baseUrl: process.env.GEO_NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org',
        userAgent:
            process.env.GEO_NOMINATIM_USER_AGENT ||
            'jovi-mall/1.0 (+https://jovimall.com; geocoding)',
        email: process.env.GEO_NOMINATIM_EMAIL || undefined,
    };

    // ⚠ A block is populated ONLY when its key is present, and the factory reads
    // that absence as "skip this provider" when building a chain. So the presence
    // of a key is the switch — there is deliberately no separate `*_ENABLED` flag
    // to disagree with it.
    if (process.env.GEO_GEOAPIFY_API_KEY) {
        config.geoapify = {
            apiKey: process.env.GEO_GEOAPIFY_API_KEY,
            baseUrl: process.env.GEO_GEOAPIFY_BASE_URL,
        };
    }
    if (process.env.GEO_LOCATIONIQ_API_KEY) {
        config.locationiq = {
            apiKey: process.env.GEO_LOCATIONIQ_API_KEY,
            // `us1` and `eu1` are separate hosts serving the same API; eu1 is the
            // shorter round trip from this platform's market.
            baseUrl: process.env.GEO_LOCATIONIQ_BASE_URL,
        };
    }

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
 *
 * ── The cache is wrapped HERE, and that placement is the design (ADR-A04 D-1) ──
 * Not inside the factory, and not inside an adapter. This is the one function every caller
 * already goes through, so wrapping here means the cache applies to whichever provider is
 * configured — including the paid adapter D-2 defers, whose author inherits it without knowing
 * it exists. Wrapping inside `NominatimProvider` would have to be written again for that
 * adapter; wrapping in the factory would put a Redis dependency in the file whose only job is
 * to translate a config string into a class.
 *
 * The decorator forwards `name`, so `getGeocodingProviderType()` and every `GeoCandidate` still
 * report the real provider. Nothing downstream can tell the difference, which is the property
 * that keeps "no business logic branches on the provider" true.
 */
export function getGeocodingProvider(): IGeocodingProvider {
    if (!geocodingProviderInstance) {
        const provider = createGeocodingProvider(geocodingConfig);
        geocodingProviderInstance = geocodingConfig.cache.enabled
            ? new CachedGeocodingProvider(
                provider,
                geocodingConfig.defaultCountryCodes,
                {
                    ttlSeconds: geocodingConfig.cache.ttlSeconds,
                    negativeTtlSeconds: geocodingConfig.cache.negativeTtlSeconds,
                    reversePrecision: geocodingConfig.cache.reversePrecision,
                },
            )
            : provider;
        console.log(
            `[Geocoding] Initialized ${geocodingConfig.provider} geocoding provider`
            + ` (cache ${geocodingConfig.cache.enabled ? 'on' : 'off'})`,
        );
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
