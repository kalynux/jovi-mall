/**
 * Test: the geocoding result cache (ADR-A04 D-1, Phase 6 step 13).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * **DB-free, and Redis-free** — the decorator is driven against a FAKE Redis client, the same
 * approach `test:messaging-login` takes to its store, so the behaviour that actually matters is
 * asserted rather than scanned:
 *
 *   - a Redis outage still returns results (the fail-open guarantee)
 *   - the candidate list round-trips unchanged
 *   - one address typed two ways is one key
 *   - the provider is asked ONCE for two identical searches
 *
 * The last of those is the whole feature, and it is the one a source scan cannot see: a cache
 * that reads, writes and never actually short-circuits looks identical from the outside — same
 * shape, same result, same log line — and only the provider's bill knows.
 *
 * Run: npm run test:geocoding-cache
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as redisFactory from '../../src/infra/redis/redis.factory';
import {
    CachedGeocodingProvider,
    buildReverseKey,
    buildSearchKey,
    normalizeGeoQuery,
    quantizeCoordinate,
} from '../../src/core/geocoding/geocoding.cache';
import {
    GeoCandidate,
    GeoSearchOptions,
    IGeocodingProvider,
} from '../../src/core/geocoding/geocoding-provider.interface';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
    let ok: boolean;
    try {
        ok = await fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

const ROOT = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function candidate(label: string, lng: number, lat: number): GeoCandidate {
    return {
        formatted_address: label,
        coordinates: { type: 'Point', coordinates: [lng, lat] },
        provider: 'nominatim',
        provider_place_id: `way:${label.length}`,
        components: {
            street: 'Rue Njo-Njo',
            neighbourhood: 'Bonapriso',
            city: 'Douala',
            region: 'Littoral',
            country: 'Cameroon',
            country_code: 'CM',
            postal_code: null,
        },
    };
}

/** A provider that counts what it was asked, so "the cache short-circuits" is observable. */
class CountingProvider implements IGeocodingProvider {
    readonly name = 'nominatim' as const;
    searchCalls = 0;
    reverseCalls = 0;
    constructor(
        private readonly results: GeoCandidate[] = [candidate('Rue Njo-Njo, Douala', 9.7, 4.02)],
        private readonly reverseResult: GeoCandidate | null = candidate('Bonapriso, Douala', 9.7, 4.02),
    ) {}
    async search(_query: string, _opts?: GeoSearchOptions): Promise<GeoCandidate[]> {
        this.searchCalls++;
        return this.results;
    }
    async reverse(_lat: number, _lng: number): Promise<GeoCandidate | null> {
        this.reverseCalls++;
        return this.reverseResult;
    }
}

/** A provider that always fails, for the "a provider error is the caller's to see" case. */
class FailingProvider implements IGeocodingProvider {
    readonly name = 'nominatim' as const;
    async search(): Promise<GeoCandidate[]> {
        throw new Error('provider is down');
    }
    async reverse(): Promise<GeoCandidate | null> {
        throw new Error('provider is down');
    }
}

/**
 * The fake Redis.
 *
 * `getRedisClient` is module-scoped in `infra/redis/redis.factory`, so it is replaced on the
 * module object rather than injected — the decorator deliberately has no client parameter,
 * because a client passed in at construction would be captured before Redis was reachable.
 */
interface FakeRedis {
    store: Map<string, string>;
    gets: number;
    sets: number;
    ttls: Map<string, number>;
    mode: 'ok' | 'throw' | 'hang';
}

function installFakeRedis(mode: FakeRedis['mode'] = 'ok'): FakeRedis {
    const fake: FakeRedis = { store: new Map(), gets: 0, sets: 0, ttls: new Map(), mode };
    // The house technique — the same monkey-patch-a-singleton `test:messaging-login` uses on
    // this exact export. It works because the cache reaches for `getRedisClient` at CALL time.
    (redisFactory as Record<string, unknown>).getRedisClient = async (): Promise<unknown> => {
        if (fake.mode === 'throw') throw new Error('redis is down');
        // A dead host does not reject — it hangs. That is the case the timeout exists for, and
        // the reason this fixture offers it: `worker-lock.ts` learned it the expensive way.
        if (fake.mode === 'hang') return new Promise(() => undefined);
        return {
            get: async (key: string): Promise<string | null> => {
                fake.gets++;
                return fake.store.get(key) ?? null;
            },
            set: async (key: string, value: string, opts: { EX: number }): Promise<string> => {
                fake.sets++;
                fake.store.set(key, value);
                fake.ttls.set(key, opts.EX);
                return 'OK';
            },
        };
    };
    return fake;
}

const OPTS = { ttlSeconds: 3600, negativeTtlSeconds: 60, reversePrecision: 4 };

async function main(): Promise<void> {
    console.log('\n── Key normalisation: one address, one key ────────────────────────────\n');

    assert('case and surrounding space collapse', () =>
        normalizeGeoQuery('  Rue Njo-Njo, DOUALA  ') === 'rue njo-njo, douala');

    assert('runs of internal whitespace collapse to one space', () =>
        normalizeGeoQuery('Rue   Njo-Njo,\tDouala') === 'rue njo-njo, douala');

    // Byte-different, visually identical — a string typed on macOS versus Windows. Left alone,
    // this halves the hit rate for every accented address and nothing ever says so.
    assert('the same string in two Unicode compositions normalises to one', () =>
        normalizeGeoQuery('Extrême-Nord') === normalizeGeoQuery('Extrême-Nord'));

    // Deliberately NOT normalised away: a geocoder does not treat these as the same place.
    assert('accents are KEPT — Extrême-Nord is not Extreme-Nord', () =>
        normalizeGeoQuery('Extrême-Nord') !== normalizeGeoQuery('Extreme-Nord'));

    assert('punctuation is KEPT — a comma separates address components', () =>
        normalizeGeoQuery('Rue Njo-Njo, Douala') !== normalizeGeoQuery('Rue Njo-Njo Douala'));

    assert('the same address in different spacing and case is ONE key', () =>
        buildSearchKey('  Rue   Njo-Njo, DOUALA ', ['cm'], 'fr', 5)
        === buildSearchKey('rue njo-njo, douala', ['cm'], 'fr', 5));

    console.log('\n── The bias, the language and the limit participate ────────────────────\n');

    assert('a different country bias is a different key', () =>
        buildSearchKey('douala', ['cm'], 'fr', 5) !== buildSearchKey('douala', ['ng'], 'fr', 5));

    assert('a different language is a different key', () =>
        buildSearchKey('douala', ['cm'], 'fr', 5) !== buildSearchKey('douala', ['cm'], 'en', 5));

    // Serving a cached 3-item list to a request that asked for 10 truncates it silently, and the
    // caller cannot tell that from "the provider only found three".
    assert('a different limit is a different key', () =>
        buildSearchKey('douala', ['cm'], 'fr', 5) !== buildSearchKey('douala', ['cm'], 'fr', 10));

    assert('the country list is order-insensitive — one bias, one key', () =>
        buildSearchKey('douala', ['cm', 'ng'], 'fr', 5)
        === buildSearchKey('douala', ['ng', 'cm'], 'fr', 5));

    assert('country codes are case-insensitive', () =>
        buildSearchKey('douala', ['CM'], 'fr', 5) === buildSearchKey('douala', ['cm'], 'fr', 5));

    // A Redis key is unbounded user input otherwise, and `/system/cache/keys` LISTS key names —
    // an address somebody typed is personal data and would sit in an operator's browser.
    assert('the raw address never appears in the key', () => {
        const key = buildSearchKey('Rue Njo-Njo, Douala', ['cm'], 'fr', 5);
        return !key.toLowerCase().includes('njo') && !key.toLowerCase().includes('douala');
    });

    assert('the key is versioned, so a shape change cannot read old values back', () =>
        buildSearchKey('douala', ['cm'], 'fr', 5).startsWith('geo:s:v1:')
        && buildReverseKey(4.05, 9.7, 4).startsWith('geo:r:v1:'));

    console.log('\n── Reverse keys are coarse, or they never hit ──────────────────────────\n');

    assert('coordinates round to the configured precision', () =>
        quantizeCoordinate(4.050123456, 4) === '4.0501');

    // A GPS fix never repeats exactly. Unrounded, the hit rate is zero and the cache looks fine.
    assert('two fixes ~1 m apart share one key', () =>
        buildReverseKey(4.0501234, 9.7001234, 4) === buildReverseKey(4.0501255, 9.7001266, 4));

    assert('two points ~1 km apart do NOT share a key', () =>
        buildReverseKey(4.0501, 9.7001, 4) !== buildReverseKey(4.0591, 9.7001, 4));

    assert('negative zero has one spelling', () =>
        quantizeCoordinate(-0.00001, 4) === quantizeCoordinate(0, 4));

    console.log('\n── The candidate list round-trips, and the provider is asked once ──────\n');

    await assertAsync('a second identical search does NOT reach the provider', async () => {
        installFakeRedis();
        const inner = new CountingProvider();
        const cache = new CachedGeocodingProvider(inner, ['cm'], OPTS);
        await cache.search('Rue Njo-Njo, Douala', { limit: 5, language: 'fr' });
        await cache.search('  rue njo-njo, DOUALA  ', { limit: 5, language: 'fr' });
        return inner.searchCalls === 1;
    });

    await assertAsync('the cached candidate list is returned unchanged', async () => {
        installFakeRedis();
        const results = [candidate('A', 9.70, 4.02), candidate('B', 9.71, 4.03)];
        const inner = new CountingProvider(results);
        const cache = new CachedGeocodingProvider(inner, ['cm'], OPTS);
        const first = await cache.search('douala', { limit: 5 });
        const second = await cache.search('douala', { limit: 5 });
        return inner.searchCalls === 1 && JSON.stringify(first) === JSON.stringify(second);
    });

    // The structured `components` are what `toGeoAddress` persists, so a lossy round trip would
    // quietly degrade every address stored from a cache hit.
    await assertAsync('the structured components survive the round trip', async () => {
        installFakeRedis();
        const inner = new CountingProvider();
        const cache = new CachedGeocodingProvider(inner, ['cm'], OPTS);
        await cache.search('douala', { limit: 5 });
        const [hit] = await cache.search('douala', { limit: 5 });
        return hit.components.city === 'Douala'
            && hit.components.country_code === 'CM'
            && hit.components.postal_code === null
            && hit.provider_place_id !== null
            && hit.coordinates.coordinates[0] === 9.7;
    });

    await assertAsync('a reverse lookup is cached too', async () => {
        installFakeRedis();
        const inner = new CountingProvider();
        const cache = new CachedGeocodingProvider(inner, ['cm'], OPTS);
        await cache.reverse(4.0501234, 9.7001234);
        await cache.reverse(4.0501255, 9.7001266);
        return inner.reverseCalls === 1;
    });

    // `null` and `[]` are different answers and must not collapse into "nothing cached".
    await assertAsync('a reverse MISS (null) is cached as null, not as absent', async () => {
        const fake = installFakeRedis();
        const inner = new CountingProvider([], null);
        const cache = new CachedGeocodingProvider(inner, ['cm'], OPTS);
        const first = await cache.reverse(4.05, 9.70);
        const second = await cache.reverse(4.05, 9.70);
        return first === null && second === null && inner.reverseCalls === 1 && fake.sets === 1;
    });

    console.log('\n── Empty answers are cached, and at a SHORTER ttl ──────────────────────\n');

    await assertAsync('an empty result list is still cached', async () => {
        installFakeRedis();
        const inner = new CountingProvider([]);
        const cache = new CachedGeocodingProvider(inner, ['cm'], OPTS);
        await cache.search('qqqqqq', { limit: 5 });
        const second = await cache.search('qqqqqq', { limit: 5 });
        return inner.searchCalls === 1 && Array.isArray(second) && second.length === 0;
    });

    /**
     * The asymmetry is the point. "No match" is the answer to a half-typed address AND to a real
     * gap in OpenStreetMap's coverage, and the two are indistinguishable from here — so the
     * negative TTL is short enough that a newly-mapped street is not hidden for a day.
     */
    await assertAsync('an empty result takes the negative ttl, a resolved one the full ttl', async () => {
        const fake = installFakeRedis();
        const emptyCache = new CachedGeocodingProvider(new CountingProvider([]), ['cm'], OPTS);
        await emptyCache.search('qqqqqq', { limit: 5 });
        const negativeTtl = [...fake.ttls.values()][0];

        const fullFake = installFakeRedis();
        const fullCache = new CachedGeocodingProvider(new CountingProvider(), ['cm'], OPTS);
        await fullCache.search('douala', { limit: 5 });
        const positiveTtl = [...fullFake.ttls.values()][0];

        return negativeTtl === OPTS.negativeTtlSeconds
            && positiveTtl === OPTS.ttlSeconds
            && negativeTtl < positiveTtl;
    });

    console.log('\n── It FAILS OPEN — every way Redis can fail ────────────────────────────\n');

    await assertAsync('a Redis that THROWS still returns results', async () => {
        installFakeRedis('throw');
        const inner = new CountingProvider();
        const cache = new CachedGeocodingProvider(inner, ['cm'], OPTS);
        const results = await cache.search('douala', { limit: 5 });
        return results.length === 1 && inner.searchCalls === 1;
    });

    /**
     * ⚠ The case that matters, and the one reasoning alone misses. A dead host does not reject —
     * node-redis retries the initial connect, so an unbounded `getRedisClient` sits unresolved
     * for minutes and the `catch` never runs. Without the timeout the address search parks on
     * connect and the customer watches a spinner: strictly worse than having no cache.
     */
    await assertAsync('a Redis that HANGS is bounded, and results still arrive', async () => {
        installFakeRedis('hang');
        const inner = new CountingProvider();
        const cache = new CachedGeocodingProvider(inner, ['cm'], OPTS);
        /**
         * ⚠ The keep-alive is a TEST artefact and the source is right as it stands. The cache's
         * timeout timer is `unref()`d — deliberately, so a pending cache read can never hold the
         * process open during the drain — and in a script whose only other pending work is a
         * promise that never settles, an unref'd timer does not keep the loop alive either. Node
         * would exit mid-assertion with no output. A server always has a listener holding the
         * loop; this stands in for it.
         */
        const keepAlive = setInterval(() => undefined, 20);
        try {
            const started = Date.now();
            const results = await cache.search('douala', { limit: 5 });
            const elapsed = Date.now() - started;
            return results.length === 1 && inner.searchCalls === 1 && elapsed < 3_000;
        } finally {
            clearInterval(keepAlive);
        }
    });

    await assertAsync('a corrupt cached value degrades to a miss rather than a throw', async () => {
        const fake = installFakeRedis();
        const inner = new CountingProvider();
        const cache = new CachedGeocodingProvider(inner, ['cm'], OPTS);
        fake.store.set(buildSearchKey('douala', ['cm'], undefined, 5), '{not json');
        const results = await cache.search('douala', { limit: 5 });
        return results.length === 1 && inner.searchCalls === 1;
    });

    // A provider failure is NOT the cache's to swallow: an empty list reads as "no such address",
    // and a wrong answer is worse than an error.
    await assertAsync('a PROVIDER failure still propagates to the caller', async () => {
        installFakeRedis();
        const cache = new CachedGeocodingProvider(new FailingProvider(), ['cm'], OPTS);
        try {
            await cache.search('douala', { limit: 5 });
            return false;
        } catch (err) {
            return (err as Error).message === 'provider is down';
        }
    });

    await assertAsync('a failed provider call is not cached as an empty result', async () => {
        const fake = installFakeRedis();
        const cache = new CachedGeocodingProvider(new FailingProvider(), ['cm'], OPTS);
        await cache.search('douala', { limit: 5 }).catch(() => undefined);
        return fake.sets === 0;
    });

    console.log('\n── Nothing branches on the provider ────────────────────────────────────\n');

    await assertAsync('the decorator forwards `name` rather than claiming to be a provider', async () => {
        installFakeRedis();
        const cache = new CachedGeocodingProvider(new CountingProvider(), ['cm'], OPTS);
        return cache.name === 'nominatim';
    });

    // `GeoCandidate.provider` is persisted onto every stored GeoAddress and is what a later
    // reader uses to interpret `provider_place_id`. A cache is not a provider.
    await assertAsync('a cached candidate still names the real provider', async () => {
        installFakeRedis();
        const cache = new CachedGeocodingProvider(new CountingProvider(), ['cm'], OPTS);
        await cache.search('douala', { limit: 5 });
        const [hit] = await cache.search('douala', { limit: 5 });
        return hit.provider === 'nominatim';
    });

    const cacheSrc = stripComments(read('src/core/geocoding/geocoding.cache.ts'));
    const instanceSrc = stripComments(read('src/core/geocoding/geocoding.instance.ts'));
    const factorySrc = stripComments(read('src/core/geocoding/geocoding.factory.ts'));

    assert('the cache names no concrete provider', () =>
        !cacheSrc.includes('Nominatim')
        && !/'(google|mapbox|here|geoapify)'/.test(cacheSrc));

    // Wrapping in the factory would put a Redis dependency in the file whose only job is to
    // translate a config string into a class; wrapping inside an adapter would have to be
    // written again for the paid one.
    assert('the wrap happens at the singleton, so a future adapter inherits it', () =>
        instanceSrc.includes('new CachedGeocodingProvider(')
        && !factorySrc.includes('CachedGeocodingProvider'));

    assert('the cache can be switched off without a code change', () =>
        instanceSrc.includes("process.env.GEO_CACHE_ENABLED !== 'false'")
        && instanceSrc.includes('geocodingConfig.cache.enabled'));

    console.log('\n── The Redis database is the one ADR-A04 asks for ──────────────────────\n');

    const redisSrc = read('src/infra/redis/redis.factory.ts');

    assert('the cache has its OWN database', () =>
        /export const GEO_CACHE_DB = 15;/.test(redisSrc));

    // 4 and 9 held the two pre-cutover account-linking mechanisms. ADR-A04 D-1 names them
    // explicitly: a stale key from a pre-cutover deployment must never be read back as an address.
    assert('it is NOT 4 or 9, which are retired', () => {
        const match = redisSrc.match(/export const GEO_CACHE_DB = (\d+);/);
        return match !== null && match[1] !== '4' && match[1] !== '9';
    });

    assert('it is in the catalogue, so /system/cache and the flush policy can see it', () =>
        redisSrc.includes("constant: 'GEO_CACHE_DB'"));

    // ADR-A04 D-2 defers self-hosting until "the hit rate stops rising". That is a measurement.
    assert('the hit rate is measurable', () =>
        cacheSrc.includes('geocodingCacheEventsTotal')
        && read('src/modules/system/metrics/metrics.ts').includes('geocoding_cache_events_total'));

    assert('the metric label set is closed, and is never the query', () =>
        cacheSrc.includes("type CacheEvent = 'hit' | 'miss' | 'store' | 'bypass' | 'error'")
        && !/inc\(\{\s*event:\s*[^'}]*query/.test(cacheSrc));

    console.log('\n── Documented where an operator will look ──────────────────────────────\n');

    const envExample = read('.env.example');
    for (const name of [
        'GEO_CACHE_ENABLED',
        'GEO_CACHE_TTL_SECONDS',
        'GEO_CACHE_NEGATIVE_TTL_SECONDS',
        'GEO_CACHE_REVERSE_PRECISION',
    ]) {
        assert(`${name} is documented in .env.example`, () => envExample.includes(name));
    }

    assert('.env.example says it fails open', () =>
        /fails open|FAILS OPEN/i.test(envExample.slice(
            envExample.indexOf('GEO_CACHE_ENABLED') - 900,
            envExample.indexOf('GEO_CACHE_ENABLED') + 200,
        )));

    const geoDoc = read(join('api-doc', 'geo', 'README.md'));
    assert('the api-doc tells a client the cache exists and is invisible', () =>
        /cache/i.test(geoDoc) && geoDoc.includes('ADR-A04'));

    console.log('\n' + '─'.repeat(72));
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('─'.repeat(72) + '\n');
    if (failed > 0) process.exit(1);
}

void main();
