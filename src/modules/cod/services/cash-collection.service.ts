import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { eventBus } from '../../../core/events/event-bus';
import { COD_CONFIG } from '../config/cod.config';
import { CashCollectionRepository } from '../repositories/cash-collection.repository';
import { CashCollectionModel, ICashCollection } from '../models/cash-collection.model';
import { DeliveryCodeService, deliveryCodeService } from './delivery-code.service';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import { earningsSplitService } from '../../earnings/services/earnings-split.service';
import { IOrder, OrderModel, PaymentStatus } from '../../orders/order.model';
import { OrderRepository } from '../../orders/order.repository';
import { OrderTimelineRepository } from '../../orders/order-timeline.repository';
import {
  OrderFulfillmentAggregationService,
  orderFulfillmentAggregationService,
} from '../../orders/domain/services/OrderFulfillmentAggregationService';
import { OrderCompletionService, orderCompletionService } from '../../orders/order-completion.service';
import { IShipment, ShipmentModel } from '../../shipments/shipment.model';
import { ShipmentRepository } from '../../shipments/shipment.repository';
import { CustomerModel } from '../../customers/customer.model';
import { resolveLanguage } from '../../notifications/catalog/notification-i18n';

export interface CollectInput {
  code: string;
  location?: { lat: number; lng: number } | null;
  deviceInfo?: string | null;
  ip?: string | null;
}

/**
 * CashCollectionService - the COD "payment gateway": the delivery agent is the
 * collector, and the customer's delivery code is the authorization.
 *
 * Lifecycle of one COD shipment's cash:
 *  - `picked_up`  → a pending CashCollection is created (expected amount +
 *    hashed delivery code snapshot) inside the SAME transaction as the status
 *    change; the code goes to the customer post-commit (WhatsApp + in-app).
 *  - agent submits the code at handoff → ONE transaction: collection claimed
 *    `collected` (with GPS/device evidence), shipment `delivered`, order items
 *    mirrored, fulfillment recomputed, the order's COD payment status
 *    recomputed (partially_paid/paid), and cash liabilities raised (M4).
 *  - shipment `returned` → the pending collection is cancelled and the order's
 *    COD payment status recomputed (all returned + nothing collected → failed).
 */
export class CashCollectionService {
  constructor(
    private readonly collectionRepo: CashCollectionRepository = new CashCollectionRepository(),
    private readonly codes: DeliveryCodeService = deliveryCodeService,
    private readonly shipmentRepo: ShipmentRepository = new ShipmentRepository(),
    private readonly orderRepo: OrderRepository = new OrderRepository(),
    private readonly timelineRepo: OrderTimelineRepository = new OrderTimelineRepository(),
    private readonly aggregationService: OrderFulfillmentAggregationService = orderFulfillmentAggregationService,
    private readonly completionService: OrderCompletionService = orderCompletionService,
    private readonly cashAccounts: CodCashAccountService = codCashAccountService
  ) {}

  // ─── Creation (at pickup) ────────────────────────────────────────────────────

  /**
   * Create the pending collection for a COD shipment being picked up. Runs
   * inside the caller's (ShipmentService.updateStatus) transaction so a
   * picked-up COD shipment can never exist without its collection record.
   * Returns the plaintext code for the post-commit customer notification.
   */
  async createForShipmentInSession(
    order: IOrder,
    shipment: IShipment,
    session: ClientSession
  ): Promise<{ collection: ICashCollection; code: string }> {
    if (!shipment.agent_id) {
      throw createAppError(ERROR_CODES.COD_AGENT_NOT_ASSIGNED, 422, 'A COD shipment cannot be picked up before an agent is assigned');
    }

    const expectedAmount = this.computeExpectedAmount(order, shipment);
    const code = this.codes.generateCode();

    const collection = await this.collectionRepo.create(
      {
        order_id: order._id as any,
        shipment_id: shipment._id as any,
        agency_id: shipment.agency_id,
        agent_id: shipment.agent_id,
        customer_id: order.customer_id,
        vendor_id: order.vendor_id,
        expected_amount: expectedAmount,
        currency: order.currency,
        status: 'pending',
        code_hash: this.codes.hashCode(code),
        code_plain: code,
        code_generated_at: new Date(),
        code_attempts: 0,
        code_locked: false,
      },
      session
    );

    return { collection, code };
  }

  /** Best-effort post-commit customer notification of a (re)issued code. */
  async notifyCodeIssued(order: IOrder, collection: ICashCollection, code: string): Promise<void> {
    try {
      const customer: any = await CustomerModel.findById(order.customer_id)
        .select('phone preferences.language')
        .lean()
        .exec();
      await this.codes.sendToCustomer({
        customerPhone: customer?.phone ?? null,
        code,
        orderNumber: order.order_number,
        expectedAmount: collection.expected_amount,
        currency: collection.currency,
        language: resolveLanguage(customer),
        dedupeKey: `${collection._id.toString()}:${collection.code_generated_at.getTime()}`,
      });
    } catch (error) {
      console.error('[CashCollectionService] Failed to notify customer of delivery code:', error);
    }
  }

  // ─── Collection (the handoff) ───────────────────────────────────────────────

  /**
   * Agent submits the customer's delivery code: verify, then atomically record
   * the cash and deliver the shipment. The ONLY path by which a COD shipment
   * reaches 'delivered'.
   */
  async collect(agentId: string, agentUserId: string, shipmentId: string, input: CollectInput) {
    // 1. Scope: the shipment must be assigned to THIS agent (404 — never leak).
    const shipment = await this.shipmentRepo.findById(shipmentId);
    if (!shipment || shipment.agent_id?.toString() !== agentId) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    }
    if (shipment.status !== 'picked_up' && shipment.status !== 'in_transit') {
      throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_COLLECTIBLE, 422, undefined, {
        shipmentStatus: shipment.status,
      });
    }

    const collection = await this.collectionRepo.findByShipmentId(shipmentId);
    if (!collection) {
      throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_FOUND, 404);
    }
    if (collection.status === 'collected') {
      throw createAppError(ERROR_CODES.COD_COLLECTION_ALREADY_COLLECTED, 409);
    }
    if (collection.status !== 'pending') {
      throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_COLLECTIBLE, 422, undefined, {
        collectionStatus: collection.status,
      });
    }
    if (collection.code_locked) {
      throw createAppError(ERROR_CODES.COD_CODE_ATTEMPTS_EXCEEDED, 423, 'Too many wrong codes — resend a new code to the customer');
    }

    // 2. Verify the code. Failed attempts persist OUTSIDE the transaction so a
    //    brute-force can't be reset by aborting.
    if (!this.codes.verifyCode(input.code, collection.code_hash)) {
      const updated = await this.collectionRepo.recordFailedAttempt(
        collection._id as Types.ObjectId,
        COD_CONFIG.OTP_MAX_ATTEMPTS
      );
      if (updated?.code_locked) {
        throw createAppError(ERROR_CODES.COD_CODE_ATTEMPTS_EXCEEDED, 423, 'Too many wrong codes — resend a new code to the customer');
      }
      throw createAppError(ERROR_CODES.COD_INVALID_CODE, 422, undefined, {
        attemptsRemaining: COD_CONFIG.OTP_MAX_ATTEMPTS - (updated?.code_attempts ?? 0),
      });
    }

    const orderId = shipment.order_id.toString();

    // 3. THE COD SETTLEMENT MOMENT — everything in one transaction.
    let claimed: ICashCollection | null = null;
    await transactionManager.runInTransaction(async (session) => {
      claimed = await this.collectionRepo.claimCollected(
        collection._id as Types.ObjectId,
        {
          location: input.location ?? null,
          device_info: input.deviceInfo ?? null,
          ip: input.ip ?? null,
        },
        session
      );
      if (!claimed) {
        // Concurrent submission won the claim.
        throw createAppError(ERROR_CODES.COD_COLLECTION_ALREADY_COLLECTED, 409);
      }

      // Deliver the shipment: the verified code IS the customer confirmation.
      await this.shipmentRepo.applyStatusChange(
        shipmentId,
        'delivered',
        { userId: agentUserId, role: 'agent' },
        session
      );
      await this.orderRepo.setItemDeliveryStatusByShipment(shipmentId, 'delivered', session);
      await this.aggregationService.recomputeFulfillmentStatus(orderId, session);
      await this.recomputeCodPaymentStatusInSession(orderId, session);

      await this.creditCashLiabilitiesInSession(claimed, session);
    });

    // 4. Post-commit side effects (each best-effort, all idempotent).
    const refreshedOrder = await OrderModel.findById(orderId);
    if (
      refreshedOrder &&
      refreshedOrder.fulfillment_status === 'delivered' &&
      !refreshedOrder.completion?.confirmed_at
    ) {
      // The customer released the code at handoff — that's their confirmation.
      await this.completionService.complete(refreshedOrder, 'customer', false, agentUserId);
    }

    if (refreshedOrder) {
      await this.emitPostCollectionEvents(refreshedOrder, claimed!, agentId);
      await this.splitEarnings(refreshedOrder, claimed!);
    }

    return this.toDto(claimed!, refreshedOrder?.payment_status ?? null);
  }

  /**
   * Split this collection into held earnings (vendor net, platform commission,
   * agency delivery + COD handling fee), all gated on cash settlement.
   * Idempotent and best-effort — a failure never breaks the collection; the
   * daily earnings sweep re-splits collections left without allocations.
   */
  protected async splitEarnings(order: IOrder, collection: ICashCollection): Promise<void> {
    try {
      await earningsSplitService.splitCodCollection(order, collection);
    } catch (error) {
      console.error('[CashCollectionService] Failed to split COD earnings (sweep will retry):', error);
    }
  }

  /**
   * Raise both cash liabilities for a verified collection, INSIDE the collect
   * transaction: the agent now physically holds the cash (owes the agency),
   * and the agency chain is accountable to the platform for it.
   */
  protected async creditCashLiabilitiesInSession(
    collection: ICashCollection,
    session: ClientSession
  ): Promise<void> {
    const refId = collection._id.toString();
    await this.cashAccounts.creditInSession(
      'agent',
      collection.agent_id.toString(),
      collection.expected_amount,
      collection.currency,
      'collection',
      'cash_collection',
      refId,
      session
    );
    await this.cashAccounts.creditInSession(
      'agency',
      collection.agency_id.toString(),
      collection.expected_amount,
      collection.currency,
      'collection',
      'cash_collection',
      refId,
      session
    );
  }

  // ─── Code resend ─────────────────────────────────────────────────────────────

  /** Agent asks for a fresh code to be sent to the customer (locked/lost code). */
  async resendCodeAsAgent(agentId: string, shipmentId: string) {
    const shipment = await this.shipmentRepo.findById(shipmentId);
    if (!shipment || shipment.agent_id?.toString() !== agentId) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    }
    const { order, collection, code } = await this.regenerateCode(shipmentId);
    await this.notifyCodeIssued(order, collection, code);
    return { shipmentId, resentAt: new Date() };
  }

  /**
   * Customer re-requests their delivery code. Returns the code — it is the
   * customer's own secret.
   */
  async resendCodeAsCustomer(customerId: string, orderId: string, shipmentId: string) {
    const order = await OrderModel.findById(orderId);
    if (!order || order.customer_id.toString() !== customerId) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    }
    const shipment = await this.shipmentRepo.findById(shipmentId);
    if (!shipment || shipment.order_id.toString() !== orderId) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    }
    const { collection, code } = await this.regenerateCode(shipmentId, order);
    await this.notifyCodeIssued(order, collection, code);
    return { shipmentId, deliveryCode: code, expectedAmount: collection.expected_amount, currency: collection.currency };
  }

  private async regenerateCode(
    shipmentId: string,
    preloadedOrder?: IOrder
  ): Promise<{ order: IOrder; collection: ICashCollection; code: string }> {
    const collection = await this.collectionRepo.findByShipmentId(shipmentId);
    if (!collection || collection.status !== 'pending') {
      throw createAppError(ERROR_CODES.COD_COLLECTION_NOT_FOUND, 404);
    }

    const secondsSinceIssue = (Date.now() - collection.code_generated_at.getTime()) / 1000;
    if (secondsSinceIssue < COD_CONFIG.OTP_RESEND_MIN_SECONDS) {
      throw createAppError(ERROR_CODES.COD_CODE_RESEND_TOO_SOON, 429, undefined, {
        retryInSeconds: Math.ceil(COD_CONFIG.OTP_RESEND_MIN_SECONDS - secondsSinceIssue),
      });
    }

    const order = preloadedOrder ?? (await OrderModel.findById(collection.order_id)) ?? null;
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    }

    const code = this.codes.generateCode();
    const updated = await this.collectionRepo.replaceCode(
      collection._id as Types.ObjectId,
      this.codes.hashCode(code),
      code
    );

    return { order, collection: updated ?? collection, code };
  }

  // ─── Shipment-return handling ───────────────────────────────────────────────

  /**
   * A COD shipment ended `returned`: void its pending collection and recompute
   * the order's COD payment status. Runs inside the caller's transaction.
   */
  async handleShipmentReturnedInSession(
    shipmentId: string,
    orderId: string,
    session: ClientSession
  ): Promise<void> {
    await this.collectionRepo.cancelPendingByShipment(shipmentId, session);
    await this.recomputeCodPaymentStatusInSession(orderId, session);
  }

  // ─── Order payment-status recompute ─────────────────────────────────────────

  /**
   * Derive a COD order's payment status from its shipments + collections.
   * For COD, delivered ⟺ cash collected (the code path is the only way to
   * 'delivered'), so:
   *  - every shipment delivered                         → paid
   *  - some cash collected, anything else outstanding   → partially_paid
   *  - nothing collected, every shipment returned       → failed
   */
  async recomputeCodPaymentStatusInSession(orderId: string, session: ClientSession): Promise<void> {
    const order = await OrderModel.findById(orderId).session(session);
    if (!order || order.payment_method !== 'cash_on_delivery') return;
    // Terminal financial states never regress.
    if (order.payment_status === 'paid' || order.payment_status === 'refunded' || order.payment_status === 'failed') return;

    const shipments = await ShipmentModel.find({ order_id: orderId }).session(session);
    if (shipments.length === 0) return;

    const collections = await this.collectionRepo.findByOrderId(orderId, session);
    const collectedCount = collections.filter((c) => c.status === 'collected').length;

    const allDelivered = shipments.every((s) => s.status === 'delivered');
    const allSettledOrReturned = shipments.every(
      (s) => s.status === 'delivered' || s.status === 'returned'
    );

    let next: PaymentStatus = order.payment_status;
    if (allDelivered) {
      next = 'paid';
    } else if (collectedCount > 0) {
      next = 'partially_paid';
    } else if (allSettledOrReturned) {
      // No cash ever collected and every shipment came back.
      next = 'failed';
    }

    if (next !== order.payment_status) {
      await OrderModel.updateOne({ _id: orderId }, { $set: { payment_status: next } }, { session });
    }
  }

  // ─── Read views ─────────────────────────────────────────────────────────────

  /**
   * COD blocks for customer order views, keyed by orderId. Includes the
   * plaintext delivery code for still-pending collections when
   * `includeCode` — customer-scoped callers only.
   */
  async getCodBlocksForOrders(orderIds: string[], includeCode: boolean) {
    const collections = includeCode
      ? await this.collectionRepo.findByOrderIdsWithCode(orderIds)
      : await CashCollectionModel.find({ order_id: { $in: orderIds } });

    const byOrder = new Map<string, any[]>();
    for (const c of collections) {
      const key = c.order_id.toString();
      const list = byOrder.get(key) ?? [];
      list.push({
        shipmentId: c.shipment_id.toString(),
        expectedAmount: c.expected_amount,
        currency: c.currency,
        status: c.status,
        collectedAt: c.collected_at,
        ...(includeCode && c.status === 'pending' ? { deliveryCode: c.code_plain ?? null } : {}),
      });
      byOrder.set(key, list);
    }
    return byOrder;
  }

  /** Public COD summary of one shipment (agency/agent views — never the code). */
  async getCodSummaryForShipment(shipmentId: string) {
    const collection = await this.collectionRepo.findByShipmentId(shipmentId);
    if (!collection) return null;
    return {
      expectedAmount: collection.expected_amount,
      currency: collection.currency,
      status: collection.status,
      collectedAt: collection.collected_at,
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /**
   * Expected cash for a shipment: Σ (order item price × shipment item qty).
   * Public: also used by the exposure gate at agent-assignment time, before
   * any collection exists.
   */
  computeExpectedAmount(order: IOrder, shipment: IShipment): number {
    const itemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
    let total = 0;
    for (const si of shipment.items) {
      const orderItem = itemsById.get(si.order_item_id.toString());
      if (!orderItem) {
        throw createAppError(ERROR_CODES.ORDER_ITEM_NOT_FOUND, 500, 'Shipment references an unknown order item', {
          shipmentId: (shipment._id as any).toString(),
          orderItemId: si.order_item_id.toString(),
        });
      }
      total += orderItem.price * si.quantity;
    }
    // NOTE: order-level tax/discount are 0 today (see buildVendorOrder TODOs).
    // Once they exist they must be apportioned per shipment here.
    return total;
  }

  private async emitPostCollectionEvents(order: IOrder, collection: ICashCollection, agentId: string) {
    // Timeline (audit trail on the order).
    try {
      await this.timelineRepo.appendEvent({
        orderId: order._id.toString(),
        eventType: 'payment.updated',
        description: `Cash collected on delivery (${collection.expected_amount} ${collection.currency})`,
        metadata: {
          codCollectionId: collection._id.toString(),
          shipmentId: collection.shipment_id.toString(),
          agentId,
          amount: collection.expected_amount,
          paymentStatus: order.payment_status,
        },
        actorType: 'system',
        actorId: null,
      });
    } catch (error) {
      console.error('[CashCollectionService] Failed to append timeline event:', error);
    }

    // payment.received.* — same contract the gateway path emits, so vendor
    // notifications work unchanged for COD.
    try {
      const isFull = order.payment_status === 'paid';
      const eventType = isFull ? 'payment.received.full' : 'payment.received.partial';
      await eventBus.publish(eventType, {
        eventType,
        aggregateId: order._id.toString(),
        occurredAt: new Date(),
        payload: {
          vendorId: order.vendor_id.toString(),
          paymentId: collection._id.toString(),
          orderId: order._id.toString(),
          amount: collection.expected_amount,
          currency: collection.currency,
          totalAmount: order.total_amount,
          aggregateType: 'order',
        },
      });
    } catch (error) {
      console.error('[CashCollectionService] Failed to emit payment.received event:', error);
    }

    // COD domain event (no subscribers yet — future consumers/analytics).
    try {
      await eventBus.publish('cod.collection.recorded', {
        eventType: 'cod.collection.recorded',
        aggregateId: collection._id.toString(),
        occurredAt: new Date(),
        payload: {
          collectionId: collection._id.toString(),
          orderId: order._id.toString(),
          shipmentId: collection.shipment_id.toString(),
          agencyId: collection.agency_id.toString(),
          agentId,
          amount: collection.expected_amount,
          currency: collection.currency,
        },
      });
    } catch (error) {
      console.error('[CashCollectionService] Failed to emit cod.collection.recorded:', error);
    }
  }

  private toDto(collection: ICashCollection, orderPaymentStatus: string | null) {
    return {
      collectionId: collection._id.toString(),
      shipmentId: collection.shipment_id.toString(),
      orderId: collection.order_id.toString(),
      amount: collection.expected_amount,
      currency: collection.currency,
      status: collection.status,
      collectedAt: collection.collected_at,
      orderPaymentStatus,
    };
  }
}

export const cashCollectionService = new CashCollectionService();
