import { ClientSession, Types } from 'mongoose';
import { Booking, IBooking } from '../models/booking.model';
import { BookingStatus, CreateBookingInput, TimeWindow } from '../types/booking.types';
import { SlotLockService } from './slot-lock.service';
import { SlotGeneratorService } from './slot-generator.service';
import { ProductVariantModel } from '../../catalog/models';
import { DEFAULT_VARIANT_SIGNATURE } from '../../catalog/domain/services/variants/constants';
import { CalendarClientFactory } from '../../integrations/calendar/calendar-client.factory';
import { isCalendarNotConnected } from '../utils/calendar-error.util';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/** What a group service is: a slot several customers share, up to `maxBookings` seats. */
export interface GroupServiceCapacity {
  maxBookings: number;
}

/**
 * GroupBookingService — everything that is true of a *group* service and of nothing else.
 *
 * A group ("capacity") service is one where several customers occupy the same window: a
 * class, a tour, a workshop. Three things follow from that, and every one of them is a
 * place where the single-occupancy path is wrong:
 *
 * 1. **The checkout hold is owner-scoped** (`slot:lock:{slotId}:{userId}`), so several
 *    customers can hold the same class at once. Every `SlotLockService` call about a group
 *    slot must pass `scopeToOwner = true` or it addresses a different key entirely — the
 *    defect this service exists to stop repeating (KI-1: `rescheduleBooking` asserted the
 *    unscoped key, so moving a group booking always failed; `SlotLockService.extend` had
 *    the same bug, fixed separately, and its docstring already warned about it).
 * 2. **Occupancy is counted, not asserted.** "Is this window free" is the wrong question;
 *    the question is "are there fewer than `maxBookings` seats taken". Counting and writing
 *    must be serialised under the per-slot capacity mutex or two commits oversell the class.
 * 3. **The calendar event is SHARED.** All seats in a window point at one `[x/N]` event.
 *    So a per-booking `updateEvent` drags the whole class to a new time, and a per-booking
 *    `deleteEvent` removes the class from the vendor's calendar because one attendee left.
 *
 * The mode lives on the service variant's `serviceConfig`, so `resolveCapacity` is the one
 * place that decides whether a product is a group service; callers branch on its result
 * rather than re-deriving the rule.
 */
export class GroupBookingService {
  private slotLockService: SlotLockService;
  private slotGenerator: SlotGeneratorService;

  constructor(slotLockService?: SlotLockService, slotGenerator?: SlotGeneratorService) {
    this.slotLockService = slotLockService ?? new SlotLockService();
    this.slotGenerator = slotGenerator ?? new SlotGeneratorService();
  }

  /**
   * The group configuration for a product, or `null` when it is not a group service.
   *
   * `null` is the answer for every non-service product, for a service with no usable
   * variant, and for `calendar`/`manual` modes — all of which are single-occupancy and
   * take the exclusive lock. Mirrors `ProductBookingService.isCapacityProduct`'s rule
   * (active default variant carrying `serviceConfig`), which is what `lockSlot` uses to
   * choose the key namespace: the two must agree, or the hold is written under one key
   * and read under another. That disagreement IS KI-1.
   *
   * A `capacity` variant with no usable `maxBookings` is a misconfiguration rather than a
   * single-occupancy product — it is refused, the same way `ProductBookingService` refuses
   * to book one, instead of silently downgrading a class to one seat.
   */
  async resolveCapacity(productId: string): Promise<GroupServiceCapacity | null> {
    if (!Types.ObjectId.isValid(productId)) return null;

    const variant = await ProductVariantModel.findOne({
      productId: new Types.ObjectId(productId),
      status: 'active',
      optionSignature: DEFAULT_VARIANT_SIGNATURE,
      deletedAt: null,
    })
      .select('serviceConfig')
      .lean();

    const serviceConfig = variant?.serviceConfig;
    if (!serviceConfig || serviceConfig.bookingMode !== 'capacity') return null;

    const maxBookings = serviceConfig.maxBookings;
    if (!maxBookings || maxBookings < 1) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_CAPACITY, 422, undefined, {
        productId,
      });
    }

    return { maxBookings };
  }

  /** Whether this product's slots are shared — i.e. whether holds on them are owner-scoped. */
  async isGroupService(productId: string): Promise<boolean> {
    return (await this.resolveCapacity(productId)) !== null;
  }

  /**
   * Seats taken in one exact window, optionally ignoring one booking.
   *
   * Matched on the EXACT interval, not on overlap, because that is how the group booking
   * path defines a seat: a class's capacity is about that class, not about every class
   * that happens to touch the same minutes. Counting by overlap here would refuse a move
   * that the booking path would have accepted — the same shape of bug as KI-1, one layer up.
   *
   * `excludeBookingId` is what makes a move idempotent: a booking already sitting in the
   * target window must not be counted as a rival for the seat it already holds.
   */
  async countSeatsTaken(
    productId: string | Types.ObjectId,
    window: TimeWindow,
    excludeBookingId?: string | Types.ObjectId,
    session?: ClientSession
  ): Promise<number> {
    const filter: Record<string, unknown> = {
      productId: new Types.ObjectId(productId.toString()),
      startAt: window.start,
      endAt: window.end,
      status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      deletedAt: null,
    };
    if (excludeBookingId) {
      filter._id = { $ne: new Types.ObjectId(excludeBookingId.toString()) };
    }

    return Booking.countDocuments(filter).session(session ?? null);
  }

  /** Seats still free in a window — what a client needs to render "3 of 8 left". */
  async spotsRemaining(
    productId: string,
    window: TimeWindow,
    maxBookings: number,
    excludeBookingId?: string
  ): Promise<number> {
    const taken = await this.countSeatsTaken(productId, window, excludeBookingId);
    return Math.max(0, maxBookings - taken);
  }

  /**
   * Runs `fn` under the slot's capacity mutex, so a count-then-write cannot interleave
   * with another one for the same slot. Retries briefly rather than failing on first
   * contention: the critical section is short, and a class filling up is exactly when
   * several people commit at once.
   */
  async withSlotMutex<T>(slotId: string, fn: () => Promise<T>): Promise<T> {
    const token = await this.acquireMutexWithRetry(slotId);
    if (!token) {
      throw createAppError(ERROR_CODES.BOOKING_SLOT_FULL, 409, 'Slot is busy, please retry');
    }
    try {
      return await fn();
    } finally {
      await this.slotLockService.releaseCapacityMutex(slotId, token);
    }
  }

  /**
   * Takes a seat in a group slot, or refuses because the class is full.
   *
   * This is `BookingService.createCapacityBooking`'s body; that method is now a delegate,
   * so `ProductBookingService` and every existing caller are unchanged.
   *
   * @param holdOwnerId Owner of the per-user checkout hold, released on the way out.
   * @param bookingNumber The handle to stamp on the row. Drawn by the caller so
   *        both creation paths use one generator call site, and so the counter is
   *        incremented outside the slot mutex held below.
   */
  async createBooking(
    input: CreateBookingInput,
    maxBookings: number,
    holdOwnerId: string,
    productTitle: string,
    bookingNumber: string
  ): Promise<IBooking> {
    const {
      slotId,
      userId,
      productId,
      vendorId,
      metadata,
      priceSnapshot,
      currency,
      requiresPayment,
    } = input;

    const { start, end } = this.slotGenerator.parseSlotId(slotId);
    const needsPayment = requiresPayment !== false;

    try {
      return await this.withSlotMutex(slotId, async () => {
        const taken = await this.countSeatsTaken(productId, { start, end });
        if (taken >= maxBookings) {
          throw createAppError(
            ERROR_CODES.BOOKING_SLOT_FULL,
            409,
            `This slot is full (${maxBookings} seats)`
          );
        }

        // Attach to (or open) the slot's shared event BEFORE the row exists, so the seat
        // it is about to take is counted: `taken + 1`.
        const sharedEventId = await this.syncSlotEvent({
          vendorId,
          productId,
          productTitle,
          window: { start, end },
          maxBookings,
          seatsOverride: taken + 1,
          idempotencyKey: slotId,
        });

        return Booking.create({
          bookingNumber,
          productId,
          userId,
          vendorId,
          startAt: start,
          endAt: end,
          status: BookingStatus.CONFIRMED,
          externalCalendarEventId: sharedEventId ?? undefined,
          metadata,
          priceSnapshot,
          currency: currency || 'XAF',
          requiresPayment: needsPayment,
        });
      });
    } finally {
      // Release the per-user checkout hold (best-effort). Owner-scoped, matching lockSlot.
      await this.slotLockService.release(slotId, holdOwnerId, true);
    }
  }

  /**
   * Moves a group booking into another slot: the write half of the KI-1 fix.
   *
   * Serialised on the TARGET slot, because that is the one whose capacity can be
   * oversold. The source slot only loses a seat, which no concurrent writer is harmed by.
   *
   * `externalCalendarEventId` is CLEARED here rather than updated, and re-attached
   * afterwards by `syncCalendarForMove`. That ordering is deliberate: the id currently on
   * the row belongs to the OLD slot's shared event, and leaving it there through a
   * calendar outage would point this booking at a class it is no longer in — a later
   * cancel or reschedule would then edit the wrong event. Losing the link degrades to
   * "no calendar mirror", which is the failure mode the rest of this module already
   * accepts.
   */
  async moveIntoSlot(
    booking: IBooking,
    newSlotId: string,
    window: TimeWindow,
    maxBookings: number
  ): Promise<void> {
    await this.withSlotMutex(newSlotId, async () => {
      const taken = await this.countSeatsTaken(booking.productId, window, booking._id.toString());
      if (taken >= maxBookings) {
        throw createAppError(
          ERROR_CODES.BOOKING_SLOT_FULL,
          409,
          `This slot is full (${maxBookings} seats)`,
          { slotId: newSlotId }
        );
      }

      booking.startAt = window.start;
      booking.endAt = window.end;
      booking.externalCalendarEventId = undefined;
      await booking.save();
    });
  }

  /**
   * Re-renders BOTH shared events after a move: the class the booking left (one seat
   * lighter, or gone entirely if it was the last one) and the class it joined.
   *
   * Best-effort and post-commit, matching `createBooking` above — the booking row is the
   * authoritative record of the time, the calendar is a mirror, and a Google outage must
   * not reject a move the customer and vendor have already agreed.
   */
  async syncCalendarForMove(
    booking: IBooking,
    previousWindow: TimeWindow,
    previousEventId: string | undefined,
    maxBookings: number,
    productTitle: string,
    newSlotId: string
  ): Promise<void> {
    const vendorId = booking.vendorId.toString();
    const productId = booking.productId.toString();

    // The class it left. Reuses the id the booking carried, since the remaining seats
    // still hold it. `booking` has already moved, so it no longer counts here.
    await this.syncSlotEvent({
      vendorId,
      productId,
      productTitle,
      window: previousWindow,
      maxBookings,
      knownEventId: previousEventId,
    });

    // The class it joined. Persist the id so this booking is linked to the right event.
    const newEventId = await this.syncSlotEvent({
      vendorId,
      productId,
      productTitle,
      window: { start: booking.startAt, end: booking.endAt },
      maxBookings,
      idempotencyKey: newSlotId,
    });

    if (newEventId && booking.externalCalendarEventId !== newEventId) {
      booking.externalCalendarEventId = newEventId;
      await booking.save();
    }
  }

  /**
   * Gives up a seat: what cancelling ONE attendee of a class must do to the shared event.
   *
   * The single-occupancy path deletes the event outright, which for a group slot removes
   * the whole class from the vendor's calendar because one person dropped out. Here the
   * event is re-rendered at the new count, and deleted only when the last seat goes.
   *
   * Best-effort — a calendar failure must never block a cancellation or its refund.
   */
  async releaseSeat(booking: IBooking, maxBookings: number, productTitle: string): Promise<void> {
    await this.syncSlotEvent({
      vendorId: booking.vendorId.toString(),
      productId: booking.productId.toString(),
      productTitle,
      window: { start: booking.startAt, end: booking.endAt },
      maxBookings,
      knownEventId: booking.externalCalendarEventId,
      excludeBookingId: booking._id.toString(),
    });
  }

  /**
   * Brings one slot's shared `[x/N]` event in line with how many seats are actually taken:
   * updates it, creates it when the first seat lands, and deletes it when the last leaves.
   *
   * @returns the event id now backing that window, or `null` if there is none (no seats,
   *   no calendar connected, or the provider failed — all of which are survivable).
   */
  private async syncSlotEvent(params: {
    vendorId: string;
    productId: string;
    productTitle: string;
    window: TimeWindow;
    maxBookings: number;
    /** Event id the caller already knows about, when no seat row carries it any more. */
    knownEventId?: string;
    /** Seat count to render instead of querying — for a row that does not exist yet. */
    seatsOverride?: number;
    /** Ignore this booking when counting: it is leaving this window. */
    excludeBookingId?: string;
    /** Passed to `createEvent` so a retry cannot open a second event for one slot. */
    idempotencyKey?: string;
  }): Promise<string | null> {
    const {
      vendorId,
      productId,
      productTitle,
      window,
      maxBookings,
      knownEventId,
      seatsOverride,
      excludeBookingId,
      idempotencyKey,
    } = params;

    try {
      const seats =
        seatsOverride ?? (await this.countSeatsTaken(productId, window, excludeBookingId));

      // Whichever remaining seat carries the id is as good as any — they share one event.
      const existingEventId =
        knownEventId ??
        (
          await Booking.findOne({
            productId: new Types.ObjectId(productId),
            startAt: window.start,
            endAt: window.end,
            status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
            externalCalendarEventId: { $nin: [null, ''] },
            deletedAt: null,
            ...(excludeBookingId ? { _id: { $ne: new Types.ObjectId(excludeBookingId) } } : {}),
          })
            .select('externalCalendarEventId')
            .lean()
        )?.externalCalendarEventId;

      const calendarClient = await CalendarClientFactory.forVendor(vendorId);

      if (seats <= 0) {
        if (existingEventId) await calendarClient.deleteEvent(existingEventId);
        return null;
      }

      const title = `[${seats}/${maxBookings}] ${productTitle}`;
      const description = `Capacity booking — ${seats}/${maxBookings} seats filled`;

      if (existingEventId) {
        await calendarClient.updateEvent(existingEventId, {
          title,
          description,
          start: window.start,
          end: window.end,
        });
        return existingEventId;
      }

      const event = await calendarClient.createEvent(
        { title, description, start: window.start, end: window.end },
        idempotencyKey ? { idempotencyKey } : undefined
      );
      return event.externalId;
    } catch (error) {
      if (isCalendarNotConnected(error)) {
        console.warn(
          `[GroupBookingService] Vendor ${vendorId} has no calendar connected; group slot event not synced.`
        );
      } else {
        console.error('[GroupBookingService] Group slot calendar sync failed:', error);
      }
      return knownEventId ?? null;
    }
  }

  /** Tries to acquire the per-slot capacity mutex, retrying briefly under contention. */
  private async acquireMutexWithRetry(
    slotId: string,
    attempts = 5,
    delayMs = 100
  ): Promise<string | null> {
    for (let i = 0; i < attempts; i++) {
      const token = await this.slotLockService.acquireCapacityMutex(slotId);
      if (token) return token;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
  }
}

export const groupBookingService = new GroupBookingService();
