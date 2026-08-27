import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { escapeRegex } from '../../../core/utils/regex.util';
import { IOrder, OrderModel } from '../../orders/order.model';
import { OrderRepository } from '../../orders/order.repository';
import { OrderService } from '../../orders/order.service';
import { customerOrderViewService } from '../../orders/services/customer-order-view.service';
import { ShipmentService } from '../../shipments/shipment.service';
import { cashCollectionService } from '../../cod/services/cash-collection.service';
import { VendorRepository } from '../../vendors/vendor.repository';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import { stripDeliveryCodes } from '../dto/bot-projections';
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
 */
export class BotOrderController {
    /** `POST /orders/list` — order history, grouped by checkout group. */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = BotOrderListSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const { data, meta } = await orderRepository.findGroupsByCustomer(
            caller.customerId,
            { page: query.page, limit: query.limit },
            {
                fulfillmentStatus: query.status,
                paymentStatus: query.paymentStatus,
                q: query.q,
            },
        );

        sendSuccess(res, data.map((group) => ({
            cartId: group.cartId,
            createdAt: group.createdAt,
            currency: group.currency,
            totalAmount: group.totalAmount,
            orderCount: group.orderCount,
            paymentStatus: aggregatePaymentStatus(group.paymentStatuses),
            orders: group.orders,
        })), { meta });
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

    /** `POST /orders/:orderId` — one per-vendor order in detail. */
    static getOrder = asyncHandler(async (req: Request, res: Response) => {
        const { orderId } = BotOrderParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const order = await resolveOwnedOrder(caller.customerId, orderId);
        const [dto] = await customerOrderViewService.toDtos([order]);

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

        sendSuccess(res, match);
    });

    /**
     * `POST /orders/:orderId/shipments/:shipmentId/resend-delivery-code`
     *
     * Regenerates the code, resends it over WhatsApp, and returns it — it is the
     * customer's own secret. Invalidates the previous one and clears any wrong-attempt
     * lockout. The 1-per-60s server-side cooldown answers `429 COD_CODE_RESEND_TOO_SOON`
     * and is deliberately left to the service rather than re-stated here.
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

        sendSuccess(res, {
            order_id: order._id.toString(),
            fulfillment_status: order.fulfillment_status,
        }, { message: 'Order cancelled' });
    });
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

