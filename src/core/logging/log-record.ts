import { LogLevel, isLogLevel } from './logging.config';

/**
 * One log line, as both sinks store it and as `/system/logs` serves it.
 *
 * Deliberately a NAMED, closed shape rather than "whatever pino emitted". Same argument
 * ADR-014 D-3 makes about the metrics projection: a dependency's internal record shape is not
 * our wire contract, and pinning it here keeps adding a binding a one-repo change instead of a
 * dashboard break. It also bounds what a log row can cost — an unbounded passthrough would let
 * one `console.log(hugeObject)` put a megabyte in the ring and in Mongo.
 */
export interface LogRecord {
    /** ISO-8601. pino is configured with `stdTimeFunctions.isoTime` so this is not a rebuild. */
    at: string;
    level: LogLevel;
    msg: string;
    /**
     * Where the line entered the logger.
     *
     * A bridged `console.*` call carries no component binding — recovering the calling module
     * would need a stack capture per call, which is far too expensive on this path. Reporting
     * the provenance makes that absence legible rather than mysterious.
     */
    source: 'console' | 'logger';
    /** From the AsyncLocalStorage request context; null for worker and boot lines. */
    requestId: string | null;
    /** The wi-admin administrator, when the line was produced under an internal-admin call. */
    actorId: string | null;
    /** Present on HTTP access lines only. `routeGroup`, never the raw path — see the metrics rule. */
    method?: string;
    routeGroup?: string;
    status?: number;
    durationMs?: number;
    /** Set when the raw path was attached (warn+ only), so 4xx/5xx stay diagnosable. */
    path?: string;
    err?: { type: string; message: string; stack: string | null } | null;
    /**
     * The Phase-16 error record, present on lines the global error handler produced.
     *
     * ── Why ONE nested object rather than a dozen sibling fields ──────────────
     * `parseLogLine` below assigns every persisted field BY NAME, deliberately — see this
     * file's header. Adding twelve top-level fields would mean twelve edits here, twelve in
     * `log-query.service.ts`'s `toRecord`, and a thirteenth forgotten one silently dropped
     * on read. One object is one edit in each place, and the shape stays closed.
     *
     * `internalMessage` and `details` are the halves that never reach a client for a
     * masked category. They are the reason this record exists: the whole exposure ladder is
     * "what did the caller see, and what actually happened", and both have to be stored to
     * be answerable later.
     */
    httpError?: HttpErrorRecord | null;
}

/** The error half of a log line. See `api/middlewares/error-handler.middleware.ts`. */
export interface HttpErrorRecord {
    category: string;
    code: string;
    statusCode: number;
    routeGroup: string;
    /** The platform role that made the request; null for anonymous and internal callers. */
    actorRole: string | null;
    /** What we actually sent. Safe to show Support — it is what the caller already read. */
    clientMessage: string;
    /** What the code threw. NOT safe to show Support: free text, and possibly PII. */
    internalMessage: string;
    /** Unfiltered. `{ cause: <gateway prose> }` lives here and nowhere else. */
    details: Record<string, unknown> | null;
    causeMessage: string | null;
    /** True when `clientMessage` differs from `internalMessage` — i.e. the category is masked. */
    masked: boolean;
}

/**
 * Parse one NDJSON line from pino into a `LogRecord`.
 *
 * Never throws — a sink that throws while parsing a log line would take down whatever was being
 * logged. An unparseable line returns null and is counted, not raised.
 */
export function parseLogLine(line: string, maxStackBytes: number): LogRecord | null {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;

    const level = typeof raw.level === 'string' && isLogLevel(raw.level) ? raw.level : 'info';
    const at = typeof raw.time === 'string' ? raw.time : new Date().toISOString();

    const record: LogRecord = {
        at,
        level,
        msg: typeof raw.msg === 'string' ? raw.msg : '',
        source: raw.source === 'console' ? 'console' : 'logger',
        requestId: null,
        actorId: null,
    };

    // Assigned by name rather than through an index signature: the point of a closed record
    // shape is that adding a field here is a deliberate edit, and a loop with a cast would
    // quietly accept anything pino happened to emit.
    if (typeof raw.requestId === 'string') record.requestId = raw.requestId;
    if (typeof raw.actorId === 'string') record.actorId = raw.actorId;
    if (typeof raw.method === 'string') record.method = raw.method;
    if (typeof raw.routeGroup === 'string') record.routeGroup = raw.routeGroup;
    if (typeof raw.status === 'number') record.status = raw.status;
    if (typeof raw.durationMs === 'number') record.durationMs = raw.durationMs;
    if (typeof raw.path === 'string') record.path = raw.path;

    const httpError = raw.httpError as Record<string, unknown> | undefined;
    if (httpError && typeof httpError === 'object') {
        // Bounded on the way in, the same way the stack below is. A hot 502 carrying a fat
        // `details` would otherwise roll the capped collection in minutes and evict the
        // records somebody is trying to look up.
        record.httpError = {
            category: String(httpError.category ?? 'internal'),
            code: String(httpError.code ?? 'INTERNAL_SERVER_ERROR'),
            statusCode: typeof httpError.statusCode === 'number' ? httpError.statusCode : 500,
            routeGroup: String(httpError.routeGroup ?? 'other'),
            actorRole: typeof httpError.actorRole === 'string' ? httpError.actorRole : null,
            clientMessage: String(httpError.clientMessage ?? ''),
            internalMessage: truncate(String(httpError.internalMessage ?? ''), maxStackBytes),
            details: boundDetails(httpError.details, maxStackBytes),
            causeMessage: typeof httpError.causeMessage === 'string'
                ? truncate(httpError.causeMessage, maxStackBytes)
                : null,
            masked: httpError.masked === true,
        };
    }

    const err = raw.err as { type?: unknown; message?: unknown; stack?: unknown } | undefined;
    if (err && typeof err === 'object') {
        const stack = typeof err.stack === 'string' ? err.stack : null;
        record.err = {
            type: typeof err.type === 'string' ? err.type : 'Error',
            message: typeof err.message === 'string' ? err.message : '',
            // A stack is the reason to keep the error at all, and still not unbounded.
            stack: stack !== null && stack.length > maxStackBytes ? `${stack.slice(0, maxStackBytes)}…` : stack,
        };
    }

    return record;
}

/** Rough retained size of a record, for the ring buffer's byte budget. */
export function recordBytes(record: LogRecord): number {
    return (
        record.msg.length
        + (record.err?.stack?.length ?? 0)
        + (record.err?.message.length ?? 0)
        // Fixed overhead for the scalar fields and object headers. An estimate on purpose: an
        // exact measure would cost a JSON.stringify per line on the hottest path in the process.
        + 200
    );
}

function truncate(value: string, maxBytes: number): string {
    return value.length > maxBytes ? `${value.slice(0, maxBytes)}…` : value;
}

/**
 * Keep `details` only while it stays within the same byte budget a stack gets.
 *
 * An oversized payload is replaced by a marker rather than trimmed: half a JSON object is
 * not a smaller JSON object, and a reader who sees `{ truncated: true }` at least knows to
 * go and look at the source rather than trusting a fragment.
 */
function boundDetails(value: unknown, maxBytes: number): Record<string, unknown> | null {
    if (value === null || value === undefined || typeof value !== 'object') return null;
    let serialised: string;
    try {
        serialised = JSON.stringify(value);
    } catch {
        return { truncated: true, reason: 'circular' };
    }
    if (serialised.length > maxBytes) {
        return { truncated: true, bytes: serialised.length };
    }
    return value as Record<string, unknown>;
}
