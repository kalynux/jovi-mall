/**
 * Every assumption the logging subsystem depends on, as a value.
 *
 * Same shape and same rule as `modules/system/config/system.config.ts`: a frozen object built at
 * import time, never a literal in a rule and never a bare `process.env` read at a call site.
 *
 * ── Why this is read lazily, unlike the other config modules ──────────────────
 * Every other `*.config.ts` here freezes at import. This one cannot: `initLogging()` runs at the
 * very top of `startServer()`, and a test that sets `LOG_RING_SIZE` before requiring the module
 * would otherwise be reading a value frozen by whichever import happened first. `loggingConfig()`
 * memoises after the first call, which is after `dotenv/config` in every real path.
 */

function intEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(key: string, fallback: boolean): boolean {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    return raw === 'true' || raw === '1';
}

/** Levels this subsystem understands, weakest first. Mirrors pino's own ordering. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
    trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
});

export function levelRank(level: string): number {
    return LEVEL_RANK[level as LogLevel] ?? 0;
}

export function isLogLevel(value: string): value is LogLevel {
    return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * The floor a persisted level may not go below.
 *
 * `debug` persistence turns a capped collection over in minutes and evicts exactly the errors
 * the collection exists to keep — so the clamp protects the feature from its own configuration
 * rather than protecting the database. Asserted in `test:system`.
 */
export const MIN_PERSIST_LEVEL: LogLevel = 'info';

export interface LoggingConfig {
    LEVEL: LogLevel;
    /** Rewire `console.*` through the logger. The kill switch — see `console-bridge.ts`. */
    CONSOLE_BRIDGE: boolean;
    /**
     * Whether the primary human-readable stream is attached.
     *
     * On in every real process — stdout is how an operator tails a container. Off in the test
     * suite, which asserts against the ring buffer and would otherwise interleave every logged
     * line with its own output, making a failure unreadable.
     */
    STDOUT: boolean;
    /** Bound applied BEFORE scrubbing, so a 2 MB payload dump does not run seven regexes. */
    MAX_MESSAGE_BYTES: number;
    /** Stack traces are the reason to have this at all; they are still not unbounded. */
    MAX_STACK_BYTES: number;
    RING_SIZE: number;
    RING_MAX_BYTES: number;
    /** One `info` line per finished request, off the metrics middleware's existing hook. */
    HTTP_ACCESS: boolean;

    // ── Persistence (J2) ──────────────────────────────────────────────────────
    PERSIST_ENABLED: boolean;
    PERSIST_LEVEL: LogLevel;
    MONGO_CAP_BYTES: number;
    MONGO_CAP_MAX_DOCS: number;
    MONGO_MAX_INFLIGHT: number;
    SINK_FAILURE_STREAK: number;
    SINK_COOLDOWN_MS: number;
    SINK_ERROR_THROTTLE_MS: number;
    SINK_FLUSH_BUDGET_MS: number;
}

let cached: Readonly<LoggingConfig> | null = null;

export function loggingConfig(): Readonly<LoggingConfig> {
    if (cached) return cached;

    const isProduction = process.env.NODE_ENV === 'production';

    const rawLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
    const level: LogLevel = isLogLevel(rawLevel) ? rawLevel : 'info';

    const rawPersist = (process.env.LOG_PERSIST_LEVEL ?? 'warn').toLowerCase();
    const askedPersist: LogLevel = isLogLevel(rawPersist) ? rawPersist : 'warn';
    const persistLevel: LogLevel =
        levelRank(askedPersist) < levelRank(MIN_PERSIST_LEVEL) ? MIN_PERSIST_LEVEL : askedPersist;

    cached = Object.freeze({
        LEVEL: level,
        CONSOLE_BRIDGE: boolEnv('LOG_CONSOLE_BRIDGE', true),
        STDOUT: boolEnv('LOG_STDOUT', true),
        MAX_MESSAGE_BYTES: intEnv('LOG_MAX_MESSAGE_BYTES', 8192),
        MAX_STACK_BYTES: intEnv('LOG_MAX_STACK_BYTES', 4096),
        RING_SIZE: intEnv('LOG_RING_SIZE', 2000),
        RING_MAX_BYTES: intEnv('LOG_RING_MAX_BYTES', 8 * 1024 * 1024),
        HTTP_ACCESS: boolEnv('LOG_HTTP_ACCESS', isProduction),

        /**
         * Default **true in production only**. The whole justification for persisting is "the
         * error survives the restart you go looking for it after", and that argument does not
         * apply to `npm run dev` against a shared database — where it would only add write load
         * and a collection nobody reads.
         */
        PERSIST_ENABLED: boolEnv('LOG_PERSIST_ENABLED', isProduction),
        PERSIST_LEVEL: persistLevel,
        MONGO_CAP_BYTES: intEnv('LOG_MONGO_CAP_BYTES', 256 * 1024 * 1024),
        MONGO_CAP_MAX_DOCS: intEnv('LOG_MONGO_CAP_MAX_DOCS', 500_000),
        MONGO_MAX_INFLIGHT: intEnv('LOG_MONGO_MAX_INFLIGHT', 100),
        SINK_FAILURE_STREAK: intEnv('LOG_SINK_FAILURE_STREAK', 20),
        SINK_COOLDOWN_MS: intEnv('LOG_SINK_COOLDOWN_MS', 60_000),
        SINK_ERROR_THROTTLE_MS: intEnv('LOG_SINK_ERROR_THROTTLE_MS', 60_000),
        SINK_FLUSH_BUDGET_MS: intEnv('LOG_SINK_FLUSH_BUDGET_MS', 1000),
    });

    return cached;
}

/** Test-only. The real process reads config once and keeps it. */
export function __resetLoggingConfigForTests(): void {
    cached = null;
}
