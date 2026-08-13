import { Request } from 'express';

/**
 * Paths the rate limiter never counts, each with the reason it is on the list.
 *
 * A closed list with a written justification per entry, following
 * `modules/system/domain/maintenance-mode.ts` — which established the discipline for
 * exactly this shape of decision, and for the same reason: an exemption without a stated
 * cause is indistinguishable from an oversight, and the next person deletes it or copies it.
 *
 * Matching is by prefix on the path only (never the query string), and it is anchored: a
 * path is exempt when it equals an entry or continues it with `/`. `/api/healthcheck-bypass`
 * must not inherit `/api/health`'s exemption.
 */

interface Exemption {
    prefix: string;
    reason: string;
}

export const EXEMPT_PATHS: readonly Exemption[] = Object.freeze([
    {
        prefix: '/api/health',
        reason:
            'The FROZEN contract. geo-tracker registers this as a READINESS checker and treats any '
            + 'status >= 300 as an error, so a 429 here pulls geo-tracker out of rotation and kills '
            + 'every live WebSocket tracking session — for load on a different service that is itself '
            + 'healthy. ADR-014 D-1. Covers /live and /ready by prefix.',
    },
    {
        prefix: '/metrics',
        reason:
            'A throttled scrape is a monitoring gap that opens exactly when load is high, which is '
            + 'when it is worth having. It has its own token gate and its own 404-on-refusal.',
    },
    {
        prefix: '/api/webhooks',
        reason:
            'Gateway traffic. A 429 to Stripe, WhatsApp or Telegram does not inconvenience a caller — '
            + 'it loses a payment notification or a delivery receipt. These are signature-authenticated '
            + 'and bounded by their own body limits; volume is not the threat here.',
    },
]);

/** Prefix set, precomputed — this runs on every request. */
const EXEMPT_PREFIXES: readonly string[] = Object.freeze(EXEMPT_PATHS.map((e) => e.prefix));

/**
 * Is this request exempt from rate limiting?
 *
 * Reads `req.path`, not `req.originalUrl`: the query string is caller-controlled and must
 * never be able to talk its way into an exemption.
 */
export function isExemptPath(req: Request): boolean {
    return isExemptPathname(req.path);
}

/** The pure half, so `test:rate-limit` can assert it without building a request. */
export function isExemptPathname(pathname: string): boolean {
    return EXEMPT_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
}
