import { createHash } from 'crypto';
import { getRedisClient, CACHE_DB } from '../../infra/redis/redis.factory';
import { geocodingCacheEventsTotal } from '../../modules/system/metrics/metrics';
import {
    GeoCandidate,
    GeoSearchOptions,
    IGeocodingProvider,
} from './geocoding-provider.interface';

/**
 * The geocoding result cache — ADR-A04 D-1, "cache it before you rent it".
 *
 * A **decorator** over `IGeocodingProvider`, not a layer inside one. That shape is what keeps
 * ADR-A04's cheapest promise true: the paid adapter, when it is built, inherits the cache by
 * construction and its author does not have to remember anything. It also keeps the rule the
 * interface's own header states — *no business logic branches on the provider* — because this
 * class does not know or care which provider it wraps, and forwards `name` from the one it does.
 *
 * ── Why a cache at all, when the call sites are auth-gated ───────────────────
 * ADR-A04 corrects the framing: no anonymous storefront traffic reaches the provider, so the
 * exposure is bounded by signed-in address entry rather than browse volume. What it does not
 * bound is the *shape* of that traffic. Address strings repeat heavily in this domain — a
 * handful of neighbourhoods carry most of a city's orders, and every customer typing the same
 * street produces the same query — and Nominatim's public instance permits roughly one request
 * per second with bans for abuse. One person filling in a checkout address emits a request per
 * keystroke-batch; ten of them at once is the whole budget.
 *
 * ── It FAILS OPEN, and that is not negotiable ────────────────────────────────
 * Every Redis interaction here is wrapped, bounded and swallowed. A Redis outage degrades to
 * direct provider calls — never to a failed address search, and never to a slow one. Same
 * argument as `api/rate-limit/fail-open-store.ts` and `core/jobs/worker-lock.ts`: a cache that
 * is down must not become a single point of failure in front of the thing it was added to help.
 *
 * ⚠ **The timeout is what makes "fails open" true rather than merely intended**, and this is
 * the lesson `worker-lock.ts` paid for: a dead Redis host does **not** reject promptly. node-redis
 * retries the initial connect on a backoff, so `getRedisClient` can sit unresolved for minutes
 * and the `catch` never runs — the address search would park on connect and the customer would
 * watch a spinner. Bounded, the same outage costs 250 ms and a provider call.
 */

/** The closed label set on `geocoding_cache_events_total`. See that counter's header. */
type CacheEvent = 'hit' | 'miss' | 'store' | 'bypass' | 'error';

function record(event: CacheEvent): void {
    try {
        geocodingCacheEventsTotal.inc({ event });
    } catch {
        /* metrics never break the path they observe */
    }
}

/**
 * Key version. Bump it when the SHAPE **or the CONTENT RULES** of a cached value change.
 *
 * Cheaper and safer than a migration: the old keys become unreadable, expire on their own TTL,
 * and nothing has to parse two shapes. It is in the key rather than only in the value because a
 * value-side version check still costs the round trip and the JSON parse.
 *
 * ── v1 → v2, 2026-08-26: the entity decoder ─────────────────────────────────
 * `SanitizedGeocodingProvider` now decodes the HTML entities providers emit
 * (`d&apos;AKWA` → `d'AKWA`), and it sits INSIDE this cache — so everything written from
 * now on is already decoded. **Everything written BEFORE it was not**, and those entries
 * live for `GEO_CACHE_TTL_SECONDS` (24 hours by default). Without a bump, a deploy would
 * fix the defect for uncached addresses and go on serving the broken string for a day for
 * exactly the popular ones — which is the worst possible distribution, because the popular
 * addresses are the ones customers are looking at.
 *
 * ⚠ **The shape did not change here, only the content**, and that is precisely why this
 * needed saying out loud: a reader applying the old rule literally would have left the
 * version alone and shipped a fix that appeared not to work. The bump costs one cold cache.
 */
const KEY_VERSION = 'v2';

/** Hard ceiling on any single Redis call. See the header — this is the fail-open guarantee. */
const REDIS_OP_TIMEOUT_MS = 250;

/**
 * After a Redis failure, stop trying for this long.
 *
 * Without it every address keystroke attempts a fresh connection while Redis is down —
 * `getRedisClient` only caches a client it managed to connect — and each one pays the timeout
 * above. Failing open should be quiet AND fast; this is the second half.
 */
const REDIS_BACKOFF_MS = 30_000;

/** Resolved rather than thrown, so no call site needs an error path for "Redis was slow". */
const TIMED_OUT = Symbol('geocoding-cache-redis-timeout');

function withTimeout<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), REDIS_OP_TIMEOUT_MS);
        timer.unref();
    });
    // The loser keeps running. Swallow its settlement so a late rejection is not an unhandled one.
    void work.catch(() => undefined);
    return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

export interface GeocodingCacheOptions {
    /** Seconds a result is kept. */
    ttlSeconds: number;
    /**
     * Seconds an EMPTY answer is kept — deliberately shorter than a positive one.
     *
     * "No match" is the answer to a half-typed address and to a real gap in OpenStreetMap's
     * coverage, and the two are indistinguishable from here. Caching it at the full TTL would
     * make a newly-mapped street unfindable for a day; not caching it at all leaves the cheapest
     * and most repeated query — a typo, retried — going to the provider every time.
     */
    negativeTtlSeconds: number;
    /**
     * Decimal places a reverse-geocode coordinate is rounded to before it becomes a key.
     *
     * A GPS fix never repeats exactly, so an unrounded key would have a hit rate of zero while
     * looking implemented — the failure mode this whole file exists to avoid elsewhere. Four
     * decimals is ~11 m at the equator: the same building, and a different building is a
     * different key. ADR-A04 D-1 asks for "coarser precision" and this is that number.
     */
    reversePrecision: number;
}

/**
 * Normalise a query into something two people typing the same address share.
 *
 * Case, surrounding space, runs of internal space, and Unicode composition — a string typed on
 * macOS and one typed on Windows can be byte-different and visually identical, which would halve
 * the hit rate invisibly. Deliberately NOT stripped: accents (`Extrême-Nord` is not
 * `Extreme-Nord` to a geocoder and the results genuinely differ) and punctuation (a comma
 * separates address components and the provider reads it).
 *
 * Exported because `test:geocoding-cache` asserts it directly — the property "same address,
 * different spacing and case, one key" is the whole point of the cache and is worth pinning
 * without going through Redis.
 */
export function normalizeGeoQuery(query: string): string {
    return query.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Round a coordinate to the configured precision, so a moving fix still hits one key.
 *
 * `toFixed` rather than a multiply/round/divide, because the latter reintroduces float noise at
 * exactly the digit being rounded to. The `+ 0` is not decoration: `(-0.00001).toFixed(4)` is
 * `"-0.0000"` while `(0).toFixed(4)` is `"0.0000"`, so a point a centimetre either side of the
 * equator or the prime meridian would produce two keys for one place. Round-tripping through
 * `Number` collapses `-0` to `0` — the one input where `toFixed` alone is not canonical.
 */
export function quantizeCoordinate(value: number, precision: number): string {
    return (Number(value.toFixed(precision)) + 0).toFixed(precision);
}

/**
 * The forward-search key.
 *
 * Hashed rather than embedded, for two reasons that both matter: a Redis key is unbounded user
 * input otherwise, and `GET /api/internal/admin/system/cache/keys` LISTS key names — an address
 * somebody typed is personal data, and it would be sitting in an operator's browser. That
 * endpoint offers no value read, so the hash is where the address stops.
 *
 * ── `limit` is in the key, and the ADR does not mention it ───────────────────
 * ADR-A04 D-1 names query + country bias + language. `limit` is added because serving a cached
 * 3-item list to a request that asked for 10 silently truncates the answer, and the caller
 * cannot tell that from "the provider only found three". Fragmentation is the cost, and it is
 * small: `GEO_DEFAULT_LIMIT` answers almost every real request.
 */
export function buildSearchKey(
    query: string,
    countryCodes: readonly string[],
    language: string | undefined,
    limit: number | undefined,
): string {
    const parts = [
        normalizeGeoQuery(query),
        [...countryCodes].map((c) => c.toLowerCase()).sort().join(','),
        (language ?? '').toLowerCase(),
        String(limit ?? ''),
    ].join('\u0000');
    return `geo:s:${KEY_VERSION}:${createHash('sha256').update(parts).digest('hex').slice(0, 32)}`;
}

/** The reverse key. Coordinates are already bounded, so there is nothing to hash away. */
export function buildReverseKey(lat: number, lng: number, precision: number): string {
    return `geo:r:${KEY_VERSION}:${quantizeCoordinate(lat, precision)}:${quantizeCoordinate(lng, precision)}`;
}

/** What is stored. An envelope rather than a bare array, so `null` and `[]` stay distinct. */
interface CachedSearch {
    candidates: GeoCandidate[];
}
interface CachedReverse {
    candidate: GeoCandidate | null;
}

export class CachedGeocodingProvider implements IGeocodingProvider {
    private unavailableUntil = 0;

    constructor(
        private readonly inner: IGeocodingProvider,
        private readonly defaultCountryCodes: readonly string[],
        private readonly options: GeocodingCacheOptions,
    ) {}

    /**
     * Forwarded, never `'cached'`.
     *
     * `GeoCandidate.provider` must keep naming whoever actually resolved the address — it is
     * persisted onto every stored `GeoAddress` and is what a later reader uses to interpret
     * `provider_place_id`. A cache is not a provider.
     */
    get name(): IGeocodingProvider['name'] {
        return this.inner.name;
    }

    async search(query: string, opts: GeoSearchOptions = {}): Promise<GeoCandidate[]> {
        const key = buildSearchKey(
            query,
            opts.countryCodes ?? this.defaultCountryCodes,
            opts.language,
            opts.limit,
        );

        const cached = await this.read<CachedSearch>(key);
        if (cached) return cached.candidates;

        // Outside the cache's try/catch on purpose: a provider failure is the caller's to see.
        // Swallowing it here would turn a 503 into an empty result list, which reads as "no such
        // address" — a wrong answer is worse than an error.
        const candidates = await this.inner.search(query, opts);

        await this.write(key, { candidates }, candidates.length === 0);
        return candidates;
    }

    async reverse(lat: number, lng: number): Promise<GeoCandidate | null> {
        const key = buildReverseKey(lat, lng, this.options.reversePrecision);

        const cached = await this.read<CachedReverse>(key);
        if (cached) return cached.candidate;

        const candidate = await this.inner.reverse(lat, lng);

        await this.write(key, { candidate }, candidate === null);
        return candidate;
    }

    // ── Redis, and every path out of it returns rather than throws ─────────────

    private async read<T>(key: string): Promise<T | null> {
        if (Date.now() < this.unavailableUntil) {
            record('bypass');
            return null;
        }

        try {
            const client = await withTimeout(getRedisClient(CACHE_DB));
            if (client === TIMED_OUT) return this.markDown('read');

            const raw = await withTimeout(client.get(key));
            if (raw === TIMED_OUT) return this.markDown('read');

            this.unavailableUntil = 0;
            if (raw === null) {
                record('miss');
                return null;
            }

            record('hit');
            return JSON.parse(raw) as T;
        } catch (error) {
            // Includes a malformed value — a key written by an older shape, or a truncated
            // write. Treating it as a miss is correct and self-healing: the provider answers and
            // the write below replaces it.
            return this.markDown('read', error);
        }
    }

    private async write<T>(key: string, value: T, isEmpty: boolean): Promise<void> {
        if (Date.now() < this.unavailableUntil) return;

        const ttl = isEmpty ? this.options.negativeTtlSeconds : this.options.ttlSeconds;
        if (ttl <= 0) return;

        try {
            const client = await withTimeout(getRedisClient(CACHE_DB));
            if (client === TIMED_OUT) {
                this.markDown('write');
                return;
            }

            const stored = await withTimeout(client.set(key, JSON.stringify(value), { EX: ttl }));
            if (stored === TIMED_OUT) {
                this.markDown('write');
                return;
            }

            this.unavailableUntil = 0;
            record('store');
        } catch (error) {
            this.markDown('write', error);
        }
    }

    /** One log line per backoff window, not one per request. Failing open should be quiet. */
    private markDown(context: string, error?: unknown): null {
        const wasUp = this.unavailableUntil === 0;
        this.unavailableUntil = Date.now() + REDIS_BACKOFF_MS;
        record('error');
        if (wasUp) {
            console.warn(
                `[GeocodingCache] Redis unavailable during ${context}; serving address search `
                + `directly from the provider for ${REDIS_BACKOFF_MS / 1000}s.`,
                error ?? '',
            );
        }
        return null;
    }
}
