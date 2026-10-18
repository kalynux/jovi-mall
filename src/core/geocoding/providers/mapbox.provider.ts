import { createAppError } from '../../errors';
import { ERROR_CODES } from '../../error-codes';
import { recordIntegrationCall } from '../../../modules/system/domain/integration-observations';
import { IGeoAddressComponents } from '../../types/geo-address.types';
import { MapboxProviderConfig } from '../geocoding.config';
import {
    GeoCandidate,
    GeoSearchOptions,
    IGeocodingProvider,
} from '../geocoding-provider.interface';

/** One level of a v6 `context` — every level carries at least a name. */
interface MapboxContextLevel {
    mapbox_id?: string;
    name?: string;
}

/**
 * The parts of a Mapbox Geocoding v6 feature we consume. Like the other adapters,
 * we read only what maps onto a {@link GeoCandidate}, so a change in the rest
 * (match codes, translations, bbox) cannot break us.
 */
interface MapboxFeature {
    geometry?: { coordinates?: [number, number] };
    properties?: {
        mapbox_id?: string;
        feature_type?: string;
        name?: string;
        place_formatted?: string;
        full_address?: string;
        coordinates?: { longitude?: number; latitude?: number };
        context?: {
            address?: MapboxContextLevel & { street_name?: string };
            street?: MapboxContextLevel;
            neighborhood?: MapboxContextLevel;
            locality?: MapboxContextLevel;
            place?: MapboxContextLevel;
            district?: MapboxContextLevel;
            region?: MapboxContextLevel;
            postcode?: MapboxContextLevel;
            country?: MapboxContextLevel & { country_code?: string };
        };
    };
}

interface MapboxResponse {
    features?: MapboxFeature[];
}

/** v6 forward limits — a query past either is a 422 before Mapbox looks at it. */
const MAX_QUERY_CHARS = 256;
const MAX_QUERY_WORDS = 20;
/** v6 forward `limit` ceiling. */
const MAX_FORWARD_LIMIT = 10;

/**
 * The only feature types Mapbox may answer with (owner decision, 2026-10-18).
 *
 * ⚠ **Coarse answers are dropped so the chain can correct them.** The chain falls
 * through only on an EMPTY answer, and Mapbox is first. Its coverage of Cameroonian
 * streets is thin, so for "Boulevard de la Liberté, Akwa, Douala" it answered
 * "Douala, Littoral, Cameroon" — the city centroid — while LocationIQ, never asked,
 * had the exact street. A place / district / region / postcode / country answer
 * is therefore treated as "no match", and a customer who types only a city gets
 * one from the next provider instead.
 */
const SPECIFIC_FEATURE_TYPES: ReadonlySet<string> = new Set(['address', 'street', 'neighborhood', 'locality']);

/**
 * Mapbox adapter — Geocoding API **v6**, `https://api.mapbox.com/search/geocode/v6/{forward,reverse}`.
 *
 * The FIRST link of the default chain since 2026-10-18 (owner decision), ahead of
 * LocationIQ and Geoapify. Its failover semantics match theirs: a 429 and a 5xx /
 * timeout fail OVER, while a 401, a 403 and a 422 are `GEO_SEARCH_FAILED` and do
 * not — a rejected token or a refused account is a configuration fault an operator
 * must see, not something to paper over with the reserve (see `geocoding.chain.ts`).
 *
 * ⚠ **`permanent` is a LICENCE switch, not a feature flag.** Mapbox's terms forbid
 * caching or storing results obtained with `permanent=false` ("temporary"
 * geocoding, 100 000 free requests/month). This platform does both: the Redis
 * result cache sits in front of the whole chain, and the candidate a customer picks
 * is stored on the order and on their saved address. So the compliant setting is
 * `permanent=true` — billed from the first request, and refused by Mapbox unless the
 * account has a card on file. `GEO_MAPBOX_PERMANENT` defaults to true for that
 * reason, and `config/env.ts` warns when it is turned off.
 *
 * ⚠ **A query Mapbox's limits refuse is answered EMPTY, not as an error.** v6
 * rejects `q` over 256 characters or 20 words, and any `;`, with a 422. Sent as-is,
 * that 422 would be `GEO_SEARCH_FAILED`, which the chain deliberately does not fall
 * over on — so a long landmark-style address ("derrière la pharmacie…") that
 * LocationIQ resolves fine would fail outright the day Mapbox went first. Returning
 * `[]` says what is true ("this provider cannot answer that") and lets the chain
 * ask the next one.
 */
export class MapboxProvider implements IGeocodingProvider {
    readonly name = 'mapbox' as const;

    private readonly baseUrl: string;

    constructor(
        private readonly config: MapboxProviderConfig,
        private readonly requestTimeoutMs: number,
        private readonly defaultLimit: number,
        private readonly defaultCountryCodes: string[],
    ) {
        this.baseUrl = (config.baseUrl || 'https://api.mapbox.com/search/geocode/v6').replace(/\/$/, '');
    }

    async search(query: string, opts: GeoSearchOptions = {}): Promise<GeoCandidate[]> {
        // `;` is the v6 batch separator and refused in `q`; a comma means the same
        // thing to a person typing an address.
        const q = query.replace(/;/g, ',').trim();
        if (q.length === 0) return [];
        if (q.length > MAX_QUERY_CHARS || q.split(/\s+/).length > MAX_QUERY_WORDS) return [];

        const params = this.baseParams();
        params.set('q', q);
        params.set('limit', String(Math.min(opts.limit ?? this.defaultLimit, MAX_FORWARD_LIMIT)));
        // Asked of Mapbox rather than filtered afterwards, so the `limit` slots are
        // filled with street-level results instead of being spent on cities we drop.
        params.set('types', [...SPECIFIC_FEATURE_TYPES].join(','));

        const countryCodes = opts.countryCodes ?? this.defaultCountryCodes;
        if (countryCodes.length > 0) {
            params.set('country', countryCodes.map(c => c.toLowerCase()).join(','));
        }
        if (opts.language) params.set('language', opts.language);

        const body = await this.request(`/forward?${params.toString()}`);
        return (body?.features ?? [])
            .filter(f => this.isSpecific(f))
            .map(f => this.toCandidate(f))
            .filter((c): c is GeoCandidate => c !== null);
    }

    async reverse(lat: number, lng: number): Promise<GeoCandidate | null> {
        const params = this.baseParams();
        params.set('longitude', String(lng));
        params.set('latitude', String(lat));
        // limit defaults to 1, which is what we want: the most specific feature.
        // (A limit above 1 also requires exactly one `types`, so leave it alone.)

        // Filtered here rather than with `types`: reverse answers most-specific first,
        // so a coarse first feature means Mapbox has nothing finer for this point —
        // which is "no match", letting the chain ask the next provider.
        const body = await this.request(`/reverse?${params.toString()}`);
        const first = body?.features?.[0];
        return first && this.isSpecific(first) ? this.toCandidate(first) : null;
    }

    // ── internals ──────────────────────────────────────────────────────────────

    /** See {@link SPECIFIC_FEATURE_TYPES}. A feature with no type is not trusted. */
    private isSpecific(f: MapboxFeature): boolean {
        return SPECIFIC_FEATURE_TYPES.has(f.properties?.feature_type ?? '');
    }

    private baseParams(): URLSearchParams {
        return new URLSearchParams({
            access_token: this.config.apiKey,
            permanent: this.config.permanent ? 'true' : 'false',
        });
    }

    private async request(path: string): Promise<MapboxResponse | null> {
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

            // v6 signals "no match" with an empty FeatureCollection and a 200; a 404
            // means the request was malformed, so it is NOT treated as a miss here.
            if (response.status === 429) {
                throw createAppError(
                    ERROR_CODES.GEO_PROVIDER_RATE_LIMITED,
                    429,
                    "Geocoding provider 'mapbox' is rate limited or out of quota",
                );
            }
            if (response.status >= 500) {
                throw createAppError(
                    ERROR_CODES.GEO_PROVIDER_UNAVAILABLE,
                    503,
                    `Geocoding provider 'mapbox' responded with HTTP ${response.status}`,
                );
            }
            if (!response.ok) {
                // 401 bad token · 403 account refused (e.g. permanent=true with no
                // card on file) · 422 bad parameter. All configuration or caller
                // faults — surfaced, never failed over.
                throw createAppError(
                    ERROR_CODES.GEO_SEARCH_FAILED,
                    502,
                    `Geocoding provider 'mapbox' responded with HTTP ${response.status}`,
                );
            }
            return (await response.json()) as MapboxResponse;
        } catch (err) {
            observedError = err;
            if (err && typeof err === 'object' && 'code' in err) throw err;
            throw createAppError(
                ERROR_CODES.GEO_PROVIDER_UNAVAILABLE,
                503,
                "Geocoding provider 'mapbox' is unreachable",
                { cause: err instanceof Error ? err.message : String(err) },
            );
        } finally {
            clearTimeout(timer);
            recordIntegrationCall('geocoding', observedAt, observedError);
        }
    }

    private toCandidate(f: MapboxFeature): GeoCandidate | null {
        const p = f.properties ?? {};
        const lon = p.coordinates?.longitude ?? f.geometry?.coordinates?.[0];
        const lat = p.coordinates?.latitude ?? f.geometry?.coordinates?.[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

        const ctx = p.context ?? {};
        // A feature of a given level is not guaranteed to repeat itself in its own
        // context, so its own `name` is the fallback for its level.
        const own = (type: string): string | null => (p.feature_type === type ? p.name ?? null : null);

        const components: IGeoAddressComponents = {
            street: ctx.street?.name ?? ctx.address?.street_name ?? own('street'),
            neighbourhood: ctx.neighborhood?.name ?? ctx.locality?.name
                ?? own('neighborhood') ?? own('locality'),
            city: ctx.place?.name ?? own('place') ?? ctx.district?.name ?? null,
            region: ctx.region?.name ?? own('region'),
            country: ctx.country?.name ?? own('country'),
            country_code: ctx.country?.country_code ? ctx.country.country_code.toUpperCase() : null,
            postal_code: ctx.postcode?.name ?? own('postcode'),
        };

        const formatted = p.full_address
            ?? [p.name, p.place_formatted].filter((s): s is string => !!s && s.length > 0).join(', ');

        return {
            formatted_address: formatted,
            coordinates: { type: 'Point', coordinates: [lon as number, lat as number] },
            provider: 'mapbox',
            provider_place_id: p.mapbox_id ?? null,
            components,
        };
    }
}
