import { publicCatalogService } from '../../catalog/services/public-catalog.service';
import { botChrome } from '../domain/bot-chrome-copy';
import { showMoreActionId } from '../domain/bot-action-id';
import { BOT_CHAT_LIST_MAX } from '../domain/bot-list-window';
import { BotReplyIntent, WA_CAROUSEL_CARDS } from '../domain/channel-reply';
import { BotProductCard, toBotProductCard } from '../domain/product-card';
import { inAppBaseUrl, inAppScreenUrl } from '../domain/inapp-url';
import { inAppSurfaceStore } from './inapp-surface.store';
import { ProductDisplaySet, productDisplayStore } from './product-display.store';

/**
 * Turning a set of product ids into the messages a customer actually sees.
 *
 * ── THE ONE RULE THAT DECIDES EVERYTHING ELSE HERE ──────────────────────────
 * **The model chooses WHICH products; this service chooses HOW they are drawn, and the two
 * decisions never swap places.** The model has just run a search and picked the ones worth
 * showing — that is a judgement about the conversation, and nothing here second-guesses it.
 * Whether those become a Mini App button, a carousel or five image cards is a judgement about
 * a channel's capabilities, a deployment's configuration and a picture's reachability, none
 * of which a language model can see and all of which change without it being told.
 *
 * That split is why `show_products` takes ids and returns a count, and why every degradation
 * below is silent to the caller: the model wrote one sentence and asked for five products to
 * be shown, and five products were shown, by whatever means this deployment has.
 */

/** How many products the model may hand over at once. Two pages of five. */
export const BOT_DISPLAY_MAX_PRODUCTS = 10;

/**
 * ⚠ **Every variable below is read as a spelled-out property access, never through a helper
 * that takes the name as an argument.**
 *
 * `test:env` re-derives the environment contract by scanning source, and it recognises exactly
 * two shapes: a literal environment property access, and the seven named config helpers
 * (`intEnv`, `boolEnv`, `listEnv`, …). A local `read('BOT_MINIAPP_BASE_URL')` is invisible to
 * that census — so the variable would go undocumented in `.env.example` and the suite would
 * pass anyway, which is the exact failure it exists to prevent and how every storage
 * credential once ended up documented under a name nothing read.
 *
 * ⚠ It scans COMMENTS too. Writing an example access in this docstring adds a variable called
 * `NAME` to the contract, which is why this paragraph describes the shape instead of showing
 * it — measured, on the first run of the suite after this file was written.
 */
const trimmed = (value: string | undefined): string | null => {
    const out = (value ?? '').trim().replace(/\/+$/, '');
    return out.length > 0 ? out : null;
};

/**
 * ⚠ **The in-app origin is read through `domain/inapp-url.ts` and nowhere else.**
 *
 * There was a local `miniAppBaseUrl` alias here, kept so this file's call sites read unchanged
 * while the old rail was retired. The repoint removed the last of those call sites, so the
 * alias went with them rather than sitting here looking alive.
 *
 * The reason it is one implementation and not two is worth keeping: five screens need the same
 * answer with the same two checks — HTTPS, because Telegram refuses the whole `sendMessage`
 * otherwise, and public reachability, because a screen on a loopback address opens for nobody.
 * Two readers of one environment variable is a drift whose symptom is a turn in which the
 * customer is told nothing at all.
 */

/**
 * The approved WhatsApp carousel template, if this deployment has one.
 *
 * Absent is the ordinary case. See the `product_list` intent for why a carousel is a
 * pre-approved marketing template rather than something that can simply be sent.
 */
function carouselTemplate(): { templateName: string; languageCode: string } | null {
    const templateName = trimmed(process.env.WHATSAPP_PRODUCT_CAROUSEL_TEMPLATE);
    if (!templateName) return null;
    return {
        templateName,
        languageCode: process.env.WHATSAPP_PRODUCT_CAROUSEL_LANG?.trim() || 'en',
    };
}

export interface ProductDisplayPage {
    /** The handle the "See more" button and the Mini App both name. */
    setId: string;
    /** What this page will draw. Never more than `BOT_CHAT_LIST_MAX`. */
    cards: BotProductCard[];
    /** Rows in the whole set, across every page. */
    total: number;
    /** Is there another page behind this one? */
    hasMore: boolean;
    /** The absolute Mini App URL, or null when this deployment or channel has none. */
    miniAppUrl: string | null;
    /** What to send. Null when there is nothing showable at all. */
    intent: BotReplyIntent | null;
}

export class ProductDisplayService {
    /**
     * A fresh list: hydrate, persist, and build the first page.
     *
     * ⚠ **The caller's ORDER is preserved and a missing id is DROPPED, not an error.**
     * `listByIdsWithVariant` answers a Map precisely so both are possible: a product the model
     * saw in a search a second ago may have been suspended, unpublished or sold out of
     * existence since, and the right rendering is four cards rather than a failure. The order
     * is the model's ranking and re-sorting it would silently disagree with the sentence it
     * has just written.
     */
    async create(input: {
        productIds: string[];
        owner: string;
        customerId: string;
        channel: ProductDisplaySet['channel'];
        externalId: string;
        language: string | null;
    }): Promise<ProductDisplayPage> {
        const requested = [...new Set(input.productIds)].slice(0, BOT_DISPLAY_MAX_PRODUCTS);
        const hydrated = await publicCatalogService.listByIdsWithVariant(requested);
        const live = requested.filter((id) => hydrated.has(id));

        const setId = await productDisplayStore.mint({
            owner: input.owner,
            customerId: input.customerId,
            channel: input.channel,
            externalId: input.externalId,
            language: input.language,
            productIds: live,
            offset: 0,
        });

        return this.buildPage(
            {
                owner: input.owner,
                customerId: input.customerId,
                channel: input.channel,
                externalId: input.externalId,
                language: input.language,
                productIds: live,
                offset: 0,
            },
            setId,
            // ⚠ Empty on purpose. The model has just written its own sentence introducing
            // these products, in the conversation it is having; a second generic line over
            // the top of it is the talking-over `setOnboardingReply` refuses to do.
            { intro: '' },
        );
    }

    /**
     * The next page of a set the customer is already looking at.
     *
     * Advances the stored cursor BEFORE returning, so a double tap on "See more" — which
     * happens, because a chat button does not visibly disable itself — shows page three
     * rather than page two twice.
     */
    async next(owner: string, setId: string): Promise<ProductDisplayPage | null> {
        const set = await productDisplayStore.read(owner, setId);
        if (!set) return null;

        const offset = Math.min(set.offset + BOT_CHAT_LIST_MAX, set.productIds.length);
        await productDisplayStore.advance(owner, setId, offset);

        return this.buildPage({ ...set, offset }, setId, {
            intro: botChrome('moreProductsPrompt', set.language),
        });
    }

    /**
     * The URL behind the chat card's **Browse** button.
     *
     * ── ⚠ REPOINTED FROM THE OLD RAIL TO THE IN-APP LISTING SCREEN (R10) ────
     * This used to mint an `ma_` handle and open `/api/bot/miniapp/p/<handle>` — the original
     * Mini App product rail. That rail is being **replaced**, not left beside the new screen:
     * the platform must never ship two product-browsing experiences at once. So this button
     * now opens `/s/pl/<handle>`, and `miniapp.controller.ts` + `public/page.html` are deleted
     * once the new screen is confirmed working on a real handset.
     *
     * ⚠ **The old rail stays reachable by its own URL during the overlap, deliberately**, which
     * is exactly why the deletion is a named task rather than a someday — dead code that looks
     * alive is how somebody later fixes a bug in the wrong file. `test:inapp-catalog` § 2
     * refuses a half-deleted rail and prints the ordering while it is still standing.
     *
     * ── ⚠ THE IDS ARE PINNED, NOT RE-QUERIED, AND THAT IS THE WHOLE POINT ───
     * `InAppListingQuery` can hold either a query or a set of ids, and the two page very
     * differently. Handing this button a *query* would let the screen re-run a search and show
     * a customer different products, at different prices, from the ones the model just wrote a
     * sentence about. Pinning the set keeps the screen showing **exactly what the chat offered**
     * — the same guarantee `ProductDisplaySet` exists to make.
     *
     * The grid still re-reads each product live, so the prices are current; what is fixed is
     * *which* products, not what they cost.
     *
     * ⚠ **The whole set, not the current page.** `set.productIds` is every id the model chose;
     * the chat shows five at a time and the screen shows all of them. That is the button's
     * entire purpose — "see these properly" — and windowing it here would make the screen a
     * second copy of the chat's paging.
     *
     * Null whenever this deployment has no in-app origin, which is **the path that runs today**
     * — `BOT_MINIAPP_BASE_URL` is unset in production. `channel-reply.ts` drops the button
     * rather than rendering one with an empty target.
     */
    private async browseScreenUrl(set: Omit<ProductDisplaySet, 'expiresAt'>): Promise<string | null> {
        // Asked BEFORE minting: a session written for a screen this deployment cannot open is
        // a Redis key nothing will ever read.
        if (!inAppBaseUrl()) return null;

        const handle = await inAppSurfaceStore.mint({
            kind: 'pl',
            owner: set.owner,
            customerId: set.customerId,
            channel: set.channel,
            externalId: set.externalId,
            language: set.language,
            query: { q: null, category: null, storeSlug: null, productIds: set.productIds },
        });

        return inAppScreenUrl('pl', handle, set.language);
    }

    /** Everything in a set, for the Mini App page — no windowing, no intent. */
    async cardsForSet(set: ProductDisplaySet): Promise<BotProductCard[]> {
        const hydrated = await publicCatalogService.listByIdsWithVariant(set.productIds);
        return set.productIds
            .map((id) => hydrated.get(id))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
            .map((entry) => toBotProductCard(entry.item, entry.defaultVariantId, set.language));
    }

    /**
     * One page of a set → the cards and the intent that draws them.
     *
     * ⚠ **Re-hydrates on every page, deliberately.** The stored set holds ids and nothing
     * else — no titles, no prices, no stock — so page two quotes what the product costs now
     * rather than what it cost when the list was built half an hour ago. A cached card is a
     * price a customer can hold us to.
     */
    private async buildPage(
        set: Omit<ProductDisplaySet, 'expiresAt'>,
        setId: string,
        options: { intro: string },
    ): Promise<ProductDisplayPage> {
        const window = set.productIds.slice(set.offset, set.offset + BOT_CHAT_LIST_MAX);
        const hydrated = await publicCatalogService.listByIdsWithVariant(window);
        const cards = window
            .map((id) => hydrated.get(id))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
            .map((entry) => toBotProductCard(entry.item, entry.defaultVariantId, set.language));

        const hasMore = set.productIds.length > set.offset + window.length;

        /**
         * ⚠ **The Mini App is Telegram-only, and that is a platform fact rather than a
         * preference.** `web_app` is a Telegram inline-keyboard button; WhatsApp's nearest
         * equivalent is a Flow, which is a different artefact needing its own publication.
         * A `cta_url` would open the page in the phone's browser, outside the chat, with no
         * way back — which is worse than the cards it would replace.
         */
        const miniAppUrl =
            set.channel === 'telegram' ? await this.browseScreenUrl(set) : null;

        if (cards.length === 0) return { setId, cards, total: set.productIds.length, hasMore, miniAppUrl: null, intent: null };

        return {
            setId,
            cards,
            total: set.productIds.length,
            hasMore,
            miniAppUrl,
            intent: {
                kind: 'product_list',
                text: options.intro,
                browsePrompt: botChrome('browseProductsPrompt', set.language),
                cards,
                miniAppUrl,
                hasMore,
                moreToken: hasMore ? showMoreActionId(setId) : null,
                labels: {
                    browse: botChrome('browseProductsButton', set.language),
                    buyNow: botChrome('buyNowButton', set.language),
                    addToCart: botChrome('addToCartButton', set.language),
                    seeMore: botChrome('seeMoreButton', set.language),
                    details: botChrome('detailsButton', set.language),
                },
                carousel: cards.length === WA_CAROUSEL_CARDS ? carouselTemplate() : null,
                /**
                 * ⚠ **The product ID ALONE, because a template URL button takes a suffix.**
                 * The approved template declares `https://<storefront>/shop/p/{{1}}`, so what
                 * travels is the id. `/shop/p/:id` is the storefront's own redirect stub for
                 * "a link held somewhere that knows an id but not a store slug", which is
                 * exactly this situation — and it is already used by `bot-booking.controller`
                 * for the same reason.
                 */
                carouselUrlSuffix: (card) => card.productId,
            },
        };
    }
}

export const productDisplayService = new ProductDisplayService();
