import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CartService } from '../../cart/services/cart.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { parseBotActionId } from '../domain/bot-action-id';
import { productDisplayService } from '../services/product-display.service';
import { BotDisplayActionSchema, BotProductDisplaySchema } from '../validators/bot.validators';

const cartService = new CartService();

/**
 * Drawing products, and answering the buttons underneath them.
 *
 * ── WHY THIS IS THE FIRST PRODUCT TURN THAT CARRIES A `reply` ───────────────
 * `bot-surface.md` § 14.3 has always ended *"a product … is data for your model to narrate,
 * and deliberately carries no `reply`"*, and that sentence was right about **a** product and
 * wrong about a **list**. Narrating a list is what produced the behaviour this feature was
 * reported for: five products as a numbered markdown list, no pictures, no prices anybody can
 * tap, no way to buy. The model was doing exactly what it was asked; there was nothing else
 * it could do.
 *
 * So the rule is now narrower rather than reversed. One product, a cart, an order, a support
 * context — still data, still narrated. A **set the customer is meant to choose from** is a
 * rendering, and a rendering belongs on this side of the wire for the same reason every other
 * one does: the automation layer has no copy table, no translator and no reason to know that
 * a WhatsApp carousel is a pre-approved marketing template with a fixed card count.
 *
 * ── THE MODEL ASKS FOR A DRAWING, NOT FOR A CHANNEL ─────────────────────────
 * `catalog_show_products` takes ids and answers with a count. Whether that became a Mini App
 * button, a carousel or five image cards is not in the response, deliberately: it is a fact
 * about this deployment's configuration and this picture's reachability, both of which change
 * without the model being told. Handing it back would invite a sentence about the interface
 * ("tap the carousel below") that is wrong on the other channel.
 */
export class BotProductDisplayController {
    /**
     * `POST /catalog/display` — draw these products.
     *
     * ⚠ **Classified `mutating`, and the reason is the Mini App handle rather than the
     * drawing.** Nothing about a customer changes here; but each call mints a URL handle that
     * grants a browser the right to write to their basket, and a retried chat message that
     * minted a second one would leave the first live with nothing having asked for it. The
     * `Idempotency-Key` the surface demands is what collapses the retry onto one handle.
     */
    static show = asyncHandler(async (req: Request, res: Response) => {
        const { productIds } = BotProductDisplaySchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const page = await productDisplayService.create({
            productIds,
            owner: caller.userId,
            customerId: caller.customerId,
            channel: req.bot!.envelope.channel,
            externalId: req.bot!.envelope.externalId,
            language: botResponseLanguageOf(req),
        });

        setBotReply(req, page.intent);

        /**
         * ⚠ **`shown` may be lower than what was asked for, and that is not an error.** A
         * product the model saw in a search a moment ago can have been suspended, unpublished
         * or archived since; those ids are dropped rather than refused. The model is told the
         * real number so it does not write "here are five" over four cards.
         */
        sendSuccess(res, {
            shown: page.cards.length,
            total: page.total,
            hasMore: page.hasMore,
        });
    });

    /**
     * `POST /catalog/action` — the customer pressed something.
     *
     * Every button this surface draws under a product comes back here, on both channels:
     * Telegram as `callback_query.data`, WhatsApp as `interactive.button_reply.id`. The
     * automation layer forwards the token and transforms nothing, which is the whole point of
     * the `<verb>:<argument>` vocabulary.
     */
    static action = asyncHandler(async (req: Request, res: Response) => {
        const { token } = BotDisplayActionSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);
        const language = botResponseLanguageOf(req);

        const parsed = parseBotActionId(token);

        /**
         * ⚠ **An unknown token is a REFUSAL WITH A SENTENCE, never a 500 and never silence.**
         * A button sits in a chat history for as long as the conversation does, so a customer
         * tapping one whose verb a deploy has retired is an ordinary event. Telegram reports
         * nothing at all for an unhandled callback — the tap simply does nothing, forever —
         * which is why the refusal has to produce a message rather than a log line.
         */
        if (!parsed || (parsed.verb !== 'add' && parsed.verb !== 'buy' && parsed.verb !== 'more')) {
            throw createAppError(
                ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN,
                422,
                'Unrecognised action token',
            );
        }

        if (parsed.verb === 'more') {
            const page = await productDisplayService.next(caller.userId, parsed.argument);
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
            return;
        }

        /**
         * `add:<productId>:<variantId>` and `buy:<productId>:<variantId>`.
         *
         * The split is deliberate rather than a validator: both halves are 24-character
         * ObjectIds and a malformed token must be refused as a *token*, with the sentence
         * above, rather than as a Zod failure describing fields the customer never sent.
         */
        const [productId, variantId] = parsed.argument.split(':');
        if (!/^[0-9a-fA-F]{24}$/.test(productId ?? '') || !/^[0-9a-fA-F]{24}$/.test(variantId ?? '')) {
            throw createAppError(
                ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN,
                422,
                'Malformed action token',
            );
        }

        /**
         * ⚠ **The SAME `CartService.addToCart` the storefront and `cart_add_item` call**, with
         * the same customer id. Every stock rule, price rule and mixed-cart rule stays where
         * the storefront already exercises it — a button must not become a second door onto a
         * basket that behaves differently from the first.
         *
         * No `negotiationLockRef`: a bargained price is bound to a conversation the model is
         * having, and a card button is not that conversation.
         */
        await cartService.addToCart(caller.customerId, productId, variantId, 1);

        /**
         * ⚠ **"Buy now" is NOT a one-tap purchase on this platform, and pretending otherwise
         * would be the worst outcome available.** Checkout needs a delivery address and a
         * payment method, and a bot-registered customer routinely has neither — GAP-002
         * creates the account on their first message and the address step is skippable. A
         * button that placed an order would have to invent one of those or fail at the moment
         * of payment.
         *
         * So both verbs add the item, and they differ in what the customer is told next: `add`
         * is silent shopping, `buy` hands them back to the model with checkout named, which is
         * a turn the model can actually complete (`checkout_create_orders`).
         */
        setBotReply(req, {
            kind: 'text',
            text: botChrome(parsed.verb === 'buy' ? 'addedToCartCheckout' : 'addedToCart', language),
        });

        sendSuccess(res, { added: true, productId, variantId, quantity: 1 });
    });
}
