import { AsyncLocalStorage } from 'async_hooks';

/**
 * The request an administrative action is happening inside, available anywhere.
 *
 * ── Why this exists at all ────────────────────────────────────────────────────
 * Two reasons, and the second is the one that actually forced it.
 *
 * 1. **Deduplication.** The `/admin/*` middleware writes a coarse row per request, and a
 *    handful of services write a richer explicit one. `admin-agency.service.ts` is reached
 *    through `/api/admin/delivery-agencies/:id/deactivate`, so both would fire and the feed
 *    would carry the same act twice. The recorder sets `serviceRecorded`, and the
 *    middleware stands down.
 *
 * 2. **Context.** `auditLogger.log()` is called from deep inside a service that has no
 *    `req`. Without this it cannot record the IP, the path, the actor's name or the
 *    correlation id — so the RICHER row would be the one missing the request context, which
 *    is backwards. Threading `req` through fourteen service signatures to fix that is the
 *    alternative, and it is worse.
 *
 * `AsyncLocalStorage` rather than a `Map` keyed by request id: a Map needs clearing on both
 * `finish` and `close`, and a missed `close` leaks for the life of the process. An ALS store
 * becomes unreachable when its async context ends, however the request ended.
 */

export interface AdminActionContext {
    correlationId: string;
    actor: {
        userId: string | null;
        role: string | null;
        name: string | null;
    };
    ip: string | null;
    userAgent: string | null;
    method: string;
    path: string;
    /**
     * Set by the recorder when a service wrote its own row. The middleware reads it on
     * `finish` and skips its coarse row — the specific record wins over the generic one.
     */
    serviceRecorded: boolean;
}

const storage = new AsyncLocalStorage<AdminActionContext>();

export function runWithAdminActionContext<T>(context: AdminActionContext, fn: () => T): T {
    return storage.run(context, fn);
}

/**
 * The current context, or null outside one.
 *
 * Null is the common case and never an error: workers, consumers, the CLI scripts and every
 * non-admin request run with no context, and `auditLogger.log()` called from any of them
 * simply records less.
 */
export function currentAdminActionContext(): AdminActionContext | null {
    return storage.getStore() ?? null;
}

/** Mark that a service wrote a specific row, so the middleware does not duplicate it. */
export function markServiceRecorded(): void {
    const context = storage.getStore();
    if (context) context.serviceRecorded = true;
}
