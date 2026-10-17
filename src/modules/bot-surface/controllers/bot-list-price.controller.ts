import { Request, Response } from 'express';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CartService } from '../../cart/services/cart.service';
import { publicCatalogService } from '../../catalog/services/public-catalog.service';
import { dealInBasketIntent } from '../../negotiation/domain/deal-in-basket';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { parseListPriceArgument } from '../domain/bot-action-id';
import { BotActionHandlers, ParsedBotAction, unknownBotAction } from '../domain/bot-action-dispatch';
import { listPriceActions } from '../domain/list-price-option';

const cartService = new CartService();

/**
 * ⚠ **Its own file, not a second handler in `bot-negotiation.controller.ts`**, and the reason is a
 * guard rather than taste. `test:negotiation` § 11 refuses any `.addToCart(` in that file, because
 * the `deal:` press must reach the basket only through the shared deal core — a second basket write
 * there is how the press and the spoken close drift apart. This handler writes the basket directly
 * and correctly (there is no deal and no lock), so it lives where that guard does not need an
 * exception.
 */

/**
 * `take:<productId>:<variantId>:<price>` — **Buy at the listed price**, the button under the
 * bargain question (owner, 2026-10-17).
 *
 * ── WHAT IT IS, BESIDE `deal:` ──────────────────────────────────────────────
 * `deal:` accepts a price the AGENT offered and spends a lock minted for it. This accepts the price
 * the SHOP lists, so there is nothing to lock: it is the storefront's own add-to-basket, at the
 * storefront's own price. ⚠ **No `negotiationLockRef`, deliberately** — the cart prices an
 * un-haggled line at the displayed price (the ask, on a bargainable variant), which is exactly the
 * figure on the button.
 *
 * ⚠ **Not `add:`, and that is the whole reason for a verb.** `add:` re-resolves the purchase rung,
 * and on a negotiable variant the rung IS `bargain` — so an `add:` button here would answer the
 * question with the same question. This verb names an outcome the ladder does not have: *skip the
 * haggle*. It still refuses everything the ladder refuses — a sold-out variant, a product gone off
 * sale, a service.
 *
 * ⚠ **The token's price is a CHECK** (`listPriceActionId`). Sold only when the live listed price
 * still equals it; otherwise the customer gets the current price on a fresh button, and pays
 * nothing they were not shown.
 *
 * ⚠ **It closes the haggle for the automation layer**, with the same `negotiation.closed` signal a
 * `deal:` press sends. The customer was routed to the bargainer when they were asked for an offer;
 * having bought, their next line belongs to the main assistant again.
 */
async function handleListPriceTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const ids = parseListPriceArgument(action.argument);
    if (!ids) throw unknownBotAction();

    // Read live — also the publishability gate, as on every purchase door.
    const product = await publicCatalogService.getProductById(ids.productId);
    const variant = product.variants.find((v) => v.id === ids.variantId);

    if (!variant || !variant.inStock || product.type === 'service') {
        throw createAppError(
            ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK,
            422,
            'That item cannot be bought right now',
        );
    }

    if (variant.price !== ids.price) {
        setBotReply(req, {
            kind: 'text',
            text: botChrome('listPriceChangedPrompt', language),
            actions: listPriceActions(
                { productId: ids.productId, variantId: variant.id, amount: variant.price, currency: variant.currency },
                language,
            ),
        });
        sendSuccess(res, {
            outcome: 'price_changed',
            productId: ids.productId,
            variantId: variant.id,
            unitPrice: variant.price,
            currency: variant.currency,
        });
        return;
    }

    /**
     * The SAME `CartService.addToCart` every other door calls — every stock, digital and mixed-cart
     * rule stays where the storefront exercises it. A refusal propagates as the bot surface's own
     * error reply, exactly as an `add:` tap's does.
     */
    await cartService.addToCart(caller.customerId, ids.productId, variant.id, 1);

    // "Deal — it's in your basket at that price." + View basket · Checkout · Keep shopping.
    setBotReply(req, dealInBasketIntent(language));

    sendSuccess(res, {
        outcome: 'cart',
        verb: 'take',
        productId: ids.productId,
        variantId: variant.id,
        /**
         * ⚠ **The flag the automation layer clears the haggle on** — the shape a `deal:` press
         * sends (N8N-DEPLOY-DAY-CHANGES § 8.1: n8n keys on `negotiation.closed === true`). No
         * session id: a listed-price purchase never opened one, and nothing in the automation layer
         * reads it.
         */
        negotiation: {
            closed: true,
            closedBy: 'button',
            sessionId: null,
            productId: ids.productId,
            variantId: variant.id,
            quantity: 1,
            unitPrice: variant.price,
            currency: variant.currency,
        },
    });
}


export const LIST_PRICE_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    take: handleListPriceTap,
});
