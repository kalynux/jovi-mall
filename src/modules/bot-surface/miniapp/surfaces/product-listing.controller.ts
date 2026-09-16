import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { PublicProductListItemDto } from '../../../catalog/dto/public-product.dto';
import { PublicProductListQuery } from '../../../catalog/validators/public-catalog.validator';
import { publicCatalogService } from '../../../catalog/services/public-catalog.service';
import { toBotCopyLanguage } from '../../domain/bot-error-copy';
import { formatBotPrice, formatBotPriceRange, toPublicMediaUrl } from '../../domain/product-card';
import { __IN_APP_SCREEN_PATH } from '../../domain/inapp-url';
import {
    InAppListingQuery,
    InAppSurfaceSession,
    inAppSurfaceStore,
} from '../../services/inapp-surface.store';

/**
 * `inAppProductListing` — the browse grid's two endpoints.
 *
 * ── WHAT THIS FILE IS, AND WHERE ITS SPECIFICATION LIVES ────────────────────
 * The response shapes below are written out as a contract in the opening comment of
 * `public/pl.html`, which is the page that consumes them. That comment is the specification
 * and this file implements it; if the two ever disagree, the page is right, because the page
 * is what a customer sees.
 *
 * ── ⚠ IT PAGES THE QUERY, NOT A HELD LIST OF IDS ────────────────────────────
 * This is the deliberate opposite of `ProductDisplaySet`, and `inapp-surface.store.ts` argues
 * both sides at length. The short version: that store holds the ten ids the *model* chose, so
 * that page two cannot re-run a search and quietly return different products at different
 * prices. A listing screen is not that — it is a grid a customer scrolls, and it **must page
 * past ten**. Inheriting `BOT_DISPLAY_MAX_PRODUCTS` would make it look broken at row eleven,
 * which is the single most likely way this screen gets quietly ruined later.
 *
 * Both doctrines are right for their own surface. Do not unify them.
 *
 * ── THE MOUNT IS THE SECURITY DECISION, AND IT IS INHERITED ─────────────────
 * `/api/bot/miniapp/**` carries neither `INTERNAL_SERVICE_TOKEN` nor `BOT_WEBHOOK_SECRET` — a
 * browser can hold neither without handing every viewer the whole bot surface. The opaque
 * handle in the URL is the only credential; it names one conversation, it is kind-checked on
 * read, and it dies in thirty minutes. Nothing here reads an identity out of the request, and
 * nothing may start: the session already knows whose it is.
 */

/**
 * How many cards a page of the grid holds.
 *
 * ⚠ **Deliberately NOT `BOT_DISPLAY_MAX_PRODUCTS` (10), and larger than it on purpose.** That
 * constant bounds what a *chat* answer may carry, where five cards is a wall of text and ten
 * is the ceiling on a held set. A scrolling grid has no such constraint, and a customer who
 * taps "Load more" after nine products is being shown the seams of an implementation.
 *
 * Twenty-four divides by two, three and four, so it fills the last row evenly at every column
 * count `shell.css` produces. It stays under `LimitSchema`'s ceiling of 100.
 */
const PAGE_SIZE = 24;

/**
 * The most pages a customer may walk forward through.
 *
 * Not a product decision — a bound on a public, unauthenticated read whose cursor is
 * caller-supplied. Twenty-four times two hundred is 4 800 rows, past which nobody is browsing
 * and somebody is enumerating the catalogue one deep `$skip` at a time.
 */
const MAX_PAGE = 200;

/**
 * ⚠ **The cursor is a page number, and it is deliberately not opaque.**
 *
 * The page treats it as a token and never reads it, so it *could* be encoded — but encoding
 * would imply it carries something worth hiding, and it does not. What bounds this read is the
 * session, which pins the query; the cursor only says how far down that one query the customer
 * has scrolled. An edited cursor reaches a different page of the same query, which is the same
 * thing scrolling reaches.
 */
const CursorSchema = z.object({
    cursor: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
});

const HandleSchema = z.object({ handle: z.string().trim().min(3).max(64) });

const OpenSchema = z
    .object({
        productId: z.string().regex(/^[0-9a-fA-F]{24}$/),
    })
    .strict();

export class ProductListingController {
    /**
     * `GET /api/bot/miniapp/s/pl/:handle/data` — one page of the grid.
     *
     * ⚠ **Re-read live on every page, never cached onto the session.** A card quotes a price a
     * customer can hold us to, and a listing lives for thirty minutes; page two must say what
     * the product costs now rather than what it cost when the screen was opened. The session
     * holds the *question*, and the catalogue answers it each time.
     */
    static data = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);
        const { cursor } = CursorSchema.parse(req.query);
        const session = await readListing(handle);

        const page = cursor ?? 1;
        const { products, hasMore } = session.query.productIds?.length
            ? await pinnedPage(session.query.productIds, page)
            : await queryPage(session.query, page);

        /**
         * ⚠ **Extended on a READ, which is the one place a customer's attention is visible.**
         * Somebody scrolling a grid is using the screen; letting it lapse under them because
         * the clock started when the chat button was tapped is a lapse they did nothing to
         * earn. `touch` moves the Redis TTL and the recorded expiry together, and it refuses
         * `co` outright — a checkout credential must never slide this way.
         *
         * Not awaited for its result: a failed extension costs a customer a re-tap much later,
         * and failing this read over it would cost them the page they are looking at now.
         */
        void inAppSurfaceStore.touch('pl', handle).catch(() => undefined);

        sendSuccess(res, {
            heading: headingFor(session.query),
            products,
            /**
             * ⚠ **`page < MAX_PAGE` is not belt-and-braces — without it the last "Load more"
             * is an ERROR rather than an ending.** The grid would hand the page a cursor of
             * `MAX_PAGE + 1`, the page would send it straight back, and `CursorSchema` would
             * refuse its own successor with a 400 — which `pl.html` renders as "something went
             * wrong". A customer who has scrolled to the bottom of a large catalogue would be
             * told the shop is broken at the exact moment it simply ran out of products.
             *
             * A null cursor hides the button instead, which is what the end of a list looks
             * like.
             */
            cursor: hasMore && page < MAX_PAGE ? String(page + 1) : null,
        });
    });

    /**
     * `POST /api/bot/miniapp/s/pl/:handle/open` — mint a detail session for one product.
     *
     * ⚠ **A POST rather than a link per card, and the reason is arithmetic.** The detail screen
     * needs its own `pd` handle and only the backend can mint one, so a grid of 24 cards drawn
     * with links would mean 24 Redis writes per page — for a customer who taps at most one.
     * The page posts the product it wants and gets one URL back.
     *
     * ⚠ **This mints a session. It is NOT a purchase** — nothing here touches a cart, a price
     * or an order. The purchase button lives on the screen this opens, and what it does is
     * `POST /s/pd/:handle/act`, which belongs to the stream that owns the write path.
     */
    static open = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);
        const { productId } = OpenSchema.parse(req.body ?? {});
        const session = await readListing(handle);

        await assertOfferable(session, productId);

        const detailHandle = await inAppSurfaceStore.mint({
            kind: 'pd',
            owner: session.owner,
            customerId: session.customerId,
            channel: session.channel,
            externalId: session.externalId,
            language: session.language,
            productId,
        });

        /**
         * ⚠ **A same-origin path, deliberately, rather than `inAppScreenUrl`'s absolute URL.**
         *
         * That helper is the one reader of `BOT_MINIAPP_BASE_URL` and is right for a URL that
         * has to travel — into a Telegram `web_app` button, where the origin must be the
         * configured public one. This URL does not travel: it is handed to a page that is
         * already open, and `window.location.assign` will follow it inside the same WebView.
         *
         * Building it absolutely would introduce a way for the two to disagree — a deployment
         * whose configured origin is not the host the customer actually reached would navigate
         * them off it mid-session, losing the Telegram WebView context (and with it `close()`,
         * the theme, and the back button). A relative path cannot do that. The path constant
         * is imported rather than written out, so it cannot drift from the helper's.
         */
        const url = `${__IN_APP_SCREEN_PATH}/pd/${detailHandle}?lang=${toBotCopyLanguage(session.language)}`;

        sendSuccess(res, { url });
    });
}

/**
 * Resolve a listing handle, or refuse the way the chat would have.
 *
 * One refusal bucket for unknown, lapsed, malformed **and wrong-kind**, which is the position
 * every other handle on this surface takes: all four have the same remedy — go back to the chat
 * and ask again — and distinguishing them would confirm to a caller that a handle it does not
 * own is real.
 *
 * ⚠ The kind is named here rather than checked afterwards. `read('pl', …)` refuses a `pd` or
 * `co` handle by construction, so a handle pasted onto this path cannot open the wrong screen
 * with the right data.
 */
async function readListing(handle: string): Promise<Extract<InAppSurfaceSession, { kind: 'pl' }>> {
    const session = await inAppSurfaceStore.read('pl', handle);
    if (!session) {
        throw createAppError(
            ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
            404,
            'That product list is no longer held',
        );
    }
    return session;
}

/**
 * May this screen offer that product?
 *
 * ⚠ **The old rail's membership check, and it is NOT as tight here — read this before
 * assuming it is.** `MiniAppController.addToCart` can be exact because its session holds the
 * ten ids it was built from, so "was this offered" is a set lookup. A listing session holds a
 * **query**, by design (see the header), and a query has no membership set to test against
 * without re-running it — which would be a second full catalogue read on every tap, racing the
 * first.
 *
 * So the bound is the strongest one available on each shape:
 *
 *   - **a pinned session** (`productIds`, used by a wishlist or a model-chosen grid) is checked
 *     exactly, against the ids it holds — the old rail's rule, intact;
 *   - **a query session** is checked against *publishability*: the product must be one the
 *     public catalogue would serve. That is the same bound the query itself has, since every
 *     product a query can return is publishable.
 *
 * ⚠ **The residual, stated rather than hidden:** on a query session a tampered `productId` can
 * open a publishable product the query would not have returned. What that reaches is a public
 * product detail — already readable by anyone at `/api/public/products/:id` with no credential
 * — and a later cart write that lands in the **session owner's own basket**, because every
 * write on this surface is addressed by the session and never by the request. It is the old
 * rail's stated worst case and no wider.
 *
 * Closing it exactly would mean recording the ids each page actually served onto the session.
 * That was raised and **declined on the record**: it would grow a session that is deliberately
 * a *query* — unbounded in the paging case the query shape exists to support — to close a hole
 * whose exploit is "see a public product you could already see".
 *
 * ⚠ **THE TRIGGER THAT REOPENS THAT DECISION: if a write from this surface ever stops landing
 * only in the session owner's own basket, this has to be revisited IN THE SAME CHANGE.** The
 * whole trade-off rests on the blast radius being the owner's own cart; widen that and the
 * residual stops being harmless without a line of this file changing.
 */
async function assertOfferable(
    session: Extract<InAppSurfaceSession, { kind: 'pl' }>,
    productId: string,
): Promise<void> {
    const pinned = session.query.productIds;
    if (pinned?.length) {
        if (!pinned.includes(productId)) {
            throw createAppError(
                ERROR_CODES.BOT_PRODUCT_NOT_IN_LIST,
                422,
                'That product is not on this list',
            );
        }
        return;
    }

    const hydrated = await publicCatalogService.listByIdsWithVariant([productId]);
    if (!hydrated.has(productId)) {
        throw createAppError(
            ERROR_CODES.BOT_PRODUCT_NOT_IN_LIST,
            422,
            'That product is not on this list',
        );
    }
}

/** One page of a catalogue query. */
async function queryPage(
    query: InAppListingQuery,
    page: number,
): Promise<{ products: ListingCard[]; hasMore: boolean }> {
    /**
     * Built as a literal rather than parsed through `PublicProductListQuerySchema`, because
     * nothing here is caller-supplied: `q`, `category` and `storeSlug` were validated by the
     * chat door that minted the session, and the paging is this file's own. Re-parsing would
     * only re-check our own constants.
     */
    const listQuery: PublicProductListQuery = {
        q: query.q ?? undefined,
        category: query.category ?? undefined,
        storeSlug: query.storeSlug ?? undefined,
        type: undefined,
        minPrice: undefined,
        maxPrice: undefined,
        inStock: undefined,
        /**
         * `relevance` when there is a search term and `newest` otherwise — the storefront's
         * own default pairing. A relevance sort with nothing to be relevant to is an
         * arbitrary order presented as a ranking.
         */
        sort: query.q ? 'relevance' : 'newest',
        page,
        limit: PAGE_SIZE,
    };

    const { data, meta } = await publicCatalogService.listProducts(listQuery);
    return {
        products: await toCards(data),
        hasMore: page * PAGE_SIZE < meta.total,
    };
}

/**
 * One page of a pinned set of ids — a wishlist, or a grid the model chose.
 *
 * ⚠ **The caller's ORDER is preserved and a missing id is DROPPED rather than an error**, the
 * rule `productDisplayService` already follows: a product can be unpublished or suspended
 * between the set being built and the page being scrolled, and four cards is the right
 * rendering of five ids when one has gone.
 */
async function pinnedPage(
    productIds: string[],
    page: number,
): Promise<{ products: ListingCard[]; hasMore: boolean }> {
    const start = (page - 1) * PAGE_SIZE;
    const window = productIds.slice(start, start + PAGE_SIZE);
    if (window.length === 0) return { products: [], hasMore: false };

    const hydrated = await publicCatalogService.listByIdsWithVariant(window);
    const items = window
        .map((id) => hydrated.get(id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

    return {
        products: items.map((entry) => toCard(entry.item, entry.defaultVariantId)),
        hasMore: start + window.length < productIds.length,
    };
}

/**
 * A page of list rows → the grid's cards.
 *
 * ⚠ **A second read, and it is not redundant.** `listProducts` answers
 * `PublicProductListItemDto`, which deliberately does not carry a variant id — that is a
 * *second* method on the service (`listByIdsWithVariant`) precisely so the public DTO does not
 * grow a field for one consumer. The grid needs it: a card with no sellable variant is drawn
 * and cannot be opened, so without it every card would be either wrongly tappable or wrongly
 * muted.
 *
 * The cost is one extra by-ids read per page. Accepted rather than worked around, because the
 * alternative is a new method on a catalogue service another stream currently holds.
 */
async function toCards(items: PublicProductListItemDto[]): Promise<ListingCard[]> {
    if (items.length === 0) return [];

    const withVariant = await publicCatalogService.listByIdsWithVariant(items.map((i) => i.id));
    return items.map((item) => toCard(item, withVariant.get(item.id)?.defaultVariantId ?? null));
}

interface ListingCard {
    productId: string;
    variantId: string | null;
    title: string;
    priceText: string;
    imageUrl: string | null;
    storeName: string;
    inStock: boolean;
}

/**
 * One catalogue row → one card.
 *
 * ⚠ **`variantId` here means "is there anything sellable", and it is NOT
 * `toBotProductCard`'s `buyable`.** That function nulls the variant on every **service**,
 * because a chat card's buttons would offer "Add to cart" and the cart refuses services
 * outright. This screen has the opposite obligation: a service is *bookable*, the detail
 * screen is where a booking starts, and nulling it here would make every service on the
 * platform untappable in the grid — the same defect that function exists to prevent, arrived
 * at from the other end.
 *
 * The purchase ladder still decides what the button *says*, one screen later and per variant.
 * Nothing here chooses a verb or a label.
 */
function toCard(item: PublicProductListItemDto, defaultVariantId: string | null): ListingCard {
    return {
        productId: item.id,
        variantId: defaultVariantId,
        title: item.title,
        priceText: priceTextOf(item),
        imageUrl: cardImageUrl(item),
        storeName: item.store.name,
        inStock: item.inStock,
    };
}

/**
 * ⚠ **Formatted server-side, and the page does no money maths at all.**
 *
 * The currency, the negotiable **ask** and the discount rules all live in
 * `public-display-price.ts` and are already resolved into this DTO. A second implementation in
 * a WebView would be a second set of rounding bugs, in the one place nothing tests —
 * `test:inapp-catalog` § 1 refuses `toFixed`, `parseFloat` and `Intl.NumberFormat` in a page
 * for exactly that reason.
 *
 * `formatBotPrice` rather than ICU, for the reason `product-card.ts` records: ICU renders XAF
 * with a narrow no-break space whose code point differs between Node builds, and its grouping
 * character would disagree with every other price this platform prints.
 */
function priceTextOf(item: PublicProductListItemDto): string {
    return item.priceRange
        ? formatBotPriceRange(item.priceRange.min, item.priceRange.max, item.currency)
        : formatBotPrice(item.price, item.currency);
}

/**
 * The card's picture, for a **browser** rather than for a platform's fetcher.
 *
 * ⚠ **The reachability rule is the wrong test on this surface, and falling back past it is
 * deliberate.** `toPublicMediaUrl` exists because Telegram and Meta fetch media *server-side*,
 * so a URL on a loopback or carrier-NAT host is a rejected send rather than a slow image. Here
 * the fetcher is the customer's own phone, inside a WebView, and what it can reach is a
 * different question — on a development machine it can reach exactly the private host that
 * rule rejects.
 *
 * So the rewrite is kept (it is what makes the URL correct in production, where the origin the
 * service knows itself by is not the one the world reaches) and the rejection is not: a raw URL
 * that a browser may be able to load beats no picture at all, and the page renders an empty
 * frame either way if it cannot.
 */
function cardImageUrl(item: PublicProductListItemDto): string | null {
    const raw = item.image?.url ?? null;
    return toPublicMediaUrl(raw) ?? raw;
}

/**
 * What the screen calls this shelf — the search term, the category, or nothing.
 *
 * ⚠ **Never a translated string, and never invented.** It is echoed from what the customer
 * asked for, so it is already in their words; the screen's own heading comes from
 * `inAppCopy`. A store-slug session gets no heading rather than a slug rendered as prose —
 * `electro-shop-douala` is a database key, not a shop's name.
 */
function headingFor(query: InAppListingQuery): string | null {
    return query.q?.trim() || query.category?.trim() || null;
}

/** ⚠ Exported for `test:inapp-catalog` § 2, which asserts the grid pages past ten. */
export const __LISTING_PAGE_SIZE = PAGE_SIZE;
