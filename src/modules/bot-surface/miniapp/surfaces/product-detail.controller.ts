import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import {
    PublicProductDetailDto,
    PublicVariantDto,
} from '../../../catalog/dto/public-product.dto';
import { publicCatalogService } from '../../../catalog/services/public-catalog.service';
import { botChrome } from '../../domain/bot-chrome-copy';
import { formatBotPrice, toPublicMediaUrl } from '../../domain/product-card';
import { resolvePurchaseAffordance } from '../../domain/purchase-affordance';
import { inAppSurfaceStore } from '../../services/inapp-surface.store';

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
        const session = await inAppSurfaceStore.read('pd', handle);
        if (!session) {
            throw createAppError(
                ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
                404,
                'That product is no longer held',
            );
        }

        /**
         * ⚠ **A product that has gone since the screen was opened is a 404, not an empty
         * screen.** `getProductById` raises `CATALOG_PRODUCT_NOT_FOUND` for an unpublished,
         * suspended or deleted product, and the page renders that refusal as its failed state
         * with the sentence attached. Swallowing it into a blank detail view would show a
         * customer a product page for something that is not for sale.
         */
        const product = await publicCatalogService.getProductById(session.productId);

        void inAppSurfaceStore.touch('pd', handle).catch(() => undefined);

        /**
         * ⚠ **Computed ONCE and used for both halves, because the page matches them
         * POSITIONALLY.** `pd.html` builds the customer's selection as one value per entry of
         * `options`, in order, and compares it against each variant's `valueIds` index by
         * index. So the two arrays are one data structure in two pieces: derive `valueIds`
         * from the product's full option list while sending a filtered `options`, and every
         * comparison silently misaligns — no variant ever matches, the button never enables,
         * and nothing fails anywhere for somebody to find.
         */
        const picker = selectableOptions(product);

        sendSuccess(res, {
            title: product.title,
            storeName: product.store.name,
            /**
             * ⚠ **City only — a ship-from address stays private.** `business_addresses[]` are
             * the places a vendor ships from: a home or a warehouse, with a street line and
             * exact coordinates. The public detail DTO already publishes nothing but the city
             * for that reason, and this projection must not reach past it.
             */
            storeCity: product.store.city,
            imageUrl: heroImageUrl(product),
            description: product.description || null,
            /**
             * The option id is the join key this file needs and the page does not — it
             * selects by value id and matches positionally — so it is dropped here rather
             * than published. The contract in `pd.html` says `{ name, values }`.
             */
            options: picker.map(({ name, values }) => ({ name, values })),
            variants: product.variants.map((variant) =>
                toVariantRow(variant, picker, product, session.language),
            ),
            defaultVariantId: product.defaultVariantId,
        });
    });
}

/**
 * The picker, with every value no surviving variant can reach removed.
 *
 * ── ⚠ WHY THIS FILTER EXISTS, AND WHAT IT LOOKS LIKE WITHOUT IT ────────────
 * `toPublicProductDetailDto` filters **variants** to the sellable ones — active and not
 * deleted — but builds `options[].values` from *every* option value on the product. The two
 * are not filtered together, and for a storefront that is fine: it can grey a chip out.
 *
 * Here it produces a dead end a customer cannot read. Archive the red T-shirt and "Red" still
 * draws as a chip; tapping it selects an option combination no variant matches, so the page's
 * `currentVariant()` answers null and the button falls back to **"Pick an option first"** — to
 * somebody who has just picked one. They tap it again, get the same sentence, and conclude the
 * screen is broken.
 *
 * So a value is offered only if some sellable variant actually carries it. An option left with
 * no values at all is dropped entirely rather than rendered as an empty row.
 *
 * ⚠ **This does NOT make every remaining combination reachable, and it cannot.** A product
 * genuinely sold in Red-S and Blue-L has four chips and two valid pairings; picking Red then L
 * is a real "that combination is not available", not a defect. The page has no words for that
 * case — `inAppCopy` has no key for it — so it still shows "Pick an option first", which is
 * wrong but rare. Raised with the stream that owns the copy table rather than papered over
 * here, because inventing the sentence locally would put screen copy outside the one table
 * that a boot assertion proves complete in five languages.
 */
function selectableOptions(product: PublicProductDetailDto): PickerOption[] {
    const reachable = new Set(product.variants.flatMap((v) => v.optionValueIds));

    return product.options
        .map((option) => ({
            id: option.id,
            name: option.name,
            values: option.values
                .filter((value) => reachable.has(value.id))
                .map((value) => ({ id: value.id, label: value.value })),
        }))
        .filter((option) => option.values.length > 0);
}

/**
 * One option as the picker will draw it. `id` is the join key used to order a variant's
 * `valueIds`; it is stripped before the response, which identifies options by position.
 */
interface PickerOption {
    id: string;
    name: string;
    values: Array<{ id: string; label: string }>;
}

/**
 * One variant → one row the picker can select and the button can act on.
 *
 * ⚠ **`valueIds` is ordered to match `options`, and the page depends on that exactly.** It
 * compares the customer's chosen value per option, positionally, against this array — so an
 * order that came back in the variant's own sequence rather than the product's would silently
 * match the wrong variant, or none. `PublicVariantDto.options` is pre-joined with its
 * `optionId`, which is what makes the re-ordering possible here rather than in the browser.
 *
 * ⚠ **Keyed on ids, never on `optionSignature`.** Renaming an option value is a documented
 * *safe* operation that deliberately does not rewrite that string, so a lookup built from
 * displayed text stops finding variants that exist.
 */
function toVariantRow(
    variant: PublicVariantDto,
    picker: PickerOption[],
    product: PublicProductDetailDto,
    language: string | null,
): {
    variantId: string;
    valueIds: string[];
    priceText: string;
    inStock: boolean;
    affordance: { verb: string; label: string; enabled: boolean };
} {
    const byOptionId = new Map(variant.options.map((o) => [o.optionId, o.valueId]));

    /**
     * ⚠ **Resolved per VARIANT, not per product, and that is the whole reason the detail screen
     * exists.** A product may sell one variant at a fixed price and another with a bargaining
     * window open, so the list row's answer — which reports its *default* variant — cannot be
     * applied across the picker. `PublicVariantDto.negotiable` is the per-variant predicate,
     * published for exactly this.
     */
    const affordance = resolvePurchaseAffordance({
        type: product.type,
        negotiable: variant.negotiable,
        inStock: variant.inStock,
        variantId: variant.id,
    });

    return {
        variantId: variant.id,
        /**
         * ⚠ Ordered by the **picker** the page was actually sent, never by the product's full
         * option list — see the note where `picker` is computed. The two disagree whenever an
         * option was dropped for having no reachable values, and a positional comparison
         * against the wrong array matches nothing while failing nowhere.
         */
        valueIds: picker.map((option) => byOptionId.get(option.id) ?? ''),
        priceText: priceTextOf(variant),
        inStock: variant.inStock,
        /**
         * ⚠ **Verbatim, and translated here rather than in the page.** `labelKey` is resolved
         * through `botChrome()` against the session's language — the same call the chat card
         * makes — so the word on the button is the same word in both places. The page is told,
         * never asked.
         *
         * `verb` travels for the page's own use (it is what tells a renderer that this is a
         * conversation rather than a basket), and is **never** sent back on the write: the
         * page posts a variant id and the server re-resolves the rung.
         */
        affordance: {
            verb: affordance.verb,
            label: botChrome(affordance.labelKey, language),
            enabled: affordance.enabled,
        },
    };
}

/**
 * A variant's price, formatted server-side.
 *
 * ⚠ **A SERVICE variant's `price` is a UNIT RATE, not a total**, and printing it as "the
 * price" misquotes the customer. The DTO ships two derived fields beside it for exactly this —
 * `priceFrom` (the least a booking of the minimum duration can cost) and `priceUnit` (a label
 * such as "per 60 min") — and the documented rendering is "from {priceFrom} · {priceUnit}".
 * Rendering `price` alone here would quote a 60-minute rate to somebody booking 90 minutes.
 *
 * ⚠ **The page does no money maths at all** — `test:inapp-catalog` § 1 refuses `toFixed`,
 * `parseFloat` and `Intl.NumberFormat` in a page. Everything above happens on this side.
 */
function priceTextOf(variant: PublicVariantDto): string {
    if (variant.service) {
        return `${formatBotPrice(variant.service.priceFrom, variant.currency)} · ${variant.service.priceUnit}`;
    }
    return formatBotPrice(variant.price, variant.currency);
}

/**
 * The hero picture, for a **browser** rather than for a platform's fetcher.
 *
 * ⚠ **The reachability rule is the wrong test on this surface, and falling back past it is
 * deliberate** — the same reasoning the listing records. `toPublicMediaUrl` exists because
 * Telegram and Meta fetch media server-side, so a private-host URL is a rejected *send*. Here
 * the fetcher is the customer's own phone inside a WebView, which on a development machine can
 * reach exactly the host that rule rejects. The origin rewrite is kept, because it is what
 * makes the URL correct in production; the rejection is not.
 *
 * ⚠ **No placeholder, unlike a chat card.** A card with a hole in it reads as a broken bot, so
 * `toBotProductCard` substitutes a stand-in. A screen has layout: `pd.html` renders an empty
 * hero frame, which reads as a product with no photograph — which is what it is.
 */
function heroImageUrl(product: PublicProductDetailDto): string | null {
    const raw = product.images[0]?.url ?? null;
    return toPublicMediaUrl(raw) ?? raw;
}
