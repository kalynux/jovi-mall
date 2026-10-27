import { ClientSession, Types } from 'mongoose';
import { Booking, IBooking, BookingPaymentStatus, IRescheduleProposal } from '../models/booking.model';
import { CreateBookingInput, BookingStatus, CalendarDayBooking } from '../types/booking.types';
import { BookedWindow } from '../utils/availability-windows.util';
import { transactionManager } from '../../../core/database/transaction.manager';
import { isCalendarNotConnected } from '../utils/calendar-error.util';
import { bookingEventDescription } from '../utils/calendar-description.util';
import { SlotLockService, SLOT_HOLD_TTL_SECONDS } from './slot-lock.service';
import { SlotGeneratorService } from './slot-generator.service';
import { GroupBookingService } from './group-booking.service';
import { CalendarClientFactory } from '../../integrations/calendar/calendar-client.factory';
import { CalendarEventInput } from '../../integrations/calendar/interfaces/calendar-client.interface';
import { ProductModel, ProductVariantModel } from "../../catalog/models";
import { DEFAULT_VARIANT_SIGNATURE } from "../../catalog/domain/services/variants/constants";
import { UserModel } from "../../users/user.model";
import { getCalendarColorIdByStatus } from '../../integrations/calendar/utils/calendar-event-colors.util';
import { eventBus } from '../../../core/events/event-bus';
import { BookingCalendarSyncService } from './booking-calendar-sync.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { earningsCompletionService } from '../../earnings/services/earnings-completion.service';
import { earningsSplitService } from '../../earnings/services/earnings-split.service';
import { raiseRefundOwed } from '../../earnings/services/refund-owed.service';
import { bookingRefundService } from './booking-refund.service';
import { VendorRepository } from '../../vendors/vendor.repository';
import { StoreRepository } from '../../store/repositories/store.repository';
import { assertCancellationAllowed } from '../../vendors/utils/cancellation-policy.util';
import { BookingNumberGenerator } from '../utils/booking-number.generator';
import { CustomerModel } from '../../customers/customer.model';
import { formatInTimeZone } from 'date-fns-tz';
import { BOOKING_CONFIG } from '../config/booking.config';
// Types only — erased at runtime, so this adds no module cycle (the service itself is lazy-loaded).
import type { OfferedSlot, SlotSelection } from '../../catalog/domain/services/booking/ProductBookingService';
import { AppointmentSettingsPatch, calendarLocationOf, mergeAccessSetting } from '../domain/appointment';
import {
  declinedVendorProposal,
  hasLiveProposal,
  openProposalMatch,
  proposalExpiry,
  rescheduleDecision,
} from '../domain/reschedule-proposal';
import { applyStatusChange, BookingStatusActor, statusChange } from '../domain/booking-status-history';

export class BookingService {
  private slotLockService: SlotLockService;
  private slotGenerator: SlotGeneratorService;
  /**
   * Group ("capacity") services — classes, tours, workshops — differ from single-occupancy
   * bookings in three ways that cannot be expressed as an `if` inside this class: the hold
   * key is owner-scoped, occupancy is a seat count rather than a yes/no, and the calendar
   * event is shared by every seat. All of that lives in `GroupBookingService`; this class
   * asks it whether a product is a group service and hands the group-specific work over.
   */
  private groupBookingService: GroupBookingService;

  private vendorRepo: VendorRepository;
  private storeRepo: StoreRepository;

  constructor() {
    this.slotLockService = new SlotLockService();
    this.slotGenerator = new SlotGeneratorService();
    this.groupBookingService = new GroupBookingService();
    this.vendorRepo = new VendorRepository();
    this.storeRepo = new StoreRepository();
  }

  /**
   * Creates a booking after verifying slot lock.
   * @param input Booking details
   * @param lockOwnerId The ID of the entity that locked the slot
   * @returns Created booking
   */
  async createBooking(input: CreateBookingInput, lockOwnerId: string): Promise<IBooking> {
    const { slotId, userId, productId, vendorId, metadata, priceSnapshot, currency, requiresPayment, bookingMode, location, access } = input;
    // Consecutive slots booked as one appointment are each held under their own id; `slotId` is
    // then the span's id, which parses to the whole interval below.
    const heldSlotIds = input.heldSlotIds?.length ? input.heldSlotIds : [slotId];

    const product = await ProductModel.findById(productId);
    if (!product) {
      throw createAppError(ERROR_CODES.BOOKING_PRODUCT_NOT_FOUND, 404, 'Product not found');
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      throw createAppError(ERROR_CODES.BOOKING_USER_NOT_FOUND, 404, 'User not found');
    }
    // Step 1: Assert every slot is locked by the owner
    for (const held of heldSlotIds) {
      await this.slotLockService.assertLocked(held, lockOwnerId);
    }

    // Step 2: Parse slot to get start/end times
    const { start, end } = this.slotGenerator.parseSlotId(slotId);

    // Determine payment status for calendar title and color
    const needsPayment = requiresPayment !== false; // Default to true
    const paymentStatus = needsPayment ? 'unpaid' : 'paid';

    // Manual-mode bookings land as PENDING; the vendor confirms them later
    // (PATCH /bookings/:id/status → confirmed). 'calendar' confirms immediately.
    // Either way the booking row itself blocks the slot from the moment it exists —
    // it no longer depends on a calendar event being written.
    const isManual = bookingMode === 'manual';

    // The booking's handle. Drawn BEFORE the transaction on purpose — the counter
    // behind it is a single document, so incrementing it inside would make every
    // concurrent booking conflict on that one row. A booking that then fails
    // burns its number, which the format explicitly does not promise against.
    const bookingNumber = await BookingNumberGenerator.generate();

    // Step 3: Re-check occupancy and create, in ONE transaction.
    //
    // The Redis hold is the first line of defence, but it is released the moment
    // this method returns and it evaporates entirely if Redis restarts. This
    // compare-then-create closes that window: a concurrent commit for the same
    // interval loses here rather than overselling the slot.
    const booking = await transactionManager.runInTransaction(async (session) => {
      const overlapping = await this.countOverlappingBookings(productId, start, end, session);
      if (overlapping > 0) {
        throw createAppError(
          ERROR_CODES.BOOKING_SLOT_UNAVAILABLE,
          409,
          'That time was just taken. Please choose another slot.',
          { slotId }
        );
      }

      const [created] = await Booking.create(
        [
          {
            bookingNumber,
            productId,
            userId,
            vendorId,
            startAt: start,
            endAt: end,
            status: isManual ? BookingStatus.PENDING : BookingStatus.CONFIRMED,
            statusHistory: [
              statusChange(null, isManual ? BookingStatus.PENDING : BookingStatus.CONFIRMED, { role: 'customer', id: userId }),
            ],
            metadata,
            priceSnapshot,
            currency: currency || 'XAF',
            requiresPayment: needsPayment,
            location: location ?? null,
            access: access ?? null,
          },
        ],
        { session }
      );
      return created;
    });

    // Step 4: Release the slot holds — the booking row now holds the interval.
    for (const held of heldSlotIds) {
      await this.slotLockService.release(held, lockOwnerId);
    }

    // Step 5: Mirror onto the vendor's calendar. Best-effort and AFTER the commit:
    // external I/O must never sit inside a transaction, and a Google outage must
    // not lose a confirmed sale. Manual bookings get their event on confirmation.
    //
    // Safe to be best-effort only because availability now derives this product's
    // occupancy from the booking rows above, not from the calendar.
    if (!isManual) {
      const paymentPrefix = needsPayment ? '[UNPAID]' : '[FREE]';
      const eventInput: CalendarEventInput = {
        title: `${paymentPrefix} ${product.title}`,
        description: bookingEventDescription({
          email: user.login_email,
          priceSnapshot,
          currency,
          bookingNumber: booking.bookingNumber,
          bookingId: booking._id,
          metadata,
        }),
        start,
        end,
        colorId: getCalendarColorIdByStatus(paymentStatus),
        location: calendarLocationOf(location, access),
        metadata: {
          ...metadata,
          bookingUserId: userId,
          bookingProductId: productId,
        },
      };

      try {
        const calendarClient = await CalendarClientFactory.forVendor(vendorId);
        const calendarEvent = await calendarClient.createEvent(eventInput, {
          idempotencyKey: slotId, // Use slotId for idempotency
        });
        booking.externalCalendarEventId = calendarEvent.externalId;
        await booking.save();
      } catch (calendarError) {
        if (isCalendarNotConnected(calendarError)) {
          console.warn(
            `[BookingService] Booking ${booking._id} created without a calendar event — vendor ${vendorId} has no calendar connected.`
          );
        } else {
          console.error('[BookingService] Failed to create calendar event for booking:', calendarError);
        }
      }
    }

    // Step 6: Emit booking.created event
    await this.emitBookingCreatedEvent(booking, product.title);

    return booking;
  }

  /**
   * Creates a booking for a capacity-mode slot, where up to `maxBookings` seats may be
   * booked for the same time window. Unlike createBooking:
   * - Multiple bookings share ONE calendar event per slot, whose title shows `[x/N]`.
   * - There is no exclusive slot lock; capacity is enforced under a short per-slot mutex
   *   so concurrent commits can't oversell.
   * - Bookings are confirmed immediately.
   *
   * The seat-taking itself is `GroupBookingService`'s, so that the create path and the
   * reschedule path count seats, take the mutex and render the shared `[x/N]` event
   * through **one** implementation. They did not before, and the two drifting apart is
   * what produced KI-1.
   *
   * @param input Booking details
   * @param maxBookings Seats per slot (from serviceConfig.maxBookings)
   * @param holdOwnerId Owner of the per-user checkout hold to release on completion
   */
  async createCapacityBooking(
    input: CreateBookingInput,
    maxBookings: number,
    holdOwnerId: string
  ): Promise<IBooking> {
    const product = await ProductModel.findById(input.productId);
    if (!product) {
      throw createAppError(ERROR_CODES.BOOKING_PRODUCT_NOT_FOUND, 404, 'Product not found');
    }

    const user = await UserModel.findById(input.userId);
    if (!user) {
      throw createAppError(ERROR_CODES.BOOKING_USER_NOT_FOUND, 404, 'User not found');
    }

    // Drawn outside the slot mutex `GroupBookingService` takes, for the same
    // reason `createBooking` draws it outside its transaction.
    const bookingNumber = await BookingNumberGenerator.generate();

    const booking = await this.groupBookingService.createBooking(
      input,
      maxBookings,
      holdOwnerId,
      product.title,
      bookingNumber
    );

    await this.emitBookingCreatedEvent(booking, product.title);
    return booking;
  }

  /**
   * Every window a product has active (pending|confirmed) bookings in that OVERLAPS
   * [fromDate, toDate], with how many bookings occupy each.
   *
   * Matching is by **overlap**, not by `startAt` falling inside the range. An
   * exact-boundary match misses a booking that straddles the range edge — and
   * missing an occupied window means offering it for sale again.
   *
   * This is the authority on a product's own occupancy: availability subtracts the
   * windows this reports as full, rather than trusting Google Calendar to know.
   */
  async findActiveBookingWindows(
    productId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<BookedWindow[]> {
    const rows = await Booking.aggregate<{ _id: { start: Date; end: Date }; count: number }>([
      {
        $match: {
          productId: new Types.ObjectId(productId),
          status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
          deletedAt: null,
          // Half-open overlap: starts before the range ends, ends after it begins.
          startAt: { $lt: toDate },
          endAt: { $gt: fromDate },
        },
      },
      {
        $group: {
          _id: { start: '$startAt', end: '$endAt' },
          count: { $sum: 1 },
        },
      },
    ]);

    /**
     * ⚠ **An OPEN proposal of a new time holds that time too** (plan Part B). While the other side
     * decides, the booking keeps its original time AND the proposed one, so nobody else can book
     * the slot an answer is about to need. A lapsed proposal (past `expiresAt`) holds nothing —
     * the date is in the query, so no job has to clear it first.
     */
    const proposals = await Booking.aggregate<{ _id: { start: Date; end: Date }; count: number }>([
      {
        $match: {
          productId: new Types.ObjectId(productId),
          status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
          deletedAt: null,
          ...openProposalMatch(new Date()),
          'rescheduleProposal.startAt': { $lt: toDate },
          'rescheduleProposal.endAt': { $gt: fromDate },
        },
      },
      {
        $group: {
          _id: { start: '$rescheduleProposal.startAt', end: '$rescheduleProposal.endAt' },
          count: { $sum: 1 },
        },
      },
    ]);

    const merged = new Map<string, BookedWindow>();
    for (const row of [...rows, ...proposals]) {
      const start = new Date(row._id.start);
      const end = new Date(row._id.end);
      const key = `${start.getTime()}:${end.getTime()}`;
      const prev = merged.get(key);
      merged.set(key, { start, end, count: (prev?.count ?? 0) + row.count });
    }
    return [...merged.values()];
  }

  /**
   * Whether an active booking already overlaps [start, end) for this product.
   *
   * `seats` is the occupancy the window may reach before it is full — 1 for
   * single-occupancy services. Runs inside the creating transaction, so it is the
   * guard that actually prevents a double-book if the Redis hold was lost.
   */
  private async countOverlappingBookings(
    productId: string,
    start: Date,
    end: Date,
    session?: ClientSession,
    excludeBookingId?: string
  ): Promise<number> {
    return Booking.countDocuments({
      productId: new Types.ObjectId(productId),
      status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      deletedAt: null,
      ...(excludeBookingId ? { _id: { $ne: new Types.ObjectId(excludeBookingId) } } : {}),
      // Its own time, OR an open proposal of a new time — see `findActiveBookingWindows`.
      $or: [
        { startAt: { $lt: end }, endAt: { $gt: start } },
        {
          ...openProposalMatch(new Date()),
          'rescheduleProposal.startAt': { $lt: end },
          'rescheduleProposal.endAt': { $gt: start },
        },
      ],
    }).session(session ?? null);
  }

  /**
   * Detaches a cancelled booking from its calendar event.
   *
   * Single occupancy: the event IS this booking, so it goes.
   *
   * ⚠ A group service's event is **shared by every seat in that class**. Deleting it
   * because one attendee dropped out takes the whole class off the vendor's calendar —
   * which is what all three cancellation paths did, since each simply called
   * `deleteEvent` on `externalCalendarEventId`. The group service re-renders it at the
   * new `[x/N]` count instead, and deletes it only when the last seat goes.
   *
   * Best-effort throughout: a calendar failure must never block a cancellation or its
   * refund.
   */
  private async detachFromCalendarOnCancel(booking: IBooking): Promise<void> {
    try {
      const group = await this.groupBookingService.resolveCapacity(booking.productId.toString());

      if (group) {
        const product = await ProductModel.findById(booking.productId);
        await this.groupBookingService.releaseSeat(
          booking,
          group.maxBookings,
          product?.title ?? 'Booking'
        );
        return;
      }

      if (!booking.externalCalendarEventId) return;

      const calendarClient = await CalendarClientFactory.forVendor(booking.vendorId.toString());
      await calendarClient.deleteEvent(booking.externalCalendarEventId);
    } catch (error) {
      console.error('[BookingService] Failed to detach calendar event on cancel:', error);
    }
  }

  /**
   * Cancels a booking and removes it from the calendar.
   * @param bookingId Booking to cancel
   * @param userId User requesting cancellation
   * @param reason Optional cancellation reason
   */
  async cancelBooking(
    bookingId: string,
    userId: string,
    reason?: string
  ): Promise<IBooking> {
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }

    // Verify ownership
    if (booking.userId.toString() !== userId) {
      throw createAppError(ERROR_CODES.BOOKING_UNAUTHORIZED, 403, 'Unauthorized to cancel this booking');
    }

    if (booking.status === BookingStatus.CANCELLED) {
      throw createAppError(ERROR_CODES.BOOKING_ALREADY_CANCELLED, 409, 'Booking is already cancelled');
    }

    // A finished appointment is not cancellable — the service was delivered, or the
    // customer did not turn up. Only the vendor can adjust those, and only via a
    // refund. Without this guard the state machine's terminal states were bypassed
    // entirely on the customer path, which set `cancelled` on a `completed` booking.
    if (
      booking.status === BookingStatus.COMPLETED ||
      booking.status === BookingStatus.NO_SHOW
    ) {
      throw createAppError(
        ERROR_CODES.BOOKING_NOT_CANCELLABLE,
        409,
        `Cannot cancel a booking that is already '${booking.status}'`
      );
    }

    /**
     * Enforce the vendor's cancellation policy (customer-initiated cancellation) — EXCEPT after
     * the customer declined the VENDOR's proposal of a new time (D-9). The vendor started that
     * change, so the customer may walk away with a full refund whatever the policy says.
     */
    const vendorDeclined = declinedVendorProposal(booking.rescheduleProposal);
    if (!vendorDeclined) {
      const vendor = await this.vendorRepo.findById(booking.vendorId.toString());
      assertCancellationAllowed(vendor?.policies?.cancellation_policy ?? null, {
        createdAt: booking.createdAt,
        serviceOrDeliveryAt: booking.startAt,
        isPending: booking.status === BookingStatus.PENDING,
      });
    }

    // Take it off the calendar — or, for a group service, take one seat off the class.
    await this.detachFromCalendarOnCancel(booking);

    // Update booking status
    applyStatusChange(booking, BookingStatus.CANCELLED, { role: 'customer', id: userId }, reason);
    booking.cancelledAt = new Date();
    booking.cancelledReason = reason;
    await booking.save();

    // Return the money. Post-commit and best-effort: the slot is already released,
    // and a refund that cannot be issued electronically becomes `refund_pending`
    // plus a support ticket rather than blocking the cancellation.
    //
    // Runs BEFORE the event so the notification reports the real payment outcome.
    // A full refund after a declined vendor proposal: the VENDOR bears the fees (D-9).
    await this.refundIfPaid(booking, userId, 'customer', reason, vendorDeclined ? 'vendor' : undefined);

    // Emit booking.cancelled event
    await this.emitBookingCancelledEvent(booking, 'customer');

    return booking;
  }

  /**
   * Refunds a just-cancelled booking, if any money was taken.
   *
   * Both cancellation paths call this. Previously NEITHER refunded anything: a
   * customer cancelling inside the vendor's own cancellation window, and a vendor
   * cancelling on a customer, both simply kept the money.
   */
  private async refundIfPaid(
    booking: IBooking,
    initiatedBy: string,
    initiatedByRole: 'customer' | 'vendor' | 'admin',
    reason?: string,
    feesPaidBy?: 'customer' | 'vendor'
  ): Promise<void> {
    try {
      const outcome = await bookingRefundService.refundCancelledBooking(
        booking,
        initiatedBy,
        initiatedByRole,
        reason,
        feesPaidBy
      );
      if (outcome.status !== 'not_applicable') {
        console.log(
          `[BookingService] Booking ${booking._id} cancellation refund → ${outcome.status}`
        );
      }
    } catch (error) {
      console.error('[BookingService] Refund on cancellation failed:', error);
    }
  }

  /**
   * Reschedules a booking to a new slot.
   *
   * Ownership is scoped in the QUERY via `actor`, so the vendor and the customer
   * reach the same code path and neither can move the other's booking. A miss is a
   * 404 rather than a 403 — the same rule the shipment endpoints follow.
   *
   * @param bookingId Existing booking ID
   * @param newSlotId New slot ID — or, for a CUSTOMER, a run of consecutive slot ids, each held,
   *   covering an interval of the appointment's own length (2026-10-26)
   * @param lockOwnerId Owner of the hold on the new slot: the signed-in USER's id, because that is
   *   the only id a hold is ever written under. ⚠ For a shop this is NOT `actor.id` — see
   *   `VendorBookingController.rescheduleBooking`.
   * @param actor Which side is asking, and their id (for a shop, the VENDOR id the booking holds)
   */
  async rescheduleBooking(
    bookingId: string,
    newSlotId: SlotSelection,
    lockOwnerId: string,
    actor?: { role: 'vendor' | 'customer'; id: string }
  ): Promise<IBooking> {
    const scope: Record<string, unknown> = { _id: bookingId, deletedAt: null };
    if (actor?.role === 'vendor') scope.vendorId = new Types.ObjectId(actor.id);
    if (actor?.role === 'customer') scope.userId = new Types.ObjectId(actor.id);

    const booking = await Booking.findOne(scope);
    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }

    // Only a live booking can move. `cancelled`, `completed` and `no-show` are all
    // terminal — previously only `cancelled` was checked here, so a completed
    // appointment could be silently dragged to a new time.
    const reschedulable: BookingStatus[] = [BookingStatus.PENDING, BookingStatus.CONFIRMED];
    if (!reschedulable.includes(booking.status)) {
      throw createAppError(
        ERROR_CODES.BOOKING_NOT_RESCHEDULABLE,
        409,
        `Cannot reschedule a booking with status '${booking.status}'. Only pending or confirmed bookings can be rescheduled.`
      );
    }

    // A new time already waiting for an answer: that question is settled first (accept, decline,
    // or withdraw it) — two open proposals on one booking would leave nobody sure which one an
    // answer was about.
    if (hasLiveProposal(booking.rescheduleProposal)) {
      throw createAppError(ERROR_CODES.BOOKING_PROPOSAL_PENDING, 409, undefined, {
        proposedBy: booking.rescheduleProposal!.proposedBy,
      });
    }

    // Step 0: the new time must be one THIS side may move to, before any hold is asserted or
    // any occupancy counted. See `assertRescheduleTarget` for the two rules and why they differ.
    const target = await this.assertRescheduleTarget(booking, newSlotId, actor);
    const { start, end } = target;

    // Step 1: Is this a group service? Everything below branches on the answer, and the
    // FIRST thing it decides is which Redis key the hold lives under.
    //
    // ⚠ THIS IS KI-1. A group service's checkout hold is owner-scoped
    // (`slot:lock:{slotId}:{userId}`) so several customers can hold one class at once —
    // but this method asserted the UNSCOPED key, defaulting `scopeToOwner` to false. It
    // read a key `lockSlot` had never written, found nothing, and refused every move of
    // every group booking with BOOKING_SLOT_NOT_LOCKED — on the storefront and in chat
    // alike, even when the target slot was wide open. `SlotLockService.extend` carried the
    // same bug and its docstring still warns about it.
    const group = await this.groupBookingService.resolveCapacity(booking.productId.toString());
    const scopeToOwner = group !== null;

    // A class is joined one session at a time — the same refusal a new group booking gets.
    if (group && target.heldSlotIds.length > 1) {
      throw createAppError(ERROR_CODES.BOOKING_MULTI_SLOT_NOT_SUPPORTED, 422, undefined, {
        slotCount: target.heldSlotIds.length,
      });
    }

    for (const held of target.heldSlotIds) {
      await this.slotLockService.assertLocked(held, lockOwnerId, scopeToOwner);
    }

    // Step 2: the new interval is the one Step 0 validated — never re-parsed from the raw id.

    /**
     * Step 3: does this move APPLY, or does it wait for the other side? (D-8, D-9)
     * A vendor's move always waits for the customer. A customer's move waits for the vendor only
     * on a `manual` service — the vendor chose to approve each booking by hand. An absent actor
     * gets the customer rule, the same default `assertRescheduleTarget` gives it.
     */
    const role = actor?.role ?? 'customer';
    // A shop's move proposes whatever the mode, so the mode is read only for a customer's.
    const mode = role === 'vendor' || group ? 'capacity' : await this.resolveBookingMode(booking.productId.toString());

    if (rescheduleDecision(role, mode) === 'propose') {
      await this.assertTargetFree(booking, target.slotId, { start, end }, group);
      const now = new Date();
      booking.rescheduleProposal = {
        status: 'open',
        proposedBy: role,
        // The whole interval's id — a span parses back to it when the proposal is accepted.
        slotId: target.slotId,
        startAt: start,
        endAt: end,
        previousStartAt: booking.startAt,
        previousEndAt: booking.endAt,
        proposedAt: now,
        expiresAt: proposalExpiry(booking.startAt, start),
        answeredAt: null,
      };
      await booking.save();
      // The proposal itself now holds the interval (`openProposalMatch`), so the short holds go.
      for (const held of target.heldSlotIds) {
        await this.slotLockService.release(held, lockOwnerId, scopeToOwner);
      }
      await this.emitRescheduleProposedEvent(booking);
      return booking;
    }

    // A move applied directly is the latest word on the time — an earlier answered proposal
    // (a decline in particular, which waives the cancellation policy) no longer describes it.
    booking.rescheduleProposal = null;
    const previousStartAt = booking.startAt;
    await this.applyMove(booking, target.slotId, { start, end }, group);

    // Step 6: Release slot locks — under the same key namespace they were asserted with.
    for (const held of target.heldSlotIds) {
      await this.slotLockService.release(held, lockOwnerId, scopeToOwner);
    }

    // Step 7: Tell the customer, with BOTH times — a message carrying only the
    // new one is indistinguishable from a duplicate of the original booking. `movedBy` lets the
    // vendor's handler tell them when it was the customer who moved it.
    await this.emitBookingRescheduledEvent(booking, previousStartAt, role);

    return booking;
  }

  /**
   * Answer the open proposal of a new time on a booking (D-8, D-9). Only the OTHER side may
   * answer; the proposer withdraws instead (`withdrawRescheduleProposal`).
   *
   * - **accept** → the booking moves to the proposed time, through the same move as a direct
   *   reschedule (occupancy re-checked, calendar mirrored), and both sides are told.
   * - **decline** → the original time stands. A customer who declines a VENDOR's proposal may then
   *   cancel with a full refund whatever the cancellation policy says (`declinedVendorProposal`).
   *
   * A proposal past `expiresAt` has lapsed: it is recorded as such here and refused with
   * `BOOKING_PROPOSAL_NOT_FOUND` — the original time stood, as D-9 says.
   */
  async answerRescheduleProposal(
    bookingId: string,
    actor: { role: 'vendor' | 'customer'; id: string },
    answer: 'accept' | 'decline'
  ): Promise<IBooking> {
    const booking = await this.findScopedBooking(bookingId, actor);
    const proposal = await this.liveProposalOrThrow(booking);

    if (proposal.proposedBy === actor.role) {
      throw createAppError(ERROR_CODES.BOOKING_PROPOSAL_NOT_YOURS, 403, undefined, {
        proposedBy: proposal.proposedBy,
      });
    }

    const now = new Date();
    if (answer === 'decline') {
      booking.rescheduleProposal = { ...proposal, status: 'declined', answeredAt: now };
      await booking.save();
      await this.emitRescheduleAnsweredEvent(booking, 'declined');
      return booking;
    }

    const group = await this.groupBookingService.resolveCapacity(booking.productId.toString());
    const previousStartAt = booking.startAt;
    // Written by the move's own save, so the time and the answer land together.
    booking.rescheduleProposal = { ...proposal, status: 'accepted', answeredAt: now };
    await this.applyMove(booking, proposal.slotId, { start: proposal.startAt, end: proposal.endAt }, group);

    await this.emitBookingRescheduledEvent(booking, previousStartAt, 'agreed');
    await this.emitRescheduleAnsweredEvent(booking, 'accepted');
    return booking;
  }

  /** The proposer takes their proposal back. The original time stands; the other side is not asked. */
  async withdrawRescheduleProposal(
    bookingId: string,
    actor: { role: 'vendor' | 'customer'; id: string }
  ): Promise<IBooking> {
    const booking = await this.findScopedBooking(bookingId, actor);
    const proposal = await this.liveProposalOrThrow(booking);
    if (proposal.proposedBy !== actor.role) {
      throw createAppError(ERROR_CODES.BOOKING_PROPOSAL_NOT_YOURS, 403, undefined, {
        proposedBy: proposal.proposedBy,
      });
    }
    booking.rescheduleProposal = { ...proposal, status: 'withdrawn', answeredAt: new Date() };
    await booking.save();
    return booking;
  }

  /** A booking scoped to the side asking, 404 otherwise — the rule `rescheduleBooking` follows. */
  private async findScopedBooking(
    bookingId: string,
    actor: { role: 'vendor' | 'customer'; id: string }
  ): Promise<IBooking> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }
    const scope: Record<string, unknown> = { _id: bookingId, deletedAt: null };
    if (actor.role === 'vendor') scope.vendorId = new Types.ObjectId(actor.id);
    else scope.userId = new Types.ObjectId(actor.id);
    const booking = await Booking.findOne(scope);
    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }
    return booking;
  }

  /**
   * The booking's proposal if it is open and unexpired. An open-but-expired one is written down
   * as `lapsed` on the way past — the lazy half of "no job runs".
   */
  private async liveProposalOrThrow(booking: IBooking): Promise<IRescheduleProposal> {
    const stored = booking.rescheduleProposal ? plainProposal(booking.rescheduleProposal) : null;
    if (stored && stored.status === 'open' && !hasLiveProposal(stored)) {
      booking.rescheduleProposal = { ...stored, status: 'lapsed' };
      await booking.save();
    }
    const live: BookingStatus[] = [BookingStatus.PENDING, BookingStatus.CONFIRMED];
    if (!stored || !hasLiveProposal(stored) || !live.includes(booking.status)) {
      throw createAppError(ERROR_CODES.BOOKING_PROPOSAL_NOT_FOUND, 404, undefined, {
        status: booking.rescheduleProposal?.status ?? null,
      });
    }
    return stored;
  }

  /** The service's booking mode — `calendar` when it cannot be read, which is the confirm-at-once default. */
  private async resolveBookingMode(productId: string): Promise<string> {
    const variant = await ProductVariantModel.findOne({
      productId: new Types.ObjectId(productId),
      status: 'active',
      optionSignature: DEFAULT_VARIANT_SIGNATURE,
      deletedAt: null,
    }).select('serviceConfig.bookingMode').lean();
    return variant?.serviceConfig?.bookingMode ?? 'calendar';
  }

  /** The target is free for this booking — the occupancy half of a move, without moving. */
  private async assertTargetFree(
    booking: IBooking,
    slotId: string,
    window: { start: Date; end: Date },
    group: { maxBookings: number } | null
  ): Promise<void> {
    if (group) {
      const taken = await this.groupBookingService.countSeatsTaken(booking.productId, window, booking._id.toString());
      if (taken >= group.maxBookings) {
        throw createAppError(ERROR_CODES.BOOKING_SLOT_FULL, 409, `This slot is full (${group.maxBookings} seats)`, { slotId });
      }
      return;
    }
    const overlapping = await this.countOverlappingBookings(
      booking.productId.toString(), window.start, window.end, undefined, booking._id.toString()
    );
    if (overlapping > 0) {
      throw createAppError(ERROR_CODES.BOOKING_SLOT_UNAVAILABLE, 409, 'That time is no longer free. Please choose another slot.', { slotId });
    }
  }

  /**
   * Move a booking to `window`: occupancy re-checked, the row written, the calendar mirrored.
   * Shared by a direct reschedule and an accepted proposal, so the two cannot drift.
   * The caller has validated the target and holds whatever hold applies.
   */
  private async applyMove(
    booking: IBooking,
    slotId: string,
    window: { start: Date; end: Date },
    group: { maxBookings: number } | null
  ): Promise<void> {
    const { start, end } = window;
    const previousStartAt = booking.startAt;
    const previousEndAt = booking.endAt;
    const previousEventId = booking.externalCalendarEventId;

    // Steps 3+4: check occupancy and move. Both are mode-specific, and inseparable —
    // a group move counts seats and writes under the target slot's capacity mutex, so
    // that a concurrent booking cannot slip into the last seat between the two.
    if (group) {
      await this.groupBookingService.moveIntoSlot(
        booking,
        slotId,
        { start, end },
        group.maxBookings
      );
    } else {
      // Single occupancy: the target must actually be free. The hold guards concurrent
      // movers; this guards against moving onto an interval that is already sold.
      // This booking is excluded outright — its own time and its own proposal hold are not
      // competitors for the move. (It used to be counted and then subtracted when it overlapped.)
      const overlapping = await this.countOverlappingBookings(
        booking.productId.toString(),
        start,
        end,
        undefined,
        booking._id.toString()
      );
      if (overlapping > 0) {
        throw createAppError(
          ERROR_CODES.BOOKING_SLOT_UNAVAILABLE,
          409,
          'That time is no longer free. Please choose another slot.',
          { slotId: slotId }
        );
      }

      // Move the booking. This is the authoritative record of the new time, so it is
      // written FIRST — a calendar outage must not be able to reject a reschedule the
      // customer and vendor have already agreed.
      booking.startAt = start;
      booking.endAt = end;
      await booking.save();
    }

    // Step 5: Mirror onto the calendar, best-effort.
    //
    // Previously this ran before the save and threw BOOKING_CALENDAR_SYNC_FAILED,
    // so a Google hiccup left the booking at its OLD time while the customer had
    // been told it moved. It also resolved a calendar client unconditionally, which
    // failed outright for a vendor who has none — even with no event to update.
    if (group) {
      // ⚠ A group booking's event is SHARED with the rest of its class, so the
      // single-occupancy `updateEvent` below would drag every other attendee to the new
      // time. Two events are re-rendered instead: the class left (one seat lighter) and
      // the class joined.
      const product = await ProductModel.findById(booking.productId);
      await this.groupBookingService.syncCalendarForMove(
        booking,
        { start: previousStartAt, end: previousEndAt },
        previousEventId,
        group.maxBookings,
        product?.title ?? 'Booking',
        slotId
      );
    } else if (booking.externalCalendarEventId) {
      try {
        // Rebuild the event title/description to match createBooking's formatting,
        // so a reschedule doesn't degrade '[UNPAID] Haircut' into raw ObjectIds.
        const [product, user] = await Promise.all([
          ProductModel.findById(booking.productId),
          UserModel.findById(booking.userId),
        ]);
        const paymentPrefix = booking.requiresPayment ? '[UNPAID]' : '[FREE]';
        const title = product
          ? `${paymentPrefix} ${product.title}`
          : `${paymentPrefix} Booking`;

        const calendarClient = await CalendarClientFactory.forVendor(
          booking.vendorId.toString()
        );
        await calendarClient.updateEvent(booking.externalCalendarEventId, {
          title,
          description: bookingEventDescription({
            lead: 'Rescheduled booking by',
            email: user?.login_email,
            priceSnapshot: booking.priceSnapshot,
            currency: booking.currency,
            bookingNumber: booking.bookingNumber,
            bookingId: booking._id,
            metadata: booking.metadata,
          }),
          start,
          end,
          colorId: getCalendarColorIdByStatus(booking.paymentStatus), // Preserve payment status color
          location: calendarLocationOf(booking.location, booking.access),
          metadata: booking.metadata as Record<string, string>,
        });
      } catch (error) {
        console.error('[BookingService] Failed to update calendar event on reschedule:', error);
      }
    }

  }

  /**
   * Where a booking may be moved to, by who is moving it.
   *
   * ── A CUSTOMER moves only to a time the service really offers ────────────────
   * The same check a new booking passes (`ProductBookingService.assertOfferedSlot`): inside the
   * shop's published hours, free, the length the service is sold in, and in the future. Until
   * 2026-09-16 this method checked the slot id's FORMAT only, so a customer could move an
   * appointment onto 3am, onto a closed day, or onto an eight-hour interval that blocked the
   * shop's whole day.
   *
   * ⚠ **Validated with the booking being moved still counted as busy, deliberately.** That is
   * exactly the availability the customer was shown when they picked the new time — the
   * storefront and the chat both read it with this booking in place — so every time a customer
   * could have been offered passes, and nothing they could not have been offered does. Excluding
   * the booking would have re-anchored the grid around the gap it leaves and validated a
   * different set of slots from the one on their screen.
   *
   * ── A SHOP may move outside its published hours, at the SAME LENGTH ─────────
   * Owner's decision, 2026-09-16: it is the shop's own calendar and its call — a regular who can
   * only come at 7pm, a closure moved at short notice. What a shop may NOT do is change the
   * length: the price was fixed on the original interval, and a longer one is also how a single
   * booking blocks a whole day. Overlap is refused below by the same checks every move passes.
   * The rule itself is `assertShopRuleSlot`, shared with the hold that precedes the move.
   *
   * ⚠ **An absent `actor` gets the CUSTOMER rule.** Every caller passes one today; a future caller
   * that forgets must not inherit the looser rule by omission.
   *
   * ⚠ **The product booking service is imported lazily**, because it imports THIS class: a static
   * import here is a module cycle, and a cycle resolved at load time hands one of the two modules
   * an `undefined`. Resolved at call time, both are loaded. `test:booking-slot-offer` pins that
   * the customer branch really calls the check, so this indirection cannot quietly become a no-op.
   *
   * ── A CUSTOMER keeps the appointment's LENGTH too (2026-10-26) ──────────────
   * Once a booking could span several consecutive slots, "a time the service offers" stopped
   * implying "the same length": one offered slot is shorter than a two-slot appointment, and moving
   * onto it silently halved what the customer had paid for. So the customer names a run of the
   * same length (`newSlotId` as a list), and a different length is refused as the shop's is —
   * `BOOKING_INVALID_SLOT_ID` 400 `length_changed`.
   */
  private async assertRescheduleTarget(
    booking: IBooking,
    newSlotId: SlotSelection,
    actor?: { role: 'vendor' | 'customer'; id: string }
  ): Promise<OfferedSlot> {
    if (actor?.role === 'vendor') {
      return this.assertShopRuleSlot(booking, newSlotId);
    }

    const { productBookingService } = await import(
      '../../catalog/domain/services/booking/product-booking.instance'
    );
    const offered = await productBookingService.assertOfferedSlot(booking.productId.toString(), newSlotId);
    const length = offered.end.getTime() - offered.start.getTime();
    if (length !== booking.endAt.getTime() - booking.startAt.getTime()) {
      throw createAppError(
        ERROR_CODES.BOOKING_INVALID_SLOT_ID,
        400,
        'Choose a new time of the same length as the appointment.',
        { slotId: offered.slotId, reason: 'length_changed' }
      );
    }
    return offered;
  }

  /**
   * The SHOP's rule for a time it may move one of its own appointments to.
   *
   * Three things, and no availability read: the interval is real, it keeps the appointment's
   * length, and it has not already happened. Published opening hours are deliberately not
   * consulted — that is the whole point of the shop rule (see `assertRescheduleTarget`).
   *
   * ⚠ **`not_future` was missing until 2026-09-20, and it is not a tidy-up.** Without it a shop
   * could move an appointment into last week — quietly rewriting history for a customer who has
   * already been, and moving a booking behind the sweeps and reminders that only ever look
   * forward. The customer rule never had this hole, because `assertOfferedSlot` refuses a past
   * slot outright.
   *
   * ⚠ **Shared with the hold, on purpose.** `holdSlotForReschedule` calls this same method, so a
   * hold can never be granted for a time the move would then refuse. Two copies of a rule split
   * across two endpoints is how a dashboard ends up holding a slot it cannot use.
   *
   * ── A RUN OF CONSECUTIVE SLOTS (2026-10-27) ─────────────────────────────────
   * An appointment booked over several slots is longer than any one slot `GET /availability`
   * lists, so a shop picking from that grid had no single id of the right length and every move
   * of such a booking failed `length_changed`. The shop now names the run, exactly as a customer
   * does: each id is parsed, the run must be contiguous (`not_contiguous`, the customer's
   * refusal), and the rule above is applied to the whole interval. `heldSlotIds` are the ids as
   * named — what each hold is written under — and `slotId` is the span's id.
   */
  private assertShopRuleSlot(
    booking: IBooking,
    selection: SlotSelection,
    now: Date = new Date()
  ): OfferedSlot {
    const heldSlotIds = typeof selection === 'string' ? [selection] : [...selection];
    const named = heldSlotIds.length === 1 ? { slotId: heldSlotIds[0] } : { slotIds: heldSlotIds };

    const refuse = (
      reason: 'slot_count' | 'inverted' | 'not_contiguous' | 'length_changed' | 'not_future',
      message: string
    ): never => {
      throw createAppError(ERROR_CODES.BOOKING_INVALID_SLOT_ID, 400, message, { ...named, reason });
    };

    if (heldSlotIds.length === 0 || heldSlotIds.length > BOOKING_CONFIG.maxSlotsPerBooking) {
      refuse('slot_count', `Choose between 1 and ${BOOKING_CONFIG.maxSlotsPerBooking} consecutive slots.`);
    }

    const parts = heldSlotIds.map((id) => this.slotGenerator.parseSlotId(id));
    const start = parts[0].start;
    const end = parts[parts.length - 1].end;
    const current = booking.endAt.getTime() - booking.startAt.getTime();

    if (parts.some((p) => p.end.getTime() <= p.start.getTime())) {
      refuse('inverted', 'A rescheduled appointment must keep its original length.');
    }
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].start.getTime() !== parts[i - 1].end.getTime()) {
        refuse('not_contiguous', 'The slots of one appointment must follow each other with no gap.');
      }
    }
    if (end.getTime() - start.getTime() !== current) {
      refuse('length_changed', 'A rescheduled appointment must keep its original length.');
    }
    if (start.getTime() <= now.getTime()) {
      refuse('not_future', 'An appointment cannot be moved to a time that has already passed.');
    }

    return {
      start,
      end,
      slotId: heldSlotIds.length === 1 ? heldSlotIds[0] : this.slotGenerator.spanId(start, end),
      heldSlotIds,
    };
  }

  /**
   * Hold a time for a shop that is about to move one of its own appointments onto it.
   *
   * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
   * A move needs a hold, and the only route that takes one — the storefront's slot lock — runs
   * `assertOfferedSlot`, which refuses anything outside the shop's published hours. So the shop
   * rule granted a freedom the shop had no way to exercise: every out-of-hours move failed at the
   * hold, one step before the rule that allows it. This is that door, and it enforces the SAME
   * rule the move applies a moment later.
   *
   * ⚠ **Scoped by the booking, not by the product.** The rule is "the length of THIS appointment",
   * and scoping the lookup by `actor` makes another shop's booking a 404 rather than a 403 —
   * the same answer `rescheduleBooking` gives, for the same reason.
   *
   * ⚠ **The hold is written under the signed-in USER's id**, exactly as every other hold on this
   * platform is, and owner-scoped for a group service exactly as the move will assert it. Passing
   * the vendor entity's id here is the defect of 2026-02-23 all over again — see
   * `VendorBookingController.rescheduleBooking`.
   *
   * ⚠ **Seats are NOT checked for a group service.** Capacity is enforced when the move happens,
   * under the target slot's mutex; checking it here as well would be a second opinion that can
   * disagree, and a hold is not a seat.
   *
   * ⚠ **A run is held slot by slot (2026-10-27)**, each under its own id, so the move asserts
   * exactly the keys written here — and the storefront, whose holds are per slot, sees each one.
   * If any slot of the run is already held by someone else, the ones taken so far are released:
   * half a run held is a time nobody can use.
   */
  async holdSlotForReschedule(
    bookingId: string,
    newSlotId: SlotSelection,
    holdOwnerId: string,
    actor: { role: 'vendor'; id: string }
  ): Promise<{ slotId: string; slotIds: string[]; start: Date; end: Date; expiresAt: Date }> {
    const booking = await Booking.findOne({
      _id: bookingId,
      vendorId: new Types.ObjectId(actor.id),
      deletedAt: null,
    });
    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }

    const reschedulable: BookingStatus[] = [BookingStatus.PENDING, BookingStatus.CONFIRMED];
    if (!reschedulable.includes(booking.status)) {
      throw createAppError(
        ERROR_CODES.BOOKING_NOT_RESCHEDULABLE,
        409,
        `Cannot reschedule a booking with status '${booking.status}'. Only pending or confirmed bookings can be rescheduled.`
      );
    }

    const target = this.assertShopRuleSlot(booking, newSlotId);
    const { start, end } = target;

    const group = await this.groupBookingService.resolveCapacity(booking.productId.toString());
    const scopeToOwner = group !== null;

    // A class is joined one session at a time — refused here as the move will refuse it.
    if (group && target.heldSlotIds.length > 1) {
      throw createAppError(ERROR_CODES.BOOKING_MULTI_SLOT_NOT_SUPPORTED, 422, undefined, {
        slotCount: target.heldSlotIds.length,
      });
    }

    // Single occupancy only: the target must not already be sold. The booking being moved is
    // still counted, so moving an appointment a little earlier — overlapping itself — is allowed,
    // exactly as `rescheduleBooking` allows it.
    if (!group) {
      const overlapping = await this.countOverlappingBookings(
        booking.productId.toString(),
        start,
        end
      );
      const selfOverlaps =
        booking.startAt.getTime() < end.getTime() && booking.endAt.getTime() > start.getTime();
      if (overlapping > (selfOverlaps ? 1 : 0)) {
        throw createAppError(
          ERROR_CODES.BOOKING_SLOT_UNAVAILABLE,
          409,
          'That time is no longer free. Please choose another slot.',
          { slotId: target.slotId }
        );
      }
    }

    const taken: string[] = [];
    for (const slotId of target.heldSlotIds) {
      const held = await this.slotLockService.lock(
        slotId,
        holdOwnerId,
        SLOT_HOLD_TTL_SECONDS,
        scopeToOwner
      );
      if (!held) {
        for (const done of taken) {
          await this.slotLockService.release(done, holdOwnerId, scopeToOwner);
        }
        throw createAppError(
          ERROR_CODES.BOOKING_SLOT_LOCKED,
          409,
          'This slot is already locked by another user',
          { slotId }
        );
      }
      taken.push(slotId);
    }

    return {
      slotId: target.slotId,
      slotIds: target.heldSlotIds,
      start,
      end,
      expiresAt: new Date(Date.now() + SLOT_HOLD_TTL_SECONDS * 1000),
    };
  }

  /**
   * A customer's own bookings, filtered and paged.
   *
   * Paging is not optional politeness: a long-standing customer's booking history
   * is unbounded, and the previous unpaged version returned every row at once.
   * The `{ data, meta }` envelope matches every other list endpoint on the platform.
   */
  async getUserBookings(
    userId: string,
    filters: {
      status?: BookingStatus;
      paymentStatus?: BookingPaymentStatus;
      startDate?: Date;
      endDate?: Date;
      page?: number;
      limit?: number;
    } = {}
  ): Promise<{ data: IBooking[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20));

    const query: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
      deletedAt: null,
    };
    if (filters.status) query.status = filters.status;
    if (filters.paymentStatus) query.paymentStatus = filters.paymentStatus;
    if (filters.startDate || filters.endDate) {
      const range: Record<string, Date> = {};
      if (filters.startDate) range.$gte = filters.startDate;
      if (filters.endDate) range.$lte = filters.endDate;
      query.startAt = range;
    }

    const [total, data] = await Promise.all([
      Booking.countDocuments(query),
      Booking.find(query)
        .sort({ startAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('productId', 'title type')
        // The vendor's *business* name lives on their Store, not the profile —
        // `display_name` is what the profile legitimately carries.
        .populate('vendorId', 'display_name'),
    ]);

    return { data, total, page, limit };
  }

  /**
   * A single booking belonging to this customer.
   *
   * Scoped by `userId` in the query rather than fetched-then-compared, so another
   * customer's id is a 404 and never a 403 — a 403 would confirm the booking
   * exists, which is itself a disclosure.
   */
  async getUserBooking(bookingId: string, userId: string): Promise<IBooking> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }

    const booking = await Booking.findOne({
      _id: bookingId,
      userId: new Types.ObjectId(userId),
      deletedAt: null,
    })
      .populate('productId', 'title type')
      .populate('vendorId', 'display_name');

    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }
    return booking;
  }

  /**
   * Gets bookings for a vendor.
   */
  async getVendorBookings(vendorId: string, fromDate?: Date, toDate?: Date): Promise<IBooking[]> {
    const query: any = { vendorId };
    if (fromDate || toDate) {
      query.startAt = {};
      if (fromDate) query.startAt.$gte = fromDate;
      if (toDate) query.startAt.$lte = toDate;
    }
    return Booking.find(query).sort({ startAt: 1 });
  }

  /**
   * Updates booking status with calendar synchronization.
   * Handles state transitions and calendar event creation/deletion.
   * 
   * @param bookingId Booking ID to update
   * @param vendorId Vendor ID for ownership verification
   * @param newStatus New booking status
   * @param actor Who is changing it — the vendor by default. An ADMINISTRATOR may also move a
   *   `no-show` to `completed` (ADMIN-BOOKINGS-PLAN § 4: a paid no-show waits for an
   *   administrator, who completes it — the vendor is paid after the hold — or cancels it).
   * @param reason Kept on the status history row.
   * @returns Updated booking
   */
  async updateBookingStatus(
    bookingId: string,
    vendorId: string,
    newStatus: BookingStatus,
    actor: BookingStatusActor = { role: 'vendor', id: vendorId },
    reason?: string | null
  ): Promise<IBooking> {
    // Booking status transition rules
    const VALID_TRANSITIONS: Record<string, string[]> = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['completed', 'cancelled', 'no-show'],
      completed: [],    // Terminal state
      'no-show': actor.role === 'admin' ? ['completed'] : [],    // Terminal for the vendor — no calendar sync
      cancelled: [],    // Terminal state
    };

    const booking = await Booking.findOne({
      _id: bookingId,
      vendorId,
      deletedAt: null,
    });

    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }

    const currentStatus = booking.status;

    // Validate transition
    if (!VALID_TRANSITIONS[currentStatus]?.includes(newStatus)) {
      throw createAppError(ERROR_CODES.BOOKING_INVALID_STATUS_TRANSITION, 400, `Cannot transition from ${currentStatus} to ${newStatus}. Allowed transitions: ${VALID_TRANSITIONS[currentStatus]?.join(', ') || 'none (terminal state)'}`);
    }

    // Update status. A completion is dated here, once, and the earnings hold below starts
    // from this same date — it is what the customer's protection window is counted from.
    const completedAt = newStatus === BookingStatus.COMPLETED ? new Date() : null;
    applyStatusChange(booking, newStatus, actor, reason);
    if (completedAt) booking.completedAt = completedAt;
    await booking.save();

    // Handle calendar sync (non-blocking - log errors but don't throw)
    try {
      const calendarClient = await CalendarClientFactory.forVendor(vendorId);

      if (calendarClient) {
        if (currentStatus === 'pending' && newStatus === 'confirmed') {
          // Create calendar event when confirming a pending booking
          const product = await ProductModel.findById(booking.productId);
          if (product) {
            const user = await UserModel.findById(booking.userId);
            const paymentPrefix = booking.requiresPayment ? '[UNPAID]' : '[FREE]';
            const colorId = getCalendarColorIdByStatus(booking.paymentStatus);

            const calendarEvent = await calendarClient.createEvent({
              title: `${paymentPrefix} ${product.title}`,
              description: bookingEventDescription({
                email: user?.login_email,
                priceSnapshot: booking.priceSnapshot,
                currency: booking.currency,
                bookingNumber: booking.bookingNumber,
                bookingId: booking._id,
                metadata: booking.metadata,
              }),
              start: booking.startAt,
              end: booking.endAt,
              colorId,
              location: calendarLocationOf(booking.location, booking.access),
            });

            // Update booking with calendar event ID
            booking.externalCalendarEventId = calendarEvent.externalId;
            await booking.save();
          }
        } else if (currentStatus === 'confirmed' && newStatus === 'cancelled') {
          // Take it off the calendar when cancelling a confirmed booking — or, for a
          // group service, take one seat off the shared class event rather than
          // deleting the class.
          await this.detachFromCalendarOnCancel(booking);
        }
        // no-show: intentionally no calendar action
      }
    } catch (calendarError) {
      // Log but don't block status update
      console.error('[BookingService] Calendar sync error during status update:', calendarError);
    }

    // On completion, start the escrow hold window on this booking's held earnings
    // (service products release only once the customer is satisfied / completed).
    // Idempotent and best-effort: a no-op when the booking had no paid earnings.
    if (newStatus === BookingStatus.COMPLETED) {
      try {
        await earningsCompletionService.onSourceCompleted('booking', booking._id.toString(), completedAt ?? new Date());
      } catch (earningsError) {
        console.error('[BookingService] Failed to mature booking earnings on completion:', earningsError);
      }
    }

    // Tell the customer. `pending → confirmed` had NO event at all, so someone
    // told "the provider still needs to accept it" was never told when they did.
    //
    // `completed` is emitted by CompletionPricingService instead — it is the only
    // caller that knows the settled final price and any balance, and a second
    // event from here would either duplicate it or carry the wrong numbers.
    if (currentStatus === BookingStatus.PENDING && newStatus === BookingStatus.CONFIRMED) {
      await this.emitBookingConfirmedEvent(booking);
    }
    if (newStatus === BookingStatus.CANCELLED) {
      await this.emitBookingCancelledEvent(booking, actor.role === 'admin' ? 'admin' : 'vendor');

      // Cancelled from the STATUS MENU after the customer paid. Unlike the seller's cancel
      // action (`vendorCancelBooking` → BookingRefundService), this path refunds nothing, so
      // the money is paused and a high-priority refund ticket is opened (owner, 2026-10-05).
      if (booking.paymentStatus === 'paid') {
        await raiseRefundOwed({
          target: { kind: 'booking', id: booking._id.toString() },
          reason: 'booking_cancelled_unrefunded',
          reference: booking.bookingNumber ?? booking._id.toString(),
          amount: booking.priceSnapshot,
          currency: booking.currency,
          paymentMethod: booking.paymentMethod ?? null,
          cancelledBy: 'the seller (status menu)',
        });
      }
    }

    return booking;
  }

  /**
   * Change ONE booking's link / instructions / reveal margin (owner decision D-5) — for the
   * meeting tools that generate a different link per session. The service's defaults are not
   * touched, and no other booking changes.
   *
   * Refused on a finished booking: the access window is over and the record should say what the
   * customer was actually given.
   *
   * The customer is not notified: the link reaches them through the time gate like any other,
   * and a message carrying it early would be the leak the gate exists to prevent.
   */
  async updateBookingAccess(
    bookingId: string,
    vendorId: string,
    patch: AppointmentSettingsPatch['access'],
  ): Promise<IBooking> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }
    const booking = await Booking.findOne({ _id: bookingId, vendorId, deletedAt: null });
    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }
    const finished: BookingStatus[] = [BookingStatus.CANCELLED, BookingStatus.COMPLETED, BookingStatus.NO_SHOW];
    if (finished.includes(booking.status)) {
      throw createAppError(ERROR_CODES.BOOKING_ACCESS_NOT_EDITABLE, 409, undefined, { status: booking.status });
    }

    booking.access = mergeAccessSetting(booking.access ?? null, patch) ?? null;
    await booking.save();
    return booking;
  }

  /**
   * Marks a cash booking as paid (vendor-only operation).
   *
   * Rules:
   * - Vendor must own the booking
   * - Booking must require payment and not already be paid
   * - Only valid for cash payment method (or unset, i.e. the vendor is declaring it was cash)
   *
   * @param bookingId Booking to mark as paid
   * @param vendorId Vendor performing the action
   */
  async markAsPaidByCash(bookingId: string, vendorId: string): Promise<IBooking> {
    const booking = await Booking.findOne({
      _id: bookingId,
      vendorId,
      deletedAt: null,
    });

    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }

    if (!booking.requiresPayment) {
      throw createAppError(ERROR_CODES.BOOKING_PAYMENT_NOT_REQUIRED, 400, 'This booking does not require payment');
    }

    if (booking.paymentStatus === 'paid') {
      throw createAppError(ERROR_CODES.BOOKING_ALREADY_PAID, 409, 'Booking is already marked as paid');
    }

    // Only allow for bookings that are cash or have no payment method yet
    if (booking.paymentMethod && booking.paymentMethod !== 'cash') {
      throw createAppError(ERROR_CODES.BOOKING_INVALID_PAYMENT_METHOD, 400, `Cannot manually mark a '${booking.paymentMethod}' booking as paid. Only cash bookings are eligible.`);
    }

    booking.paymentStatus = 'paid';
    booking.paymentMethod = 'cash';
    booking.paidAt = new Date();
    await booking.save();

    // Sync calendar color/title (non-blocking)
    try {
      const calendarSync = new BookingCalendarSyncService();
      await calendarSync.syncBookingPaymentStatus(booking);
    } catch (calendarError) {
      console.error('[BookingService] Calendar sync error after marking paid:', calendarError);
    }

    // Emit payment updated event
    try {
      await eventBus.publish('booking.payment.updated', {
        eventType: 'booking.payment.updated',
        aggregateId: booking._id.toString(),
        occurredAt: new Date(),
        payload: {
          bookingId: booking._id.toString(),
          vendorId: booking.vendorId.toString(),
          userId: booking.userId.toString(),
          paymentStatus: booking.paymentStatus,
          paymentMethod: booking.paymentMethod,
          paidAt: booking.paidAt,
        },
      });
    } catch (eventError) {
      console.error('[BookingService] Failed to emit booking.payment.updated event:', eventError);
    }

    return booking;
  }

  /**
   * Records that the outstanding balance on a completed booking was settled in
   * cash, on the day, by the vendor.
   *
   * A service business collects an overrun at the counter far more often than it
   * chases an online payment, and without this the balance would sit open forever
   * on a booking the vendor considers finished.
   *
   * Unlike the online path this moves NO money through a gateway — it records a
   * hand-to-hand payment the vendor is asserting happened, which is why it is
   * vendor-only and why the earnings split runs off the amount they declare.
   *
   * @param amount Optional partial settlement; defaults to the whole outstanding balance.
   */
  async settleBalanceByCash(
    bookingId: string,
    vendorId: string,
    amount?: number
  ): Promise<IBooking> {
    const booking = await Booking.findOne({
      _id: bookingId,
      vendorId: new Types.ObjectId(vendorId),
      deletedAt: null,
    });

    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw createAppError(
        ERROR_CODES.BOOKING_NOT_COMPLETED,
        409,
        'A balance can only be settled once the booking is completed'
      );
    }

    const settlement = booking.settlement;
    if (!settlement || settlement.balanceDue <= 0) {
      throw createAppError(ERROR_CODES.BOOKING_NO_BALANCE_DUE, 400, 'No balance is due on this booking');
    }

    const outstanding = settlement.balanceDue - (settlement.balancePaid ?? 0);
    if (outstanding <= 0) {
      throw createAppError(
        ERROR_CODES.BOOKING_BALANCE_ALREADY_SETTLED,
        409,
        'This balance has already been settled'
      );
    }

    // Never credit more than is owed: an over-declared cash amount would inflate
    // the vendor's earnings against money the customer never paid.
    const collected = Math.min(outstanding, Math.round(amount ?? outstanding));
    if (collected <= 0) {
      throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Amount must be greater than zero');
    }

    settlement.balancePaid = (settlement.balancePaid ?? 0) + collected;
    settlement.balancePaidAt = new Date();
    settlement.balancePaymentMethod = 'cash';
    booking.settlement = settlement;
    await booking.save();

    // Split the extra exactly as an online balance payment does. Best-effort:
    // the cash is already in the vendor's hand, so a split failure must not
    // reject a settlement that physically happened.
    try {
      await earningsSplitService.splitBookingBalance(booking, collected);
    } catch (error) {
      console.error('[BookingService] Failed to split cash balance earnings:', error);
    }

    return booking;
  }

  /**
   * Cancels a booking on behalf of a vendor, with optional reason.
   *
   * Differences from the customer-facing cancelBooking:
   * - Ownership is verified via vendorId (not userId)
   * - Returns ConflictError (409) on double-cancel or terminal state
   * - Provides calendar cleanup once, via service layer
   *
   * @param bookingId Booking to cancel
   * @param vendorId Vendor requesting cancellation
   * @param reason Optional reason for cancellation audit trail
   */
  async cancelVendorBooking(
    bookingId: string,
    vendorId: string,
    reason?: string,
    actorRole: 'vendor' | 'system' = 'vendor'
  ): Promise<IBooking> {
    const booking = await Booking.findOne({
      _id: bookingId,
      vendorId,
      deletedAt: null,
    });

    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }

    if (booking.status === BookingStatus.CANCELLED) {
      throw createAppError(ERROR_CODES.BOOKING_ALREADY_CANCELLED, 409, 'Booking is already cancelled');
    }

    // Cannot cancel terminal states other than 'cancelled'
    if (
      booking.status === BookingStatus.COMPLETED ||
      booking.status === BookingStatus.NO_SHOW
    ) {
      throw createAppError(ERROR_CODES.BOOKING_TERMINAL_STATE, 409, `Cannot cancel a booking that is already '${booking.status}'`);
    }

    // Take it off the calendar — or, for a group service, take one seat off the class.
    // Non-blocking, once.
    await this.detachFromCalendarOnCancel(booking);

    applyStatusChange(
      booking,
      BookingStatus.CANCELLED,
      actorRole === 'system' ? { role: 'system', id: null } : { role: 'vendor', id: vendorId },
      reason
    );
    booking.cancelledAt = new Date();
    booking.cancelledReason = reason;
    await booking.save();

    // A vendor cancelling on a paid customer owes the money back just as surely as
    // a customer cancelling does — arguably more so, since the customer did nothing
    // wrong. Same path, different actor on the audit trail.
    await this.refundIfPaid(booking, vendorId, 'vendor', reason);

    // `system` when the unpaid-booking sweep drove it — a customer told "the
    // provider cancelled" when nobody did would reasonably blame the vendor.
    await this.emitBookingCancelledEvent(booking, actorRole);

    return booking;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Administrator decisions (ADMIN-BOOKINGS-PLAN § 4)
  //
  // An administrator is a THIRD actor on the same paths the customer and the vendor use, never a
  // parallel implementation of them: the calendar detach, the refund and the events below are the
  // ones every other cancellation and completion runs. Reached only from wi-admin, through
  // `/api/internal/admin/bookings` — authorization and the audit row live on that side.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Cancel a booking for a party, and refund the customer through the ordinary cancellation refund.
   *
   * `fault` decides who bears the payment and transfer fees, nothing else:
   * - `vendor`   → the customer gets 100% back (the D-9 rule a declined vendor proposal uses);
   * - `customer` → the refund service's default, the customer bears the fees.
   *
   * Differences from the two existing cancellations, each deliberate:
   * - the vendor's cancellation POLICY is not applied — it is the vendor's promise to the customer,
   *   and the platform is not party to it (the order rule, `AdminOrderController.cancel`);
   * - a `no-show` may be cancelled: a PAID no-show holds its money until an administrator either
   *   completes it (the vendor is paid) or cancels it (the customer is refunded) — owner decision
   *   2026-10-27. A `completed` booking is refused: its refund is the refund queue's, which also
   *   recovers the vendor's earnings.
   */
  async cancelAsAdmin(
    bookingId: string,
    adminId: string,
    reason: string,
    fault: 'vendor' | 'customer'
  ): Promise<IBooking> {
    const booking = await this.findLiveBookingOrThrow(bookingId);

    if (booking.status === BookingStatus.CANCELLED) {
      throw createAppError(ERROR_CODES.BOOKING_ALREADY_CANCELLED, 409, 'Booking is already cancelled');
    }
    if (booking.status === BookingStatus.COMPLETED) {
      throw createAppError(ERROR_CODES.BOOKING_TERMINAL_STATE, 409, undefined, {
        status: booking.status,
        hint: 'A completed booking is refunded through the refund queue, which also recovers the vendor\'s earnings.',
      });
    }

    await this.detachFromCalendarOnCancel(booking);

    applyStatusChange(booking, BookingStatus.CANCELLED, { role: 'admin', id: adminId }, reason);
    booking.cancelledAt = new Date();
    booking.cancelledReason = reason;
    await booking.save();

    await this.refundIfPaid(booking, adminId, 'admin', reason, fault === 'vendor' ? 'vendor' : 'customer');
    await this.emitBookingCancelledEvent(booking, 'admin');

    return booking;
  }

  /**
   * Complete a booking for the vendor — the vendor is paid once the ordinary hold ends.
   *
   * From `confirmed` (the vendor never closed it) or `no-show` (a paid no-show the administrator
   * decided in the vendor's favour, or a wrong mark). Through `updateBookingStatus`, so the hold
   * starts exactly as a vendor completion starts it and the customer keeps the same protection
   * window. Completed at the BOOKED price: there is no settlement — an administrator does not know
   * how long a duration-priced session really ran.
   *
   * Refused while the customer has not paid (`BOOKING_ADMIN_COMPLETE_UNPAID`). The point of this
   * action is releasing money already held; completing an unpaid booking would instead ask the
   * customer for money, which is the vendor's call. A cash payment is recorded first
   * (`markAsPaidByCash`). Refused before the appointment starts (`BOOKING_NOT_STARTED`).
   */
  async completeAsAdmin(bookingId: string, adminId: string, reason: string): Promise<IBooking> {
    const booking = await this.findLiveBookingOrThrow(bookingId);

    if (booking.requiresPayment && booking.paymentStatus !== 'paid') {
      throw createAppError(ERROR_CODES.BOOKING_ADMIN_COMPLETE_UNPAID, 409, undefined, {
        paymentStatus: booking.paymentStatus,
        paymentMethod: booking.paymentMethod ?? null,
      });
    }
    if (booking.status === BookingStatus.CONFIRMED && booking.startAt.getTime() > Date.now()) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_STARTED, 409, undefined, { startAt: booking.startAt });
    }

    const updated = await this.updateBookingStatus(
      bookingId,
      booking.vendorId.toString(),
      BookingStatus.COMPLETED,
      { role: 'admin', id: adminId },
      reason
    );
    await this.emitBookingCompletedEvent(updated, updated.priceSnapshot, 0);
    return updated;
  }

  /**
   * Withdraw the open proposal of a new time, whichever side made it. The original time stands,
   * as it does when a proposal lapses. Nobody is notified — the proposer's own withdrawal notifies
   * nobody either, and the booking simply keeps the time both sides already have.
   */
  async withdrawProposalAsAdmin(bookingId: string): Promise<IBooking> {
    const booking = await this.findLiveBookingOrThrow(bookingId);
    const proposal = await this.liveProposalOrThrow(booking);
    booking.rescheduleProposal = { ...proposal, status: 'withdrawn', answeredAt: new Date() };
    await booking.save();
    return booking;
  }

  /** Every live seat of one class: same service, same start (a group service's session). */
  async findSessionSeats(productId: string, startAt: Date): Promise<IBooking[]> {
    if (!Types.ObjectId.isValid(productId)) return [];
    return Booking.find({
      productId: new Types.ObjectId(productId),
      startAt,
      status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      deletedAt: null,
    }).sort({ createdAt: 1 });
  }

  /** A booking by id, not soft-deleted, or 404 — unscoped, for the administrator paths only. */
  private async findLiveBookingOrThrow(bookingId: string): Promise<IBooking> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null });
    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }
    return booking;
  }

  /**
   * Returns bookings for a vendor grouped by date, for calendar display.
   *
   * Groups are keyed as 'YYYY-MM-DD' **in the vendor's own timezone**, which is
   * also returned so a client can re-derive the key from `startAt` and agree with
   * it. N+1 queries are avoided by using a single populated query.
   *
   * ⚠ Fixed 2026-09-09 (DOC-PROGRAM close-out § 6, item 2). The key was
   * `format(booking.startAt, 'yyyy-MM-dd')` — date-fns' `format`, which renders in
   * the PROCESS timezone — under a comment that said UTC. It was neither. A
   * booking at `23:30Z` landed under the next day on a server running UTC+1, the
   * grouping moved when the host's zone changed, and a client re-deriving the day
   * in UTC disagreed with the key it had been given.
   *
   * The vendor's zone is the platform's answer for a vendor's wall clock —
   * availability rules are authored in it (`availability-rule.model.ts`) and
   * `AvailabilityService.resolveVendorTimezone` resolves the same way, down to the
   * same `BOOKING_CONFIG.defaultTimezone` fallback whose own comment reads
   * "Deliberately NOT the server's zone — that is the bug this replaces". This was
   * the last site still carrying that bug.
   *
   * @param vendorId Authenticated vendor
   * @param startDate Start of the date range (inclusive), an absolute instant
   * @param endDate End of the date range (inclusive), an absolute instant
   */
  async getCalendarView(
    vendorId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    timezone: string;
    days: { date: string; bookings: CalendarDayBooking[] }[];
  }> {
    // Resolved BEFORE the query so a lookup failure cannot silently fall back to
    // the server's zone mid-grouping — the failure mode this method just left.
    const { vendorTimezone } = await this.resolveVendorIdentity(vendorId);
    const timezone = vendorTimezone || BOOKING_CONFIG.defaultTimezone;

    const bookings = await Booking.find({
      vendorId,
      // Filter on startAt only: results are grouped by the booking's start date,
      // so a booking starting within the range must never be dropped because it
      // ends after endDate.
      startAt: { $gte: startDate, $lte: endDate },
      deletedAt: null,
    })
      .sort({ startAt: 1 })
      .populate<{ productId: { _id: any; title: string } }>('productId', 'title')
      .populate<{ userId: { _id: any; login_email: string } }>('userId', 'login_email')
      .lean();

    // Group by date (YYYY-MM-DD as it reads on the VENDOR'S wall clock)
    const grouped = new Map<string, CalendarDayBooking[]>();

    for (const booking of bookings) {
      const dateKey = formatInTimeZone(booking.startAt, timezone, 'yyyy-MM-dd');

      if (!grouped.has(dateKey)) {
        grouped.set(dateKey, []);
      }

      const product = booking.productId as any;
      const user = booking.userId as any;

      grouped.get(dateKey)!.push({
        bookingId: booking._id.toString(),
        startAt: booking.startAt,
        endAt: booking.endAt,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        productId: product?._id?.toString() ?? null,
        productTitle: product?.title ?? null,
        customerEmail: user?.login_email ?? null,
        externalCalendarEventId: booking.externalCalendarEventId ?? null,
      });
    }

    // Return sorted by date
    const days = Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bookings]) => ({ date, bookings }));

    return { timezone, days };
  }

  /**
   * Emit booking.created event
   *
   * Consumed by BOTH the vendor stack (they have work) and the customer stack
   * (they are told what they booked and whether it still needs accepting) — one
   * event, two audiences, two entirely different messages.
   *
   * `status` is on the payload because the customer's copy depends on it: a
   * `manual` booking lands `pending` and the customer must be told they are
   * waiting on the vendor, rather than assuming it is settled. The VENDOR's copy
   * depends on the same field for the mirror-image reason — a pending booking is
   * one they still have to accept, and their message has to say so.
   *
   * ⚠ THIS PAYLOAD IS THE MESSAGE. Both consumers are forbidden to enrich from
   * the database ("No DB enrichment - use event payload only" —
   * `VendorNotificationEventHandler`), so a field that is not here cannot appear
   * in any notification. Four of them exist purely to be rendered:
   *
   *   `bookingNumber`   the handle the message names
   *   `customerName`    who booked it — the vendor's first question
   *   `vendorTimezone`  the zone `startAt` must be rendered in; without it the
   *                    time is formatted in whatever zone the server runs in
   *   `productTitle`    what was booked
   *
   * The vendor handler used to read `bookingNumber`, `serviceName` and
   * `startTime`, and this payload has never carried any of those three names.
   * Every value rendered empty and the date rendered the literal string
   * "Invalid Date" (`new Date(undefined)`), so every vendor was sent
   * "New booking # for scheduled on Invalid Date." — and the WhatsApp send failed
   * outright, because Meta rejects an empty template parameter. Renaming a field
   * on either side without the other is the way back to that.
   *
   * @param booking - Created booking
   * @param productTitle - Product title for notification message
   */
  private async emitBookingCreatedEvent(booking: IBooking, productTitle: string): Promise<void> {
    try {
      // Read before the literal, and spelled out field-by-field below rather than
      // spread into it. A spread is opaque to `test:booking-notification`'s source
      // scan — the one thing that can see a producer and a consumer disagreeing —
      // so a payload field hidden inside one is a field nothing checks.
      const vendor = await this.resolveVendorIdentity(booking.vendorId.toString());

      await eventBus.publish('booking.created', {
        eventType: 'booking.created',
        aggregateId: booking._id.toString(),
        occurredAt: new Date(),
        payload: {
          bookingId: booking._id.toString(),
          vendorId: booking.vendorId.toString(),
          userId: booking.userId.toString(),
          productId: booking.productId.toString(),
          bookingNumber: booking.bookingNumber ?? null,
          productTitle,
          vendorName: vendor.vendorName,
          vendorTimezone: vendor.vendorTimezone,
          customerName: await this.resolveCustomerName(booking.userId.toString()),
          startAt: booking.startAt,
          endAt: booking.endAt,
          status: booking.status,
          priceSnapshot: booking.priceSnapshot,
          currency: booking.currency,
          requiresPayment: booking.requiresPayment,
          paymentStatus: booking.paymentStatus,
          /**
           * The chat this booking was made in, when it was made in one — set by the bot's two
           * booking doors. The customer handler uses it to send ONE confirmation (the chat's own)
           * instead of two. Absent for a storefront or vendor booking, which is unchanged.
           */
          bookedInChat: (booking.metadata as { bookedInChat?: string } | undefined)?.bookedInChat
        }
      });

      console.log(`[BookingService] Emitted booking.created event for booking ${booking._id}`);
    } catch (error: any) {
      console.error('[BookingService] Failed to emit booking.created event:', error);
      // Don't throw - this is a secondary operation
    }
  }

  /**
   * Emit booking.cancelled event
   *
   * `cancelledByRole` and `paymentStatus` are on the payload for the customer's
   * copy: it has to name who called it off and say where the money went in the
   * SAME message. A separate refund notification arriving minutes later (or not
   * at all, if the refund path fails) is how a cancellation reads as theft.
   *
   * `bookingNumber` is here for the vendor's copy, which is a single sentence
   * naming the booking and nothing else — without it that message read
   * "Booking # has been cancelled.", which identifies no booking at all.
   *
   * @param booking - Cancelled booking
   * @param cancelledByRole - Which side ended it
   */
  private async emitBookingCancelledEvent(
    booking: IBooking,
    cancelledByRole: 'customer' | 'vendor' | 'system' | 'admin' = 'vendor'
  ): Promise<void> {
    try {
      await eventBus.publish('booking.cancelled', {
        eventType: 'booking.cancelled',
        aggregateId: booking._id.toString(),
        occurredAt: new Date(),
        payload: {
          bookingId: booking._id.toString(),
          vendorId: booking.vendorId.toString(),
          userId: booking.userId.toString(),
          productId: booking.productId.toString(),
          bookingNumber: booking.bookingNumber ?? null,
          productTitle: await this.resolveProductTitle(booking.productId.toString()),
          startAt: booking.startAt,
          endAt: booking.endAt,
          cancelledAt: booking.cancelledAt!,
          cancelledReason: booking.cancelledReason,
          cancelledByRole,
          // Read AFTER the refund attempt, so it reports where the money actually
          // ended up rather than where it was before.
          paymentStatus: booking.paymentStatus,
          priceSnapshot: booking.priceSnapshot,
          currency: booking.currency
        }
      });

      console.log(`[BookingService] Emitted booking.cancelled event for booking ${booking._id}`);
    } catch (error: any) {
      console.error('[BookingService] Failed to emit booking.cancelled event:', error);
      // Don't throw - this is a secondary operation
    }
  }

  /**
   * Emit booking.confirmed — a `manual` booking the vendor has accepted.
   *
   * There was no event for this at all, so the customer who was told "the
   * provider still needs to accept it" was never told when they did.
   */
  private async emitBookingConfirmedEvent(booking: IBooking): Promise<void> {
    try {
      await eventBus.publish('booking.confirmed', {
        eventType: 'booking.confirmed',
        aggregateId: booking._id.toString(),
        occurredAt: new Date(),
        payload: {
          bookingId: booking._id.toString(),
          vendorId: booking.vendorId.toString(),
          userId: booking.userId.toString(),
          productId: booking.productId.toString(),
          bookingNumber: booking.bookingNumber ?? null,
          productTitle: await this.resolveProductTitle(booking.productId.toString()),
          vendorName: await this.resolveVendorName(booking.vendorId.toString()),
          startAt: booking.startAt,
          endAt: booking.endAt
        }
      });
    } catch (error: any) {
      console.error('[BookingService] Failed to emit booking.confirmed event:', error);
    }
  }

  /**
   * Emit booking.rescheduled — carries BOTH times so the move is verifiable.
   *
   * `movedBy` says who made it happen: `customer` (moved it themselves — the VENDOR is told, D-8),
   * `vendor` (only ever via an accepted proposal today, kept for completeness), `agreed` (a
   * proposal one side made and the other accepted — both already know, the customer is told the
   * new time as a confirmation).
   */
  private async emitBookingRescheduledEvent(
    booking: IBooking,
    previousStartAt: Date,
    movedBy: 'customer' | 'vendor' | 'agreed'
  ): Promise<void> {
    try {
      await eventBus.publish('booking.rescheduled', {
        eventType: 'booking.rescheduled',
        aggregateId: booking._id.toString(),
        occurredAt: new Date(),
        payload: {
          bookingId: booking._id.toString(),
          vendorId: booking.vendorId.toString(),
          userId: booking.userId.toString(),
          productId: booking.productId.toString(),
          productTitle: await this.resolveProductTitle(booking.productId.toString()),
          bookingNumber: booking.bookingNumber ?? null,
          vendorTimezone: (await this.resolveVendorIdentity(booking.vendorId.toString())).vendorTimezone,
          customerName: await this.resolveCustomerName(booking.userId.toString()),
          startAt: booking.startAt,
          endAt: booking.endAt,
          previousStartAt,
          movedBy
        }
      });
    } catch (error: any) {
      console.error('[BookingService] Failed to emit booking.rescheduled event:', error);
    }
  }

  /**
   * Emit booking.reschedule_proposed — one side asked for a new time and the OTHER must answer
   * (D-8, D-9). Carries both times and the deadline after which the original time stands.
   */
  private async emitRescheduleProposedEvent(booking: IBooking): Promise<void> {
    const proposal = booking.rescheduleProposal;
    if (!proposal) return;
    try {
      await eventBus.publish('booking.reschedule_proposed', {
        eventType: 'booking.reschedule_proposed',
        aggregateId: booking._id.toString(),
        occurredAt: new Date(),
        payload: {
          bookingId: booking._id.toString(),
          vendorId: booking.vendorId.toString(),
          userId: booking.userId.toString(),
          productId: booking.productId.toString(),
          productTitle: await this.resolveProductTitle(booking.productId.toString()),
          ...(await this.resolveVendorIdentity(booking.vendorId.toString())),
          customerName: await this.resolveCustomerName(booking.userId.toString()),
          bookingNumber: booking.bookingNumber ?? null,
          proposedBy: proposal.proposedBy,
          startAt: proposal.startAt,
          endAt: proposal.endAt,
          previousStartAt: proposal.previousStartAt,
          expiresAt: proposal.expiresAt
        }
      });
    } catch (error: any) {
      console.error('[BookingService] Failed to emit booking.reschedule_proposed event:', error);
    }
  }

  /** Emit booking.reschedule_answered — the other side accepted or declined. The PROPOSER is told. */
  private async emitRescheduleAnsweredEvent(booking: IBooking, answer: 'accepted' | 'declined'): Promise<void> {
    const proposal = booking.rescheduleProposal;
    if (!proposal) return;
    try {
      await eventBus.publish('booking.reschedule_answered', {
        eventType: 'booking.reschedule_answered',
        aggregateId: booking._id.toString(),
        occurredAt: new Date(),
        payload: {
          bookingId: booking._id.toString(),
          vendorId: booking.vendorId.toString(),
          userId: booking.userId.toString(),
          productId: booking.productId.toString(),
          productTitle: await this.resolveProductTitle(booking.productId.toString()),
          ...(await this.resolveVendorIdentity(booking.vendorId.toString())),
          customerName: await this.resolveCustomerName(booking.userId.toString()),
          bookingNumber: booking.bookingNumber ?? null,
          proposedBy: proposal.proposedBy,
          answer,
          proposedStartAt: proposal.startAt,
          previousStartAt: proposal.previousStartAt,
          startAt: booking.startAt
        }
      });
    } catch (error: any) {
      console.error('[BookingService] Failed to emit booking.reschedule_answered event:', error);
    }
  }

  /**
   * Emit booking.completed — the appointment happened and was settled.
   *
   * `finalPrice` and `balanceDue` come from the completion settlement rather than
   * the booking's frozen `priceSnapshot`, which is only the original quote.
   */
  async emitBookingCompletedEvent(
    booking: IBooking,
    finalPrice: number,
    balanceDue: number
  ): Promise<void> {
    try {
      await eventBus.publish('booking.completed', {
        eventType: 'booking.completed',
        aggregateId: booking._id.toString(),
        occurredAt: new Date(),
        payload: {
          bookingId: booking._id.toString(),
          vendorId: booking.vendorId.toString(),
          userId: booking.userId.toString(),
          productId: booking.productId.toString(),
          productTitle: await this.resolveProductTitle(booking.productId.toString()),
          vendorName: await this.resolveVendorName(booking.vendorId.toString()),
          finalPrice,
          balanceDue,
          currency: booking.currency
        }
      });
    } catch (error: any) {
      console.error('[BookingService] Failed to emit booking.completed event:', error);
    }
  }

  /**
   * A product's title, or null. Never throws: a missing product must not cost the
   * notification — the catalog falls back to a generic "your service".
   */
  private async resolveProductTitle(productId: string): Promise<string | null> {
    try {
      const product = await ProductModel.findById(productId).select('title').lean();
      return product?.title ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The SHOP's name, or null. Same never-throws rule as above.
   *
   * ⚠ The Store's name first: business identity lives on the Store, and `display_name` is the
   * vendor's PERSONAL name — which is what every booking message named until 2026-09-22. The
   * personal name stays only as the fallback for a vendor with no store row.
   */
  private async resolveVendorName(vendorId: string): Promise<string | null> {
    try {
      const shop = (await this.storeRepo.findNameByVendorId(vendorId))?.trim();
      if (shop) return shop;
      const vendor = await this.vendorRepo.findById(vendorId);
      return vendor?.display_name ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The vendor's name AND the timezone their notifications must render times in,
   * from ONE read.
   *
   * Both go on `booking.created`, and the timezone is the load-bearing half. The
   * notification handlers are forbidden to enrich from the database, so without
   * this the vendor's start time is formatted in whatever zone the Node process
   * happens to run in — which for a containerised deployment is UTC, an hour off
   * for every vendor in Douala, and silently wrong rather than obviously wrong.
   * A vendor's availability rules are already authored in this zone
   * (`availability-rule.model.ts`), so it is the zone they think in.
   *
   * `Vendor.timezone` is `required` with a default, so the null is only the
   * lookup failing. The consumer supplies its own fallback rather than one being
   * baked in here.
   */
  private async resolveVendorIdentity(
    vendorId: string
  ): Promise<{ vendorName: string | null; vendorTimezone: string | null }> {
    try {
      const vendor = await this.vendorRepo.findById(vendorId);
      // The shop's name, not the person's — see resolveVendorName.
      const shop = (await this.storeRepo.findNameByVendorId(vendorId))?.trim();
      return {
        vendorName: shop || (vendor?.display_name ?? null),
        vendorTimezone: vendor?.timezone ?? null,
      };
    } catch {
      return { vendorName: null, vendorTimezone: null };
    }
  }

  /**
   * The customer's name, for the vendor's copy of `booking.created`.
   *
   * Keyed on `user_id` because a booking references the `users` row, not the
   * `customers` profile. Null when there is no customer profile (a booking made
   * by a user who never completed one) or the lookup fails — the consumer then
   * says "a customer" rather than leaving a hole in the sentence.
   *
   * Not a privacy widening: the vendor is already sent the customer's LOGIN EMAIL
   * in the calendar event this same method's caller writes, and a display name is
   * strictly less identifying than that. They are about to provide this person a
   * service in person.
   */
  private async resolveCustomerName(userId: string): Promise<string | null> {
    try {
      const customer = await CustomerModel.findOne({ user_id: userId })
        .select('name')
        .lean()
        .exec();
      return customer?.name ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * A proposal as a plain object. The stored one is a Mongoose sub-document, and spreading that
 * (`{ ...proposal, status }`) copies its internals rather than its fields — every write of a new
 * status goes through this first.
 */
function plainProposal(p: IRescheduleProposal): IRescheduleProposal {
  return {
    status: p.status,
    proposedBy: p.proposedBy,
    slotId: p.slotId,
    startAt: p.startAt,
    endAt: p.endAt,
    previousStartAt: p.previousStartAt,
    previousEndAt: p.previousEndAt,
    proposedAt: p.proposedAt,
    expiresAt: p.expiresAt,
    answeredAt: p.answeredAt ?? null,
  };
}
