import { REDIS_DB_CATALOG, RedisDbSpec } from '../../../infra/redis/redis.factory';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * What may be flushed from the cache, and what it costs when you do.
 *
 * Pure — no Redis, no Express. `npm run test:system` drives every refusal path without a server.
 *
 * ═══ THE THREE THINGS THIS FILE EXISTS TO PREVENT ═════════════════════════════
 *
 * **1. A whole-instance flush.** There is no `FLUSHALL` anywhere in the code path this feeds,
 * and `db: 0` is refused outright — nothing in this codebase uses database 0, so a request for
 * it is a typo or a probe. A "clear the cache" button that can clear everything is a button
 * somebody presses during an incident.
 *
 * **2. A prefix that is secretly a wildcard.** The caller supplies a literal prefix and *we*
 * append the `*`. Glob metacharacters are escaped. Without that, `prefix: '*'` is a whole-database
 * flush wearing a prefix's clothes, and it would sail past the whole-database rule below.
 *
 * **3. A flush whose consequences nobody stated.** Three of these databases hold keys that are
 * load-bearing for correctness or for money, and "clearing a cache" does not sound dangerous.
 * Each carries its blast radius in the table, the refusal messages quote it, and it travels into
 * wi-admin's audit row — so the person who did it, and the person reading the trail afterwards,
 * both see what it meant.
 *
 * ── Addressed by NAME, never by index ─────────────────────────────────────────
 * `SLOT_LOCK_DB`, not `7`. A numeric field invites `0`, and a typo turning `7` into `8` silently
 * flushes live download links instead of booking holds. A misspelt name is a 404.
 */

export interface CacheFlushPolicy {
    spec: RedisDbSpec;
    /** May the whole logical database be cleared, or is a prefix mandatory? */
    wholeDbAllowed: boolean;
    /** Stated plainly, in the response and in the audit row. */
    blastRadius: string;
    /** True when clearing this can cause a duplicate side effect or lose a customer's work. */
    destructive: boolean;
}

function specFor(constant: string): RedisDbSpec {
    const spec = REDIS_DB_CATALOG.find((row) => row.constant === constant);
    if (!spec) {
        // Import-time, so a policy row naming a database the factory dropped kills the process
        // rather than producing a table with a hole in it.
        throw createAppError(
            ERROR_CODES.CONFIG_CACHE_POLICY_MISSING,
            500,
            `Cache-flush policy names "${constant}", which is not in REDIS_DB_CATALOG`,
            { constant },
        );
    }
    return spec;
}

export const CACHE_FLUSH_POLICY: readonly CacheFlushPolicy[] = Object.freeze([
    {
        spec: specFor('EMAIL_VERIFY_DB'),
        wholeDbAllowed: true,
        destructive: false,
        blastRadius: 'In-flight email verification links stop working. Users request a new one. Low.',
    },
    {
        spec: specFor('WA_VERIFY_DB'),
        wholeDbAllowed: true,
        destructive: false,
        blastRadius: 'In-flight WhatsApp verification codes stop working. Users request a new one. Low.',
    },
    {
        spec: specFor('WA_IDEMPOTENCY_DB'),
        wholeDbAllowed: false,
        destructive: true,
        blastRadius:
            'DESTRUCTIVE. These keys are the only thing stopping a retried send from becoming a '
            + 'SECOND WhatsApp message to a real person. Clearing them reopens a duplicate-send '
            + "window for the remainder of each key's TTL (24-72h).",
    },
    {
        spec: specFor('WA_WINDOW_DB'),
        wholeDbAllowed: true,
        destructive: false,
        blastRadius:
            'Service-window state recomputes on the next inbound message. Worst case a paid '
            + 'template is sent where a free-form reply would have been allowed. Low, but it costs money.',
    },
    {
        spec: specFor('SLOT_LOCK_DB'),
        wholeDbAllowed: false,
        destructive: true,
        blastRadius:
            'DESTRUCTIVE. Drops live booking holds. DEGRADED, NOT BROKEN: the actual double-sale '
            + "guard is createBooking's in-transaction overlap re-check, so what is lost is the "
            + 'reservation courtesy — two customers can reach checkout for the same slot and the '
            + 'second loses at commit — not the single-occupancy invariant.',
    },
    {
        spec: specFor('DOWNLOAD_TOKEN_DB'),
        wholeDbAllowed: false,
        destructive: true,
        blastRadius:
            'DESTRUCTIVE. Invalidates every live download link. A paying customer mid-download '
            + 'gets a dead URL and must re-mint from their library. Recoverable, visible, annoying.',
    },
    {
        spec: specFor('TELEGRAM_LINK_TOKEN_DB'),
        wholeDbAllowed: true,
        destructive: false,
        blastRadius: 'In-flight Telegram linking tokens stop working. Users restart linking. Low.',
    },
    {
        spec: specFor('TELEGRAM_WINDOW_DB'),
        wholeDbAllowed: true,
        destructive: false,
        blastRadius: 'Per-chat send-window state recomputes on the next inbound message. Low.',
    },
    {
        spec: specFor('RATE_LIMIT_DB'),
        wholeDbAllowed: true,
        destructive: false,
        // The only database in the catalogue whose loss costs nothing durable — it holds
        // counters, not state. Flushing it re-opens one window of allowance for everybody,
        // which is also exactly what an operator wants when a bad ceiling has locked a
        // legitimate integration out and the fix is still deploying.
        blastRadius:
            'Every caller gets a fresh allowance for the current window. Nothing durable is lost. '
            + 'Low — and it is the intended remedy for a ceiling set too tight.',
    },
    {
        spec: specFor('WORKER_LOCK_DB'),
        // The ONE destructive database that permits a whole-database flush, and the exception is
        // the point rather than an oversight. A prefix-only rule would be useless here: an
        // operator facing an orphaned lock does not know which worker owns it — that is the
        // symptom — and the remedy is releasing whatever is stuck. The three prefix-only
        // databases above are ones where the operator already knows the narrow key they mean.
        wholeDbAllowed: true,
        destructive: true,
        blastRadius:
            'DESTRUCTIVE. Releases every background-sweep lock, so a sweep already running on '
            + 'another instance can be started a second time — the exact double-processing this '
            + 'database exists to prevent, and it reaches the money sweeps (earnings release, COD '
            + 'deposit deadlines). It is nevertheless the intended remedy for a lock orphaned by a '
            + 'hard kill, which otherwise blocks its sweep until the TTL expires. Prefer waiting '
            + 'out the TTL; flush when the wait costs more than one overlapping pass.',
    },
]);

/**
 * Every catalogued database has a policy row.
 *
 * Asserted by `test:system` rather than trusted: a new logical database added to the factory
 * without a policy row would otherwise be silently unflushable — or worse, quietly reachable if
 * somebody later made the lookup permissive.
 */
export function policyFor(constant: string): CacheFlushPolicy | null {
    return CACHE_FLUSH_POLICY.find((row) => row.spec.constant === constant) ?? null;
}

export interface FlushRequest {
    db: string;
    prefix?: string;
    limit?: number;
    dryRun?: boolean;
    confirm: string;
}

export interface FlushPlan {
    ok: true;
    db: number;
    constant: string;
    /** The literal SCAN pattern. Built here so no caller can hand-craft one. */
    match: string;
    limit: number;
    dryRun: boolean;
    destructive: boolean;
    blastRadius: string;
}

export interface FlushRefusal {
    ok: false;
    code: 'unknown_db' | 'whole_db_not_allowed' | 'confirmation_mismatch' | 'invalid_prefix';
    message: string;
}

/**
 * Glob metacharacters, so a prefix is a prefix and never a pattern.
 *
 * Exported since Phase 15 so the read-only key inspector shares this exact escaping rather than
 * growing a second copy — the whole point of `resolveInspectPlan` living in this file.
 */
export function escapeGlob(value: string): string {
    return value.replace(/([\\*?[\]^])/g, '\\$1');
}

export function resolveFlushPlan(
    request: FlushRequest,
    maxKeys: number,
): FlushPlan | FlushRefusal {
    const policy = policyFor(request.db);
    if (!policy) {
        return {
            ok: false,
            code: 'unknown_db',
            message:
                `No cache database named "${request.db}". Known: `
                + `${CACHE_FLUSH_POLICY.map((row) => row.spec.constant).join(', ')}. `
                + 'Databases are addressed by name, never by index.',
        };
    }

    // The "type the name" guard. Also makes a replayed or half-built request fail closed.
    if (request.confirm !== request.db) {
        return {
            ok: false,
            code: 'confirmation_mismatch',
            message: `"confirm" must repeat the database name exactly ("${request.db}").`,
        };
    }

    const prefix = (request.prefix ?? '').trim();

    // A caller who passes `*` is asking for a whole-database flush through the prefix path.
    // Refuse explicitly rather than escaping it into a literal asterisk and returning zero
    // matches, which would look like success.
    if (prefix === '*' || prefix === '**') {
        return {
            ok: false,
            code: 'invalid_prefix',
            message: 'A prefix is a literal string, not a pattern. Omit it to request a whole-database flush.',
        };
    }

    if (!prefix && !policy.wholeDbAllowed) {
        return {
            ok: false,
            code: 'whole_db_not_allowed',
            message:
                `${policy.spec.constant} may only be flushed by prefix. ${policy.blastRadius}`,
        };
    }

    const requested = request.limit ?? maxKeys;
    const limit = Math.min(Math.max(Math.trunc(requested), 1), maxKeys);

    return {
        ok: true,
        db: policy.spec.db,
        constant: policy.spec.constant,
        match: prefix ? `${escapeGlob(prefix)}*` : '*',
        limit,
        // Defaults to a dry run, mirroring `FILE_CLEANUP_DRY_RUN`. An operator has to ask twice.
        dryRun: request.dryRun !== false,
        destructive: policy.destructive,
        blastRadius: policy.blastRadius,
    };
}

// ═══ Read-only inspection (Phase 15) ══════════════════════════════════════════

export interface InspectRequest {
    db: string;
    prefix?: string;
    limit?: number;
}

export interface InspectPlan {
    ok: true;
    db: number;
    constant: string;
    label: string;
    match: string;
    limit: number;
    /** Carried so the caller can render the warning even though nothing is being deleted. */
    destructive: boolean;
    blastRadius: string;
}

/**
 * The plan for listing key NAMES in one logical database.
 *
 * Deliberately shares this file, `policyFor`, `escapeGlob` and the name-not-index rule with
 * `resolveFlushPlan` — a second scanner is how the two drift and how the careful escaping ends
 * up on only one of them.
 *
 * ── It drops two of the flush's guards, and both omissions are decisions ──────
 * **No `confirm`.** Requiring an operator to type `SLOT_LOCK_DB` in order to *look* at key names
 * trains reflexive confirmation-typing, which is precisely what destroys the guard's value on
 * the path where it matters. The ceremony has to stay attached to deletion or it stops meaning
 * anything.
 *
 * **No `wholeDbAllowed` check.** Listing an entire destructive database is fine; clearing one is
 * not. `test:system` pins this asymmetry so it reads as a decision rather than an oversight.
 *
 * What it keeps: the database is addressed **by name** from the same closed list, the prefix is
 * a literal with the `*` appended by us, `prefix: "*"` is refused rather than silently escaped,
 * and the limit is clamped.
 */
export function resolveInspectPlan(
    request: InspectRequest,
    maxKeys: number,
): InspectPlan | FlushRefusal {
    const policy = policyFor(request.db);
    if (!policy) {
        return {
            ok: false,
            code: 'unknown_db',
            message:
                `No cache database named "${request.db}". Known: `
                + `${CACHE_FLUSH_POLICY.map((row) => row.spec.constant).join(', ')}. `
                + 'Databases are addressed by name, never by index.',
        };
    }

    const prefix = (request.prefix ?? '').trim();

    if (prefix === '*' || prefix === '**') {
        return {
            ok: false,
            code: 'invalid_prefix',
            message: 'A prefix is a literal string, not a pattern. Omit it to list the whole database.',
        };
    }

    const requested = request.limit ?? maxKeys;
    const limit = Math.min(Math.max(Math.trunc(requested), 1), maxKeys);

    return {
        ok: true,
        db: policy.spec.db,
        constant: policy.spec.constant,
        label: policy.spec.label,
        match: prefix ? `${escapeGlob(prefix)}*` : '*',
        limit,
        destructive: policy.destructive,
        blastRadius: policy.blastRadius,
    };
}
