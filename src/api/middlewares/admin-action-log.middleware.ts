import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import { AdminActionLogModel } from '../../core/audit/admin-action.model';
import {
    AdminActionContext,
    runWithAdminActionContext,
} from '../../core/audit/admin-action.context';

/**
 * Records every mutating request to the legacy `/api/admin/*` surface.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Until the Phase 8 cutover the dashboard still calls admin endpoints HERE rather than on
 * wi-admin, and those actions were recorded nowhere at all — not in `admin_audit_log`
 * (wi-admin never saw them) and not here (nothing wrote anything). Every ported domain
 * closes a slice of that, but the remainder is real and is what this covers in the interim.
 *
 * ── Complete by construction, which is the whole point of doing it here ───────
 * One `router.use('/admin', …)` registered BEFORE the twelve `/admin*` mounts matches all of
 * them by prefix. So this cannot miss an endpoint by omission the way per-handler
 * instrumentation would — including endpoints added to the legacy surface after this was
 * written.
 *
 * It deliberately does NOT match `/api/internal/admin/*`, which is mounted separately.
 * Those are wi-admin's delegated calls and are already audited on that side, with a real
 * administrator identity; recording them here would double-count every ported operation.
 *
 * ── Three rules it must never break ───────────────────────────────────────────
 * 1. It never delays the request. `next()` is called synchronously; the row is written on
 *    `finish`, after the response has gone.
 * 2. It never fails the request. Every path is caught — an audit shim that can 500 a
 *    working admin endpoint is worse than the gap it fills.
 * 3. It never stores a request BODY. Only `Object.keys(req.body)` — see below.
 */

/** Query keys worth keeping. Everything else is dropped rather than filtered. */
const SAFE_QUERY_KEYS = new Set([
    'page', 'limit', 'sort', 'status', 'from', 'to', 'search', 'q', 'type', 'role',
]);

/** `User-Agent` is attacker-controlled and unbounded; the row is not. */
const MAX_USER_AGENT = 512;

export function adminActionLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Reads change nothing, and the request log already has them. Recording every admin GET
    // would bury the writes under orders of magnitude more noise.
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        return next();
    }

    const startedAt = Date.now();
    const context: AdminActionContext = {
        correlationId: correlationIdOf(req),
        actor: actorOf(req),
        ip: req.ip ?? null,
        userAgent: userAgentOf(req),
        method: req.method,
        // `originalUrl`, not `path`: inside a router the mount prefix is already stripped,
        // and `/deactivate` instead of `/api/admin/delivery-agencies/:id/deactivate` is not
        // worth recording.
        path: req.originalUrl,
        serviceRecorded: false,
    };

    runWithAdminActionContext(context, () => {
        res.on('finish', () => {
            /**
             * A service wrote a specific row for this request, so the coarse one would be a
             * duplicate of the same act with less detail. The specific record wins.
             *
             * `admin-agency.service.ts` is the live case: reached through
             * `/api/admin/delivery-agencies/:id/deactivate`, and it records the status
             * transition, the suspended product count and the held order items — none of
             * which this middleware could know.
             */
            if (context.serviceRecorded) return;

            // Nothing changed, so there is nothing to record. A 4xx is the guard working.
            if (res.statusCode < 200 || res.statusCode >= 300) return;

            void write(req, res, context, startedAt);
        });

        next();
    });
}

async function write(
    req: Request,
    res: Response,
    context: AdminActionContext,
    startedAt: number,
): Promise<void> {
    try {
        await AdminActionLogModel.create({
            occurred_at: new Date(),
            correlation_id: context.correlationId,
            source: 'request',
            stream: 'admin',

            actor_kind: context.actor.userId ? 'platform_admin_user' : 'anonymous',
            actor_user_id: context.actor.userId && Types.ObjectId.isValid(context.actor.userId)
                ? new Types.ObjectId(context.actor.userId)
                : null,
            actor_role: context.actor.role,
            actor_name: context.actor.name,
            ip: context.ip,
            user_agent: context.userAgent,

            method: context.method,
            path: context.path,
            status_code: res.statusCode,
            duration_ms: Date.now() - startedAt,

            action: null,
            resource_type: null,
            resource_id: null,

            // Ids and pagination — safe by inspection, and what makes a row identifiable.
            params: Object.keys(req.params ?? {}).length > 0 ? { ...req.params } : null,
            query: safeQuery(req),
            /**
             * ── KEY NAMES ONLY. Never values. ────────────────────────────────
             *
             * This is the primary control on this surface, and it is blunt on purpose. The
             * legacy admin routes accept vendor KYC documents, ticket bodies, payout
             * references, delivery codes and file uploads; a redaction list over that is a
             * list somebody has to keep complete, forever, against endpoints nobody is
             * porting. Storing names alone cannot leak whatever the next endpoint accepts.
             *
             * `changes` on a `source: 'service'` row DOES carry values, because those
             * payloads are hand-authored by the service and known — a different situation
             * with a different answer.
             */
            body_keys: bodyKeys(req),
            changes: null,
            error_code: null,
        });
    } catch {
        // Deliberately silent. This runs after the response; there is no caller left to
        // tell, and throwing inside a `finish` handler takes the process down.
    }
}

function correlationIdOf(req: Request): string {
    const header = req.headers['x-request-id'];
    if (typeof header === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(header)) return header;
    return randomUUID();
}

function actorOf(req: Request): AdminActionContext['actor'] {
    const auth = req.auth;
    if (!auth?.user) return { userId: null, role: null, name: null };

    const user = auth.user as unknown as { id?: string; _id?: unknown; email?: string };
    const entity = auth.role_entity as unknown as { name?: string } | undefined;

    return {
        userId: user.id ?? (user._id ? String(user._id) : null),
        role: auth.role ?? null,
        name: entity?.name ?? user.email ?? null,
    };
}

function userAgentOf(req: Request): string | null {
    const raw = req.headers['user-agent'];
    return typeof raw === 'string' ? raw.slice(0, MAX_USER_AGENT) : null;
}

function safeQuery(req: Request): Record<string, unknown> | null {
    const query = req.query ?? {};
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(query)) {
        if (!SAFE_QUERY_KEYS.has(key)) continue;
        if (typeof value === 'string') out[key] = value.slice(0, 200);
    }

    return Object.keys(out).length > 0 ? out : null;
}

function bodyKeys(req: Request): string[] {
    // Never touched on a multipart upload — `req.body` there is whatever the parser left,
    // and enumerating it buys nothing.
    if (!req.is('application/json')) return [];

    const body = req.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];

    return Object.keys(body as Record<string, unknown>).slice(0, 50);
}
