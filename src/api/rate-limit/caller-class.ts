import crypto from 'crypto';
import { Request } from 'express';
import { CallerClass } from './policy';
import { INTERNAL_ADMIN_SERVICE_TOKEN, internalAdminApiEnabled } from '../../config/internal-admin.config';
import { AGENT_CONFIG, internalApiEnabled } from '../../modules/agents/config/agent.config';

/**
 * Who is asking, and which bucket their requests are counted in.
 *
 * ── The ordering problem, and why it is solved with two layers rather than one ─
 * A rate limiter has to run BEFORE authentication (otherwise it cannot protect the login
 * endpoint) but needs authentication to tell an agent from a customer. The tempting fix is
 * to `jwt.decode()` without verifying and read `role` from the claims — and it is wrong in
 * the worst direction: an unverified claim is attacker-chosen, so a forger would name
 * themselves `admin` and be handed the LARGEST bucket. A rate limiter that can be talked
 * into a bigger allowance is not one.
 *
 * So the split is:
 *
 *   Layer A  before the routers, IP-scoped. Resolves only `internal_service` (a
 *            constant-time secret compare, no identity involved) versus everyone else.
 *   Layer B  at the tail of `requireAuth`, identity-scoped, where `req.auth` is populated
 *            by a verified token and a real database row.
 *
 * `resolveCallerClass` serves both: before auth it returns `internal_service` or
 * `anonymous`; after auth it returns the role. Nothing here ever reads an unverified claim.
 */

/**
 * Resolve the caller's class.
 *
 * Order is deliberate. The service token is checked first because an internal caller may
 * ALSO carry a user identity — geo-tracker forwards a viewer's bearer token on some paths —
 * and being an internal service is the stronger fact: throttling wi-admin turns an
 * administrator's action into an outage, and throttling geo-tracker makes its authorization
 * resolution fail closed under load, dropping live tracking watchers.
 */
export function resolveCallerClass(req: Request): CallerClass {
    if (isInternalServiceCaller(req)) return 'internal_service';

    const role = req.auth?.role;
    if (role === 'admin') return 'admin';
    if (role === 'vendor') return 'vendor';
    if (role === 'agency') return 'agency';
    if (role === 'agent') return 'agent';
    if (role === 'customer') return 'customer';

    return 'anonymous';
}

/**
 * The counting key for a caller.
 *
 * Identity scope keys on the user id, so one person on a laptop and a phone shares one
 * bucket — which is the intent; the bucket belongs to the person, not the device.
 *
 * IP scope falls back to `'unknown'` rather than to an empty string, because an empty key
 * would silently merge every address whose `req.ip` is undefined into one bucket and the
 * merge would look like a working limiter.
 *
 * ⚠ `req.ip` is only meaningful when `app.set('trust proxy', …)` matches the deployment.
 * See `config/http.config.ts`.
 */
export function rateLimitKey(req: Request, scope: 'ip' | 'identity'): string {
    if (scope === 'identity') {
        const userId = req.auth?.user?._id;
        if (userId) return `u:${String(userId)}`;
    }
    return `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Does this request carry a valid internal service token?
 *
 * Both secrets are checked — wi-admin's (`INTERNAL_ADMIN_SERVICE_TOKEN`) and geo-tracker's
 * (`INTERNAL_SERVICE_TOKEN`) — because both are trusted callers and neither should be
 * throttled. They are deliberately different secrets with different blast radii, and this
 * function is the one place that needs to know about both, which is why it does not live
 * in either middleware.
 *
 * An unset secret means the corresponding door is closed, so it can never match: comparing
 * against `''` and finding a caller who also sent `''` would grant exemption to anyone on a
 * misconfigured deploy. Both `*Enabled()` guards are checked first for exactly that reason.
 */
function isInternalServiceCaller(req: Request): boolean {
    const presented = extractServiceToken(req);
    if (!presented) return false;

    if (internalAdminApiEnabled() && timingSafeEqual(presented, INTERNAL_ADMIN_SERVICE_TOKEN())) {
        return true;
    }
    if (internalApiEnabled() && timingSafeEqual(presented, AGENT_CONFIG.INTERNAL_SERVICE_TOKEN)) {
        return true;
    }
    return false;
}

/** Same extraction both service-token middlewares use, so the three cannot disagree. */
function extractServiceToken(req: Request): string | null {
    const header = req.headers['x-service-token'] ?? req.headers['x-internal-token'];
    if (typeof header === 'string' && header.length > 0) return header;

    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();

    return null;
}

/**
 * Constant-time compare.
 *
 * Lengths are hashed first so a length mismatch does not short-circuit — `timingSafeEqual`
 * throws on unequal lengths, and that throw is itself an oracle. Copied in shape from
 * `service-token.middleware.ts`, which explains it at more length.
 */
function timingSafeEqual(a: string, b: string): boolean {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}
