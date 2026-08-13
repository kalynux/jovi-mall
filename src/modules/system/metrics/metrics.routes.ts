import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { SYSTEM_CONFIG } from '../config/system.config';
import { metricsContentType, metricsText } from './metrics';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { logger } from '../../../core/logging';

/**
 * `GET /metrics` — Prometheus text exposition, on the BARE app.
 *
 * ── Why this is gated when geo-tracker's is not ───────────────────────────────
 * geo-tracker mounts `/metrics` unauthenticated behind `METRICS_ENABLED`, and that is right for
 * a service which is not internet-facing. **This service is.** It serves `/api/public/*` with no
 * auth and is the origin the storefront calls.
 *
 * What an open `/metrics` hands over here, in aggregate: request volumes per route group — so
 * order rate and payment rate, which is business intelligence — the complete internal route map,
 * every integration provider and worker name with its cadence, error rates with their timing,
 * the Node version, and the outbox backlog. Individually minor. Together it is a free
 * reconnaissance feed, and the duration histograms are a timing oracle.
 *
 * ── Three gates ───────────────────────────────────────────────────────────────
 *  1. `METRICS_ENABLED` — default **true**, for parity with geo-tracker.
 *  2. `METRICS_SCRAPE_TOKEN` — **required in production, optional otherwise.** A dev box works
 *     unconfigured; a production deploy that forgot the token serves nothing at all rather than
 *     serving openly. Fails closed, exactly like `internalAdminApiEnabled()`.
 *  3. `METRICS_ALLOWED_IPS` — optional, for operators terminating at a sidecar.
 *
 * Deliberately NOT `INTERNAL_ADMIN_SERVICE_TOKEN`: a Prometheus scrape config lives in a
 * monitoring namespace and is read by more people than an administrative secret should be, and
 * `admin-caller.middleware.ts` says plainly that that token is a full-privilege credential.
 * Separate secret, separate rotation — the same argument `internal-admin.config.ts` makes about
 * not reusing geo-tracker's token.
 *
 * Deliberately NOT behind `requireAdminCaller`: that guard requires a valid ObjectId in
 * `X-Actor-Id` and would 400 every scrape. Prometheus's `bearer_token_file` is the standard
 * mechanism and is what this accepts.
 *
 * ── Every rejection is a 404 ──────────────────────────────────────────────────
 * Disabled, missing token, wrong token, refused IP — all identical, so the response is never an
 * oracle confirming the endpoint exists or that a guess was close. The distinction is logged
 * server-side, where it belongs.
 *
 * ⚠ This sits outside `apiRouter`, so it carries none of what `/api` carries — no
 * `adminActionLogMiddleware`, no maintenance middleware. Both are intentional: telemetry matters
 * most during the incident, and a scrape is not an administrative action.
 */
const router = Router();

function tokenMatches(presented: string, expected: string): boolean {
    // Constant-time: a plain `===` on a secret leaks its prefix to anyone willing to measure.
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function presentedToken(req: Request): string {
    const header = req.get('x-metrics-token');
    if (header) return header;

    const auth = req.get('authorization') ?? '';
    return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

/**
 * Refuse a scrape by pretending the route does not exist.
 *
 * The 404-instead-of-401 is deliberate and unchanged: an unauthenticated caller learning
 * that `/metrics` is *there but guarded* has learned something worth knowing, and a scrape
 * endpoint is worth probing for. Answering exactly as an unmatched route does gives them
 * nothing.
 *
 * Phase 16 changed only how it is written. This used to hand-build the body — a fifth copy
 * of the envelope, missing `requestId`, and now missing `category` too. Raising the same
 * error the 404 catch-all raises is what keeps the disguise convincing: two responses that
 * are meant to be indistinguishable have to come out of one code path, or the next field
 * added to the envelope is added to only one of them.
 */
function refuse(next: NextFunction, reason: string): void {
    logger().warn({ reason }, 'metrics scrape refused');
    next(createAppError(ERROR_CODES.NOT_FOUND, 404, 'Route not found'));
}

router.get('/', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (!SYSTEM_CONFIG.METRICS_ENABLED) {
        refuse(next, 'METRICS_ENABLED is false');
        return;
    }

    const expected = SYSTEM_CONFIG.METRICS_SCRAPE_TOKEN;
    const isProduction = process.env.NODE_ENV === 'production';

    if (!expected && isProduction) {
        refuse(next, 'METRICS_SCRAPE_TOKEN is unset in production — refusing to serve openly');
        return;
    }

    if (expected && !tokenMatches(presentedToken(req), expected)) {
        refuse(next, 'bad or missing scrape token');
        return;
    }

    if (SYSTEM_CONFIG.METRICS_ALLOWED_IPS.length > 0) {
        const ip = req.ip ?? '';
        if (!SYSTEM_CONFIG.METRICS_ALLOWED_IPS.includes(ip)) {
            refuse(next, `IP ${ip} not in METRICS_ALLOWED_IPS`);
            return;
        }
    }

    res.setHeader('Content-Type', metricsContentType());
    res.send(await metricsText());
}));

export const metricsRoutes = router;
