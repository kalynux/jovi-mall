import { createAppError } from '../errors';
import { ERROR_CODES } from '../error-codes';
import { GeoProviderName } from '../types/geo-address.types';
import {
    GeoCandidate,
    GeoSearchOptions,
    IGeocodingProvider,
} from './geocoding-provider.interface';

/**
 * The error codes that mean "this provider could not answer — ask the next one".
 *
 * Deliberately a CLOSED list, and deliberately short. Everything not named here
 * is an answer, a caller mistake or a configuration fault, and none of those get
 * better by asking somebody else:
 *
 *  - `GEO_SEARCH_FAILED` (a 400 from a malformed query, an unparseable body) —
 *    the same query will be just as wrong at the next provider, and retrying it
 *    spends the reserve's quota to reproduce the failure.
 *  - a **401** — a rejected key is a configuration fault an operator must see.
 *    Quietly serving from the other provider is exactly how a deployment runs for
 *    months on half its capacity with nobody aware. It surfaces as
 *    `GEO_SEARCH_FAILED`, so it is covered by the rule above rather than needing
 *    its own.
 */
const FAILOVER_CODES: ReadonlySet<string> = new Set([
    ERROR_CODES.GEO_PROVIDER_RATE_LIMITED,
    ERROR_CODES.GEO_PROVIDER_UNAVAILABLE,
]);

function isFailover(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    return typeof code === 'string' && FAILOVER_CODES.has(code);
}

/**
 * ChainedGeocodingProvider — several providers, tried in order, first useful
 * answer wins.
 *
 * ── What it is for ───────────────────────────────────────────────────────────
 *
 * Every candidate provider has a free tier measured in a few thousand calls a
 * day, and address search at checkout is the kind of traffic that spends one.
 * Rather than pick a single provider and be down when its quota runs out, the
 * chain **adds their allowances together**: Geoapify's 3 000/day at 5 rps in
 * front, LocationIQ's 5 000/day at 2 rps behind it, and keyless Nominatim as the
 * last resort so a deployment with no keys at all still resolves an address.
 *
 * ── The two things it falls over ON, and the one it does not ─────────────────
 *
 * 1. **A failover ERROR** — `GEO_PROVIDER_RATE_LIMITED` (429: out of quota, over
 *    the per-second cap) or `GEO_PROVIDER_UNAVAILABLE` (5xx, timeout, DNS). This
 *    is the "reached my limit" and the "one is down" case.
 * 2. **An EMPTY result.** A provider that answers "no match" has answered, but it
 *    has not been *useful*, and coverage genuinely differs between providers on
 *    Cameroonian addresses — a street one has mapped and the other has not is the
 *    ordinary case, not the exotic one. So an empty search or a null reverse also
 *    moves to the next provider, and the chain returns empty only when EVERY
 *    provider has been asked. This is the "not available on one, check the other;
 *    if none have it, return nothing" behaviour.
 *
 * It does **not** fall over on a `GEO_SEARCH_FAILED` — see {@link FAILOVER_CODES}.
 *
 * ── What it costs, stated plainly ────────────────────────────────────────────
 *
 * Failing over on an empty result means a genuinely unmatchable address costs one
 * call at EVERY provider instead of one. That is the deliberate trade: an address
 * nobody can resolve is rare, and a customer who cannot find their own street is
 * a lost order. The negative cache (`GEO_CACHE_NEGATIVE_TTL_SECONDS`) is what
 * stops the same unmatchable query paying that price twice, and the chain sits
 * INSIDE the cache decorator so a cached miss never reaches any provider at all.
 *
 * ── What it must never do ────────────────────────────────────────────────────
 *
 * ⚠ **`name` reports the FIRST provider, but every candidate reports the provider
 * that actually resolved it.** The chain is not a provider in the domain sense —
 * there is no `'chain'` in {@link GeoProviderName}, deliberately, because that
 * value is persisted on every stored `GeoAddress.provider` and a row saying
 * "chain" would record which *mechanism* answered instead of which *service*,
 * making `provider_place_id` unresolvable forever. Candidates are passed through
 * untouched; nothing here rewrites `provider`.
 *
 * The last error is re-thrown when every provider fails, so a total outage still
 * surfaces as an error rather than as an empty result — "nobody could be asked"
 * and "everybody said no" are different answers and the caller must be able to
 * tell them apart.
 */
export class ChainedGeocodingProvider implements IGeocodingProvider {
    constructor(private readonly providers: IGeocodingProvider[]) {
        if (providers.length === 0) {
            // A construction-time programming error rather than a runtime fault,
            // but it still goes through createAppError: the ESLint ban on
            // `throw new Error()` is absolute here precisely so no path can
            // produce an error the global handler cannot normalise.
            throw createAppError(
                ERROR_CODES.GEO_PROVIDER_NOT_CONFIGURED,
                500,
                'ChainedGeocodingProvider requires at least one provider',
            );
        }
    }

    /**
     * The first provider's name. Used only for logging and
     * `getGeocodingProviderType()`; it never reaches a stored `GeoAddress`,
     * because candidates carry their own resolver's name.
     */
    get name(): GeoProviderName {
        return this.providers[0].name;
    }

    /** The chain, in order — for the operations surface and for tests. */
    get chain(): GeoProviderName[] {
        return this.providers.map(p => p.name);
    }

    async search(query: string, opts?: GeoSearchOptions): Promise<GeoCandidate[]> {
        let lastError: unknown;
        let anyProviderAnswered = false;

        for (const provider of this.providers) {
            try {
                const results = await provider.search(query, opts);
                anyProviderAnswered = true;
                if (results.length > 0) return results;
                // Answered, but not usefully — try the next one's coverage.
            } catch (error) {
                if (!isFailover(error)) throw error;
                lastError = error;
                console.warn(
                    `[Geocoding] '${provider.name}' failed over on search:`,
                    (error as { code?: string }).code,
                );
            }
        }

        // ⚠ "Nobody could be asked" and "everybody said no" are different answers
        // and the caller must be able to tell them apart. An empty array claims
        // the address does not exist; only return it if somebody actually looked.
        // One provider 429ing while the next honestly finds nothing is a MISS.
        if (!anyProviderAnswered && lastError) throw lastError;
        return [];
    }

    async reverse(lat: number, lng: number): Promise<GeoCandidate | null> {
        let lastError: unknown;
        let anyProviderAnswered = false;

        for (const provider of this.providers) {
            try {
                const result = await provider.reverse(lat, lng);
                anyProviderAnswered = true;
                if (result) return result;
            } catch (error) {
                if (!isFailover(error)) throw error;
                lastError = error;
                console.warn(
                    `[Geocoding] '${provider.name}' failed over on reverse:`,
                    (error as { code?: string }).code,
                );
            }
        }

        if (!anyProviderAnswered && lastError) throw lastError;
        return null;
    }
}
