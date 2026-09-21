import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { escapeRegex } from '../../../core/utils/regex.util';
import { FulfillmentStatus, IOrder, OrderModel } from '../../orders/order.model';
import { OrderRepository } from '../../orders/order.repository';
import { OrderTimelineRepository } from '../../orders/order-timeline.repository';
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
import { BotActionHandlers, ParsedBotAction, unknownBotAction } from '../domain/bot-action-dispatch';
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
    orderCancelActionId,
    orderShipmentsActionId,
    shipmentActionId,
    trackActionId,
} from '../domain/bot-action-id';
import {
    orderCancelConfirmActionId,
    orderCancelDeclineActionId,
    splitConfirmArgument,
    supportTopicActionId,
} from '../domain/bot-ticket-actions';
import { mintConfirmationRef, verifyConfirmationRef } from '../domain/bot-confirmation-ref';
import {
    CANCELLATION_REASON_METADATA_KEY,
    CancellationReasonRefusal,
    judgeCancellationReason,
} from '../domain/bot-cancellation-reason';
import {
    confirmTicketCloseTap,
    declineTicketCloseTap,
    ticketTap,
} from './bot-ticket.controller';
import {
    botFulfillmentStateLabel,
    botOrderCopy,
    botPaymentStateLabel,
    botShipmentStateLabel,
    toBotOrderPaymentState,
} from '../domain/bot-order-status-copy';
import { botStorefrontLink, surfacePath, windowForChat } from '../domain/bot-list-window';
import {
    BotCartIdParamSchema,
    BotCodCodeSchema,
    BotNoArgsSchema,
    BotOrderCancelSchema,
    BotOrderListSchema,
    BotOrderParamSchema,
    BotOrderShipmentParamSchema,
} from '../validators/bot.validators';

/**
 * The body of the cancellation-reason write.
 *
 * ⚠ **Declared HERE rather than in `bot.validators.ts`, exactly as the checkout screen declares its
 * own.** It is one field on one route belonging to one stream, and the switchboard's validator file is
 * a shared file — a contract request for two lines buys nothing. 500 characters is a typed sentence or
 * two, which is what the prompt asks for; anything longer is a support conversation, and there is one
 * of those a button away.
 */
const CancellationReasonBodySchema = z
    .object({ reason: z.string().trim().min(1).max(500) })
    .strict();

/** How much of an order's history the cancellation-reason rule is shown. See its call site. */
const TIMELINE_ROWS_CONSULTED = 100;

const orderRepository = new OrderRepository();
const timelineRepository = new OrderTimelineRepository();
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
 * guarding. Disclosure happens only when asked for by name — the `/orders/:orderId/cod-code`
 * route or the Get code button, both through the one guarded `discloseCodCode`.
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
        await listOwnOrders(req, res, BotOrderListSchema.parse(req.body ?? {}));
    });

    /**
     * `POST /orders/:orderId/cancellation-reason` — the words the customer typed after cancelling.
     *
     * ── ⚠ THE GAP THIS CLOSES, AND IT WAS LIVE ──────────────────────────────
     * "Yes, cancel" cancels the order and the bot then asks *"what went wrong? Tell me in your own
     * words and I will pass it on"* — and **nothing recorded the answer**. The order carries the fixed
     * literal "Cancelled by customer" and the customer's sentence went nowhere. The owner's decision is
     * that a cancellation reason is TYPED, never picked, so the typed words have to reach the order.
     *
     * ⚠ **It is a SECOND, later write, and cancelling never waits for it.** A customer who says nothing
     * has still cancelled. Every rule about whether the words may be recorded is in
     * `domain/bot-cancellation-reason.ts`, pure, so all three refusals can be asserted without a
     * database — each of them needs a cancelled order, a timeline and a clock.
     *
     * ⚠ **The assistant calls this with the customer's OWN sentence**, which is why the description is
     * stored verbatim rather than summarised: a vendor reading the order's history is reading what the
     * customer said, not a paraphrase of it.
     */
    static recordCancellationReason = asyncHandler(async (req: Request, res: Response) => {
        const { orderId } = BotOrderParamSchema.parse(req.params);
        const { reason } = CancellationReasonBodySchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const order = await resolveOwnedOrder(caller.customerId, orderId);
        const orderKey = order._id.toString();

        /**
         * ⚠ **The whole (bounded) timeline, because the rule reads two different things from it** —
         * when the cancellation happened, and whether a reason is already on it. `findByOrder` caps at
         * 100 and an order's history is far shorter; a cancelled order's is a handful of rows.
         */
        const timeline = await timelineRepository.findByOrder(orderKey, {
            page: 1,
            limit: TIMELINE_ROWS_CONSULTED,
            sort: { created_at: -1 },
        });

        const verdict = judgeCancellationReason({
            fulfillmentStatus: order.fulfillment_status,
            events: timeline.data.map((event) => ({
                eventType: event.event_type,
                metadata: event.metadata,
                actorType: event.actor_type,
                createdAt: event.created_at,
            })),
            fallbackAt: order.updated_at ?? order.created_at,
        });

        if (!verdict.ok) throw cancellationReasonRefusal(verdict.refusal);

        /**
         * ⚠ **`note.added`, attributed to the customer, and FLAGGED as a cancellation reason.** The
         * flag is what makes the note self-describing — without it a later reader has to infer from
         * position that a sentence explains a cancellation — and it is what the one-reason-per-
         * cancellation rule counts.
         */
        await timelineRepository.appendEvent({
            orderId: orderKey,
            eventType: 'note.added',
            description: reason,
            metadata: {
                [CANCELLATION_REASON_METADATA_KEY]: true,
                cancelledAt: verdict.cancelledAt.toISOString(),
            },
            actorType: 'customer',
            actorId: caller.userId,
        });

        setBotReply(req, {
            kind: 'text',
            text: botOrderCopy('cancelReasonRecorded', botResponseLanguageOf(req)),
        });

        sendSuccess(res, {
            orderId: orderKey,
            orderNumber: order.order_number,
            recorded: true,
        });
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
                                  paymentMethod: dto.paymentMethod,
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
        await showOrderCard(req, res, orderId);
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
     * ⚠ **The Shipments button on the order card lands here too, as `shp:<orderId>`.** Tracking
     * is a different button and a different destination — `track:<orderId>` answers with the
     * storefront's live tracking page — so a customer who wants the map and a customer who wants
     * to pick a parcel are never sent through each other.
     */
    static listShipments = asyncHandler(async (req: Request, res: Response) => {
        const { orderId } = BotOrderParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        await showShipments(req, res, orderId);
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
     * ⚠ **A door, not the discloser.** The work is `discloseCodCode`, shared with the Get code
     * button; this validates the request and fetches nothing itself, which the guard in
     * `test:bot-surface` enforces.
     */
    static getCodCode = asyncHandler(async (req: Request, res: Response) => {
        const { orderId } = BotOrderParamSchema.parse(req.params);
        const { shipmentId } = BotCodCodeSchema.parse(req.body ?? {});
        await discloseCodCode(req, res, orderId, shipmentId);
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
        await confirmParcelDelivery(req, res, orderId, shipmentId);
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
        await cancelOwnedOrder(req, res, orderId, reason);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  The work a route and a tap share
//
//  ⚠ **A route and a tap call the SAME plain function — never each other.** The routes above are
//  wrapped in `asyncHandler`, which returns before the work finishes and catches its own errors
//  into `next`. A tap handler awaiting one resolves early and swallows every refusal: a tap that
//  produces no message and no log line. That exact mistake was made once on this surface. So the
//  work lives here as plain async functions that THROW, and both doors await them.
//
//  ⚠ **The delivery code follows the same rule, and a guard pins exactly how.** The disclosure
//  lives in ONE function, `discloseCodCode`, with exactly two doors: the `getCodCode` route and
//  the `codCodeTap` button. `test:bot-surface` asserts that shape by name — the discloser exists
//  once and both fetches and answers, each door calls it and fetches nothing itself, no third
//  caller exists, and no other file under `bot-surface/` fetches a code at all.
//
//  ⚠ **So a new way to show a code is a guard change, not a new caller.** Before 2026-09-16 the
//  guard named the ROUTE as the discloser; sharing the body with a tap made that list false, and
//  the guard was changed deliberately by its owner rather than satisfied by reusing the old name
//  for a new function — a guard passed by matching a string protects nothing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⛔ **THE one place a delivery code leaves this service** (besides `resendCodCode`, which issues a
 * new one) — for `POST /orders/:orderId/cod-code` and `code:<orderId>:<shipmentId>`.
 *
 * The code is a payment credential: the secret the customer hands the agent to prove they paid.
 * Every other read on this surface strips it, precisely so that it is disclosed only when asked for
 * by name, once. See the header and `getCodCode`.
 *
 * A code is meaningful only while its collection is `pending`; the underlying block omits it
 * otherwise, which is what makes a collected parcel answer without one rather than replaying a spent
 * secret.
 *
 * ⚠ **The reply carries the code and nothing else — no Resend button.** Owner's decision: a
 * replacement is issued by the agent from their app, which keeps one issuing path; a second here
 * would let a customer invalidate, from a chat, the code the agent is holding at the door.
 */
async function discloseCodCode(
    req: Request,
    res: Response,
    orderRef: string,
    shipmentId: string | undefined,
): Promise<void> {
    const caller = botCallerOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderRef);

    const blocks = await cashCollectionService.getCodBlocksForOrders([order._id.toString()], true);
    const collections = (blocks.get(order._id.toString()) ?? []) as Array<Record<string, unknown>>;

    if (collections.length === 0) {
        throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_FOUND, 404, undefined, {
            orderId: order._id.toString(),
        });
    }

    /**
     * `shipmentId` is required only when the order has more than one parcel. With one there is
     * nothing to disambiguate, and demanding an id the customer does not have would make the common
     * case unreachable. A tap always carries one.
     */
    const match = shipmentId
        ? collections.find((c) => c.shipmentId === shipmentId)
        : collections.length === 1
            ? collections[0]
            : null;

    if (!match) {
        throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_FOUND, 404, undefined, {
            orderId: order._id.toString(),
            // Naming the count rather than the ids: the flow's next move is to ask which parcel,
            // and it gets the ids from `/shipments` where they belong.
            shipmentCount: collections.length,
            reason: shipmentId ? 'no_such_shipment' : 'shipment_id_required',
        });
    }

    /**
     * ⚠ **No reply when the collection carries no code**, which is what an already-collected parcel
     * looks like. Chrome around an absent secret would announce a code and then not show one; with
     * no reply the model says, from the block, that it has been collected.
     */
    const code = typeof match.deliveryCode === 'string' ? match.deliveryCode : null;
    setBotReply(
        req,
        code
            ? { kind: 'text', text: `${botChrome('getCodeButton', botResponseLanguageOf(req))}: ${code}` }
            : null,
    );

    sendSuccess(res, match);
}

/**
 * Order history as a picker — for `POST /orders/list` and for the `ord:list` tap.
 *
 * ⚠ **One function, because a tap and a tool must not word one list differently.** The route passes
 * whatever filter the model chose; the tap passes the schema's own defaults, so the first five rows a
 * customer taps their way to are the same five the model would have described.
 */
async function listOwnOrders(
    req: Request,
    res: Response,
    query: ReturnType<typeof BotOrderListSchema.parse>,
): Promise<void> {
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
     * ⚠ **The second cap is not redundant.** `windowForChat` caps GROUPS at five, and five groups can
     * hold more than five orders — a single basket split across three sellers is three rows on its
     * own. Without this, a WhatsApp list could exceed the ten rows Meta accepts and the whole message
     * would be rejected.
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
}

/** The order card — for `POST /orders/:orderId`, `ord:<orderId>` and `no:cnc:<orderId>`. */
async function showOrderCard(req: Request, res: Response, orderRef: string): Promise<void> {
    const caller = botCallerOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderRef);
    const [dto] = await customerOrderViewService.toDtos([order]);

    setOrderCardReply(req, dto);

    sendSuccess(res, stripDeliveryCodes(dto));
}

/** The parcels on one order — for `POST /orders/:orderId/shipments` and `shp:<orderId>`. */
async function showShipments(req: Request, res: Response, orderRef: string): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderRef);
    const shipments = await orderService.listShipmentsForCustomer(
        caller.customerId,
        order._id.toString(),
    );

    /**
     * ⚠ **One parcel is shown, not offered.** A picker with a single row asks the customer to
     * choose between one thing — two taps to reach a card they could have been handed. With none
     * (a digital order, or a physical one not yet dispatched) there is nothing to draw, and the
     * model says where the order has got to instead.
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
}

/** Confirm one parcel — for the confirm-delivery route and `yes:cd:<orderId>:<shipmentId>`. */
async function confirmParcelDelivery(
    req: Request,
    res: Response,
    orderRef: string,
    shipmentId: string,
): Promise<void> {
    const caller = botCallerOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderRef);
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
}

/** Cancel an order — for `POST /orders/:orderId/cancel` and `yes:cnc:<orderId>`. */
async function cancelOwnedOrder(
    req: Request,
    res: Response,
    orderRef: string,
    reason: string | undefined,
): Promise<void> {
    const caller = botCallerOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderRef);

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
     * ⚠ **Only ask for the reason when the customer did not already give one.** A model that
     * passed `reason` has just relayed what the customer said; asking again would make the
     * platform look as though it had not been listening. A TAP never carries one — the Yes button
     * is the decision, and the words come next, typed (owner's decision).
     */
    setBotReply(
        req,
        reason
            ? null
            : { kind: 'text', text: botChrome('cancelReasonPrompt', botResponseLanguageOf(req)) },
    );

    /**
     * ⚠ **`awaitingCancellationReason` is what makes the typed reason reachable at all**, and it is a
     * flag for the AUTOMATION LAYER rather than for a customer.
     *
     * The prompt above is deterministic, so this turn is answered without the assistant — which means
     * the assistant does not know an order was just cancelled, and the customer's next message ("the
     * shop never replied") arrives as ordinary text with nothing to attach it to. Chat is stateless
     * between turns, so the only thing that can carry that knowledge forward is the automation layer
     * passing this data to the assistant for the turn AFTER this one.
     *
     * ⚠ **Until it does, the words are asked for and not recorded** — the cancellation itself is
     * unaffected, which is why the prompt stays deterministic rather than being handed to a model that
     * would currently answer an empty input with a greeting. The requirement is with the deploy-day
     * n8n change set; `orders_record_cancellation_reason` is the tool it names.
     */
    sendSuccess(res, {
        order_id: order._id.toString(),
        fulfillment_status: order.fulfillment_status,
        awaitingCancellationReason: !reason,
    }, { message: 'Order cancelled' });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Taps — what this stream answers when a customer presses one of its buttons
//
//  Routed by `bot-action.controller.ts`, which parses the token once and calls whatever is
//  registered for its key (`domain/bot-action-dispatch.ts` is the contract). This file never
//  opens the dispatcher, and the dispatcher never learns what an order is.
//
//  ⚠ **Every handler validates its OWN argument and refuses a malformed one with
//  `unknownBotAction()`** — the refusal the dispatcher gives an unknown verb — so a mangled `shp:`
//  and a retired `zzz:` read identically to the customer.
// ─────────────────────────────────────────────────────────────────────────────

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * An argument that must be exactly `count` ObjectIds, or a refusal.
 *
 * ⚠ **Refused as a TOKEN, never as a Zod failure.** A validation error would describe fields the
 * customer never sent; the token refusal says what actually happened — they pressed something
 * this service cannot read.
 */
function idsOf(argument: string, count: number): string[] {
    const parts = argument.split(':');
    if (parts.length !== count || !parts.every((part) => OBJECT_ID.test(part))) {
        throw unknownBotAction();
    }
    return parts;
}

/**
 * `ord:<orderId>` — the order card · `ord:<orderId>:cancel` — the are-you-sure.
 *
 * ⚠ **Two shapes of one verb, told apart here rather than in the registry.** The dispatch contract
 * keeps a verb one stream owns keyed by the verb alone; sub-dispatching it would put this stream's
 * argument grammar into a shared file where the next change to it is somebody else's edit.
 */
async function orderTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const [orderId, view, ...extra] = action.argument.split(':');

    /**
     * `ord:list` — the chat order list, for a menu that has no order to name yet.
     *
     * ⚠ **Told apart by SHAPE, before the id check.** `list` is not 24 hex characters, so it cannot
     * collide with an order id — the same way `tkt:list` and `tkt:new` sit beside ticket ids.
     */
    if (orderId === 'list' && view === undefined && extra.length === 0) {
        await listOwnOrders(req, res, BotOrderListSchema.parse({}));
        return;
    }

    if (!OBJECT_ID.test(orderId ?? '') || extra.length > 0) throw unknownBotAction();

    if (view === undefined) {
        await showOrderCard(req, res, orderId);
        return;
    }
    if (view === 'cancel') {
        await askToCancel(req, res, orderId);
        return;
    }
    throw unknownBotAction();
}

/**
 * The are-you-sure before a cancellation.
 *
 * ⚠ **It cancels nothing and checks nothing.** Eligibility lives in `assertCancellable` and stays
 * there; this turn only asks. A customer who taps Yes meets the full check a moment later and is
 * told, in their own language, if the order has moved on since the card was drawn — which a card
 * sitting in a chat history always might have.
 *
 * ⚠ **The order is loaded anyway, only to prove ownership.** Rendering a prompt for an id the caller
 * does not own would confirm the id is real before refusing — what `resolveOwnedOrder` prevents.
 */
async function askToCancel(req: Request, res: Response, orderRef: string): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderRef);
    const orderId = order._id.toString();

    /**
     * ⚠ **The confirm carries a SIGNED, ten-minute reference; the decline carries none.**
     * A button lives in a chat history for as long as the conversation does, so a bare `yes:cnc` would
     * still cancel an order when tapped three weeks later, from a message the customer scrolled past —
     * long after the sentence above it stopped describing the order. Declining changes nothing, so
     * refusing a stale "No, keep it" would be refusing the one answer that is always safe.
     */
    const ref = mintConfirmationRef(
        'cancel',
        { userId: caller.userId, channel: caller.channel },
        orderId,
    );

    setBotReply(req, {
        kind: 'choice',
        text: botChrome('cancelOrderPrompt', language),
        options: [
            { id: orderCancelConfirmActionId(orderId, ref), label: botChrome('confirmButton', language) },
            { id: orderCancelDeclineActionId(orderId), label: botChrome('declineButton', language) },
        ],
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    });

    sendSuccess(res, { orderId, orderNumber: order.order_number, awaitingConfirmation: true });
}

/** `shp:<orderId>` — every parcel on the order · `shp:<orderId>:<shipmentId>` — one parcel. */
async function shipmentTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    if (!action.argument.includes(':')) {
        const [orderId] = idsOf(action.argument, 1);
        await showShipments(req, res, orderId);
        return;
    }

    const [orderId, shipmentId] = idsOf(action.argument, 2);
    await showShipment(req, res, orderId, shipmentId);
}

/**
 * One parcel, with whatever it can actually offer.
 *
 * ⚠ **The only path that reads raw shipment fields**, and it publishes none of them — see this
 * file's header. `handing_over` and `delivery_failures[].reason` choose the wording and the
 * buttons; the response body is the ordinary customer projection.
 */
async function showShipment(
    req: Request,
    res: Response,
    orderRef: string,
    shipmentId: string,
): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderRef);
    const shipments = await orderService.listShipmentsForCustomer(
        caller.customerId,
        order._id.toString(),
    );
    const shipment = shipments.find((candidate) => candidate.id === shipmentId);
    if (!shipment) {
        throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, { shipmentId });
    }

    await setShipmentCardReply(req, order, shipment, language);
    sendSuccess(res, shipment);
}

/**
 * `track:<orderId>` — the order's state and the storefront's live tracking page.
 *
 * ⚠ **A TAP that answers with a link, rather than a link on the card, for one reason.** A cash-on-
 * delivery parcel card already carries Get code, and WhatsApp cannot put a reply button and a URL
 * button in one message. So there Track has to be a reply button too, and this is where it lands.
 * A card with no other control carries the link directly (`setShipmentCardReply`).
 *
 * Degrades to the state alone when this deployment has no storefront to link to — a sentence,
 * never a button with an empty target.
 */
async function trackTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const [orderRef] = idsOf(action.argument, 1);
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    const order = await resolveOwnedOrder(caller.customerId, orderRef);
    const orderId = order._id.toString();
    const url = orderTrackingUrl(orderId, language);
    const text = `${order.order_number}\n${botFulfillmentStateLabel(order.fulfillment_status, language)}`;

    setBotReply(
        req,
        url
            ? { kind: 'link', text, label: botChrome('trackButton', language), url }
            : { kind: 'text', text },
    );

    sendSuccess(res, { orderId, orderNumber: order.order_number, trackingUrl: url });
}

/**
 * `code:<orderId>:<shipmentId>` — the Get code button on a cash-on-delivery parcel card.
 *
 * ⚠ **One of exactly two doors onto the disclosure, and it fetches nothing itself** — the guard in
 * `test:bot-surface` fails if it ever does. Validating the argument is all it owns.
 */
async function codCodeTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const [orderId, shipmentId] = idsOf(action.argument, 2);
    await discloseCodCode(req, res, orderId, shipmentId);
}

/** `yes:cd:<orderId>:<shipmentId>` — the parcel arrived. */
async function confirmDeliveryTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const [orderId, shipmentId] = idsOf(action.argument, 2);
    await confirmParcelDelivery(req, res, orderId, shipmentId);
}

/**
 * `no:cd:<orderId>:<shipmentId>` — the parcel did NOT arrive.
 *
 * ⚠ **It writes nothing, and that is the whole point of having it.** Without it there is no No
 * button, and a two-way question becomes a control that can only agree.
 */
async function declineDeliveryTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const [orderRef, shipmentId] = idsOf(action.argument, 2);
    const caller = botCallerOf(req);
    const order = await resolveOwnedOrder(caller.customerId, orderRef);

    setBotReply(req, {
        kind: 'text',
        text: botOrderCopy('deliveryNotReceived', botResponseLanguageOf(req)),
    });

    sendSuccess(res, { confirmed: false, orderId: order._id.toString(), shipmentId });
}

/**
 * `yes:cnc:<orderId>:<ref>` — cancel it. The reason is asked for next, as typed text.
 *
 * ⚠ **A stale or unverifiable reference ASKS AGAIN rather than refusing**, the shape the account
 * stream's close established: the customer who tapped is this conversation's own account and could
 * get a fresh confirm by asking, so re-stating what the tap would do is that, one step shorter — and
 * it re-reads the order, which by then may no longer be cancellable at all.
 *
 * ⚠ **A reference is REQUIRED.** The bare `yes:cnc:<orderId>` shape predates signing and was never
 * deployed; accepting it would re-open exactly the three-weeks-later tap the signature exists to
 * refuse.
 */
async function confirmCancelTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const split = splitConfirmArgument(action.argument);
    if (!split) throw unknownBotAction();

    const caller = botCallerOf(req);
    const verdict = verifyConfirmationRef(
        split.ref,
        'cancel',
        { userId: caller.userId, channel: caller.channel },
        split.id,
    );

    if (verdict !== 'valid') {
        await askToCancel(req, res, split.id);
        return;
    }

    await cancelOwnedOrder(req, res, split.id, undefined);
}

/** `no:cnc:<orderId>` — leave it alone. Back to the card the customer came from. */
async function declineCancelTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const [orderId] = idsOf(action.argument, 1);
    await showOrderCard(req, res, orderId);
}


/**
 * `open:ol` — the whole order history, on a screen.
 *
 * ── ⚠ THE DEGRADATION IS THE PATH THAT ACTUALLY RUNS ────────────────────────
 * `BOT_MINIAPP_BASE_URL` is unset in production, so `inAppScreenUrl` answers null and this returns
 * the storefront's own orders page. That is what every customer gets today, and it is why the row
 * is safe to render at all.
 *
 * ⚠ **`openInAppScreen` rather than a hand-rolled mint.** The five fields binding a screen session
 * to a conversation are read there from the request envelope and nowhere else, so a session can
 * only be addressed at the chat that asked for it. That binding is the security property of the
 * whole in-app surface; it is written once.
 *
 * ⚠ **`fallbackPath` is READ FROM THE SAME TABLE `windowForChat({ surface: 'orders' })` uses**, so
 * the row's destination cannot drift from the `moreUrl` reported on the turn that drew it.
 *
 * ⚠ **This sentence used to say that while the code typed the literal `'/shop/account/orders'`.**
 * The path was right, so nothing was ever red — and a reader (the switchboard, 2026-09-20) believed
 * the drift was already prevented and told another stream to copy the pattern, which turned out not
 * to exist. `surfacePath()` was added so the claim could become true rather than be deleted.
 *
 * ⚠ **`textKey` is `ordersScreenPrompt`, and it used to be `loadMoreRow` — a row title doing a body's
 * job.** `loadMoreRow` is a 24-character list-row title ("Load more"), and as the sentence ABOVE a
 * button it said nothing about what the button opens; `respondWithScreen`'s own default is worse here,
 * because it introduces products. The switchboard added the proper key on 2026-09-20 and this is its
 * one caller, so `viewOrdersPrompt` — the key this was NOT allowed to borrow — can now go.
 */
async function orderHistoryTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    if (action.argument !== '') throw unknownBotAction();

    const handle = await openInAppScreen(req, {
        payload: { kind: 'ol' },
        fallbackPath: surfacePath('orders'),
        labelKey: 'browseAllButton',
        textKey: 'ordersScreenPrompt',
    });

    sendSuccess(res, { handle, opened: 'orders' });
}

/**
 * ⭐ **The keys this stream answers, for the dispatcher's registry.**
 *
 * One map, plain verbs and (verb, sub-key) pairs side by side, as `bot-action-dispatch.ts`
 * requires. Exported rather than registered from here, so the registry stays the one place a reader
 * can see every routed key.
 *
 * ⚠ **`code` reaches the delivery-code disclosure**, one of its two guarded doors — see "The work a
 * route and a tap share" above before adding anything that shows a code.
 */
export const ORDER_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    ord: orderTap,
    shp: shipmentTap,
    code: codCodeTap,
    track: trackTap,
    /**
     * ⚠ **The whole `tkt` verb, handled in `bot-ticket.controller.ts`** — the request list, one
     * request, Reply, Attach photo, Close, an attach, and the support form. It stays registered in
     * THIS map because the dispatch contract gives each stream one map, and orders, support and
     * digital are one stream; the handlers live with the requests they are about.
     */
    tkt: ticketTap,
    'yes:cd': confirmDeliveryTap,
    'no:cd': declineDeliveryTap,
    'yes:cnc': confirmCancelTap,
    'no:cnc': declineCancelTap,
    /** Closing a support request — the confirm pair, from the support half of this stream. */
    'yes:tcl': confirmTicketCloseTap,
    'no:tcl': declineTicketCloseTap,
    'open:ol': orderHistoryTap,
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
    /** Decides whether an unpaid order reads as a debt or as "cash on delivery". */
    paymentMethod: string;
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
    const state = botFulfillmentStateLabel(order.fulfillmentStatus, language);
    const money = formatBotPrice(order.total, order.currency);
    const payment = botPaymentStateLabel(toBotOrderPaymentState(order.paymentStatus), language, {
        cashOnDelivery: order.paymentMethod === 'cash_on_delivery',
    });

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
            id: orderShipmentsActionId(order.id),
            label: botChrome('shipmentsButton', language),
        });
    }

    if (isCancellableFromChat(order)) {
        actions.push({
            id: orderCancelActionId(order.id),
            label: botChrome('cancelOrderButton', language),
        });
    }

    actions.push({
        id: supportTopicActionId('hp', order.id),
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

    const state = botFulfillmentStateLabel(order.fulfillmentStatus, language);
    const payment = botPaymentStateLabel(toBotOrderPaymentState(order.paymentStatus), language, {
        cashOnDelivery: order.paymentMethod === 'cash_on_delivery',
    });
    const money = formatBotPrice(order.total, order.currency);

    return `${heading}\n${state} · ${payment}\n${money}`;
}

/**
 * One parcel's card — and the only turn on this surface whose buttons depend on internal state.
 *
 * Five shapes, in priority order, and each one exists because the shape above it would offer
 * the customer something useless:
 *
 *   1. **A failed attempt** — the three support actions. The failure REASON is read here and
 *      never published (see the file header); it decides whether asking for a redelivery is
 *      worth putting in front of somebody, because a parcel refused at the door is not a
 *      parcel that needs rescheduling.
 *   2. **Cash on delivery with a code still pending** — the code. Confirming a delivery that
 *      has not happened is not the next thing this customer needs, and on a COD parcel handing
 *      over the code IS the confirmation.
 *   3. **Prepaid, at the door, not yet confirmed** — the yes/no question. The gate is the
 *      service's own two refusals restated; see the comment at the branch.
 *   4. **Moving** — the state, the journey, and a Track link to the storefront tracking page.
 *      A parcel mid-handover lands here and gets the handover sentence as well.
 *   5. **Anything else** — preparing or delivered: the state and the journey, no controls,
 *      because there is nothing to press.
 *
 * ⚠ **`completion.confirmedAt` is NOT the confirmation gate, though the DTO warns about a
 * neighbouring trap.** That warning is about the ORDER-level confirm and is right: fulfilment
 * does not move when a customer confirms. But an order completes only when its LAST parcel is
 * confirmed, so `confirmedAt` stays null while earlier parcels are already confirmed — gating a
 * per-parcel question on it keeps offering the question to people who answered it.
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
        /**
         * ⚠ **Track is a TAP here, not a link, and that is forced by WhatsApp.** This card already
         * carries Get code, and one interactive message cannot hold both a reply button and a URL
         * button. `track:<orderId>` answers with the same tracking page the link would have opened.
         * Offered only when there is a storefront to link to — a Track tap that can only answer
         * with a sentence is a button that looks broken.
         *
         * ⚠ **Get code gains no Resend** (owner's decision): a replacement code comes from the
         * agent's app, which keeps one issuing path.
         */
        const trackable = orderTrackingUrl(orderId, language) !== null;
        setBotReply(req, {
            kind: 'text',
            text: `${state}\n${shipment.trackingNumber ?? ''}`.trim(),
            actions: [
                { id: codCodeActionId(orderId, shipment.id), label: botChrome('getCodeButton', language) },
                ...(trackable
                    ? [{ id: trackActionId(orderId), label: botChrome('trackButton', language) }]
                    : []),
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
                    id: confirmActionId('cd', `${orderId}:${shipment.id}`),
                    label: botChrome('confirmButton', language),
                },
                {
                    id: declineActionId('cd', `${orderId}:${shipment.id}`),
                    label: botChrome('declineButton', language),
                },
            ],
            listButton: botChrome('chooseListButton', language),
            sectionTitle: botChrome('chooseSectionTitle', language),
        });
        return;
    }

    const text = await plainParcelText(order, shipment, state, language);

    /**
     * ⭐ **A parcel that is MOVING gets the tracking page, one tap away.**
     *
     * This is where both of the atlas's Track asks land — "tracking = status in chat plus a link"
     * and "handover = one sentence and a Track button". A handover collapses to `shipped` for the
     * customer, so the parcel mid-handover reaches this branch and gets the sentence
     * (`plainParcelText`) and the link together.
     *
     * ⚠ **A URL button here, not a tap-code.** This card has no other control to sit beside, so a
     * `link` needs no dispatcher and costs no second round-trip. The cash-on-delivery card above
     * is different — it already carries Get code, and WhatsApp cannot put a reply button and a
     * URL button in one message — which is why `track:<orderId>` exists as a tap that REPLIES
     * with this same link.
     *
     * ⚠ **Only while it moves.** A parcel still being prepared has no route to show, and a
     * delivered one has nothing left to track; a Track button on either opens a page with nothing
     * on it, which reads to the customer as the tracking being broken.
     */
    const url = shipment.status === 'shipped' || shipment.status === 'out_for_delivery'
        ? orderTrackingUrl(orderId, language)
        : null;

    setBotReply(
        req,
        url
            ? { kind: 'link', text, label: botChrome('trackButton', language), url }
            : { kind: 'text', text },
    );
}

/**
 * The storefront's live tracking page for one order, in the customer's language — or null when
 * this deployment has no storefront to link to.
 *
 * ⚠ **The SAME page the "your order has shipped" notification's Track button opens**
 * (`customer-notification-catalog.ts`, `TRACK_BUTTON`). Verified in the storefront source rather
 * than taken from that comment: `frontend/landing/src/app/[locale]/shop/account/orders/detail/
 * [orderId]/tracking` exists. One tracking view whichever door the customer came in by — a chat
 * link and a notification link that opened different pages would be two answers to "where is
 * it".
 *
 * ⚠ **Per ORDER, not per parcel**, because that is how the page is built: an order's parcels
 * can go to several places, and the page draws them together.
 *
 * ⚠ **`botStorefrontLink`, never concatenation** — it applies the `as-needed` locale prefix, and
 * a bare path does not 404 for a French customer, it silently opens in English.
 */
function orderTrackingUrl(orderId: string, language: string | null): string | null {
    return botStorefrontLink(`/shop/account/orders/detail/${orderId}/tracking`, language);
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
            id: supportTopicActionId('rd', orderId),
            label: botOrderCopy('askRedeliveryButton', language),
        });
    }

    // Only when the address is what went wrong. Offering an address fix to somebody who was
    // simply out invites them to change a correct address.
    if (reason === 'address_not_found' || reason === 'address_inaccessible') {
        actions.push({
            id: supportTopicActionId('ad', orderId),
            label: botOrderCopy('askAddressFixButton', language),
        });
    }

    actions.push({
        id: supportTopicActionId('hp', orderId),
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
 * ── WHY THE JOURNEY IS IN THE MESSAGE AS WELL AS BEHIND THE LINK ───────────
 * A moving parcel's card also carries a Track link to the storefront tracking page — but a link
 * costs a tap, a browser and a page load, and on a phone with poor data that is where a customer
 * gives up. `CustomerShipmentDto.statusHistory` is already collapsed to the five customer words
 * and already de-duplicated, so `picked_up → in_transit → handing_over` is one "On its way" line
 * rather than three. The short answer to "where is it" is here; the map is one tap away.
 *
 * ⚠ **This comment once argued there should be no Track button at all**, because the only Track
 * token then opened the parcel LIST — a loop back to where the customer came from. The fix was
 * finding the real destination (verified in the storefront source), not deleting the button.
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

/**
 * The three ways recording a cancellation reason can be refused, as codes a chat can explain.
 *
 * ⚠ **One refusal per situation, and none of them reuses `ORDER_ALREADY_CANCELLED`.** That code means
 * "you cannot cancel this, it is already cancelled" — the opposite of what two of these say — and a
 * code that means two things breaks every dashboard that groups by it. The messages here are for an
 * operator; the customer reads `error.customerMessage`.
 */
function cancellationReasonRefusal(refusal: CancellationReasonRefusal) {
    if (refusal === 'already_recorded') {
        return createAppError(
            ERROR_CODES.ORDER_CANCELLATION_REASON_ALREADY_RECORDED,
            409,
            'A cancellation reason is already recorded for this order',
        );
    }
    if (refusal === 'window_closed') {
        return createAppError(
            ERROR_CODES.ORDER_CANCELLATION_REASON_WINDOW_CLOSED,
            422,
            'Too long after the cancellation to record a reason for it',
        );
    }
    return createAppError(
        ERROR_CODES.ORDER_CANCELLATION_REASON_NOT_CANCELLED,
        422,
        'This order is not cancelled, so there is no cancellation to explain',
    );
}
