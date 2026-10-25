import { Types } from 'mongoose';
import { eventBus } from '../../../core/events/event-bus';
import { EarningsAllocationRepository, SourceRef } from '../repositories/earnings-allocation.repository';
import { EarningsSourceType } from '../models/earnings-allocation.model';
import { EARNINGS_CONFIG, daysFromNow } from '../config/earnings.config';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { OrderModel } from '../../orders/order.model';
import { holdReleaseFrom, isCourierFinished } from '../domain/earnings-hold';
import { courierHoldStartOf } from '../domain/courier-hold';

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
   *
   * It then syncs every parcel's COURIER clock (agency and rider rows with their own terms,
   * earnings/domain/courier-hold.ts): every caller is already a moment a parcel's state may
   * have changed, so this is the one hook they all go through. A courier failure is logged,
   * never thrown: the order's own hold above is already written. The nightly sweep is the
   * courier clock's backstop (`EarningsReleaseWorker.startCourierHolds`).
   */
  async syncOrderHold(orderId: string, now: Date = new Date()): Promise<void> {
    await this.syncOrderClock(orderId, now);
    try {
      const shipments = await ShipmentModel.find({ order_id: new Types.ObjectId(orderId) }, { _id: 1 }).lean();
      for (const s of shipments) await this.syncShipmentCourierHold(s._id.toString(), now);
    } catch (error) {
      console.error(`[EarningsCompletionService] courier hold sync failed for order ${orderId}:`, error);
    }
  }

  /** Every source one delivery's money hangs off: its `shipment` row and its COD collections. */
  async sourcesOfShipment(shipmentId: string): Promise<SourceRef[]> {
    const collections = await CashCollectionModel.find({ shipment_id: new Types.ObjectId(shipmentId) }, { _id: 1 });
    return [
      { sourceType: 'shipment', sourceId: shipmentId },
      ...collections.map((c) => ({ sourceType: 'cod_collection' as const, sourceId: c._id.toString() })),
    ];
  }

  /**
   * Bring one delivery's agency and rider rows in line with the parcel (owner decision,
   * 2026-10-22). Each row carries its agency's terms (`courier_hold`):
   *  - parcel at a starting status for that row (`courierStartStatuses`) and the row not
   *    started → started from the parcel's own history, released `days` later (0 = at the
   *    next nightly sweep);
   *  - parcel no longer at one (`agent_delivered → failed`) and the row started → un-started.
   * Rows without a snapshot are the order's business and are not touched. Idempotent; never
   * moves a date it already wrote (a resume may have moved it since).
   */
  async syncShipmentCourierHold(shipmentId: string, now: Date = new Date()): Promise<void> {
    const rows = await this.allocationRepo.findHeldCourierBySources(await this.sourcesOfShipment(shipmentId), true);
    if (rows.length === 0) return;
    const shipment = await ShipmentModel.findById(shipmentId, {
      status: 1, status_history: 1, customer_confirmation: 1, order_id: 1,
    }).lean();
    if (!shipment) return;
    const order = await OrderModel.findById(shipment.order_id, { payment_method: 1 }).lean();
    const isCod = order?.payment_method === 'cash_on_delivery';

    for (const row of rows) {
      const hold = row.courier_hold!;
      const start = courierHoldStartOf(shipment as any, isCod, hold.days === 0, now);
      if (start && !row.completed_at) {
        await this.allocationRepo.startCourierHold(row._id as Types.ObjectId, start, holdReleaseFrom(start, hold.days));
      } else if (!start && row.completed_at) {
        await this.allocationRepo.clearCourierHold(row._id as Types.ObjectId);
      }
    }
  }

  /** The order-level half of `syncOrderHold`: every row that is not on a courier clock. */
  private async syncOrderClock(orderId: string, now: Date): Promise<void> {
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
