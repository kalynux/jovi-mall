import { Types } from 'mongoose';
import { OrderModel } from '../../orders/order.model';
import { OrderTimelineRepository } from '../../orders/order-timeline.repository';
import { Booking } from '../../booking/models/booking.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { ActorSource } from '../../../core/types/actor-source.types';
import { EarningsAllocationRepository, SourceRef } from '../repositories/earnings-allocation.repository';
import { IEarningsAllocation } from '../models/earnings-allocation.model';
import { IEarningsPause } from '../models/earnings-pause.schema';
import {
  EarningsPauseReason,
  resumedHoldReleaseAt,
} from '../domain/earnings-hold';
import { earningsCompletionService, EarningsCompletionService } from './earnings-completion.service';

/** Who paused or resumed. A system pause has no user id and is recorded as `system`. */
export interface PauseActor {
  userId: string | null;
  source: ActorSource;
  name: string | null;
}

export const SYSTEM_PAUSE_ACTOR: PauseActor = { userId: null, source: 'platform', name: 'system' };

export type PauseTarget = { kind: 'order'; id: string } | { kind: 'booking'; id: string };

/** One row of the administrator's queue of paused money. */
export interface ActivePause {
  kind: PauseTarget['kind'];
  id: string;
  /** The order number or booking number. */
  reference: string | null;
  vendorId: string | null;
  /** What the customer paid for it. */
  amount: number | null;
  currency: string | null;
  pause: IEarningsPause;
}

export interface PauseOutcome {
  /** False when there was nothing to do (already paused / not paused). Never an error. */
  changed: boolean;
  pause: IEarningsPause | null;
}

/**
 * EarningsPauseService — stops and restarts the release of one order's or booking's money.
 *
 * ── The record and its index ─────────────────────────────────────────────────
 * The pause lives on the Order (`earnings_pause`) or Booking (`earningsPause`): that is the
 * truth, and it is what an administrator sees and acts on. Each still-held allocation gets a
 * copy of `paused_at`, purely so the release worker's QUERY can skip it. A row created while
 * the source is already paused (a shipment split landing after a dispute opened) has no copy;
 * `pausedAtOfSource` is how the worker catches it.
 *
 * ── Resuming continues the countdown ────────────────────────────────────────
 * Owner, 2026-10-05: paused money stays paused "until it is unpaused by the admin, where it
 * continues counting its held duration". `resumedHoldReleaseAt` moves each row's release date
 * by the paused time that fell inside its hold, so pausing never shortens or restarts a hold.
 *
 * ── What pauses on its own, and what resumes on its own ──────────────────────
 *  - a seller cancelling a PAID order          → paused; an administrator resumes or refunds
 *  - a paid booking cancelled from the status menu → paused; same
 *  - a card payment disputed                   → paused; resumes by itself if the dispute is won
 *  - an administrator                          → either, by hand, on any order or booking
 *
 * Every write is a compare-and-set, so two callers (an administrator and the dispute webhook,
 * say) can never both think they paused or resumed the same money.
 */
export class EarningsPauseService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly completion: EarningsCompletionService = earningsCompletionService,
    private readonly timelineRepo: OrderTimelineRepository = new OrderTimelineRepository()
  ) {}

  async pause(
    target: PauseTarget,
    reason: EarningsPauseReason,
    actor: PauseActor,
    note: string | null = null,
    now: Date = new Date()
  ): Promise<PauseOutcome> {
    const record: IEarningsPause = {
      active: true,
      reason,
      note,
      paused_at: now,
      paused_by_user_id: actor.userId,
      paused_by_source: actor.source,
      paused_by_name: actor.name,
      resumed_at: null,
      resumed_by_user_id: null,
      resumed_by_source: 'platform',
      resumed_by_name: null,
      resume_note: null,
    };

    const field = target.kind === 'order' ? 'earnings_pause' : 'earningsPause';
    const model: any = target.kind === 'order' ? OrderModel : Booking;
    const res = await model.updateOne(
      { _id: new Types.ObjectId(target.id), [`${field}.active`]: { $ne: true } },
      { $set: { [field]: record } }
    );
    if ((res.modifiedCount ?? 0) === 0) {
      return { changed: false, pause: await this.currentPause(target) };
    }

    await this.allocationRepo.markPausedBySources(await this.sourcesOf(target), now);
    if (target.kind === 'order') {
      await this.appendTimeline(target.id, 'earnings.paused', `Earnings paused (${reason})`, { reason, note }, actor);
    }
    return { changed: true, pause: record };
  }

  /**
   * Resume. `onlyIfReason` limits it to pauses raised for one of those reasons — the dispute
   * webhook uses it so that winning a dispute never lifts a pause an administrator placed.
   */
  async resume(
    target: PauseTarget,
    actor: PauseActor,
    note: string | null = null,
    onlyIfReason: readonly EarningsPauseReason[] | null = null,
    now: Date = new Date()
  ): Promise<PauseOutcome> {
    const current = await this.currentPause(target);
    if (!current?.active || !current.paused_at) return { changed: false, pause: current };
    if (onlyIfReason && (!current.reason || !onlyIfReason.includes(current.reason))) {
      return { changed: false, pause: current };
    }

    const field = target.kind === 'order' ? 'earnings_pause' : 'earningsPause';
    const model: any = target.kind === 'order' ? OrderModel : Booking;
    const res = await model.updateOne(
      {
        _id: new Types.ObjectId(target.id),
        [`${field}.active`]: true,
        [`${field}.paused_at`]: current.paused_at,
      },
      {
        $set: {
          [`${field}.active`]: false,
          [`${field}.resumed_at`]: now,
          [`${field}.resumed_by_user_id`]: actor.userId,
          [`${field}.resumed_by_source`]: actor.source,
          [`${field}.resumed_by_name`]: actor.name,
          [`${field}.resume_note`]: note,
        },
      }
    );
    if ((res.modifiedCount ?? 0) === 0) {
      return { changed: false, pause: await this.currentPause(target) };
    }

    const rows = await this.allocationRepo.findHeldBySources(await this.sourcesOf(target));
    for (const row of rows) {
      await this.allocationRepo.markResumed(
        row._id as Types.ObjectId,
        resumedHoldReleaseAt(row, current.paused_at, now)
      );
    }
    if (target.kind === 'order') {
      await this.appendTimeline(target.id, 'earnings.resumed', 'Earnings resumed', { note, pausedReason: current.reason }, actor);
    }
    return { changed: true, pause: await this.currentPause(target) };
  }

  /**
   * Every order and booking whose earnings are paused right now, newest pause first — the
   * queue an administrator works through. Orders and bookings live in two collections, so a
   * page of the combined list is assembled from the newest `page × limit` of each; the
   * volume of active pauses is small by construction (each one is an exception).
   */
  async listActive(
    kind: PauseTarget['kind'] | undefined,
    page: number,
    limit: number
  ): Promise<{ items: ActivePause[]; total: number }> {
    const window = page * limit;
    const wantOrders = kind !== 'booking';
    const wantBookings = kind !== 'order';

    const [orders, orderCount, bookings, bookingCount] = await Promise.all([
      wantOrders
        ? OrderModel.find(
            { 'earnings_pause.active': true },
            { order_number: 1, vendor_id: 1, total_amount: 1, currency: 1, earnings_pause: 1 }
          ).sort({ 'earnings_pause.paused_at': -1 }).limit(window).lean()
        : Promise.resolve([]),
      wantOrders ? OrderModel.countDocuments({ 'earnings_pause.active': true }) : Promise.resolve(0),
      wantBookings
        ? Booking.find(
            { 'earningsPause.active': true },
            { bookingNumber: 1, vendorId: 1, priceSnapshot: 1, currency: 1, earningsPause: 1 }
          ).sort({ 'earningsPause.paused_at': -1 }).limit(window).lean()
        : Promise.resolve([]),
      wantBookings ? Booking.countDocuments({ 'earningsPause.active': true }) : Promise.resolve(0),
    ]);

    const merged: ActivePause[] = [
      ...(orders as any[]).map((o) => ({
        kind: 'order' as const,
        id: o._id.toString(),
        reference: o.order_number ?? null,
        vendorId: o.vendor_id?.toString() ?? null,
        amount: o.total_amount ?? null,
        currency: o.currency ?? null,
        pause: o.earnings_pause as IEarningsPause,
      })),
      ...(bookings as any[]).map((b) => ({
        kind: 'booking' as const,
        id: b._id.toString(),
        reference: b.bookingNumber ?? null,
        vendorId: b.vendorId?.toString() ?? null,
        amount: b.priceSnapshot ?? null,
        currency: b.currency ?? null,
        pause: b.earningsPause as IEarningsPause,
      })),
    ].sort((a, b) => (b.pause.paused_at?.getTime() ?? 0) - (a.pause.paused_at?.getTime() ?? 0));

    return {
      items: merged.slice((page - 1) * limit, page * limit),
      total: orderCount + bookingCount,
    };
  }

  /** True when the order or booking exists. The admin endpoints answer 404 otherwise. */
  async targetExists(target: PauseTarget): Promise<boolean> {
    const model: any = target.kind === 'order' ? OrderModel : Booking;
    return (await model.countDocuments({ _id: new Types.ObjectId(target.id) }).limit(1)) > 0;
  }

  /** The pause record of an order or booking, or null when it has never been paused. */
  async currentPause(target: PauseTarget): Promise<IEarningsPause | null> {
    if (target.kind === 'order') {
      const order = await OrderModel.findById(target.id, { earnings_pause: 1 }).lean();
      return (order?.earnings_pause as IEarningsPause | undefined) ?? null;
    }
    const booking = await Booking.findById(target.id, { earningsPause: 1 }).lean();
    return ((booking as any)?.earningsPause as IEarningsPause | undefined) ?? null;
  }

  /**
   * When the source behind this allocation was paused, or null if it is not. For the release
   * worker's double-check on rows the query let through. `cache` is per sweep.
   */
  async pausedAtOfSource(
    allocation: IEarningsAllocation,
    cache: Map<string, Date | null>
  ): Promise<Date | null> {
    const target = await this.targetOf(allocation);
    if (!target) return null;
    const key = `${target.kind}:${target.id}`;
    if (!cache.has(key)) {
      const pause = await this.currentPause(target);
      cache.set(key, pause?.active ? (pause.paused_at ?? new Date()) : null);
    }
    return cache.get(key) ?? null;
  }

  private async targetOf(allocation: IEarningsAllocation): Promise<PauseTarget | null> {
    const id = allocation.source_id.toString();
    switch (allocation.source_type) {
      case 'order':
        return { kind: 'order', id };
      case 'booking':
        return { kind: 'booking', id };
      case 'shipment': {
        const s = await ShipmentModel.findById(id, { order_id: 1 }).lean();
        return s?.order_id ? { kind: 'order', id: s.order_id.toString() } : null;
      }
      case 'cod_collection': {
        const c = await CashCollectionModel.findById(id, { order_id: 1 }).lean();
        return c?.order_id ? { kind: 'order', id: c.order_id.toString() } : null;
      }
      default:
        return null;
    }
  }

  private async sourcesOf(target: PauseTarget): Promise<SourceRef[]> {
    return target.kind === 'order'
      ? this.completion.sourcesOfOrder(target.id)
      : [{ sourceType: 'booking', sourceId: target.id }];
  }

  private async appendTimeline(
    orderId: string,
    eventType: 'earnings.paused' | 'earnings.resumed',
    description: string,
    metadata: Record<string, unknown>,
    actor: PauseActor
  ): Promise<void> {
    try {
      await this.timelineRepo.appendEvent({
        orderId,
        eventType,
        description,
        metadata: { ...metadata, actorSource: actor.source, actorName: actor.name },
        actorType: actor.userId ? (actor.source === 'admin' ? 'admin' : 'system') : 'system',
        actorId: actor.userId,
      });
    } catch (error) {
      // The pause itself is written; a missing timeline line must not undo it.
      console.error('[EarningsPauseService] timeline append failed:', error);
    }
  }
}

export const earningsPauseService = new EarningsPauseService();
