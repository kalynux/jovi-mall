import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { AppError, createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { CartService, CartResponse } from '../../../cart/services/cart.service';
import { CustomerModel, ICustomer, ICustomerSavedAddress } from '../../../customers/customer.model';
import { OrderService } from '../../../orders/order.service';
import { cartQuoteService } from '../../../orders/services/cart-quote.service';
import { PaymentOrchestratorService } from '../../../payments';
import { PaymentGatewayType, PaymentStatus } from '../../../payments/models/payment-transaction.model';
import { publicCatalogService } from '../../../catalog/services/public-catalog.service';
import { formatBotPrice, toPublicMediaUrl } from '../../domain/product-card';
import { botStorefrontLink, surfacePath } from '../../domain/bot-list-window';
import { maskPhone } from '../../dto/bot-projections';
import { InAppSurfaceSession, inAppSurfaceStore } from '../../services/inapp-surface.store';
import { accountIdentifier, maskAddress } from './checkout-masking';
import { ChatDestination, resolveChatDestination } from './checkout-destination';
import {
    assertNetworkChargeable,
    maskedPayerNumber,
    mobileMoneyGateway,
    storedPayerNumber,
    validatedPayerNumber,
} from './checkout-payer';

/**
 * ⚠ **Re-exported, not redefined.** The five payment helpers moved to `checkout-payer.ts` so a
 * transport-free core can import them; they are re-exported here so every existing caller of
 * this module keeps working. New callers should import from `./checkout-payer` directly.
 */
export {
    assertNetworkChargeable,
    maskedPayerNumber,
    mobileMoneyGateway,
    storedPayerNumber,
    validatedPayerNumber,
};

/**
 * `inAppCheckout` — the screen that turns a basket into an order and a mobile-money prompt.
 *
 * ── ⚠ THIS IS THE ONE SCREEN WHOSE MISTAKES COST REAL MONEY ─────────────────
 * Every other handle on this surface has a worst case of *adding items to a stranger's
 * basket*. A `co` handle authorises **placing an order against a stranger's saved address and
 * starting a payment**, from a URL that carries no other credential and that a customer can
 * forward. Four protections hold that in place, and they are split across three files
 * deliberately so no single edit can remove them all:
 *
 *   1. **A ten-minute life** — `TTL_SECONDS.co` in `inapp-surface.store.ts`, strictly the
 *      shortest of the five, and `touch` refuses `co` outright so a page left open cannot
 *      keep an order-placing credential alive.
 *   2. **Single use on the write** — `placeCheckout` below calls `consume`, never `read`.
 *      Neither door has an `Idempotency-Key` (the page is browser traffic; the WhatsApp form is
 *      retried by Meta on its own schedule), so the store's Lua read-and-delete is the only
 *      thing standing between a double-tap or a retry and two orders.
 *   3. **Nothing sensitive is projected in full** — the address comes back coarse (see
 *      `maskAddress`) and the mobile-money number never reaches the page at all: it is the
 *      field's *placeholder*, and an empty field means "use the number on my account".
 *   4. **No money is quoted by the page** — `totalText` and every `lineTotalText` are
 *      formatted here. `test:inapp-checkout` § 1 refuses `toFixed`, `parseFloat` and
 *      `Intl.NumberFormat` in `co.html` for exactly that reason.
 *
 * ── ⚠ THE HANDLE IS SPENT EVEN WHEN THIS FILE THEN FAILS ────────────────────
 * That is the safe direction, and it is what the page's no-retry rule is built on: a customer
 * who loses a checkout re-taps in the chat and gets a fresh screen, whereas a handle that
 * survived a partial failure is a handle that can place the order twice. It also means
 * **nothing below may tell a customer their order was not placed** — once `consume` has
 * returned, an order may exist whatever happens next.
 *
 * ── THE SPECIFICATION IS THE PAGE ───────────────────────────────────────────
 * The `/data` response shape is written out as a contract in the opening comment of
 * `public/co.html`. If this file and that comment disagree, the page is right — it is what a
 * customer sees.
 *
 * ── ⚠ EVERY REFUSAL A CUSTOMER CAN ACT ON IS SHAPED TO LAND ON 404 OR 410 ───
 * `co.html`'s `explain()` maps those two statuses to `copy.expired` — *"ask me again in the
 * chat and I will open a fresh one"* — which is the page's own copy, in the customer's own
 * language, and is the only remedy that actually works for any of them. Every OTHER status
 * renders `error.message`, which is English. So a basket that has emptied is **404**, not the
 * 409 it would be on an API meant for machines. That is not a status-code flourish: it is the
 * difference between a French customer reading a French sentence and reading ours.
 *
 * ⚠ **One status per error code, platform-wide — `test:errors` enforces it.** The basket-gone
 * refusal was first raised as `CART_EMPTY_CHECKOUT` at 410, but that code is 400 everywhere else,
 * and a code that means two categories breaks every dashboard that groups by it. It now shares the
 * screen's handle-gone code at 404, which the page and the WhatsApp form both treat exactly as they
 * treated 410. Both move to the switchboard's screen-session code when it lands.
 */

/**
 * The HTTP body the page submits. Shape only — the VALUE of `phone` is validated inside
 * `placeCheckout`, so the page and the WhatsApp form are refused by one rule, not two.
 */
const PlaceBodySchema = z.object({ phone: z.unknown().optional() }).strict();

const cartService = new CartService();
const orderService = new OrderService();
const paymentOrchestrator = new PaymentOrchestratorService();

// ─────────────────────────────────────────────────────────────────────────────
//  THE CHECKOUT CORE — exported, transport-neutral, and the ONLY implementation
//
//  ⭐ **One read, one set of rules, two renderings.** The Telegram page (`co.html`, through the
//  controller below) and the WhatsApp form (`whatsapp/flows`, backend-ed's adapter) both call
//  these two functions. Neither may copy the projection or re-derive a rule, because every rule
//  here is one of the four protections that keep a `co` handle from placing an order against a
//  stranger's address — and a second copy is a copy that eventually lacks one.
//
//  Nothing below touches `req` or `res`. A refusal is an `AppError` carrying a status and
//  `details.spent`; each transport maps those to its own answer.
// ─────────────────────────────────────────────────────────────────────────────

/** One line as a screen draws it. Every money value is already a string. */
export interface CheckoutLine {
    title: string;
    variantLabel: string | null;
    quantity: number;
    lineTotalText: string;
    imageUrl: string | null;
}

/**
 * What a checkout screen shows. The page's opening comment is the contract for the first four
 * fields; `language` is here for a renderer that words its own labels.
 */
export interface CheckoutView {
    lines: CheckoutLine[];
    /** The one figure the customer is agreeing to pay. The screen adds nothing up. */
    totalText: string;
    /** ⚠ MASKED. `null` is the no-address state; `digital` swaps the heading. */
    address: { text: string; digital?: true } | null;
    /** ⚠ Never the full number — a placeholder, and empty means "use this one". */
    payment: { phoneMasked: string | null };
    language: string | null;
    /**
     * The website's address page, in the customer's language — **only in the no-address state**,
     * null otherwise and null when `STOREFRONT_URL` is unset (the page then shows the sentence
     * and no link, never a dead one).
     *
     * ⚠ **Built HERE and never by the page**, through `botStorefrontLink(surfacePath('addresses'))`
     * — the one reader of the storefront origin and the locale rule, and the path table
     * `verify:landing-routes` checks. Owner's ruling 2026-09-20: an address is added on the
     * website; this screen captures none.
     *
     * Optional in the TYPE only because the WhatsApp form (on hold) does not draw it and its
     * fixtures predate it; `readCheckoutView` always sets it.
     */
    addAddressUrl?: string | null;
}

/**
 * What placing a checkout answers.
 *
 * ⚠ **No amount, no address and no order numbers**, deliberately. The screen's only job after
 * this is to say "approve the payment on your phone" and close; everything the customer needs
 * next arrives in the chat, where it can be worded in their language and carry buttons. A
 * receipt rendered on a screen that is about to close is a receipt nobody reads.
 */
export interface CheckoutPlaced {
    orderCount: number;
    transactionId: string;
    /**
     * ⚠ **`FAILED` or `CANCELLED` here means the charge was refused AT OPEN — no prompt is coming
     * to the handset.** The orchestrator answers a gateway's refusal as a result rather than an
     * error (it throws only when the call itself failed), so a caller that reads only "did it
     * throw" tells the customer to approve a payment that does not exist. Every renderer must
     * read this field, and all three do: `co.html` and the WhatsApp form's `placedResponse` say
     * `failed` instead of "approve it on your phone", and the chat door reports `state: 'failed'`
     * (`stateOf`). Found 2026-09-22: the page said "approve it" for every 200.
     */
    status: PaymentStatus;
}

/**
 * What `placeCheckout` knows after placing — a superset of `CheckoutPlaced`, for the CHAT door.
 *
 * ⚠ **The screen is sent `CheckoutPlaced` only, by explicit projection in
 * `CheckoutController.place`.** The extra fields are for a conversation the customer owns, which
 * can word them in their language beside Check-status and Try-again; a screen that is about to
 * close has no use for them, and a `co` URL is forwardable.
 */
export interface CheckoutPlacement extends CheckoutPlaced {
    orderNumbers: string[];
    /** The wallet the prompt went to, MASKED — the same mask the screen's placeholder uses. */
    payerMasked: string;
    /** The gateway's own instruction (a USSD code, "confirm on your phone"), relayed verbatim. */
    instructions: unknown;
}

/**
 * What only the CHAT door passes to `placeCheckout`.
 *
 * The screen has none of these: it has no identity but the handle, and no address picker by
 * design. The chat has both — the bot resolved the customer before the handler ran, and the
 * customer chose an address in words.
 */
export interface PlaceCheckoutOptions {
    /**
     * The customer the bot resolved. The handle must be theirs; and knowing them BEFORE the
     * spend is what lets the address and the wallet be checked while a refusal still costs the
     * customer nothing (`details.spent: false`).
     */
    callerCustomerId?: string;
    /** One of the customer's own saved addresses. Null → their default, exactly as the screen. */
    addressId?: string | null;
}

/**
 * The checkout a handle opens, read live.
 *
 * ⚠ **Repeatable — `read`, never `consume`.** A screen reads on every open and every refresh,
 * and a WhatsApp form's INIT exchange may be retried by Meta on its own schedule.
 *
 * ⚠ **Read live on every call, and NOTHING is cached onto the session.** The `co` session holds
 * an owner, a conversation and a cart id — no prices, no lines, no total. A held total is a total
 * that can disagree with the basket by the time somebody pays, discovered by the customer at the
 * moment of the charge.
 *
 * Refuses with **404** — the handle is unknown, lapsed, malformed or the wrong kind, or the
 * basket has gone or been replaced since. Both carry `details.spent: false` — a read spends
 * nothing — and are told apart by their message.
 */
export async function readCheckoutView(handle: string): Promise<CheckoutView> {
    const session = await inAppSurfaceStore.read('co', plausibleHandle(handle));
    if (!session) throw handleGone(false);

    const cart = await cartService.getCart(session.customerId);
    assertBasketStillThere(cart, session, false);

    const customer = await loadCustomer(session.customerId);

    /**
     * ⚠ **The total is the SERVER's figure.** It comes from `cartQuoteService`, the service the
     * storefront cart and `cart_quote` call, so delivery, the vendor-absorbed fee, tax and
     * discount are decided in one place. A screen that summed the lines would be a second
     * implementation of all four, in the one place nothing tests.
     *
     * ⚠ **Quoted WITHOUT an address id, deliberately.** Passing one makes `quoteForCustomer`
     * validate it and throw `ORDER_DELIVERY_ADDRESS_REQUIRED` — which would turn the no-address
     * state, a real state with a real instruction, into an error. The address is resolved
     * separately and reported as data.
     */
    const quote = await cartQuoteService.quoteForCustomer(session.customerId);
    const address = await resolveDestination(cart, customer);

    return {
        lines: await toCheckoutLines(cart),
        totalText: formatBotPrice(quote.total, quote.currency),
        address,
        payment: { phoneMasked: await maskedPayerNumber(customer) },
        language: session.language,
        addAddressUrl: address ? null : botStorefrontLink(surfacePath('addresses'), session.language),
    };
}

/**
 * Spend the handle, create the orders, open the charge.
 *
 * ── ⚠ `details.spent` IS ON EVERY REFUSAL, AND ABSENT MEANS SPENT ───────────
 * A caller deciding whether a retry is honest must know whether the handle survived, and the
 * status code cannot say: a 400 can come from the typed number (before the spend) or from order
 * creation (after it). So every `AppError` thrown here carries the answer.
 *
 * ⚠ **Treat a missing flag as `true`.** Over HTTP the platform strips `details` from every
 * external-service and internal error, so a 502 reaches a browser with no flag at all — and
 * anything that is not an `AppError` never had one. The safe reading of silence is "the order
 * may exist": send the customer to the chat, which knows the truth.
 *
 * ── THE ORDER OF THE WORK IS THE PROTECTION ─────────────────────────────────
 *   1. **Validate the number, then check a gateway exists** — neither needs the session, both
 *      are deterministic, and a refusal here must not cost the customer their handle.
 *   2. **`consume`** — before anything that takes time. A double-tap, a refreshed tab, a
 *      forwarded URL and a Meta retry all find the handle gone, and no `Idempotency-Key`
 *      reaches this code from either transport, so the store's Lua read-and-delete is the only
 *      guard there is.
 *   3. **Everything else**, with every refusal marked spent.
 *
 * ⚠ **The ADDRESS is never free text and never a coordinate.** On the screen it is not an
 * argument at all — `createOrdersFromCart` resolves the customer's default. The chat door may name
 * ONE OF THE CUSTOMER'S OWN saved addresses by id (`options.addressId`), checked before the spend
 * by `resolveChatDestination` and then passed to `createOrdersFromCart` explicitly, so neither
 * door can send a delivery anywhere the customer has not saved and been shown.
 *
 * @param phone Whatever the screen submitted. `null`, `undefined`, `''` and whitespace all mean
 *   "use the number on my account"; anything else must be a valid phone number.
 * @param options The chat door's extras — see `PlaceCheckoutOptions`. The screen passes none.
 */
export async function placeCheckout(
    handle: string,
    phone: unknown,
    options: PlaceCheckoutOptions = {},
): Promise<CheckoutPlacement> {
    const typedNumber = validatedPayerNumber(phone);
    const gateway = mobileMoneyGateway();
    if (typedNumber) assertNetworkChargeable(gateway, typedNumber, false);

    /**
     * ⚠ **The chat door is checked BEFORE the spend, because it can be.** The screen learns its
     * customer only from the session, so everything about them is necessarily after `consume`;
     * the chat knows the caller up front. A wrong address id or an account with no wallet is
     * then refused with the handle still alive, and the model can put it right in the same turn
     * instead of re-opening the checkout.
     */
    const addressId = options.callerCustomerId
        ? await precheckChatDoor(options.callerCustomerId, options.addressId ?? null, typedNumber, gateway)
        : null;

    const session = await inAppSurfaceStore.consume('co', plausibleHandle(handle));
    if (!session) throw handleGone(false);
    /**
     * ⚠ **A handle belongs to one customer, and the chat door proves it.** A `co` URL is
     * forwardable, so a handle a customer pasted into their own chat could otherwise place an
     * order for whoever it was minted for. Refused exactly like an unknown handle — anything
     * else would confirm the handle was real — and marked spent, because it now is.
     */
    if (options.callerCustomerId && session.customerId !== options.callerCustomerId) {
        throw handleGone(true);
    }

    try {
        const cart = await cartService.getCart(session.customerId);
        assertBasketStillThere(cart, session, true);

        const customer = await loadCustomer(session.customerId);
        const payerNumber = typedNumber ?? (await storedPayerNumber(customer));
        if (!payerNumber) {
            throw createAppError(
                ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED,
                422,
                'A mobile money number is needed to take this payment',
                { spent: true },
            );
        }

        /**
         * ⚠ **Checked again for the ACCOUNT's number, and BEFORE the orders exist.** The typed
         * number was checked before the spend; the account's can only be known after it, because
         * the customer comes from the session. Past this point the handle is gone either way —
         * but refusing here rather than inside the gateway is the difference between "go back to
         * the chat" and "go back to the chat, and there is now an unpaid order and a thirty-minute
         * stock hold behind you that you never asked for".
         */
        assertNetworkChargeable(gateway, payerNumber, true);

        /**
         * ⚠ **`'online'`, never `'cash_on_delivery'`, and no screen offers a choice.** Mobile money
         * is the only live method here; a COD checkout takes no payment, produces a delivery code
         * per shipment, and is refused outright by `initiatePaymentForCart`.
         */
        const { cartId, orders } = await orderService.createOrdersFromCart(
            session.customerId,
            'online',
            { addressId, address: null },
        );

        /**
         * ⚠ **The charge is opened and its RESULT is not waited for** — a mobile-money push is
         * approved on a handset minutes later, on a device that is not this screen. A failure of
         * THIS call is a failure to open the charge, not a failed payment: the orders exist and
         * await payment either way, and the chat can take the payment again.
         *
         * ⭐ **`originChat` is the conversation this session belongs to**, so the payment's
         * result is told THERE (`IPaymentTransaction.originChat`). Every road into this function
         * — the chat's own place, its Yes tap, the screen and the WhatsApp form — holds a `co`
         * handle minted in one chat, so every one of them has a conversation to answer in.
         * Measured 2026-09-22: without it, a WhatsApp order's "payment received" went to
         * Telegram, the account's first-priority channel.
         */
        const payment = await paymentOrchestrator.initiatePaymentForCart(cartId, gateway, {
            phoneNumber: payerNumber,
            customerName: customer.name,
        }, { originChat: session.channel });

        return {
            orderCount: orders.length,
            transactionId: payment.transactionId,
            status: payment.status,
            orderNumbers: orders.map((order) => order.order_number),
            payerMasked: maskPhone(payerNumber),
            instructions: payment.instructions ?? null,
        };
    } catch (error) {
        throw markedSpent(error);
    }
}

/**
 * The checkout a CHAT would review — the screen's read, for a customer with no screen.
 *
 * ── ⭐ THE SAME PROJECTION AS `readCheckoutView`, NOT A SECOND ONE ───────────
 * Lines through `toCheckoutLines`, the total through `cartQuoteService`, the wallet through
 * `maskedPayerNumber`, the gateway through `mobileMoneyGateway` — every figure a customer is told
 * in the chat is the figure the screen would have shown them. What differs is only what a chat
 * can do and a screen deliberately cannot: choose among the saved addresses.
 *
 * ⚠ **Read live and holds nothing** — the handle the chat door mints beside it carries a cart id
 * and no money, exactly as the screen's does.
 *
 * ⚠ **The gateway is asked for here, before anything is minted**, so a deployment with no mobile
 * money refuses in the review rather than after the customer has said yes.
 *
 * Refuses an empty basket with `CART_EMPTY_CHECKOUT` (400), the chat's own sentence for it — the
 * screen door (`POST /checkout/screen`) refuses it the same way.
 */
export async function readChatCheckout(
    customerId: string,
    requestedAddressId: string | null,
): Promise<ChatCheckoutView> {
    mobileMoneyGateway();

    const cart = await cartService.getCart(customerId);
    if (cart.items.length === 0 || !cart.cartId) {
        throw createAppError(ERROR_CODES.CART_EMPTY_CHECKOUT, 400, 'There is nothing in the basket to check out');
    }

    const customer = await loadCustomer(customerId);
    const quote = await cartQuoteService.quoteForCustomer(customerId);
    const addresses = customer.saved_addresses ?? [];

    return {
        cartId: cart.cartId,
        productType: cart.productType ?? null,
        lines: await toCheckoutLines(cart),
        totalText: formatBotPrice(quote.total, quote.currency),
        destination: resolveChatDestination(cart.productType, addresses, requestedAddressId),
        addresses,
        accountIdentifier: accountIdentifier(customer),
        phoneMasked: await maskedPayerNumber(customer),
    };
}

/** What `readChatCheckout` answers. The chat controller shapes it for the model. */
export interface ChatCheckoutView {
    cartId: string;
    productType: string | null;
    lines: CheckoutLine[];
    totalText: string;
    destination: ChatDestination;
    /** In stored order. The chat controller projects them through `toBotAddressDto`. */
    addresses: ICustomerSavedAddress[];
    /** Where a DOWNLOAD lands — the screen's own wording for a digital basket. */
    accountIdentifier: string;
    phoneMasked: string | null;
}

export class CheckoutController {
    /** `GET /api/bot/miniapp/s/co/:handle/data` — the page's read. A thin wrapper; see `readCheckoutView`. */
    static data = asyncHandler(async (req: Request, res: Response) => {
        const view = await readCheckoutView(String(req.params.handle ?? ''));
        /** The page's contract is these five fields; `language` came in through the copy call. */
        sendSuccess(res, {
            lines: view.lines,
            totalText: view.totalText,
            address: view.address,
            payment: view.payment,
            addAddressUrl: view.addAddressUrl ?? null,
        });
    });

    /**
     * `POST /api/bot/miniapp/s/co/:handle/place` — the page's write. A thin wrapper; see `placeCheckout`.
     *
     * ⚠ **Projected to `CheckoutPlaced` field by field**, never the placement itself: order
     * numbers and the masked wallet are for the chat, and a spread would hand this forwardable
     * page whatever the placement gains next.
     */
    static place = asyncHandler(async (req: Request, res: Response) => {
        const { phone } = PlaceBodySchema.parse(req.body ?? {});
        const placed = await placeCheckout(String(req.params.handle ?? ''), phone);
        const answer: CheckoutPlaced = {
            orderCount: placed.orderCount,
            transactionId: placed.transactionId,
            status: placed.status,
        };
        sendSuccess(res, answer);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  The rules the core applies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A handle, or a value that cannot match one.
 *
 * ⚠ **Not a refusal.** An absurd value is simply absent — the store answers null for anything
 * without its prefix — so a malformed handle and a lapsed one are the same 404, which is the
 * position every handle on this surface takes: distinguishing them would confirm to a caller
 * that a handle it does not own is real.
 */
function plausibleHandle(handle: string): string {
    return typeof handle === 'string' && handle.length <= 128 ? handle.trim() : '';
}



/**
 * The chat door's refusals that can be made while the handle is still alive.
 *
 * Every one carries `spent: false`, and every one is something the model can put right in the
 * same turn — pick a deliverable address, list the addresses again, ask for a number — which is
 * exactly why it must not cost the customer their checkout.
 *
 * ⚠ **The same codes `createOrdersFromCart` raises for the same conditions**
 * (`ORDER_DELIVERY_ADDRESS_REQUIRED` 422 with the same `details.reason` values,
 * `CUSTOMER_ADDRESS_NOT_FOUND` 404), so a client handles one vocabulary whichever side of the
 * spend a refusal lands on.
 *
 * ⚠ **The account's number is network-checked here too**, with `spent: false`, for the reason
 * `assertNetworkChargeable` gives: a number no network can be worked out for would otherwise be
 * found only inside the gateway, after the orders and their stock hold exist.
 *
 * @returns The address id to place the orders against — null for a digital basket.
 */
async function precheckChatDoor(
    customerId: string,
    requestedAddressId: string | null,
    typedNumber: string | null,
    gateway: PaymentGatewayType,
): Promise<string | null> {
    const cart = await cartService.getCart(customerId);
    if (cart.items.length === 0 || !cart.cartId) {
        throw createAppError(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, 404, 'That basket is no longer there', { spent: false });
    }

    /**
     * ⚠ **A physical basket must NAME its address on the chat door — the default is never
     * assumed at this step.** The review proposed one and the customer agreed to THAT one; had
     * the model chosen another address in the review and then omitted the id here, falling back
     * to the default would ship the parcel somewhere the customer was never shown. The same
     * reasoning that makes `deliveryAddressId` required on `checkout_create_orders`.
     */
    if (cart.productType !== 'digital' && !requestedAddressId) {
        throw createAppError(
            ERROR_CODES.ORDER_DELIVERY_ADDRESS_REQUIRED,
            422,
            'Name the delivery address: pass the address id the checkout review proposed.',
            { reason: 'address_not_named', spent: false },
        );
    }

    const customer = await loadCustomer(customerId);
    const destination = resolveChatDestination(cart.productType, customer.saved_addresses ?? [], requestedAddressId);

    if (destination.kind === 'blocked') {
        if (destination.blocker === 'address_not_found') {
            throw createAppError(ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND, 404, 'That address is not one of yours', {
                spent: false,
            });
        }
        throw createAppError(
            ERROR_CODES.ORDER_DELIVERY_ADDRESS_REQUIRED,
            422,
            destination.blocker === 'no_saved_address'
                ? 'A delivery address is required. Add one on the website, then check out again.'
                : 'That address has no mapped location, so a delivery cannot be routed to it. Choose another.',
            {
                reason: destination.blocker === 'no_saved_address' ? 'no_delivery_address' : 'selected_address_not_geocoded',
                spent: false,
            },
        );
    }

    if (!typedNumber) {
        const stored = await storedPayerNumber(customer);
        if (!stored) {
            throw createAppError(
                ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED,
                422,
                'A mobile money number is needed to take this payment',
                { spent: false },
            );
        }
        assertNetworkChargeable(gateway, stored, false);
    }

    return destination.kind === 'address' ? String(destination.address._id) : null;
}

/** The handle-gone refusal, one wording for the read and the write. */
function handleGone(spent: boolean): AppError {
    return createAppError(
        ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
        404,
        'That checkout is no longer held',
        { spent },
    );
}

/**
 * Mark a refusal as having happened after the handle was spent.
 *
 * ⚠ **Only an `AppError` can carry the flag**, so anything else is rethrown untouched — and a
 * caller reading no flag treats it as spent, which is the rule on `placeCheckout` and the reason
 * this function does not need to invent one.
 */
function markedSpent(error: unknown): unknown {
    if (!(error instanceof AppError)) return error;
    if (error.details?.spent === true) return error;
    return new AppError(
        error.message,
        error.statusCode,
        error.code,
        error.isOperational,
        { ...(error.details ?? {}), spent: true },
    );
}

/**
 * Refuse a checkout whose basket has gone or been replaced since the screen opened.
 *
 * ⚠ **404, and the status is the whole point** — see the header. `co.html` renders 404 (and 410)
 * as `copy.expired`, which says "ask me again in the chat and I will open a fresh one" in the
 * customer's own language. Any other status would render our English.
 *
 * ⚠ **Not `CART_EMPTY_CHECKOUT`**, which this once raised at 410: that code is 400 on the quote
 * path, and one code at two statuses is two categories — `test:errors` refuses it.
 *
 * ⚠ **This compares the basket's IDENTITY, not its contents**, and the limit is worth stating.
 * `clearCart` deletes the document, so a basket emptied and rebuilt gets a new id and is caught
 * here. A line ADDED to the same basket between the screen opening and the Pay tap is not
 * caught — the customer is charged for it, because the orders are built from the live basket
 * at `place` time rather than from anything the screen remembered. That is the correct
 * direction (nobody is ever charged a stale total), and closing the remaining gap would mean
 * the page sending back a total it had computed, which is the one thing this screen may not do.
 */
function assertBasketStillThere(
    cart: CartResponse,
    session: Extract<InAppSurfaceSession, { kind: 'co' }>,
    spent: boolean,
): void {
    if (cart.items.length === 0 || !cart.cartId) {
        throw createAppError(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, 404, 'That basket is no longer there', { spent });
    }
    if (session.cartId && session.cartId !== cart.cartId) {
        throw createAppError(ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED, 404, 'That basket has been replaced', { spent });
    }
}

async function loadCustomer(customerId: string): Promise<ICustomer> {
    const customer = await CustomerModel.findById(customerId)
        .select('name email phone saved_addresses')
        .lean<ICustomer>()
        .exec();
    if (!customer) {
        throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404, 'Customer not found');
    }
    return customer;
}

/**
 * The basket, line by line, with every money value already rendered.
 *
 * ⚠ **One products read for the whole basket, not one per line.** A basket is small but a
 * checkout screen is opened on a phone over a mobile connection, and the alternative is N round
 * trips to Mongo for N thumbnails nobody is going to look at closely.
 *
 * ⚠ **A missing picture is `null`, never a placeholder.** A chat card substitutes a stand-in
 * because a card with a hole in it reads as a broken bot; a screen has layout, and `co.html`
 * renders an empty thumbnail frame — which is what a product with no photograph is. The same
 * decision Stream B's detail screen records.
 */
async function toCheckoutLines(cart: CartResponse): Promise<CheckoutLine[]> {
    const images = await primaryImageUrls([...new Set(cart.items.map((item) => item.productId))]);

    return cart.items.map((item) => ({
        title: item.title,
        /**
         * ⚠ **Empty becomes null rather than an empty string.** `generateVariantTitle` answers
         * `''` for a product with no options — a digital download, a single-variant simple
         * product — and the page joins `variantLabel` with the quantity, so an empty string
         * would render as a stray separator under every such line.
         */
        variantLabel: item.variantTitle && item.variantTitle.length > 0 ? item.variantTitle : null,
        quantity: item.quantity,
        lineTotalText: formatBotPrice(item.price * item.quantity, item.currency),
        imageUrl: images.get(item.productId) ?? null,
    }));
}

/**
 * Each product's thumbnail, for a **browser** rather than for a platform's fetcher.
 *
 * ⚠ **Through `publicCatalogService`, never through the product model directly.** A product's
 * media is `file_references`, not a column, and `decorateRows` is what turns those into a
 * `FileDetail` with a servable URL — the same resolution the storefront grid and the chat cards
 * use. Reaching past it to read a document would be a second implementation of the storage
 * provider's URL rules, which is exactly the drift `STORAGE_PROVIDER` already produces silently.
 *
 * ⚠ **`toPublicMediaUrl` is applied and its verdict is then fallen back past**, which is the
 * same call Stream B's screens make and for the same reason. That helper exists because Telegram
 * and Meta fetch media server-side, so a private-host URL is a rejected *send*. Here the fetcher
 * is the customer's own phone inside a WebView, which on a development machine can reach exactly
 * the host that rule rejects. The origin rewrite is what makes the URL correct in production;
 * the rejection is not this surface's rule.
 *
 * ⚠ **A product that has been unpublished since it entered the basket simply has no row**, and
 * that is the right degradation: the line renders with an empty frame. Checkout will refuse the
 * basket for its own reasons if the product is genuinely gone; a missing thumbnail must never be
 * the thing that decides.
 */
async function primaryImageUrls(productIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (productIds.length === 0) return out;

    const hydrated = await publicCatalogService.listByIdsWithVariant(productIds);
    for (const [id, entry] of hydrated) {
        const raw = entry.item.image?.url ?? null;
        out.set(id, raw ? (toPublicMediaUrl(raw) ?? raw) : null);
    }
    return out;
}

/**
 * Where this basket is going, **masked**, or null when there is nowhere to send it.
 *
 * ── ⚠ A DIGITAL BASKET NEEDS NO DELIVERY ADDRESS, AND MUST NOT BE PARKED ────
 * `createOrdersFromCart` resolves a drop-off only for a PHYSICAL order; a digital one has no
 * delivery at all. Returning null for those would strand every download purchase in the
 * no-address state — a screen telling a customer to send an address for something that is
 * never carried anywhere. So a digital basket reports where the goods actually land: the
 * account itself, named by the masked identifier the customer already recognises.
 *
 * ⚠ **That line is deliberately composed of nothing but the customer's own data** — a masked
 * email, a masked phone, or their name — so it needs no copy key and reads correctly in all
 * five languages under the "Deliver to" heading.
 *
 * ── ⚠ IT MIRRORS `resolveDeliveryAddress` EXACTLY, INCLUDING ITS FALLBACK ───
 * Default saved address, else the first, and it must carry a geocoded `geo` — an address typed
 * by hand rather than picked from the address search has none, and checkout refuses it. Showing
 * a *different* address here from the one the order would use is the failure this whole screen
 * exists to avoid: a customer confirming one destination and a delivery leaving for another.
 */
async function resolveDestination(
    cart: CartResponse,
    customer: ICustomer,
): Promise<{ text: string; digital?: true } | null> {
    /**
     * ⚠ **`digital` changes the LABEL, not just the value**, which is why it is on the wire at
     * all. Under "Deliver to", a masked email reads as somebody's address having been mangled;
     * under `checkoutDigitalDelivery` — *"Sent to your account"* — the same string answers the
     * only question a download raises, which is *which* account. The page owns that choice
     * because the page owns the copy table; this flag is the one fact it cannot derive.
     */
    if (cart.productType === 'digital') {
        return { text: accountIdentifier(customer), digital: true };
    }

    const addresses = customer.saved_addresses ?? [];
    const chosen = addresses.find((address) => address.is_default) ?? addresses[0] ?? null;
    if (!chosen?.geo) return null;

    return { text: maskAddress(chosen) };
}




