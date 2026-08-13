import { createAppError } from '../../errors';
import { ERROR_CODES } from '../../error-codes';
import { recordIntegrationCall } from '../../../modules/system/domain/integration-observations';
import { IGeoAddressComponents } from '../../types/geo-address.types';
import { NominatimConfig } from '../geocoding.config';
import {
    GeoCandidate,
    GeoSearchOptions,
    IGeocodingProvider,
} from '../geocoding-provider.interface';

/**
 * Shape of the parts of a Nominatim `jsonv2` result we consume. Nominatim returns
 * many more fields; we read only what maps onto a {@link GeoCandidate}.
 */
interface NominatimResult {
    place_id?: number;
    osm_type?: string;
    osm_id?: number;
    lat?: string;
    lon?: string;
    display_name?: string;
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
 * OpenStreetMap Nominatim adapter — the default, keyless geocoding provider.
 *
 * Notes:
 *  - Sends the mandatory `User-Agent` (usage policy); a missing/generic UA is
 *    grounds for a block on the public endpoint.
 *  - Uses `format=jsonv2` + `addressdetails=1` to get the structured `address`.
 *  - Timeouts and network failures surface as GEO_PROVIDER_UNAVAILABLE; a non-2xx
 *    or unparseable body as GEO_SEARCH_FAILED — so the caller can fail soft and
 *    keep the (non-geo) critical path working.
 */
export class NominatimProvider implements IGeocodingProvider {
    readonly name = 'nominatim' as const;

    constructor(
        private readonly config: NominatimConfig,
        private readonly requestTimeoutMs: number,
        private readonly defaultLimit: number,
        private readonly defaultCountryCodes: string[],
    ) {}

    async search(query: string, opts: GeoSearchOptions = {}): Promise<GeoCandidate[]> {
        const params = new URLSearchParams({
            q: query,
            format: 'jsonv2',
            addressdetails: '1',
            limit: String(opts.limit ?? this.defaultLimit),
        });

        const countryCodes = opts.countryCodes ?? this.defaultCountryCodes;
        if (countryCodes.length > 0) {
            params.set('countrycodes', countryCodes.map(c => c.toLowerCase()).join(','));
        }
        if (opts.language) params.set('accept-language', opts.language);
        if (this.config.email) params.set('email', this.config.email);

        const body = await this.request<NominatimResult[]>(`/search?${params.toString()}`, opts.language);
        if (!Array.isArray(body)) return [];
        return body.map(r => this.toCandidate(r)).filter((c): c is GeoCandidate => c !== null);
    }

    async reverse(lat: number, lng: number): Promise<GeoCandidate | null> {
        const params = new URLSearchParams({
            lat: String(lat),
            lon: String(lng),
            format: 'jsonv2',
            addressdetails: '1',
        });
        if (this.config.email) params.set('email', this.config.email);

        const body = await this.request<NominatimResult>(`/reverse?${params.toString()}`);
        // Nominatim returns `{ error: ... }` (not a 4xx) when a point has no match.
        if (!body || (body as { error?: unknown }).error) return null;
        return this.toCandidate(body);
    }

    // ── internals ──────────────────────────────────────────────────────────────

    private async request<T>(path: string, language?: string): Promise<T> {
        const url = `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        // Reported to the operations surface, which cannot probe this provider: Nominatim's
        // usage policy is roughly one request per second with bans for abuse, so an operator
        // opening a dashboard must not spend that budget. Real traffic already knows the
        // answer — `/system/integrations` reports what this call learns.
        const observedAt = Date.now();
        let observedError: unknown;

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'User-Agent': this.config.userAgent,
                    Accept: 'application/json',
                    ...(language ? { 'Accept-Language': language } : {}),
                },
                signal: controller.signal,
            });

            if (!response.ok) {
                throw createAppError(
                    ERROR_CODES.GEO_SEARCH_FAILED,
                    502,
                    `Geocoding provider 'nominatim' responded with HTTP ${response.status}`,
                );
            }
            return (await response.json()) as T;
        } catch (err) {
            observedError = err;
            // Re-throw AppErrors (e.g. the non-2xx above) untouched.
            if (err && typeof err === 'object' && 'code' in err) throw err;
            // Timeout (AbortError) or network failure → provider unavailable.
            throw createAppError(
                ERROR_CODES.GEO_PROVIDER_UNAVAILABLE,
                503,
                "Geocoding provider 'nominatim' is unreachable",
                { cause: err instanceof Error ? err.message : String(err) },
            );
        } finally {
            clearTimeout(timer);
            recordIntegrationCall('geocoding', observedAt, observedError);
        }
    }

    private toCandidate(r: NominatimResult): GeoCandidate | null {
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
            provider: 'nominatim',
            provider_place_id: placeId,
            components,
        };
    }
}
