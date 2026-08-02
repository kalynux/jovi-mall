import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { IOrder } from './order.model';
import { OrderTimelineRepository } from './order-timeline.repository';
import {
  EarningsCompletionService,
  earningsCompletionService,
} from '../earnings/services/earnings-completion.service';

/**
 * Item delivery statuses from which nothing further will happen.
 *
 * `failed` is deliberately absent: a failed delivery is still in the agent's
 * hands and can go back to `in_transit` (see TRIGGERABLE_TRANSITIONS),
 * so the order is not finished. `rejected` and `pending_agency_reassignment`
 * are likewise waiting on someone.
 */
const TERMINAL_ITEM_DELIVERY_STATUSES: readonly string[] = ['delivered', 'returned'];

/**
 * OrderCompletionService - marks an order "completed" (customer confirmed
 * delivery/satisfaction, or system auto-confirmed) and starts the escrow hold
 * window.
 *
 * Shared by the customer confirm-delivery endpoint and the auto-confirm sweep so
 * the side effects (stamp `completion`, append timeline, mature the held
 * earnings) stay identical regardless of who triggers completion.
 *
 * Completion is what starts the hold window for EVERY actor on the order —
 * vendor, platform, agency and agent alike. Nobody's share matures early and
 * nobody's late; see EarningsCompletionService.onOrderCompleted.
 */
export class OrderCompletionService {
  constructor(
    private readonly timelineRepo: OrderTimelineRepository = new OrderTimelineRepository(),
    private readonly earningsCompletion: EarningsCompletionService = earningsCompletionService
  ) {}

  /**
   * Is the order finished — i.e. has every physical item reached a state from
   * which nothing more will happen?
   *
   * NOT the same as `fulfillment_status === 'delivered'`, which requires every
   * item to be *delivered*. An order with one item delivered and one returned is
   * every bit as finished, but sits at `partially_delivered` and would otherwise
   * never complete — stranding the delivered item's escrow permanently. For COD
   * that is real cash already taken from a customer, so leaving it unreleasable
   * is worse than any alternative.
   */
  isSettled(order: IOrder): boolean {
    if (order.order_type !== 'physical') return order.fulfillment_status === 'fulfilled';

    const statuses = order.items
      .map((item) => item.delivery?.status)
      .filter((s): s is NonNullable<typeof s> => !!s);

    return (
      statuses.length > 0 && statuses.every((s) => TERMINAL_ITEM_DELIVERY_STATUSES.includes(s))
    );
  }

  /**
   * Throw if the order is not in a state a customer may confirm: every item
   * settled, and not already completed.
   */
  assertConfirmable(order: IOrder): void {
    if (order.completion?.confirmed_at) {
      throw createAppError(ERROR_CODES.EARNINGS_ALREADY_COMPLETED, 409);
    }
    if (!this.isSettled(order)) {
      throw createAppError(ERROR_CODES.EARNINGS_ORDER_NOT_CONFIRMABLE, 422, undefined, {
        fulfillment_status: order.fulfillment_status,
      });
    }
  }

  /**
   * Complete an order. Idempotent: a second call on an already-completed order
   * is a no-op. `actorId` is the confirming user (null for the system sweep).
   */
  async complete(
    order: IOrder,
    confirmedBy: 'customer' | 'system',
    auto: boolean,
    actorId: string | null = null
  ): Promise<void> {
    if (order.completion?.confirmed_at) return; // already completed

    const now = new Date();
    order.completion = { confirmed_at: now, confirmed_by: confirmedBy, auto };
    await order.save();

    await this.timelineRepo.appendEvent({
      orderId: order._id.toString(),
      eventType: 'order.completed',
      description: auto
        ? 'Order auto-confirmed as completed after the confirmation window elapsed'
        : 'Customer confirmed delivery; order completed',
      metadata: { auto, confirmedBy },
      actorType: confirmedBy,
      actorId,
    });

    // Start the escrow hold window on every allocation this order produced —
    // including its per-shipment COD collection rows, which do not hang off the
    // order's own source id.
    await this.earningsCompletion.onOrderCompleted(order._id.toString(), now);
  }
}

export const orderCompletionService = new OrderCompletionService();
