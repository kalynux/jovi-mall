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
    /**
     * ⚠ **LITERALS BEFORE THE BARE PATH.** `/checkout/screen` and its two siblings are
     * declared above `/checkout` deliberately — not because Express would confuse them (they
     * differ in segment count) but because `assertNoShadowedRoutes()` is the only thing
     * standing between this table and the `/articles/index`-behind-`/articles/:slug` defect
     * this service has shipped twice, and literal-first is the habit that keeps it true.
     */
    /**
     * Mints the checkout screen's handle.
     *
     * ⚠ **`mutating: true` although it writes no business record**, for the reason
     * `inapp_open_*` carries it: it mints **the largest credential on this surface** — a URL
     * that can place an order against a saved address and start a payment. A retried chat
     * message must collapse onto one handle rather than leaving a trail of live ones.
     */
    { tool: 'checkout_open_screen', method: 'POST', path: '/checkout/screen', mutating: true, requiresCustomerRole: true },
    /**
     * ⚠ **NOT a duplicate of `payment_get_transaction`, and the difference is the whole point.**
     * That one reads the stored record; this one asks the GATEWAY. A mobile-money confirmation
     * arrives by webhook, and a webhook that has not landed leaves the record saying PENDING for
     * a payment approved two minutes ago — so at the one moment a customer asks "did it go
     * through?", the stored answer is the wrong one. Today only the reconciliation sweep closes
     * that gap, ten minutes out.
     *
     * ⚠ **It takes no transactionId on purpose.** The id never reaches the chat — the screen's
     * `place` answers a browser and the browser closes — so a model asked for one would invent
     * it. It resolves the caller's own latest checkout payment instead.
     */
    { tool: 'checkout_payment_status', method: 'POST', path: '/checkout/payment-status', mutating: false, requiresCustomerRole: true },
    /**
     * ⚠ `mutating: true` for the reason `bookings_pay` is: it pushes a USSD prompt to a real
     * handset, and a second unasked-for prompt is a second interruption of somebody's day.
     */
    { tool: 'checkout_retry_payment', method: 'POST', path: '/checkout/retry-payment', mutating: true, requiresCustomerRole: true },
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
    /**
     * The customer's own words about why they cancelled, recorded one turn AFTER the
     * cancellation — the tap is the decision and the reason is typed next, so the model files
     * what they say.
     *
     * ⚠ **Mutating, so it needs an `Idempotency-Key` like every other write** — and the
     * handler additionally refuses a second note outright (`ORDER_CANCELLATION_REASON_ALREADY_
     * RECORDED`, 409), because a replayed tool call must not append a second, contradictory
     * story to one order's history.
     */
    { tool: 'orders_record_cancellation_reason', method: 'POST', path: '/orders/:orderId/cancellation-reason', mutating: true, requiresCustomerRole: true },
    { tool: 'orders_resend_cod_code', method: 'POST', path: '/orders/:orderId/shipments/:shipmentId/resend-delivery-code', mutating: true, requiresCustomerRole: true },
    { tool: 'orders_confirm_shipment_delivery', method: 'POST', path: '/orders/:orderId/shipments/:shipmentId/confirm-delivery', mutating: true, requiresCustomerRole: true },

    // ── Profile and addresses ────────────────────────────────────────────────
    { tool: 'profile_get_summary', method: 'POST', path: '/profile', mutating: false, requiresCustomerRole: true },
    { tool: 'profile_set_language', method: 'PATCH', path: '/profile/language', mutating: true, requiresCustomerRole: true },
    { tool: 'addresses_list', method: 'POST', path: '/addresses/list', mutating: false, requiresCustomerRole: true },
    { tool: 'addresses_add', method: 'POST', path: '/addresses', mutating: true, requiresCustomerRole: true },
    { tool: 'profile_update', method: 'PATCH', path: '/profile', mutating: true, requiresCustomerRole: true },
    /**
     * ⚠ **ORDER: `/default` is declared BEFORE the bare `:addressId`.**
     *
     * The two do not actually collide — Express matches `/addresses/:addressId` against one
     * segment and `/addresses/:addressId/default` against two — so `assertNoShadowedRoutes`
     * passes either way. It is written in this order anyway because the next person adding
     * `/addresses/:addressId/<something>` will copy the line above it, and the habit is
     * what keeps this table out of the trap that put `/articles/index` behind
     * `/articles/:slug` and `/orders/groups/:cartId` behind `/orders/:id`.
     */
    { tool: 'addresses_set_default', method: 'PATCH', path: '/addresses/:addressId/default', mutating: true, requiresCustomerRole: true },
    { tool: 'addresses_update', method: 'PATCH', path: '/addresses/:addressId', mutating: true, requiresCustomerRole: true },
    { tool: 'addresses_remove', method: 'DELETE', path: '/addresses/:addressId', mutating: true, requiresCustomerRole: true },

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
    /**
     * ⚠ **Three segments, and it CANNOT be declared before `/tickets/:ticketId`** — the
     * shadowing rule runs the other way here. `/tickets/:ticketId` is two segments and
     * matches nothing three long, so the literal tail is what distinguishes this from
     * `/notes` and `/close`. `assertNoShadowedRoutes()` checks it either way.
     */
    { tool: 'tickets_add_attachment', method: 'POST', path: '/tickets/:ticketId/attachments', mutating: true, requiresCustomerRole: true },

    // ── Inbound files (Step 7b) ──────────────────────────────────────────────
    /**
     * The one row on this surface that carries a PAYLOAD rather than a reference, and the
     * one the automation layer calls before the model runs at all.
     *
     * ⚠ **`mutating: true`, and a read-only maintenance window must refuse it.** It writes
     * a `files` row and bytes into storage. The consequence is worth stating because it is
     * mild and easy to mistake for a bug: during such a window a customer's photo is
     * refused with a sentence they can read, the conversation carries on, and nothing else
     * on the ticket path stops working.
     */
    { tool: 'files_receive_inbound', method: 'POST', path: '/files/inbound', mutating: true, requiresCustomerRole: true },

    // ── Support routing (GAP-004) ────────────────────────────────────────────
    // A read, and one whose `mutating: false` is worth a word: it is the FIRST step of the
    // support flow, so a `readonly` maintenance window that refused it would leave a
    // customer unable to find out who to complain to about the window. Nothing it touches
    // is written — the ladder only reads what other routes recorded.
    { tool: 'support_resolve_contacts', method: 'POST', path: '/support/context', mutating: false, requiresCustomerRole: true },

    // ── Product cards ────────────────────────────────────────────────────────
    /**
     * ⚠ **`mutating: true` on a route that changes nothing about the customer**, and the
     * reason is worth stating because the column's own docstring above says it answers
     * *"would running this twice do something the customer did not ask for"*.
     *
     * It would. Each call mints a **Mini App handle** — a URL that lets a browser write to
     * this customer's basket — and a retried chat message that minted a second one would
     * leave the first live with nobody having asked for it. The drawing is free; the
     * credential is not, and the `Idempotency-Key` is what collapses a retry onto one.
     */
    { tool: 'catalog_show_products', method: 'POST', path: '/catalog/display', mutating: true, requiresCustomerRole: true },
    /**
     * The customer pressed a button under a card. `add:` and `buy:` write to the basket, so
     * a retry without a key would double a line — the same reason `cart_add_item` is
     * classified this way, arriving through a different door.
     */
    { tool: 'catalog_display_action', method: 'POST', path: '/catalog/action', mutating: true, requiresCustomerRole: true },

    // ── Discovery: browsing by category, and what other customers said ───────
    /**
     * ⚠ **Both are `mutating: false`, unlike `catalog_show_products` above, and the difference
     * is the credential.** Drawing product cards mints a handle a browser can write a basket
     * with; these two draw buttons whose tokens carry nothing but a category digest or a
     * product id, so a retried chat message costs nothing and needs no `Idempotency-Key`.
     */
    { tool: 'catalog_browse_categories', method: 'POST', path: '/catalog/categories', mutating: false, requiresCustomerRole: true },
    { tool: 'catalog_product_reviews_summary', method: 'POST', path: '/catalog/products/:productId/reviews', mutating: false, requiresCustomerRole: true },

    // ── The in-app screens ───────────────────────────────────────────────────
    /**
     * ⚠ **All three are `mutating`, and none of them writes a business record.** They mint a
     * handle that authorises a browser to read a customer's data and — on the checkout screen
     * this trio will grow — to spend money. That is the same reasoning
     * `catalog_show_products` is classified under: the `Idempotency-Key` collapses a retried
     * chat message onto ONE handle instead of leaving a trail of live credentials behind every
     * network hiccup.
     *
     * ⚠ **`/inapp/stores` before `/inapp/products/:productId`** is not load-bearing here (the
     * segments differ), but the order is kept literal-first anyway because
     * `assertNoShadowedRoutes()` is the only thing standing between this table and the
     * `/articles/index`-behind-`/articles/:slug` defect this service has already shipped twice.
     */
    { tool: 'inapp_open_listing', method: 'POST', path: '/inapp/listing', mutating: true, requiresCustomerRole: true },
    { tool: 'inapp_open_stores', method: 'POST', path: '/inapp/stores', mutating: true, requiresCustomerRole: true },
    /**
     * The order-history screen's door.
     *
     * ⚠ **It takes no arguments at all**, and that is the session shape rather than an
     * oversight: an order listing is scoped by the caller's own identity, so naming an id
     * would be inventing a parameter that could only ever be wrong. `InAppSurfaceSession`'s
     * `ol` member carries no query for the same reason.
     */
    { tool: 'inapp_open_orders', method: 'POST', path: '/inapp/orders', mutating: true, requiresCustomerRole: true },
    { tool: 'inapp_open_product', method: 'POST', path: '/inapp/products/:productId', mutating: true, requiresCustomerRole: true },

    // ── Wishlist and recently viewed ─────────────────────────────────────────
    { tool: 'wishlist_list', method: 'POST', path: '/wishlist/list', mutating: false, requiresCustomerRole: true },
    { tool: 'wishlist_add', method: 'POST', path: '/wishlist', mutating: true, requiresCustomerRole: true },
    { tool: 'wishlist_remove', method: 'DELETE', path: '/wishlist/:productId', mutating: true, requiresCustomerRole: true },
    // Naturally idempotent — re-viewing moves the entry to the head rather than adding a
    // second one — but it WRITES, and a read-only window must not accept it.
    { tool: 'recently_viewed_record', method: 'POST', path: '/recently-viewed', mutating: true, requiresCustomerRole: true },
    { tool: 'recently_viewed_list', method: 'POST', path: '/recently-viewed/list', mutating: false, requiresCustomerRole: true },
    /**
     * Destructive and not recoverable — the rows are deleted, not flagged — so `mutating`
     * carries its full weight here rather than the "would a retry surprise anybody" reading
     * the record above gets. A retry of a clear is harmless; the FIRST call is the one that
     * needs the customer to have asked for it, which is why the catalogue marks it
     * `requires_confirmation`.
     */
    { tool: 'recently_viewed_clear', method: 'DELETE', path: '/recently-viewed', mutating: true, requiresCustomerRole: true },

    // ── Digital delivery ─────────────────────────────────────────────────────
    { tool: 'digital_list_entitlements', method: 'POST', path: '/digital/my-products', mutating: false, requiresCustomerRole: true },
    { tool: 'digital_create_download_link', method: 'POST', path: '/digital/download-links', mutating: true, requiresCustomerRole: true },

    // ── Bookings ─────────────────────────────────────────────────────────────
    { tool: 'bookings_list', method: 'POST', path: '/bookings/list', mutating: false, requiresCustomerRole: true },
    /**
     * ⚠ **A LITERAL among the `:bookingId` rows, and it must stay above them.**
     * `/bookings/availability` and `/bookings/:bookingId` are both two segments, so this is
     * the real shadowing case rather than the habitual one — `assertNoShadowedRoutes` refuses
     * the table if these two are swapped, which is the guard `/articles/index` did not have.
     *
     * It reads a PRODUCT's slots, not a booking, and it is filed here anyway: the identity
     * envelope is a body, `productId` rides in it, and adding a `/products/*` family to this
     * surface for one read would be a second place to look for booking things.
     */
    { tool: 'bookings_get_availability', method: 'POST', path: '/bookings/availability', mutating: false, requiresCustomerRole: true },
    /**
     * ⚠ **This TAKES THE SLOT HOLD ITSELF**, which is why there is no `bookings_lock_slot`
     * beside it. The hold is acquired and released inside this one request, so no chat turn
     * can end with a slot held. See `BotBookingController.create`.
     */
    { tool: 'bookings_create', method: 'POST', path: '/bookings', mutating: true, requiresCustomerRole: true },
    { tool: 'bookings_get', method: 'POST', path: '/bookings/:bookingId', mutating: false, requiresCustomerRole: true },
    { tool: 'bookings_get_balance', method: 'POST', path: '/bookings/:bookingId/balance', mutating: false, requiresCustomerRole: true },
    { tool: 'bookings_payment_status', method: 'POST', path: '/bookings/:bookingId/payment-status', mutating: false, requiresCustomerRole: true },
    /**
     * Both money rows. `mutating` for the reason the column actually asks about: each one
     * pushes a USSD prompt to a real handset, and a second unasked-for prompt is a second
     * interruption — even though the orchestrator's own idempotency key would refuse to
     * charge twice (`PAYMENT_BOOKING_IN_PROGRESS`).
     */
    { tool: 'bookings_pay', method: 'POST', path: '/bookings/:bookingId/pay', mutating: true, requiresCustomerRole: true },
    { tool: 'bookings_pay_balance', method: 'POST', path: '/bookings/:bookingId/pay-balance', mutating: true, requiresCustomerRole: true },
    { tool: 'bookings_cancel', method: 'POST', path: '/bookings/:bookingId/cancel', mutating: true, requiresCustomerRole: true },
    /** Takes the hold on the NEW slot itself, for the same reason `bookings_create` does. */
    { tool: 'bookings_reschedule', method: 'PATCH', path: '/bookings/:bookingId/reschedule', mutating: true, requiresCustomerRole: true },

    // ── Saved payment methods ────────────────────────────────────────────────
    { tool: 'payment_methods_list', method: 'POST', path: '/payment-methods/list', mutating: false, requiresCustomerRole: true },
    /**
     * ⚠ **Mobile money only, and the reason is structural rather than cautious.** The
     * customer API takes `gateway_customer_id` and `gateway_instrument_id`, which for a CARD
     * are produced by the gateway's own SDK running in a browser. A chat has no browser and
     * therefore no way to obtain one — a model asked for those fields would invent them. For
     * a WALLET the two values are simply the customer's phone number, so this route takes
     * the number and builds the rest itself. See `BotPaymentMethodController.add`.
     */
    { tool: 'payment_methods_add', method: 'POST', path: '/payment-methods', mutating: true, requiresCustomerRole: true },
    { tool: 'payment_methods_set_default', method: 'PATCH', path: '/payment-methods/:methodId/default', mutating: true, requiresCustomerRole: true },
    // The SIXTH `DELETE` with a body on this surface. Count the table, not the sentence in § 3.
    { tool: 'payment_methods_remove', method: 'DELETE', path: '/payment-methods/:methodId', mutating: true, requiresCustomerRole: true },

    // ── Typed slash commands ─────────────────────────────────────────────────
    /**
     * ⭐ **One route for every command the customer types**, and the vocabulary lives here
     * rather than in the automation layer. n8n forwards the raw text of any message starting
     * with `/` and holds no command list, no alias table and no argument grammar — the same
     * argument § 14.6 already makes about parsing a typed answer, applied to the alias table,
     * which is a five-language table.
     *
     * ⚠ **NOT `anonymous`, and that was a deliberate reversal.** The first draft flagged it so
     * `/help` could answer somebody whose identity had not resolved. `test:bot-surface` refused
     * it, and the refusal was right: the exemption exists for rows that answer questions
     * *about* the sender, and this one **acts for them** — it dispatches `/cancel` and
     * `/cart clear`. An anonymous door onto every command is the one shape that rule forbids.
     *
     * The case it was protecting turns out to be mostly imaginary. `/identity/sync` runs on
     * EVERY inbound message and auto-registers (GAP-002), so a sender reaching this route has
     * an account and resolves. Where resolution genuinely fails, the identity refusal already
     * carries `customerMessage` and — on an unbound Telegram chat — renders the
     * `request_contact` keyboard, which is a better first turn than a command list to somebody
     * the platform cannot yet act for.
     *
     * ⚠ **`mutating: true`, and the cost is recorded rather than solved.** This one route
     * carries `/orders` (a read) and `/cancel` (a write), so a `readonly` maintenance window
     * refuses the reads too. Splitting by verb is not available: only the parser knows which
     * verb a message is, and it runs inside the handler — behind the guard that would have to
     * decide. Per-command maintenance classification is the fix, and it is a follow-up.
     */
    { tool: 'commands_dispatch', method: 'POST', path: '/command', mutating: true, requiresCustomerRole: true },

    // ── Account access ───────────────────────────────────────────────────────
    /**
     * ⚠ **The ONLY route on this surface that mints a credential, and the only one whose
     * result the caller is not allowed to read.** Everything else here returns what it did;
     * this returns whether it did it. The sign-in link and the eight-character code go
     * straight to the customer's chat from `sender-login-delivery.service.ts`, because the
     * catalogue's `never_relay: ["message"]` means exactly what it says and a tool response
     * is read by a model and stored in its Redis chat memory.
     *
     * ⚠ **It does not contradict "not a session mint" in § 3 of `bot.routes.ts`.** That rule
     * forbids issuing a customer bearer token TO THE AUTOMATION LAYER, and this issues
     * nothing to the automation layer at all — the credential is redeemed by a human in a
     * browser, and n8n never holds it. A route that answered with the token would be the
     * thing that rule forbids, which is the second reason this one does not.
     *
     * `/reset-password` is deliberately absent — see `bot-auth.controller.ts`.
     */
    { tool: 'auth_send_login_link', method: 'POST', path: '/auth/login-link', mutating: true, requiresCustomerRole: true },

    // ── Contact changes (MCP parity step 6) ──────────────────────────────────
    /**
     * ⚠ **The five writes below move or abandon WHAT THE ACCOUNT SIGNS IN WITH**, which is
     * why every one of them is `flow_only` in the catalogue and none reaches a model. The
     * read is not: "what am I signed in with, and is anything in flight?" is the question a
     * customer actually asks, and answering it is what stops the flow being entered blind.
     *
     * ⚠ **`/contact/email/pending` and `/contact/phone/pending` are literals under a family
     * that carries NO `:param`**, so nothing can shadow anything today. Keep it that way: a
     * `/contact/email/:something` added later must be declared AFTER them — the same note
     * `user.routes.ts` carries about the endpoints these delegate to.
     */
    { tool: 'contact_get_state', method: 'POST', path: '/contact', mutating: false, requiresCustomerRole: true },
    { tool: 'contact_change_email', method: 'PATCH', path: '/contact/email', mutating: true, requiresCustomerRole: true },
    { tool: 'contact_cancel_email_change', method: 'DELETE', path: '/contact/email/pending', mutating: true, requiresCustomerRole: true },
    { tool: 'contact_change_phone', method: 'PATCH', path: '/contact/phone', mutating: true, requiresCustomerRole: true },
    /**
     * Confirming takes NO arguments and is still `mutating` — it is the single write that
     * moves `login_phone`, and the pending block it spends is gone afterwards. A retry
     * answers `409 CONTACT_CHANGE_NOT_PENDING`, which is the correct outcome and not one a
     * caller should reach by accident.
     */
    { tool: 'contact_confirm_phone', method: 'POST', path: '/contact/phone/confirm', mutating: true, requiresCustomerRole: true },
    { tool: 'contact_cancel_phone_change', method: 'DELETE', path: '/contact/phone/pending', mutating: true, requiresCustomerRole: true },

    // ── Messaging connections and account closure (MCP parity step 7) ────────
    { tool: 'connections_list', method: 'POST', path: '/connections/list', mutating: false, requiresCustomerRole: true },
    /**
     * ⚠ **The SEVENTH `DELETE` with a body on this surface**, and the only route here that
     * refuses on a property of the CALLER rather than of the argument: disconnecting the
     * channel the request arrived on is `409 BOT_CONNECTION_ACTIVE_CHANNEL`. See
     * `BotAccountController.disconnect`.
     */
    { tool: 'connections_disconnect', method: 'DELETE', path: '/connections/:channel', mutating: true, requiresCustomerRole: true },
    /**
     * ⚠ **A READ that exists so the write below can be a two-step**, and it is declared
     * first for the habitual reason even though the two cannot collide (`/account/close` is
     * two segments and `/account/close/preview` is three, and neither carries a `:param`).
     *
     * It is a separate route rather than a no-argument branch of `account_close` because
     * that row is `mutating`: `botIdempotency` demands a key on it, and a preview sharing
     * one with the close collides on the request fingerprint. See
     * `BotAccountController.closePreview`.
     */
    { tool: 'account_close_preview', method: 'POST', path: '/account/close/preview', mutating: false, requiresCustomerRole: true },
    /**
     * Irreversible, and the most destructive row on this surface — the identifiers are
     * removed rather than archived (ADR-A02 D-1). `mutating` carries its full weight: it is
     * the FIRST call that needs the customer to have asked for it, which is what the typed
     * confirmation phrase is for, and a retry answers `409` from the compare-and-set on
     * `active` rather than re-running the cascade.
     *
     * `POST`, not `DELETE`, mirroring `POST /api/me/close`: the account row is not removed,
     * and a `DELETE` would promise on the wire exactly the thing the design refuses to do.
     */
    { tool: 'account_close', method: 'POST', path: '/account/close', mutating: true, requiresCustomerRole: true },

    // ── Reviews ──────────────────────────────────────────────────────────────
    { tool: 'reviews_check_eligibility', method: 'POST', path: '/reviews/eligibility', mutating: false, requiresCustomerRole: true },
    /**
     * ⚠ **`/reviews/list` is a literal beside `/reviews`, and the order below is the safe
     * one.** This family has no `:param` route today, so nothing can shadow anything — but
     * `POST /reviews/:reviewId` is the obvious next row, and it would swallow both literals.
     * Declared before the bare mount for the same reason `/notifications/read-all` is.
     */
    { tool: 'reviews_list_mine', method: 'POST', path: '/reviews/list', mutating: false, requiresCustomerRole: true },
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
    { tool: 'notifications_list', method: 'POST', path: '/notifications/list', mutating: false, requiresCustomerRole: true },
    { tool: 'notifications_unread_count', method: 'POST', path: '/notifications/unread-count', mutating: false, requiresCustomerRole: true },
    /**
     * ⚠ **Literals before the parameter, and here it is not merely habit.** The customer
     * API's own router carries a comment about this exact path family: `read-all` and
     * `preferences` would each match a bare `:id` segment. These two do not collide —
     * `/notifications/read-all` is one segment and `/notifications/:notificationId/read` is
     * two — but the family is one `PATCH /notifications/:id` away from the trap, so the
     * order is written the safe way round.
     */
    { tool: 'notifications_mark_all_read', method: 'PATCH', path: '/notifications/read-all', mutating: true, requiresCustomerRole: true },
    { tool: 'notifications_mark_read', method: 'PATCH', path: '/notifications/:notificationId/read', mutating: true, requiresCustomerRole: true },
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
