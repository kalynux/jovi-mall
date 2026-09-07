import { storefrontUrl } from '../../../core/utils/storefront-link.util';

/**
 * The chat list window — how many rows a chat answer may carry, and where the rest live.
 *
 * ── WHY THIS IS SERVER-SIDE AND NOT A LINE IN A PROMPT ───────────────────────
 * A chat reply listing twenty orders is a wall of text nobody reads, and the model paying
 * for those tokens summarises them badly. That much was already understood: `chatPage`
 * defaults every list on this surface to 5.
 *
 * ⚠ **But a default is not a cap.** `limit` was `max(100)`, so a model that decided it
 * needed "all" of something could ask for a hundred and get them — and a rule that lives
 * only in a system prompt is a rule the model breaks under exactly the pressure that makes
 * it matter. The MCP server's `instructions` do say "at most 5"; this file is what makes
 * that true whether or not the model was listening.
 *
 * That is the same argument, for the fourth time, that put `error.customerMessage`, then
 * `onboarding.next.prompt`, then the whole `reply` body on this side of the wire: the
 * automation layer has no copy table, no translator and no URL table, so anything it would
 * otherwise have to *decide* has to arrive already decided. See `bot-surface.md` § 14.
 *
 * ── THE CAP IS USELESS WITHOUT THE ESCAPE HATCH ──────────────────────────────
 * Truncating to five and saying nothing is worse than not truncating: the customer is
 * shown a partial answer presented as a complete one. So the window always reports the
 * real `total` and, when there is more, a deep link into the storefront. `hasMore` is what
 * a client branches on; `moreUrl` is what it renders.
 */

/** The most rows any list on this surface may return. Not a default — a ceiling. */
export const BOT_CHAT_LIST_MAX = 5;

/**
 * The lists a customer can be sent to see the rest of.
 *
 * A closed union rather than a free string, because the value picks a URL: a typo in a
 * caller-supplied path is a 404 in a chat window, discovered by the customer.
 */
export type BotListSurface =
    | 'orders'
    | 'tickets'
    | 'bookings'
    | 'wishlist'
    | 'digital'
    | 'addresses'
    | 'notifications'
    | 'paymentMethods'
    | 'reviews'
    | 'products';

/**
 * Where each list lives on the storefront, as authored — **without** a locale prefix.
 *
 * ⚠ These are `frontend/landing`'s routes and this table is a COPY of them; there is no
 * shared package and nothing checks it at build time. A route renamed there is a dead link
 * here, silently. `test:bot-surface` asserts the shape and the locale rule; it cannot
 * assert that the other repository still serves these paths.
 */
const SURFACE_PATHS: Readonly<Record<BotListSurface, string>> = Object.freeze({
    orders: '/shop/account/orders',
    tickets: '/shop/account/support',
    bookings: '/shop/account/bookings',
    wishlist: '/shop/saved',
    digital: '/shop/account/downloads',
    addresses: '/shop/account/addresses',
    notifications: '/shop/account/notifications',
    paymentMethods: '/shop/account/payment-methods',
    reviews: '/shop/account/reviews',
    products: '/shop',
});

/**
 * Where a list's "see the rest" link points.
 *
 * Three states, and the third arrived with bookings (parity Step 4):
 *
 *   - a `BotListSurface` — one of the fixed account pages in `SURFACE_PATHS`.
 *   - `{ path }` — an ENTITY page composed by the caller. A product's bookable slots do
 *     not live on any fixed page; they live on that product's own page, so the surface
 *     table cannot name the destination and the handler has to. ⚠ The path must be one
 *     this service composed from a storefront route it copied, never one a caller sent —
 *     see `botStorefrontLink`.
 *   - `null` — the storefront has no page for this list at all (`recently_viewed_list`).
 */
export type BotListDestination = BotListSurface | { path: string } | null;

/** What a list answer reports about itself. Rides in `meta`, never in `data`. */
export interface BotListWindow {
    /** How many rows this answer actually carries. Never above `BOT_CHAT_LIST_MAX`. */
    shown: number;
    /** How many exist in total, across every page. */
    total: number;
    /** Is anything left unshown *after* this window? */
    hasMore: boolean;
    /** Where to see the rest. Null when there is no rest, and null when unconfigured. */
    moreUrl: string | null;
}

/**
 * The storefront link for a list, in the customer's own language.
 *
 * ⚠ **The locale prefix is not decoration, and getting it wrong is invisible from here.**
 * `frontend/landing` routes with next-intl's `localePrefix: "as-needed"`: English owns the
 * bare paths (`/shop/account/orders`) and every other language is prefixed
 * (`/fr/shop/account/orders`). A bare path therefore does not 404 for a French customer —
 * middleware rewrites it onto the English tree — which is worse than a 404, because a bot
 * that has just answered in French hands them a link that opens in English and nothing
 * anywhere reports a fault.
 *
 * `toStorefrontLocale` is reused rather than re-deriving the five codes, so this cannot
 * drift from the language the sentence beside the link is written in. It also folds an
 * unknown tag to `en`, which is the safe direction: the unprefixed tree always exists.
 *
 * ⚠ **The storefront may ship a SUBSET of the five** (`APP_LOCALES`, env-driven in
 * that repository), and this service cannot see which. A prefix for a dropped locale would
 * 404 — but only for a customer whose language that build does not serve, who would have
 * been shown English anyway.
 *
 * Returns null when `STOREFRONT_URL` is unset, the same contract `buildPayLinkUrl` already
 * established: a caller must treat null as "there is no link", never render the string.
 */
export function botListMoreUrl(
    surface: BotListDestination,
    language: string | null | undefined,
): string | null {
    /**
     * ⚠ **`null` means "the storefront has no page for this list", and it is a real state
     * rather than a missing value.** `recently_viewed_list` is the case: the landing app
     * records views from the product page and shows them nowhere, so an invitation to "see
     * the rest on the website" would send a customer to a page that does not list them.
     * Saying nothing is the honest answer; inventing a plausible destination is not.
     */
    if (surface === null) return null;
    /**
     * An entity page the handler composed — a product's own page, for its slots. It goes
     * through the same locale rule as everything else, which is the whole reason it is
     * routed through here rather than concatenated at the call site.
     */
    if (typeof surface === 'object') return botStorefrontLink(surface.path, language);
    return botStorefrontLink(SURFACE_PATHS[surface], language);
}

/**
 * Any storefront path, absolute and in the customer's language.
 *
 * Extracted from `botListMoreUrl` when notifications arrived: a notification carries an
 * `action.path` — `/shop/account/orders/abc` — which is the same kind of relative storefront
 * path a list's "see the rest" link is, and needs the same locale prefix. Two copies of the
 * `as-needed` rule is one copy that gets it wrong, and the wrong one fails silently (an
 * English page for a French customer, no error anywhere).
 *
 * ⚠ **Takes a path this service composed, never one a caller supplied.** Everything reaching
 * it is either `SURFACE_PATHS` above or a `path` written by a notification catalogue in this
 * repository. It is not a redirector: handed an absolute URL it would happily concatenate,
 * so do not start passing it one.
 */
export function botStorefrontLink(
    path: string,
    language: string | null | undefined,
): string | null {
    /**
     * ⚠ **This used to implement the `as-needed` rule inline, and a SECOND copy of it was
     * then written in `customer-notification-catalog.ts`** — which is precisely what the
     * paragraph above warns against, in the file that warns about it. The second copy had
     * no locale prefix at all and no `/shop/account` either, so every notification button
     * 404'd for months while this one worked.
     *
     * One implementation now, in `core/utils/storefront-link.util.ts`. Behaviour here is
     * unchanged — same fold, same prefix, same null-when-unset contract.
     */
    return storefrontUrl(path, language);
}

/**
 * Cap a list to what a chat can carry, and describe what was left out.
 *
 * ⚠ **`hasMore` is derived from the real total and the caller's OFFSET, never from the
 * page being full.** Two ways to get this wrong, and both mislead:
 *
 *   - `items.length === BOT_CHAT_LIST_MAX` claims there is more whenever a list is exactly
 *     five long, and the customer follows a link to nothing.
 *   - `total > shown` is right on the first page and wrong on every later one — the last
 *     page of twenty would still advertise more.
 *
 * So the answer is `total > offset + shown`, and a paginated caller passes its offset.
 *
 * The slice is defensive rather than the mechanism: every list schema is clamped to
 * `BOT_CHAT_LIST_MAX`, so a repository should never return more than five. It stays because
 * two lists on this surface are **not** paginated at all (`addresses_list`,
 * `digital_list_entitlements`) and pass their whole array through here — for them this
 * slice *is* the cap.
 */
export function windowForChat<T>(input: {
    items: readonly T[];
    /** Rows matching the query in total, across every page. */
    total: number;
    /** Rows skipped before this window. `(page - 1) * limit`, or 0 when unpaginated. */
    offset?: number;
    /** Null when the storefront has no page for this list — see `botListMoreUrl`. */
    surface: BotListDestination;
    /** The customer's language — `botResponseLanguageOf(req)`. */
    language: string | null | undefined;
}): { items: T[]; window: BotListWindow } {
    const items = input.items.slice(0, BOT_CHAT_LIST_MAX);
    const offset = input.offset ?? 0;

    /**
     * A total below what we are holding is not a fact about the data; it is a caller that
     * counted wrong, or an unpaginated list whose count was never taken. Trusting it would
     * report `hasMore: false` on a list we just truncated. Take the larger.
     */
    const total = Math.max(input.total, offset + items.length);
    const hasMore = total > offset + items.length;

    return {
        items,
        window: {
            shown: items.length,
            total,
            hasMore,
            // No link when there is nothing more to see — an invitation to a page that
            // shows the same five rows is noise, and the model would read it as a cue.
            moreUrl: hasMore ? botListMoreUrl(input.surface, input.language) : null,
        },
    };
}
