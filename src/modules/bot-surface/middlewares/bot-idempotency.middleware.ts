import { NextFunction, Request, Response } from 'express';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { botRouteFor } from '../domain/bot-route-table';
import { fingerprintRequest } from '../domain/bot-key-digest';
import {
    BotIdempotencyStore,
    botIdempotencyStore,
    BotIdempotentResponse,
} from '../services/bot-idempotency.store';
import { botIdempotencyScopeOf } from './bot-identity.middleware';

/**
 * `Idempotency-Key` on every mutating bot route — required, not advisory.
 *
 * ── WHICH ROUTES, AND WHY IT IS NOT A PER-ROUTE DECORATION ──────────────────
 * The route table says which rows are `mutating`, and this middleware reads it. A
 * per-route `withIdempotency(...)` wrapper would work exactly as long as everybody
 * remembered to wrap, and the route somebody forgot would be the route that doubles.
 * Reading the classification means a row added to the table is covered the moment it is
 * declared, by an author who need not have heard of this file.
 *
 * ── IT FAILS CLOSED, UNLIKE THE OTHER TWO REDIS GUARDS IN THIS SERVICE ──────
 * `FailOpenStore` (rate limiting) and `withWorkerLock` (sweep overlap) both fail OPEN when
 * Redis is unreachable, and both are right to: an absent rate limit costs one window of
 * extra allowance, and an absent worker lock costs one overlapping pass — while failing
 * closed would put a single point of failure in front of every route, or silently stop the
 * sweeps that move money.
 *
 * The arithmetic here runs the other way. What an absent record costs is a SECOND set of
 * orders and a second stock hold, on a money path, at precisely the moment retries are
 * most likely — a Redis outage and a flaky network arrive together. What failing closed
 * costs is that a chat cannot check out until Redis returns, while reads on this surface
 * and the entire storefront carry on. So a Redis fault answers `503` on mutating routes
 * (`BOT_IDEMPOTENCY_IN_PROGRESS`, which is the retry-shortly answer) and nothing is
 * executed twice.
 *
 * Every Redis call is BOUNDED, and that is what makes "fails closed" a real statement
 * rather than a hopeful one: a dead host does not reject promptly — node-redis retries the
 * initial connect — so an unbounded call hangs the request for minutes instead of
 * refusing it. Same trap `core/jobs/worker-lock.ts` documents, opposite verdict on the
 * timeout's meaning: there, "don't know" means run; here it means refuse.
 */

const REDIS_OP_TIMEOUT_MS = 2_000;

/** Resolved rather than thrown, so the call sites need no error code for "Redis was slow". */
const TIMED_OUT = Symbol('bot-idempotency-redis-timeout');

function withTimeout<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), REDIS_OP_TIMEOUT_MS);
        timer.unref();
    });
    // The loser keeps running. Swallow its settlement so a late rejection is not unhandled.
    void work.catch(() => undefined);
    return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

const HEADER = 'idempotency-key';

/** Long enough for a UUID and a conversation id; short enough not to be a payload. */
const MAX_KEY_LENGTH = 200;

export function buildBotIdempotencyMiddleware(store: BotIdempotencyStore = botIdempotencyStore) {
    return async function botIdempotency(
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        const absolutePath = `${req.baseUrl}${req.path}`;
        const route = botRouteFor(req.method, absolutePath);

        // An unrecognised path is on its way to a 404; a read needs no key.
        if (!route || !route.mutating) {
            next();
            return;
        }

        const key = req.get(HEADER)?.trim();
        if (!key) {
            next(createAppError(ERROR_CODES.BOT_IDEMPOTENCY_KEY_REQUIRED, 400, undefined, {
                tool: route.tool,
                header: 'Idempotency-Key',
            }));
            return;
        }
        if (key.length > MAX_KEY_LENGTH) {
            next(createAppError(ERROR_CODES.BOT_IDEMPOTENCY_KEY_REQUIRED, 400, undefined, {
                tool: route.tool,
                reason: 'too_long',
                maxLength: MAX_KEY_LENGTH,
            }));
            return;
        }

        /**
         * Scoped to the RESOLVED caller, not to the envelope.
         *
         * `requireBotIdentity` has already run, so this is the account the operation will
         * actually touch. Keying on the raw `externalId` instead would be subtly wrong the
         * day one person reaches an account from two channels: two identities, one
         * customer, and a key that no longer describes what it guards.
         *
         * ⚠ **The two GAP-002 rows have no resolved caller to key on**, because the account
         * they exist to create does not exist yet. Those fall back to the messaging identity
         * — hashed, since a scope string becomes part of a listable Redis key name — and the
         * two spaces are prefixed so they cannot collide. `botIdempotencyScopeOf` holds the
         * whole rule; this call site does not branch.
         */
        const identity = botIdempotencyScopeOf(req);

        // `identity` was consumed by the identity middleware, so the fingerprint covers the
        // operation's own arguments and nothing else — a cosmetic `displayName` that differs
        // between two attempts must not make a retry look like a new request.
        const fingerprint = fingerprintRequest(req.method, absolutePath, req.body ?? {});

        const claim = await withTimeout(
            store.claim({ identity, key, fingerprint, tool: route.tool }),
        );

        if (claim === TIMED_OUT) {
            // ⚠ A DIFFERENT code from the in-progress refusal below, and `test:errors`'
            // census is what insisted: one code raised at 503 and at 409 derives two
            // categories, which that scan refuses. It is the better shape anyway — telling
            // a caller "another call is in flight" when Redis is simply down would have
            // them retry on the wrong cadence, waiting for a race that is not happening.
            next(createAppError(ERROR_CODES.BOT_IDEMPOTENCY_STORE_UNAVAILABLE, 503, undefined, {
                tool: route.tool,
            }));
            return;
        }

        if (claim.status === 'replay') {
            replay(res, claim.response);
            return;
        }

        if (claim.status === 'in_progress') {
            next(createAppError(ERROR_CODES.BOT_IDEMPOTENCY_IN_PROGRESS, 409, undefined, {
                tool: claim.tool,
            }));
            return;
        }

        if (claim.status === 'reused') {
            next(createAppError(ERROR_CODES.BOT_IDEMPOTENCY_KEY_REUSED, 409, undefined, {
                tool: route.tool,
                spentOn: claim.tool,
            }));
            return;
        }

        install(res, {
            settle: async (response) => {
                // Only a success is worth replaying. A failure releases the key so the same
                // one may be retried once its cause is gone — see the store's header.
                if (response.status >= 200 && response.status < 300) {
                    await withTimeout(
                        store.complete({ identity, key, fingerprint, tool: route.tool, response }),
                    );
                    return;
                }
                await withTimeout(store.release(identity, key));
            },
        });

        next();
    };
}

export const botIdempotency = buildBotIdempotencyMiddleware();

/** Answer with exactly what the first call answered. */
function replay(res: Response, response: BotIdempotentResponse): void {
    // Says plainly that nothing ran. Without it a caller cannot tell a replay from a second
    // execution, which is the one fact this whole mechanism is asserting.
    res.setHeader('Idempotency-Replayed', 'true');
    res.status(response.status).json(response.body);
}

/**
 * Capture the response, however it is produced.
 *
 * `res.json` is wrapped rather than `res.send`, because every route on this surface — and
 * the global error handler that answers for the ones that throw — goes through `.json()`.
 * The `finish` listener is the belt: a response that ends some other way (or a socket that
 * dies mid-flight) would otherwise leave a claim held for its full sixty seconds, and the
 * customer would be told "still in flight" for a request that is over.
 *
 * Settling is fire-and-forget and self-catching on purpose. The response is already on its
 * way to the caller by the time this runs, so a Redis failure here cannot be reported to
 * anybody — and awaiting it would delay a reply the customer is waiting for in order to
 * write a record only a retry would ever read.
 */
function install(res: Response, hooks: { settle: (r: BotIdempotentResponse) => Promise<void> }): void {
    let settled = false;

    const settle = (response: BotIdempotentResponse): void => {
        if (settled) return;
        settled = true;
        void hooks.settle(response).catch((error) => {
            console.error('[BotSurface] could not record an idempotency outcome', error);
        });
    };

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
        settle({ status: res.statusCode, body });
        return originalJson(body);
    };

    res.on('finish', () => {
        // A non-JSON ending, or a handler that answered with `res.end()`. Treated as a
        // failure so the key is released: releasing a key whose operation actually
        // succeeded costs one duplicate at worst on a route nobody reaches that way, while
        // holding it costs every retry for a minute.
        settle({ status: res.statusCode, body: null });
    });
}
