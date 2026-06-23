import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { IOrder } from './order.model';
import { OrderTimelineRepository } from './order-timeline.repository';
import {
  EarningsCompletionService,
  earningsCompletionService,
} from '../earnings/services/earnings-completion.service';

/**
 * OrderCompletionService - marks an order "completed" (customer confirmed
 * delivery/satisfaction, or system auto-confirmed) and starts the escrow hold
 * window.
 *
 * Shared by the customer confirm-delivery endpoint and the auto-confirm sweep so
 * the side effects (stamp `completion`, append timeline, mature the held
 * earnings) stay identical regardless of who triggers completion.
 */
export class OrderCompletionService {
  constructor(
    private readonly timelineRepo: OrderTimelineRepository = new OrderTimelineRepository(),
    private readonly earningsCompletion: EarningsCompletionService = earningsCompletionService
  ) {}

  /**
   * Throw if the order is not in a state a customer may confirm. An order is
   * confirmable once its fulfilment has reached `delivered` (physical) or
   * `fulfilled` (digital) and it has not already been completed.
   */
  assertConfirmable(order: IOrder): void {
    if (order.completion?.confirmed_at) {
      throw createAppError(ERROR_CODES.EARNINGS_ALREADY_COMPLETED, 409);
    }
    const confirmable = order.fulfillment_status === 'delivered' || order.fulfillment_status === 'fulfilled';
    if (!confirmable) {
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

    // Start the escrow hold window on this order's held earnings.
    await this.earningsCompletion.onSourceCompleted('order', order._id.toString(), now);
  }
}

export const orderCompletionService = new OrderCompletionService();
