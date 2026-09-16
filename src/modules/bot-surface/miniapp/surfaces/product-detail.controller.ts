import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { toBotCopyLanguage } from '../../domain/bot-error-copy';
import { __IN_APP_SCREEN_PATH } from '../../domain/inapp-url';
import { InAppSurfaceSession, inAppSurfaceStore } from '../../services/inapp-surface.store';
import { browserImageUrl } from './browser-image-url';
import { readProductDetail } from './product-detail.read';
import { readSimilarProductIds } from './similar-products.read';

/**
 * `inAppProductDetail` — the screen's read side.
 *
 * ── ⚠ THIS IS ONE HALF OF A SEAM, AND THE OTHER HALF IS ANOTHER STREAM'S ────
 * The detail screen has two endpoints and they belong to different sessions:
 *
 *   `GET  /s/pd/:handle/data`  — this file. The projection: product, options, variants, and
 *                                the purchase affordance **per variant**.
 *   `POST /s/pd/:handle/act`   — NOT this file. The write path owns it, because the four rungs
 *                                end in a cart, a checkout or a message posted into the chat.
 *
 * The rule that lets both finish independently: **the button is rendered here and decided by
 * `resolvePurchaseAffordance()`, which is the same function the chat card calls.** This file
 * returns its result verbatim, already translated; the page hardcodes no label and no logic;
 * and the write path **re-resolves it** from the session's product and the posted variant
 * rather than trusting anything the page sends. So the two sides are not coupled at runtime —
 * they simply agree, because one function answers for both.
 *
 * ⚠ **Which is why nothing here may narrow the affordance.** Dropping a disabled one, or
 * substituting a label, would put a second opinion about the ladder on this surface and the
 * customer would see one word on the chat card and another on the screen for one product.
 * `test:inapp-catalog` § 1 scans the page for the four English rung words with comments
 * stripped, for exactly that reason.
 *
 * ── ⚠ THE READ IS NOT HERE — IT IS IN `product-detail.read.ts` ──────────────
 * The picker, the per-variant affordance, the service price and the city-only store line are
 * decided ONCE, in `readProductDetail`, because a WhatsApp Flow draws the same product and must
 * not hold a second opinion about any of them. This file is the Telegram Mini App's RENDERING of
 * that read: it resolves the handle, keeps the session alive, applies the **browser's** image
 * rule, and projects exactly the fields `pd.html` names — nothing else.
 *
 * ── THE SPECIFICATION IS THE PAGE ───────────────────────────────────────────
 * The response shape is written out as a contract in the opening comment of `public/pd.html`.
 * If this file and that comment disagree, the page is right — it is what a customer sees.
 */

const HandleSchema = z.object({ handle: z.string().trim().min(3).max(64) });

export class ProductDetailController {
    /**
     * `GET /api/bot/miniapp/s/pd/:handle/data` — the product, its picker, and the button.
     *
     * ⚠ **Read live on every open and every retry, never cached onto the session.** The
     * session holds a product **id** and nothing else — no title, no price, no stock — so a
     * screen reopened twenty minutes later quotes what the product costs now. A held price is
     * a price a customer can hold us to.
     */
    static data = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);

        /**
         * ⚠ The kind is named on the read, so a `pl` or `co` handle pasted onto this path
         * refuses rather than opening this screen with another screen's session. One refusal
         * bucket for unknown, lapsed, malformed and wrong-kind: all four have the same remedy,
         * and separating them would confirm that a handle the caller does not own is real.
         */
        const session = await readDetailSession(handle);

        /**
         * ⚠ **A product that has gone since the screen was opened is a 404, not an empty
         * screen.** `readProductDetail` lets `CATALOG_PRODUCT_NOT_FOUND` through for an
         * unpublished, suspended or deleted product, and the page renders that refusal as its
         * failed state with the sentence attached.
         *
         * ⚠ **The similar-items check runs beside it and can NEVER fail this read.** It decides
         * only whether a Similar-items button is drawn. A ranking that cannot be computed — a
         * cache or database wobble in a different module — must cost the customer that one
         * optional button, not the product page they opened. So its failure is swallowed to
         * `false` here, where a missing button is the right outcome; the tap endpoint below
         * makes the opposite call, because there the customer explicitly asked.
         */
        const [detail, hasSimilar] = await Promise.all([
            readProductDetail(session.productId, session.language),
            readSimilarProductIds(session.productId)
                .then((ids) => ids.length > 0)
                .catch(() => false),
        ]);

        /**
         * ⚠ **Extended here, and deliberately NOT in `readProductDetail`** — a Flow calling the
         * same read must never extend an in-app session as a side effect of fetching data.
         */
        void inAppSurfaceStore.touch('pd', handle).catch(() => undefined);

        /**
         * ⚠ **Exactly the fields `pd.html`'s contract names, and no more.** The read also carries
         * `productId`, a per-variant `label` and the picture as a stored file (`image`); those
         * exist for a Flow that lists variants flat and needs image bytes. The page uses none of
         * them, and a projection that grows by spreading is how a field meant for one renderer
         * ends up published to every browser.
         */
        sendSuccess(res, {
            title: detail.title,
            storeName: detail.storeName,
            storeCity: detail.storeCity,
            imageUrl: browserImageUrl(detail.imageSourceUrl),
            description: detail.description,
            options: detail.options,
            variants: detail.variants.map((variant) => ({
                variantId: variant.variantId,
                valueIds: variant.valueIds,
                priceText: variant.priceText,
                inStock: variant.inStock,
                affordance: variant.affordance,
            })),
            defaultVariantId: detail.defaultVariantId,
            /** Draw the Similar-items button? False when there is nothing to show, or no way to ask. */
            hasSimilar,
        });
    });

    /**
     * `POST /api/bot/miniapp/s/pd/:handle/similar` — open a grid of products similar to this one.
     *
     * ⚠ **A POST that mints a session, for the reason `/s/pl/:handle/open` gives.** The listing
     * screen needs its own `pl` handle and only the server can mint one, so the page asks and is
     * handed back a URL. Nothing here touches a cart, a price or an order.
     *
     * ⚠ **The shelf is PINNED, not re-queried.** The similar products are resolved now and their
     * ids stored in the listing session, so the grid shows exactly the shelf the button promised.
     * A listing that re-ran "similar" on every page could reshuffle under the customer as a
     * ranking cache expired. Each product is still re-read live per page, so prices are current.
     *
     * ⚠ **Every failure here IS surfaced, unlike on the data read.** There, a failed similar-items
     * check just means no button. Here the customer pressed it, and a silent nothing would read as
     * a broken button. An empty shelf is not a failure: `url: null`, and the page says so — but
     * the page only draws the button when `hasSimilar` was true, so that answer is a race rather
     * than the ordinary case.
     */
    static similar = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);
        const session = await readDetailSession(handle);

        const productIds = await readSimilarProductIds(session.productId);
        if (productIds.length === 0) {
            sendSuccess(res, { url: null });
            return;
        }

        /**
         * The listing session inherits everything that makes it this customer's — owner, customer,
         * conversation, language — from the detail session that asked. Nothing is read from the
         * request, so nothing a caller sends can address the listing at somebody else.
         */
        const listingHandle = await inAppSurfaceStore.mint({
            kind: 'pl',
            owner: session.owner,
            customerId: session.customerId,
            channel: session.channel,
            externalId: session.externalId,
            language: session.language,
            query: { q: null, category: null, storeSlug: null, productIds },
        });

        /**
         * ⚠ A same-origin path, for the reason `/s/pl/:handle/open` records: the page is already
         * open inside the Telegram WebView, and an absolute URL built from configuration could
         * navigate the customer to a different host and lose the WebView's context.
         */
        sendSuccess(res, {
            url: `${__IN_APP_SCREEN_PATH}/pl/${listingHandle}?lang=${toBotCopyLanguage(session.language)}`,
        });
    });
}

/**
 * Resolve a detail handle, or refuse the way the chat would have.
 *
 * ⚠ The kind is named on the read, so a `pl` or `co` handle pasted onto this path refuses rather
 * than opening this screen with another screen's session. One refusal bucket for unknown, lapsed,
 * malformed and wrong-kind: all four have the same remedy, and separating them would confirm that
 * a handle the caller does not own is real.
 */
async function readDetailSession(handle: string): Promise<Extract<InAppSurfaceSession, { kind: 'pd' }>> {
    const session = await inAppSurfaceStore.read('pd', handle);
    if (!session) {
        throw createAppError(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, 404, 'That product is no longer held');
    }
    return session;
}
