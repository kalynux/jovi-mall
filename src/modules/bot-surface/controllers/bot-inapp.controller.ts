import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome, BotChromeKey } from '../domain/bot-chrome-copy';
import { botStorefrontLink } from '../domain/bot-list-window';
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
 * ── ⚠ EVERY ROUTE HERE DEGRADES, AND THE DEGRADATION IS THE COMMON CASE ─────
 * `inAppScreenUrl` answers null whenever this deployment has no HTTPS in-app origin — which
 * is **true in production today**, because `BOT_MINIAPP_BASE_URL` is unset. So the "no screen
 * available" path is not a rare fallback to be sketched in; it is the path that runs, and it
 * must leave the customer somewhere real. That somewhere is the storefront, via
 * `botStorefrontLink`, which already gets the customer's language prefix right.
 *
 * ⚠ **Never a dead button.** A `link` intent with no URL is worse than no button at all, so
 * when neither a screen nor a storefront link can be built, the reply is cleared and the model
 * answers in its own words. That is the same rule `createPayLink` already follows.
 */
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
         * ⚠ **No storefront fallback path is composed here, and that is not an omission.** A
         * product's public URL is `/shop/stores/<storeSlug>/products/<productSlug>` — two
         * slugs this route does not hold and would have to fetch. The card that offered this
         * button already carries `detailUrl` built from exactly those slugs, so the customer
         * has a working link either way; inventing a second, id-shaped one here would produce
         * a 404 in a chat window, discovered by the customer.
         */
        respondWithScreen(req, {
            kind: 'pd',
            handle,
            language,
            fallbackPath: null,
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
            fallbackPath: '/shop/stores',
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
     * ⚠ **`loadMoreRow` is the label, not a button key**, because in chat this arrives as the
     * sixth row of a list rather than as a button — five orders plus a way out. Six rows is a
     * WhatsApp *list*; buttons cap at three.
     */
    static orders = asyncHandler(async (req: Request, res: Response) => {
        const handle = await openInAppScreen(req, {
            payload: { kind: 'ol' },
            /**
             * The storefront's own order list, which is where this degrades today — production
             * has no in-app origin configured, so this is the path that actually runs.
             */
            fallbackPath: '/shop/account/orders',
            labelKey: 'loadMoreRow',
            textKey: 'moreProductsPrompt',
        });

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
         * The sentence above the button. Defaults to the browse prompt, which is right for the
         * three product doors and wrong for everything else — an order screen introduced with
         * "here are some products" is worse than no sentence at all.
         */
        textKey?: BotChromeKey;
    },
): void {
    const label = botChrome(input.labelKey, input.language);
    const text = botChrome(input.textKey ?? 'browseProductsPrompt', input.language);

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
    | { kind: 'co'; cartId: string | null };

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
