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
  REFUND_CLOSABLE_PAUSE_REASONS,
  resumedHoldReleaseAt,
} from '../domain/earnings-hold';
import { COURIER_BENEFICIARIES, orderPauseReachesRow, shipmentPauseReachesRow } from '../domain/courier-hold';
import { earningsCompletionService, EarningsCompletionService } from './earnings-completion.service';

/** Who paused or resumed. A system pause has no user id and is recorded as `system`. */
export interface PauseActor {
  userId: string | null;
  source: ActorSource;
  name: string | null;
}

export const SYSTEM_PAUSE_ACTOR: PauseActor = { userId: null, source: 'platform', name: 'system' };

/** An order's or a booking's money — what the system's own pauses (refund, dispute, ticket) act on. */
export type PauseTarget = { kind: 'order'; id: string } | { kind: 'booking'; id: string };

/**
 * Everything an administrator can pause: an order, a booking, or ONE DELIVERY (`shipment`) —
 * its agency's and rider's shares only (owner decision, 2026-10-22). Kept apart from
 * `PauseTarget` so the refund, dispute and ticket code, which never pause a delivery, cannot
 * be handed one.
 */
export type EarningsPauseTarget = PauseTarget | { kind: 'shipment'; id: string };

/** One row of the administrator's queue of paused money. */
export interface ActivePause {
  kind: EarningsPauseTarget['kind'];
  id: string;
  /** The order number, booking number, or a delivery's tracking number. */
  reference: string | null;
  vendorId: string | null;
  /** What the customer paid for it; for a delivery, its delivery fee. */
  amount: number | null;
  currency: string | null;
  /** A delivery only: its order and its agency. Null on an order or a booking. */
  orderId?: string | null;
  agencyId?: string | null;
  pause: IEarningsPause;
}

export interface PauseOutcome {
  /** False when there was nothing to do (already paused / not paused). Never an error. */
  changed: boolean;
  pause: IEarningsPause | null;
}

/** A pause as the release worker's per-sweep cache holds it. */
interface CachedPause {
  pausedAt: Date;
  reason: EarningsPauseReason | null;
}

/** The release worker's per-sweep cache for `pausedAtOfSource`, keyed `kind:id`. */
export type PauseCache = Map<string, CachedPause | null>;

/**
 * EarningsPauseService — stops and restarts the release of one order's, booking's or
 * delivery's money.
 *
 * ── The record and its index ─────────────────────────────────────────────────
 * The pause lives on the Order (`earnings_pause`), the Booking (`earningsPause`) or the
 * Shipment (`earnings_pause`, a delivery pause): that is the truth, and it is what an
 * administrator sees and acts on. Each still-held allocation it reaches gets a copy of
 * `paused_at`, purely so the release worker's QUERY can skip it. A row created while the
 * source is already paused (a shipment split landing after a dispute opened) has no copy;
 * `pausedAtOfSource` is how the worker catches it.
 *
 * ── Which rows a pause reaches (owner decision, 2026-10-22) ──────────────────
 *  - an ORDER pause reaches every row of the order — except that an ADMINISTRATOR's order
 *    pause skips an agency (and its rider) whose own terms free it (`orderPauseReachesRow`);
 *  - a DELIVERY pause reaches only that parcel's agency and rider rows;
 *  - a BOOKING pause reaches the booking's rows.
 * A courier row can therefore be held by two pauses at once. It stays paused until NEITHER
 * holds it, and its `paused_at` is the start of that unbroken span — which is why a resume
 * moves each row by ITS OWN `paused_at`, not the lifted record's.
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
 *  - an administrator                          → either, by hand, on any order, booking or delivery
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
    target: EarningsPauseTarget,
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

    const { model, field } = recordOf(target);
    const res = await model.updateOne(
      { _id: new Types.ObjectId(target.id), [`${field}.active`]: { $ne: true } },
      { $set: { [field]: record } }
    );
    if ((res.modifiedCount ?? 0) === 0) {
      return { changed: false, pause: await this.currentPause(target) };
    }

    if (target.kind === 'shipment') {
      const rows = await this.heldRowsOf(target);
      await this.allocationRepo.markPausedByIds(rows.map((r) => r._id as Types.ObjectId), now);
    } else {
      await this.allocationRepo.markPausedBySources(await this.sourcesOf(target), now, {
        exceptFreeCourier: reason === 'admin',
      });
    }
    await this.appendTimeline(target, 'earnings.paused', reason, { reason, note }, actor);
    return { changed: true, pause: record };
  }

  /**
   * Resume. `onlyIfReason` limits it to pauses raised for one of those reasons — the dispute
   * webhook uses it so that winning a dispute never lifts a pause an administrator placed.
   */
  async resume(
    target: EarningsPauseTarget,
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

    const { model, field } = recordOf(target);
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

    const others = new Map<string, CachedPause | null>();
    for (const row of await this.heldRowsOf(target)) {
      if (!reaches(target, row, current.reason)) continue; // this pause never held it
      if (await this.otherPauseHolds(row, target, others)) continue; // still held by the other one
      await this.allocationRepo.markResumed(
        row._id as Types.ObjectId,
        // The row's own mark is the start of its unbroken paused span (see the header); a row
        // created during the pause and not yet marked by the worker paused with the record.
        resumedHoldReleaseAt(row, row.paused_at ?? current.paused_at, now)
      );
    }
    await this.appendTimeline(target, 'earnings.resumed', null, { note, pausedReason: current.reason }, actor);
    return { changed: true, pause: await this.currentPause(target) };
  }

  /**
   * A refund was PAID: close the pause that existed only because it was owed
   * (REFUND-FLOW-PLAN § 6.5). Closes `refund_in_progress`, `seller_cancelled_paid_order` and
   * `booking_cancelled_unrefunded` — nothing else: a card dispute waits for its verdict and an
   * administrator's pause for an administrator.
   *
   * Called AFTER the clawback, so what is left held is the part the refund did not take back.
   * ⚠ Unlike `resume`, it does NOT move hold dates: the refund settled the matter, and the rest
   * of the money matures on the dates it already had (owner contract § 11.3). This also ends
   * today's gap where a fully refunded seller-cancel stayed in the admin queue forever.
   */
  async closeOnRefund(
    target: PauseTarget,
    note: string | null = null,
    actor: PauseActor = SYSTEM_PAUSE_ACTOR,
    now: Date = new Date()
  ): Promise<PauseOutcome> {
    const current = await this.currentPause(target);
    if (!current?.active || !current.paused_at) return { changed: false, pause: current };
    if (!current.reason || !REFUND_CLOSABLE_PAUSE_REASONS.includes(current.reason)) {
      return { changed: false, pause: current };
    }

    const { model, field } = recordOf(target);
    const res = await model.updateOne(
      {
        _id: new Types.ObjectId(target.id),
        [`${field}.active`]: true,
        [`${field}.paused_at`]: current.paused_at,
        [`${field}.reason`]: current.reason,
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

    // Lift the index copy only; the release date each row already has stands. A courier row a
    // delivery pause still holds keeps its mark.
    const others = new Map<string, CachedPause | null>();
    for (const row of await this.heldRowsOf(target)) {
      if (!reaches(target, row, current.reason)) continue;
      if (await this.otherPauseHolds(row, target, others)) continue;
      await this.allocationRepo.markResumed(row._id as Types.ObjectId, row.hold_release_at);
    }
    await this.appendTimeline(
      target,
      'earnings.resumed',
      null,
      { note, pausedReason: current.reason, closedBy: 'refund' },
      actor,
      'Earnings pause closed: refund completed'
    );
    return { changed: true, pause: await this.currentPause(target) };
  }

  /**
   * Every order, booking and delivery whose earnings are paused right now, newest pause
   * first — the queue an administrator works through. They live in three collections, so a
   * page of the combined list is assembled from the newest `page × limit` of each; the
   * volume of active pauses is small by construction (each one is an exception).
   */
  async listActive(
    kind: EarningsPauseTarget['kind'] | undefined,
    page: number,
    limit: number
  ): Promise<{ items: ActivePause[]; total: number }> {
    const window = page * limit;
    const wantOrders = !kind || kind === 'order';
    const wantBookings = !kind || kind === 'booking';
    const wantShipments = !kind || kind === 'shipment';

    const [orders, orderCount, bookings, bookingCount, shipments, shipmentCount] = await Promise.all([
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
      wantShipments
        ? ShipmentModel.find(
            { 'earnings_pause.active': true },
            { tracking_number: 1, order_id: 1, agency_id: 1, delivery_fee_snapshot: 1, earnings_pause: 1 }
          ).sort({ 'earnings_pause.paused_at': -1 }).limit(window).lean()
        : Promise.resolve([]),
      wantShipments ? ShipmentModel.countDocuments({ 'earnings_pause.active': true }) : Promise.resolve(0),
    ]);

    // A delivery's vendor and currency are its order's.
    const shipmentOrders = new Map<string, { vendor_id?: unknown; currency?: string }>();
    if ((shipments as any[]).length > 0) {
      const ids = [...new Set((shipments as any[]).map((s) => s.order_id?.toString()).filter(Boolean))];
      const rows = await OrderModel.find(
        { _id: { $in: ids.map((id) => new Types.ObjectId(id)) } },
        { vendor_id: 1, currency: 1 }
      ).lean();
      for (const o of rows as any[]) shipmentOrders.set(o._id.toString(), o);
    }

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
      ...(shipments as any[]).map((s) => {
        const order = shipmentOrders.get(s.order_id?.toString() ?? '');
        return {
          kind: 'shipment' as const,
          id: s._id.toString(),
          reference: s.tracking_number ?? null,
          vendorId: (order?.vendor_id as any)?.toString() ?? null,
          amount: s.delivery_fee_snapshot ?? null,
          currency: order?.currency ?? null,
          orderId: s.order_id?.toString() ?? null,
          agencyId: s.agency_id?.toString() ?? null,
          pause: s.earnings_pause as IEarningsPause,
        };
      }),
    ].sort((a, b) => (b.pause.paused_at?.getTime() ?? 0) - (a.pause.paused_at?.getTime() ?? 0));

    return {
      items: merged.slice((page - 1) * limit, page * limit),
      total: orderCount + bookingCount + shipmentCount,
    };
  }

  /** True when the order, booking or delivery exists. The admin endpoints answer 404 otherwise. */
  async targetExists(target: EarningsPauseTarget): Promise<boolean> {
    const { model } = recordOf(target);
    return (await model.countDocuments({ _id: new Types.ObjectId(target.id) }).limit(1)) > 0;
  }

  /** The pause record of an order, booking or delivery, or null when it has never been paused. */
  async currentPause(target: EarningsPauseTarget): Promise<IEarningsPause | null> {
    if (target.kind === 'order') {
      const order = await OrderModel.findById(target.id, { earnings_pause: 1 }).lean();
      return (order?.earnings_pause as IEarningsPause | undefined) ?? null;
    }
    if (target.kind === 'shipment') {
      const shipment = await ShipmentModel.findById(target.id, { earnings_pause: 1 }).lean();
      return ((shipment as any)?.earnings_pause as IEarningsPause | undefined) ?? null;
    }
    const booking = await Booking.findById(target.id, { earningsPause: 1 }).lean();
    return ((booking as any)?.earningsPause as IEarningsPause | undefined) ?? null;
  }

  /**
   * When the pause holding this allocation began, or null if none does. For the release
   * worker's double-check on rows the query let through. `cache` is per sweep.
   *
   * Two pauses can hold a courier row — its order's (unless an administrator placed it and
   * the row's terms free it) and its delivery's — and the earliest that applies wins.
   */
  async pausedAtOfSource(
    allocation: IEarningsAllocation,
    cache: Map<string, CachedPause | null>
  ): Promise<Date | null> {
    const candidates: Date[] = [];
    const target = await this.targetOf(allocation);
    if (target) {
      const pause = await this.cachedPause(target, cache);
      if (pause && orderPauseReachesRow(allocation, pause.reason)) candidates.push(pause.pausedAt);
    }
    if (shipmentPauseReachesRow(allocation)) {
      const shipmentId = await shipmentIdOf(allocation);
      if (shipmentId) {
        const pause = await this.cachedPause({ kind: 'shipment', id: shipmentId }, cache);
        if (pause) candidates.push(pause.pausedAt);
      }
    }
    if (candidates.length === 0) return null;
    return new Date(Math.min(...candidates.map((d) => d.getTime())));
  }

  private async cachedPause(
    target: EarningsPauseTarget,
    cache: Map<string, CachedPause | null>
  ): Promise<CachedPause | null> {
    const key = `${target.kind}:${target.id}`;
    if (!cache.has(key)) {
      const pause = await this.currentPause(target);
      cache.set(key, pause?.active ? { pausedAt: pause.paused_at ?? new Date(), reason: pause.reason ?? null } : null);
    }
    return cache.get(key) ?? null;
  }

  /**
   * Does a pause OTHER than `lifted` still hold this row? Only a courier row can have two: its
   * order's and its delivery's. Bookings have no deliveries.
   */
  private async otherPauseHolds(
    row: IEarningsAllocation,
    lifted: EarningsPauseTarget,
    cache: Map<string, CachedPause | null>
  ): Promise<boolean> {
    if (lifted.kind === 'booking' || !shipmentPauseReachesRow(row)) return false;
    if (lifted.kind === 'order') {
      const shipmentId = await shipmentIdOf(row);
      return !!shipmentId && !!(await this.cachedPause({ kind: 'shipment', id: shipmentId }, cache));
    }
    const orderTarget = await this.targetOf(row);
    if (!orderTarget) return false;
    const pause = await this.cachedPause(orderTarget, cache);
    return !!pause && orderPauseReachesRow(row, pause.reason);
  }

  /** The order (or booking) an allocation's money belongs to. */
  private async targetOf(allocation: IEarningsAllocation): Promise<PauseTarget | null> {
    const id = allocation.source_id.toString();
    switch (allocation.source_type) {
      case 'order':
        return { kind: 'order', id };
      case 'booking': {
        // A booking's BALANCE payment is split under its own source id (the balance
        // PaymentTransaction's, see `splitBookingBalance`) — map it back to its booking, or a
        // paused booking's balance share would be released straight through the pause.
        if (await Booking.exists({ _id: allocation.source_id })) return { kind: 'booking', id };
        const owner = await Booking.findOne({ 'settlement.balanceTransactionId': allocation.source_id }, { _id: 1 }).lean();
        return owner ? { kind: 'booking', id: (owner as any)._id.toString() } : { kind: 'booking', id };
      }
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

  /** The held rows a pause of this target may reach: a delivery's agency and rider rows only. */
  private async heldRowsOf(target: EarningsPauseTarget): Promise<IEarningsAllocation[]> {
    if (target.kind === 'shipment') {
      return this.allocationRepo.findHeldCourierBySources(await this.completion.sourcesOfShipment(target.id), false);
    }
    return this.allocationRepo.findHeldBySources(await this.sourcesOf(target));
  }

  private async sourcesOf(target: PauseTarget): Promise<SourceRef[]> {
    return target.kind === 'order' ? this.completion.sourcesOfOrder(target.id) : bookingSourcesOf(target.id);
  }

  /** Order pauses go on the order's timeline; a delivery pause on its order's, naming the parcel. */
  private async appendTimeline(
    target: EarningsPauseTarget,
    eventType: 'earnings.paused' | 'earnings.resumed',
    reason: EarningsPauseReason | null,
    metadata: Record<string, unknown>,
    actor: PauseActor,
    description?: string
  ): Promise<void> {
    if (target.kind === 'booking') return;
    let orderId = target.id;
    let text = description ?? (eventType === 'earnings.paused' ? `Earnings paused (${reason})` : 'Earnings resumed');
    if (target.kind === 'shipment') {
      const s = await ShipmentModel.findById(target.id, { order_id: 1, tracking_number: 1 }).lean();
      if (!s?.order_id) return;
      orderId = s.order_id.toString();
      const parcel = (s as any).tracking_number ?? target.id;
      text = eventType === 'earnings.paused'
        ? `Delivery earnings paused for parcel ${parcel} (${reason})`
        : `Delivery earnings resumed for parcel ${parcel}`;
      metadata = { ...metadata, shipmentId: target.id };
    }
    try {
      await this.timelineRepo.appendEvent({
        orderId,
        eventType,
        description: text,
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

/** Where a target's pause record lives. */
function recordOf(target: EarningsPauseTarget): { model: any; field: string } {
  if (target.kind === 'order') return { model: OrderModel, field: 'earnings_pause' };
  if (target.kind === 'shipment') return { model: ShipmentModel, field: 'earnings_pause' };
  return { model: Booking, field: 'earningsPause' };
}

/** Does a pause of `target`, raised for `reason`, reach this row? */
function reaches(target: EarningsPauseTarget, row: IEarningsAllocation, reason: EarningsPauseReason | null): boolean {
  if (target.kind === 'shipment') return shipmentPauseReachesRow(row);
  return orderPauseReachesRow(row, reason);
}

/**
 * The delivery an agency or rider row pays for: its snapshot names it; a row written before
 * the snapshot existed is found from its source (the shipment itself, or the COD collection's).
 */
async function shipmentIdOf(row: IEarningsAllocation): Promise<string | null> {
  if (!COURIER_BENEFICIARIES.includes(row.beneficiary_type)) return null;
  if (row.courier_hold?.shipment_id) return row.courier_hold.shipment_id;
  if (row.source_type === 'shipment') return row.source_id.toString();
  if (row.source_type === 'cod_collection') {
    const c = await CashCollectionModel.findById(row.source_id, { shipment_id: 1 }).lean();
    return c?.shipment_id ? c.shipment_id.toString() : null;
  }
  return null;
}

/**
 * Every source a booking's money hangs off: the booking itself and, once a balance was paid
 * at settlement, that balance payment (`splitBookingBalance` keys its rows by the balance
 * PaymentTransaction id so they cannot collide with the booking's). Used by the pause and by
 * the clawback (REFUND-FLOW-PLAN § 6.2: "the booking rows AND the balance-payment rows").
 */
export async function bookingSourcesOf(bookingId: string): Promise<SourceRef[]> {
  const sources: SourceRef[] = [{ sourceType: 'booking', sourceId: bookingId }];
  const booking = await Booking.findById(bookingId, { 'settlement.balanceTransactionId': 1 }).lean();
  const balanceId = (booking as any)?.settlement?.balanceTransactionId;
  if (balanceId && balanceId.toString() !== bookingId) {
    sources.push({ sourceType: 'booking', sourceId: balanceId.toString() });
  }
  return sources;
}

export const earningsPauseService = new EarningsPauseService();
