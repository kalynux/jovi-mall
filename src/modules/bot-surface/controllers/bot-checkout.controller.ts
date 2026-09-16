import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CartService } from '../../cart/services/cart.service';
import { CustomerModel, ICustomer } from '../../customers/customer.model';
import { PaymentTransactionModel, IPaymentTransaction } from '../../payments/models/payment-transaction.model';
import { PaymentOrchestratorService } from '../../payments';
import { notchPayEnabled, myCoolPayEnabled } from '../../payments/config/payments.config';
import { PaymentGatewayType } from '../../payments/models/payment-transaction.model';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { botStorefrontLink } from '../domain/bot-list-window';
import { formatBotPrice } from '../domain/product-card';
import { inAppBaseUrl, inAppScreenUrl } from '../domain/inapp-url';
import { inAppSurfaceStore } from '../services/inapp-surface.store';
import { storedPayerNumber } from '../miniapp/surfaces/checkout.controller';

/**
 * The chat half of checkout — the door onto the screen, and the payment's answer afterwards.
 *
 * ── THREE TURNS, AND THEY ARE THE THREE THE SCREEN CANNOT DO ────────────────
 * `miniapp/surfaces/checkout.controller.ts` is the screen: it reads the basket, places the
 * orders and opens the charge. It cannot do any of these, because by the time they matter the
 * page is gone:
 *
 *   `POST /checkout/screen`          mint the `co` session and hand back the button that opens it
 *   `POST /checkout/payment-status`  ask the gateway where the charge actually got to
 *   `POST /checkout/retry-payment`   open a fresh charge for the same orders
 *
 * ── ⚠ THE PAYMENT'S RESULT ARRIVES IN THE CHAT, AND NOT THROUGH THIS FILE ───
 * Neither a Mini App nor a WhatsApp Flow can hold a session open while somebody approves a
 * mobile-money push on their handset — the approval happens minutes later, on a device that is
 * not the browser. So the screen promises the answer in the thread and closes, and what
 * actually delivers it is the **customer notification catalogue**: `order.payment.received` on
 * success and `order.payment_failed` on failure, pushed into the same conversation.
 *
 * The two routes below are what the customer can then DO about it: ask where it got to, and
 * ask again. Both exist because a push tells somebody something and gives them nothing to act
 * on — which is the shape of every other dead end this surface has been closing.
 *
 * ── ⚠ NONE OF THE THREE MONEY READS SETS A SENTENCE, AND THAT IS THE RULE ───
 * `channel-reply.ts` states it: a turn whose wording is fixed — a prompt, a picker, a payment
 * button — carries a `reply`; a record is DATA for the model to narrate. A payment status is a
 * record. Writing "your payment went through" here would put a second, untranslatable opinion
 * beside the notification catalogue's own copy for the same event, in a different table, and
 * the customer would eventually be told both.
 *
 * The one exception is the screen door, which IS a fixed-wording turn: it renders a control.
 */

/** No arguments — every one of these is scoped to the caller's own basket and payments. */
const NoArgsSchema = z.object({}).strict();

const cartService = new CartService();
const paymentOrchestrator = new PaymentOrchestratorService();

export class BotCheckoutController {
    /**
     * `POST /checkout/screen` — open the checkout screen.
     *
     * ⚠ **This mints a credential and places no order.** The `co` handle it produces is the
     * largest one on this surface — it authorises placing an order against a saved address and
     * starting a payment — which is why the route is `mutating` in the route table despite
     * writing no business record, and why a retried chat message must collapse onto ONE handle
     * rather than leaving a trail of live ones. The `Idempotency-Key` is what does that.
     *
     * ⚠ **It refuses an empty basket rather than opening a screen that can only fail.** The
     * refusal happens HERE, in the chat, because this is where a sentence can be written in the
     * customer's own language — the screen's equivalent state can only render page copy.
     *
     * ⚠ **It does NOT check for a delivery address, deliberately.** "No saved address" is a
     * real state on the screen with a real instruction (`checkoutNoAddress`), and refusing here
     * would replace a page that shows the customer what they were about to buy with a chat
     * refusal that shows them nothing. A digital basket needs no address at all, so a check
     * here would also have to know the basket's type to avoid being wrong half the time.
     *
     * ⚠ **Cash on delivery does not come through this screen.** It takes no payment, produces a
     * delivery code per shipment, and is refused outright by `initiatePaymentForCart` — so a
     * COD checkout stays on `checkout_create_orders`, where the method is named explicitly.
     */
    static screen = asyncHandler(async (req: Request, res: Response) => {
        NoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);
        const language = botResponseLanguageOf(req);

        const cart = await cartService.getCart(caller.customerId);
        if (cart.items.length === 0 || !cart.cartId) {
            throw createAppError(
                ERROR_CODES.CART_EMPTY_CHECKOUT,
                400,
                'There is nothing in the basket to check out',
            );
        }

        const text = botChrome('browseProductsPrompt', language);
        const label = botChrome('checkoutButton', language);

        /**
         * ⚠ **THE ORIGIN IS CHECKED BEFORE ANYTHING IS MINTED, and for `co` that ordering is
         * the decision rather than a micro-optimisation.**
         *
         * The other in-app doors mint first and discover afterwards that there is nowhere to
         * send the customer, which for a listing handle is harmless. This handle can place an
         * order and start a payment. `BOT_MINIAPP_BASE_URL` is **unset in production**, so
         * minting first would mean every single checkout turn creating a ten-minute
         * order-placing credential that is handed to nobody and reachable by no one.
         *
         * That is not a leak — nothing receives it and it expires — and it is still worth
         * refusing, for a reason backend-89 put better than the wasted work: **"how many live
         * checkout handles exist" stops meaning anything**, and that is the number somebody
         * reaches for the first time this surface has an incident.
         *
         * ⚠ **`inAppBaseUrl()`, never a second read of the variable.** `inapp-url.ts` was
         * extracted to be its single reader and it holds BOTH rules that decide the answer —
         * HTTPS (Telegram refuses a `web_app` button on any other scheme, and refuses the whole
         * message with it) and publicly reachable (a Tailscale or loopback origin opens for
         * nobody but the developer who set it). A local `process.env` check here would pass on
         * an origin the renderer then rejects. Stream C calls the same function from its own
         * two minting paths, which is what keeps the two doors agreeing.
         */
        if (!inAppBaseUrl()) {
            const fallback = botStorefrontLink('/cart', language);
            /**
             * ⚠ **Never a dead button.** With no storefront either, the reply is cleared and
             * the model answers in its own words — the rule `/payments/:id/pay-link` already
             * follows, because a control with an empty target is worse than no control.
             */
            setBotReply(req, fallback ? { kind: 'link', text, label, url: fallback } : null);
            sendSuccess(res, { handle: null, opened: 'storefront', itemCount: cart.totalItems });
            return;
        }

        /**
         * ⚠ **`cartId` is recorded so the screen can tell "this basket" from "a basket".**
         * `clearCart` deletes the document, so a basket emptied and rebuilt gets a new id — and
         * the screen refuses rather than charging for a basket the customer never reviewed. No
         * prices and no lines are stored beside it; the screen reads those live on every open.
         */
        const handle = await inAppSurfaceStore.mint({
            kind: 'co',
            owner: caller.userId,
            customerId: caller.customerId,
            channel: req.bot!.envelope.channel,
            externalId: req.bot!.envelope.externalId,
            language,
            cartId: cart.cartId,
        });

        /**
         * ⚠ **Still checked, and not redundantly.** `inAppBaseUrl` answered above, so this can
         * only be null if the environment changed between the two calls — but the alternative
         * is composing the URL by hand from a base this file would then have to know the shape
         * of, which is the second reader the guard above exists to avoid.
         */
        const screenUrl = inAppScreenUrl('co', handle, language);
        if (!screenUrl) {
            const fallback = botStorefrontLink('/cart', language);
            setBotReply(req, fallback ? { kind: 'link', text, label, url: fallback } : null);
            sendSuccess(res, { handle: null, opened: 'storefront', itemCount: cart.totalItems });
            return;
        }

        setBotReply(req, { kind: 'inapp', text, label, url: screenUrl });
        sendSuccess(res, { handle, opened: 'checkout', itemCount: cart.totalItems });
    });

    /**
     * `POST /checkout/payment-status` — where did the charge actually get to?
     *
     * ── WHY THIS IS NOT `payment_get_transaction` ───────────────────────────
     * That tool reads the stored record. This one **asks the gateway**, which is the difference
     * that matters at the only moment a customer asks the question: a mobile-money confirmation
     * reaches us by webhook, and a webhook that has not arrived leaves the record saying
     * `PENDING` for a payment the customer approved two minutes ago. `verifyPayment` is what
     * the reconciliation sweep uses to close exactly that gap — this route just lets a customer
     * trigger it instead of waiting ten minutes for the cron.
     *
     * ⚠ **It also needs no transaction id, and that is deliberate.** The id never reaches the
     * chat: the screen's `place` answers a browser, and the browser closes. A model asked for
     * one would invent it. So the caller's own most recent checkout payment is the answer,
     * resolved here.
     *
     * ⚠ **Owner-scoped, and repeated rather than inherited**, for the reason
     * `BotCartController.getTransaction` states: a bot request is not a session, so there is no
     * `req.auth` for the customer route's predicate to read.
     */
    static paymentStatus = asyncHandler(async (req: Request, res: Response) => {
        NoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const transaction = await latestCheckoutPayment(caller.customerId);

        /**
         * ⚠ **A terminal transaction is NOT re-verified.** `verifyPayment` returns early on one
         * anyway, but asking is a gateway call per impatient customer for an answer that cannot
         * change. Settled is settled.
         */
        const verified = isTerminal(transaction.status)
            ? { status: transaction.status }
            : await paymentOrchestrator.verifyPayment(transaction._id.toString());

        sendSuccess(res, toPaymentReport(transaction, verified.status));
    });

    /**
     * `POST /checkout/retry-payment` — open a fresh charge for orders that are still unpaid.
     *
     * ⚠ **It re-opens a CHARGE; it does not re-place an ORDER.** The orders from the failed
     * attempt still exist and are still awaiting payment — which is the whole reason
     * `order.payment_failed`'s copy says the items are still waiting and must never read as a
     * cancellation. Placing a second set would double the basket and double the stock hold.
     *
     * ⚠ **`initiatePaymentForCart` is what makes a retry safe, and none of it is reimplemented
     * here.** It answers with the LIVE attempt when one is still open (so an impatient customer
     * gets the prompt already on their phone rather than a second one), releases a genuinely
     * dead attempt before opening a new one, and refuses a group that is already paid. Every
     * one of those is a money invariant and belongs where the storefront exercises it too.
     *
     * ⚠ **A typed number overrides the account's, exactly as on the screen** — a customer whose
     * first attempt failed because the prompt went to the wrong handset has no other way to say
     * so. The fallback is `storedPayerNumber`, imported rather than re-derived, so the chat and
     * the screen cannot disagree about which wallet is charged.
     */
    static retryPayment = asyncHandler(async (req: Request, res: Response) => {
        const { phone } = RetrySchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const transaction = await latestCheckoutPayment(caller.customerId);
        const cartId = transaction.cartId?.toString();
        if (!cartId) {
            throw createAppError(
                ERROR_CODES.PAYMENT_CART_NOT_FOUND,
                422,
                'That payment was not for a checkout basket',
            );
        }

        const customer = await loadCustomer(caller.customerId);
        const payerNumber = phone ?? (await storedPayerNumber(customer));
        if (!payerNumber) {
            throw createAppError(
                ERROR_CODES.PAYMENT_REFERENCE_REQUIRED,
                422,
                'A mobile money number is needed to take this payment',
            );
        }

        const payment = await paymentOrchestrator.initiatePaymentForCart(
            cartId,
            mobileMoneyGateway(),
            { phoneNumber: payerNumber, customerName: customer.name },
        );

        sendSuccess(res, {
            transactionId: payment.transactionId,
            state: stateOf(payment.status),
            /**
             * ⚠ **Relayed verbatim and NOT translated, because it is the operator's word for
             * what the gateway did.** `instructions` carries the USSD code and the "confirm the
             * prompt on your phone" line the provider itself supplies, and it is the one thing
             * in this response the customer genuinely has to act on. The model narrates it.
             */
            instructions: payment.instructions ?? null,
        });
    });
}

/** A retry may name the wallet to charge. Absent means "the one on my account". */
const RetrySchema = z
    .object({ phone: z.string().trim().min(6).max(20).nullable().default(null) })
    .strict();

/**
 * The caller's most recent checkout-group payment.
 *
 * ⚠ **`userId` holds the CUSTOMER id for an order or cart payment**, and the USER id only for a
 * booking one — the asymmetry `BotCartController.getTransaction` documents and accepts both
 * sides of. This query is cart-scoped, so only the customer id can ever match, and narrowing it
 * to that is what keeps one customer's "check my payment" from ever reaching another's record.
 *
 * ⚠ **404 rather than an empty answer**, because "you have no payment" and "I could not find
 * yours" are the same sentence to a customer and only one of them is a state the model should
 * narrate as news.
 */
async function latestCheckoutPayment(customerId: string): Promise<IPaymentTransaction> {
    const transaction = await PaymentTransactionModel.findOne({
        userId: customerId,
        cartId: { $ne: null },
    })
        .select('-rawGatewayPayloads')
        .sort({ createdAt: -1 })
        .exec();

    if (!transaction) {
        throw createAppError(
            ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND,
            404,
            'There is no recent checkout payment on this account',
        );
    }
    return transaction;
}

async function loadCustomer(customerId: string): Promise<ICustomer> {
    const customer = await CustomerModel.findById(customerId)
        .select('name phone')
        .lean<ICustomer>()
        .exec();
    if (!customer) {
        throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404, 'Customer not found');
    }
    return customer;
}

/**
 * The gateway's status, reduced to the three things a customer's next move depends on.
 *
 * ⚠ **`CANCELLED` is reported as `failed`, and that is a decision rather than a shortcut.** To
 * the platform they are different — one was refused, one was abandoned — but to the person
 * holding the phone both mean *the money did not move and the items are still waiting*, and
 * both are fixed by the same action. Splitting them would give the model a distinction it can
 * only narrate as blame.
 *
 * ⚠ **`REFUNDED` is `settled`, not `failed`.** The payment DID go through; what happened
 * afterwards is a refund, and it belongs to the order's own story rather than to this one.
 */
function stateOf(status: string): 'settled' | 'failed' | 'waiting' {
    if (status === 'SUCCEEDED' || status === 'REFUNDED') return 'settled';
    if (status === 'FAILED' || status === 'CANCELLED') return 'failed';
    return 'waiting';
}

function isTerminal(status: string): boolean {
    return stateOf(status) !== 'waiting';
}

/**
 * One payment, as a chat can talk about it.
 *
 * ⚠ **`amountText` is formatted here and the model is given no raw number to format itself.**
 * Every price this surface prints goes through `formatBotPrice` — deliberately not
 * `Intl.NumberFormat`, whose XAF grouping character differs between Node builds and between
 * languages. A second format in a payment message is how one customer sees `20 000 XAF` on
 * their order and `XAF 20,000` on the receipt for it.
 */
function toPaymentReport(
    transaction: IPaymentTransaction,
    status: string,
): {
    transactionId: string;
    state: 'settled' | 'failed' | 'waiting';
    amountText: string;
    orderCount: number;
} {
    return {
        transactionId: transaction._id.toString(),
        state: stateOf(status),
        amountText: formatBotPrice(transaction.amountSnapshot, transaction.currencySnapshot),
        orderCount: transaction.orderIds?.length ?? 0,
    };
}

/**
 * Which mobile-money gateway a retry charges through.
 *
 * ⚠ **The same preference the screen applies, and it must stay the same.** NotchPay first
 * because it is the gateway an administrator can refund through; My-CoolPay has no refund API
 * at all. A retry that silently moved a customer to the other provider would mean two charges
 * for one basket with different reversibility, decided by which door they came through.
 *
 * ⚠ It is **not** copied from the screen's helper by accident — that one throws inside a
 * browser request and this one inside a chat turn, and the two mounts word a refusal
 * differently. The rule they share is the ORDER, which is one line and is stated in both.
 */
function mobileMoneyGateway(): PaymentGatewayType {
    if (notchPayEnabled()) return 'NOTCHPAY';
    if (myCoolPayEnabled()) return 'MYCOOLPAY';
    throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED,
        503,
        'No mobile money gateway is configured on this deployment',
    );
}
