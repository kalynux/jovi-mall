import type { Store, ClientRateLimitInfo, IncrementResponse } from 'express-rate-limit';
import { logger } from '../../core/logging';
import { recordRateLimitStoreError } from '../../modules/system/metrics/metrics';

/**
 * A store decorator that turns a backing-store failure into an ALLOWED request.
 *
 * ── The naive integration fails CLOSED, and that is the bug this exists for ────
 * `rate-limit-redis` calls `sendCommand`, which REJECTS when the client is down.
 * express-rate-limit surfaces that rejection into the middleware chain, so it becomes a
 * `500` — on **every request**, for as long as Redis is unreachable. Wiring the Redis store
 * in without this decorator does not add a rate limiter to the platform; it adds a
 * single point of failure in front of every route.
 *
 * So: a store error admits the request, logs once per throttle window, and increments a
 * counter. Failing open is the correct direction — the cost is that an attacker gets an
 * unlimited window while our cache is down, and the alternative is that a cache wobble
 * takes the whole platform offline. The counter is what stops that being a silent choice.
 *
 * ── Why a decorator rather than a library option ──────────────────────────────
 * express-rate-limit has options in this area that have moved between minor versions. A
 * decorator is behaviour we own and can test — `verify:rate-limit` kills the client
 * mid-test and asserts the next request is served — rather than behaviour that depends on
 * which patch release resolved.
 */
export class FailOpenStore implements Store {
    /**
     * Set once the backing store has failed, and never unset within a process.
     *
     * `skip` reads it so a dead Redis is not hammered with a doomed command on every
     * request. It is deliberately sticky rather than time-boxed: a half-open probe would
     * mean deciding how often to retry and what to do with the request used to find out,
     * and that is a circuit breaker. Until this service has one, "degrade for the life of
     * the process and say so loudly" is the honest simple behaviour, and a restart or a
     * redeploy recovers it.
     */
    private degraded = false;

    private lastReportedAt = 0;

    constructor(
        private readonly inner: Store,
        /** How often a store failure may produce a log line. Errors arrive per request. */
        private readonly reportIntervalMs = 60_000,
    ) {}

    /** True once the backing store has failed. Read by the middleware's `skip`. */
    get isDegraded(): boolean {
        return this.degraded;
    }

    init(options: Parameters<NonNullable<Store['init']>>[0]): void {
        this.inner.init?.(options);
    }

    async increment(key: string): Promise<IncrementResponse> {
        try {
            const result = await this.inner.increment(key);
            return result;
        } catch (error) {
            this.report(error, 'increment');
            // `totalHits: 0` is below every ceiling, so the request is admitted. Reporting
            // a hit count we did not observe would be a lie that eventually blocks somebody.
            return { totalHits: 0, resetTime: undefined };
        }
    }

    async decrement(key: string): Promise<void> {
        try {
            await this.inner.decrement(key);
        } catch (error) {
            this.report(error, 'decrement');
        }
    }

    async resetKey(key: string): Promise<void> {
        try {
            await this.inner.resetKey(key);
        } catch (error) {
            this.report(error, 'resetKey');
        }
    }

    async resetAll(): Promise<void> {
        try {
            await this.inner.resetAll?.();
        } catch (error) {
            this.report(error, 'resetAll');
        }
    }

    async get(key: string): Promise<ClientRateLimitInfo | undefined> {
        try {
            return await this.inner.get?.(key);
        } catch (error) {
            this.report(error, 'get');
            return undefined;
        }
    }

    /**
     * Count it always, log it rarely.
     *
     * The counter is the point: failing open must be VISIBLE. A log line per request during
     * an outage would bury everything else in the same stream an operator is trying to read
     * the outage from, so the line is throttled and the metric is not.
     */
    private report(error: unknown, operation: string): void {
        this.degraded = true;
        recordRateLimitStoreError(operation);

        const now = Date.now();
        if (now - this.lastReportedAt < this.reportIntervalMs) return;
        this.lastReportedAt = now;

        logger().error(
            { err: error instanceof Error ? error.message : String(error), operation },
            'rate-limit store unavailable — FAILING OPEN, requests are not being counted',
        );
    }
}
