import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Types } from 'mongoose';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { INTERNAL_ADMIN_SERVICE_TOKEN, internalAdminApiEnabled } from '../../config/internal-admin.config';
import { stampContextActor } from '../../core/logging/request-context';

/**
 * requireAdminCaller — authenticates the **wi-admin service** on `/api/internal/admin/*`.
 *
 * The user-facing `requireAuth` is wrong for this caller for the same reason it is wrong
 * for geo-tracker: wi-admin is a service, not a person. It holds no `users` row, no role
 * entity and no refresh cookie. What it does hold is the identity of the administrator who
 * asked, and it passes that along in headers.
 *
 * This mirrors `modules/agents/middlewares/service-token.middleware.ts` deliberately — same
 * fail-closed rule, same timing-safe compare, same header precedence. Two service callers
 * with two different-shaped guards is how one of them ends up weaker.
 *
 * ── The synthetic actor (ADR-004 D-1) ─────────────────────────────────────────
 * Administrators live in a separate database. Under full separation there is no `users` row
 * and no `admins` row for them here, so this middleware FABRICATES the `req.auth` shape the
 * existing controllers read, from the headers, with **no database query**:
 *
 *     req.auth.user.id          ← X-Actor-Id   (a wi-admin `admin_accounts._id`)
 *     req.auth.role             ← 'admin'      (constant — the route is admin-only by mount)
 *     req.auth.role_entity._id  ← X-Actor-Id   (same id: there is no second identity to name)
 *
 * That id then lands in columns declared `ref: MODELS.USER` and `ref: MODELS.ADMIN` where it
 * resolves to nothing. **That is a decision, not an oversight** — no `.populate()` anywhere
 * in this repo dereferences an actor (`*_by*`) field (13 populate sites, verified, none touch
 * one), and the admin-exclusivity check on tickets is an id-to-id string comparison that goes
 * on working. Readers who need the person get the denormalised `*_name` snapshot written
 * beside the id.
 *
 * What would break it: adding `.populate()` on an actor field. Don't.
 *
 * ── What this guard does NOT do ───────────────────────────────────────────────
 * It does not check permissions. Authorization is resolved in wi-admin before the call is
 * made and is deliberately single-sided — so this token is a **full-privilege credential**,
 * and its secrecy is the whole control. `X-Actor-Tier` is accepted for logging and is never
 * read for a decision.
 */

/** The ONE role a caller through this door can be. Not read from a header — see above. */
const ADMIN_ROLE = 'admin';

export const requireAdminCaller = (req: Request, _res: Response, next: NextFunction) => {
    if (!internalAdminApiEnabled()) {
        // An unset secret DENIES. A misconfigured deploy must not expose every admin
        // operation to anyone who finds the URL; the fail direction of an auth check is
        // never "open".
        return next(
            createAppError(
                ERROR_CODES.AUTH_ADMIN_CALLER_NOT_CONFIGURED,
                503,
                'Internal admin API is disabled — INTERNAL_ADMIN_SERVICE_TOKEN is not set'
            )
        );
    }

    const presented = extractServiceToken(req);
    if (!presented || !timingSafeEqual(presented, INTERNAL_ADMIN_SERVICE_TOKEN())) {
        return next(createAppError(ERROR_CODES.AUTH_ADMIN_CALLER_TOKEN_INVALID, 401));
    }

    const actorId = headerValue(req, 'x-actor-id');
    if (!actorId || !Types.ObjectId.isValid(actorId)) {
        // Refused rather than defaulted. An operation recorded against no actor — or against
        // a placeholder — is worse than a failed one: the money still moves and the audit
        // trail names nobody.
        return next(
            createAppError(
                ERROR_CODES.AUTH_ADMIN_CALLER_ACTOR_MISSING,
                400,
                'X-Actor-Id must be present and a valid administrator id'
            )
        );
    }

    const actorName = headerValue(req, 'x-actor-name') ?? 'Administrator';
    const actorObjectId = new Types.ObjectId(actorId);

    req.auth = {
        // Shaped to satisfy every read the admin routers make. `user` is typed `IUser` in
        // the global declaration, so this is a structural stand-in rather than a document —
        // only `id` and `_id` are ever read on this path.
        user: { id: actorId, _id: actorObjectId } as never,
        role: ADMIN_ROLE,
        role_entity: { _id: actorObjectId, id: actorId, name: actorName },
    };

    /**
     * Stamp the administrator onto the ambient log context (Phase 15).
     *
     * This is the join ADR-002 asks for and nothing previously supported. wi-admin already
     * sends its audit row's `correlation_id` as `X-Request-Id`, and `requestIdMiddleware`
     * adopts that value verbatim — so with the actor stamped here, every jovi-mall log line
     * produced while serving an internal-admin call names both the request AND the
     * administrator who caused it. "Resolve a dangling intent by grepping the other service for
     * the same correlation id" becomes an actual query rather than an aspiration.
     */
    stampContextActor(actorId, 'admin');

    next();
};

/**
 * The acting administrator, for a handler that wants to stamp provenance rather than just
 * an id. Returns null when called outside the internal admin API.
 */
export interface AdminCallerActor {
    id: string;
    name: string;
    tier: number | null;
}

export function adminCallerActor(req: Request): AdminCallerActor | null {
    const id = headerValue(req, 'x-actor-id');
    if (!id) return null;

    const rawTier = headerValue(req, 'x-actor-tier');
    const tier = rawTier !== null && /^\d+$/.test(rawTier) ? Number(rawTier) : null;

    return { id, name: headerValue(req, 'x-actor-name') ?? 'Administrator', tier };
}

function headerValue(req: Request, name: string): string | null {
    const raw = req.headers[name];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
    return null;
}

function extractServiceToken(req: Request): string | null {
    const header = req.headers['x-service-token'];
    if (typeof header === 'string' && header.length > 0) return header;

    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();

    return null;
}

/**
 * Constant-time compare. Lengths are hashed first so that differing lengths don't
 * short-circuit (timingSafeEqual throws on length mismatch, which is itself a leak).
 */
function timingSafeEqual(a: string, b: string): boolean {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}
