import { createAppError } from '../../errors';
import { ERROR_CODES } from '../../error-codes';
import { recordIntegrationCall } from '../../../modules/system/domain/integration-observations';
import { IGeoAddressComponents } from '../../types/geo-address.types';
import { ApiKeyProviderConfig } from '../geocoding.config';
import {
    GeoCandidate,
    GeoSearchOptions,
    IGeocodingProvider,
} from '../geocoding-provider.interface';

/**
 * The parts of a Geoapify GeoJSON feature we consume. Geoapify returns a great
 * deal more (confidence ranks, timezone, datasource); we read only what maps
 * onto a {@link GeoCandidate}, so a change in the rest cannot break us.
 */
interface GeoapifyFeature {
    properties?: {
        lat?: number;
        lon?: number;
        formatted?: string;
        street?: string;
        suburb?: string;
        district?: string;
        city?: string;
        town?: string;
        village?: string;
        county?: string;
        state?: string;
        region?: string;
        country?: string;
        country_code?: string;
        postcode?: string;
        place_id?: string;
    };
}

interface GeoapifyResponse {
    features?: GeoapifyFeature[];
}

/**
 * Geoapify adapter — `https://api.geoapify.com/v1/geocode/{search,reverse}`.
 *
 * One of the two paid providers behind {@link ChainedGeocodingProvider}. Free tier
 * at the time of writing: **3 000 credits/day, 5 requests/second, no credit card**,
 * and Geoapify describe their limits as *soft* — they contact you about an upgrade
 * rather than cutting you off. That is the opposite posture to LocationIQ's, which
 * is why the two are worth having together and why Geoapify is the chain's default
 * FIRST hop: the provider that degrades gracefully should absorb the normal load,
 * and the one that refuses hard should be the reserve.
 *
 * ── What makes this adapter fail OVER rather than fail ──────────────────────
 *
 * `GEO_PROVIDER_RATE_LIMITED` (429) and `GEO_PROVIDER_UNAVAILABLE` (5xx, timeout,
 * network) are the two codes the chain treats as "ask the next one". Everything
 * else — a 400 from a malformed query, an unparseable body — is `GEO_SEARCH_FAILED`
 * and is NOT retried elsewhere, because a query the caller got wrong will be just
 * as wrong at the next provider and retrying it only spends the reserve's quota.
 *
 * ⚠ A 401 is deliberately **not** a failover: a rejected key is a configuration
 * fault an operator must see, and quietly serving from the other provider is how
 * a deployment runs for months on half its capacity without anybody noticing.
 */
export class GeoapifyProvider implements IGeocodingProvider {
    readonly name = 'geoapify' as const;

    private readonly baseUrl: string;

    constructor(
        private readonly config: ApiKeyProviderConfig,
        private readonly requestTimeoutMs: number,
        private readonly defaultLimit: number,
        private readonly defaultCountryCodes: string[],
    ) {
        this.baseUrl = (config.baseUrl || 'https://api.geoapify.com/v1/geocode').replace(/\/$/, '');
    }

    async search(query: string, opts: GeoSearchOptions = {}): Promise<GeoCandidate[]> {
        const params = new URLSearchParams({
            text: query,
            format: 'geojson',
            limit: String(opts.limit ?? this.defaultLimit),
            apiKey: this.config.apiKey,
        });

        const countryCodes = opts.countryCodes ?? this.defaultCountryCodes;
        if (countryCodes.length > 0) {
            // Geoapify's filter syntax is a single `countrycode:` list, not repeated params.
            params.set('filter', `countrycode:${countryCodes.map(c => c.toLowerCase()).join(',')}`);
        }
        if (opts.language) params.set('lang', opts.language);

        const body = await this.request<GeoapifyResponse>(`/search?${params.toString()}`);
        return (body?.features ?? [])
            .map(f => this.toCandidate(f))
            .filter((c): c is GeoCandidate => c !== null);
    }

    async reverse(lat: number, lng: number): Promise<GeoCandidate | null> {
        const params = new URLSearchParams({
            lat: String(lat),
            lon: String(lng),
            format: 'geojson',
            apiKey: this.config.apiKey,
        });

        const body = await this.request<GeoapifyResponse>(`/reverse?${params.toString()}`);
        const first = body?.features?.[0];
        // A point with no match comes back as an empty FeatureCollection, not a 404.
        return first ? this.toCandidate(first) : null;
    }

    // ── internals ──────────────────────────────────────────────────────────────

    private async request<T>(path: string): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        const observedAt = Date.now();
        let observedError: unknown;

        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });

            if (response.status === 429) {
                throw createAppError(
                    ERROR_CODES.GEO_PROVIDER_RATE_LIMITED,
                    429,
                    "Geocoding provider 'geoapify' is rate limited or out of quota",
                );
            }
            if (response.status >= 500) {
                throw createAppError(
                    ERROR_CODES.GEO_PROVIDER_UNAVAILABLE,
                    503,
                    `Geocoding provider 'geoapify' responded with HTTP ${response.status}`,
                );
            }
            if (!response.ok) {
                throw createAppError(
                    ERROR_CODES.GEO_SEARCH_FAILED,
                    502,
                    `Geocoding provider 'geoapify' responded with HTTP ${response.status}`,
                );
            }
            return (await response.json()) as T;
        } catch (err) {
            observedError = err;
            if (err && typeof err === 'object' && 'code' in err) throw err;
            throw createAppError(
                ERROR_CODES.GEO_PROVIDER_UNAVAILABLE,
                503,
                "Geocoding provider 'geoapify' is unreachable",
                { cause: err instanceof Error ? err.message : String(err) },
            );
        } finally {
            clearTimeout(timer);
            recordIntegrationCall('geocoding', observedAt, observedError);
        }
    }

    private toCandidate(f: GeoapifyFeature): GeoCandidate | null {
        const p = f.properties ?? {};
        const lat = Number(p.lat);
        const lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        const components: IGeoAddressComponents = {
            street: p.street ?? null,
            neighbourhood: p.suburb ?? p.district ?? null,
            city: p.city ?? p.town ?? p.village ?? null,
            region: p.state ?? p.region ?? p.county ?? null,
            country: p.country ?? null,
            country_code: p.country_code ? p.country_code.toUpperCase() : null,
            postal_code: p.postcode ?? null,
        };

        return {
            formatted_address: p.formatted ?? '',
            coordinates: { type: 'Point', coordinates: [lon, lat] },
            provider: 'geoapify',
            provider_place_id: p.place_id ?? null,
            components,
        };
    }
}
