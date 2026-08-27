/**
 * The bot surface's route table — the whole of `/api/internal/bot/*`, as data.
 *
 * ── WHY A TABLE, AND WHY IT IS PURE ──────────────────────────────────────────
 * Four separate things need to know what this surface's routes are, and three of them
 * are nowhere near the router:
 *
 *   1. `bot.routes.ts`               mounts them, one handler per row.
 *   2. `bot-idempotency.middleware`  demands an `Idempotency-Key` on the mutating ones.
 *   3. `maintenance-mode.ts`         decides which survive a `readonly` window.
 *   4. `test:bot-surface`            asserts the whole set against `api-doc/n8n/tools/
 *                                    catalog.json`, which is the contract the automation
 *                                    layer is built from.
 *
 * A hand-kept list in any of those four is a list that drifts from the other three, and
 * the drift is invisible: a route mounted without a `mutating` flag would silently accept
 * a retry twice, and a read left out of the maintenance predicate would 503 during a
 * window that was supposed to leave reads working. So the table is declared once, here,
 * and every consumer derives from it.
 *
 * ── This file imports NOTHING ────────────────────────────────────────────────
 * No Express, no Mongoose, no controllers. That is what lets `maintenance-mode.ts` — a
 * pure module `test:system` drives with no database and no server — read it without
 * pulling the entire bot surface into its import graph. Handlers are attached in
 * `bot.routes.ts`, against this table, with a closed-registry check in both directions.
 *
 * ── The `mutating` column is a SAFETY classification, not a description ──────
 * `geo/search` mints a candidate handle and `recently-viewed` writes a row, and the two
 * are classified opposite ways. The question the column answers is not "does anything
 * change" but "would running this twice do something the customer did not ask for" —
 * which is what both the idempotency guard and the read-only window actually care about.
 * Each row that is not obvious carries its reason.
 */

/** Every method this surface uses. `GET` is deliberately absent — see `bot.routes.ts`. */
export type BotRouteMethod = 'POST' | 'PATCH' | 'DELETE';

export interface BotRouteSpec {
    /**
     * The tool name in `api-doc/n8n/tools/catalog.json`.
     *
     * This is the join key for the contract assertion in `test:bot-surface`, and it is
     * also what an operator sees in a log line — a `tool` reads better in an incident
     * than `POST /api/internal/bot/orders/:orderId/shipments/:shipmentId/confirm-delivery`.
     */
    tool: string;
    method: BotRouteMethod;
    /** Express path, relative to the `/api/internal/bot` mount. */
    path: string;
    /** Requires an `Idempotency-Key`, and refused during a `readonly` maintenance window. */
    mutating: boolean;
    /**
     * The catalogue's `requires_customer_role`.
     *
     * ⚠ **Today this is contract metadata rather than a branch**, and saying so is more
     * useful than pretending otherwise. Every GAP-001 route refuses an unresolved
     * identity — `identity/resolve` included, per its own `errors` block in the
     * catalogue, which lists `BOT_IDENTITY_UNRESOLVED`, `BOT_IDENTITY_NEEDS_CONTACT` and
     * `BOT_IDENTITY_NOT_CUSTOMER` — so the guard behaves identically for both values.
     *
     * It is carried because it is asserted against the catalogue (a value that drifts
     * there is a value the automation layer's own guard would enforce differently).
     *
     * ⚠ **This column was going to be the seam GAP-002 branched on, and it could not be.**
     * `identity_resolve_sender` is `requires_customer_role: false` and nevertheless MUST
     * refuse an unresolved sender — its own `errors` block in the catalogue promises a 404
     * — so branching the identity guard here would have quietly turned that route's
     * contract inside out. GAP-002 got the explicit `anonymous` column below instead, and
     * this one stayed what it always was: contract metadata pinned to the catalogue.
     */
    requiresCustomerRole: boolean;
    /**
     * **Runs for a sender with NO ACCOUNT AT ALL.** GAP-002, and nothing else, ever.
     *
     * On a row that sets this, `requireBotIdentity` resolves SOFTLY: a resolvable sender
     * still arrives with `req.bot.caller` populated, and an unresolvable one arrives with
     * `caller: null` and the raw envelope, instead of the refusal every other row gets.
     * That is the whole mechanism by which registration is reachable — the guard is a
     * `router.use`, so a route it refuses is a route that cannot create the account it
     * exists to create.
     *
     * ⚠ **Default false, and it must stay a per-row opt-in.** Every other row on this
     * surface reads or writes a customer's cart, orders, addresses or money, and on those
     * an unresolved caller is precisely the request that must not run. A row that sets this
     * is a row that has to handle `caller === null` itself; `botCallerOf` still throws, so
     * forgetting is a 500 in development rather than a silent read of somebody else's data.
     */
    anonymous?: boolean;
}

/**
 * ⚠ **ORDER IS SIGNIFICANT.** Express matches in declaration order, so a literal segment
 * must be declared before a parameter that would swallow it — `/orders/list` before
 * `/orders/:orderId`, `/tickets/list` before `/tickets/:ticketId`, `/bookings/list`
 * before `/bookings/:bookingId`.
 *
 * This is not left to care: `assertNoShadowedRoutes()` below runs at import and refuses
 * to load a table in which any row is unreachable. jovi-mall has been bitten by route
 * order twice already — `/articles/index` behind `/articles/:slug`, and
 * `/orders/groups/:cartId` behind `/orders/:id` — and both times the symptom was a
 * handler that existed, compiled, and was never reached.
 */
export const BOT_ROUTES: readonly BotRouteSpec[] = Object.freeze([
    // ── Identity ─────────────────────────────────────────────────────────────
    { tool: 'identity_resolve_sender', method: 'POST', path: '/identity/resolve', mutating: false, requiresCustomerRole: false },

    // ── Registration and onboarding (GAP-002) ────────────────────────────────
    // The only two rows on this surface that run for a sender with no account. Both are
    // `mutating` — `sync` CREATES an account, and a maintenance `readonly` window must
    // refuse that. The consequence is deliberate and documented: during such a window the
    // automation layer falls back to `identity/resolve`, which is a read and keeps working
    // for everybody who already has an account.
    { tool: 'identity_sync_sender', method: 'POST', path: '/identity/sync', mutating: true, requiresCustomerRole: false, anonymous: true },
    { tool: 'identity_submit_onboarding', method: 'POST', path: '/identity/onboarding', mutating: true, requiresCustomerRole: false, anonymous: true },

    // ── Cart ─────────────────────────────────────────────────────────────────
    { tool: 'cart_get', method: 'POST', path: '/cart/get', mutating: false, requiresCustomerRole: true },
    { tool: 'cart_quote', method: 'POST', path: '/cart/quote', mutating: false, requiresCustomerRole: true },
    // Increments an existing line rather than setting it, so a retry silently doubles it.
    { tool: 'cart_add_item', method: 'POST', path: '/cart/items', mutating: true, requiresCustomerRole: true },
    { tool: 'cart_set_item_quantity', method: 'PATCH', path: '/cart/items/:variantId', mutating: true, requiresCustomerRole: true },
    { tool: 'cart_remove_item', method: 'DELETE', path: '/cart/items/:variantId', mutating: true, requiresCustomerRole: true },
    { tool: 'cart_clear', method: 'DELETE', path: '/cart', mutating: true, requiresCustomerRole: true },

    // ── Checkout and money ───────────────────────────────────────────────────
    // The route GAP-001 says must not ship without idempotency: a retry creates a second
    // set of orders AND a second 30-minute stock hold.
    { tool: 'checkout_create_orders', method: 'POST', path: '/checkout', mutating: true, requiresCustomerRole: true },
    { tool: 'payment_get_transaction', method: 'POST', path: '/payments/:transactionId', mutating: false, requiresCustomerRole: true },
    // GAP-008. `mutating`, and the classification is the interesting half: it changes
    // nothing a customer owns and re-running it is safe — but a second mint REVOKES the
    // first, so a retry that the caller did not intend kills the link already sitting in the
    // chat. That is exactly "would running this twice do something the customer did not ask
    // for", which is the question this column answers.
    { tool: 'payment_create_pay_link', method: 'POST', path: '/payments/:transactionId/pay-link', mutating: true, requiresCustomerRole: true },

    // ── Orders ───────────────────────────────────────────────────────────────
    { tool: 'orders_list_groups', method: 'POST', path: '/orders/list', mutating: false, requiresCustomerRole: true },
    { tool: 'orders_get_group', method: 'POST', path: '/orders/groups/:cartId', mutating: false, requiresCustomerRole: true },
    { tool: 'orders_get_order', method: 'POST', path: '/orders/:orderId', mutating: false, requiresCustomerRole: true },
    { tool: 'orders_list_shipments', method: 'POST', path: '/orders/:orderId/shipments', mutating: false, requiresCustomerRole: true },
    // Discloses a payment credential and changes nothing. The RESEND below is the write.
    { tool: 'orders_get_cod_code', method: 'POST', path: '/orders/:orderId/cod-code', mutating: false, requiresCustomerRole: true },
    { tool: 'orders_cancel', method: 'POST', path: '/orders/:orderId/cancel', mutating: true, requiresCustomerRole: true },
    { tool: 'orders_resend_cod_code', method: 'POST', path: '/orders/:orderId/shipments/:shipmentId/resend-delivery-code', mutating: true, requiresCustomerRole: true },
    { tool: 'orders_confirm_shipment_delivery', method: 'POST', path: '/orders/:orderId/shipments/:shipmentId/confirm-delivery', mutating: true, requiresCustomerRole: true },

    // ── Profile and addresses ────────────────────────────────────────────────
    { tool: 'profile_get_summary', method: 'POST', path: '/profile', mutating: false, requiresCustomerRole: true },
    { tool: 'profile_set_language', method: 'PATCH', path: '/profile/language', mutating: true, requiresCustomerRole: true },
    { tool: 'addresses_list', method: 'POST', path: '/addresses/list', mutating: false, requiresCustomerRole: true },
    { tool: 'addresses_add', method: 'POST', path: '/addresses', mutating: true, requiresCustomerRole: true },
    { tool: 'addresses_set_default', method: 'PATCH', path: '/addresses/:addressId/default', mutating: true, requiresCustomerRole: true },

    // ── Geo ──────────────────────────────────────────────────────────────────
    // Both mint a single-use candidate handle, which IS a write to Redis — and both are
    // classified as reads, matching the catalogue. The handle is scoped to this sender,
    // costs nothing, and expires in 30 minutes; running a search twice is what a person
    // typing an address does anyway. Nothing the customer owns changes.
    { tool: 'geo_search_address', method: 'POST', path: '/geo/search', mutating: false, requiresCustomerRole: true },
    { tool: 'geo_reverse_address', method: 'POST', path: '/geo/reverse', mutating: false, requiresCustomerRole: true },

    // ── Tickets ──────────────────────────────────────────────────────────────
    { tool: 'tickets_list', method: 'POST', path: '/tickets/list', mutating: false, requiresCustomerRole: true },
    { tool: 'tickets_create', method: 'POST', path: '/tickets', mutating: true, requiresCustomerRole: true },
    { tool: 'tickets_get', method: 'POST', path: '/tickets/:ticketId', mutating: false, requiresCustomerRole: true },
    { tool: 'tickets_add_note', method: 'POST', path: '/tickets/:ticketId/notes', mutating: true, requiresCustomerRole: true },
    { tool: 'tickets_close', method: 'POST', path: '/tickets/:ticketId/close', mutating: true, requiresCustomerRole: true },

    // ── Support routing (GAP-004) ────────────────────────────────────────────
    // A read, and one whose `mutating: false` is worth a word: it is the FIRST step of the
    // support flow, so a `readonly` maintenance window that refused it would leave a
    // customer unable to find out who to complain to about the window. Nothing it touches
    // is written — the ladder only reads what other routes recorded.
    { tool: 'support_resolve_contacts', method: 'POST', path: '/support/context', mutating: false, requiresCustomerRole: true },

    // ── Wishlist and recently viewed ─────────────────────────────────────────
    { tool: 'wishlist_list', method: 'POST', path: '/wishlist/list', mutating: false, requiresCustomerRole: true },
    { tool: 'wishlist_add', method: 'POST', path: '/wishlist', mutating: true, requiresCustomerRole: true },
    { tool: 'wishlist_remove', method: 'DELETE', path: '/wishlist/:productId', mutating: true, requiresCustomerRole: true },
    // Naturally idempotent — re-viewing moves the entry to the head rather than adding a
    // second one — but it WRITES, and a read-only window must not accept it.
    { tool: 'recently_viewed_record', method: 'POST', path: '/recently-viewed', mutating: true, requiresCustomerRole: true },

    // ── Digital delivery ─────────────────────────────────────────────────────
    { tool: 'digital_list_entitlements', method: 'POST', path: '/digital/my-products', mutating: false, requiresCustomerRole: true },
    { tool: 'digital_create_download_link', method: 'POST', path: '/digital/download-links', mutating: true, requiresCustomerRole: true },

    // ── Bookings ─────────────────────────────────────────────────────────────
    { tool: 'bookings_list', method: 'POST', path: '/bookings/list', mutating: false, requiresCustomerRole: true },
    { tool: 'bookings_get', method: 'POST', path: '/bookings/:bookingId', mutating: false, requiresCustomerRole: true },
    { tool: 'bookings_cancel', method: 'POST', path: '/bookings/:bookingId/cancel', mutating: true, requiresCustomerRole: true },

    // ── Reviews ──────────────────────────────────────────────────────────────
    { tool: 'reviews_check_eligibility', method: 'POST', path: '/reviews/eligibility', mutating: false, requiresCustomerRole: true },
    { tool: 'reviews_create', method: 'POST', path: '/reviews', mutating: true, requiresCustomerRole: true },

    // ── Proactive messaging (GAP-012) ────────────────────────────────────────
    // `messaging/window` is a read in the strictest sense — it looks at one Redis TTL and
    // writes nothing — and it is the one a `readonly` window must keep serving, because a
    // flow that cannot ask whether it may still speak has to guess.
    { tool: 'messaging_get_window', method: 'POST', path: '/messaging/window', mutating: false, requiresCustomerRole: true },
    // `notify` MINTS A PAY LINK and sends a message to a real person. Both halves are
    // "would running this twice do something the customer did not ask for": the second mint
    // kills the link the first one sent, and the second message is a second interruption.
    { tool: 'messaging_notify_customer', method: 'POST', path: '/messaging/notify', mutating: true, requiresCustomerRole: true },

    // ── Notification preferences ─────────────────────────────────────────────
    { tool: 'notifications_get_preferences', method: 'POST', path: '/notifications/preferences', mutating: false, requiresCustomerRole: true },
    { tool: 'notifications_update_preferences', method: 'PATCH', path: '/notifications/preferences', mutating: true, requiresCustomerRole: true },
]);

/** Where this surface is mounted. One literal, read by the router and by maintenance mode. */
export const BOT_SURFACE_PREFIX = '/api/internal/bot';

// ─────────────────────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An Express path with `:params`, as a regex over one absolute request path.
 *
 * Deliberately narrow: `:param` becomes `[^/]+` and every other character is escaped.
 * The bot surface uses no optional segments, no wildcards and no regex parameters, and
 * `assertNoShadowedRoutes` would not be sound if it did — so a path that needed one
 * would have to be a decision taken here rather than a pattern that quietly works.
 */
function toPattern(prefix: string, path: string): RegExp {
    const escaped = `${prefix}${path}`
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:[A-Za-z0-9_]+/g, '[^/]+');
    // The input is BOT_ROUTES' own path literals, which are module constants — no user
    // input reaches this — and the escape pass above neutralises every metacharacter
    // before the `:param` substitution runs.
    // eslint-disable-next-line no-restricted-syntax -- static pattern, no user input
    return new RegExp(`^${escaped}$`);
}

interface CompiledRoute extends BotRouteSpec {
    pattern: RegExp;
}

const COMPILED: readonly CompiledRoute[] = BOT_ROUTES.map((spec) => ({
    ...spec,
    pattern: toPattern(BOT_SURFACE_PREFIX, spec.path),
}));

/** Whether an absolute request path is under this surface at all. */
export function isBotSurfacePath(path: string): boolean {
    return path === BOT_SURFACE_PREFIX || path.startsWith(`${BOT_SURFACE_PREFIX}/`);
}

/**
 * The route a request resolves to, or null.
 *
 * `method` is compared upper-cased; `path` must be the ABSOLUTE path with no query
 * string (`req.path` at app level, before any `use` mount has stripped a prefix).
 */
export function botRouteFor(method: string, path: string): BotRouteSpec | null {
    const upper = method.toUpperCase();
    return COMPILED.find((row) => row.method === upper && row.pattern.test(path)) ?? null;
}

/**
 * Whether this request is a bot READ — the predicate `readonly` maintenance mode needs.
 *
 * Fails CLOSED on a path that matches no row: an unrecognised request under this prefix
 * is going to 404 anyway, and answering "it is a read" for something we cannot name is
 * the wrong direction for a guard.
 */
export function isBotReadRequest(method: string, path: string): boolean {
    const route = botRouteFor(method, path);
    return route !== null && !route.mutating;
}

// ─────────────────────────────────────────────────────────────────────────────
// The import-time structural checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refuse to load a table in which any row is unreachable.
 *
 * A row is shadowed when an EARLIER row with the same method matches one of its own
 * concrete forms — which is what happens the moment `/orders/:orderId` is declared above
 * `/orders/list`. The concrete form is built by substituting a placeholder for every
 * parameter, so a literal-vs-parameter clash at the same position is caught and two
 * different literals are not.
 *
 * Throws a bare `Error` rather than an `AppError`, on purpose: this runs at module load,
 * before any request exists, and the only correct outcome is that the process does not
 * start. `agent.config.ts` throws at import for the same reason.
 */
export function assertNoShadowedRoutes(): void {
    const concrete = (spec: BotRouteSpec): string =>
        `${BOT_SURFACE_PREFIX}${spec.path}`.replace(/:[A-Za-z0-9_]+/g, 'x');

    for (let i = 0; i < COMPILED.length; i++) {
        const row = COMPILED[i];
        const sample = concrete(row);
        for (let j = 0; j < i; j++) {
            const earlier = COMPILED[j];
            if (earlier.method === row.method && earlier.pattern.test(sample)) {
                // A bare Error, at module load, with no request in flight and nothing
                // above to catch it. An AppError exists to be shaped into an HTTP
                // response by the global handler, and there is no response here: the
                // only correct outcome is that the process does not boot.
                // eslint-disable-next-line no-restricted-syntax -- module load, no request
                throw new Error(
                    `[BotSurface] route "${row.method} ${row.path}" (${row.tool}) is unreachable: `
                    + `"${earlier.method} ${earlier.path}" (${earlier.tool}) is declared earlier and `
                    + `matches "${sample}". Declare the literal segment first.`,
                );
            }
        }
    }
}

/** One tool name may name only one route. */
export function assertToolNamesUnique(): void {
    const seen = new Set<string>();
    for (const row of BOT_ROUTES) {
        if (seen.has(row.tool)) {
            // eslint-disable-next-line no-restricted-syntax -- module load; see above.
            throw new Error(`[BotSurface] duplicate tool name in BOT_ROUTES: ${row.tool}`);
        }
        seen.add(row.tool);
    }
}

assertToolNamesUnique();
assertNoShadowedRoutes();
