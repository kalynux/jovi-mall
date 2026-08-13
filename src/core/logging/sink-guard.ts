/**
 * The two things that stop a log sink from becoming an infinite loop.
 *
 * ── 1. The original console methods, captured at MODULE LOAD ──────────────────
 * `console-bridge.ts` imports this module, so ES module evaluation order guarantees this file
 * runs before anything swaps `console.*`. Every sink's own last-resort diagnostic goes through
 * `originalConsole`, never through `console` (which may be the bridge) and never through the
 * logger (which is what failed).
 *
 * Capturing lazily inside a function would be a real bug rather than a style choice: the first
 * caller might be a sink failing AFTER the bridge installed, and it would then capture the
 * bridge and report its own failure into the thing that is failing.
 *
 * ── 2. The reentrancy flag ────────────────────────────────────────────────────
 * A sink that logs produces a line that reaches the sink. `runInSink` drops any nested
 * invocation and counts it, so the recursion terminates at depth one instead of blowing the
 * stack while the process is already in trouble.
 */

export const originalConsole = Object.freeze({
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
});

let inSink = false;
let suppressed = 0;

/** Run a sink body, dropping the call entirely if a sink is already on the stack. */
export function runInSink(fn: () => void): void {
    if (inSink) {
        suppressed += 1;
        return;
    }
    inSink = true;
    try {
        fn();
    } catch {
        // A sink must never propagate. The failure is counted by the sink itself; throwing here
        // would surface inside whatever business code happened to be logging.
    } finally {
        inSink = false;
    }
}

export function suppressedSinkCalls(): number {
    return suppressed;
}

/**
 * Rate-limited diagnostic for a sink that is failing.
 *
 * A sink failing usually fails for every line, so an unthrottled report is itself a log storm.
 * Returns whether it actually emitted, so callers can count the rest.
 */
export function makeThrottledReporter(intervalMs: number): (message: string) => boolean {
    let lastAt = 0;
    return (message: string): boolean => {
        const now = Date.now();
        if (now - lastAt < intervalMs) return false;
        lastAt = now;
        originalConsole.error(message);
        return true;
    };
}

/** Test-only. */
export function __resetSinkGuardForTests(): void {
    inSink = false;
    suppressed = 0;
}
