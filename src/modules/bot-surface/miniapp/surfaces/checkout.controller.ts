import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { OptionalPhoneNumberSchema } from '../../../../core/validation/phone';
import { CartService, CartResponse } from '../../../cart/services/cart.service';
import { CustomerModel, ICustomer, ICustomerSavedAddress } from '../../../customers/customer.model';
import { OrderService } from '../../../orders/order.service';
import { cartQuoteService } from '../../../orders/services/cart-quote.service';
import { PaymentOrchestratorService } from '../../../payments';
import { PaymentGatewayType } from '../../../payments/models/payment-transaction.model';
import { notchPayEnabled, myCoolPayEnabled } from '../../../payments/config/payments.config';
import { UserPaymentMethodRepository } from '../../../payment-methods/repositories/user-payment-method.repository';
import { publicCatalogService } from '../../../catalog/services/public-catalog.service';
import { maskPhone } from '../../dto/bot-projections';
import { formatBotPrice, toPublicMediaUrl } from '../../domain/product-card';
import { InAppSurfaceSession, inAppSurfaceStore } from '../../services/inapp-surface.store';
import { accountIdentifier, maskAddress } from './checkout-masking';

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
 *   2. **Single use on the write** — `place` below calls `consume`, never `read`. This mount
 *      has no `Idempotency-Key` (it is browser traffic, and a browser sends what the page
 *      sends), so the store's Lua read-and-delete is the only thing standing between a
 *      double-tap and two orders.
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
 * renders `error.message`, which is English. So a basket that has emptied is **410**, not the
 * 409 it would be on an API meant for machines. That is not a status-code flourish: it is the
 * difference between a French customer reading a French sentence and reading ours.
 */

const HandleSchema = z.object({ handle: z.string().trim().min(3).max(64) });

/**
 * What the page submits.
 *
 * ⚠ **`phone` is nullable and null is the COMMON case**, not an omission — it means "charge
 * the number already on my account", which is the whole reason the number is shown as a
 * placeholder rather than a value. A typed number is validated with the platform's own E.164
 * schema, so a mistyped one is refused here rather than by a gateway.
 */
const PlaceSchema = z
    .object({ phone: OptionalPhoneNumberSchema.nullable().default(null) })
    .strict();

const cartService = new CartService();
const orderService = new OrderService();
const paymentOrchestrator = new PaymentOrchestratorService();
const paymentMethods = new UserPaymentMethodRepository();

/** One line as the page draws it. Every money value is already a string. */
interface CheckoutLine {
    title: string;
    variantLabel: string | null;
    quantity: number;
    lineTotalText: string;
    imageUrl: string | null;
}

export class CheckoutController {
    /**
     * `GET /api/bot/miniapp/s/co/:handle/data` — the basket, the total, and where it is going.
     *
     * ⚠ **Read live on every open, and NOTHING is cached onto the session.** The `co` session
     * holds an owner, a conversation and a cart id — no prices, no lines, no total. A held
     * total is a total that can disagree with the basket by the time somebody pays, and the
     * disagreement would be discovered by the customer at the moment of the charge.
     * `InAppSurfaceSession`'s own docstring states this; it is restated here because this is
     * the file that would break it.
     *
     * ⚠ **Repeatable.** The page reads on every open and every retry, which is why this uses
     * `read` and only `place` uses `consume`.
     */
    static data = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);
        const session = await readCheckout(handle);

        const cart = await cartService.getCart(session.customerId);
        assertBasketStillThere(cart, session);

        const customer = await loadCustomer(session.customerId);

        /**
         * ⚠ **The total is the SERVER's figure and the page adds nothing up.** It comes from
         * `cartQuoteService`, which is the same service the storefront cart and
         * `cart_quote` call — so delivery, the vendor-absorbed fee, tax and discount are
         * decided in one place. A WebView that summed the lines would be a second
         * implementation of all four, in the one place nothing tests.
         *
         * ⚠ **Quoted WITHOUT an address id, deliberately.** Passing one makes `quoteForCustomer`
         * validate it and throw `ORDER_DELIVERY_ADDRESS_REQUIRED` — which would turn the
         * no-address state, a real state with a real instruction, into an error page. The
         * address is resolved separately below and reported as data.
         */
        const quote = await cartQuoteService.quoteForCustomer(session.customerId);

        sendSuccess(res, {
            lines: await toCheckoutLines(cart),
            totalText: formatBotPrice(quote.total, quote.currency),
            address: await resolveDestination(cart, customer),
            payment: { phoneMasked: await maskedPayerNumber(customer) },
        });
    });

    /**
     * `POST /api/bot/miniapp/s/co/:handle/place` — create the orders and open the charge.
     *
     * ⚠ **`consume` FIRST, before anything else that could take time.** A double-tap, a
     * refreshed tab and a forwarded URL must all find the handle gone, and the window in which
     * two requests can both see it live is exactly the work done before this line. The body is
     * parsed above it because a Zod failure is deterministic and places nothing — burning a
     * handle on a malformed request would cost a customer their checkout for a typo.
     *
     * ⚠ **The ADDRESS IS RESOLVED SERVER-SIDE AND THE PAGE NEVER SENDS ONE.** `co.html` has
     * exactly one input and it is `type="tel"` (`test:inapp-checkout` § 1 asserts the count),
     * so there is no address field to trust — and `createOrdersFromCart` re-resolves it from
     * the customer's own saved addresses regardless, which is what keeps this screen and the
     * storefront agreeing about where a delivery goes.
     *
     * ⚠ **Nothing below may report "not placed".** Once `consume` has returned, the order may
     * exist whatever fails afterwards; the page's own catch says the same thing and sends the
     * customer to the chat, which knows the truth.
     */
    static place = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);
        const { phone } = PlaceSchema.parse(req.body ?? {});

        const session = await inAppSurfaceStore.consume('co', handle);
        if (!session) {
            throw createAppError(
                ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
                404,
                'That checkout is no longer held',
            );
        }

        const cart = await cartService.getCart(session.customerId);
        assertBasketStillThere(cart, session);

        /**
         * ⚠ **Resolved BEFORE the orders exist, so a customer with no payable number is
         * refused while there is still nothing to refuse.** The alternative ordering — create
         * the orders, then discover there is nothing to charge — leaves a thirty-minute stock
         * hold and an unpaid order behind a page that has already closed.
         */
        const customer = await loadCustomer(session.customerId);
        const payerNumber = phone ?? (await storedPayerNumber(customer));
        if (!payerNumber) {
            throw createAppError(
                ERROR_CODES.PAYMENT_REFERENCE_REQUIRED,
                422,
                'A mobile money number is needed to take this payment',
            );
        }

        const gateway = mobileMoneyGateway();

        /**
         * ⚠ **`'online'`, never `'cash_on_delivery'`, and the screen offers no choice.** Mobile
         * money is the only live method here, and a COD checkout is a different conversation:
         * it takes no payment, produces a delivery code per shipment, and is refused outright
         * by `initiatePaymentForCart`. Adding a method picker to this screen would mean the
         * page deciding something that changes what the customer owes at the door.
         */
        const { cartId, orders } = await orderService.createOrdersFromCart(
            session.customerId,
            'online',
            { addressId: null, address: null },
        );

        /**
         * ⚠ **The charge is opened here and its RESULT is not waited for**, because there is
         * nothing to wait for: a mobile-money push is approved on a handset minutes later, on
         * a device that is not this browser. The page says so before this call (`checkoutWatchChat`)
         * and closes; the chat delivers the outcome.
         *
         * A failure of THIS call is a failure to open the charge, not a failed payment — the
         * orders exist and are awaiting payment either way, which is why it is allowed to
         * propagate: the page renders it, and the customer is sent back to the chat where the
         * order can be paid again. It must never be swallowed into a success.
         */
        const payment = await paymentOrchestrator.initiatePaymentForCart(cartId, gateway, {
            phoneNumber: payerNumber,
            customerName: customer.name,
        });

        sendSuccess(res, {
            /**
             * ⚠ **No amount, no address and no order numbers come back here.** The page's only
             * job after this call is to say "approve the payment on your phone" and close —
             * everything a customer needs to know next arrives in the chat, where it can be
             * worded in their language and carry buttons. A receipt rendered on a page that is
             * about to close is a receipt nobody reads.
             */
            orderCount: orders.length,
            transactionId: payment.transactionId,
            status: payment.status,
        });
    });
}

/**
 * Resolve a checkout handle, or refuse the way every other screen does.
 *
 * ⚠ **The kind is named on the read.** `read('co', …)` refuses a `pl` or `pd` handle by
 * construction — and that is the load-bearing direction: a listing handle is handed out
 * freely, appears in a chat and may be forwarded, so it must not be replayable against the one
 * endpoint that can spend money.
 *
 * One refusal bucket for unknown, lapsed, malformed and wrong-kind: all four have the same
 * remedy, and separating them would confirm to a caller that a handle it does not own is real.
 */
async function readCheckout(handle: string): Promise<Extract<InAppSurfaceSession, { kind: 'co' }>> {
    const session = await inAppSurfaceStore.read('co', handle);
    if (!session) {
        throw createAppError(
            ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
            404,
            'That checkout is no longer held',
        );
    }
    return session;
}

/**
 * Refuse a checkout whose basket has gone or been replaced since the screen opened.
 *
 * ⚠ **410, and the status is the whole point** — see the header. `co.html` renders 404 and 410
 * as `copy.expired`, which says "ask me again in the chat and I will open a fresh one" in the
 * customer's own language. Any other status would render our English.
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
): void {
    if (cart.items.length === 0 || !cart.cartId) {
        throw createAppError(ERROR_CODES.CART_EMPTY_CHECKOUT, 410, 'That basket is no longer there');
    }
    if (session.cartId && session.cartId !== cart.cartId) {
        throw createAppError(ERROR_CODES.CART_EMPTY_CHECKOUT, 410, 'That basket has been replaced');
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
): Promise<{ text: string } | null> {
    if (cart.productType === 'digital') {
        return { text: accountIdentifier(customer) };
    }

    const addresses = customer.saved_addresses ?? [];
    const chosen = addresses.find((address) => address.is_default) ?? addresses[0] ?? null;
    if (!chosen?.geo) return null;

    return { text: maskAddress(chosen) };
}

/**
 * The number the charge will go to, **masked**, or null when the customer has none on file.
 *
 * ⚠ **This is a PLACEHOLDER on the page, never a value**, which is what makes the common case
 * one tap and no disclosure: the customer sees enough to confirm it is the right wallet, the
 * page never holds the number, and submitting the field empty means "use that one". A forwarded
 * URL therefore discloses a masked tail and cannot be used to learn a payable number.
 */
async function maskedPayerNumber(customer: ICustomer): Promise<string | null> {
    const stored = await storedPayerNumber(customer);
    return stored ? maskPhone(stored) : null;
}

/**
 * The number on the account, in full — **server-side only.**
 *
 * ⚠ **A saved wallet first, the profile phone second.** The wallet is the number the customer
 * deliberately nominated for paying; the profile phone is the number they sign in with, and the
 * two are frequently different handsets. Charging the login number when a wallet exists would
 * push the prompt to the wrong device.
 *
 * ⚠ **`gateway_customer_id` IS the phone number for a mobile-money method** — the customer API
 * stores the E.164 value as both gateway ids and returns neither on any endpoint. That rule is
 * inherited whole: it is read here to charge, and it leaves this process only masked.
 *
 * ⚠ **The REPOSITORY, not `paymentMethodService`, and the difference is the point.** That
 * service projects to `PaymentMethodDto`, which deliberately omits both gateway ids — the rule
 * that keeps a saved wallet's number unreadable through every API. Nothing here breaks that:
 * the number is read to open a charge and is published only through `maskedPayerNumber`.
 *
 * ⚠ **EXPORTED, and it must stay the only answer to "which wallet gets charged".**
 * `bot-checkout.controller.ts` re-opens a charge from the chat when a customer asks to try
 * again, and a second implementation of this fallback there would mean the screen and the chat
 * pushing the prompt to two different handsets for one customer — discovered by them, at the
 * moment they are trying to pay. Both are Stream D's files precisely so this stays one rule.
 */
export async function storedPayerNumber(customer: ICustomer): Promise<string | null> {
    /** Already sorted default-first, then newest, by the repository itself. */
    const methods = await paymentMethods.list('customer', String(customer._id));
    const wallet = methods.find((method) => method.method_type === 'mobile_money') ?? null;

    const number = wallet?.gateway_customer_id?.trim();
    if (number) return number;

    return customer.phone?.trim() || null;
}

/**
 * Which mobile-money gateway this deployment charges through.
 *
 * ⚠ **Chosen here rather than by the page, and that is not a detail.** Every other entry point
 * takes the gateway from its caller — the storefront names one, the billing module names one —
 * because those callers are the platform's own code. This one's caller is a browser, and a
 * gateway name arriving from a browser is a caller choosing where a stranger's money goes.
 *
 * ⚠ **NotchPay first, deliberately and not alphabetically.** It is the gateway with a working
 * refund integration and a real webhook secret, so a payment taken through it can be reversed
 * by an administrator; My-CoolPay has no refund API at all. When both are configured, the one
 * that can be undone is the one to use.
 *
 * Neither configured is a **configuration** state rather than a fault, and it is refused as
 * such: the deployment cannot take mobile money, and no amount of retrying by the customer
 * changes that.
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

