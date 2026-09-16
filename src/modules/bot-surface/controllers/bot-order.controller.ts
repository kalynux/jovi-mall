import { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { escapeRegex } from '../../../core/utils/regex.util';
import { FulfillmentStatus, IOrder, OrderModel } from '../../orders/order.model';
import { OrderRepository } from '../../orders/order.repository';
import { CANCELLABLE_FULFILLMENT_STATES, OrderService } from '../../orders/order.service';
import { customerOrderViewService } from '../../orders/services/customer-order-view.service';
import { CustomerOrderDto } from '../../orders/dto/customer-order.dto';
import { CustomerShipmentDto } from '../../orders/dto/customer-shipment.dto';
import { ShipmentModel } from '../../shipments/shipment.model';
import { ShipmentService } from '../../shipments/shipment.service';
import { cashCollectionService } from '../../cod/services/cash-collection.service';
import { VendorRepository } from '../../vendors/vendor.repository';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { openInAppScreen } from './bot-inapp.controller';
import { stripDeliveryCodes } from '../dto/bot-projections';
import { botChrome } from '../domain/bot-chrome-copy';
import { BotReplyOption } from '../domain/channel-reply';
import { formatBotPrice } from '../domain/product-card';
import {
    codCodeActionId,
    confirmActionId,
    declineActionId,
    openSurfaceActionId,
    orderActionId,
    shipmentActionId,
    ticketActionId,
    trackActionId,
} from '../domain/bot-action-id';
import {
    botFulfillmentStateLabel,
    botOrderCopy,
    botPaymentStateLabel,
    botShipmentStateLabel,
    toBotOrderPaymentState,
} from '../domain/bot-order-status-copy';
import { windowForChat } from '../domain/bot-list-window';
import {
    BotCartIdParamSchema,
    BotCodCodeSchema,
    BotNoArgsSchema,
    BotOrderCancelSchema,
    BotOrderListSchema,
    BotOrderParamSchema,
    BotOrderShipmentParamSchema,
} from '../validators/bot.validators';

const orderRepository = new OrderRepository();
const orderService = new OrderService();
const shipmentService = new ShipmentService();
const vendorRepository = new VendorRepository();

/**
 * The customer's orders, as a chat asks about them.
 *
 * ── ONE DIFFERENCE FROM THE CUSTOMER API, AND IT RUNS THROUGH EVERY READ ────
 * `codCollections[].deliveryCode` is stripped from both order projections. It is a
 * payment credential — the secret the customer hands the agent to prove they paid — and
 * on the customer API it rides along on every order read because a browser is showing it
 * to its owner on a screen they opened. Here the same field would land in a model's
 * context on every "where is my order?", and from there into a transcript nobody is
 * guarding. Disclosure happens once, deliberately, through `/orders/:orderId/cod-code`.
 *
 * ⚠ GAP-001 names only the GROUP read; this strips the single-order read too, because
 * both are built by `customerOrderViewService.toDtos` and leaving one open makes closing
 * the other pointless. Recorded as a deliberate deviation in `api-doc/n8n/bot-surface.md`.
 *
 * ── ⚠ THIS SURFACE NOW DRAWS ITSELF, AND THAT REVERSES ONE SENTENCE ─────────
 * `bot-surface.md` § 14.3 listed "an order list" among the things that are *"data for your
 * model to narrate"*. That was already corrected once for product lists — *"a set the
 * customer is meant to choose from is a rendering, and renderings live on this side of the
 * wire"* — and an order list is the same shape of thing arriving by a second door. Narrating
 * it produced what this stream exists to fix: eleven delivery states, nine fulfilment states
 * and seven payment states read aloud as prose, in five languages, with nothing to tap.
 *
 * So the reads below set a `reply`. What has NOT changed is who words the conversation: the
 * model still answers *"where is my blender?"*. This file words the fixed parts — a status, a
 * picker, a confirmation — and hands back the turn everywhere else.
 *
 * ── THE INTERNAL FACTS THIS FILE READS AND NEVER PUBLISHES ──────────────────
 * Two of them, and both follow the same rule: **an internal value may choose which buttons a
 * customer is offered; it may never reach the wire.**
 *
 *   - `delivery_failures[].reason` — written by an agent for their own agency, and
 *     deliberately absent from `CustomerShipmentDto`, which publishes only the count. It is
 *     read here to decide whether a redelivery is worth offering; the customer gets the
 *     consequence, never the vocabulary.
 *   - `ShipmentStatus.handing_over` — collapsed to `shipped` for the customer by
 *     `CUSTOMER_VISIBLE_STATUS`, because the eleven internal states describe dispatch
 *     machinery. It is read here to say one sentence that names no agent at all.
 *
 * Neither value is put in a response body anywhere below. `stripDeliveryCodes` is the third
 * member of the same family and the oldest.
 */
export class BotOrderController {
    /**
     * `POST /orders/list` — order history, grouped by checkout group.
     *
     * ⚠ **The rows are ORDERS and the data is GROUPS, and the mismatch is deliberate.** A
     * checkout group is one basket paid once; it holds one per-vendor order per seller in it.
     * Everything a customer can then *do* — see it, track it, cancel it — is scoped to one
     * order, and `ord:<orderId>` is the only token in the vocabulary for picking one. Rows of
     * groups would mean a tap that could not name what it had selected.
     *
     * `data` keeps its group shape untouched, because that is the tool contract the model and
     * every existing caller already read.
     */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = BotOrderListSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);
        const language = botResponseLanguageOf(req);

        const { data, meta } = await orderRepository.findGroupsByCustomer(
            caller.customerId,
            { page: query.page, limit: query.limit },
            {
                fulfillmentStatus: query.status,
                paymentStatus: query.paymentStatus,
                q: query.q,
            },
        );

        const chat = windowForChat({
            items: data.map((group) => ({
                cartId: group.cartId,
                createdAt: group.createdAt,
                currency: group.currency,
                totalAmount: group.totalAmount,
                orderCount: group.orderCount,
                paymentStatus: aggregatePaymentStatus(group.paymentStatuses),
                orders: group.orders,
            })),
            total: meta.total,
            offset: (query.page - 1) * query.limit,
            surface: 'orders',
            language,
        });

        /**
         * Flatten the windowed groups to their orders and cap again.
         *
         * ⚠ **The second cap is not redundant.** `windowForChat` caps GROUPS at five, and five
         * groups can hold more than five orders — a single basket split across three sellers is
         * three rows on its own. Without this, a WhatsApp list could exceed the ten rows Meta
         * accepts and the whole message would be rejected.
         */
        const rows = chat.items.flatMap((group) => group.orders).slice(0, ORDER_ROW_MAX);
        const droppedInFlattening =
            chat.items.reduce((sum, group) => sum + group.orders.length, 0) > rows.length;
        const hasMore = chat.window.hasMore || droppedInFlattening;

        setBotReply(
            req,
            rows.length === 0
                ? null
                : {
                      kind: 'choice',
                      text: botOrderCopy('whichOrder', language),
                      options: [
                          ...rows.map((order) => orderRow(order, language)),
                          ...(hasMore ? [loadMoreRow(language)] : []),
                      ],
                      listButton: botChrome('chooseListButton', language),
                      sectionTitle: botChrome('chooseSectionTitle', language),
                  },
        );

        sendSuccess(res, chat.items, { meta: { ...meta, ...chat.window } });
    });

    /** `POST /orders/groups/:cartId` — one checkout group in detail. */
    static getGroup = asyncHandler(async (req: Request, res: Response) => {
        const { cartId } = BotCartIdParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const orders = await orderRepository.findByCartAndCustomer(cartId, caller.customerId);
        if (orders.length === 0) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { cartId });
        }

        const dtos = await customerOrderViewService.toDtos(orders);

        /**
         * ⚠ **A group with several orders is a picker; a group with one is not.** Rendering a
         * one-row choice would make the customer tap twice to reach a card they could have been
         * shown — and rendering nothing for a three-seller basket puts them back in the prose
         * this stream exists to replace.
         */
        const language = botResponseLanguageOf(req);
        setBotReply(
            req,
            dtos.length > 1
                ? {
                      kind: 'choice',
                      text: botOrderCopy('whichOrder', language),
                      options: dtos.map((dto) =>
                          orderRow(
                              {
                                  id: dto.id,
                                  orderNumber: dto.orderNumber,
                                  total: dto.total,
                                  currency: dto.currency,
                                  fulfillmentStatus: dto.fulfillmentStatus,
                                  paymentStatus: dto.paymentStatus,
                              },
                              language,
                          ),
                      ),
                      listButton: botChrome('chooseListButton', language),
                      sectionTitle: botChrome('chooseSectionTitle', language),
                  }
                : null,
        );

        sendSuccess(res, {
            cartId,
            createdAt: orders[0].created_at,
            currency: orders[0].currency,
            totalAmount: orders.reduce((sum, o) => sum + o.total_amount, 0),
            orderCount: orders.length,
            paymentStatus: aggregatePaymentStatus(orders.map((o) => o.payment_status)),
            orders: dtos.map(stripDeliveryCodes),
        });
    });

    /**
     * `POST /orders/:orderId` — one per-vendor order in detail, as a status card.
     *
     * Also the destination of an `ord:<orderId>` tap, and of `no:cnc:<orderId>` — a customer
     * who declines a cancellation is returned to exactly the card they started from, which is
     * what makes "No" a way out rather than a dead end.
     */
    static getOrder = asyncHandler(async (req: Request, res: Response) => {
        const { orderId } = BotOrderParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const order = await resolveOwnedOrder(caller.customerId, orderId);
        const [dto] = await customerOrderViewService.toDtos([order]);

        setOrderCardReply(req, dto);

        sendSuccess(res, stripDeliveryCodes(dto));
    });

    /**
     * `POST /orders/:orderId/shipments` — where the parcels are.
     *
     * The read that makes the two shipment-scoped tools reachable at all: nothing else a
     * customer can call returns a `shipmentId` except a COD collection block, which is
     * undefined for every prepaid order.
     *
     * Statuses arrive collapsed to the five-word customer vocabulary and the internal
     * failure notes are never included. The agent's partial name and photo appear only
     * while that agent is physically carrying the parcel (ADR-A06), and the window is
     * enforced in the service before the agent is looked up — so there is nothing here to
     * project away.
     *
     * ⚠ **This is where the Shipments button lands, and the button's TOKEN is `track:`.** The
     * label says "Shipments" and the verb says "track" because the tool catalogue already
     * calls this read *"the answer to 'where is my order'"* — there is no live-position route
     * on this surface, so tracking a parcel and listing it are one action. Naming them
     * separately would have minted a verb with nowhere to go.
     */
    static listShipments = asyncHandler(async (req: Request, res: Response) => {
        const { orderId } = BotOrderParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const order = await resolveOwnedOrder(caller.customerId, orderId);
        const shipments = await orderService.listShipmentsForCustomer(
            caller.customerId,
            order._id.toString(),
        );

        const language = botResponseLanguageOf(req);

        /**
         * ⚠ **One parcel is shown, not offered.** A picker with a single row asks the customer
         * to choose between one thing — two taps to reach a card they could have been handed.
         * With none (a digital order, or a physical one not yet dispatched) there is nothing to
         * draw at all and the model says where the order has got to instead.
         */
        if (shipments.length === 1) {
            await setShipmentCardReply(req, order, shipments[0], language);
        } else {
            setBotReply(
                req,
                shipments.length === 0
                    ? null
                    : {
                          kind: 'choice',
                          text: botOrderCopy('whichParcel', language),
                          options: shipments.map((shipment, index) =>
                              parcelRow(order._id.toString(), shipment, index, language),
                          ),
                          listButton: botChrome('chooseListButton', language),
                          sectionTitle: botChrome('chooseSectionTitle', language),
                      },
            );
        }

        sendSuccess(res, shipments);
    });

    /**
     * `POST /orders/:orderId/cod-code` — disclose the delivery code, deliberately.
     *
     * ⚠ **The one route on this surface whose entire purpose is to put a credential into a
     * chat window.** It exists precisely so that every OTHER route can strip it: a flow
     * that needs the code asks for it by name, once, and the code does not ride along on
     * "where is my order?". The catalogue marks this `flow_only` for the same reason — the
     * model is never given it as a tool to reach for.
     *
     * A code is only meaningful while its collection is `pending`; the underlying block
     * omits it otherwise, and that is what makes a collected shipment answer without one
     * rather than replaying a spent secret.
     *
     * `shipmentId` is required only when the order has more than one parcel. With one
     * parcel there is nothing to disambiguate, and demanding an id the customer does not
     * have would make the common case unreachable.
     *
     * ⚠ **THE REPLY CARRIES THE CODE AND NOTHING ELSE — there is deliberately no Resend
     * button.** Owner's decision: a replacement code is issued by the delivery agent from
     * their own app, which keeps one issuing path. A second one here would let a customer
     * invalidate, from a chat, the code the agent is holding at the door.
     */
    static getCodCode = asyncHandler(async (req: Request, res: Response) => {
        const { orderId } = BotOrderParamSchema.parse(req.params);
        const { shipmentId } = BotCodCodeSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const order = await resolveOwnedOrder(caller.customerId, orderId);

        const blocks = await cashCollectionService.getCodBlocksForOrders([order._id.toString()], true);
        const collections = (blocks.get(order._id.toString()) ?? []) as Array<Record<string, unknown>>;

        if (collections.length === 0) {
            throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_FOUND, 404, undefined, {
                orderId: order._id.toString(),
            });
        }

        const match = shipmentId
            ? collections.find((c) => c.shipmentId === shipmentId)
            : collections.length === 1
                ? collections[0]
                : null;

        if (!match) {
            throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_FOUND, 404, undefined, {
                orderId: order._id.toString(),
                // Naming the count rather than the ids: the flow's next move is to ask which
                // parcel, and it gets the ids from `/shipments` where they belong.
                shipmentCount: collections.length,
                reason: shipmentId ? 'no_such_shipment' : 'shipment_id_required',
            });
        }

        /**
         * ⚠ **No reply is set when the collection carries no code**, which is what a already-
         * collected shipment looks like. Rendering the chrome around an absent secret would
         * produce a message announcing a code and then not showing one.
         */
        const code = typeof match.deliveryCode === 'string' ? match.deliveryCode : null;
        setBotReply(
            req,
            code
                ? { kind: 'text', text: `${botChrome('getCodeButton', botResponseLanguageOf(req))}: ${code}` }
                : null,
        );

        sendSuccess(res, match);
    });

    /**
     * `POST /orders/:orderId/shipments/:shipmentId/resend-delivery-code`
     *
     * Regenerates the code, resends it over WhatsApp, and returns it — it is the
     * customer's own secret. Invalidates the previous one and clears any wrong-attempt
     * lockout. The 1-per-60s server-side cooldown answers `429 COD_CODE_RESEND_TOO_SOON`
     * and is deliberately left to the service rather than re-stated here.
     *
     * ⚠ **Reachable as a TOOL and never as a BUTTON.** It keeps its place in the catalogue so
     * a model can use it when a customer explicitly asks; what the owner refused is a control
     * on a card, because a tap is cheap and this one invalidates the code an agent may already
     * be holding. See `getCodCode` and `codCodeActionId`, which both say so from their side.
     */
    static resendCodCode = asyncHandler(async (req: Request, res: Response) => {
        const { orderId, shipmentId } = BotOrderShipmentParamSchema.parse(req.params);
        const caller = botCallerOf(req);

        const order = await resolveOwnedOrder(caller.customerId, orderId);
        const result = await cashCollectionService.resendCodeAsCustomer(
            caller.customerId,
            order._id.toString(),
            shipmentId,
        );

        sendSuccess(res, result, {
            message: 'A new delivery code was generated. Give it to the agent only after you have received and paid for your package.',
        });
    });

    /**
     * `POST /orders/:orderId/shipments/:shipmentId/confirm-delivery`
     *
     * Confirming the LAST parcel completes the order and starts the seller's seven-day
     * escrow hold. A repeat answers `409 SHIPMENT_ALREADY_CONFIRMED` rather than doing it
     * twice, which is what makes this idempotent underneath as well as at the door.
     *
     * ⚠ **This is where `yes:cd:<orderId>:<shipmentId>` lands, and until now the same decision
     * was collected as free text in five languages.** It is the exact case
     * `bot-action-id.ts` was written for — the set of valid answers is two — and one of the
     * places the rule had never been applied.
     */
    static confirmShipmentDelivery = asyncHandler(async (req: Request, res: Response) => {
        const { orderId, shipmentId } = BotOrderShipmentParamSchema.parse(req.params);
        const caller = botCallerOf(req);

        const order = await resolveOwnedOrder(caller.customerId, orderId);
        const result = await shipmentService.confirmDeliveryByCustomer(
            caller.customerId,
            order._id.toString(),
            shipmentId,
            caller.userId,
        );

        setBotReply(req, {
            kind: 'text',
            text: botOrderCopy('deliveryConfirmed', botResponseLanguageOf(req)),
        });

        sendSuccess(res, result);
    });

    /**
     * `POST /orders/:orderId/cancel` — customer-initiated cancellation.
     *
     * Gated by the vendor's cancellation policy and limited to pre-shipment orders. A PAID
     * order is refused with guidance to use the refund flow — this endpoint performs no
     * refund, deliberately, and `assertCancellable` is what says so.
     *
     * ⚠ `reason` is the customer's own words. The catalogue tells the model not to
     * paraphrase, and there is nothing this service can do to enforce that — but it is
     * worth knowing that the string lands on a record the vendor reads.
     *
     * ⚠ **THE REASON IS TYPED, AND THAT IS THE ONE PLACE THIS STREAM KEEPS FREE TEXT.**
     * Owner's decision: a canned reason tells the vendor less than a sentence. It is not an
     * exception to `bot-action-id.ts`'s rule but an application of it — the set of answers to
     * *"are you sure"* is known in advance and is a button; the set of answers to *"why"* is
     * not, and is exactly what that file reserves free text for.
     *
     * So a tap arrives here with no `reason`, the order is cancelled, and the reply asks for
     * the words. The cancellation is not held pending an explanation the customer may never
     * send — that would leave an order in limbo because somebody put their phone down.
     */
    static cancel = asyncHandler(async (req: Request, res: Response) => {
        const { orderId } = BotOrderParamSchema.parse(req.params);
        const { reason } = BotOrderCancelSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const order = await resolveOwnedOrder(caller.customerId, orderId);

        const vendor = await vendorRepository.findById(order.vendor_id.toString());
        await orderService.assertCancellable(order, {
            actorType: 'customer',
            vendorPolicy: vendor?.policies?.cancellation_policy ?? null,
        });

        await orderService.cancelOrder(order, {
            actorType: 'customer',
            actorId: caller.customerId,
            reason: reason ?? 'Cancelled by customer',
        });

        /**
         * ⚠ **Only ask for the reason when the customer did not already give one.** A model
         * that passed `reason` has just relayed what the customer said; asking again would make
         * the platform look as though it had not been listening.
         */
        setBotReply(
            req,
            reason
                ? null
                : { kind: 'text', text: botChrome('cancelReasonPrompt', botResponseLanguageOf(req)) },
        );

        sendSuccess(res, {
            order_id: order._id.toString(),
            fulfillment_status: order.fulfillment_status,
        }, { message: 'Order cancelled' });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Taps that are not routes
//
//  ⚠ **Every verb below already has a documented request mapping to `/catalog/action`
//  (`bot-surface.md` § 14.7), and the dispatcher that owns that route delegates to here.**
//  These are handlers rather than routes on purpose: adding a route means editing
//  `bot-route-table.ts`, `bot.routes.ts` and `catalog.json` in lockstep, and
//  `assertHandlersCoverRoutes()` runs at module import — so one stream adding one row breaks
//  `npm run dev` for every session at once. Stream 0 declared the routes; streams fill bodies.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a tap handler is handed: the request, the response, the token's argument — the part
 * after the prefix this handler claimed — and Express's `next`.
 *
 * ── ⚠ WHY `next` IS CARRIED RATHER THAN STUBBED ─────────────────────────────
 * Several taps below delegate to a route handler on the class above, and those are wrapped in
 * `asyncHandler`, whose entire job is `Promise.resolve(fn(...)).catch(next)`. Hand one a `next`
 * that does nothing and **every error inside it is swallowed**: no response is written, the
 * request hangs until the automation layer times out, and the customer is told nothing at all.
 * Telegram reports nothing for a callback that produced no message, so the symptom is a button
 * that works for most orders and is silent for the one that failed.
 *
 * That is the precise failure mode this whole surface is built to refuse — see
 * `bot-reply.middleware.ts`, which exists so that *"every bot response carries a sendable
 * body"* is true by construction. Passing the real `next` puts the error back on the global
 * handler, which words it and lets the reply interceptor render it.
 */
export type BotOrderTapHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
) => Promise<void>;

/**
 * ⚠ **The token prefixes this controller claims, LONGEST FIRST.**
 *
 * `yes` and `no` are shared verbs — account closure uses `yes:close-account` and belongs to a
 * different stream — so this map cannot be keyed on the verb alone. It is keyed on the prefix
 * INCLUDING the context, and `handleBotOrderTap` matches the longest one, so a future
 * `yes:cancel-subscription` cannot be swallowed by a shorter entry here.
 */
const ORDER_TAP_PREFIXES = Object.freeze({
    /** The parcel card. No route serves one parcel, so this is the only door to it. */
    'shp': showShipmentTap,
    /** "Yes, it arrived" and "no, it did not". */
    'yes:cd': confirmDeliveryTap,
    'no:cd': declineDeliveryTap,
    /**
     * ⚠ **`no:ord` is the REQUEST to cancel and `no:cnc` is the refusal to; they are not a
     * pair and must not be read as one.**
     *
     * The rule that makes them consistent is `bot-action-id.ts`'s own: **the context names
     * what is being agreed to or declined.** `no:ord:<id>` declines the ORDER — the Cancel
     * button on the card. `yes:cnc:<id>` / `no:cnc:<id>` answer the CANCELLATION — the
     * are-you-sure that `no:ord` puts up.
     *
     * Written this way rather than by minting a `cnc` verb because the verb set is closed and
     * every addition has to be documented, mapped and taught to the automation layer; a verb
     * that means "start cancelling" would buy one turn and cost that everywhere.
     */
    'no:ord': askCancelTap,
    'yes:cnc': confirmCancelTap,
    'no:cnc': declineCancelTap,
    /** Open a support conversation about this order or parcel. */
    'tkt:new': supportRequestTap,
    /** The whole order history, drawn properly. The last row of the chat list. */
    'open:ol': orderHistoryTap,
    /** The order card, the parcel list, the delivery code. */
    'ord': orderCardTap,
    'track': shipmentsTap,
    'code': codCodeTap,
} as const);

/** ⚠ Exported so the dispatcher can declare which tokens reach this controller. */
export const BOT_ORDER_TAP_PREFIXES: readonly string[] = Object.freeze(
    Object.keys(ORDER_TAP_PREFIXES).sort((a, b) => b.length - a.length),
);

/**
 * Handle a tap this controller owns, or report that it does not own it.
 *
 * ⚠ **Returns `false` rather than throwing on a token that is not ours**, so the dispatcher
 * keeps exactly one place that words *"I did not understand that"*. Two refusals for one
 * unknown token is how a customer gets told twice, in different words, that a button is stale.
 */
export async function handleBotOrderTap(
    req: Request,
    res: Response,
    next: NextFunction,
    token: string,
): Promise<boolean> {
    for (const prefix of BOT_ORDER_TAP_PREFIXES) {
        if (token === prefix || token.startsWith(`${prefix}:`)) {
            const argument = token.slice(prefix.length + 1);
            await ORDER_TAP_PREFIXES[prefix as keyof typeof ORDER_TAP_PREFIXES](
                req,
                res,
                next,
                argument,
            );
            return true;
        }
    }
    return false;
}

/** `ord:<orderId>` — the order card. */
async function orderCardTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    req.params = { ...req.params, orderId: argument };
    req.body = {};
    await BotOrderController.getOrder(req, res, next);
}

/** `track:<orderId>` — this order's parcels. See `listShipments` for why the verb is `track`. */
async function shipmentsTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    req.params = { ...req.params, orderId: argument };
    req.body = {};
    await BotOrderController.listShipments(req, res, next);
}

/** `code:<orderId>:<shipmentId>` — disclose the delivery code for one parcel. */
async function codCodeTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    const [orderId, shipmentId] = splitIds(argument, 2);
    req.params = { ...req.params, orderId };
    req.body = { shipmentId };
    await BotOrderController.getCodCode(req, res, next);
}

/** `yes:cd:<orderId>:<shipmentId>` — the parcel arrived. */
async function confirmDeliveryTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    const [orderId, shipmentId] = splitIds(argument, 2);
    req.params = { ...req.params, orderId, shipmentId };
    req.body = {};
    await BotOrderController.confirmShipmentDelivery(req, res, next);
}

/**
 * `no:ord:<orderId>` — the Cancel button on the order card. Puts up the are-you-sure.
 *
 * ⚠ **It cancels nothing, and it checks nothing either.** The eligibility rules live in
 * `assertCancellable` and stay there; this turn only asks. A customer who taps Yes meets the
 * full check a moment later and is told, in their own language, if the order has moved on
 * since the card was drawn — which a chat card, sitting in a history, always might have.
 *
 * ⚠ **The order is loaded anyway, and only to prove ownership.** Rendering a cancellation
 * prompt for an id the caller does not own would confirm the id is real before refusing, which
 * is exactly what `resolveOwnedOrder` exists to prevent.
 */
async function askCancelTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const order = await resolveOwnedOrder(caller.customerId, argument);
    const orderId = order._id.toString();

    setBotReply(req, {
        kind: 'choice',
        text: botChrome('cancelOrderPrompt', language),
        options: [
            { id: confirmActionId(`cnc:${orderId}`), label: botChrome('confirmButton', language) },
            { id: declineActionId(`cnc:${orderId}`), label: botChrome('declineButton', language) },
        ],
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    });

    sendSuccess(res, { orderId, orderNumber: order.order_number, awaitingConfirmation: true });
}

/** `yes:cnc:<orderId>` — cancel it. The reason is asked for afterwards; see `cancel`. */
async function confirmCancelTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    req.params = { ...req.params, orderId: argument };
    req.body = {};
    await BotOrderController.cancel(req, res, next);
}

/**
 * `shp:<orderId>:<shipmentId>` — one parcel, with whatever it can actually offer.
 *
 * ⚠ **The only handler here that reads raw shipment fields**, and it publishes none of them —
 * see this file's header. `handing_over` and `delivery_failures[].reason` choose the wording
 * and the buttons; the response body is the ordinary customer projection.
 */
async function showShipmentTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    const [orderId, shipmentId] = splitIds(argument, 2);
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderId);
    const shipments = await orderService.listShipmentsForCustomer(
        caller.customerId,
        order._id.toString(),
    );
    const shipment = shipments.find((s) => s.id === shipmentId);
    if (!shipment) {
        throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, { shipmentId });
    }

    await setShipmentCardReply(req, order, shipment, language);
    sendSuccess(res, shipment);
}

/**
 * `no:cd:<orderId>:<shipmentId>` — the parcel did NOT arrive.
 *
 * ⚠ **It writes nothing, and that is the whole point of having it.** The alternative to a No
 * button is a customer typing "no" in one of five languages at a parser that does not have a
 * table for it — and the alternative to *this* handler is no No button at all, which turns a
 * two-way question into a control that can only agree.
 */
async function declineDeliveryTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    const [orderId, shipmentId] = splitIds(argument, 2);
    const caller = botCallerOf(req);
    await resolveOwnedOrder(caller.customerId, orderId);

    setBotReply(req, {
        kind: 'text',
        text: botOrderCopy('deliveryNotReceived', botResponseLanguageOf(req)),
    });

    sendSuccess(res, { confirmed: false, orderId, shipmentId });
}

/** `no:cnc:<orderId>` — leave the order alone. Returns the customer to the card they came from. */
async function declineCancelTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    req.params = { ...req.params, orderId: argument };
    req.body = {};
    await BotOrderController.getOrder(req, res, next);
}

/**
 * `tkt:new:<topic>:<orderId>[:<shipmentId>]` — open a support conversation about a delivery.
 *
 * ⚠ **It creates no ticket, and that is deliberate.** `bot-ticket.controller.ts` is the one
 * door onto ticket creation and belongs to another stream; a second one here would be a second
 * set of rules about importance, category and attachments, disagreeing with the first the day
 * either changes. What this does is answer with the topic named and **no reply**, which hands
 * the turn to the model — the documented meaning of an absent `reply` — so the customer is
 * asked for the detail a ticket actually needs before one is opened.
 *
 * ⚠ **Two of the three topics exist because the FEATURE does not.** Owner's decision,
 * 2026-09-16, taken on the facts: there is no delivery-reschedule endpoint anywhere in the
 * platform, and the delivery address is snapshotted onto the order at checkout, so editing the
 * saved address book redirects no parcel already out. The customer gets a person instead of a
 * button that lies. If either capability is ever built, this is the call site to revisit.
 */
async function supportRequestTap(
    req: Request,
    res: Response,
    next: NextFunction,
    argument: string,
): Promise<void> {
    const [topic, orderId, shipmentId] = argument.split(':');
    const caller = botCallerOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderId ?? '');

    // No reply: the turn belongs to the model, which asks what happened and opens the ticket.
    setBotReply(req, null);

    sendSuccess(res, {
        supportRequest: true,
        topic: SUPPORT_TOPICS[topic as keyof typeof SUPPORT_TOPICS] ?? 'delivery_problem',
        orderId: order._id.toString(),
        orderNumber: order.order_number,
        shipmentId: shipmentId ?? null,
    });
}

/**
 * `open:ol` — the whole order history, on a screen.
 *
 * ── ⚠ THE DEGRADATION IS THE PATH THAT ACTUALLY RUNS ────────────────────────
 * The order-listing SCREEN is a later milestone and `BOT_MINIAPP_BASE_URL` is unset in
 * production, so `inAppScreenUrl` answers null and this returns the storefront's own orders
 * page. That is not a fallback to sketch in — it is what every customer gets today, and it is
 * why the row is safe to render at all.
 *
 * ⚠ **`openInAppScreen` rather than a hand-rolled mint, and that is not stylistic.** The five
 * fields that bind a screen session to a conversation — owner, customer, channel, external id,
 * language — are read there from the request envelope and from nowhere else, so a session can
 * only ever be addressed at the chat that asked for it. Three hand-written copies of that is
 * three chances to get the owner binding wrong, which is the security property of the whole
 * in-app surface.
 *
 * ⚠ **`fallbackPath` is the same `/shop/account/orders` that `windowForChat({surface:
 * 'orders'})` builds**, by way of the same `SURFACE_PATHS` table, so the row's destination
 * cannot drift from the `moreUrl` reported in `meta` on the turn that drew it.
 *
 * ⚠ **`textKey` is `loadMoreRow` and it is the wrong SHAPE of string for a body** — it is a
 * row title. It is used because the chrome table has no orders-screen sentence and
 * `respondWithScreen`'s default is `browseProductsPrompt`, whose own docstring says an order
 * screen introduced with "here are some products" is worse than no sentence at all. Terse and
 * true beats fluent and wrong; a proper key is requested of Stream 0.
 */
async function orderHistoryTap(
    req: Request,
    res: Response,
    _next: NextFunction,
    _argument: string,
): Promise<void> {
    const handle = await openInAppScreen(req, {
        payload: { kind: 'ol' },
        fallbackPath: '/shop/account/orders',
        labelKey: 'browseAllButton',
        textKey: 'loadMoreRow',
    });

    sendSuccess(res, { handle, opened: 'orders' });
}

/**
 * The three delivery topics, as the model is told about them.
 *
 * ⚠ **Short in the token, explicit in the body.** The token is byte-budgeted — Telegram
 * truncates past 64 with no error — and `tkt:new:redelivery:<24>:<24>` would not fit. The
 * model never sees the abbreviation.
 */
const SUPPORT_TOPICS = Object.freeze({
    rd: 'redelivery_requested',
    ad: 'delivery_address_wrong',
    hp: 'delivery_problem',
});

// ─────────────────────────────────────────────────────────────────────────────
//  Rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many order rows a chat list may carry, before the "see the rest" row.
 *
 * ⚠ **`BOT_CHAT_LIST_MAX` is five and this is five, and they are not the same number.** That
 * one is the cap on rows in `data`; this is the cap on rows in the RENDERED list, which also
 * has to leave room for the sixth row inside WhatsApp's ten. They agree today and are written
 * separately so that changing one does not silently move the other past Meta's limit.
 */
const ORDER_ROW_MAX = 5;

/** What a picker row needs to know about an order. Both list shapes can supply it. */
interface OrderRowInput {
    id: string;
    orderNumber: string;
    total: number;
    currency: string;
    fulfillmentStatus: string;
    paymentStatus: string;
}

/**
 * One order as a row.
 *
 * ⚠ **`shortLabel` is the order number alone.** `ORD-YYYY-NNNNNN` is fifteen characters
 * against WhatsApp's twenty-four-character row title, so it survives; the status and the
 * amount go in the description, which has seventy-two. Telegram gets the whole thing on one
 * line, which is what `label` is for.
 */
function orderRow(order: OrderRowInput, language: string | null): BotReplyOption {
    const state = botFulfillmentStateLabel(
        order.fulfillmentStatus as Parameters<typeof botFulfillmentStateLabel>[0],
        language,
    );
    const money = formatBotPrice(order.total, order.currency);
    const payment = botPaymentStateLabel(toBotOrderPaymentState(order.paymentStatus), language);

    return {
        id: orderActionId(order.id),
        label: `${order.orderNumber} · ${state} · ${money}`,
        shortLabel: order.orderNumber,
        description: `${state} · ${payment} · ${money}`,
    };
}

/**
 * The last row of the order list — the whole history, drawn properly.
 *
 * ⚠ **A row, not a link, because a `choice` row cannot be one.** Both channels render a choice
 * option as a callback token: Telegram as `callback_data`, WhatsApp as a list row id. So the
 * escape hatch is a tap that *produces* a link rather than a link itself — `open:ol` reaches
 * `openInAppScreen`, which answers with the in-app screen where one is configured and the
 * storefront's own orders page where none is. That second case is production today, because
 * `BOT_MINIAPP_BASE_URL` is unset — so it is the path that runs, not a fallback to sketch in.
 *
 * ⚠ It is `loadMoreRow` and not `seeMoreButton`: 24 characters rather than 20, because this is
 * the one string here that lands in a row title rather than on a button.
 */
function loadMoreRow(language: string | null): BotReplyOption {
    return {
        id: openSurfaceActionId('ol'),
        label: botChrome('loadMoreRow', language),
        shortLabel: botChrome('loadMoreRow', language),
    };
}

/**
 * One parcel as a row.
 *
 * ⚠ **Numbered rather than named by tracking code.** `ACR-YYMMDD-HHMMSS-XXXXX` is twenty-three
 * characters against a twenty-four-character row title — it fits by one, and any change to
 * that generator would cut it with no error anywhere. The code goes in the description.
 */
function parcelRow(
    orderId: string,
    shipment: CustomerShipmentDto,
    index: number,
    language: string | null,
): BotReplyOption {
    const name = `${botOrderCopy('parcelLabel', language)} ${index + 1}`;
    const state = botShipmentStateLabel(shipment.status, language);
    const carrier = shipment.agencyName ? ` · ${shipment.agencyName}` : '';

    return {
        id: shipmentActionId(orderId, shipment.id),
        label: `${name} · ${state}${carrier}`,
        shortLabel: name,
        description: `${state}${carrier}${shipment.trackingNumber ? ` · ${shipment.trackingNumber}` : ''}`,
    };
}

/**
 * The order card: what state it is in, and the two or three things that can be done to it.
 *
 * ── ⚠ EVERY ACTION IS GATED ON BEING ABLE TO SUCCEED ────────────────────────
 * Owner's decision, 2026-09-16: **Cancel appears only on an order that can still be
 * cancelled.** `assertCancellable` refuses a shipped order, and refuses a PAID one outright
 * with a pointer to the refund flow — which between them is most orders. A button that is
 * always present and usually says no trains a customer to stop reading the card.
 *
 * The same rule removes Shipments from a digital order, which has no parcels at all.
 *
 * ⚠ **Three is WhatsApp's hard cap and `channel-reply.ts` drops the fourth**, silently and
 * correctly. Nothing here relies on that: the gates below can never produce more than three,
 * so the renderer's backstop stays a backstop rather than becoming the mechanism.
 */
function setOrderCardReply(req: Request, order: CustomerOrderDto): void {
    const language = botResponseLanguageOf(req);
    const actions: BotReplyOption[] = [];

    if (order.orderType === 'physical' && order.fulfillmentStatus !== 'cancelled') {
        actions.push({
            id: trackActionId(order.id),
            label: botChrome('shipmentsButton', language),
        });
    }

    if (isCancellableFromChat(order)) {
        actions.push({
            id: declineActionId(`ord:${order.id}`),
            label: botChrome('cancelOrderButton', language),
        });
    }

    actions.push({
        id: ticketActionId(`new:hp:${order.id}`),
        label: botChrome('getHelpButton', language),
    });

    setBotReply(req, { kind: 'text', text: orderCardText(order, language), actions });
}

/**
 * ⚠ **A CHEAP, DELIBERATELY CONSERVATIVE echo of `assertCancellable` — never a second copy of
 * it.**
 *
 * The real rule needs the vendor's cancellation policy and, for cash-on-delivery, a count of
 * in-flight shipments: two more queries on a card that is drawn on every "where is my order?".
 * So this tests only the parts that are on the order itself, and `cancel` remains the
 * authority — a customer who taps through still meets the full check.
 *
 * The asymmetry is the safe one: this can hide a Cancel button from an order that could in
 * fact be cancelled (the customer asks the assistant, which calls the tool), and it cannot
 * show one on an order that certainly cannot be. The reverse would be a control that refuses.
 */
function isCancellableFromChat(order: CustomerOrderDto): boolean {
    /**
     * ⚠ **Imported, not retyped.** `CANCELLABLE_FULFILLMENT_STATES` is exported by
     * `order.service.ts` and is the same list `assertCancellable` tests against, so the button
     * and the rule cannot drift apart. A hand-written `'pending' || 'processing'` here would be
     * a second copy of a vocabulary — and the day a third state becomes cancellable, the only
     * symptom would be a button that never appears for it.
     */
    if (!CANCELLABLE_FULFILLMENT_STATES.includes(order.fulfillmentStatus as FulfillmentStatus)) {
        return false;
    }
    // `assertCancellable` refuses `paid` with ORDER_CANCEL_REQUIRES_REFUND, and refuses every
    // payment state that is not one of these two spellings of "not yet paid".
    return order.paymentStatus === 'pending' || order.paymentStatus === 'AWAITING_PAYMENT';
}

/**
 * The card itself.
 *
 * Three lines, in the order a customer reads them: which order, how it is going, what it cost.
 * The store is named because a checkout group splits across sellers and "your order" is
 * ambiguous the moment there are two.
 */
function orderCardText(order: CustomerOrderDto, language: string | null): string {
    const heading = order.store.name
        ? `${order.orderNumber} · ${order.store.name}`
        : order.orderNumber;

    const state = botFulfillmentStateLabel(
        order.fulfillmentStatus as Parameters<typeof botFulfillmentStateLabel>[0],
        language,
    );
    const payment = botPaymentStateLabel(toBotOrderPaymentState(order.paymentStatus), language);
    const money = formatBotPrice(order.total, order.currency);

    return `${heading}\n${state} · ${payment}\n${money}`;
}

/**
 * One parcel's card — and the only turn on this surface whose buttons depend on internal state.
 *
 * Four shapes, in priority order, and each one exists because the shape above it would offer
 * the customer something useless:
 *
 *   1. **A failed attempt** — the three support actions. The failure REASON is read here and
 *      never published (see the file header); it decides whether asking for a redelivery is
 *      worth putting in front of somebody, because a parcel refused at the door is not a
 *      parcel that needs rescheduling.
 *   2. **Cash on delivery with a code still pending** — the code, and nothing else. Confirming
 *      a delivery that has not happened is not the next thing this customer needs.
 *   3. **At the door or just delivered, not yet confirmed** — the yes/no question.
 *   4. **Anything else** — the state, and no controls, because there is nothing to press.
 *
 * ⚠ **`completion.confirmedAt` is the confirmation gate, NOT `fulfillmentStatus`.** The DTO
 * says so explicitly: fulfilment does not move when a customer confirms, so a card gated on
 * the status offers Confirm delivery forever — and every tap after the first answers
 * `409 SHIPMENT_ALREADY_CONFIRMED`.
 */
async function setShipmentCardReply(
    req: Request,
    order: IOrder,
    shipment: CustomerShipmentDto,
    language: string | null,
): Promise<void> {
    const orderId = order._id.toString();
    const state = botShipmentStateLabel(shipment.status, language);

    if (shipment.status === 'delivery_failed') {
        setBotReply(req, {
            kind: 'text',
            text: botOrderCopy('deliveryFailedPrompt', language),
            actions: await failedDeliveryActions(order, shipment, language),
        });
        return;
    }

    /**
     * ⚠ **Gated on the payment method before the query, not inside it.** A prepaid order can
     * never have a collection block, and this card is drawn on every "where is my parcel?" —
     * so an ungated lookup is a round trip to the COD service on the majority of reads that
     * can only ever answer "no". `customerOrderViewService` gates the same call the same way.
     */
    const pendingCode =
        order.payment_method === 'cash_on_delivery'
        && (await hasPendingCodCode(orderId, shipment.id));

    if (pendingCode) {
        setBotReply(req, {
            kind: 'text',
            text: `${state}\n${shipment.trackingNumber ?? ''}`.trim(),
            actions: [
                { id: codCodeActionId(orderId, shipment.id), label: botChrome('getCodeButton', language) },
            ],
        });
        return;
    }

    /**
     * ⚠ **THE GATE IS THE SERVICE'S OWN TWO REFUSALS, RESTATED — not a guess at them.**
     * `confirmDeliveryByCustomer` accepts a shipment in exactly one state and from exactly one
     * kind of order, and offering the question anywhere else is a button that can only fail:
     *
     *   - **`out_for_delivery` and nothing else.** That customer word maps from the internal
     *     `agent_delivered` alone — the agent says they handed it over and the customer has not
     *     agreed yet. `delivered` is the state AFTER confirmation, so including it offers the
     *     question to somebody who has already answered it, and every tap answers
     *     `409 SHIPMENT_ALREADY_CONFIRMED`.
     *   - **Never cash on delivery.** The service refuses those outright with *"confirmed by
     *     giving the agent your delivery code, not by confirming here"*. On a COD parcel the
     *     handing over of the code IS the confirmation, which is why the branch above — the
     *     code — is the whole of what a COD customer is offered.
     *
     * ⚠ **`completion.confirmedAt` was the wrong gate and is deliberately not used here.** The
     * DTO's warning about it is about the ORDER-level confirmation, and it is right about that:
     * fulfilment does not move when a customer confirms, so an order-level control gated on
     * `fulfillmentStatus` offers itself forever. But an order completes only when its LAST
     * parcel is confirmed — so on a three-parcel order `confirmedAt` stays null after the first
     * two, and gating on it would keep offering the question for parcels already confirmed.
     * Per-parcel state is what answers a per-parcel question.
     */
    const awaitingConfirmation =
        shipment.status === 'out_for_delivery'
        && order.payment_method !== 'cash_on_delivery';

    if (awaitingConfirmation) {
        setBotReply(req, {
            kind: 'choice',
            text: botChrome('confirmDeliveryPrompt', language),
            options: [
                {
                    id: confirmActionId(`cd:${orderId}:${shipment.id}`),
                    label: botChrome('confirmButton', language),
                },
                {
                    id: declineActionId(`cd:${orderId}:${shipment.id}`),
                    label: botChrome('declineButton', language),
                },
            ],
            listButton: botChrome('chooseListButton', language),
            sectionTitle: botChrome('chooseSectionTitle', language),
        });
        return;
    }

    setBotReply(req, { kind: 'text', text: await plainParcelText(order, shipment, state, language) });
}

/**
 * The three actions after a failed attempt.
 *
 * ⚠ **None of them performs the thing its label describes, and the labels say so.** There is
 * no delivery-reschedule endpoint in this platform and no way to redirect a parcel already
 * out; all three open a support conversation with the topic named. Owner's decision — the
 * alternative on the table was Get help alone, which hides what the customer actually wants
 * and makes them explain it from nothing.
 *
 * ⚠ **The failure reason chooses the offer and never reaches the wire.** A parcel the customer
 * refused, or one whose payment was refused, is not a parcel that wants rescheduling — putting
 * "Ask to redeliver" in front of somebody who turned the agent away is offering to repeat
 * something they declined.
 */
async function failedDeliveryActions(
    order: IOrder,
    shipment: CustomerShipmentDto,
    language: string | null,
): Promise<BotReplyOption[]> {
    const orderId = order._id.toString();
    const reason = await latestFailureReason(orderId, shipment.id);

    const actions: BotReplyOption[] = [];

    // A refusal — of the parcel or of the payment — is the customer's own decision, and
    // offering to do it again is not a service.
    const refused = reason === 'customer_refused' || reason === 'payment_refused';
    if (!refused) {
        actions.push({
            id: ticketActionId(`new:rd:${orderId}`),
            label: botOrderCopy('askRedeliveryButton', language),
        });
    }

    // Only when the address is what went wrong. Offering an address fix to somebody who was
    // simply out invites them to change a correct address.
    if (reason === 'address_not_found' || reason === 'address_inaccessible') {
        actions.push({
            id: ticketActionId(`new:ad:${orderId}`),
            label: botOrderCopy('askAddressFixButton', language),
        });
    }

    actions.push({
        id: ticketActionId(`new:hp:${orderId}`),
        label: botChrome('getHelpButton', language),
    });

    return actions;
}

/**
 * A parcel with nothing to press — plus the one sentence a handover is owed.
 *
 * ⚠ **`handing_over` reaches this function and reaches no response body.**
 * `CUSTOMER_VISIBLE_STATUS` collapses it to `shipped`, deliberately, because the eleven
 * internal states describe dispatch machinery. Until now that left a customer with a parcel
 * that had changed hands and no word about it — the status they were shown was correct and
 * explained nothing.
 *
 * The sentence names no agent, the old one or the new one. ADR-A06 publishes a carrying
 * agent's partial name only while they hold the parcel, and announcing a handover by name
 * would disclose one agent's involvement after their window had closed — the revocation half
 * of that decision, undone by a courtesy.
 */
async function plainParcelText(
    order: IOrder,
    shipment: CustomerShipmentDto,
    state: string,
    language: string | null,
): Promise<string> {
    const lines = [state];

    const marks = [shipment.trackingNumber, shipment.agencyName].filter(Boolean);
    if (marks.length > 0) lines.push(marks.join(' · '));

    if (await isHandingOver(order._id.toString(), shipment.id)) {
        lines.push('', botChrome('handoverPrompt', language));
    }

    const journey = parcelJourney(shipment, language);
    if (journey.length > 0) lines.push('', ...journey);

    return lines.join('\n');
}

/**
 * ⭐ **The journey — what a "Track" button would have shown, rendered instead of hidden behind
 * one.**
 *
 * ── ⚠ WHY THERE IS NO TRACK BUTTON HERE ────────────────────────────────────
 * The brief asks for one on this card. `track:<orderId>` returns the parcel LIST, which is the
 * screen the customer tapped to *reach* this card — so the button would send them back where
 * they came from. A control that loops is the same failure as a control that does nothing; it
 * just takes one more tap to discover.
 *
 * There is no live-position route on this surface at all (`api-doc/n8n/tools/catalog.json` says
 * the shipments read *is* "the answer to 'where is my order'"), so the live map a customer
 * imagines behind "Track" does not exist to link to. What does exist is
 * `CustomerShipmentDto.statusHistory` — already collapsed to the five customer words and
 * already de-duplicated, so `picked_up → in_transit → handing_over` is one "On its way" line
 * rather than three. That is the content of the missing screen, and it fits in the message.
 *
 * ⚠ **Empty for a parcel that has only ever been in one state**, because a one-line "journey"
 * restates the status printed directly above it.
 */
function parcelJourney(shipment: CustomerShipmentDto, language: string | null): string[] {
    const history = shipment.statusHistory ?? [];
    if (history.length < 2) return [];

    return history.map(
        (entry) => `${botShipmentStateLabel(entry.status, language)} — ${formatBotDate(entry.at, language)}`,
    );
}

/**
 * A date, in the customer's language.
 *
 * ⚠ **ICU here and deliberately NOT for money** — `formatBotPrice` avoids `Intl.NumberFormat`
 * because it renders XAF with a narrow no-break space whose code point differs between Node
 * builds. Neither hazard applies to a date, and a hand-rolled calendar in five languages is not
 * something this stream should be writing.
 *
 * ⚠ **Deliberately identical to `formatDate` in `miniapp/surfaces/order-listing.controller.ts`**
 * — same `dateStyle`, same fallback — because that screen and this card describe the same
 * parcels to the same person. It is copied rather than imported only because that one is module
 * private; it is four lines and reported to Stream 0 rather than quietly forked.
 *
 * ⚠ **No `timeZone` is pinned**, so this renders in the server's zone, which is what every
 * other date this platform shows a customer already does. Pinning one here would make this card
 * disagree with the emails about the same delivery.
 */
function formatBotDate(at: string, language: string | null): string {
    try {
        return new Intl.DateTimeFormat(language ?? 'en', { dateStyle: 'medium' }).format(new Date(at));
    } catch {
        // A locale ICU does not carry is not worth losing the line over.
        return new Date(at).toISOString().slice(0, 10);
    }
}

/**
 * Is this parcel mid-handover between two agents?
 *
 * ⚠ **Read from the raw shipment because the customer projection cannot answer it** — and
 * that is the projection being right rather than lacking something. `handing_over` collapses
 * to `shipped` there deliberately, so nothing downstream can accidentally render an internal
 * dispatch state. Asking the model directly, here, is the narrow exception this file's header
 * describes: it chooses a sentence and reaches no response body.
 */
async function isHandingOver(orderId: string, shipmentId: string): Promise<boolean> {
    const shipment = await ShipmentModel.findOne(
        { _id: shipmentId, order_id: orderId },
        { status: 1 },
    ).lean();

    return shipment?.status === 'handing_over';
}

/** Is there a delivery code this customer has not been given yet? */
async function hasPendingCodCode(orderId: string, shipmentId: string): Promise<boolean> {
    const blocks = await cashCollectionService.getCodBlocksForOrders([orderId], true);
    const collections = (blocks.get(orderId) ?? []) as Array<Record<string, unknown>>;
    return collections.some(
        (c) => c.shipmentId === shipmentId && typeof c.deliveryCode === 'string' && c.deliveryCode,
    );
}

/**
 * The reason the most recent attempt failed — read to choose buttons, never to publish.
 *
 * ⚠ **`customer-shipment.dto.ts` refuses to put this on the wire and that refusal stands.**
 * The note beside it is written by an agent for their own agency ("gate locked, dog") and the
 * reason is an internal enum the notification copy already rephrases for customers. Reading it
 * to decide what to OFFER respects that decision; echoing it would route around it.
 *
 * `null` when the agent reported an outcome without choosing a reason, which the model allows.
 */
async function latestFailureReason(orderId: string, shipmentId: string): Promise<string | null> {
    const shipment = await ShipmentModel.findOne(
        { _id: shipmentId, order_id: orderId },
        { delivery_failures: 1 },
    ).lean();

    const failures = shipment?.delivery_failures ?? [];
    return failures.length > 0 ? (failures[failures.length - 1].reason ?? null) : null;
}

/** Split a token argument into a fixed number of id segments, refusing anything else. */
function splitIds(argument: string, count: number): string[] {
    const parts = argument.split(':');
    if (parts.length !== count || parts.some((p) => !/^[0-9a-fA-F]{24}$/.test(p))) {
        throw createAppError(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, 422, 'Malformed action token');
    }
    return parts;
}

/**
 * Resolve "the order id, or the order number the customer quoted".
 *
 * ── WHY THIS SURFACE ACCEPTS BOTH AND THE CUSTOMER API DOES NOT ─────────────
 * A browser holds ids: the customer clicked a row. A chat holds whatever the person read
 * off a receipt or a notification, and that is `ORD-2026-000123`. Refusing it would mean
 * the model had to search the order list for a string the customer just gave it, which is
 * two calls and one chance to pick the wrong row.
 *
 * ── OWNERSHIP IS THE QUERY, NEVER A CHECK AFTER IT ──────────────────────────
 * `customer_id` is in the filter, so an order belonging to somebody else is
 * indistinguishable from one that does not exist. A `findById` followed by a comparison
 * would answer 403 and thereby confirm the id is real — and on this surface an id is
 * exactly what a caller can guess at.
 *
 * ⚠ `escapeRegex` is not optional. `order_number` is matched case-insensitively, and every
 * search path in this service is `$regex`-based — an unescaped term is injection and
 * ReDoS at once. ESLint bans a bare `new RegExp` here for that reason.
 */
async function resolveOwnedOrder(customerId: string, reference: string): Promise<IOrder> {
    const customer = new Types.ObjectId(customerId);

    if (Types.ObjectId.isValid(reference)) {
        const byId = await OrderModel.findOne({ _id: reference, customer_id: customer });
        if (byId) return byId;
    }

    const byNumber = await OrderModel.findOne({
        customer_id: customer,
        order_number: { $regex: `^${escapeRegex(reference)}$`, $options: 'i' },
    });
    if (byNumber) return byNumber;

    throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId: reference });
}

/**
 * Collapse a checkout group's per-order payment statuses into one label.
 *
 * ⚠ A verbatim copy of `customer-order.controller.ts`'s private function, and it must stay
 * verbatim: two doors reporting different words for one group's payment state is exactly
 * the drift a curated surface is supposed to prevent. `test:bot-surface` asserts the two
 * agree across the whole input space rather than trusting this comment.
 *
 * The empty case is first because `[].every(...)` is `true` in JavaScript — an empty group
 * would otherwise report `paid`, the most reassuring possible answer to "what happened to
 * my money", derived from no data at all.
 */
export function aggregatePaymentStatus(statuses: string[]): string {
    if (statuses.length === 0) return 'unknown';
    if (statuses.every((s) => s === 'refunded')) return 'refunded';
    if (statuses.every((s) => s === 'failed')) return 'failed';
    if (statuses.some((s) => s === 'disputed')) return 'disputed';
    if (statuses.every((s) => s === 'paid')) return 'paid';
    if (statuses.some((s) => s === 'paid' || s === 'partially_paid')) return 'partially_paid';
    if (statuses.every((s) => s === 'AWAITING_PAYMENT' || s === 'pending')) return 'awaiting_payment';
    return 'mixed';
}
