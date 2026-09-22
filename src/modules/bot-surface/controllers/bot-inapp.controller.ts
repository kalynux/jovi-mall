import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome, BotChromeKey } from '../domain/bot-chrome-copy';
import { botStorefrontLink, surfacePath } from '../domain/bot-list-window';
import { inAppScreenUrl } from '../domain/inapp-url';
import {
    InAppListingQuery,
    InAppSurfaceKind,
    inAppSurfaceStore,
} from '../services/inapp-surface.store';
import {
    BotInAppListingSchema,
    BotInAppProductSchema,
    BotInAppStoresSchema,
} from '../validators/bot.validators';

/**
 * The doors onto the in-app screens — three routes, each one turn long.
 *
 * ── WHAT THIS CONTROLLER IS, AND WHAT IT DELIBERATELY IS NOT ────────────────
 * It **mints a session and hands back a button.** It does not read a catalogue, render a
 * product, page a grid or know what a screen looks like. Every one of those belongs to the
 * screen's own controller under `miniapp/`, which is reached by the handle this produces.
 *
 * The split exists because the two halves have different credentials and different audiences.
 * This surface is reached with `INTERNAL_SERVICE_TOKEN` **and** `BOT_WEBHOOK_SECRET`, held by
 * the automation layer and nothing else; the screen is reached by a browser on a customer's
 * phone, which can hold neither. So a handle is the only thing that can cross between them,
 * and minting it is all this file does.
 *
 * ── ⚠ EVERY ROUTE HERE DEGRADES, AND BOTH HALVES OF THE LADDER RUN ───────────
 * `inAppScreenUrl` answers null whenever this deployment has no HTTPS in-app origin. This
 * header used to say that was "true in production today"; ⚠ **it stopped being true** — the
 * owner's WhatsApp turn of 2026-09-22 (core exec 1942) came back with a `/api/bot/miniapp/s/ol/…`
 * screen URL, so `BOT_MINIAPP_BASE_URL` is set there now. Whether a screen exists is
 * configuration, and neither branch is a sketch: without an origin this must still leave the
 * customer somewhere real, which is the storefront, via `botStorefrontLink`, which already gets
 * the customer's language prefix right.
 *
 * ── ⚠ THE SENTENCE ABOVE THE BUTTON IS PER SCREEN, NEVER A PRODUCT DEFAULT ────
 * The door's `text` is what the customer reads, and on WhatsApp it is the whole `cta_url` body.
 * Two doors were shipped reading a sentence that belonged to another screen: the order history
 * said *"Here are a few more."* (the product "See more" page's line) and one product said *"Tap
 * below to see THEM"*. The first reached the owner's handset twice in one turn, because the model
 * copied it as its own answer. `SCREEN_PROMPT` is the per-kind table that replaced the single
 * product-shaped default; see it before adding a door.
 *
 * ⚠ **Never a dead button.** A `link` intent with no URL is worse than no button at all, so
 * when neither a screen nor a storefront link can be built, the reply is cleared and the model
 * answers in its own words. That is the same rule `createPayLink` already follows.
 */

/**
 * The sentence over each screen's button, by kind — used when a door names no `textKey`.
 *
 * ⚠ **Every entry is a sentence that is RIGHT for that screen.** The old single default
 * (`browseProductsPrompt`, *"Tap below to see them with pictures and prices."*) is right for a
 * grid of products and for nothing else — it put "them" over ONE product (exec 1892, the owner's
 * handset, 2026-09-22). It survives below only as the last resort for a kind added later without
 * an entry here; add the entry with the kind.
 *
 *   - `pd` — ONE product: `productScreenPrompt`. One line here fixes BOTH doors onto the product
 *     screen — `inapp_open_product` and the discovery stream's `open:pd` tap, which names no
 *     `textKey` either.
 *   - `sl` — the shop directory, whose "them" is shops and whose shops have no prices:
 *     `storesScreenPrompt`.
 *
 * `co`, `bk` and `bp` have no entry because no door reaches them through this helper: each is
 * minted by its own stream on the tap that opens it, with that stream's own sentence.
 */
const SCREEN_PROMPT: Readonly<Partial<Record<InAppSurfaceKind, BotChromeKey>>> = Object.freeze({
    pl: 'browseProductsPrompt',
    pd: 'productScreenPrompt',
    sl: 'storesScreenPrompt',
    ol: 'ordersScreenPrompt',
    tf: 'supportFormPrompt',
    bl: 'bookingsScreenPrompt',
});

/** This kind's sentence, or the product-grid line where no correct one exists yet (see above). */
export function screenPromptOf(kind: InAppSurfaceKind): BotChromeKey {
    return SCREEN_PROMPT[kind] ?? 'browseProductsPrompt';
}

/**
 * ⭐ **The order-history screen, as every door onto it opens it** — the `inapp_open_orders` tool
 * and the `open:ol` tap (the Load more row under the chat order list).
 *
 * One descriptor rather than two call sites agreeing, because they did NOT agree: the tap said
 * *"Tap below to see all your orders."* over **See all**, while the tool said *"Here are a few
 * more."* over **Load more**, and it was the tool's version the owner met (core exec 1942).
 * `fallbackPath` is read from the same table `windowForChat({ surface: 'orders' })` reports as
 * `moreUrl`, so the storefront page cannot drift from the one the list advertises.
 */
export const ORDERS_SCREEN_DOOR: Readonly<{
    fallbackPath: string;
    labelKey: BotChromeKey;
    textKey: BotChromeKey;
}> = Object.freeze({
    fallbackPath: surfacePath('orders'),
    labelKey: 'browseAllButton',
    textKey: 'ordersScreenPrompt',
});

export class BotInAppController {
    /**
     * `POST /inapp/listing` — open the product grid.
     *
     * Serves category browse, "See all" after a page of cards, and a wishlist rendered as a
     * grid. The session holds the **query**, not a list of ids — see `InAppListingQuery` for
     * why that is the opposite of `ProductDisplaySet` on purpose.
     */
    static listing = asyncHandler(async (req: Request, res: Response) => {
        const input = BotInAppListingSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);
        const language = botResponseLanguageOf(req);

        const handle = await inAppSurfaceStore.mint({
            kind: 'pl',
            owner: caller.userId,
            customerId: caller.customerId,
            channel: req.bot!.envelope.channel,
            externalId: req.bot!.envelope.externalId,
            language,
            query: {
                q: input.q ?? null,
                category: input.category ?? null,
                storeSlug: input.storeSlug ?? null,
                productIds: input.productIds ?? null,
            },
        });

        /**
         * The storefront fallback mirrors the query, so a customer who lands in a browser sees
         * the same shelf rather than the shop's front page. `/shop` is the listing route the
         * chat list window already points at, so this cannot drift from that table.
         */
        const params = new URLSearchParams();
        if (input.q) params.set('q', input.q);
        if (input.category) params.set('category', input.category);
        const suffix = params.toString();

        respondWithScreen(req, {
            kind: 'pl',
            handle,
            language,
            fallbackPath: input.storeSlug
                ? `/shop/stores/${input.storeSlug}`
                : `/shop${suffix ? `?${suffix}` : ''}`,
            labelKey: 'browseAllButton',
        });

        sendSuccess(res, { handle, opened: 'listing' });
    });

    /**
     * `POST /inapp/products/:productId` — open one product, where variants can be chosen.
     *
     * ⚠ **This is the only place on the whole surface a customer can pick a variant.** A chat
     * card carries the default variant and nothing else, which is why every card needs this
     * door: a product with sizes is unbuyable from chat alone.
     */
    static product = asyncHandler(async (req: Request, res: Response) => {
        const { productId } = BotInAppProductSchema.parse(req.params);
        const caller = botCallerOf(req);
        const language = botResponseLanguageOf(req);

        /**
         * Shape-checked here rather than trusted downstream, and answered as NOT FOUND rather
         * than as a validation error — the rule the rest of this surface follows so a caller
         * cannot learn that its id was well-formed-but-unknown.
         */
        if (!Types.ObjectId.isValid(productId)) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
        }

        const handle = await inAppSurfaceStore.mint({
            kind: 'pd',
            owner: caller.userId,
            customerId: caller.customerId,
            channel: req.bot!.envelope.channel,
            externalId: req.bot!.envelope.externalId,
            language,
            productId,
        });

        /**
         * ⚠ **This used to pass `null` and say that no id-shaped product URL existed. That was
         * WRONG, and the cost was silence.** The canonical URL does need two slugs
         * (`/shop/stores/<storeSlug>/products/<productSlug>`) which this route does not hold —
         * but the storefront also serves a **by-id redirect stub**, `/shop/p/<productId>`, which
         * `bot-booking.controller.ts` has linked to all along and which the discovery stream
         * uses for the same fallback. Verified: `frontend/landing/src/app/[locale]/shop/p`.
         *
         * With `BOT_MINIAPP_BASE_URL` unset — production today — `respondWithScreen` had no
         * screen AND no fallback, so it rendered **no control at all**: the one door whose whole
         * job is "open this product" answered with a bare sentence.
         */
        respondWithScreen(req, {
            kind: 'pd',
            handle,
            language,
            fallbackPath: `/shop/p/${productId}`,
            labelKey: 'openButton',
        });

        sendSuccess(res, { handle, opened: 'product' });
    });

    /**
     * `POST /inapp/stores` — open the store directory.
     *
     * ⚠ **A listing rather than a chat picker, and that is a capacity decision.** There can be
     * well over a hundred stores; a WhatsApp list holds ten rows and a chat answer is capped at
     * five. A picker over five of a hundred stores is not a directory, it is a sample.
     *
     * ⚠ **The store SCREEN is a later milestone.** Until it exists this route still answers —
     * with the storefront link — because the alternative is a button that opens nothing. The
     * session is minted regardless so the screen needs no contract change when it lands.
     */
    static stores = asyncHandler(async (req: Request, res: Response) => {
        const input = BotInAppStoresSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);
        const language = botResponseLanguageOf(req);

        const handle = await inAppSurfaceStore.mint({
            kind: 'sl',
            owner: caller.userId,
            customerId: caller.customerId,
            channel: req.bot!.envelope.channel,
            externalId: req.bot!.envelope.externalId,
            language,
            query: { q: input.q ?? null, city: input.city ?? null },
        });

        respondWithScreen(req, {
            kind: 'sl',
            handle,
            language,
            /**
             * ⚠ **null: the website has NO all-shops page.** This was `/shop/stores`, which answers
             * 404 in every language — only `/shop/stores/<slug>` exists (deploy-day link check,
             * 2026-09-21). With no honest page to send them to, the customer gets no button and
             * the assistant answers in words, rather than a "View stores" button that dead-ends.
             * If the website gains a shops directory, point this at it.
             */
            fallbackPath: null,
            labelKey: 'viewStoresButton',
        });

        sendSuccess(res, { handle, opened: 'stores' });
    });

    /**
     * `POST /inapp/orders` — open the customer's full order history.
     *
     * ⚠ **Takes no arguments at all**, and that is the session shape rather than an omission.
     * An order listing is scoped by the caller's own identity, so naming an id would be
     * inventing a parameter that could only ever be wrong — the same reasoning that leaves
     * `open:ol` without a reference and `InAppSurfaceSession`'s `ol` member without a query.
     * There is therefore no validator: there is nothing to validate.
     *
     * ⚠ **The first caller of `openInAppScreen`, deliberately.** The three doors above each
     * hand-roll mint-then-respond because they predate the helper; this one proves it, and the
     * three should collapse onto it in a later pass. The helper exists because the tap-code
     * door and the chat order list both need to open a screen too, and three hand-written
     * copies of the owner binding is three chances to get the owner binding wrong.
     *
     * ── ⛔ WHAT THIS DOOR SAID ON THE OWNER'S HANDSET (core exec 1942, 2026-09-22) ──
     * *"Here are a few more."* over a **Load more** button, as the answer to "Sho my orders" —
     * and the model, reading that sentence in the tool result, typed it again as its own answer,
     * so the customer got it twice. Both keys were borrowed from other turns: `moreProductsPrompt`
     * is the product "See more" page's line (a SECOND page, wrong for a first look) and
     * `loadMoreRow` is the sixth ROW of the chat order list, which is the tap that reaches
     * `open:ol` — not what a door opened from a typed request should be labelled.
     *
     * ⚠ **Now `ORDERS_SCREEN_DOOR`, the one descriptor the `open:ol` tap uses too**, so the two
     * ways into this screen say the same sentence over the same label and cannot drift apart again.
     *
     * ⚠ **This door is the SECOND answer to "show my orders", not the first.** The first is
     * `orders_list_groups`, which draws the five most recent orders in the chat as a list the
     * customer can tap, with the Load more row leading here. The model reached for this door
     * instead because the catalogue's `when_to_use` quoted "show me my orders" verbatim — see the
     * chat-surfaces report for the catalogue request.
     */
    static orders = asyncHandler(async (req: Request, res: Response) => {
        const handle = await openInAppScreen(req, { payload: { kind: 'ol' }, ...ORDERS_SCREEN_DOOR });

        sendSuccess(res, { handle, opened: 'orders' });
    });
}

/**
 * Set the reply for a screen: the in-app button when there is a screen, the storefront link
 * when there is not, and nothing at all when there is neither.
 *
 * ⚠ **One helper rather than three copies, because the THIRD case is the one that gets
 * forgotten.** An unconfigured deployment with no storefront URL either has to say something
 * the model can continue from, or say nothing and let the model speak — and what it must never
 * do is render a control with an empty target.
 */
export function respondWithScreen(
    req: Request,
    input: {
        kind: InAppSurfaceKind;
        handle: string;
        language: string | null;
        /** A storefront path to fall back to, or null when none can be composed honestly. */
        fallbackPath: string | null;
        labelKey: BotChromeKey;
        /**
         * The sentence above the button. Defaults to this KIND's line in `SCREEN_PROMPT` — it
         * used to default to the product-grid prompt for every kind, which is how a single
         * product came to be introduced as "them".
         */
        textKey?: BotChromeKey;
    },
): void {
    const label = botChrome(input.labelKey, input.language);
    const text = botChrome(input.textKey ?? screenPromptOf(input.kind), input.language);

    const screenUrl = inAppScreenUrl(input.kind, input.handle, input.language);
    if (screenUrl) {
        setBotReply(req, { kind: 'inapp', text, label, url: screenUrl });
        return;
    }

    const fallbackUrl = input.fallbackPath
        ? botStorefrontLink(input.fallbackPath, input.language)
        : null;

    setBotReply(req, fallbackUrl ? { kind: 'link', text, label, url: fallbackUrl } : null);
}

/**
 * What a caller supplies to open a screen: the kind, and whatever that kind's session needs.
 *
 * Deliberately mirrors `InAppSessionInput` minus the five fields every session shares, because
 * those five come from the request and a caller that could supply them could mint a session
 * addressed at somebody else's conversation.
 */
export type InAppScreenPayload =
    | { kind: 'pl'; query: InAppListingQuery }
    | { kind: 'pd'; productId: string }
    | { kind: 'ol' }
    | { kind: 'sl'; query: { q?: string | null; city?: string | null } }
    | { kind: 'co'; cartId: string | null }
    | {
          kind: 'tf';
          form: {
              orderId: string | null;
              topic: 'rd' | 'ad' | 'hp' | null;
              attachmentRef: string | null;
          };
      }
    /**
     * ⚠ **All THREE bookings kinds land together, though only `bl` has a caller today.** This
     * type is the second declaration of a fact the store already holds, and the `tf` round
     * showed what happens when only one half moves: the store gained the kind, this did not,
     * and the stream that needed it stopped dead on a type error in a file it does not own.
     * Adding `bk` and `bp` now costs two lines and removes this file as a place the kinds can
     * disagree.
     */
    | { kind: 'bl' }
    | { kind: 'bk'; productId: string; bookingId: string | null }
    | { kind: 'bp'; bookingId: string; purpose: 'primary' | 'balance' };

/**
 * Mint a screen session for the customer this request belongs to, and set the reply that opens
 * it — falling back to the storefront, and to no control at all when there is not even that.
 *
 * ── ⚠ WHY THIS IS EXPORTED, AND WHY EVERY STREAM MUST USE IT ────────────────
 * Several controllers now need to open a screen: this one's three doors, the tap-code door
 * that handles `open:<surface>` buttons, and the chat order list's "show me the rest" row.
 * Written three times it becomes three opinions about the **owner binding** — and that binding
 * is the security property of the whole surface. The five shared fields below are read from
 * the request envelope and from nowhere else, so a session can only ever be addressed at the
 * conversation that asked for it. A caller passing its own `owner` is the bug this prevents by
 * not offering the option.
 *
 * It also means the degradation is written once. `BOT_MINIAPP_BASE_URL` is unset in production,
 * so the fallback is not a rare branch to sketch in — it is the path that actually runs, and
 * three hand-written copies of it is three chances to render a button with an empty target.
 *
 * Returns the handle, because a caller usually wants to report it.
 */
export async function openInAppScreen(
    req: Request,
    input: {
        payload: InAppScreenPayload;
        /** A storefront path to fall back to, or null when none can be composed honestly. */
        fallbackPath: string | null;
        labelKey: BotChromeKey;
        textKey?: BotChromeKey;
    },
): Promise<string> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const handle = await inAppSurfaceStore.mint({
        ...input.payload,
        owner: caller.userId,
        customerId: caller.customerId,
        channel: req.bot!.envelope.channel,
        externalId: req.bot!.envelope.externalId,
        language,
    } as Parameters<typeof inAppSurfaceStore.mint>[0]);

    respondWithScreen(req, {
        kind: input.payload.kind,
        handle,
        language,
        fallbackPath: input.fallbackPath,
        labelKey: input.labelKey,
        textKey: input.textKey,
    });

    return handle;
}
