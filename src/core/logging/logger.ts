import pino, { Logger, LoggerOptions, StreamEntry } from 'pino';
import { SENSITIVE_FIELD_NAMES } from '../audit/redact';
import { loggingConfig } from './logging.config';
import { scrubText, truncateMessage } from './scrub';
import { LogRingBuffer } from './ring-buffer';
import { parseLogLine } from './log-record';
import { currentRequestContext } from './request-context';
import { runInSink } from './sink-guard';
import { logMongoSink } from './mongo-sink';

/**
 * Structured logging with mandatory redaction.
 *
 * This service logged with `console.*` from its first commit — 1268 call sites, no levels, no
 * redaction, nothing queryable. wi-admin's `core/logging/logger.ts` header records what that
 * costs: a **refresh token** written to stdout on every silent refresh. This file is the
 * deliberate convergence, and it is kept diffable against wi-admin's on purpose.
 *
 * ── Redaction is two layers, and only the first is a boundary ─────────────────
 * `REDACTED_PATHS` is exact and operates on object KEYS — that is the security boundary, and
 * adding a credential-shaped field to a logged object without adding it there reintroduces the
 * defect. `scrub.ts` is a heuristic net over rendered strings, and its own header says so.
 *
 * ── Why `multistream` and not `transport` ─────────────────────────────────────
 * pino's `transport` option and a destination stream are **mutually exclusive**. wi-admin uses
 * `transport: {target: 'pino-pretty'}`, and copying that here would make it impossible to
 * attach the ring buffer and the Mongo sink at all — the failure is a runtime throw at logger
 * construction, not a quiet degradation. So pino-pretty is used as a STREAM in development,
 * and our sinks run on the main thread, where they cannot be stranded in a transport worker at
 * exit.
 */

/**
 * Exact key paths whose value is replaced before anything is written.
 *
 * **Derived, never retyped.** `SENSITIVE_FIELD_NAMES` is the audit sanitiser's set, and wi-admin's
 * `test-audit.ts` already fails if the two services' sets drift — so deriving from it means this
 * list inherits that guarantee instead of becoming a third copy that rots.
 *
 * The `/^[a-z0-9_]+$/` filter is load-bearing, not tidiness: that set deliberately carries two
 * bracketed PATH FRAGMENTS (`headers["x-service-token`) which exist only so the cross-service
 * name comparison lines up. They are not valid pino paths and pino **throws at construction**
 * on an invalid path, so an unfiltered spread would take the process down at boot.
 */
const SENSITIVE_LEAVES: readonly string[] = Object.freeze(
    [...SENSITIVE_FIELD_NAMES].filter((name) => /^[a-z0-9_]+$/.test(name)),
);

export const REDACTED_PATHS: readonly string[] = Object.freeze([
    // Headers that carry a credential verbatim.
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-service-token"]',
    'req.headers["x-internal-token"]',
    'res.headers["set-cookie"]',
    // Credential-shaped fields as a top-level binding, and one level down.
    ...SENSITIVE_LEAVES,
    ...SENSITIVE_LEAVES.map((name) => `*.${name}`),
]);

let instance: Logger | null = null;
let ring: LogRingBuffer | null = null;

/** The recent-lines buffer. Created by `initLogging()`; never null once the logger exists. */
export function logRing(): LogRingBuffer {
    if (!ring) logger();
    return ring as LogRingBuffer;
}

function buildRingStream(buffer: LogRingBuffer, maxStackBytes: number): { write(line: string): void } {
    return {
        write(line: string): void {
            runInSink(() => {
                const record = parseLogLine(line, maxStackBytes);
                if (record === null) buffer.noteUnparseable();
                else buffer.push(record);
            });
        },
    };
}

function buildStreams(): StreamEntry[] {
    const config = loggingConfig();
    const isProduction = process.env.NODE_ENV === 'production';

    ring = new LogRingBuffer(config.RING_SIZE, config.RING_MAX_BYTES);

    const streams: StreamEntry[] = [];

    if (!config.STDOUT) {
        // Nothing pushed. The ring and the Mongo sink below are still attached, which is what
        // the test suite asserts against.
    } else if (isProduction) {
        streams.push({ level: config.LEVEL, stream: process.stdout });
    } else {
        // Lazily required so a production process never loads the pretty-printer, and so its
        // worker-thread machinery is not paid for on every `ts-node-dev --respawn` restart.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pretty = require('pino-pretty') as (options: Record<string, unknown>) => NodeJS.WritableStream;
        streams.push({
            level: config.LEVEL,
            stream: pretty({ colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' }),
        });
    }

    streams.push({ level: config.LEVEL, stream: buildRingStream(ring, config.MAX_STACK_BYTES) });

    /**
     * The Mongo sink is attached HERE, at construction, even though persistence is enabled later
     * by `enableLogPersistence()` once Mongo is connected. `pino.multistream` fixes its stream
     * set at construction, so the alternative is rebuilding the logger mid-process and losing
     * every reference already handed out. The sink is simply inert until enabled.
     */
    streams.push({ level: config.PERSIST_LEVEL, stream: logMongoSink.stream() });

    return streams;
}

function buildOptions(): LoggerOptions {
    const config = loggingConfig();

    return {
        level: config.LEVEL,
        redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
        base: { service: 'jovi-mall' },
        formatters: {
            // Emit `"level":"info"` rather than pino's numeric default, so a line is readable
            // without a decoder ring — and so the sinks can store the label directly.
            level: (label) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,

        /**
         * Stated rather than relied upon. pino applies this to `err` by default, but the
         * console bridge's whole "311 `console.error(msg, err)` sites become structured
         * stacks" claim rests on it — so it is declared here where that claim can be checked.
         */
        serializers: { err: pino.stdSerializers.err },

        /**
         * Stamp every line with the ambient request context.
         *
         * This is the whole reason the ALS exists: a `mixin` reaches lines produced by code
         * that never saw `req`, including bridged `console.*` calls, which a child logger
         * structurally cannot.
         */
        mixin() {
            const context = currentRequestContext();
            if (!context) return {};
            return {
                requestId: context.requestId,
                ...(context.actorId ? { actorId: context.actorId } : {}),
            };
        },

        hooks: {
            /**
             * Truncate then scrub every string argument.
             *
             * In the hook rather than in the console bridge deliberately: a hand-written
             * `logger.info('token ' + tok)` bypasses the bridge entirely, and those are exactly
             * the call sites a future author writes *because* the logger now exists. One hook
             * covers the bridge and every direct call.
             */
            logMethod(args: unknown[], method): void {
                const config2 = loggingConfig();
                const cleaned = args.map((arg) =>
                    typeof arg === 'string'
                        ? scrubText(truncateMessage(arg, config2.MAX_MESSAGE_BYTES))
                        : arg,
                );
                method.apply(this, cleaned as Parameters<typeof method>);
            },
        },
    };
}

/**
 * The root logger.
 *
 * Built lazily so `logging.config.ts` can read a populated `process.env` first — a config
 * failure should print a plain readable message, not arrive pre-formatted as JSON from a logger
 * that may itself be misconfigured.
 */
export function logger(): Logger {
    if (instance) return instance;
    instance = pino(buildOptions(), pino.multistream(buildStreams(), { dedupe: false }));
    return instance;
}

/**
 * A logger bound to one correlation id.
 *
 * Rarely needed now that the `mixin` stamps every line automatically — it exists for the
 * worker paths, which have no ambient request but do have a job identity worth carrying.
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
    return logger().child(bindings);
}

/** Test-only. Drops the instance so the next call rebuilds from current env. */
export function __resetLoggerForTests(): void {
    instance = null;
    ring = null;
}
