import { createAppError } from '../errors';
import { ERROR_CODES } from '../error-codes';
import { GEO_PROVIDERS } from '../types/geo-address.types';
import { GeocodingConfig } from './geocoding.config';
import { IGeocodingProvider } from './geocoding-provider.interface';
import { NominatimProvider } from './providers/nominatim.provider';

/**
 * Geocoding Provider Factory
 *
 * The ONLY place where geocoding provider selection happens (mirrors
 * `core/storage/storage.factory.ts`). Providers that are named in
 * {@link GEO_PROVIDERS} but have no adapter in this build throw a clear
 * GEO_PROVIDER_NOT_CONFIGURED so the missing seam is obvious; an entirely
 * unknown provider string throws CONFIG_INVALID_GEO_PROVIDER.
 */
export function createGeocodingProvider(config: GeocodingConfig): IGeocodingProvider {
    const { provider } = config;

    switch (provider) {
        case 'nominatim':
            if (!config.nominatim) {
                throw createAppError(
                    ERROR_CODES.GEO_PROVIDER_NOT_CONFIGURED,
                    500,
                    "Nominatim configuration is required when GEO_PROVIDER is 'nominatim'",
                );
            }
            return new NominatimProvider(
                config.nominatim,
                config.requestTimeoutMs,
                config.defaultLimit,
                config.defaultCountryCodes,
            );

        // Adapters not implemented in this build. The abstraction is ready — drop
        // in a provider class + config block and add a case here.
        case 'google':
        case 'mapbox':
        case 'here':
        case 'geoapify':
            throw createAppError(
                ERROR_CODES.GEO_PROVIDER_NOT_CONFIGURED,
                500,
                `Geocoding provider '${provider}' has no adapter in this build. ` +
                    `Implement it under core/geocoding/providers and register it in the factory.`,
            );

        default:
            throw createAppError(
                ERROR_CODES.CONFIG_INVALID_GEO_PROVIDER,
                500,
                `Unknown geocoding provider: ${String(provider)}. Supported: ${GEO_PROVIDERS.join(', ')}`,
            );
    }
}
