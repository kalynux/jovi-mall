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
    {
        prefix: '/api/internal/agents',
        reason:
            'geo-tracker asking for a verdict, as a SERVICE — every route under here is behind '
            + 'requireServiceToken and no user session is involved, so the caller is one authenticated '
            + 'peer rather than a population. A 429 breaks the tracking pipe in both directions: an '
            + 'unanswered eligibility or tracking-policy read fails geo-tracker\'s authorization, and '
            + 'a refused tracking-state report is dropped silently, because that channel is '
            + 'best-effort by design. Same reasoning as the maintenance exemption on this prefix — '
            + 'blocking it turns a jovi-mall load spike into a geo-tracker outage.',
    },
    {
        prefix: '/api/internal/shipments',
        reason:
            'The same caller as /api/internal/agents, on the same token: geo-tracker pulling a '
            + 'shipment\'s geocoded drop-off so it can route to it. Every route under here is behind '
            + 'requireServiceToken and read-only, so the caller is one authenticated peer rather than '
            + 'a population — and it is pulled once per tracking session, never on the broadcast path. '
            + 'A 429 here is quieter than on the prefix above (nobody is dropped) and correspondingly '
            + 'easier to leave un-exempt: the session simply opens with no ETA, and geo-tracker does '
            + 'not retry until the next activation or subscribe.',
    },
    {
        prefix: '/api/tracking/agent-state',
        reason:
            'The reverse channel, also requireServiceToken: geo-tracker pushing an agent\'s tracking '
            + 'state and last fix. Named PRECISELY rather than exempting /api/tracking, because the '
            + 'other route under that mount — GET /visible-agents — runs behind requireAuth and '
            + 'carries a real USER identity forwarded by geo-tracker. Exempting that one would hand '
            + 'any authenticated caller an unlimited DB-touching endpoint, to spare a re-check that '
            + 'is already cached in geo-tracker (PERMISSION_CACHE_TTL) and fired by webhook rather '
            + 'than on a timer. Layer B is doing its job there and should keep it.',
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
