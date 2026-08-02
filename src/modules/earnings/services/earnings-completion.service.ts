import { Types } from 'mongoose';
import { eventBus } from '../../../core/events/event-bus';
import { EarningsAllocationRepository } from '../repositories/earnings-allocation.repository';
import { EarningsSourceType } from '../models/earnings-allocation.model';
import { EARNINGS_CONFIG, daysFromNow } from '../config/earnings.config';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { ShipmentModel } from '../../shipments/shipment.model';

/**
 * EarningsCompletionService - reacts to an order/booking being completed
 * (customer confirmed delivery / satisfaction, or auto-confirmed).
 *
 * It stamps `completed_at` + `hold_release_at` (= completed_at + HOLD_DAYS) on
 * the source's still-`held` allocations. The release worker later moves matured
 * holds to the withdrawable balance. Idempotent: a second call is a no-op because
 * only rows with `completed_at: null` are touched.
 *
 * ── One order, one maturity date, every actor ────────────────────────────────
 *
 * An order's money does not all hang off the order row, and for the same reason
 * in both cases — the delivery fee cannot be divided until it is known who made
 * the delivery:
 *  - A COD order splits per cash handoff (`source_type: 'cod_collection'`),
 *    because that is when the cash exists and who collected it is known.
 *  - A PREPAID order splits its delivery fee per SHIPMENT
 *    (`source_type: 'shipment'`) at `agent_delivered`, when the agent is known.
 *
 * Those allocations still belong to the same order, and `onOrderCompleted`
 * matures all of them with it — see the note there.
 */
export class EarningsCompletionService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository()
  ) {}

  /**
   * Mature every allocation an order produced — its own row, its per-collection
   * COD rows AND its per-shipment prepaid delivery rows — on one date.
   *
   * Sourcing those rows by order is the whole point: `markCompletedBySource` is
   * keyed by source, and an order's money is spread across three source types.
   * Stamping only `('order', orderId)` therefore silently leaves the delivery
   * money held forever, since `findMaturedHeld` skips a null `hold_release_at`.
   * That failure was caught once for COD; the prepaid shipment rows added here
   * are the same trap, and any FUTURE source type belonging to an order must be
   * swept here too.
   *
   * This is also what makes the hold window uniform: agency and agent shares of a
   * prepaid delivery become withdrawable HOLD_DAYS after the order completes,
   * exactly like the vendor's, the platform's, and a COD agent's — never at
   * delivery, and never on a per-shipment clock.
   *
   * Idempotent by the same rule as markCompletedBySource: only rows with no
   * completion date are touched, so a re-confirm or a second sweep is a no-op.
   */
  async onOrderCompleted(orderId: string, completedAt: Date = new Date()): Promise<void> {
    await this.onSourceCompleted('order', orderId, completedAt);

    const collections = await CashCollectionModel.find(
      { order_id: new Types.ObjectId(orderId) },
      { _id: 1 }
    );
    for (const collection of collections) {
      await this.onSourceCompleted('cod_collection', collection._id.toString(), completedAt);
    }

    const shipments = await ShipmentModel.find(
      { order_id: new Types.ObjectId(orderId) },
      { _id: 1 }
    );
    for (const shipment of shipments) {
      await this.onSourceCompleted('shipment', shipment._id.toString(), completedAt);
    }
  }

  async onSourceCompleted(
    sourceType: EarningsSourceType,
    sourceId: string,
    completedAt: Date = new Date()
  ): Promise<void> {
    const holdReleaseAt = daysFromNow(EARNINGS_CONFIG.HOLD_DAYS, completedAt);
    const modified = await this.allocationRepo.markCompletedBySource(
      sourceType,
      sourceId,
      completedAt,
      holdReleaseAt
    );

    if (modified > 0) {
      try {
        await eventBus.publish('earnings.matured', {
          eventType: 'earnings.matured',
          aggregateId: sourceId,
          payload: { sourceType, sourceId, holdReleaseAt, allocationsTouched: modified },
          occurredAt: new Date(),
        });
      } catch (error) {
        console.error('[EarningsCompletionService] Failed to emit earnings.matured event:', error);
      }
    }
  }
}

export const earningsCompletionService = new EarningsCompletionService();
