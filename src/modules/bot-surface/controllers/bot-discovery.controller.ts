import { Request, Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { publicCatalogService } from '../../catalog/services/public-catalog.service';
import { wishlistService } from '../../customers/services/wishlist.service';
import { recentlyViewedService } from '../../customers/services/recently-viewed.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { BotReplyOption } from '../domain/channel-reply';
import { categoryActionId, categoryDigest, openSurfaceActionId } from '../domain/bot-action-id';
import { BotActionHandlers, ParsedBotAction, unknownBotAction } from '../domain/bot-action-dispatch';
import { openInAppScreen } from './bot-inapp.controller';
import { readSimilarProductIds } from '../miniapp/surfaces/similar-products.read';
import { readProductReviewSummary } from '../miniapp/surfaces/product-reviews.read';
import { productDisplayService } from '../services/product-display.service';

/**
 * DISCOVERY — the turns where a customer is still looking rather than buying.
 *
 * Four things reach a customer from here, and all four are things the model used to READ ALOUD:
 * the shop's categories, what is similar to a product, what other customers said about it, and
 * saving something for later. Reading a catalogue aloud is the failure `product_list` was written
 * to end (`channel-reply.ts`), and the same argument covers a category list and a rating.
 *
 * ── ⚠ TWO DOORS, AND ONLY ONE OF THEM WORKS TODAY ───────────────────────────
 * The two routes here are MCP tools: the model calls them and the `reply` they set travels back
 * through the automation layer. ⛔ **A `reply` returned by an MCP tool does not reach the customer
 * today** — `compose agent reply` in the live `wi-mall-core` sends the model's own text and the
 * product-cards echo, and nothing else (the deploy-day n8n change set covers it). The TAPS below
 * are different: a button press is relayed to the dispatcher and its reply IS sent, so everything
 * reachable by tapping works the moment the verb is routed.
 *
 * That asymmetry is deliberate in the design rather than worked around: every model-called door
 * here degrades to exactly what a customer gets now — the model narrating — and never to silence
 * or to a dead button.
 *
 * ── VALIDATORS ARE LOCAL ────────────────────────────────────────────────────
 * `bot.validators.ts` belongs to the switchboard, and two of these schemas are one line each. They
 * live here so this controller is a contract request for a route row and nothing else.
 */

/**
 * ⚠ **A length bound, not an id pattern**, and it is inherited rather than invented: the whole
 * surface answers a malformed id with the same 404 as an unknown one, so a caller cannot learn that
 * its id was well-formed. The shape check happens below, against the same code.
 */
const BotProductParamSchema = z.object({ productId: z.string().trim().min(1).max(64) });

/** How many categories a chat may offer before "See all" is the better answer. */
const CATEGORY_CHOICES = 5;

/**
 * WhatsApp's list-row title cap — the number this whole disambiguation exists because of.
 *
 * ⚠ Repeated here rather than imported from the renderer for the reason `bot-action-id.ts` repeats
 * Telegram's callback cap: this file decides what a row SAYS, and the renderer decides how a
 * channel draws it. `test:inapp-discovery` asserts the two numbers agree, which is what stops the
 * duplication becoming a divergence.
 */
const WA_ROW_TITLE_CAP = 24;

export class BotDiscoveryController {
    /**
     * `POST /catalog/categories` — the shop's categories, as buttons.
     *
     * ⚠ **The busiest five plus "See all", never the whole list.** WhatsApp caps a list at ten rows
     * and a chat answer at five choices; a picker over five of forty categories is a sample, not a
     * directory, which is exactly why the sixth option opens the full grid instead.
     *
     * ⚠ **It mints nothing.** The tap does: `cat:<digest>` opens a listing session for whichever
     * category was pressed, so a category list sitting in a chat history for a week cannot hold a
     * stale handle.
     */
    static browseCategories = asyncHandler(async (req: Request, res: Response) => {
        botCallerOf(req);
        const language = botResponseLanguageOf(req);

        const categories = await publicCatalogService.listCategories();

        /**
         * ⚠ **`listCategories` is derived over the browse filter**, so a category whose every
         * product is a draft is already absent — a chip that leads to an empty grid is worse than
         * no chip. Nothing here re-filters; the catalogue has answered that question.
         */
        if (categories.length === 0) {
            setBotReply(req, { kind: 'text', text: botChrome('noCategoriesPrompt', language) });
            sendSuccess(res, { shown: 0, total: 0 });
            return;
        }

        const shown = categories.slice(0, CATEGORY_CHOICES);
        const names = shown.map((category) => category.name);
        const options: BotReplyOption[] = shown.map((category) => ({
            id: categoryActionId(category.name),
            /** Telegram draws the whole name. */
            label: category.name,
            /**
             * ⛔ **A WhatsApp list row title is cut at 24 characters and a category name is FREE
             * TEXT up to 200**, so two categories sharing a long opening render as one row twice:
             * "Électroménager et petit…" and "Électroménager et gros …". The customer picks at
             * random. In English the same two names fit, which is why every check any of us ran
             * passed.
             */
            shortLabel: distinguishingPart(category.name, names),
            /** The full name, where a WhatsApp row has 72 characters for it. */
            description: category.name,
        }));

        /**
         * The way out of a five-item picker, and it is the SAME button the rest of the surface uses
         * for "the whole shelf" — `open:pl` with no reference, minted on the tap.
         */
        options.push({
            id: openSurfaceActionId('pl'),
            label: botChrome('browseAllButton', language),
        });

        setBotReply(req, {
            kind: 'choice',
            text: botChrome('browseCategoriesPrompt', language),
            options,
            listButton: botChrome('chooseListButton', language),
            sectionTitle: botChrome('chooseSectionTitle', language),
        });

        sendSuccess(res, { shown: shown.length, total: categories.length });
    });

    /**
     * `POST /catalog/products/:productId/reviews` — the star average, the count, and two quotes.
     *
     * ⚠ **The model must not restate the rating in its own words**, which the tool catalogue says
     * in as many words: the numbers are in the reply, and a model paraphrasing "4.3 from 27" is a
     * model rounding somebody's reputation.
     */
    static reviewsSummary = asyncHandler(async (req: Request, res: Response) => {
        botCallerOf(req);
        const language = botResponseLanguageOf(req);
        const { productId } = BotProductParamSchema.parse(req.params);

        const summary = await readProductReviewSummary(assertProductId(productId));

        if (!summary.rating || summary.rating.count === 0) {
            setBotReply(req, { kind: 'text', text: botChrome('noReviewsYetPrompt', language) });
            sendSuccess(res, { average: null, count: 0, quotes: 0 });
            return;
        }

        setBotReply(req, {
            kind: 'text',
            text: reviewSummaryText(summary),
            /**
             * One action, and it opens the product where the reviews actually are. `open:pd` mints
             * the detail session on the tap — a handle baked into a chat message would be dead
             * long before most customers pressed it.
             */
            actions: [
                {
                    id: openSurfaceActionId('pd', productId),
                    label: botChrome('readAllReviewsButton', language),
                },
            ],
        });

        sendSuccess(res, {
            average: summary.rating.average,
            count: summary.rating.count,
            quotes: summary.quotes.length,
        });
    });
}

/**
 * `★ 4.3 (27)`, the product's name, and the quotes — composed HERE rather than by the model.
 *
 * ⚠ **The stars are drawn, not described.** A rendered rating is read at a glance in every language
 * this surface speaks, and it is the one part of a review summary that must never be paraphrased.
 * The number stays beside them because ★★★★☆ alone cannot tell 4.3 from 3.6.
 */
function reviewSummaryText(summary: Awaited<ReturnType<typeof readProductReviewSummary>>): string {
    const rating = summary.rating!;

    /**
     * ⚠ **The stars and the number arrive RENDERED** (`ratingDisplay`), for the reason the screens
     * are forbidden to do money arithmetic: three surfaces draw this rating, and three roundings of
     * 4.25 is how one product reads 4.3 in a chat and 4.2 on a screen.
     */
    const lines = [`${summary.title}`, `${rating.stars} ${rating.averageText} (${rating.count})`];
    for (const quote of summary.quotes) {
        lines.push('', `“${quote.body}”`);
    }
    return lines.join('\n');
}

/**
 * The part of `name` that tells it apart from the others it is shown beside.
 *
 * ── WHY A COMMON PREFIX IS DROPPED RATHER THAN THE NAME TRUNCATED ───────────
 * A row title is cut at 24 characters on WhatsApp, and category names are free text: the ones a
 * shop actually writes share their opening far more often than their ending —
 * *"Électroménager et petit matériel"* beside *"Électroménager et gros matériel"*. Cutting the
 * front off both leaves two identical rows; cutting the shared opening leaves "petit matériel" and
 * "gros matériel", which is the whole distinction in the first few characters.
 *
 * ⚠ **Word-aligned, or it produces worse nonsense than it fixes** — a prefix cut mid-word turns
 * "électroménager" into "ménager" and reads as a different category.
 *
 * ⚠ **Only when it actually helps.** With a single category, with names that share no opening word,
 * or when the remainder would be too short to mean anything, the full name is returned and the
 * renderer truncates as before: a shortened label that says less than the truncation it replaced is
 * not an improvement. The full name is in the row's description either way.
 */
export function distinguishingPart(name: string, siblings: readonly string[]): string {
    /**
     * ⛔ **Scoped to the siblings this name would ACTUALLY COLLIDE with at the cap, and the first
     * version of this was wrong in a way that only showed up in a real shop.** It asked whether
     * EVERY other name shared the opening, so a single unrelated category vetoed the trimming for
     * the pair that actually collided:
     *
     *     Produits de beauté et soins du visage  →  "Produits de beauté et s…"
     *     Produits de beauté et soins du corps   →  "Produits de beauté et s…"   ⛔ still identical
     *     Chaussures                             →  "Chaussures"
     *
     * It passed every two-row test and failed wherever a shop has twenty categories and two of them
     * are similar — which is everywhere. Found by rendering it rather than reading it (backend-d5).
     *
     * ⚠ Compared by CODE POINT, not by `slice`, because these names are the ones with accents and
     * Arabic in them, and the whole defect is about what survives the cut.
     */
    const cut = (value: string): string => [...value].slice(0, WA_ROW_TITLE_CAP).join('');
    const others = siblings.filter((sibling) => sibling !== name && cut(sibling) === cut(name));

    /**
     * Nothing collides, so nothing needs trimming. A pair that differs inside the first
     * twenty-four characters is already two distinct rows, and shortening it further would only be
     * cosmetic — at the cost of a rule that is harder to predict from the outside.
     */
    if (others.length === 0) return name;

    const words = name.split(/\s+/);
    let shared = 0;

    while (shared < words.length - 1) {
        const candidate = words.slice(0, shared + 1).join(' ');
        const everyoneStartsWithIt = others.every(
            (sibling) => sibling === candidate || sibling.startsWith(`${candidate} `),
        );
        if (!everyoneStartsWithIt) break;
        shared += 1;
    }

    if (shared === 0) return name;

    const remainder = words.slice(shared).join(' ').trim();
    /** Three characters is the floor: below it the row says less than a truncated name would. */
    return remainder.length >= 3 ? remainder : name;
}

/** The shape check, answered as NOT FOUND so a caller cannot learn its id was well-formed. */
function assertProductId(productId: string): string {
    if (!Types.ObjectId.isValid(productId)) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
    }
    return productId;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The taps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `cat:<digest>` — a category the customer pressed.
 *
 * ⚠ **The digest is resolved by RECOMPUTING it over the live category list**, because this platform
 * has no category ids: `Product.category` is free text and `listCategories()` answers names and
 * counts. So the match is against the same string the list returns — no trimming, no case folding —
 * or the digest of a name and the digest of its tidied twin stop agreeing.
 *
 * ⚠ **A category that has gone is NOT an error.** Categories are derived from what is on sale, so
 * the last product leaving one deletes it, and a button in a week-old chat is an ordinary event.
 * The customer gets the whole shelf and a sentence saying why.
 */
async function handleCategoryTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const categories = await publicCatalogService.listCategories();
    const match = categories.find((category) => categoryDigest(category.name) === action.argument);

    if (!match) {
        await openInAppScreen(req, {
            payload: { kind: 'pl', query: { q: null, category: null, storeSlug: null, productIds: null } },
            fallbackPath: '/shop',
            labelKey: 'browseAllButton',
            textKey: 'categoryGonePrompt',
        });
        sendSuccess(res, { opened: 'listing', category: null });
        return;
    }

    await openInAppScreen(req, {
        payload: { kind: 'pl', query: { q: null, category: match.name, storeSlug: null, productIds: null } },
        /**
         * The storefront fallback mirrors the query, so a customer landing in a browser sees the
         * same shelf rather than the shop's front page — and in production, where no in-app origin
         * is configured, this is the path that actually runs.
         */
        fallbackPath: `/shop?category=${encodeURIComponent(match.name)}`,
        labelKey: 'browseAllButton',
    });

    sendSuccess(res, { opened: 'listing', category: match.name, total: match.productCount });
}

/**
 * `sim:<productId>` — products like this one, drawn as cards.
 *
 * ⚠ **Cards rather than a screen, and that is the opposite of what the detail screen's own
 * Similar-items button does.** There the customer is already inside the app and a grid is the right
 * answer; here they are in a chat, and `productDisplayService` already decides per channel whether
 * that becomes a Mini App button, a carousel or five image cards. Handing this to a screen would
 * degrade to a storefront link in production, which is worse than the cards that work today.
 */
async function handleSimilarTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const envelope = req.bot!.envelope;
    const productId = assertTapProductId(action.argument);

    const productIds = await readSimilarProductIds(productId);
    if (productIds.length === 0) {
        setBotReply(req, { kind: 'text', text: botChrome('noSimilarItemsPrompt', language) });
        sendSuccess(res, { shown: 0 });
        return;
    }

    const page = await productDisplayService.create({
        productIds,
        owner: caller.userId,
        customerId: caller.customerId,
        channel: envelope.channel,
        externalId: envelope.externalId,
        language,
    });

    /**
     * ⚠ **A tap needs its own sentence, unlike a model-driven list.** `create` leaves the intro
     * empty because the model has just written one; nobody wrote anything here — a button was
     * pressed — so the reply says what the customer is looking at.
     */
    if (!page.intent) {
        setBotReply(req, { kind: 'text', text: botChrome('noSimilarItemsPrompt', language) });
        sendSuccess(res, { shown: 0 });
        return;
    }

    setBotReply(
        req,
        page.intent.kind === 'product_list'
            /**
             * ⚠ **A tap needs its own sentence and it must be the RIGHT one.** This briefly used
             * `moreProductsPrompt` ("Here are some more.") while its own key was in the contract
             * queue — true after this tap, and subtly wrong: the customer asked for things LIKE the
             * one they were looking at, not more of a list.
             */
            ? { ...page.intent, text: botChrome('similarItemsPrompt', language) }
            : page.intent,
    );
    sendSuccess(res, { shown: page.cards.length, total: page.total });
}

/**
 * `save:<productId>` — put it in the customer's saved items.
 *
 * ⛔ **This is NOT "notify me", and the copy must never imply it is** (owner, 2026-09-16). Nothing
 * on this platform can tell a customer that something is back in stock — the wishlist model records
 * that as deliberately unbuilt — so the button saves and promises exactly that.
 *
 * Saving is idempotent by index, so a double tap answers the same sentence rather than a conflict:
 * from where the customer sits, "it is saved" was already true.
 */
async function handleSaveTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const productId = assertTapProductId(action.argument);

    await wishlistService.add(caller.customerId, productId);

    setBotReply(req, { kind: 'text', text: botChrome('savedForLaterPrompt', language) });
    sendSuccess(res, { saved: true, productId });
}

/**
 * `open:pd:<productId>` — open the product screen, from a reviews summary or anywhere else.
 *
 * ⚠ **A storefront fallback, unlike the switchboard's `inapp_open_product`, which composes none.**
 * That route's reasoning is that a product's canonical URL needs two slugs it does not hold — true,
 * but `/shop/p/<id>` is the storefront's own by-id redirect stub, already used by the booking
 * controller and by the approved WhatsApp carousel template. Without it this tap renders no control
 * at all in production, where there is no in-app origin.
 */
async function handleOpenProductTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const productId = assertTapProductId(action.argument);

    await openInAppScreen(req, {
        payload: { kind: 'pd', productId },
        fallbackPath: `/shop/p/${productId}`,
        labelKey: 'openButton',
    });

    recordProductView(botCallerOf(req).customerId, productId);

    sendSuccess(res, { opened: 'product', productId });
}

/**
 * Remember that this customer opened this product.
 *
 * ── ⚠ ON OPENING, NEVER ON RENDERING — AND THE TOOL'S OWN DESCRIPTION SAID OTHERWISE ──
 * `recently_viewed_record` is `flow_only` and its description asks the flow that RENDERS product
 * cards to call it. That was rejected deliberately (owner's ruling, 2026-09-20): a single search
 * draws five to ten cards, so recording on render floods the very list the support ladder reads to
 * answer *"what was this customer looking at"* — and makes it less useful the more the customer
 * browses. Opening a product is the act that means something; being shown one in a grid is not.
 *
 * ⚠ **Nothing was calling it at all**, from any flow, so the list the ladder reads was never
 * written from the bot. This call and the product screen's data read are the two that fix it.
 *
 * ⚠ **Best-effort, and it must stay that way.** A remembered view is a convenience; the tap's job
 * is to open the product. `record` throws for a product that has gone off sale, and that must cost
 * the customer nothing — so the failure is logged and swallowed, exactly as the screen session's
 * `touch` is.
 */
function recordProductView(customerId: string, productId: string): void {
    void recentlyViewedService.record(customerId, productId).catch((error: unknown) => {
        console.warn('[BotSurface] could not record a product view', error);
    });
}

/**
 * A product id carried by a TAP — refused as a token, never as a schema failure.
 *
 * A malformed token is not something the customer typed, so a validation error naming a field they
 * never sent is a sentence nobody can act on. `unknownBotAction()` is the one refusal for every way
 * a tap can route nowhere.
 */
function assertTapProductId(argument: string): string {
    if (!/^[0-9a-fA-F]{24}$/.test(argument)) throw unknownBotAction();
    return argument;
}

/**
 * The keys this stream answers, for the dispatcher's registry.
 *
 * ⚠ Two maps rather than one for this stream, agreed with the registry's owner: these are the
 * catalogue's turns, and `deal:` belongs to the negotiation module's. The no-double-claim assertion
 * runs over one flat key space either way, so the split costs nothing and keeps each map next to
 * the code it routes to.
 */
export const DISCOVERY_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    cat: handleCategoryTap,
    sim: handleSimilarTap,
    save: handleSaveTap,
    'open:pd': handleOpenProductTap,
});
