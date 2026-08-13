import { format } from 'util';
import { logger } from './logger';
import { originalConsole } from './sink-guard';

/**
 * Routes `console.*` through the structured logger.
 *
 * ── Why this exists rather than a codemod ─────────────────────────────────────
 * There are ~565 `console.*` call sites in `src/`, and **311 of them are `console.error`**.
 * Those are precisely the lines Phase 15 promises will survive the restart you go looking for
 * them after — so without this shim, the sinks would never see the output that matters most.
 * Rewriting 565 sites by hand, in a repo with a part-applied agent-contract refactor, is an
 * unreviewable diff and a merge-conflict generator.
 *
 * ── Sell it honestly: capture, levels, correlation, stacks. NOT a security control ─
 * What this buys is real: every existing line gains a level, a timestamp, a `requestId` from
 * the ALS mixin, and — where an `Error` was passed — a structured, searchable stack. What it
 * does NOT buy is redaction: the scrubber that runs over these messages is a heuristic net
 * (`scrub.ts` says so in its own header). Moving credential-adjacent call sites onto the
 * structured logger properly remains a named debt.
 *
 * ── Three conditions, all enforced here ───────────────────────────────────────
 *  1. **Installed explicitly** from `server.ts`, never as an import side effect. A module whose
 *     import silently rewires `console` is the version of this idea that is too clever.
 *  2. **`LOG_CONSOLE_BRIDGE=false` restores native behaviour** with no code change — the kill
 *     switch that makes the whole thing reversible during an incident.
 *  3. **Only the five level-shaped methods.** `console.table`, `dir`, `trace`, `time`, `group`
 *     and the rest stay native, because they are formatting tools rather than log levels and a
 *     line-oriented logger renders them worse than the console does. Asserted in `test:system`
 *     so nobody "completes" the set later.
 */

/** `console` method → pino level. `log` is an alias for `info`, as every logger treats it. */
const METHOD_LEVELS = {
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error',
    debug: 'debug',
} as const;

export const BRIDGED_METHODS = Object.freeze(Object.keys(METHOD_LEVELS) as Array<keyof typeof METHOD_LEVELS>);

let installed = false;

function emit(level: 'info' | 'warn' | 'error' | 'debug', args: unknown[]): void {
    /**
     * An `Error` argument becomes pino's `err` binding rather than text.
     *
     * This is the single biggest free win in the phase: it converts 311 existing
     * `console.error('something failed:', err)` sites into structured errors with a searchable
     * `err.stack`, without touching one of them.
     */
    const errorArg = args.find((arg) => arg instanceof Error) as Error | undefined;
    const rest = errorArg ? args.filter((arg) => arg !== errorArg) : args;

    // `util.format` is what `console.*` itself uses, so `%s`/`%d` placeholders and object
    // inspection render exactly as the author expected them to.
    const message = rest.length > 0 ? format(...(rest as [unknown, ...unknown[]])) : '';

    const bindings = errorArg ? { source: 'console', err: errorArg } : { source: 'console' };
    logger()[level](bindings, message);
}

/** Swap the five level-shaped console methods. Idempotent. */
export function installConsoleBridge(): void {
    if (installed) return;
    installed = true;

    for (const method of BRIDGED_METHODS) {
        const level = METHOD_LEVELS[method];
        console[method] = (...args: unknown[]): void => {
            emit(level, args);
        };
    }
}

/** Restore the captured originals. Used by the kill switch path and by tests. */
export function uninstallConsoleBridge(): void {
    if (!installed) return;
    installed = false;
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
}

export function isConsoleBridgeInstalled(): boolean {
    return installed;
}
