import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { publicCatalogService } from '../../../catalog/services/public-catalog.service';
import { toBotCopyLanguage } from '../../domain/bot-error-copy';
import { __IN_APP_SCREEN_PATH } from '../../domain/inapp-url';
import { InAppSurfaceSession, inAppSurfaceStore } from '../../services/inapp-surface.store';
import { browserImageUrl } from './browser-image-url';
import { DEFAULT_LISTING_PAGE_SIZE, ListingProduct, readListingPage } from './product-listing.read';

/**
 * `inAppProductListing` — the browse grid's two endpoints.
 *
 * ── WHAT THIS FILE IS, AND WHERE ITS SPECIFICATION LIVES ────────────────────
 * The response shapes below are written out as a contract in the opening comment of
 * `public/pl.html`, which is the page that consumes them. That comment is the specification
 * and this file implements it; if the two ever disagree, the page is right, because the page
 * is what a customer sees.
 *
 * ── ⚠ THE READ IS NOT HERE — IT IS IN `product-listing.read.ts` ─────────────
 * Which products, in what order, at what formatted price, and what the shelf is called are
 * decided ONCE, in `readListingPage`, because a WhatsApp Flow draws the same listing and must
 * not hold a second copy of those rules. This file is the Telegram Mini App's RENDERING of that
 * read: it resolves the handle, turns `hasMore` into a cursor, applies the **browser's** image
 * rule, and keeps the session alive while somebody scrolls. None of that belongs to a Flow.
 *
 * ── ⚠ IT PAGES THE QUERY, NOT A HELD LIST OF IDS ────────────────────────────
 * The deliberate opposite of `ProductDisplaySet`, and `inapp-surface.store.ts` argues both
 * sides at length. That store holds the ten ids the *model* chose, so page two cannot re-run a
 * search and quietly return different products at different prices. A listing is a grid a
 * customer scrolls, and it **must page past ten**. Inheriting `BOT_DISPLAY_MAX_PRODUCTS` would
 * make it look broken at row eleven — the single most likely way this screen gets quietly
 * ruined later. Both doctrines are right for their own surface. Do not unify them.
 *
 * ── THE MOUNT IS THE SECURITY DECISION, AND IT IS INHERITED ─────────────────
 * `/api/bot/miniapp/**` carries neither `INTERNAL_SERVICE_TOKEN` nor `BOT_WEBHOOK_SECRET` — a
 * browser can hold neither without handing every viewer the whole bot surface. The opaque
 * handle in the URL is the only credential; it names one conversation, it is kind-checked on
 * read, and it dies in thirty minutes. Nothing here reads an identity out of the request, and
 * nothing may start: the session already knows whose it is.
 */

/**
 * The most pages a customer may walk forward through.
 *
 * Not a product decision — a bound on a public, unauthenticated read whose cursor is
 * caller-supplied. Two hundred pages of `DEFAULT_LISTING_PAGE_SIZE` is 4 800 rows, past which
 * nobody is browsing and somebody is enumerating the catalogue one deep `$skip` at a time.
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
     * holds the *question*, and `readListingPage` answers it each time.
     */
    static data = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);
        const { cursor } = CursorSchema.parse(req.query);
        const session = await readListing(handle);

        const page = cursor ?? 1;
        const listing = await readListingPage(session.query, {
            page,
            pageSize: DEFAULT_LISTING_PAGE_SIZE,
        });

        /**
         * ⚠ **Extended on a READ, which is the one place a customer's attention is visible.**
         * Somebody scrolling a grid is using the screen; letting it lapse under them because
         * the clock started when the chat button was tapped is a lapse they did nothing to
         * earn. `touch` moves the Redis TTL and the recorded expiry together, and it refuses
         * `co` outright — a checkout credential must never slide this way.
         *
         * ⚠ **Here, and deliberately NOT in `readListingPage`.** A Flow calling the same read
         * must not extend an in-app session as a side effect of fetching data.
         *
         * Not awaited for its result: a failed extension costs a customer a re-tap much later,
         * and failing this read over it would cost them the page they are looking at now.
         */
        void inAppSurfaceStore.touch('pl', handle).catch(() => undefined);

        sendSuccess(res, {
            heading: listing.heading,
            products: listing.products.map(toGridCard),
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
            cursor: listing.hasMore && page < MAX_PAGE ? String(page + 1) : null,
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
 * One listing product → one card, as `pl.html`'s contract names it.
 *
 * The only thing added to the shared read is the picture's URL under the **browser's** rule —
 * see `browserImageUrl`. Every other field is passed through untouched, so nothing about which
 * product, its price or whether it is sellable can differ from what a Flow is told.
 */
function toGridCard(product: ListingProduct): {
    productId: string;
    variantId: string | null;
    title: string;
    priceText: string;
    imageUrl: string | null;
    storeName: string;
    inStock: boolean;
} {
    return {
        productId: product.productId,
        variantId: product.variantId,
        title: product.title,
        priceText: product.priceText,
        imageUrl: browserImageUrl(product.imageSourceUrl),
        storeName: product.storeName,
        inStock: product.inStock,
    };
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
