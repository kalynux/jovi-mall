import { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RedisClientType } from 'redis';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { logger } from '../../core/logging';
import { getRedisClient, RATE_LIMIT_DB } from '../../infra/redis/redis.factory';
import { recordRateLimited } from '../../modules/system/metrics/metrics';
import { resolveCallerClass, rateLimitKey } from './caller-class';
import { isExemptPath } from './exempt-paths';
import { FailOpenStore } from './fail-open-store';
import { AUTH_POLICY, ceilingFor, GLOBAL_POLICY, IDENTITY_POLICY, PUBLIC_POLICY, RateLimitPolicy } from './policy';

/**
 * The rate limiters (Phase 16). jovi-mall had none of any kind before this.
 *
 * Three handlers, from one builder:
 *
 *   `globalRateLimiter`    Layer A — IP-scoped, mounted in `app.ts` before the routers.
 *   `identityRateLimiter`  Layer B — per-user, mounted at the TAIL of `requireAuth`.
 *   `authRateLimiter`      the credential bucket, on `/api/auth/*`.
 *
 * Why two layers rather than one, and why Layer A cannot simply read the caller's role, is
 * explained in `caller-class.ts` — briefly: classifying from an unverified JWT would hand a
 * forger the largest bucket.
 *
 * Every refusal leaves through `createAppError`, so a throttled caller gets the same
 * envelope, the same `requestId` and the same `category` as any other error, and a client
 * that already handles `error.code` needs no new branch to recognise `RATE_LIMIT_EXCEEDED`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Store lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stores are built ONCE and swapped, not rebuilt per request.
 *
 * Constructing a limiter inside a request handler is what express-rate-limit's
 * `ERR_ERL_CREATED_IN_REQUEST_HANDLER` warns about: the instance built there can end up
 * with per-request state instead of shared state, which silently defeats the limit while
 * looking exactly like a working one. wi-admin's `auth-rate-limit.middleware.ts` solved
 * this first and this is the same shape — build at app assembly with the memory store, swap
 * in Redis during boot once the connection exists.
 */
const built = new Map<string, RequestHandler>();
let sharedStore: FailOpenStore | null = null;

/**
 * Install the Redis-backed store. Called from `startServer()` after Mongo connects.
 *
 * Falls back to the in-memory store if Redis is unreachable, and says so. A per-process
 * limit still bounds an attacker — N instances multiply the effective ceiling by N, which
 * is a weaker limit, not an absent one — whereas refusing to build a limiter at all would
 * leave every endpoint open.
 */
export async function initRateLimiters(): Promise<void> {
    try {
        const client = (await getRedisClient(RATE_LIMIT_DB)) as RedisClientType;
        sharedStore = new FailOpenStore(
            new RedisStore({
                prefix: 'rl:',
                sendCommand: (...args: string[]) => client.sendCommand(args),
            }),
        );
        built.clear();
        logger().info('rate limiters using the shared Redis store');
    } catch (error) {
        logger().error(
            { err: error instanceof Error ? error.message : String(error) },
            'rate limiters falling back to the in-memory store — per-process limits only',
        );
    }
}

/** Test-only: drop the built handlers so a new ceiling or a fresh counter takes effect. */
export function resetRateLimiters(): void {
    built.clear();
    sharedStore = null;
}

/** True once the backing store has failed. Surfaced on the operations endpoint. */
export function rateLimitStoreDegraded(): boolean {
    return sharedStore?.isDegraded ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────────────

function build(policy: RateLimitPolicy): RequestHandler {
    return rateLimit({
        windowMs: policy.windowSeconds * 1000,

        // Per-caller ceiling, resolved per request. This is the whole per-user-type feature:
        // one limiter instance, a ceiling that depends on who is asking.
        limit: (req) => {
            const ceiling = ceilingFor(policy, resolveCallerClass(req));
            // `Infinity` rather than a large number — express-rate-limit compares against
            // it, and a large number is a limit somebody eventually reaches.
            return ceiling === 'exempt' ? Infinity : ceiling;
        },

        keyGenerator: (req) => `${policy.key}:${rateLimitKey(req, policy.scope)}`,

        // draft-7 `RateLimit` / `RateLimit-Policy`. No body-level `retryAfter` duplicate of
        // what the headers already carry — ADR-005 settled that for the platform.
        standardHeaders: 'draft-7',
        legacyHeaders: false,

        skip: (req) => {
            if (isExemptPath(req)) return true;
            // A dead store means every command is a doomed round trip. `FailOpenStore`
            // already admits the request; this stops us paying for the attempt.
            if (sharedStore?.isDegraded) return true;
            return ceilingFor(policy, resolveCallerClass(req)) === 'exempt';
        },

        ...(sharedStore ? { store: sharedStore } : {}),

        handler: (req, _res, next) => {
            const callerClass = resolveCallerClass(req);
            recordRateLimited(callerClass, policy.key);
            logger().warn(
                { policy: policy.key, callerClass, path: req.originalUrl ?? req.path },
                'rate limit exceeded',
            );
            next(createAppError(ERROR_CODES.RATE_LIMIT_EXCEEDED, 429, undefined, {
                retryAfterSeconds: policy.windowSeconds,
            }));
        },
    });
}

/**
 * Delegate to the current handler for a policy, building it on first use.
 *
 * The indirection is what lets `app.ts` and the routers mount these at import time while
 * the Redis-backed store is installed later during boot. Building here rather than inside
 * the request handler keeps the instance shared.
 */
function delegate(policy: RateLimitPolicy): RequestHandler {
    return (req, res, next) => {
        let handler = built.get(policy.key);
        if (!handler) {
            handler = build(policy);
            built.set(policy.key, handler);
        }
        return handler(req, res, next);
    };
}

/** Layer A — mounted in `app.ts`, before the routers. IP-scoped. */
export const globalRateLimiter: RequestHandler = delegate(GLOBAL_POLICY);

/** Layer B — mounted at the tail of `requireAuth`. Identity-scoped, per role. */
export const identityRateLimiter: RequestHandler = delegate(IDENTITY_POLICY);

/** The credential bucket — `/api/auth/*`. Strict, and the only strict one. */
export const authRateLimiter: RequestHandler = delegate(AUTH_POLICY);

/**
 * The storefront bucket — `/api/public/*`, mounted ahead of the public routers.
 *
 * Its own `policy.key` gives it its own counters, so anonymous browse traffic can no
 * longer exhaust the global backstop on behalf of every other caller sharing the address.
 * Layer A still applies on top; see `PUBLIC_POLICY` for why that is deliberate.
 */
export const publicRateLimiter: RequestHandler = delegate(PUBLIC_POLICY);
