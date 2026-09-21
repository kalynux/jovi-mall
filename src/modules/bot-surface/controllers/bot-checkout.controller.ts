import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { OptionalPhoneNumberSchema } from '../../../core/validation/phone';
import { CartService } from '../../cart/services/cart.service';
import { CustomerModel, ICustomer } from '../../customers/customer.model';
import { PaymentTransactionModel, IPaymentTransaction } from '../../payments/models/payment-transaction.model';
import { PaymentOrchestratorService } from '../../payments';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { BotActionHandlers, ParsedBotAction, unknownBotAction } from '../domain/bot-action-dispatch';
import { botStorefrontLink } from '../domain/bot-list-window';
import { formatBotPrice } from '../domain/product-card';
import { inAppBaseUrl, inAppScreenUrl } from '../domain/inapp-url';
import { inAppSurfaceStore } from '../services/inapp-surface.store';
import { mobileMoneyGateway, storedPayerNumber } from '../miniapp/surfaces/checkout.controller';

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
            // ⚠ `/shop/cart`, not `/cart`: the website has no `/cart` page (404 in every language),
            // found by the deploy-day link check (2026-09-21). `verify:landing-routes` checks
            // `SURFACE_PATHS` only, so a fallback path is checked by nothing — keep it a real route.
            const fallback = botStorefrontLink('/shop/cart', language);
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
            const fallback = botStorefrontLink('/shop/cart', language);
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
     * ⚠ **The ROUTE takes no transaction id, and that is deliberate — do not "fix" it by adding
     * the parameter.** The id never reaches the chat as text: the screen's `place` answers a
     * browser, and the browser closes. A model asked for an id it has never seen will invent
     * one. So the caller's own most recent checkout payment is the answer. The TAP
     * (`pay:st:<id>`) is different and does carry one; see `paymentTap` for why that is not a
     * contradiction.
     *
     * ⚠ **Owner-scoped, and repeated rather than inherited**, for the reason
     * `BotCartController.getTransaction` states: a bot request is not a session, so there is no
     * `req.auth` for the customer route's predicate to read.
     */
    static paymentStatus = asyncHandler(async (req: Request, res: Response) => {
        NoArgsSchema.parse(req.body ?? {});
        await reportPayment(req, res, null);
    });

    /**
     * `POST /checkout/retry-payment` — open a fresh charge for orders that are still unpaid.
     *
     * ⚠ **It re-opens a CHARGE; it does not re-place an ORDER.** The orders from the failed
     * attempt still exist and are still awaiting payment — which is the whole reason
     * `order.payment_failed`'s copy says the items are still waiting and must never read as a
     * cancellation. It also CANNOT re-place one: `createOrdersFromCart` clears the basket as it
     * creates the orders, so by the time a payment has failed there is no basket to check out.
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
        await retryCharge(req, res, null, phone);
    });
}

/**
 * A retry may name the wallet to charge. Absent means "the one on my account".
 *
 * ⚠ **The platform's own E.164 schema, the one the screen uses — never a length check.** An
 * earlier version of this file accepted any 6–20 character string here, which put a typed
 * number in front of NotchPay and My-CoolPay unvalidated: precisely the defect
 * `payments/validators/payment.validators.ts` says it was written to close, reintroduced
 * through a new door. Two doors onto one charge must refuse the same inputs.
 */
const RetrySchema = z
    .object({ phone: OptionalPhoneNumberSchema.nullable().default(null) })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
//  The money turns — one implementation, reached by a ROUTE and by a TAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a charge got to, reported as data for the model to narrate.
 *
 * `transactionId` null means "the caller's latest checkout payment" (the route); a string means
 * "this one, if it is theirs" (the tap).
 */
async function reportPayment(
    req: Request,
    res: Response,
    transactionId: string | null,
): Promise<void> {
    const caller = botCallerOf(req);
    const transaction = await resolveCheckoutPayment(caller.customerId, transactionId);

    /**
     * ⚠ **A terminal transaction is NOT re-verified.** `verifyPayment` returns early on one
     * anyway, but asking is a gateway call per impatient customer for an answer that cannot
     * change. Settled is settled.
     */
    const verified = isTerminal(transaction.status)
        ? { status: transaction.status }
        : await paymentOrchestrator.verifyPayment(transaction._id.toString());

    sendSuccess(res, toPaymentReport(transaction, verified.status));
}

/** Open a fresh charge for the orders a checkout payment covered. */
async function retryCharge(
    req: Request,
    res: Response,
    transactionId: string | null,
    phone: string | null,
): Promise<void> {
    const caller = botCallerOf(req);
    const transaction = await resolveCheckoutPayment(caller.customerId, transactionId);
    const cartId = transaction.cartId?.toString();
    /**
     * ⚠ **Unreachable by construction, and kept as a belt**: `resolveCheckoutPayment` only ever
     * returns a cart payment. It answers 404 — the one status this code has everywhere else — rather
     * than the 422 it once had here, because one code at two statuses is two categories and
     * `test:errors` refuses it.
     */
    if (!cartId) {
        throw createAppError(
            ERROR_CODES.PAYMENT_CART_NOT_FOUND,
            404,
            'That payment was not for a checkout basket',
        );
    }

    const customer = await loadCustomer(caller.customerId);
    const payerNumber = phone ?? (await storedPayerNumber(customer));
    if (!payerNumber) {
        throw createAppError(
            ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED,
            422,
            'A mobile money number is needed to take this payment',
        );
    }

    let payment: Awaited<ReturnType<PaymentOrchestratorService['initiatePaymentForCart']>>;
    try {
        payment = await paymentOrchestrator.initiatePaymentForCart(
            cartId,
            mobileMoneyGateway(),
            { phoneNumber: payerNumber, customerName: customer.name },
        );
    } catch (error) {
        /**
         * ⚠ **"Try again" on a basket that has since been paid is GOOD NEWS, not a refusal.**
         * A button sits in the chat history for as long as the conversation does, and the
         * commonest reason a retry finds nothing to charge is that the customer already paid —
         * by a later attempt, on the storefront, or because the webhook finally landed. Answering
         * that with a 409 would tell them "that has already changed, let me check" about a
         * payment that went through. So it is reported as settled.
         *
         * Only that one code is caught. Every other refusal is a real one and keeps its sentence.
         */
        if (error instanceof AppError && error.code === ERROR_CODES.PAYMENT_ORDER_ALREADY_PAID) {
            sendSuccess(res, toPaymentReport(transaction, 'SUCCEEDED'));
            return;
        }
        throw error;
    }

    sendSuccess(res, {
        transactionId: payment.transactionId,
        state: stateOf(payment.status),
        /**
         * ⚠ **Relayed verbatim and NOT translated, because it is the operator's word for what
         * the gateway did.** `instructions` carries the USSD code and the "confirm the prompt on
         * your phone" line the provider itself supplies, and it is the one thing in this response
         * the customer genuinely has to act on. The model narrates it.
         */
        instructions: payment.instructions ?? null,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  The tap — Check status · Try again
//
//  Reached through `/catalog/action`. The dispatcher belongs to the switchboard (backend-89): it
//  parses the token ONCE, refuses what nobody handles in ONE place, and calls the handler a
//  stream registers for the key. This stream owns the plain verb `pay` outright, so the key is the
//  verb alone and the handler tells `st` from `rt` itself (`bot-action-dispatch.ts`: a verb one
//  stream owns is never sub-dispatched in the shared registry).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `pay:st:<transactionId>` — Check status · `pay:rt:<transactionId>` — Try again.
 *
 * ── ⚠ THE TAP CARRIES A TRANSACTION ID; THE ROUTES DO NOT — NOT A CONTRADICTION ─
 * The routes refuse an id because their caller is a MODEL, and a model asked for an id it has
 * never seen invents one. A tap's id is minted by THIS service into a button and comes back
 * byte-identical; nothing composes it.
 *
 * And the tap MUST carry one, for a reason the routes never meet: **a button outlives the payment
 * it was drawn for.** A "Try again" tapped under last week's failure, by a customer who has checked
 * out twice since, would re-charge whichever basket is newest if it resolved "the latest" —
 * pushing a mobile-money prompt for a different order than the message on their screen names.
 * With the id it acts on the payment it was drawn under, or on nothing.
 *
 * Shape: `pay:<st|rt>:<24-hex id>` — 31 bytes against Telegram's 64.
 *
 * ── ⚠ THE DISPATCHER'S CONTRACT: THROW, NEVER `next` ────────────────────────
 * The dispatcher's `asyncHandler` is the one error path, so a refusal is THROWN and reaches the
 * global handler exactly once. An earlier version of this handler caught its own errors and passed
 * them to `next` — which, under this contract, would hand the same failure to two error paths.
 *
 * ⚠ **An argument this handler cannot read gets `unknownBotAction()`**, the dispatcher's own
 * refusal factory, so a malformed `pay:` and a retired verb read identically to the customer and
 * cannot drift. A well-formed id that points at nothing keeps `PAYMENT_TRANSACTION_NOT_FOUND`.
 *
 * ⚠ **No typed number on a tap, so the account's is charged.** A button cannot carry what the
 * customer would have typed; one who needs a different wallet says so in words, which reaches
 * `checkout_retry_payment` with `phone` set.
 */
export async function paymentTap(
    req: Request,
    res: Response,
    action: ParsedBotAction,
): Promise<void> {
    const separator = action.argument.indexOf(':');
    const which = separator < 0 ? action.argument : action.argument.slice(0, separator);
    const transactionId = separator < 0 ? '' : action.argument.slice(separator + 1);

    if (!/^[0-9a-fA-F]{24}$/.test(transactionId)) throw unknownBotAction();

    if (which === 'st') {
        await reportPayment(req, res, transactionId);
        return;
    }
    if (which === 'rt') {
        await retryCharge(req, res, transactionId, null);
        return;
    }
    throw unknownBotAction();
}

/**
 * This stream's entry in the tap-code registry. ONE map per stream (`bot-action-dispatch.ts`).
 *
 * ⚠ **Keyed by the plain verb `pay`, never `pay:st` / `pay:rt`.** One stream owns `pay`
 * outright, so its argument grammar stays in `paymentTap` — sub-keying it in the shared registry
 * would make the next change to that grammar somebody else's edit.
 */
export const CHECKOUT_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    pay: paymentTap,
});

/**
 * A checkout-group payment belonging to the caller: the one named, or their latest.
 *
 * ⚠ **`userId` holds the CUSTOMER id for an order or cart payment**, and the USER id only for a
 * booking one — the asymmetry `BotCartController.getTransaction` documents and accepts both sides
 * of. This query is cart-scoped, so only the customer id can ever match, and narrowing it to that
 * is what keeps one customer's "check my payment" from ever reaching another's record.
 *
 * ⚠ **A named id that is not the caller's answers exactly like one that does not exist.** A
 * transaction id is the only thing between one customer and another's payment record, so
 * confirming that an id is real is itself the disclosure.
 *
 * ⚠ **404 rather than an empty answer**, because "you have no payment" and "I could not find
 * yours" are the same sentence to a customer and only one of them is news for the model to
 * narrate.
 */
async function resolveCheckoutPayment(
    customerId: string,
    transactionId: string | null,
): Promise<IPaymentTransaction> {
    const filter = transactionId
        ? { _id: transactionId, userId: customerId, cartId: { $ne: null } }
        : { userId: customerId, cartId: { $ne: null } };

    const transaction = await PaymentTransactionModel.findOne(filter)
        .select('-rawGatewayPayloads')
        .sort({ createdAt: -1 })
        .exec();

    if (!transaction) {
        throw createAppError(
            ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND,
            404,
            'There is no such checkout payment on this account',
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
