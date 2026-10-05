import { Types } from 'mongoose';
import { eventBus } from '../../../core/events/event-bus';
import { EarningsAllocationRepository, SourceRef } from '../repositories/earnings-allocation.repository';
import { EarningsSourceType } from '../models/earnings-allocation.model';
import { EARNINGS_CONFIG, daysFromNow } from '../config/earnings.config';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { OrderModel } from '../../orders/order.model';
import { holdReleaseFrom, isCourierFinished } from '../domain/earnings-hold';

/**
 * EarningsCompletionService — starts the escrow hold on an order's or booking's money.
 *
 * ── When the hold starts (owner decision, 2026-10-05) ───────────────────────
 * An ORDER's hold starts at DELIVERY: the moment the courier finishes the last parcel
 * (`Order.delivered_at`, written by `syncOrderHold`), or, for a digital order, the moment it
 * is paid. It used to start at completion — the customer's confirmation, or the auto-confirm
 * sweep days later — and completion is now only the backstop for a row nothing else started.
 * A BOOKING's hold still starts when the service is marked completed, which is its delivery.
 *
 * ── One order, one maturity date, every actor ────────────────────────────────
 * An order's money does not all hang off the order row, and for the same reason in both
 * cases — the delivery fee cannot be divided until it is known who made the delivery:
 *  - A COD order splits per cash handoff (`source_type: 'cod_collection'`).
 *  - A PREPAID order splits its delivery fee per SHIPMENT (`source_type: 'shipment'`).
 * Every one of them is started together, from the same date, by `sourcesOfOrder`. A source
 * type added later that belongs to an order must be added there, or its money is held
 * forever (`findMaturedHeld` skips a null `hold_release_at`). That failure was caught once
 * for COD and once for prepaid shipments.
 */
export class EarningsCompletionService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository()
  ) {}

  /** Every source an order's money hangs off: its own row, its COD collections, its shipments. */
  async sourcesOfOrder(orderId: string): Promise<SourceRef[]> {
    const id = new Types.ObjectId(orderId);
    const [collections, shipments] = await Promise.all([
      CashCollectionModel.find({ order_id: id }, { _id: 1 }),
      ShipmentModel.find({ order_id: id }, { _id: 1 }),
    ]);
    return [
      { sourceType: 'order', sourceId: orderId },
      ...collections.map((c) => ({ sourceType: 'cod_collection' as const, sourceId: c._id.toString() })),
      ...shipments.map((s) => ({ sourceType: 'shipment' as const, sourceId: s._id.toString() })),
    ];
  }

  /**
   * Bring the order's hold in line with its delivery state. Call it after anything that can
   * change that state: a shipment transition, a COD collection, a payment on a digital order.
   * Idempotent and safe to call twice, or late.
   *
   *  - delivered (every parcel finished by the courier; digital: paid) and not yet stamped →
   *    `delivered_at = now`, and every held row of the order starts its hold from it;
   *  - already stamped → rows created since (a shipment split landing after the sync, a
   *    recovery re-split) are started from the same `delivered_at`, so one order still has
   *    one maturity date;
   *  - no longer delivered (a delivered parcel went back to `failed`) and the order not
   *    completed → the stamp and the hold on still-held rows are cleared. Released money is
   *    never touched.
   *
   * Best-effort like the splits it follows: callers `void` it with a catch. The order's
   * completion is the backstop that starts anything this missed.
   */
  async syncOrderHold(orderId: string, now: Date = new Date()): Promise<void> {
    const order = await OrderModel.findById(orderId, {
      order_type: 1, payment_method: 1, payment_status: 1, delivered_at: 1, completion: 1,
    });
    if (!order) return;

    let delivered: boolean;
    if (order.order_type === 'physical') {
      const shipments = await ShipmentModel.find({ order_id: order._id }, { status: 1 });
      delivered = isCourierFinished(
        shipments.map((s) => s.status as string),
        order.payment_method === 'cash_on_delivery'
      );
    } else {
      delivered = order.payment_status === 'paid';
    }

    if (delivered) {
      let anchor = order.delivered_at ?? null;
      if (!anchor) {
        const res = await OrderModel.updateOne(
          { _id: order._id, delivered_at: null },
          { $set: { delivered_at: now } }
        );
        if ((res.modifiedCount ?? 0) > 0) {
          anchor = now;
        } else {
          // A concurrent sync won the stamp; use its date, not ours.
          anchor = (await OrderModel.findById(order._id, { delivered_at: 1 }))?.delivered_at ?? now;
        }
      }
      await this.startHold(await this.sourcesOfOrder(orderId), anchor, orderId);
      return;
    }

    if (order.delivered_at && !order.completion?.confirmed_at && order.order_type === 'physical') {
      await OrderModel.updateOne({ _id: order._id }, { $set: { delivered_at: null } });
      await this.allocationRepo.clearHoldBySources(await this.sourcesOfOrder(orderId));
    }
  }

  /**
   * Completion backstop. Starts, from the completion date, any row of the order that has no
   * hold yet — normally none, since delivery started them all.
   */
  async onOrderCompleted(orderId: string, completedAt: Date = new Date()): Promise<void> {
    await this.startHold(await this.sourcesOfOrder(orderId), completedAt, orderId);
  }

  /** A single source completed — a booking marked completed, chiefly. */
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
    if (modified > 0) await this.emitMatured(sourceType, sourceId, holdReleaseAt, modified);
  }

  private async startHold(sources: SourceRef[], startedAt: Date, orderId: string): Promise<void> {
    const holdReleaseAt = holdReleaseFrom(startedAt, EARNINGS_CONFIG.HOLD_DAYS);
    const modified = await this.allocationRepo.markCompletedBySources(sources, startedAt, holdReleaseAt);
    if (modified > 0) await this.emitMatured('order', orderId, holdReleaseAt, modified);
  }

  private async emitMatured(
    sourceType: EarningsSourceType,
    sourceId: string,
    holdReleaseAt: Date,
    allocationsTouched: number
  ): Promise<void> {
    try {
      await eventBus.publish('earnings.matured', {
        eventType: 'earnings.matured',
        aggregateId: sourceId,
        payload: { sourceType, sourceId, holdReleaseAt, allocationsTouched },
        occurredAt: new Date(),
      });
    } catch (error) {
      console.error('[EarningsCompletionService] Failed to emit earnings.matured event:', error);
    }
  }
}

export const earningsCompletionService = new EarningsCompletionService();
