import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CartService } from '../../cart/services/cart.service';
import { MessagingChannel } from '../../channel-connections';
import { PublicProductDetailDto } from '../../catalog/dto/public-product.dto';
import { publicCatalogService } from '../../catalog/services/public-catalog.service';
import { TelegramBotService } from '../../telegram/services/telegram-bot.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { botStorefrontLink } from '../domain/bot-list-window';
import { BotReplyIntent, BotReplyOption } from '../domain/channel-reply';
// ⚠ `cartViewActionId` / `openSurfaceActionId` are deliberately NOT imported here any more:
// the three post-add buttons are built in `domain/purchase-chat-copy.ts` alone, and
// `test:inapp-purchase` fails if this file starts building them again.
import {
    BotActionHandlers,
    ParsedBotAction,
    unknownBotAction,
} from '../domain/bot-action-dispatch';
import { inAppBaseUrl, inAppScreenUrl } from '../domain/inapp-url';
import { PurchaseVerb, resolvePurchaseAffordance } from '../domain/purchase-affordance';
import { addedToCartActions, purchaseInvitePrompt } from '../domain/purchase-chat-copy';
import { inAppSurfaceStore } from '../services/inapp-surface.store';
import { productDisplayService } from '../services/product-display.service';
import { productDisplayStore } from '../services/product-display.store';

const cartService = new CartService();
const telegramBotService = new TelegramBotService();

/**
 * WHAT HAPPENS WHEN A CUSTOMER PRESSES A PURCHASE BUTTON.
 *
 * ── TWO DOORS, ONE DECISION ─────────────────────────────────────────────────
 * A customer reaches the four rungs — Bargain · Add to cart · Buy now · Book — from two
 * completely different places, and both land here:
 *
 *   `POST /catalog/action`        a tap in the chat, carrying a `<verb>:<argument>` token
 *   `POST /s/pd/:handle/act`      a press on the in-app detail screen, carrying a variant
 *
 * They authenticate differently (the first by the bot surface's two credentials, the second by
 * an opaque screen handle), they answer differently (a channel-ready `reply` versus a JSON
 * outcome the page acts on), and in between they run **the same function**. That is the whole
 * arrangement: `resolvePurchaseAffordance` decides which rung a product is on, one place
 * executes it, and a customer gets the same behaviour whichever control they pressed.
 *
 * ── ⚠ THE SERVER RE-RESOLVES THE RUNG. THE VERB IS NEVER TRUSTED ────────────
 * **`executePurchase` ignores the verb it was handed and derives the rung itself**, from the
 * product and the variant. Both callers are things a customer can edit — a callback payload is
 * whatever the client sent back, and a web page is a document with a console in it — so a
 * request that could NAME its own rung could ask to "buy now" something negotiable, or add a
 * service the cart refuses with `CART_SERVICE_PRODUCT_NOT_ALLOWED`. That refusal is not
 * hypothetical: it is the defect `purchase-affordance.ts` was written after.
 *
 * The token's verb survives for exactly two purposes — deciding whether to expect one id or
 * two, and refusing a token this service never minted. It decides nothing about what happens.
 *
 * ⚠ **So a product that MOVED between the drawing and the tap behaves correctly rather than
 * consistently.** A card drawn last month says "Add to cart"; if the vendor has since opened a
 * bargaining window, the tap opens a haggle instead. The customer gets something other than the
 * word they pressed, and that is the right outcome — the alternative is honouring a stale label
 * by selling at a price that is no longer on offer. A `book:` token carries no variant, so when
 * a product has moved the other way (service → physical) the default variant is used;
 * `defaultVariantId` is exactly the id a chat card would have carried for it.
 */
export class BotPurchaseController {
    /**
     * `POST /api/bot/miniapp/s/pd/:handle/act` — the in-app detail screen's purchase button.
     *
     * ── THE OTHER HALF OF THE B/C SEAM ──────────────────────────────────────
     * `GET /s/pd/:handle/data` renders the button from `resolvePurchaseAffordance()` verbatim;
     * this executes it, re-resolving from the session's product and the posted variant. The two
     * are not coupled at runtime — they simply agree, because one function answers for both.
     * The response shape is written out as a contract in the opening comment of `public/pd.html`;
     * **if this file and that comment ever disagree, the page is right** — it is what a customer
     * actually sees.
     *
     * ⚠ **The handle is the only credential, and it names the product.** The page sends a
     * variant id and the session supplies the product, so a page cannot buy something the
     * session was not opened for. It is `read`, not `consume`: a customer may press the button,
     * be refused by the cart, change variant and press again. Only the checkout handle — which
     * places an order — is single-use.
     *
     * ⚠ **There is no `req.bot` here.** This mount carries neither `INTERNAL_SERVICE_TOKEN` nor
     * `BOT_WEBHOOK_SECRET` (a browser can hold neither), so there is no bot caller and no
     * `reply`. The identity comes from the session and the page renders its own words.
     */
    static screenAct = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = ScreenHandleSchema.parse(req.params);
        const { variantId } = ScreenActSchema.parse(req.body ?? {});

        const session = await inAppSurfaceStore.read('pd', handle);
        if (!session) {
            /**
             * ⚠ **404, because that is what the page can act on.** `pd.html` maps 404 and 410
             * onto its own "ask me again in the chat" copy, in the customer's language, and
             * anything else onto a generic failure. One refusal bucket for unknown, lapsed,
             * wrong-owner and wrong-kind alike — they share a remedy, and distinguishing them
             * would confirm that a handle the caller does not own is real.
             *
             * ⚠ The code is shared with a lapsed product LIST rather than given a name of its
             * own. The two are one shape of failure (a held handle has gone), and the listing
             * screen already answers with it; a fourth expiry code would have cost an edit to
             * `core/error-codes.ts`, which another session is editing in this same tree.
             */
            throw createAppError(
                ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
                404,
                'That screen is no longer available',
            );
        }

        const result = await executePurchase({
            userId: session.owner,
            customerId: session.customerId,
            channel: session.channel,
            externalId: session.externalId,
            language: session.language,
            productId: session.productId,
            variantId,
        });

        /**
         * ⚠ **Two of the four rungs cannot finish inside a screen, and the way out is a push.**
         * A Mini App cannot write to the chat — `Telegram.WebApp.sendData()` works only for an
         * app launched from a REPLY keyboard and this one is launched from an inline `web_app`
         * button — so `bargain` and `book` are posted into the conversation by this service,
         * which holds the bot token, and the page closes onto the message.
         */
        if (result.outcome === 'chat') {
            await pushIntoConversation(session.channel, session.externalId, result.message);
        }

        sendSuccess(res, {
            outcome: result.outcome,
            message: result.message,
            ...(result.outcome === 'checkout' ? { url: result.url } : {}),
        });
    });
}

/** The page sends a variant and nothing else — see the class header on why never a verb. */
const ScreenHandleSchema = z.object({ handle: z.string().trim().min(3).max(64) });
const ScreenActSchema = z
    .object({ variantId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'variantId must be an id') })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
//  The verbs this stream owns, as handlers for the tap-code dispatcher
//
//  ⚠ **This file no longer opens the tap door; it answers the verbs routed to it.** The door —
//  parsing the token once and refusing an unknown verb in one place — is
//  `bot-action.controller.ts`. Every handler below receives the token already parsed and must
//  never re-read `req.body.token`, or it could disagree with the dispatcher about what was
//  pressed. See `domain/bot-action-dispatch.ts` for the contract.
// ─────────────────────────────────────────────────────────────────────────────

type PurchaseTapVerb = 'add' | 'buy' | 'bargain' | 'book';

const isPurchaseTapVerb = (verb: string): verb is PurchaseTapVerb =>
    verb === 'add' || verb === 'buy' || verb === 'bargain' || verb === 'book';

/**
 * `add:` · `buy:` · `bargain:` · `book:` — the four rungs.
 *
 * Every one of them carries ids and nothing else, and the rung is re-derived inside
 * `executePurchase` — see the class header. The verb decides only how many ids to read.
 */
async function handlePurchaseTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    /**
     * ⚠ Defensive, and it is what lets the type narrow. The registry only routes these four
     * verbs here, so this is unreachable — unless somebody registers this handler under a fifth,
     * in which case a refusal is the right answer and a crash is not.
     */
    if (!isPurchaseTapVerb(action.verb)) throw unknownBotAction();

    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const envelope = req.bot!.envelope;
    const ids = splitPurchaseToken(action.verb, action.argument);

    const result = await executePurchase({
        userId: caller.userId,
        customerId: caller.customerId,
        channel: envelope.channel,
        externalId: envelope.externalId,
        language,
        productId: ids.productId,
        variantId: ids.variantId,
    });

    setBotReply(req, replyForPurchase(result, language));

    sendSuccess(res, {
        outcome: result.outcome,
        /**
         * ⚠ **The rung the SERVER chose, not the one the button said**, so a model narrating this
         * turn describes what actually happened. A card drawn before a bargaining window opened
         * says `add` and this says `bargain`.
         */
        verb: result.verb,
        productId: result.productId,
        variantId: result.variantId,
        ...(result.outcome === 'checkout' ? { url: result.url } : {}),
    });
}

/**
 * `next:<setId>` — the next five cards IN THE CHAT.
 *
 * ⚠ **Not the same button as `more:`**, though the two ride on one message and share a set id.
 * This one keeps the customer in the conversation; that one hands them a screen.
 */
async function handleNextTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    await respondWithNextCards(req, res, botCallerOf(req).userId, action.argument);
}

/**
 * `more:<setId>` — open the held list as an in-app GRID.
 *
 * ⚠ **It falls back to the next page of chat cards when this deployment has no screen, and that
 * fallback is the path that actually runs today.** `BOT_MINIAPP_BASE_URL` is unset in
 * production, and `more:` buttons are already sitting in live chat histories where they mean
 * "five more cards". Degrading those to a storefront link would take a working control in
 * production and make it worse in order to serve a screen that is dark.
 */
async function handleMoreTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const owner = botCallerOf(req).userId;
    if (await openHeldListing(req, owner, action.argument)) {
        sendSuccess(res, { opened: 'listing' });
        return;
    }
    await respondWithNextCards(req, res, owner, action.argument);
}

/**
 * `cart:view` — the basket.
 *
 * ⚠ **Answered as DATA with no `reply`, deliberately.** § 14.3's rule stands for a cart: one
 * basket is something the model narrates, in the conversation it is already having. Rendering it
 * here would make this file a second renderer of baskets with its own opinion about how to word
 * a total.
 */
async function handleCartTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    /** `cart:view` is the only argument minted. Anything else is not ours to guess at. */
    if (action.argument !== 'view') throw unknownBotAction();

    const cart = await cartService.getCart(botCallerOf(req).customerId);
    setBotReply(req, null);
    sendSuccess(res, cart);
}

/**
 * `open:co` — the Checkout button on an added-to-cart message.
 *
 * ⚠ **Registered under the PAIR `open:co`, not under `open`.** `open` is shared by every stream
 * that draws a screen, so the dispatcher routes it by surface; this stream owns exactly the two
 * surfaces it renders a button for. The token carries no reference — a `co` session is ten minutes
 * and single-use, so the server mints on the tap — which is why the argument must be empty.
 */
async function handleOpenCheckoutTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    if (action.argument !== '') throw unknownBotAction();

    await openCheckout(req, botCallerOf(req), req.bot!.envelope, botResponseLanguageOf(req));
    sendSuccess(res, { opened: 'checkout' });
}

/** `open:pl` — Browse more, on an added-to-cart message. The whole shelf; no reference. */
async function handleOpenListingTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    if (action.argument !== '') throw unknownBotAction();

    await openBrowseListing(req, botCallerOf(req), req.bot!.envelope, botResponseLanguageOf(req));
    sendSuccess(res, { opened: 'listing' });
}

/**
 * The verbs this stream answers, for the dispatcher's registry.
 *
 * ⚠ **Exported as a map rather than registered from here**, so the dispatcher's registry is the
 * one place a reader can see every routed verb. A stream that registered itself would be a
 * stream opening the dispatcher, which is exactly what the split exists to stop.
 */
export const PURCHASE_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    add: handlePurchaseTap,
    buy: handlePurchaseTap,
    bargain: handlePurchaseTap,
    book: handlePurchaseTap,
    next: handleNextTap,
    more: handleMoreTap,
    cart: handleCartTap,
    'open:co': handleOpenCheckoutTap,
    'open:pl': handleOpenListingTap,
});

/**
 * Everything a minted screen session needs to name its owner and its conversation.
 *
 * Separated from `PurchaseContext` below because minting a checkout has nothing to do with a
 * product: `open:co` is a customer asking to pay for what is already in their basket. Passing
 * the fuller shape would have meant inventing a product id at that call site, and an invented
 * value that is never read is the kind of thing somebody later starts reading.
 */
export interface SessionOwner {
    userId: string;
    customerId: string;
    channel: MessagingChannel;
    /** The conversation. A screen's push can be addressed nowhere else. */
    externalId: string;
    language: string | null;
}

/** Who is buying, and what. Both doors supply it; only its source differs. */
export interface PurchaseContext extends SessionOwner {
    productId: string;
    /** Null when the token carried none — a `book:` tap. */
    variantId: string | null;
}

/** What one press resolved to. `url` is populated only for `checkout`. */
export interface PurchaseResult {
    /** The rung the SERVER chose. Never the one the caller named. */
    verb: PurchaseVerb;
    outcome: 'cart' | 'checkout' | 'chat';
    /** Always present, always translated. The page shows it; the chat sends it. */
    message: string;
    url: string | null;
    productId: string;
    variantId: string | null;
    productTitle: string;
}

/**
 * Re-resolve the rung, then do it. **The one place the four rungs are executed.**
 *
 * Deliberately free of presentation: it decides and writes, and never touches a `reply`, a page
 * body or a messaging API. Its callers differ entirely in how they answer, and folding any one's
 * rendering in here is how a chat turn and a screen turn start to disagree about what a button
 * did.
 *
 * ── ⚠ EXPORTED, FOR THREE DOORS — AND WHAT EACH CALLER OWNS ────────────────
 * The chat tap, the Telegram detail screen, and the WhatsApp product-detail form all run THIS.
 * "One read, one set of rules, several renderings" — never a copy of the rules. So:
 *
 *   - **`productId` comes from a SESSION or a TOKEN the service minted, never from a form or page
 *     payload.** The handle names the product; a caller naming only the variant is what stops a
 *     form buying something it was not opened for.
 *   - **Refusals are THROWN, not returned** — an `AppError` for out of stock, the cart's own
 *     rules, a product taken off sale. A caller off the bot surface renders the customer sentence
 *     itself, from `bot-error-copy.ts` by code, so a refusal reads the same in every door.
 *   - **This function NEVER pushes a message.** The Telegram push for `bargain` / `book` belongs to
 *     the Telegram screen door, because only a Mini App cannot write to the chat.
 *   - ⚠ **Idempotency is the CALLER's, and deliberately not a parameter here.** The three doors
 *     retry differently: the chat route already demands an `Idempotency-Key`; the Telegram screen
 *     repeats only on a human double tap; the WhatsApp form's platform retries on its own
 *     schedule. A key here would make all three fabricate one and dedupe the chat path twice. A
 *     caller with an automatic retrier claims before calling (`BotIdempotencyStore`: atomic claim,
 *     success replayed, failure released) — which is as strong as a key inside this function,
 *     since that would take the same Redis claim, just in this file. ⚠ Without that claim, a
 *     retried `add` doubles a basket line, because the cart ADDS rather than sets.
 *   - `url` on a `checkout` result is an in-app SCREEN address and means nothing to a caller that
 *     is not one; such a caller shows `message` and ignores it.
 */
export async function executePurchase(ctx: PurchaseContext): Promise<PurchaseResult> {
    const { customerId, productId, language } = ctx;

    /**
     * ⚠ **Read live, never from a session or a token.** The catalogue read is also the
     * publishability gate: `getProductById` refuses a draft, suspended, deleted or
     * unpublished-vendor product exactly as the storefront does, so a button on a card from
     * last month cannot sell something that has since been taken off sale.
     */
    const product: PublicProductDetailDto = await publicCatalogService.getProductById(productId);

    /**
     * ⚠ **The default variant is the fallback, and it is not a guess.** A `book:` token carries
     * no variant because a booking names a product and a slot; if that product is no longer a
     * service, the rung below needs a cart line, and `defaultVariantId` is precisely the id a
     * chat card would have carried for it.
     */
    const variant =
        (ctx.variantId ? product.variants.find((v) => v.id === ctx.variantId) : undefined)
        ?? product.variants.find((v) => v.id === product.defaultVariantId)
        ?? null;

    const affordance = resolvePurchaseAffordance({
        type: product.type,
        /**
         * ⚠ **Per VARIANT.** A product may sell one variant at a fixed price and another with a
         * window open, so the product cannot answer for the picker — which is the whole reason
         * `PublicVariantDto.negotiable` exists beside the list row's.
         */
        negotiable: variant?.negotiable ?? false,
        inStock: variant?.inStock ?? false,
        variantId: variant?.id ?? null,
    });

    const base = {
        verb: affordance.verb,
        productId,
        variantId: variant?.id ?? null,
        productTitle: product.title,
    };

    /**
     * ⚠ **A disabled affordance is refused HERE rather than rendered.** The chat drops a
     * disabled button and the screen greys it, but neither is a guarantee: a variant can sell
     * out between the drawing and the press, and a card lives in a chat history indefinitely.
     * Letting it through would reach the cart and come back as an error the customer reads as
     * the shop being broken.
     */
    if (!affordance.enabled) {
        throw createAppError(
            ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK,
            422,
            'That item cannot be bought right now',
        );
    }

    switch (affordance.verb) {
        /**
         * ⚠ **`bargain` and `book` WRITE NOTHING**, and that is why they are separate rungs
         * rather than variations on a cart write. A haggle has no agreed price yet and a booking
         * has no slot yet; both are conversations, and the platform's job here is to start one.
         *
         * ⚠ **The message must INVITE A REPLY, and this is the part that is easy to get
         * wrong.** jovi-mall cannot start a bargain. The entire negotiation surface
         * (`/api/internal/negotiation/*`) is the n8n sub-agent calling IN; there is no outbound
         * path to it and nothing here drives a turn. The agent wakes on an INBOUND customer
         * message and on nothing else — so a message that merely announced the haggle would
         * reach the customer, engage nobody, and leave the conversation dead. A question is what
         * produces the reply that actually starts it.
         */
        case 'bargain':
            return {
                ...base,
                outcome: 'chat',
                message: purchaseInvitePrompt(product.title, 'bargain', language),
                url: null,
            };

        case 'book':
            return {
                ...base,
                outcome: 'chat',
                message: purchaseInvitePrompt(product.title, 'book', language),
                url: null,
            };

        /**
         * `add` and `buy` are one cart write and two different next steps.
         *
         * ⚠ **"Buy now" is NOT a one-tap purchase on this platform, and pretending otherwise
         * would be the worst outcome available.** Checkout needs a delivery address and a
         * payment method, and a bot-registered customer routinely has neither — GAP-002 creates
         * the account on their first message and the address step is skippable. A button that
         * placed an order would have to invent one of those or fail at the moment of payment.
         *
         * ⚠ **The SAME `CartService.addToCart` the storefront and `cart_add_item` call.** Every
         * stock rule, price rule, digital cap and mixed-cart rule stays where the storefront
         * already exercises it. No `negotiationLockRef`: a bargained price is bound to a
         * conversation the model is having, and a button is not that conversation.
         */
        case 'add':
        case 'buy': {
            /**
             * ⚠ **The returned cart is KEPT, and it used to be discarded.** It is what lets the
             * checkout session below be stamped with the basket it was opened for, without a
             * second read — this path has just written to that cart, so it holds the freshest
             * answer anybody can get.
             */
            const cart = await cartService.addToCart(customerId, productId, variant!.id, 1);

            if (affordance.verb === 'add') {
                return {
                    ...base,
                    outcome: 'cart',
                    message: botChrome('addedToCart', language),
                    url: null,
                };
            }

            /**
             * A digital line is capped at quantity 1 and at one item per cart, so the basket can
             * only ever hold the one thing — a step, not a basket. Hence straight to checkout,
             * where there is a checkout screen to go to.
             *
             * ⚠ **`inAppScreenUrl` answers null whenever this deployment has no HTTPS in-app
             * origin, which is TRUE IN PRODUCTION TODAY**, so this degradation is the path that
             * runs rather than a rare fallback. It degrades to the cart outcome with checkout
             * NAMED — a turn the model can complete through `checkout_create_orders` — and never
             * to a button with an empty target, which is the one control that costs an order.
             */
            const url = await mintCheckoutUrl(ctx, cart.cartId ?? null);
            return {
                ...base,
                outcome: url ? 'checkout' : 'cart',
                message: botChrome('addedToCartCheckout', language),
                url,
            };
        }
    }
}

/**
 * Split a purchase token's argument into the ids it carries.
 *
 * ⚠ **Refused as a TOKEN rather than as a schema failure**, which is why this is not a Zod
 * object: a malformed token is not something the customer typed, and a validation error naming
 * fields they never sent is a sentence nobody can act on.
 */
function splitPurchaseToken(
    verb: 'add' | 'buy' | 'bargain' | 'book',
    argument: string,
): { productId: string; variantId: string | null } {
    const isId = (value: string | undefined): boolean => /^[0-9a-fA-F]{24}$/.test(value ?? '');
    const [productId, variantId] = argument.split(':');

    /** `book:<productId>` carries one id — a booking names a product and a slot, never a variant. */
    if (verb === 'book') {
        if (!isId(productId)) {
            throw unknownBotAction();
        }
        return { productId: productId!, variantId: null };
    }

    if (!isId(productId) || !isId(variantId)) {
        throw unknownBotAction();
    }
    return { productId: productId!, variantId: variantId! };
}

/**
 * The chat reply for one purchase.
 *
 * ⚠ **This sets the INTENT and takes no view on how many buttons a channel allows.**
 * `channel-reply.ts` composes every channel-ready body in one place, where `WA_MAX_BUTTONS` is
 * 3 and a fourth action is dropped before it ever reaches Meta. A second opinion about
 * WhatsApp's caps here is how two renderers start disagreeing about what a customer saw.
 */
function replyForPurchase(result: PurchaseResult, language: string | null): BotReplyIntent {
    /**
     * ⚠ **`bargain` and `book` carry no actions, deliberately.** The next thing wanted from the
     * customer is a sentence — an offer, or a day and a time — and a button beside that question
     * is an invitation to answer it with a tap that means nothing here.
     */
    if (result.outcome === 'chat') {
        return { kind: 'text', text: result.message };
    }

    /**
     * A digital "Buy now" with a real checkout screen to go to gets a button that OPENS it.
     * `inapp` rather than `link` because a Mini App opens inside the conversation and returns
     * the customer to the thread when it closes.
     */
    if (result.outcome === 'checkout' && result.url) {
        return {
            kind: 'inapp',
            text: result.message,
            label: botChrome('checkoutButton', language),
            url: result.url,
        };
    }

    return {
        kind: 'text',
        text: result.message,
        actions: addedToCartActions(language),
    };
}

/**
 * ⚠ **MOVED to `domain/purchase-chat-copy.ts`** (2026-09-20). Re-exported here only so that the
 * two call sites in other streams' files keep compiling until their owners switch the import;
 * it is a forwarding line and **not** a second definition.
 *
 * It had to move because a controller cannot be imported by a suite on this surface — this file
 * reaches `orders/` and `payments/`, which do work at import under bare `ts-node` and never
 * return — and because the WhatsApp form completion needs the same three buttons the chat tap
 * produces. ⛔ **Do not add a local copy back here**; import the domain module.
 */
export { addedToCartActions } from '../domain/purchase-chat-copy';

/**
 * Mint the checkout screen's session and return its URL, or null when there is no screen.
 *
 * ⚠ **The `cartId` is STAMPED, and it is the checkout screen's own guard that needs it.** Its
 * `place` handler compares the stamp against the live basket and refuses with 410 when they
 * differ. What that catches is narrow and real: `clearCart` DELETES the cart document, so a
 * basket emptied and rebuilt inside the ten-minute window comes back with a NEW id — and
 * without the stamp the customer pays for a basket they never reviewed on that screen.
 *
 * ⚠ **Required, not optional, so a new call site has to DECIDE.** The frozen session type
 * permits null and the screen degrades correctly on one (it skips the comparison), but an
 * optional parameter is how a third minter silently skips a guard it never knew about. This is
 * the same reason `PickupLocationValidationService` takes its depot ids as a required fourth
 * argument rather than an optional one.
 *
 * ⚠ **Coalesced, NEVER asserted, and never guessed.** `CartResponse.cartId` is declared
 * optional and built from `_id?.toString()`. In practice a non-empty basket always carries one
 * — `getCart` returns the bare `{ userId, items: [], totalItems: 0 }` shape only when there is
 * no cart document at all — but a guessed id is far worse than a null here: a null skips a
 * bonus guard, while a wrong one refuses a customer at the moment of payment on a handle that
 * is already spent.
 */
async function mintCheckoutUrl(ctx: SessionOwner, cartId: string | null): Promise<string | null> {
    /**
     * ⚠ **The origin is checked BEFORE minting.** A handle minted for a screen nobody can open
     * is a live order-placing credential sitting in Redis with no way to reach it — not a leak,
     * since nothing ever receives it, but it makes "how many live checkout handles exist" a
     * number that means nothing, which is the number somebody reaches for first in an incident.
     *
     * `inAppBaseUrl()` is the whole question in one call: it reads the variable once, refuses
     * anything that is not HTTPS, and requires an origin the platforms' servers can actually
     * reach. Asking it directly rather than probing `inAppScreenUrl` with a dummy handle keeps
     * the single reader of `BOT_MINIAPP_BASE_URL` that `inapp-url.ts` was extracted to be.
     */
    if (!inAppBaseUrl()) return null;

    const handle = await inAppSurfaceStore.mint({
        kind: 'co',
        owner: ctx.userId,
        customerId: ctx.customerId,
        channel: ctx.channel,
        externalId: ctx.externalId,
        language: ctx.language,
        cartId,
    });
    return inAppScreenUrl('co', handle, ctx.language);
}

/** `open:co` — start a checkout. */
async function openCheckout(
    req: Request,
    caller: { userId: string; customerId: string },
    envelope: { channel: MessagingChannel; externalId: string },
    language: string | null,
): Promise<void> {
    /**
     * ⚠ **One read, and only when there is a screen to open.** Unlike the `buy` path, nothing
     * was just added here — this is Checkout pressed on a basket that already exists — so the
     * cart has to be fetched to stamp it. The origin check is repeated ahead of the read rather
     * than left to `mintCheckoutUrl`, because in production today there IS no screen, and a
     * database read to build a session nobody can open is work done for nothing on every tap.
     */
    const cartId = inAppBaseUrl()
        ? (await cartService.getCart(caller.customerId)).cartId ?? null
        : null;

    const url = await mintCheckoutUrl(
        {
            userId: caller.userId,
            customerId: caller.customerId,
            channel: envelope.channel,
            externalId: envelope.externalId,
            language,
        },
        cartId,
    );

    const text = botChrome('payPrompt', language);
    const label = botChrome('checkoutButton', language);

    if (url) {
        setBotReply(req, { kind: 'inapp', text, label, url });
        return;
    }

    /**
     * ⚠ **No screen means the storefront, and no storefront means NO BUTTON AT ALL.** A `link`
     * intent with an empty target is worse than no control, and this is the one message where a
     * dead button costs an order — the same rule `createPayLink` follows.
     */
    // ⚠ `/shop/cart` — the website has no `/cart` page (deploy-day link check, 2026-09-21).
    const fallback = botStorefrontLink('/shop/cart', language);
    setBotReply(req, fallback ? { kind: 'link', text, label, url: fallback } : null);
}

/** `open:pl` with no reference — browse the whole shelf. */
async function openBrowseListing(
    req: Request,
    caller: { userId: string; customerId: string },
    envelope: { channel: MessagingChannel; externalId: string },
    language: string | null,
): Promise<void> {
    const text = botChrome('browseProductsPrompt', language);
    const label = botChrome('browseMoreButton', language);

    if (inAppBaseUrl()) {
        const handle = await inAppSurfaceStore.mint({
            kind: 'pl',
            owner: caller.userId,
            customerId: caller.customerId,
            channel: envelope.channel,
            externalId: envelope.externalId,
            language,
            query: { q: null, category: null, storeSlug: null, productIds: null },
        });

        const url = inAppScreenUrl('pl', handle, language);
        if (url) {
            setBotReply(req, { kind: 'inapp', text, label, url });
            return;
        }
    }

    const fallback = botStorefrontLink('/shop', language);
    setBotReply(req, fallback ? { kind: 'link', text, label, url: fallback } : null);
}

/**
 * `more:<setId>` — open a HELD list as a grid, if this deployment has a screen.
 *
 * Returns false when it could not, so the caller falls back to chat cards. The set's ids are
 * carried onto the listing session rather than re-running a search: the held set is the model's
 * own selection, and re-searching for "the rest" can return different products at different
 * prices, which reads to a customer as the shop changing its mind.
 */
async function openHeldListing(req: Request, owner: string, setId: string): Promise<boolean> {
    const set = await productDisplayStore.read(owner, setId);
    if (!set) return false;
    if (!inAppBaseUrl()) return false;

    const handle = await inAppSurfaceStore.mint({
        kind: 'pl',
        owner: set.owner,
        customerId: set.customerId,
        channel: set.channel,
        externalId: set.externalId,
        language: set.language,
        query: { q: null, category: null, storeSlug: null, productIds: set.productIds },
    });

    const url = inAppScreenUrl('pl', handle, set.language);
    if (!url) return false;

    setBotReply(req, {
        kind: 'inapp',
        text: botChrome('moreProductsPrompt', set.language),
        label: botChrome('browseAllButton', set.language),
        url,
    });
    return true;
}

/**
 * The next five cards in the chat. Shared by `next:` and by `more:`'s fallback.
 *
 * ⚠ **The display engine belongs to the stream that draws cards** — this reads and calls it and
 * never edits it, which is what keeps one list renderer rather than two.
 */
async function respondWithNextCards(
    req: Request,
    res: Response,
    owner: string,
    setId: string,
): Promise<void> {
    const page = await productDisplayService.next(owner, setId);
    if (!page) {
        throw createAppError(
            ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
            404,
            'That product list is no longer held',
        );
    }

    setBotReply(req, page.intent);
    sendSuccess(res, {
        shown: page.cards.length,
        total: page.total,
        hasMore: page.hasMore,
    });
}

/**
 * Post a message straight into the conversation a screen was opened from.
 *
 * ⚠ **Telegram only, and the WhatsApp gap is stated rather than hidden.** A Mini App is a
 * Telegram control; the WhatsApp half of these two rungs arrives with Flows, and until then a
 * WhatsApp customer reaches Bargain and Book from the chat card, where the reply goes back
 * through the ordinary renderer and needs no push at all.
 *
 * ⚠ **Best-effort, and a failure never fails the request.** `sendMessage` answers false rather
 * than throwing, and the page has already been told what happened — turning a send failure into
 * a 500 would tell a customer their haggle failed when the only thing that failed was the
 * notification about it.
 */
async function pushIntoConversation(
    channel: MessagingChannel,
    externalId: string,
    message: string,
): Promise<void> {
    if (channel !== 'telegram') return;
    await telegramBotService.sendMessage(externalId, message);
}
