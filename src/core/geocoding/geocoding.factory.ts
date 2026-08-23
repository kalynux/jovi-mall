import { createAppError } from '../errors';
import { ERROR_CODES } from '../error-codes';
import { GEO_PROVIDERS, GeoProviderName } from '../types/geo-address.types';
import { GeocodingConfig } from './geocoding.config';
import { IGeocodingProvider } from './geocoding-provider.interface';
import { NominatimProvider } from './providers/nominatim.provider';
import { GeoapifyProvider } from './providers/geoapify.provider';
import { LocationIqProvider } from './providers/locationiq.provider';
import { ChainedGeocodingProvider } from './geocoding.chain';

/**
 * Geocoding Provider Factory
 *
 * The ONLY place where geocoding provider selection happens (mirrors
 * `core/storage/storage.factory.ts`). Providers that are named in
 * {@link GEO_PROVIDERS} but have no adapter in this build throw a clear
 * GEO_PROVIDER_NOT_CONFIGURED so the missing seam is obvious; an entirely
 * unknown provider string throws CONFIG_INVALID_GEO_PROVIDER.
 *
 * ── `GEO_PROVIDER=chain` is the intended production setting ──────────────────
 *
 * Every provider with a usable free tier caps out in the low thousands of calls a
 * day, and address search at checkout spends them. The chain adds the allowances
 * together and fails over on a 429 or an outage — see
 * {@link ChainedGeocodingProvider} for what it does and does not fall over on.
 */
export function createGeocodingProvider(config: GeocodingConfig): IGeocodingProvider {
    const { provider } = config;

    if (provider === 'chain') return buildChain(config);
    return buildOne(provider, config, { required: true })!;
}

/**
 * Build one named provider.
 *
 * `required: false` is the chain's mode: a provider whose credentials are absent
 * returns `null` to be skipped, instead of throwing. That asymmetry is the whole
 * reason one `GEO_PROVIDER=chain` setting can serve a laptop with no keys and a
 * production host with both — see {@link GeocodingConfig.chain}.
 */
function buildOne(
    name: GeoProviderName,
    config: GeocodingConfig,
    opts: { required: boolean },
): IGeocodingProvider | null {
    const missing = (what: string): never | null => {
        if (!opts.required) {
            console.warn(`[Geocoding] '${name}' skipped — ${what}`);
            return null;
        }
        throw createAppError(ERROR_CODES.GEO_PROVIDER_NOT_CONFIGURED, 500, what);
    };

    switch (name) {
        case 'nominatim':
            if (!config.nominatim) {
                return missing("Nominatim configuration is required when GEO_PROVIDER is 'nominatim'");
            }
            return new NominatimProvider(
                config.nominatim,
                config.requestTimeoutMs,
                config.defaultLimit,
                config.defaultCountryCodes,
            );

        case 'geoapify':
            if (!config.geoapify) {
                return missing("GEO_GEOAPIFY_API_KEY is not set, so the 'geoapify' adapter cannot be built");
            }
            return new GeoapifyProvider(
                config.geoapify,
                config.requestTimeoutMs,
                config.defaultLimit,
                config.defaultCountryCodes,
            );

        case 'locationiq':
            if (!config.locationiq) {
                return missing("GEO_LOCATIONIQ_API_KEY is not set, so the 'locationiq' adapter cannot be built");
            }
            return new LocationIqProvider(
                config.locationiq,
                config.requestTimeoutMs,
                config.defaultLimit,
                config.defaultCountryCodes,
            );

        // Adapters not implemented in this build. The abstraction is ready — drop
        // in a provider class + config block and add a case here.
        case 'google':
        case 'mapbox':
        case 'here':
            return missing(
                `Geocoding provider '${name}' has no adapter in this build. `
                + 'Implement it under core/geocoding/providers and register it in the factory.',
            );

        default:
            // Unknown even as a NAME — a typo in GEO_PROVIDER or GEO_PROVIDER_CHAIN.
            // Always fatal, even in the chain: silently skipping a misspelt provider
            // is how a deployment runs on its fallback believing it runs on its
            // primary. Same argument as `assertUploadScannerSafe`.
            throw createAppError(
                ERROR_CODES.CONFIG_INVALID_GEO_PROVIDER,
                500,
                `Unknown geocoding provider: ${String(name)}. Supported: ${GEO_PROVIDERS.join(', ')}`,
            );
    }
}

/**
 * Build the failover chain named by `GEO_PROVIDER_CHAIN`.
 *
 * Two rules, and both exist so a partly-configured deployment degrades instead of
 * refusing to boot:
 *
 *  - a provider with no credentials is skipped, with a warning naming the variable;
 *  - **`nominatim` is always appended** as the last resort, unless it is already in
 *    the chain. It is keyless, so it cannot be skipped, which means the chain can
 *    never come out empty and a deployment with no keys at all still resolves an
 *    address. The cost is Nominatim's ~1 rps usage policy, which is exactly why it
 *    is last rather than first.
 *
 * ⚠ A misspelt name is still fatal — see the `default` branch above.
 */
function buildChain(config: GeocodingConfig): IGeocodingProvider {
    const requested = config.chain && config.chain.length > 0
        ? [...config.chain]
        : (['geoapify', 'locationiq'] as GeoProviderName[]);

    if (!requested.includes('nominatim')) requested.push('nominatim');

    const built = requested
        .map(name => buildOne(name, config, { required: false }))
        .filter((p): p is IGeocodingProvider => p !== null);

    if (built.length === 0) {
        // Unreachable while nominatim is keyless and always appended, which is
        // the point — but a future edit could break that, and an empty chain
        // must say so rather than throwing an opaque error on the first lookup.
        throw createAppError(
            ERROR_CODES.GEO_PROVIDER_NOT_CONFIGURED,
            500,
            'GEO_PROVIDER is "chain" but no provider in GEO_PROVIDER_CHAIN could be built',
        );
    }

    console.log(`[Geocoding] chain: ${built.map(p => p.name).join(' → ')}`);
    return new ChainedGeocodingProvider(built);
}
