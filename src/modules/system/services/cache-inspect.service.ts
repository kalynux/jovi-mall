import {
    REDIS_DB_CATALOG,
    anyOpenRedisClient,
    redisClientSnapshot,
} from '../../../infra/redis/redis.factory';

/**
 * `GET /api/internal/admin/system/cache`.
 *
 * ═══ THE CORRECTION THAT SHAPES THIS WHOLE RESPONSE ═══════════════════════════
 *
 * **Redis does not track hits and misses per logical database.** `keyspace_hits`,
 * `keyspace_misses`, `used_memory`, `maxmemory` and `evicted_keys` are all **instance-wide**.
 * Only `INFO keyspace` breaks down per database, and it reports key counts and TTLs — not hit
 * rate.
 *
 * The obvious response shape — one row per database with a hit rate on it — would therefore be
 * a lie in eight places. Presenting an instance-wide ratio as though it were per-database is
 * worse than omitting it: an operator would "discover" that the booking slot-lock database has
 * a 40% hit rate and go looking for a caching bug that does not exist.
 *
 * So the response is explicitly two-scoped, with the scope stated on the wire.
 *
 * ── A pleasant consequence ────────────────────────────────────────────────────
 * One `INFO` call on any single open client answers everything. There is no per-database
 * command loop and no need for a client per database — which matters, because opening one would
 * violate the rule this module is built on. If no client is open at all, this reports
 * `available: false` rather than connecting. See `infra/redis/redis.factory.ts`.
 */

export interface CacheDatabaseReport {
    db: number;
    constant: string;
    label: string;
    purpose: string;
    ttlHint: string;
    open: boolean;
    everOpened: boolean;
    keys: number | null;
    expires: number | null;
    avgTtlMs: number | null;
}

export interface CacheReport {
    available: boolean;
    reason: string | null;
    instance: {
        scope: 'instance';
        usedMemoryBytes: number | null;
        usedMemoryHuman: string | null;
        maxMemoryBytes: number | null;
        evictedKeys: number | null;
        keyspaceHits: number | null;
        keyspaceMisses: number | null;
        hitRate: number | null;
    } | null;
    databases: CacheDatabaseReport[];
    note: string;
}

const SCOPE_NOTE =
    'Memory, evictions and hit rate are INSTANCE-wide — Redis does not report them per logical '
    + 'database. Only the key counts below are per-database.';

export async function describeCache(): Promise<CacheReport> {
    const snapshot = new Map(redisClientSnapshot().map((entry) => [entry.db, entry]));

    const databases: CacheDatabaseReport[] = REDIS_DB_CATALOG.map((spec) => ({
        db: spec.db,
        constant: spec.constant,
        label: spec.label,
        purpose: spec.purpose,
        ttlHint: spec.ttlHint,
        open: snapshot.get(spec.db)?.open ?? false,
        everOpened: snapshot.get(spec.db)?.everOpened ?? false,
        keys: null,
        expires: null,
        avgTtlMs: null,
    }));

    const open = anyOpenRedisClient();
    if (!open) {
        return {
            available: false,
            // Not an error. Redis connects lazily, so a process that has not yet needed it is
            // in a normal state — and connecting here to say so would be the diagnostics
            // changing what it measures.
            reason: 'no Redis client is open in this process; nothing was connected to find out',
            instance: null,
            databases,
            note: SCOPE_NOTE,
        };
    }

    try {
        const [statsRaw, memoryRaw, keyspaceRaw] = await Promise.all([
            open.client.info('stats'),
            open.client.info('memory'),
            open.client.info('keyspace'),
        ]);

        const stats = parseInfo(statsRaw);
        const memory = parseInfo(memoryRaw);
        const keyspace = parseKeyspace(keyspaceRaw);

        for (const row of databases) {
            const entry = keyspace.get(row.db);
            if (!entry) {
                // Absent from `INFO keyspace` means the database holds nothing at all — a real
                // zero, not an unknown, so report it as one.
                row.keys = 0;
                row.expires = 0;
                row.avgTtlMs = null;
                continue;
            }
            row.keys = entry.keys;
            row.expires = entry.expires;
            row.avgTtlMs = entry.avgTtl;
        }

        const hits = numberOf(stats.keyspace_hits);
        const misses = numberOf(stats.keyspace_misses);
        const total = (hits ?? 0) + (misses ?? 0);

        return {
            available: true,
            reason: null,
            instance: {
                scope: 'instance',
                usedMemoryBytes: numberOf(memory.used_memory),
                usedMemoryHuman: memory.used_memory_human ?? null,
                maxMemoryBytes: numberOf(memory.maxmemory),
                evictedKeys: numberOf(stats.evicted_keys),
                keyspaceHits: hits,
                keyspaceMisses: misses,
                // Null rather than 1 or 0 on a cold instance: a hit rate over zero lookups is
                // not a number, and rendering 100% would be actively misleading.
                hitRate: total > 0 ? Number(((hits ?? 0) / total).toFixed(4)) : null,
            },
            databases,
            note: SCOPE_NOTE,
        };
    } catch (error) {
        return {
            available: false,
            reason: error instanceof Error ? error.message : String(error),
            instance: null,
            databases,
            note: SCOPE_NOTE,
        };
    }
}

/** `INFO` sections are `key:value` lines with `#` comments and CRLF endings. */
function parseInfo(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const index = line.indexOf(':');
        if (index === -1) continue;
        out[line.slice(0, index)] = line.slice(index + 1);
    }
    return out;
}

/** `db7:keys=12,expires=12,avg_ttl=840000` */
function parseKeyspace(raw: string): Map<number, { keys: number; expires: number; avgTtl: number | null }> {
    const out = new Map<number, { keys: number; expires: number; avgTtl: number | null }>();
    for (const [key, value] of Object.entries(parseInfo(raw))) {
        const match = /^db(\d+)$/.exec(key);
        if (!match) continue;

        const fields: Record<string, number> = {};
        for (const pair of value.split(',')) {
            const [name, rawValue] = pair.split('=');
            const parsed = Number(rawValue);
            if (name && Number.isFinite(parsed)) fields[name] = parsed;
        }

        out.set(Number(match[1]), {
            keys: fields.keys ?? 0,
            expires: fields.expires ?? 0,
            avgTtl: fields.avg_ttl ? fields.avg_ttl : null,
        });
    }
    return out;
}

function numberOf(value: string | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
