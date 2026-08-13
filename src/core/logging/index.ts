import { loggingConfig } from './logging.config';
import { logger, logRing } from './logger';
import { installConsoleBridge, uninstallConsoleBridge } from './console-bridge';
import { logMongoSink } from './mongo-sink';
import { originalConsole } from './sink-guard';

export { logger, logRing, childLogger, REDACTED_PATHS } from './logger';
export { logMongoSink } from './mongo-sink';
export { scrubText, truncateMessage, SCRUBBED_FIELD_NAMES } from './scrub';
export { LogRingBuffer, RING_SCOPE_NOTE } from './ring-buffer';
export type { RingStats, RingQuery } from './ring-buffer';
export type { LogRecord } from './log-record';
export { parseLogLine, recordBytes } from './log-record';
export { runWithRequestContext, currentRequestContext, stampContextActor } from './request-context';
export type { RequestContext } from './request-context';
export {
    installConsoleBridge,
    uninstallConsoleBridge,
    isConsoleBridgeInstalled,
    BRIDGED_METHODS,
} from './console-bridge';
export { loggingConfig, LOG_LEVELS, levelRank, isLogLevel, MIN_PERSIST_LEVEL } from './logging.config';
export type { LogLevel } from './logging.config';

/**
 * Logging comes up in TWO phases, and the split is load-bearing.
 *
 * `initLogging()` runs at the very top of `startServer()` — after `dotenv/config` so `LOG_LEVEL`
 * is readable, and **before** `assertSigningSecrets()` so a refused boot is itself captured.
 * Only the ring buffer is live at that point.
 *
 * `enableLogPersistence()` runs after `mongoose.connect` resolves, because the Mongo sink
 * obviously cannot write before there is a connection.
 *
 * Lines produced between the two land in the ring only. That is honest rather than lossy, and
 * it is visible: `/system/logs` reports the sink's state, so an operator can see the boundary
 * instead of wondering why the first few seconds of a boot are missing from the collection.
 */
let started = false;

export function initLogging(): void {
    if (started) return;
    started = true;

    const config = loggingConfig();

    // Build the instance eagerly so a misconfiguration surfaces here, at a readable point in
    // the boot, rather than on the first line somebody tries to log.
    logger();
    logRing();

    if (config.CONSOLE_BRIDGE) {
        installConsoleBridge();
    }

    logger().info(
        {
            level: config.LEVEL,
            consoleBridge: config.CONSOLE_BRIDGE,
            ringSize: config.RING_SIZE,
            persistLevel: config.PERSIST_LEVEL,
            persistEnabled: config.PERSIST_ENABLED,
        },
        'logging initialised',
    );
}

/** Enable the capped-collection sink. Safe to call when persistence is disabled — it no-ops. */
export async function enableLogPersistence(): Promise<void> {
    await logMongoSink.enable();

    /**
     * The log subsystem flushes its OWN buffer on the way out. It is deliberately not a
     * graceful-shutdown path: nothing here stops the listener, the thirteen timers, or Mongo.
     * Wiring those is its own change with its own ordering argument (ADR-015, debts).
     */
    const onExit = (): void => {
        void logMongoSink.flush().catch(() => {
            /* best effort, by definition */
        });
    };
    process.once('SIGTERM', onExit);
    process.once('beforeExit', onExit);

    const facts = logMongoSink.describe();
    if (facts.enabled) {
        logger().info(facts, 'log persistence enabled');
    } else if (facts.note) {
        // Through the logger, not the original console: this is ordinary boot information.
        logger().info(facts, 'log persistence not enabled');
    }
}

/** The kill switch's other half, for completeness and for tests. */
export function disableConsoleBridge(): void {
    uninstallConsoleBridge();
    originalConsole.info('[logging] console bridge uninstalled — console.* is native again');
}
