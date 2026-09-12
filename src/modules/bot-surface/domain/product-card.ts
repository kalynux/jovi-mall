import { PublicProductListItemDto } from '../../catalog/dto/public-product.dto';
import { addToCartActionId, buyNowActionId } from './bot-action-id';
import { botStorefrontLink } from './bot-list-window';

/**
 * ONE product, described the way a chat window can draw it — and channel-neutrally.
 *
 * ── WHY A SECOND SHAPE, WHEN `PublicProductListItemDto` ALREADY EXISTS ──────
 * That DTO is the storefront's projection: it answers *"what is this product"* and is
 * deliberately explicit so a field the model gains next is not published by accident. What a
 * card needs is a different question — *"what goes on the picture, the line under it, and the
 * three buttons"* — and every answer to it is a decision this service must take rather than
 * pass on:
 *
 *   - **the picture may not exist**, and a chat card with a hole in it reads as a broken bot
 *     rather than as a product with no photograph, so there is a placeholder;
 *   - **the picture may exist and be unfetchable**, which is a different failure and one no
 *     amount of correct JSON fixes — see `isReachableByPlatformServers`;
 *   - **the price is a rendered string**, because the number is formatted once here rather
 *     than in two renderers that would eventually disagree about a thousands separator;
 *   - **the button needs a VARIANT id**, which the list DTO does not carry.
 *
 * Keeping all four here is what lets `channel-reply.ts` stay a renderer: it places text and
 * ids into a platform body and decides nothing about the product.
 *
 * ⚠ **Pure — no clock, no database, no `await`.** `process.env` is read (the two base URLs),
 * which is the one concession, and it is read through functions rather than at module load so
 * a test can set them per case.
 */

/** What a channel renderer is given, per product. */
export interface BotProductCard {
    productId: string;
    /**
     * The default variant — what "Add to cart" adds.
     *
     * ⚠ **Nullable, and a null is not an error.** `PublicProductListRow.defaultVariantId` is
     * `string | null`, and a product whose variants were all withdrawn still lists. A card
     * with no variant keeps its picture and its Details link and **loses its buy buttons**,
     * which is the honest rendering: offering a button that cannot resolve a line is worse
     * than offering none.
     *
     * ⚠ **A SERVICE is nulled here too, and that was found live rather than reasoned.** A
     * bookable class rendered with a working-looking "Add to cart" button, and the tap came
     * back `400 CART_SERVICE_PRODUCT_NOT_ALLOWED` — *"Service products cannot be added to
     * cart"* — every single time. `CartService.addToCart` refuses them by design (they are
     * booked, not carted), so a card must not offer the action at all; the Details link goes
     * to the product page, which is where the booking flow lives.
     */
    variantId: string | null;
    title: string;
    /** Already formatted and already carrying the currency — see `formatBotPrice`. */
    priceText: string;
    storeName: string;
    inStock: boolean;
    /**
     * A URL Telegram's and Meta's servers can actually GET, the placeholder, or null.
     *
     * ⚠ **Never the raw `FileDetail.url`.** Both platforms fetch media server-side, so a URL
     * on a private, loopback or carrier-NAT host is not a slow image — it is a rejected send,
     * and on Telegram the whole `sendPhoto` fails rather than degrading.
     */
    imageUrl: string | null;
    /** The storefront product page, locale-prefixed. Null when `STOREFRONT_URL` is unset. */
    detailUrl: string | null;
    /**
     * The two callback tokens the buy buttons carry — **built here, never in the renderer.**
     *
     * ⚠ This mirrors `BotReplyOption.id`, and the reason is the same one stated at the top of
     * `channel-reply.ts`: that file places text and ids into a platform body and decides
     * nothing else. A renderer that composed `add:<product>:<variant>` would be a renderer
     * that has to know the action vocabulary, and the byte cap that goes with it.
     *
     * Both are null together, when `variantId` is null — there is nothing to add.
     */
    addToken: string | null;
    buyToken: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `20 000 XAF`, and deliberately not `Intl.NumberFormat`.
 *
 * Two reasons, and the second is the one that would bite later. ICU renders XAF as
 * `20 000 F CFA` in French and `XAF 20,000` in English, with a **narrow no-break space** whose
 * code point differs between Node builds — so a snapshot assertion in `test:bot-surface` would
 * pass on one machine and fail on another. And the grouping character would then differ
 * between the card caption and every other price this platform prints, none of which goes
 * through ICU either.
 *
 * XAF has no minor unit, so a fractional amount is rounded rather than shown — the catalogue
 * stores whole francs and a `.5` here means somebody's arithmetic, not a price.
 */
export function formatBotPrice(amount: number, currency: string): string {
    const whole = Math.round(Number.isFinite(amount) ? amount : 0);
    const grouped = Math.abs(whole)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${whole < 0 ? '-' : ''}${grouped} ${currency}`;
}

/** `9 000 – 22 000 XAF` when a product's variants do not agree on a price. */
export function formatBotPriceRange(min: number, max: number, currency: string): string {
    if (min === max) return formatBotPrice(min, currency);
    const low = formatBotPrice(min, currency).replace(` ${currency}`, '');
    return `${low} – ${formatBotPrice(max, currency)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Media
// ─────────────────────────────────────────────────────────────────────────────

/** The one route serving the placeholder. Kept beside its consumer so the two cannot drift. */
export const BOT_PLACEHOLDER_IMAGE_PATH = '/api/public/assets/no-product-image.png';

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

/**
 * The public origin of THIS API, as the outside world reaches it.
 *
 * ⚠ **`BOT_MEDIA_PUBLIC_BASE_URL` is an ORIGIN, not a media path** — `https://api.example.com`,
 * never `https://api.example.com/api/files`. It exists because a media URL has to be fetched
 * by somebody else's servers, and the address this service knows itself by is routinely not
 * the address they can reach: a container hostname, a `localhost`, or — as on this platform
 * today — a Tailscale `100.x` address that is unroutable from the public internet.
 *
 * Falls back to `API_PUBLIC_URL`, which is what an ordinary single-origin deployment already
 * sets. Both are optional, and the absence of a usable one is a documented degradation rather
 * than a fault: cards render without pictures.
 */
function publicApiOrigin(): string | null {
    const explicit = stripTrailingSlashes(process.env.BOT_MEDIA_PUBLIC_BASE_URL ?? '');
    if (explicit) return explicit;
    const fallback = stripTrailingSlashes(process.env.API_PUBLIC_URL ?? '');
    return fallback || null;
}

/**
 * Hosts a platform's fetcher cannot reach, however correct the URL is.
 *
 * ⚠ **This is a reachability test, not a security check**, and it is worth having precisely
 * because the failure it prevents is silent in the worst way: Telegram answers
 * `400 failed to get HTTP URL content` and the entire `sendPhoto` is lost — caption, keyboard
 * and all — while Meta accepts the message and delivers a card with a grey box. Neither
 * reports anything this service can see.
 *
 * The ranges are the ones that are unroutable BY DEFINITION rather than by policy: loopback,
 * RFC1918, link-local, and **`100.64/10` (carrier-grade NAT, which is what Tailscale hands
 * out)** — the range this platform's own `STORAGE_LOCAL_URL` sits in today. A public host that
 * happens to be firewalled is not detectable from a string and is not attempted.
 */
export function isReachableByPlatformServers(rawUrl: string): boolean {
    let host: string;
    try {
        host = new URL(rawUrl).hostname.toLowerCase();
    } catch {
        return false;
    }

    if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.localhost')) {
        return false;
    }

    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!v4) return true; // a name, or an IPv6 literal that is not loopback

    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    // 100.64.0.0/10 — carrier-grade NAT. Tailscale addresses live here.
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
}

/**
 * A stored file's URL, rewritten onto the public origin when it is one of ours.
 *
 * Only the ORIGIN is swapped; the path is the storage key and must survive byte-identical.
 * A URL whose origin is not ours — an object-storage or CDN provider — is passed through
 * untouched, because rewriting it would point at a path this API does not serve.
 *
 * Returns null when the result still could not be fetched, which is what makes the whole
 * feature degrade instead of failing: a card with no `imageUrl` renders as text.
 */
export function toPublicMediaUrl(rawUrl: string | null | undefined): string | null {
    if (!rawUrl) return null;

    const origin = publicApiOrigin();
    const ours = [process.env.STORAGE_LOCAL_URL, process.env.API_PUBLIC_URL]
        .map((value) => {
            try {
                return value ? new URL(value).origin : null;
            } catch {
                return null;
            }
        })
        .filter((value): value is string => value !== null);

    let candidate = rawUrl;
    if (origin) {
        try {
            const parsed = new URL(rawUrl);
            if (ours.includes(parsed.origin)) {
                candidate = `${origin}${parsed.pathname}${parsed.search}`;
            }
        } catch {
            return null;
        }
    }

    return isReachableByPlatformServers(candidate) ? candidate : null;
}

/** The stand-in picture, absolute — or null when there is no reachable origin to serve it from. */
export function botPlaceholderImageUrl(): string | null {
    const origin = publicApiOrigin();
    if (!origin) return null;
    const url = `${origin}${BOT_PLACEHOLDER_IMAGE_PATH}`;
    return isReachableByPlatformServers(url) ? url : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The card
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One storefront row → one chat card.
 *
 * `item.image` is a `FileDetail`, so it is **already null** for a private or quota-blocked
 * file — `toFileDetail` decided that, and this must not second-guess it. What is added here is
 * the reachability rule and the placeholder, in that order: a real photograph that cannot be
 * fetched is replaced by the stand-in rather than dropped, because the customer should see a
 * card either way and the difference is invisible to them.
 */
export function toBotProductCard(
    item: PublicProductListItemDto,
    defaultVariantId: string | null,
    language: string | null | undefined,
): BotProductCard {
    const priceText = item.priceRange
        ? formatBotPriceRange(item.priceRange.min, item.priceRange.max, item.currency)
        : formatBotPrice(item.price, item.currency);

    /**
     * ⚠ **What may be bought FROM A BUTTON, which is narrower than what may be listed.**
     *
     * A service is bookable and not cartable — `CartService.addToCart` refuses one outright —
     * so it is shown, and shown without buy buttons. The check is on the type rather than on
     * a try-and-see, because the failure is a 400 the customer reads as the shop being
     * broken, and it happens on every tap rather than occasionally.
     */
    const buyable = item.type !== 'service' ? defaultVariantId : null;

    return {
        productId: item.id,
        variantId: buyable,
        title: item.title,
        priceText,
        storeName: item.store.name,
        inStock: item.inStock,
        imageUrl: toPublicMediaUrl(item.image?.url ?? null) ?? botPlaceholderImageUrl(),
        detailUrl: botStorefrontLink(
            `/shop/stores/${item.store.slug}/products/${item.slug}`,
            language,
        ),
        addToken: buyable ? addToCartActionId(item.id, buyable) : null,
        buyToken: buyable ? buyNowActionId(item.id, buyable) : null,
    };
}
