import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Turning a request path into a bounded metric label.
 *
 * ── Why not just use the route ────────────────────────────────────────────────
 * The obvious implementation is `req.route.path`. It does not work here for two reasons:
 * it is `undefined` for a 404 and for anything that errors before reaching a handler (which is
 * exactly the traffic you most want counted), and this service stacks several routers on one
 * prefix — `/agent` alone carries four — so the route a request matched does not identify the
 * surface it hit.
 *
 * ── Why the allowlist is the whole design ─────────────────────────────────────
 * Normalising ids out of a path bounds *most* of the label space, and "most" is not a bound.
 * A scanner hitting `/api/.env`, `/api/wp-admin`, `/api/<random>` mints a fresh time series per
 * request, and **prom-client enforces no per-metric cardinality cap** — nothing else in the
 * stack will stop it. So the last step is a lookup in a CLOSED list built from the mount table,
 * and everything not on it collapses to `other`. That list *is* the cap.
 *
 * `npm run test:system` proves it rather than asserting it: a thousand adversarial paths must
 * produce no more than `allowlist size + 1` distinct labels.
 *
 * ── What must never become a label ────────────────────────────────────────────
 * No user id, role, vendor id, order id, agent id, email or token. Not for privacy alone —
 * every one of them is unbounded, and an unbounded label is how a metrics endpoint becomes the
 * reason a process runs out of memory.
 */

/** Every mounted prefix under `/api`, from `src/api/index.ts`. */
const MOUNTED_PREFIXES: readonly string[] = Object.freeze([
    'admin', 'admin/agents', 'admin/article-authors', 'admin/articles', 'admin/cod',
    'admin/delivery-agencies', 'admin/earnings', 'admin/orders', 'admin/payout-requests',
    'admin/tickets',
    'agency', 'agency/agents', 'agency/inventory', 'agency/magazin', 'agency/stock-requests',
    'agency/tickets', 'agency/transactions', 'agency/vendor-connections',
    'agent', 'agent/tickets', 'agent/transactions',
    'auth', 'auth/browser',
    'bookings',
    'customer', 'customer/bookings', 'customer/cart', 'customer/notifications',
    'customer/orders', 'customer/tickets',
    'digital', 'files', 'geo', 'integrations/google',
    'internal/admin', 'internal/agents',
    // `me/connections` earns its own group for the same reason `me/payment-methods` does: it
    // is a distinct surface with its own failure modes. Specifically it is the one route in
    // the service carrying a per-endpoint rate limiter, so its 429 rate is a thing an
    // operator watches on its own — folded into `/api/me` it would be invisible beside
    // password changes.
    'me', 'me/connections', 'me/payment-methods',
    'payments', 'products', 'public', 'tracking',
    // Mounted on the bare app rather than through `apiRouter`, but still under `/api` — see
    // `app.ts`. Deliberately labelled rather than dropped: silently excluding probe traffic
    // makes "is anything actually checking me" unanswerable.
    'health',
    'vendor', 'vendor/agency-connections', 'vendor/bookings', 'vendor/inventory',
    'vendor/products', 'vendor/stock-requests', 'vendor/store', 'vendor/tickets',
    'vendor/transactions',
    'webhooks', 'webhooks/telegram', 'webhooks/whatsapp',
]);

/**
 * Non-`/api` paths that are still worth their own group.
 *
 * The scrape is deliberately **labelled rather than dropped**. Silently excluding it makes "is
 * anything actually scraping me" unanswerable, and a PromQL selector excludes it at query time
 * for free.
 */
const STANDALONE_GROUPS: readonly string[] = Object.freeze([
    'metrics',
]);

export const OTHER_GROUP = 'other';

/** The complete label space, including `other`. Bounded by construction. */
export const ROUTE_GROUPS: readonly string[] = Object.freeze([
    ...MOUNTED_PREFIXES.map((p) => `/api/${p}`),
    ...STANDALONE_GROUPS.map((p) => `/${p}`),
    OTHER_GROUP,
]);

const ROUTE_GROUP_SET = new Set(ROUTE_GROUPS);

/**
 * A ceiling nobody should ever approach, asserted at boot.
 *
 * Not a real limit on Prometheus's part — a tripwire. If somebody adds fifty mounts without
 * noticing what it costs in series, this is where they find out.
 */
export const MAX_ROUTE_GROUPS = 200;

export function assertRouteGroupsBounded(): void {
    if (ROUTE_GROUPS.length > MAX_ROUTE_GROUPS) {
        throw createAppError(
            ERROR_CODES.CONFIG_METRICS_CARDINALITY_UNBOUNDED,
            500,
            `ROUTE_GROUPS has ${ROUTE_GROUPS.length} entries, over the ${MAX_ROUTE_GROUPS} cap. `
            + 'Every entry is a metric label value and therefore a time series per method and status class.',
            { groups: ROUTE_GROUPS.length, cap: MAX_ROUTE_GROUPS },
        );
    }
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NUMERIC = /^\d+$/;

/** Anything that looks like an identifier rather than a route segment. */
function isIdentifier(segment: string): boolean {
    return OBJECT_ID.test(segment)
        || UUID.test(segment)
        || NUMERIC.test(segment)
        // An opaque blob — a download token, a slug carrying an id, a signed reference.
        || segment.length > 24;
}

/**
 * `req.path` → a bounded group label.
 *
 * Deliberately total: every input returns something, and anything unrecognised returns `other`.
 */
export function routeGroup(path: string): string {
    // Defensive: `req.path` carries no query string, but a caller passing `req.url` would.
    const clean = (path.split('?')[0] || '/').toLowerCase();
    const segments = clean.split('/').filter(Boolean).map((s) => (isIdentifier(s) ? ':id' : s));

    if (segments.length === 0) return OTHER_GROUP;

    if (segments[0] !== 'api') {
        const standalone = `/${segments[0]}`;
        return ROUTE_GROUP_SET.has(standalone) ? standalone : OTHER_GROUP;
    }

    // Longest mounted prefix wins: `/api/vendor/products/:id` must group as `/api/vendor/products`
    // rather than `/api/vendor`, because both are real mounts and the deeper one is the surface.
    for (let depth = Math.min(segments.length, 4); depth >= 2; depth--) {
        const candidate = `/${segments.slice(0, depth).join('/')}`;
        if (ROUTE_GROUP_SET.has(candidate)) return candidate;
    }

    return OTHER_GROUP;
}

/** 2xx → `2xx`, and so on. Five values instead of forty. */
export function statusClass(status: number): string {
    if (status < 100 || status > 599) return 'other';
    return `${Math.floor(status / 100)}xx`;
}
