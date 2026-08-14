/**
 * The rate-limit policy table (Phase 16).
 *
 * ── What is deliberately NOT here yet ─────────────────────────────────────────
 * Per-endpoint limits. The request was for a *tolerant global* limiter that is
 * **future-proof** for per-endpoint and per-user-type tightening later, and those are two
 * different amounts of work: the per-user-type half is live below, and the per-endpoint
 * half is a row in `POLICIES` plus a lookup that already exists (`policyFor`). Building the
 * per-endpoint surface now, with nothing to put in it, would be a table of one entry and a
 * second thing to keep in step.
 *
 * ── Ceilings ──────────────────────────────────────────────────────────────────
 * Every number here is a **backstop, not a budget**. They are set so that no real user of
 * any role can reach them and a runaway loop or a scraper can; the counters exist so the
 * first week of production data can replace this paragraph with evidence.
 */

/**
 * Who is asking. Resolution order and the reason for it live in `caller-class.ts`.
 *
 * `internal_service` is first because it is the only class resolved from a shared secret
 * rather than from a user identity, and it is the only one that is exempt.
 */
export type CallerClass =
    | 'internal_service'
    | 'admin'
    | 'vendor'
    | 'agency'
    | 'agent'
    | 'customer'
    | 'anonymous';

export const CALLER_CLASSES: readonly CallerClass[] = Object.freeze([
    'internal_service',
    'admin',
    'vendor',
    'agency',
    'agent',
    'customer',
    'anonymous',
]);

/** `'exempt'` is not a very large number — it is "do not count this at all". */
export type Ceiling = number | 'exempt';

export interface RateLimitPolicy {
    /** Stable identifier. `'global'` and `'auth'` today; a route group later. */
    key: string;
    windowSeconds: number;
    /** Per caller class. Every class must have an entry — `test:rate-limit` asserts it. */
    limits: Readonly<Record<CallerClass, Ceiling>>;
    /**
     * How a caller is counted.
     *
     * `'identity'` buckets per user id, `'ip'` per source address. The distinction is what
     * makes the ceilings usable at all: an office, a school or a Cameroonian mobile carrier
     * puts hundreds of people behind one address, so an IP-scoped limit generous enough not
     * to hurt them is too generous to bound anybody.
     */
    scope: 'ip' | 'identity';
}

function envInt(name: string, fallback: number): number {
    const raw = Number(process.env[name]);
    return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/**
 * Layer A — the global, IP-scoped backstop.
 *
 * Mounted before the routers, so it runs on unauthenticated traffic and on the auth
 * endpoints themselves. It can only tell `internal_service` from everybody else, because
 * `req.auth` does not exist yet at that point in the chain.
 *
 * Its ceiling sits ABOVE every identity ceiling on purpose: this layer is not meant to be
 * the thing that limits a signed-in user — Layer B is — so it should only ever fire on a
 * genuine flood from one address.
 */
export const GLOBAL_POLICY: RateLimitPolicy = Object.freeze({
    key: 'global',
    windowSeconds: 60,
    scope: 'ip',
    limits: Object.freeze({
        internal_service: 'exempt',
        // Layer A cannot resolve these, so they all fall to `anonymous`. The entries exist
        // because the shape is checked and because a future Layer-A identity source would
        // read them rather than adding a branch.
        admin: envInt('RATE_LIMIT_GLOBAL_PER_MIN', 1200),
        vendor: envInt('RATE_LIMIT_GLOBAL_PER_MIN', 1200),
        agency: envInt('RATE_LIMIT_GLOBAL_PER_MIN', 1200),
        agent: envInt('RATE_LIMIT_GLOBAL_PER_MIN', 1200),
        customer: envInt('RATE_LIMIT_GLOBAL_PER_MIN', 1200),
        anonymous: envInt('RATE_LIMIT_GLOBAL_PER_MIN', 1200),
    }),
});

/**
 * Layer B — identity-scoped, mounted at the tail of `requireAuth`.
 *
 * One edit in one file, and every authenticated route in the service inherits it. This is
 * where the per-user-type table is actually live today.
 *
 * The ordering (agent = admin > vendor = agency > customer) is about how each role uses the
 * API, not about how much anyone is trusted:
 *
 *  - **agent** is a mobile client polling offers, shipment status and its own position, and
 *    is the most latency-sensitive surface the platform has. It is also the one whose user
 *    is standing in the street.
 *  - **admin** loads multi-panel dashboards that fan out a dozen parallel reads per screen.
 *  - **vendor / agency** run catalogue, inventory and dispatch boards — bursty, but a
 *    person at a desk.
 *  - **customer** browses and checks out, which is the least request-dense flow of the five.
 */
export const IDENTITY_POLICY: RateLimitPolicy = Object.freeze({
    key: 'identity',
    windowSeconds: 60,
    scope: 'identity',
    limits: Object.freeze({
        internal_service: 'exempt',
        admin: envInt('RATE_LIMIT_ADMIN_PER_MIN', 1200),
        agent: envInt('RATE_LIMIT_AGENT_PER_MIN', 1200),
        vendor: envInt('RATE_LIMIT_VENDOR_PER_MIN', 900),
        agency: envInt('RATE_LIMIT_AGENCY_PER_MIN', 900),
        customer: envInt('RATE_LIMIT_CUSTOMER_PER_MIN', 600),
        // Unreachable: Layer B only runs behind `requireAuth`. Present so the record is
        // total and so a mount somewhere unexpected fails safe rather than throwing.
        anonymous: envInt('RATE_LIMIT_ANON_PER_MIN', 600),
    }),
});

/**
 * The credential bucket — strict, and the only strict number in this file.
 *
 * Everything else here is a runaway-loop backstop. This one is a security control: it
 * bounds one source spraying a common password across many accounts, which is the attack
 * an account-level lockout cannot see. jovi-mall has never had either.
 *
 * `internal_service` is NOT exempt here. Nothing internal logs in, so an exemption would
 * only ever be usable by something that had already stolen the service token.
 */
export const AUTH_POLICY: RateLimitPolicy = Object.freeze({
    key: 'auth',
    windowSeconds: 60,
    scope: 'ip',
    limits: Object.freeze({
        internal_service: envInt('RATE_LIMIT_AUTH_PER_MIN', 20),
        admin: envInt('RATE_LIMIT_AUTH_PER_MIN', 20),
        vendor: envInt('RATE_LIMIT_AUTH_PER_MIN', 20),
        agency: envInt('RATE_LIMIT_AUTH_PER_MIN', 20),
        agent: envInt('RATE_LIMIT_AUTH_PER_MIN', 20),
        customer: envInt('RATE_LIMIT_AUTH_PER_MIN', 20),
        anonymous: envInt('RATE_LIMIT_AUTH_PER_MIN', 20),
    }),
});

/**
 * The storefront bucket — `/api/public/*`, mounted ahead of the public routers.
 *
 * It exists because anonymous browse traffic is the one flow that shares Layer A's
 * single IP bucket with everything else on the address. A product grid fires a list
 * call plus a categories call per page view, and behind an office NAT or a Cameroonian
 * mobile carrier that is hundreds of people contending for one 1200/min counter — so
 * the storefront would be what trips it, for everybody, including the signed-in users
 * on the same address who then cannot check out.
 *
 * Giving it its own `key` gives it its own counters (the bucket name is
 * `${policy.key}:${scope key}`), so public reads can no longer exhaust the global
 * backstop on behalf of the rest of the API.
 *
 * **This is a widening, not a tightening.** Layer A still applies on top — `/api/public`
 * is deliberately not in `EXEMPT_PATHS` — so the effective ceiling for a public read is
 * the lower of the two. The default is set above the global one on purpose: these are
 * cacheable, unauthenticated reads of already-published data, the cheapest requests the
 * service serves, and they carry `Cache-Control: public, max-age=300`.
 *
 * `scope: 'ip'` is forced by the surface, not chosen: `/api/public` runs no `requireAuth`,
 * so there is never a `req.auth` to key on and `'identity'` would silently fall through
 * to the IP anyway (see `rateLimitKey`) — the label would just be a lie.
 */
export const PUBLIC_POLICY: RateLimitPolicy = Object.freeze({
    key: 'public',
    windowSeconds: 60,
    scope: 'ip',
    limits: Object.freeze({
        internal_service: 'exempt',
        // Nothing here can resolve a role — the mount is ahead of every guard — so in
        // practice every caller lands on `anonymous`. The rest are present because the
        // record is total, and they carry the same number so a signed-in shopper reading
        // the public catalog is never treated differently from a logged-out one.
        admin: envInt('RATE_LIMIT_PUBLIC_PER_MIN', 3000),
        vendor: envInt('RATE_LIMIT_PUBLIC_PER_MIN', 3000),
        agency: envInt('RATE_LIMIT_PUBLIC_PER_MIN', 3000),
        agent: envInt('RATE_LIMIT_PUBLIC_PER_MIN', 3000),
        customer: envInt('RATE_LIMIT_PUBLIC_PER_MIN', 3000),
        anonymous: envInt('RATE_LIMIT_PUBLIC_PER_MIN', 3000),
    }),
});

/** Every policy, for the tests and for the operations surface. */
export const POLICIES: readonly RateLimitPolicy[] = Object.freeze([
    GLOBAL_POLICY,
    IDENTITY_POLICY,
    AUTH_POLICY,
    PUBLIC_POLICY,
]);

/**
 * The ceiling for a caller under a policy.
 *
 * Returns `'exempt'` or a positive integer. There is no third outcome, which is what lets
 * the middleware treat the result as a decision rather than as a suggestion.
 */
export function ceilingFor(policy: RateLimitPolicy, callerClass: CallerClass): Ceiling {
    return policy.limits[callerClass];
}
