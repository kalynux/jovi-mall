import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendMessage, sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CartService } from '../../cart/services/cart.service';
import { cartQuoteService } from '../../orders/services/cart-quote.service';
import { OrderService } from '../../orders/order.service';
import { PaymentTransactionModel } from '../../payments/models/payment-transaction.model';
import { payLinkService } from '../../payments/services/pay-link.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { addedToCartActions } from './bot-purchase.controller';
import {
    BotCartAddItemSchema,
    BotCartQuoteSchema,
    BotCartSetQuantitySchema,
    BotCheckoutSchema,
    BotNoArgsSchema,
    BotTransactionParamSchema,
    BotVariantParamSchema,
} from '../validators/bot.validators';

const cartService = new CartService();
const orderService = new OrderService();

/**
 * Cart, checkout and the payment receipt.
 *
 * Every handler delegates to the SAME service the customer API calls, with the same
 * customer id. No business logic is duplicated here and none may be added: the stock
 * semantics, the mixed-product-type rule, the COD gates and the delivery-address
 * requirement all stay where the storefront already exercises them, so the two doors
 * cannot disagree about what a cart is.
 */
export class BotCartController {
    /** `POST /cart/get` — the current cart, or an empty one. */
    static get = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const cart = await cartService.getCart(botCallerOf(req).customerId);
        sendSuccess(res, cart);
    });

    /**
     * `POST /cart/items` — add a variant, or increment it.
     *
     * ⚠ **This ADDS to the line rather than setting it**, exactly as the customer API's
     * `POST /customer/cart/items` does. It is the reason the surface demands an
     * `Idempotency-Key`: a retried chat message would otherwise put two of something in
     * a basket, and the customer would find out at checkout.
     */
    static addItem = asyncHandler(async (req: Request, res: Response) => {
        const { productId, variantId, quantity, negotiationLockRef } =
            BotCartAddItemSchema.parse(req.body ?? {});
        const cart = await cartService.addToCart(
            botCallerOf(req).customerId,
            productId,
            variantId,
            quantity,
            undefined, // currency — the service's own default, as before
            negotiationLockRef,
        );

        /**
         * ⚠ **THE SAME THREE BUTTONS A TAP PRODUCES — View cart · Checkout · Browse more.**
         *
         * A customer reaches a basket two ways: they tap "Add to cart" under a product, or they
         * type "add two of the blue ones". Only the first used to get follow-up buttons, so the
         * customer who typed had to type "checkout" as well — which is the magic-word problem
         * § 14.6 abolished, arrived at from the other side.
         *
         * ⭐ **The repeated sentence below is DELIBERATE and owner-chosen (2026-09-16).** The
         * model has just written its own reply ("Done, two blue shirts are in your basket") and
         * this adds "Added to your cart" underneath it, so the customer reads much the same
         * thing twice. The alternative put to the owner was a new neutral line ("What next?")
         * that would repeat nothing; they chose the extra sentence over the extra phrase.
         *
         * ⚠ **So do not "tidy" this** into a neutral line, and do not delete the reply to stop
         * the repetition. Either one silently reverses a decision that was taken with the
         * trade-off in front of it. The buttons are the point; the duplication is its accepted
         * cost.
         *
         * The action list is imported rather than rebuilt: two copies is how one door grows a
         * fourth button or loses Checkout with nothing failing.
         */
        const language = botResponseLanguageOf(req);
        setBotReply(req, {
            kind: 'text',
            text: botChrome('addedToCart', language),
            actions: addedToCartActions(language),
        });

        sendSuccess(res, cart);
    });

    /** `PATCH /cart/items/:variantId` — set a line to an absolute quantity. */
    static setItemQuantity = asyncHandler(async (req: Request, res: Response) => {
        const { variantId } = BotVariantParamSchema.parse(req.params);
        const { quantity } = BotCartSetQuantitySchema.parse(req.body ?? {});
        const cart = await cartService.setItemQuantity(botCallerOf(req).customerId, variantId, quantity);
        sendSuccess(res, cart);
    });

    /**
     * `DELETE /cart/items/:variantId` — remove ONE line.
     *
     * ⚠ The customer API also has a product-keyed delete that removes every variant of a
     * product — every size of a garment at once. It is deliberately NOT exposed here.
     * "Remove the blue shirt" is a sentence a model could reasonably map onto either, and
     * the destructive reading is the one nobody asked for.
     */
    static removeItem = asyncHandler(async (req: Request, res: Response) => {
        const { variantId } = BotVariantParamSchema.parse(req.params);
        const cart = await cartService.removeVariantFromCart(botCallerOf(req).customerId, variantId);
        sendSuccess(res, cart);
    });

    /** `DELETE /cart` — discard every line. Nothing recovers it. */
    static clear = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        await cartService.clearCart(botCallerOf(req).customerId);
        // `{ success, data: null, message }` — the catalogue reads this tool's result from
        // `body`, not `body.data`, because the message IS the result.
        sendMessage(res, 'Cart cleared');
    });

    /**
     * `POST /cart/quote` — what this cart will cost.
     *
     * Sending `deliveryAddressId` also VALIDATES it, against the same rule checkout
     * applies. That is the point of quoting before confirming in a chat: learning that an
     * address has no geocoded location here costs one message, and learning it at the pay
     * button costs the whole conversation.
     */
    static quote = asyncHandler(async (req: Request, res: Response) => {
        const { deliveryAddressId } = BotCartQuoteSchema.parse(req.body ?? {});
        const quote = await cartQuoteService.quoteForCustomer(
            botCallerOf(req).customerId,
            deliveryAddressId,
        );
        sendSuccess(res, quote);
    });

    /**
     * `POST /checkout` — turn the cart into one order per vendor.
     *
     * ⚠ **The route GAP-001 says must not ship without idempotency.** It is not idempotent
     * underneath: a retried call creates a second set of orders AND a second thirty-minute
     * stock hold, and neither is visible to the customer until they are asked to pay
     * twice. `botIdempotency` makes the retry safe; nothing here does.
     *
     * `deliveryAddressId` is required, unlike on the customer API — see the schema for why
     * a default address is the wrong behaviour in a chat.
     *
     * The 201 mirrors the customer endpoint's body exactly, including the message that
     * distinguishes a COD checkout (no payment call needed) from an online one.
     */
    static checkout = asyncHandler(async (req: Request, res: Response) => {
        const { paymentMethod, deliveryAddressId } = BotCheckoutSchema.parse(req.body ?? {});

        const { cartId, orders } = await orderService.createOrdersFromCart(
            botCallerOf(req).customerId,
            paymentMethod,
            { addressId: deliveryAddressId, address: null },
        );

        sendSuccess(res, {
            cartId,
            paymentMethod,
            orders: orders.map((order) => ({
                id: order._id.toString(),
                orderNumber: order.order_number,
                vendorId: order.vendor_id.toString(),
                orderType: order.order_type,
                total: order.total_amount,
                currency: order.currency,
                paymentMethod: order.payment_method,
                paymentStatus: order.payment_status,
                fulfillmentStatus: order.fulfillment_status,
                itemCount: order.items.length,
            })),
        }, {
            status: 201,
            message: paymentMethod === 'cash_on_delivery'
                ? 'Orders created. Pay the delivery agent in cash at handoff — you will receive a delivery code for each shipment.'
                : 'Orders created. Complete payment for the cart to proceed.',
        });
    });

    /**
     * `POST /payments/:transactionId` — one payment record, owner-scoped.
     *
     * ⚠ **Answers `{ success, transaction }`, NOT the `{ success, data }` envelope**, and
     * that is deliberate rather than sloppy: it mirrors `GET /api/payments/:transactionId`
     * byte for byte, and the catalogue reads this tool from `body.transaction`. A second
     * shape for one record is a second thing for a client to get wrong.
     *
     * ⚠ **Ownership is enforced here rather than inherited.** The customer route accepts
     * either id on `transaction.userId` — order and cart payments store the CUSTOMER id
     * while booking payments store the USER id — and exempts admins. This surface has no
     * admin to exempt and must accept both ids for the same reason, so the check is
     * repeated rather than reached: a bot request is not a session, and there is no
     * `req.auth` for that route's predicate to read.
     *
     * A transaction that is not theirs 404s rather than 403s. Transaction ids are the only
     * thing between one customer and another's payment record, so confirming that an id
     * exists is itself the disclosure.
     */
    static getTransaction = asyncHandler(async (req: Request, res: Response) => {
        const { transactionId } = BotTransactionParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        if (!Types.ObjectId.isValid(transactionId)) {
            throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
        }

        const transaction = await PaymentTransactionModel.findById(transactionId)
            .select('-rawGatewayPayloads')
            .lean();

        const owner = transaction?.userId?.toString();
        if (!transaction || (owner !== caller.customerId && owner !== caller.userId)) {
            throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
        }

        res.status(200).json({ success: true, transaction });
    });

    /**
     * `POST /payments/:transactionId/pay-link` — a page the customer can pay a CARD on (GAP-008).
     *
     * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────
     * Mobile money completes entirely in chat — a USSD prompt, or an OTP typed back — and is
     * the dominant local method. A card cannot: `POST /api/payments/initiate` with
     * `gateway: 'STRIPE'` answers a client secret, and only Stripe.js in a browser can
     * confirm one. This mints the handle for the page that does it.
     *
     * ⚠ **Owner-scoped, and that is what makes it safe to reach from a chat.** Minting turns
     * a transaction id into a live, unauthenticated payment page, so only the customer whose
     * payment it is may ask. The check is repeated from `getTransaction` above rather than
     * shared with the customer route's predicate, for the same reason that one is: a bot
     * request is not a session and there is no `req.auth` for it to read.
     *
     * ⚠ **A second call REVOKES the first.** At most one link per transaction is live, which
     * is what makes "the customer lost the message, send it again" safe — and is also why
     * this row is `mutating` in the route table despite changing nothing the customer owns.
     *
     * `url` comes back null when `STOREFRONT_URL` is unset. The automation layer must treat
     * that as "cards are not available here" and offer mobile money, rather than sending a
     * message with a missing link in it.
     */
    static createPayLink = asyncHandler(async (req: Request, res: Response) => {
        const { transactionId } = BotTransactionParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        if (!Types.ObjectId.isValid(transactionId)) {
            throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
        }

        const transaction = await PaymentTransactionModel.findById(transactionId)
            .select('userId')
            .lean();

        const owner = transaction?.userId?.toString();
        if (!transaction || (owner !== caller.customerId && owner !== caller.userId)) {
            throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
        }

        const link = await payLinkService.mint(transactionId);

        /**
         * ⚠ **No `url` means NO REPLY, deliberately.** `mint` answers a null url when
         * `STOREFRONT_URL` is unset, and this route's own contract already says the caller
         * must read that as "cards are not available here" and offer mobile money instead.
         * Rendering a button with an empty href would turn a configuration gap into a dead
         * control in front of somebody trying to pay — the one message on this surface where
         * a broken widget costs an order.
         */
        if (link.url) {
            const language = botResponseLanguageOf(req);
            setBotReply(req, {
                kind: 'link',
                text: botChrome('payPrompt', language),
                label: botChrome('payButton', language),
                url: link.url,
            });
        }

        sendSuccess(res, link);
    });
}
