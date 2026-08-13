import type { RedisClientType } from 'redis';
import { peekRedisClient } from '../../../infra/redis/redis.factory';
import { SYSTEM_CONFIG } from '../config/system.config';
import { InspectPlan } from '../domain/cache-flush-policy';
import { runReadCommand } from '../domain/redis-command-policy';

/**
 * Listing key NAMES in one logical Redis database.
 *
 * Sits beside `describeCache()`, which reports instance-wide memory and per-database key counts.
 * This is the per-key read that the counts make you want next.
 *
 * ── VALUES ARE NEVER RETURNED, and there is deliberately no single-key read ───
 * No `GET`, no `HGETALL`, no `LRANGE`, and no `/cache/key?name=…`. Three of the eight logical
 * databases here hold download tokens, WhatsApp idempotency keys and email/WhatsApp verification
 * codes — a value read would be a decryption oracle for exactly the databases the flush policy
 * calls destructive. A key's NAME, TYPE and TTL answer every legitimate operational question
 * ("are these expiring", "is something writing junk here") without being one.
 *
 * ── `peekRedisClient`, not `getRedisClient` ──────────────────────────────────
 * ADR-014 D-1's rule is *a probe observes; it does not provision*, and this is a probe. The
 * flush's exception is justified by "the database being cleared may legitimately have been
 * opened by a different instance" — that argument does not transfer to a listing, because a
 * listing served from a connection minted for the listing is precisely the probe that changes
 * what it measures. With no open client this returns `available: false` and a reason, in the
 * same voice `describeCache()` already uses, rather than an error.
 *
 * ── Every command goes through the allowlist ─────────────────────────────────
 * `runReadCommand` is the choke point; `test:system` asserts this file contains no direct
 * client call outside it. See `domain/redis-command-policy.ts`.
 */

export interface CacheKeyEntry {
    key: string;
    type: string | null;
    ttlMs: number | null;
    sizeBytes: number | null;
}

export interface CacheKeysOutcome {
    available: boolean;
    reason: string | null;
    db: number;
    constant: string;
    label: string;
    match: string;
    matched: number;
    truncated: boolean;
    cursor: string;
    destructive: boolean;
    blastRadius: string;
    keys: CacheKeyEntry[];
    note: string;
}

const VALUES_NOTE =
    'Key names, types and TTLs only. Values are never read by this endpoint, and there is '
    + 'deliberately no single-key value read — that would be a disclosure oracle for download '
    + 'tokens, verification codes and WhatsApp idempotency keys.';

export async function inspectCacheKeys(
    plan: InspectPlan,
    withSize: boolean,
): Promise<CacheKeysOutcome> {
    const base = {
        db: plan.db,
        constant: plan.constant,
        label: plan.label,
        match: plan.match,
        destructive: plan.destructive,
        blastRadius: plan.blastRadius,
        note: VALUES_NOTE,
    };

    const client = peekRedisClient(plan.db) as RedisClientType | null;
    if (!client) {
        return {
            ...base,
            available: false,
            reason:
                `This process has no open client for ${plan.constant}; nothing was connected to find out. `
                + 'Redis connects lazily here, so an idle database is not a down one.',
            matched: 0,
            truncated: false,
            cursor: '0',
            keys: [],
        };
    }

    const deadline = Date.now() + SYSTEM_CONFIG.CACHE_FLUSH_BUDGET_MS;
    const names: string[] = [];
    let cursor = '0';
    let truncated = false;

    // Bounded twice — key limit and wall clock — exactly as the flush is, and for the same
    // reason: a scan that stopped early must say so rather than read as a complete listing.
    do {
        const result = (await runReadCommand(client, 'scan', cursor, {
            MATCH: plan.match,
            COUNT: 500,
        })) as { cursor: number | string; keys: string[] };

        cursor = String(result.cursor);
        for (const key of result.keys) {
            if (names.length >= plan.limit) break;
            names.push(key);
        }

        if (names.length >= plan.limit || Date.now() > deadline) {
            truncated = cursor !== '0';
            break;
        }
    } while (cursor !== '0');

    const keys: CacheKeyEntry[] = [];
    for (const key of names) {
        // 2N+1 round trips is fine at limit ≤ 500 and silly to hand-optimise into a pipeline
        // that would then need its own error handling per reply.
        const [type, ttlMs] = await Promise.all([
            runReadCommand(client, 'type', key).catch(() => null),
            runReadCommand(client, 'pttl', key).catch(() => null),
        ]);

        // `MEMORY USAGE` is O(size) on a collection, so it is off by default and opt-in.
        const sizeBytes = withSize
            ? ((await runReadCommand(client, 'memoryUsage', key).catch(() => null)) as number | null)
            : null;

        keys.push({
            key,
            type: typeof type === 'string' ? type : null,
            // Redis returns -1 (no expiry) and -2 (missing); both are more useful as null than
            // as a negative number a dashboard would render as a countdown.
            ttlMs: typeof ttlMs === 'number' && ttlMs >= 0 ? ttlMs : null,
            sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : null,
        });
    }

    return {
        ...base,
        available: true,
        reason: null,
        matched: keys.length,
        truncated,
        cursor,
        keys,
    };
}
