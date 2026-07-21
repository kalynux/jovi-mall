import { ClientSession } from 'mongoose';
import { OrderModel, FulfillmentStatus } from '../../order.model';

// Item delivery statuses that mean "has left the vendor/agency for delivery."
// `handing_over` is included: the parcel was already picked up and is mid-transfer
// to a replacement agent, so the order has not regressed to "still processing".
const SHIPPED_OR_BEYOND: readonly string[] = ['handing_over', 'picked_up', 'in_transit', 'agent_delivered', 'delivered'];

// fulfillment_status values this service is allowed to move the order out of.
// Never touches 'pending' (vendor hasn't started processing) or 'cancelled'/
// 'returned'/'fulfilled' (terminal or digital-only) — those stay vendor/system
// owned via their own dedicated paths.
const RECOMPUTABLE_FROM: readonly FulfillmentStatus[] = ['processing', 'partially_shipped', 'shipped', 'partially_delivered', 'delivered'];

/**
 * Derives `Order.fulfillment_status` from the order's own physical items'
 * `delivery.status` (the per-item source of truth — an order can be split
 * across several delivery agencies, one shipment per agency).
 *
 * This is the ONLY writer of 'partially_shipped' / 'shipped' /
 * 'partially_delivered' / 'delivered' — vendors can no longer free-set these
 * (see the vendor-triggerable-only FULFILLMENT_STATE_MACHINE in
 * VendorOrderService). Call after every shipment status change: agency actions
 * (picked_up/in_transit/agent_delivered) and customer per-shipment delivery
 * confirmation (agent_delivered → delivered).
 *
 * 'delivered' here means every item's `delivery.status === 'delivered'`, i.e.
 * customer-confirmed — 'agent_delivered' (agent-claimed, unconfirmed) does NOT
 * count, since fulfillment_status gates escrow release and must reflect
 * confirmed reality, not agent-claimed reality.
 */
export class OrderFulfillmentAggregationService {
  async recomputeFulfillmentStatus(orderId: string, session?: ClientSession): Promise<FulfillmentStatus | null> {
    const query = OrderModel.findById(orderId);
    if (session) query.session(session);
    const order = await query.exec();

    if (!order || order.order_type !== 'physical' || order.items.length === 0) return null;
    if (!RECOMPUTABLE_FROM.includes(order.fulfillment_status)) return null;

    const deliveryStatuses = order.items
      .map(item => item.delivery?.status)
      .filter((s): s is NonNullable<typeof s> => !!s);

    if (deliveryStatuses.length === 0) return null;

    const allShipped = deliveryStatuses.every(s => SHIPPED_OR_BEYOND.includes(s));
    const someShipped = deliveryStatuses.some(s => SHIPPED_OR_BEYOND.includes(s));
    const allDelivered = deliveryStatuses.every(s => s === 'delivered');
    const someDelivered = deliveryStatuses.some(s => s === 'delivered');

    let next: FulfillmentStatus;
    if (allDelivered) {
      next = 'delivered';
    } else if (someDelivered) {
      next = 'partially_delivered';
    } else if (allShipped) {
      next = 'shipped';
    } else if (someShipped) {
      next = 'partially_shipped';
    } else {
      return null; // No forward movement yet (still processing).
    }

    if (next === order.fulfillment_status) return null;

    order.fulfillment_status = next;
    await order.save({ session });
    return next;
  }
}

export const orderFulfillmentAggregationService = new OrderFulfillmentAggregationService();
