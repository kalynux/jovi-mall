import { getRedisClient, RECOMMENDATION_CACHE_DB } from '../../../infra/redis/redis.factory';
import { RELATED_PRODUCTS_CONFIG } from '../config/related-products.config';

/**
 * The related-products cache (Phase 6 · 6.E.3).
 *
 * ── It FAILS OPEN, and that is not optional ──────────────────────────────────
 *
 * Every method swallows its own errors. A cache that can fail a request is worse than no
 * cache at all: the thing being cached here is a decorative strip at the bottom of a
 * product page, and a Redis outage must degrade that strip's *latency*, never take the
 * product page down with it.
 *
 * This is the same rule `FailOpenStore` applies to the rate limiter and `withWorkerLock`
 * applies to the worker locks, and it is stated the same way in all three because the naive
 * integration gets it wrong in the same way each time: `node-redis` does not reject
 * promptly when the host is gone — it retries the connect — so an unguarded `await` here
 * hangs the request rather than failing it. `getRedisClient` is therefore raced against a
 * deadline, and a timeout means *recompute*, never *fail*.
 *
 * ── What it stores ──────────────────────────────────────────────────────────
 * The computed ENTRY — ids, counts and the source label — not the hydrated cards. Cards
 * carry price, stock and store state, all of which move faster than the six-hour TTL, so
 * caching them would serve a stale price. Hydration happens on every request, from the
 * live catalogue; only the *ranking* is cached.
 */

/** How long to wait on Redis before deciding to recompute. See the header. */
const REDIS_DEADLINE_MS = 2_000;

/** What is actually stored: a ranking, never a rendered card. */
export interface CachedRelatedRanking {
    /** Ordered, most related first. */
    entries: Array<{ productId: string; orders: number | null }>;
    /** Which signal produced it — published to the client, so it cannot be cached away. */
    source: 'co_purchase' | 'same_category';
}

function keyFor(productId: string): string {
    return `related:${productId}`;
}

/**
 * Race a Redis operation against a deadline.
 *
 * ⚠ A dead host does NOT reject. `getRedisClient` awaits a connection that node-redis keeps
 * retrying, so without this the request simply stops — a hang, which reads as a much worse
 * outage than the cache being down. The timeout is what turns "cannot reach Redis" into
 * "recompute", which is the only safe direction.
 */
async function withDeadline<T>(operation: () => Promise<T>): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation(),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), REDIS_DEADLINE_MS);
            }),
        ]);
    } catch {
        // Deliberately silent at debug level rather than `error`: a cache miss caused by an
        // outage is already visible on `/system/dependencies`, and logging one line per
        // product-page view during that outage buries everything else.
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export class RelatedProductsCache {
    /** A previously computed ranking, or null for "recompute" — including on any failure. */
    async read(productId: string): Promise<CachedRelatedRanking | null> {
        const raw = await withDeadline(async () => {
            const redis = await getRedisClient(RECOMMENDATION_CACHE_DB);
            return redis.get(keyFor(productId));
        });

        if (!raw) return null;

        try {
            const parsed = JSON.parse(raw) as CachedRelatedRanking;
            // A stored shape that does not parse into what we expect is treated as a miss,
            // not as an error. The alternative — trusting it — puts a deploy that changed
            // this interface into the position of serving garbage until every key expires.
            return Array.isArray(parsed?.entries) ? parsed : null;
        } catch {
            return null;
        }
    }

    /** Store a ranking. A failure is not reported: the answer was already computed. */
    async write(productId: string, ranking: CachedRelatedRanking): Promise<void> {
        await withDeadline(async () => {
            const redis = await getRedisClient(RECOMMENDATION_CACHE_DB);
            return redis.set(keyFor(productId), JSON.stringify(ranking), {
                EX: RELATED_PRODUCTS_CONFIG.CACHE_TTL_SECONDS,
            });
        });
    }
}

export const relatedProductsCache = new RelatedProductsCache();
