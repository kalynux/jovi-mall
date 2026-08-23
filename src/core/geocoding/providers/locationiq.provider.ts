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
 * The parts of a LocationIQ result we consume. Its response is Nominatim-shaped —
 * LocationIQ is an OSM/Nominatim service — so the `address` sub-object carries the
 * same generous set of alternative keys, and this adapter reads them the same way
 * `NominatimProvider` does.
 */
interface LocationIqResult {
    place_id?: string | number;
    osm_type?: string;
    osm_id?: string | number;
    lat?: string;
    lon?: string;
    display_name?: string;
    error?: string;
    address?: {
        road?: string;
        pedestrian?: string;
        neighbourhood?: string;
        suburb?: string;
        quarter?: string;
        city?: string;
        town?: string;
        village?: string;
        municipality?: string;
        state?: string;
        region?: string;
        county?: string;
        country?: string;
        country_code?: string;
        postcode?: string;
    };
}

/**
 * LocationIQ adapter — `https://{region}.locationiq.com/v1/{search,reverse}`.
 *
 * The second of the two paid providers behind {@link ChainedGeocodingProvider}.
 * Free tier at the time of writing: **5 000 requests/day but only 2 requests per
 * second**, and — the part that shapes the chain — its limits are **hard**. There
 * is no soft buffer on the free plan: exceed the per-second, per-minute or per-day
 * allowance and it answers `429` immediately.
 *
 * That is why it sits SECOND by default. Its daily allowance is the larger of the
 * two, so it is the better reserve; its burst ceiling is the smaller, so it is the
 * worse front line. Putting it first would trip 429s on ordinary autocomplete
 * typing — three keystrokes in a second is over the limit.
 *
 * ⚠ **The region host is configuration, not a constant.** `us1` and `eu1` are
 * separate hosts serving the same API; `GEO_LOCATIONIQ_BASE_URL` selects one.
 * `eu1` is the shorter round trip from Cameroon and is the default here.
 *
 * Its failover semantics match Geoapify's exactly — see that adapter's header for
 * why a 429 and a 5xx fail OVER while a 400 and a 401 do not.
 */
export class LocationIqProvider implements IGeocodingProvider {
    readonly name = 'locationiq' as const;

    private readonly baseUrl: string;

    constructor(
        private readonly config: ApiKeyProviderConfig,
        private readonly requestTimeoutMs: number,
        private readonly defaultLimit: number,
        private readonly defaultCountryCodes: string[],
    ) {
        this.baseUrl = (config.baseUrl || 'https://eu1.locationiq.com/v1').replace(/\/$/, '');
    }

    async search(query: string, opts: GeoSearchOptions = {}): Promise<GeoCandidate[]> {
        const params = new URLSearchParams({
            key: this.config.apiKey,
            q: query,
            format: 'json',
            addressdetails: '1',
            // Without this the `address` keys vary by place type, which is exactly
            // the drift `toCandidate` would otherwise have to guess around.
            normalizeaddress: '1',
            limit: String(opts.limit ?? this.defaultLimit),
        });

        const countryCodes = opts.countryCodes ?? this.defaultCountryCodes;
        if (countryCodes.length > 0) {
            params.set('countrycodes', countryCodes.map(c => c.toLowerCase()).join(','));
        }
        if (opts.language) params.set('accept-language', opts.language);

        const body = await this.request<LocationIqResult[] | LocationIqResult>(`/search?${params.toString()}`);
        // A no-match search answers `{ error: 'Unable to geocode' }` with a 404,
        // which `request` has already turned into an empty result.
        if (!Array.isArray(body)) return [];
        return body.map(r => this.toCandidate(r)).filter((c): c is GeoCandidate => c !== null);
    }

    async reverse(lat: number, lng: number): Promise<GeoCandidate | null> {
        const params = new URLSearchParams({
            key: this.config.apiKey,
            lat: String(lat),
            lon: String(lng),
            format: 'json',
            addressdetails: '1',
            normalizeaddress: '1',
        });

        const body = await this.request<LocationIqResult>(`/reverse?${params.toString()}`);
        if (!body || body.error) return null;
        return this.toCandidate(body);
    }

    // ── internals ──────────────────────────────────────────────────────────────

    private async request<T>(path: string): Promise<T | null> {
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

            // ⚠ 404 is LocationIQ's NO MATCH, not an error. Treating it as one would
            // send every unmatched address down the chain to spend the other
            // provider's quota discovering the same nothing.
            if (response.status === 404) return null;

            if (response.status === 429) {
                throw createAppError(
                    ERROR_CODES.GEO_PROVIDER_RATE_LIMITED,
                    429,
                    "Geocoding provider 'locationiq' is rate limited or out of quota",
                );
            }
            if (response.status >= 500) {
                throw createAppError(
                    ERROR_CODES.GEO_PROVIDER_UNAVAILABLE,
                    503,
                    `Geocoding provider 'locationiq' responded with HTTP ${response.status}`,
                );
            }
            if (!response.ok) {
                throw createAppError(
                    ERROR_CODES.GEO_SEARCH_FAILED,
                    502,
                    `Geocoding provider 'locationiq' responded with HTTP ${response.status}`,
                );
            }
            return (await response.json()) as T;
        } catch (err) {
            observedError = err;
            if (err && typeof err === 'object' && 'code' in err) throw err;
            throw createAppError(
                ERROR_CODES.GEO_PROVIDER_UNAVAILABLE,
                503,
                "Geocoding provider 'locationiq' is unreachable",
                { cause: err instanceof Error ? err.message : String(err) },
            );
        } finally {
            clearTimeout(timer);
            recordIntegrationCall('geocoding', observedAt, observedError);
        }
    }

    private toCandidate(r: LocationIqResult): GeoCandidate | null {
        const lat = r.lat != null ? Number(r.lat) : NaN;
        const lon = r.lon != null ? Number(r.lon) : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        const a = r.address ?? {};
        const components: IGeoAddressComponents = {
            street: a.road ?? a.pedestrian ?? null,
            neighbourhood: a.neighbourhood ?? a.suburb ?? a.quarter ?? null,
            city: a.city ?? a.town ?? a.village ?? a.municipality ?? null,
            region: a.state ?? a.region ?? a.county ?? null,
            country: a.country ?? null,
            country_code: a.country_code ? a.country_code.toUpperCase() : null,
            postal_code: a.postcode ?? null,
        };

        const placeId = r.osm_type && r.osm_id != null
            ? `${r.osm_type}:${r.osm_id}`
            : r.place_id != null
                ? String(r.place_id)
                : null;

        return {
            formatted_address: r.display_name ?? '',
            coordinates: { type: 'Point', coordinates: [lon, lat] },
            provider: 'locationiq',
            provider_place_id: placeId,
            components,
        };
    }
}
