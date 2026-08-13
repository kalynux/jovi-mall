import { getRedisClient } from '../../../infra/redis/redis.factory';
import { SYSTEM_CONFIG } from '../config/system.config';
import { FlushPlan } from '../domain/cache-flush-policy';

/**
 * Executing a flush plan.
 *
 * The policy — what may be flushed, by whom, and what it costs — is
 * `domain/cache-flush-policy.ts`. By the time a plan reaches this file every refusal has already
 * been made; this is the mechanics.
 *
 * ── SCAN, never KEYS ──────────────────────────────────────────────────────────
 * `KEYS` is O(n) over the whole keyspace and blocks the Redis event loop for the duration —
 * which is to say it takes the platform's bookings, verification codes and download links down
 * with it, in the middle of whatever incident prompted the flush. `SCAN` is incremental and
 * yields between batches.
 *
 * ── Bounded twice, and truncation is REPORTED ─────────────────────────────────
 * Both a key limit and a wall-clock budget; whichever trips first stops the loop. The response
 * always says whether it stopped early and hands back the cursor to continue from. Silent
 * truncation would read as "done" when it means "some of it".
 *
 * ── This is the one place that may CONNECT ────────────────────────────────────
 * Everything else in this module uses `peekRedisClient` and never provisions. A flush is the
 * deliberate exception: the database being cleared may legitimately have been opened by a
 * different instance and never by this one, and refusing to act on that basis would be an
 * arbitrary limitation. The asymmetry is intentional and is documented on both accessors.
 */

export interface FlushOutcome {
    db: number;
    constant: string;
    match: string;
    dryRun: boolean;
    /** Keys the scan matched, up to the limit. */
    matched: number;
    /** Keys actually removed. Always 0 on a dry run. */
    deleted: number;
    /** True when a bound stopped the scan before the keyspace was exhausted. */
    truncated: boolean;
    /** Resume point when truncated. `'0'` means the scan completed. */
    cursor: string;
    /** A capped sample, for a dry run. **Names only — values are never read.** */
    sample: string[];
    blastRadius: string;
    destructive: boolean;
}

const SAMPLE_CAP = 20;
const DELETE_BATCH = 100;

export async function executeFlush(plan: FlushPlan): Promise<FlushOutcome> {
    const client = await getRedisClient(plan.db);

    const deadline = Date.now() + SYSTEM_CONFIG.CACHE_FLUSH_BUDGET_MS;
    const sample: string[] = [];

    let cursor = '0';
    let matched = 0;
    let deleted = 0;
    let truncated = false;
    let batch: string[] = [];

    do {
        const result = await client.scan(cursor, { MATCH: plan.match, COUNT: 500 });
        cursor = String(result.cursor);

        for (const key of result.keys) {
            if (matched >= plan.limit) {
                truncated = true;
                break;
            }
            matched += 1;
            if (sample.length < SAMPLE_CAP) sample.push(key);
            if (!plan.dryRun) batch.push(key);
        }

        if (!plan.dryRun && batch.length >= DELETE_BATCH) {
            deleted += await removeKeys(client, batch);
            batch = [];
        }

        if (matched >= plan.limit) {
            truncated = true;
            break;
        }
        if (Date.now() > deadline) {
            truncated = true;
            break;
        }
    } while (cursor !== '0');

    if (!plan.dryRun && batch.length > 0) {
        deleted += await removeKeys(client, batch);
    }

    return {
        db: plan.db,
        constant: plan.constant,
        match: plan.match,
        dryRun: plan.dryRun,
        matched,
        deleted,
        truncated,
        cursor,
        sample,
        blastRadius: plan.blastRadius,
        destructive: plan.destructive,
    };
}

/**
 * `UNLINK` where available, `DEL` otherwise.
 *
 * `UNLINK` reclaims memory on a background thread, so a large batch does not stall the server
 * the way `DEL` would — the same reasoning as preferring SCAN over KEYS. Older Redis builds do
 * not have it, hence the fallback.
 */
async function removeKeys(
    client: { unlink?: (keys: string[]) => Promise<number>; del: (keys: string[]) => Promise<number> },
    keys: string[],
): Promise<number> {
    if (keys.length === 0) return 0;
    try {
        if (typeof client.unlink === 'function') return await client.unlink(keys);
    } catch {
        // Fall through — an old server answers "unknown command" and DEL is always there.
    }
    return client.del(keys);
}
