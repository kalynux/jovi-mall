import mongoose from 'mongoose';
import { COLLECTIONS } from '../../../core/database/collections';
import { escapeRegex } from '../../../core/utils/regex.util';
import {
    LOG_LEVELS,
    LogLevel,
    LogRecord,
    levelRank,
    logMongoSink,
    logRing,
    loggingConfig,
} from '../../../core/logging';

/**
 * The read behind `GET /api/internal/admin/system/logs`.
 *
 * ── One endpoint, two stores, and the store says which it was ─────────────────
 * An operator asks one question — "what happened" — and making them pick a backing store first
 * is making them learn the implementation. So there is one route with a `source` hint, the
 * answer always names the store that served it, and the caveat belonging to that store travels
 * with the response. Same shape as `/system/cache`, which reports two scopes on one read rather
 * than splitting into two endpoints.
 *
 * ── A log line is free text and can contain personal data ────────────────────
 * That is why the route's permission is `developer_tools.logs.read` rather than
 * `system.health.read`: the latter reaches tier 2 through `allInFamily('system')`, and an
 * unfiltered feed of every warning in the platform is a broader disclosure than any individual
 * `*.read` an Admin holds — because it is not scoped by subject and cannot be. The `warning`
 * field says so on the wire.
 */

export interface LogQueryInput {
    level?: LogLevel;
    since?: Date;
    until?: Date;
    requestId?: string;
    q?: string;
    /**
     * Phase 16 — narrow to lines the global error handler produced.
     *
     * `errorsOnly` is what makes `/system/errors` a thin sibling of this service rather
     * than a second query layer: the ring buffer, the capped-collection fallback, the
     * cursor pagination and the sink-state reporting are all already here and already
     * proven by `verify:logs`.
     *
     * `category` and `code` are BOUNDED enums, so they are equality filters and need no
     * index — see the note beside `q` for why an unbounded one would not be acceptable.
     */
    errorsOnly?: boolean;
    category?: string;
    code?: string;
    source: 'ring' | 'persisted';
    limit: number;
    /** Cursor, never an offset. See `nextBefore`. */
    before?: string;
}

export interface LogQueryResult {
    sourceUsed: 'ring' | 'persisted';
    sourceReason: string | null;
    entries: LogRecord[];
    nextBefore: string | null;
    meta: {
        persistence: Record<string, unknown>;
        ring: Record<string, unknown>;
        warning: string;
    };
}

const PII_WARNING =
    'Log lines are free text and can contain personal data — an email in an SMTP failure, a phone '
    + 'number in a WhatsApp send error, an address in a geocoding warning. The scrubber removes '
    + 'credential SHAPES, never personal data.';

/** Levels at or above `floor`. Cheaper and simpler than storing a numeric rank alongside. */
function levelsAtOrAbove(floor: LogLevel): LogLevel[] {
    const min = levelRank(floor);
    return LOG_LEVELS.filter((level) => levelRank(level) >= min);
}

export async function queryLogs(input: LogQueryInput): Promise<LogQueryResult> {
    const ring = logRing();
    const persistence = logMongoSink.describe();

    const meta = {
        persistence,
        ring: ring.stats() as unknown as Record<string, unknown>,
        warning: PII_WARNING,
    };

    if (input.source === 'ring') {
        return {
            sourceUsed: 'ring',
            sourceReason: null,
            entries: ring.query({
                level: input.level,
                since: input.since,
                until: input.until,
                requestId: input.requestId,
                q: input.q,
                limit: input.limit,
            }),
            // The ring is a fixed window, not a paginated store: a cursor over something that
            // evicts from BOTH ends while you read it would hand back duplicates and gaps.
            nextBefore: null,
            meta,
        };
    }

    /**
     * Fall back rather than fail. Persistence is off by default outside production, and a
     * developer asking for logs on their laptop should get the ring with an explanation, not an
     * empty list that looks like "nothing happened".
     */
    const unavailable = persistenceUnavailableReason();
    if (unavailable !== null) {
        return {
            sourceUsed: 'ring',
            sourceReason: unavailable,
            entries: ring.query({
                level: input.level,
                since: input.since,
                until: input.until,
                requestId: input.requestId,
                q: input.q,
                limit: input.limit,
            }),
            nextBefore: null,
            meta,
        };
    }

    const db = mongoose.connection.db as NonNullable<typeof mongoose.connection.db>;
    const filter: Record<string, unknown> = {};

    if (input.level) filter.level = { $in: levelsAtOrAbove(input.level) };

    if (input.since || input.until) {
        const range: Record<string, Date> = {};
        if (input.since) range.$gte = input.since;
        // Half-open [since, until), the same convention the rest of this codebase uses.
        if (input.until) range.$lt = input.until;
        filter.at = range;
    }

    if (input.requestId) filter.requestId = input.requestId;

    if (input.errorsOnly) filter['httpError.code'] = { $exists: true };
    if (input.category) filter['httpError.category'] = input.category;
    if (input.code) filter['httpError.code'] = input.code;

    /**
     * The search term is escaped and applied as a LITERAL.
     *
     * A caller-supplied `$regex` is both a ReDoS against this process and a scan amplifier
     * against a collection with no text index. `$where` appears nowhere on this path and is
     * asserted absent by `test:system`'s safe-boundaries section.
     */
    if (input.q) filter.msg = { $regex: escapeRegex(input.q), $options: 'i' };

    if (input.before && mongoose.Types.ObjectId.isValid(input.before)) {
        filter._id = { $lt: new mongoose.Types.ObjectId(input.before) };
    }

    /**
     * `$natural: -1`, not `{ at: -1 }`.
     *
     * In a capped collection insertion order IS time order, so the natural scan is exactly the
     * query we want and costs no index. That is the fourth reason the collection is capped
     * rather than TTL'd, and it is why there is deliberately no index on `at`.
     */
    const rows = await db
        .collection(COLLECTIONS.SYSTEM_LOG)
        .find(filter)
        .sort({ $natural: -1 })
        .limit(input.limit)
        .toArray();

    const entries = rows.map(toRecord);
    const last = rows[rows.length - 1];

    return {
        sourceUsed: 'persisted',
        sourceReason: null,
        entries,
        // Only when the page was full — otherwise the caller has reached the end and a cursor
        // would invite one more round trip that returns nothing.
        nextBefore: rows.length === input.limit && last ? String(last._id) : null,
        meta,
    };
}

function persistenceUnavailableReason(): string | null {
    const config = loggingConfig();
    if (!config.PERSIST_ENABLED) {
        return 'LOG_PERSIST_ENABLED is false in this process — served from the in-memory ring instead.';
    }
    const state = logMongoSink.state();
    if (state !== 'active') {
        return `The persistence sink is "${state}" — served from the in-memory ring instead.`;
    }
    if (mongoose.connection.readyState !== 1) {
        return 'Mongo is not connected — served from the in-memory ring instead.';
    }
    return null;
}

function toRecord(row: Record<string, unknown>): LogRecord {
    const at = row.at;
    return {
        at: at instanceof Date ? at.toISOString() : String(at ?? ''),
        level: (row.level as LogLevel) ?? 'info',
        msg: String(row.msg ?? ''),
        source: row.source === 'console' ? 'console' : 'logger',
        requestId: typeof row.requestId === 'string' ? row.requestId : null,
        actorId: typeof row.actorId === 'string' ? row.actorId : null,
        ...(typeof row.method === 'string' ? { method: row.method } : {}),
        ...(typeof row.routeGroup === 'string' ? { routeGroup: row.routeGroup } : {}),
        ...(typeof row.status === 'number' ? { status: row.status } : {}),
        ...(typeof row.durationMs === 'number' ? { durationMs: row.durationMs } : {}),
        ...(typeof row.path === 'string' ? { path: row.path } : {}),
        ...(row.err ? { err: row.err as LogRecord['err'] } : {}),
        // The whole Phase-16 error record travels as one field. Omitting it here would
        // write the data and then silently drop it on read, which is exactly the failure
        // `log-record.ts`'s closed-shape header warns about.
        ...(row.httpError ? { httpError: row.httpError as LogRecord['httpError'] } : {}),
    };
}
