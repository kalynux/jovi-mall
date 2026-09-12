import path from 'path';
import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CartService } from '../../cart/services/cart.service';
import { productDisplayService } from '../services/product-display.service';
import { ProductDisplaySet, productDisplayStore } from '../services/product-display.store';
import { miniAppCopy, miniAppDirection } from './miniapp-copy';

const cartService = new CartService();

/**
 * The Telegram Mini App — a page, its data, and one write.
 *
 * ── WHY THIS IS NOT ON `/api/internal/bot/*`, AND MUST NOT BE ───────────────
 * Every route on that surface presents **two** credentials, `INTERNAL_SERVICE_TOKEN` and
 * `BOT_WEBHOOK_SECRET`, held by the automation layer and by nothing else. A browser cannot
 * hold either: putting one in a page served to a customer's phone would hand every viewer
 * the whole bot surface — every customer's cart, orders and addresses — which is the exact
 * thing the two-credential split exists to prevent.
 *
 * So this is a separate mount with a separate posture: **the handle in the URL is the only
 * credential, and it authorises exactly one conversation's list for thirty minutes.** That is
 * the position `pay-link.ts` already established for an unauthenticated payment page, and the
 * reasoning transfers intact — an opaque, short-lived, single-purpose handle is a smaller
 * disclosure than a session, and it is revocable by expiry rather than by a store nobody
 * maintains.
 *
 * ── WHAT THE HANDLE CANNOT DO, WHICH IS THE POINT ───────────────────────────
 * It names a **set that already knows its own customer**. There is no customer id, user id or
 * address in any request here, so nothing a caller sends can widen what the page reaches: the
 * worst a stolen handle achieves is adding items to a basket that is not the thief's, and
 * reading five product cards that were about to be sent into a chat anyway.
 */
export class MiniAppController {
    /**
     * `GET /api/bot/miniapp/p/:handle` — the page.
     *
     * ⚠ **Served as a STATIC FILE with nothing templated into it.** Interpolating the handle,
     * the customer's name or the product titles into the HTML would make this a rendered
     * document, and a rendered document is one escaping mistake away from putting a vendor's
     * product title into a script context. The page reads its own handle out of the URL and
     * fetches everything else as JSON.
     *
     * ⚠ **It does NOT check the handle.** An unknown or lapsed one still gets the page, which
     * then shows the "no longer available" state from its own API call. Refusing here would
     * mean a 404 in a WebView — an unstyled browser error page inside Telegram, with no
     * sentence the customer can act on and no language they necessarily read.
     */
    static page = asyncHandler(async (_req: Request, res: Response) => {
        /**
         * ⚠ **A route-scoped CSP that OVERRIDES helmet's**, and without it the page is blank.
         *
         * `app.use(helmet())` sets `default-src 'self'` with no `unsafe-inline`, which was a
         * deliberate tightening when the old `/test-auth` page was deleted. This page has an
         * inline `<style>`, an inline `<script>` and one external script — Telegram's own
         * `telegram-web-app.js`, which is the only way a Mini App learns its theme and can
         * close itself. Under the default policy all three are refused and the customer sees
         * an empty white screen with no error anywhere on this side.
         *
         * It is written as the narrowest thing that works rather than as a relaxation:
         * `default-src 'none'`, no `form-action`, no `base-uri`, and `connect-src 'self'` so
         * the page can only ever talk back to this API. `img-src` is broad because a product
         * photograph may legitimately come from object storage or a CDN on any origin, and
         * the page holds nothing an image could exfiltrate.
         */
        res.setHeader(
            'Content-Security-Policy',
            [
                "default-src 'none'",
                "script-src 'self' 'unsafe-inline' https://telegram.org",
                "style-src 'unsafe-inline'",
                'img-src https: http: data:',
                "connect-src 'self'",
                "base-uri 'none'",
                "form-action 'none'",
                // Telegram Desktop and Web embed a Mini App in a frame on their own origin.
                "frame-ancestors https://web.telegram.org https://*.telegram.org",
            ].join('; '),
        );
        /**
         * ⚠ helmet stamps `X-Frame-Options: DENY` and `Cross-Origin-Resource-Policy:
         * same-origin` globally. The first is honoured by browsers that ignore
         * `frame-ancestors` and would blank the page in Telegram Web; the second blocks the
         * embed outright. Both are removed for this one document, exactly as the public
         * storage mount relaxes CORP for the same class of reason.
         */
        res.removeHeader('X-Frame-Options');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        // The document is identical for every handle, but the URL is not — keep it out of
        // shared caches so a proxy cannot serve one customer's URL to another's request log.
        res.setHeader('Cache-Control', 'no-store');
        res.type('html');

        /**
         * ⚠ `__dirname`-relative, which is why `modules/bot-surface/miniapp/public` is on the
         * build-assets manifest. `tsc` emits `.js` and imported `.json` and NOTHING else, so
         * an HTML file under `src/` reaches `dist/` only because `copy-build-assets.ts` puts
         * it there — the exact split that left every Handlebars email template missing from
         * every container image.
         */
        res.sendFile(path.join(__dirname, 'public', 'page.html'));
    });

    /** `GET /api/bot/miniapp/api/:handle` — the cards, the copy and the direction. */
    static data = asyncHandler(async (req: Request, res: Response) => {
        const set = await resolveSet(req);
        const cards = await productDisplayService.cardsForSet(set);

        sendSuccess(res, {
            language: set.language ?? 'en',
            direction: miniAppDirection(set.language),
            copy: miniAppCopy(set.language),
            /**
             * ⚠ **An explicit projection, not the card object.** `BotProductCard` carries
             * `addToken` and `buyToken` — callback tokens meant for a messaging platform —
             * and a browser has no use for either. Spreading the card would publish them to
             * anyone who opens the page, which is the accumulation the public catalogue DTOs
             * exist to prevent, arriving through a new door.
             */
            products: cards.map((card) => ({
                productId: card.productId,
                variantId: card.variantId,
                title: card.title,
                priceText: card.priceText,
                storeName: card.storeName,
                inStock: card.inStock,
                imageUrl: card.imageUrl,
                detailUrl: card.detailUrl,
            })),
        });
    });

    /**
     * `POST /api/bot/miniapp/api/:handle/cart` — add what the customer picked.
     *
     * ⚠ **Every chosen variant must belong to THIS set.** Without that check the handle stops
     * being a key to one list and becomes a bearer credential for the customer's whole
     * basket: a caller could post any variant id in the catalogue. The set is the authority
     * on what the page was allowed to offer, so it is also the authority on what may be
     * added.
     */
    static addToCart = asyncHandler(async (req: Request, res: Response) => {
        const set = await resolveSet(req);
        const { items } = MiniAppCartSchema.parse(req.body ?? {});

        const allowed = new Set(set.productIds);
        const chosen = items.filter((item) => allowed.has(item.productId));
        if (chosen.length === 0) {
            throw createAppError(
                ERROR_CODES.BOT_PRODUCT_NOT_IN_LIST,
                422,
                'None of those products belong to this list',
            );
        }

        /**
         * ⚠ **Sequential, not `Promise.all`.** Every one of these writes the same cart
         * document, and `CartService.addToCart` is a read-modify-write — firing five at once
         * is five racing updates on one row, of which some quietly lose. A customer picking
         * five things is waiting on one page load either way.
         *
         * A failure part-way through leaves the earlier lines added, and that is the right
         * outcome: rolling them back would need a transaction across a service that does not
         * take one, and a customer who sees "3 of 5 added" can act, while one whose basket
         * silently emptied cannot.
         */
        const added: string[] = [];
        for (const item of chosen) {
            await cartService.addToCart(set.customerId, item.productId, item.variantId, 1);
            added.push(item.variantId);
        }

        sendSuccess(res, { added: added.length });
    });
}

/**
 * Resolve the handle, or refuse with the sentence the chat would have used.
 *
 * One bucket for unknown, lapsed and malformed — the position every other handle on this
 * surface takes, and here it also means a stolen handle that has expired is indistinguishable
 * from one that never existed.
 */
async function resolveSet(req: Request): Promise<ProductDisplaySet> {
    const { handle } = MiniAppHandleSchema.parse(req.params);
    const set = await productDisplayStore.readByMiniAppHandle(handle);
    if (!set) {
        throw createAppError(
            ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
            404,
            'That product list is no longer held',
        );
    }
    return set;
}

const MiniAppHandleSchema = z.object({
    handle: z.string().trim().min(3).max(64),
});

const MiniAppCartSchema = z
    .object({
        items: z
            .array(
                z
                    .object({
                        productId: z.string().regex(/^[0-9a-fA-F]{24}$/),
                        variantId: z.string().regex(/^[0-9a-fA-F]{24}$/),
                    })
                    .strict(),
            )
            .min(1)
            // The rail holds at most ten. A larger body is a caller that is not the page.
            .max(10),
    })
    .strict();
