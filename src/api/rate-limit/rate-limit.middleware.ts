import { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RedisClientType } from 'redis';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { logger } from '../../core/logging';
import { getRedisClient, RATE_LIMIT_DB } from '../../infra/redis/redis.factory';
import { recordRateLimited } from '../../modules/system/metrics/metrics';
import { isAuthSessionPathname } from './auth-paths';
import { resolveCallerClass, rateLimitKey } from './caller-class';
import { isExemptPath } from './exempt-paths';
import { FailOpenStore } from './fail-open-store';
import { AUTH_POLICY, AUTH_SESSION_POLICY, ceilingFor, CONNECTION_CODE_POLICY, GLOBAL_POLICY, IDENTITY_POLICY, PUBLIC_POLICY, RateLimitPolicy } from './policy';

/**
 * The rate limiters (Phase 16). jovi-mall had none of any kind before this.
 *
 * Five handlers, from one builder:
 *
 *   `globalRateLimiter`       Layer A — IP-scoped, mounted in `app.ts` before the routers.
 *   `identityRateLimiter`     Layer B — per-user, mounted at the TAIL of `requireAuth`.
 *   `authRateLimiter`         the credential bucket, the default under `/api/auth/*`.
 *   `authSessionRateLimiter`  the session bucket, for the named session-maintenance paths.
 *   `publicRateLimiter`       the storefront bucket, on `/api/public/*`.
 *
 * The two `/auth` buckets are selected by `authBucketDispatcher`, at the bottom of this file.
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
 * The limiters are built ONCE and swapped, not rebuilt per request.
 *
 * Constructing a limiter inside a request handler is what express-rate-limit's
 * `ERR_ERL_CREATED_IN_REQUEST_HANDLER` warns about: the instance built there can end up
 * with per-request state instead of shared state, which silently defeats the limit while
 * looking exactly like a working one. wi-admin's `auth-rate-limit.middleware.ts` solved
 * this first and this is the same shape — build at app assembly with the memory store, swap
 * in Redis during boot once the connection exists.
 *
 * ⚠ The CONNECTION is shared; the STORE is not, and must not be. express-rate-limit keeps a
 * WeakSet of every store object handed to a limiter and throws `ERR_ERL_STORE_REUSE` on the
 * second — so one `FailOpenStore` passed to all six policies builds the first limiter and
 * then throws inside the request that first touches any other one. Each policy therefore
 * gets its own `FailOpenStore` over its own `RedisStore`, all sharing the single Redis
 * client. Nothing about the counters changes: they were already separated by
 * `keyGenerator`, and are now separated by the key prefix as well.
 */
const built = new Map<string, RequestHandler>();

/** Mints a virgin store per limiter. `null` until `initRateLimiters` installs Redis. */
let storeFactory: ((policy: RateLimitPolicy) => FailOpenStore) | null = null;

/** Every store handed to a live limiter, so degradation stays observable across all of them. */
let stores: FailOpenStore[] = [];

/**
 * Install the Redis-backed stores. Called from `startServer()` after Mongo connects.
 *
 * Falls back to the in-memory store if Redis is unreachable, and says so. A per-process
 * limit still bounds an attacker — N instances multiply the effective ceiling by N, which
 * is a weaker limit, not an absent one — whereas refusing to build a limiter at all would
 * leave every endpoint open.
 */
export async function initRateLimiters(): Promise<void> {
    try {
        const client = (await getRedisClient(RATE_LIMIT_DB)) as RedisClientType;
        storeFactory = (policy) =>
            new FailOpenStore(
                new RedisStore({
                    // Per-policy prefix as well as a per-policy store instance. The
                    // `keyGenerator` below already namespaces by `policy.key` — it has to,
                    // because the MemoryStore fallback has no prefix at all — so this is
                    // belt and braces, and it makes the isolation structural rather than a
                    // property of a key format someone could later simplify.
                    prefix: `rl:${policy.key}:`,
                    sendCommand: (...args: string[]) => client.sendCommand(args),
                }),
            );
        stores = [];
        built.clear();
        logger().info('rate limiters using the shared Redis connection');
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
    storeFactory = null;
    stores = [];
}

/**
 * True once a backing store has failed. Surfaced on the operations endpoint.
 *
 * Any one of them is evidence for all of them — they share a single Redis client, so the
 * store that noticed is simply the one that happened to issue the next command.
 */
export function rateLimitStoreDegraded(): boolean {
    return stores.some((store) => store.isDegraded);
}

// ─────────────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────────────

function build(policy: RateLimitPolicy): RequestHandler {
    // A store of this limiter's own — see the note above `built`. `null` before
    // `initRateLimiters` has run, which leaves express-rate-limit's own MemoryStore.
    const store = storeFactory?.(policy) ?? null;
    if (store) stores.push(store);

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
            if (rateLimitStoreDegraded()) return true;
            return ceilingFor(policy, resolveCallerClass(req)) === 'exempt';
        },

        ...(store ? { store } : {}),

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

/** The credential bucket — the DEFAULT under `/api/auth/*`. Strict, and the only strict one. */
export const authRateLimiter: RequestHandler = delegate(AUTH_POLICY);

/** The session bucket — the named session-maintenance paths under `/api/auth/*`. */
export const authSessionRateLimiter: RequestHandler = delegate(AUTH_SESSION_POLICY);

/**
 * Chooses between the two `/api/auth` buckets. Mounted where `authRateLimiter` used to be.
 *
 * A dispatcher rather than two stacked mounts, because both would match the same prefix: a
 * session request would then be counted twice, and the second limiter's `RateLimit` headers
 * would overwrite the first's, so a client reading `remaining` would be told about a bucket
 * that was not the one binding it. Exactly one runs, so a request is counted once and the
 * headers describe the counter that actually applied.
 *
 * ⚠ `req.baseUrl + req.path`, never `req.path` alone. This is mounted with
 * `router.use('/auth', …)`, and inside a `use`-mounted layer Express has stripped the matched
 * prefix off `req.url`; `req.path` is a getter over it and reads `/mobile/refresh`. `req.path`
 * also never carries the query string, which reproduces `exempt-paths.ts`'s rule that a
 * caller-controlled query can never talk its way into a different bucket. Express matches
 * routes against the raw, un-decoded pathname, so `/api/auth/%6Dobile/refresh` misses the
 * router and this allowlist alike — the two agree by construction.
 *
 * (`isExemptPath`, inside `build()`, reads the relative `req.path` and has the same quirk. It
 * is harmless — no exempt prefix lives under `/auth` or `/public` — and must be left alone:
 * switching it to an absolute path would change what Layer A exempts.)
 */
export const authBucketDispatcher: RequestHandler = (req, res, next) => {
    const pathname = `${req.baseUrl}${req.path}`;
    const handler = isAuthSessionPathname(pathname) ? authSessionRateLimiter : authRateLimiter;
    return handler(req, res, next);
};

/**
 * The storefront bucket — `/api/public/*`, mounted ahead of the public routers.
 *
 * Its own `policy.key` gives it its own counters, so anonymous browse traffic can no
 * longer exhaust the global backstop on behalf of every other caller sharing the address.
 * Layer A still applies on top; see `PUBLIC_POLICY` for why that is deliberate.
 */
export const publicRateLimiter: RequestHandler = delegate(PUBLIC_POLICY);

/**
 * The connection-code bucket — attached to `POST /api/me/connections` alone. Layer C.
 *
 * The first per-endpoint limiter in the service, and it is one because that endpoint takes
 * a guessable secret. IP-scoped **on purpose**, even behind `requireAuth`: the per-account
 * attempt counter is already the tighter control, and accounts are free to mint, so the
 * address is the axis an attacker cannot buy their way around. See `CONNECTION_CODE_POLICY`.
 */
export const connectionCodeRateLimiter: RequestHandler = delegate(CONNECTION_CODE_POLICY);
