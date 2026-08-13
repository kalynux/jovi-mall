import { AsyncLocalStorage } from 'async_hooks';

/**
 * The ambient request identity every log line is stamped with.
 *
 * ── Why AsyncLocalStorage rather than a child logger ──────────────────────────
 * A per-request child logger has to be THREADED — passed into every service, repository and
 * mapper that might log. That is several hundred signature changes, and the moment one call
 * site forgets, the lines it produces silently lose their correlation id. Worse, it can never
 * reach a bridged `console.*` call in code that never saw `req` — which is ~565 of the sites
 * this phase is trying to make useful.
 *
 * The ALS store is read by pino's `mixin`, so EVERY line gets `requestId` — direct logger calls
 * and bridged console calls alike, at any stack depth, with no threading. That single property
 * is what makes `GET /system/logs?requestId=…` worth having.
 *
 * ── What it costs, stated ─────────────────────────────────────────────────────
 * A small per-request overhead, and the context is lost by any handler registered OUTSIDE the
 * request that created it — an `EventEmitter` listener bound at boot runs in the boot context,
 * not the request's. Worker lines correctly carry no `requestId`, because a sweep is not a
 * request. `req.requestId` stays exactly as it was; this is additive.
 */

export interface RequestContext {
    requestId: string;
    method: string;
    path: string;
    /**
     * The wi-admin administrator, when this request arrived through `requireAdminCaller`.
     *
     * This is the join ADR-002 asks for and nothing previously supported: wi-admin's audit row
     * carries `correlation_id`, jovi-mall adopts that same value as `requestId`, and stamping
     * the actor here means a log search can answer "what did this administrator's action
     * actually do inside the platform".
     */
    actorId?: string;
    actorSource?: 'admin' | 'platform';
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` ambient for its whole async subtree. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
    return storage.getStore();
}

/**
 * Attach the actor to the request already in flight.
 *
 * Mutation rather than a nested `storage.run` on purpose: `requireAdminCaller` runs as
 * middleware, part-way through a request whose context is already established, and re-entering
 * the store there would scope the actor to the middleware's own continuation rather than to the
 * handler that follows it. A no-op outside a request.
 */
export function stampContextActor(actorId: string, actorSource: 'admin' | 'platform'): void {
    const context = storage.getStore();
    if (!context) return;
    context.actorId = actorId;
    context.actorSource = actorSource;
}
