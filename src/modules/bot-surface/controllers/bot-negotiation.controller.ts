import { Request, Response } from 'express';
import { sendSuccess } from '../../../core/responses';
import { dealInBasketIntent } from '../../negotiation/domain/deal-in-basket';
import { CART_DEAL_BASKET, placeDealInBasket } from '../../negotiation/services/deal-basket.service';
import { negotiationService } from '../../negotiation/services/negotiation.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { BotReplyOption } from '../domain/channel-reply';
import { bargainActionId, lockInOfferActionId } from '../domain/bot-action-id';
import { BotActionHandlers, ParsedBotAction, unknownBotAction } from '../domain/bot-action-dispatch';
import { formatBotPrice } from '../domain/product-card';

/**
 * **Lock it in** — the customer closing a haggle by pressing the price they were offered.
 *
 * ── ⚠ WHAT THIS CHANGED, AND WHAT IT DID NOT ────────────────────────────────
 * The rule was "only the model closes a deal", and it is now "**the model, or an explicit priced
 * button — never inferred from free text**" (owner, 2026-09-16). The distinction is the whole
 * safety argument: the backend still refuses to read a customer's "ok" as acceptance, because words
 * are ambiguous in five languages and a price is money. A press on a button that says *Lock it in ·
 * 18 000 XAF* is not an inference; it is the customer choosing the one thing the button says.
 *
 * ── ⛔ THE TOKEN CARRIES A REFERENCE, NEVER A PRICE ──────────────────────────
 * `deal:<sessionId>:<round>`. The price comes from the negotiation session's own record of that
 * round and is re-judged against the vendor's live window at the moment of the press. A token
 * carrying a figure would let anyone who can post a callback lock any figure they like.
 *
 * ── THE TWO HALVES, AND WHY THEY ARE IN DIFFERENT MODULES ───────────────────
 * `negotiation` decides and mints the lock — every branch of that is a pure rule with a
 * compare-and-set behind it, tested without a database. This file does what the surface always
 * does with a lock: spends it into the basket and says something. It holds no policy at all, which
 * is why a refusal here is a sentence and a button rather than a decision.
 *
 * ⚠ **A cart add that presents a lock SETS the quantity rather than incrementing it**, which is
 * what makes a double tap harmless end to end: the first press mints the lock, the second finds it
 * and spends the same one, and the basket holds one line at one price either way.
 */
/**
 * ⚠ **This file exports handlers and no controller class, unlike every other file here.** There is
 * no route to add: a press arrives at the one tap door (`POST /catalog/action`) and is routed by
 * verb, and the model has no business closing a deal through a tool — that is the gate's job. A
 * class with no routes would be a mount waiting to be invented.
 */

/**
 * `deal:<sessionId>:<round>` — accept that round's offer.
 *
 * ⚠ **Never silence, on any branch.** A button lives in a chat history indefinitely, so every way
 * this can fail — the agent has since moved the price, the offer lapsed, the vendor's window moved,
 * the deal was already ordered — is an ordinary event that gets its own sentence and, where there
 * is one, the right next button. The one thing a customer must never get is a tap that does
 * nothing, because Telegram reports no error for an unhandled callback.
 */
async function handleLockInTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const [sessionId, rawRound] = action.argument.split(':');
    const round = Number(rawRound);
    if (!sessionId || !Number.isInteger(round)) throw unknownBotAction();

    const outcome = await negotiationService.acceptOffer({
        customerId: caller.customerId,
        sessionId,
        round,
    });

    switch (outcome.kind) {
        case 'locked': {
            /**
             * ⭐ **The ONE core both closers use** (`negotiation/services/deal-basket.service.ts`):
             * a deal the agent agreed in words goes through exactly this call from the gate, so the
             * press and the spoken close end in the same basket state (owner, 2026-09-22).
             *
             * It is the SAME `CartService.addToCart` every other door calls, with the lock
             * presented. Every stock, digital and mixed-cart rule stays where the storefront already
             * exercises it, and the cart re-validates the lock itself (a `peek`) — so a lock that
             * lapsed between the press and this line is refused by the one rule that also governs
             * checkout, not by a second opinion here.
             *
             * ⚠ **A refusal is RETHROWN unchanged**, so the customer still reads the bot surface's
             * own error reply for it, exactly as before the core was shared. The gate cannot do
             * that (its deal is already agreed and it must answer `approved`), which is why the
             * core returns the error rather than throwing it.
             */
            const basket = await placeDealInBasket(CART_DEAL_BASKET, {
                customerId: caller.customerId,
                productId: outcome.productId,
                variantId: outcome.variantId,
                quantity: outcome.quantity,
                currency: outcome.currency,
                lockRef: outcome.lockRef,
            });
            if (!basket.placed) throw basket.error;

            /**
             * The press's message and the same three controls as any other add — View cart ·
             * Checkout · Browse more. Built by the domain module the spoken close renders too; with
             * no lead it is the press's reply exactly.
             */
            setBotReply(req, dealInBasketIntent(language));

            sendSuccess(res, {
                outcome: 'deal_locked',
                /**
                 * ⚠ **The signal the automation layer keys on.** A press closes a deal that n8n
                 * cannot see — it never read a message — so its bargaining flag and its held lock
                 * reference must be cleared on this, or the customer's next typed line reaches the
                 * bargainer as though the haggle were still open. `closed` is the flag;
                 * `closedBy` distinguishes this from the model's own close.
                 *
                 * ⚠ **The lock's handle is deliberately absent.** It is a bearer credential for a
                 * price, it has already been spent into this basket, and nothing in the automation
                 * layer has any use for one.
                 */
                negotiation: {
                    closed: true,
                    closedBy: 'button',
                    sessionId: outcome.sessionId,
                    productId: outcome.productId,
                    variantId: outcome.variantId,
                    quantity: outcome.quantity,
                    unitPrice: outcome.unitPrice,
                    currency: outcome.currency,
                },
            });
            return;
        }

        /**
         * The agent replaced the offer between the button being drawn and pressed — including the
         * case where it replaced it by closing the deal itself. The customer gets the CURRENT
         * offer with its own button, so the next press is on a price that actually stands.
         */
        case 'superseded':
            setBotReply(req, {
                kind: 'text',
                text: botChrome('dealSupersededPrompt', language),
                actions: [lockInOption(outcome.sessionId, outcome.latestRound, outcome.latestPrice, outcome.currency, language)],
            });
            sendSuccess(res, {
                outcome: 'superseded',
                sessionId: outcome.sessionId,
                round: outcome.latestRound,
                unitPrice: outcome.latestPrice,
            });
            return;

        /**
         * ⛔ **An expired deal must never read as though it never happened.** Both sentences name
         * what lapsed and offer to talk about it again; neither is a fresh "would you like to
         * haggle?", which is what a customer reads as the platform forgetting their agreement.
         */
        case 'expired':
        case 'price_changed':
            setBotReply(req, {
                kind: 'text',
                text: botChrome(
                    outcome.kind === 'expired' ? 'bargainLockExpiredPrompt' : 'bargainPriceChangedPrompt',
                    language,
                ),
                actions: [bargainAgainOption(outcome.productId, outcome.variantId, language)],
            });
            sendSuccess(res, { outcome: outcome.kind, productId: outcome.productId });
            return;

        /**
         * The lock was spent by an order. ⚠ **No button at all here, deliberately**: every control
         * this surface could offer would invite the customer to buy again something they have
         * already bought, which is the one outcome worse than a dead end.
         */
        case 'already_ordered':
            setBotReply(req, { kind: 'text', text: botChrome('dealAlreadyOrderedPrompt', language) });
            sendSuccess(res, { outcome: 'already_ordered', productId: outcome.productId });
            return;

        case 'unavailable':
            setBotReply(req, {
                kind: 'text',
                text: botChrome('dealUnavailablePrompt', language),
                /**
                 * Bargain again is offered only when the session named a product. When nothing
                 * could be resolved at all — an unknown id, or somebody else's session — there is
                 * no variant to re-open a haggle on, and inventing one would send the customer to
                 * negotiate over a product this tap never identified.
                 */
                ...(outcome.productId && outcome.variantId
                    ? { actions: [bargainAgainOption(outcome.productId, outcome.variantId, language)] }
                    : {}),
            });
            sendSuccess(res, { outcome: 'unavailable' });
            return;
    }
}

/**
 * The **Lock it in** button, with the price ON it.
 *
 * ⚠ **The label carries the figure and the WhatsApp short label carries it alone.** A customer must
 * be able to see what they are agreeing to at the moment they agree — that is what makes a press an
 * acceptance rather than an inference — and WhatsApp's reply-button title is 20 characters, which
 * "Lock it in · 999 999 999 XAF" does not fit. `✓ <price>` does, up to a nine-digit amount, and
 * Telegram draws the full label beside it.
 */
function lockInOption(
    sessionId: string,
    round: number,
    unitPrice: number,
    currency: string,
    language: string | null,
): BotReplyOption {
    const price = formatBotPrice(unitPrice, currency);
    return {
        id: lockInOfferActionId(sessionId, round),
        label: `${botChrome('lockItInButton', language)} · ${price}`,
        shortLabel: `✓ ${price}`,
    };
}

/**
 * **Bargain again** — the existing purchase-ladder rung, reused rather than reinvented.
 *
 * ⚠ **It posts a QUESTION into the chat and writes nothing**, because jovi-mall cannot start a
 * bargain: the agent lives in n8n and wakes on the customer's next inbound message. A button that
 * announced a re-opened haggle and waited would wait forever.
 */
function bargainAgainOption(productId: string, variantId: string, language: string | null): BotReplyOption {
    return {
        id: bargainActionId(productId, variantId),
        label: botChrome('bargainAgainButton', language),
    };
}

export const BARGAIN_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    deal: handleLockInTap,
});
