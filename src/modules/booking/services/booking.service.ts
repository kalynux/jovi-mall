import { ClientSession, Types } from 'mongoose';
import { Booking, IBooking, BookingPaymentStatus } from '../models/booking.model';
import { CreateBookingInput, BookingStatus, CalendarDayBooking } from '../types/booking.types';
import { BookedWindow } from '../utils/availability-windows.util';
import { transactionManager } from '../../../core/database/transaction.manager';
import { isCalendarNotConnected } from '../utils/calendar-error.util';
import { SlotLockService } from './slot-lock.service';
import { SlotGeneratorService } from './slot-generator.service';
import { GroupBookingService } from './group-booking.service';
import { CalendarClientFactory } from '../../integrations/calendar/calendar-client.factory';
import { CalendarEventInput } from '../../integrations/calendar/interfaces/calendar-client.interface';
import { ProductModel } from "../../catalog/models";
import { UserModel } from "../../users/user.model";
import { getCalendarColorIdByStatus } from '../../integrations/calendar/utils/calendar-event-colors.util';
import { eventBus } from '../../../core/events/event-bus';
import { BookingCalendarSyncService } from './booking-calendar-sync.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { earningsCompletionService } from '../../earnings/services/earnings-completion.service';
import { earningsSplitService } from '../../earnings/services/earnings-split.service';
import { bookingRefundService } from './booking-refund.service';
import { VendorRepository } from '../../vendors/vendor.repository';
import { assertCancellationAllowed } from '../../vendors/utils/cancellation-policy.util';
import { BookingNumberGenerator } from '../utils/booking-number.generator';
import { CustomerModel } from '../../customers/customer.model';
import { formatInTimeZone } from 'date-fns-tz';
import { BOOKING_CONFIG } from '../config/booking.config';

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

  constructor() {
    this.slotLockService = new SlotLockService();
    this.slotGenerator = new SlotGeneratorService();
    this.groupBookingService = new GroupBookingService();
    this.vendorRepo = new VendorRepository();
  }

  /**
   * Creates a booking after verifying slot lock.
   * @param input Booking details
   * @param lockOwnerId The ID of the entity that locked the slot
   * @returns Created booking
   */
  async createBooking(input: CreateBookingInput, lockOwnerId: string): Promise<IBooking> {
    const { slotId, userId, productId, vendorId, metadata, priceSnapshot, currency, requiresPayment, bookingMode } = input;

    const product = await ProductModel.findById(productId);
    if (!product) {
      throw createAppError(ERROR_CODES.BOOKING_PRODUCT_NOT_FOUND, 404, 'Product not found');
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      throw createAppError(ERROR_CODES.BOOKING_USER_NOT_FOUND, 404, 'User not found');
    }
    // Step 1: Assert slot is locked by the owner
    await this.slotLockService.assertLocked(slotId, lockOwnerId);

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
            metadata,
            priceSnapshot,
            currency: currency || 'XAF',
            requiresPayment: needsPayment,
          },
        ],
        { session }
      );
      return created;
    });

    // Step 4: Release the slot hold — the booking row now holds the interval.
    await this.slotLockService.release(slotId, lockOwnerId);

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
        description: `Booked by ${user.login_email}\nPrice: ${priceSnapshot} ${currency || 'XAF'}\nBooking #${booking.bookingNumber ?? booking._id}${metadata?.notes ? `\nNotes: ${metadata.notes}` : ''}`,
        start,
        end,
        colorId: getCalendarColorIdByStatus(paymentStatus),
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

    return rows.map((row) => ({
      start: new Date(row._id.start),
      end: new Date(row._id.end),
      count: row.count,
    }));
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
    session?: ClientSession
  ): Promise<number> {
    return Booking.countDocuments({
      productId: new Types.ObjectId(productId),
      status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      deletedAt: null,
      startAt: { $lt: end },
      endAt: { $gt: start },
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

    // Enforce the vendor's cancellation policy (customer-initiated cancellation).
    const vendor = await this.vendorRepo.findById(booking.vendorId.toString());
    assertCancellationAllowed(vendor?.policies?.cancellation_policy ?? null, {
      createdAt: booking.createdAt,
      serviceOrDeliveryAt: booking.startAt,
      isPending: booking.status === BookingStatus.PENDING,
    });

    // Take it off the calendar — or, for a group service, take one seat off the class.
    await this.detachFromCalendarOnCancel(booking);

    // Update booking status
    booking.status = BookingStatus.CANCELLED;
    booking.cancelledAt = new Date();
    booking.cancelledReason = reason;
    await booking.save();

    // Return the money. Post-commit and best-effort: the slot is already released,
    // and a refund that cannot be issued electronically becomes `refund_pending`
    // plus a support ticket rather than blocking the cancellation.
    //
    // Runs BEFORE the event so the notification reports the real payment outcome.
    await this.refundIfPaid(booking, userId, 'customer', reason);

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
    reason?: string
  ): Promise<void> {
    try {
      const outcome = await bookingRefundService.refundCancelledBooking(
        booking,
        initiatedBy,
        initiatedByRole,
        reason
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
   * @param newSlotId New slot ID
   * @param lockOwnerId Owner of the hold on the new slot (the caller)
   * @param actor Which side is asking, and their id
   */
  async rescheduleBooking(
    bookingId: string,
    newSlotId: string,
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

    await this.slotLockService.assertLocked(newSlotId, lockOwnerId, scopeToOwner);

    // Step 2: Parse new slot
    const { start, end } = this.slotGenerator.parseSlotId(newSlotId);

    const previousStartAt = booking.startAt;
    const previousEndAt = booking.endAt;
    const previousEventId = booking.externalCalendarEventId;

    // Steps 3+4: check occupancy and move. Both are mode-specific, and inseparable —
    // a group move counts seats and writes under the target slot's capacity mutex, so
    // that a concurrent booking cannot slip into the last seat between the two.
    if (group) {
      await this.groupBookingService.moveIntoSlot(
        booking,
        newSlotId,
        { start, end },
        group.maxBookings
      );
    } else {
      // Single occupancy: the target must actually be free. The hold guards concurrent
      // movers; this guards against moving onto an interval that is already sold.
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
          { slotId: newSlotId }
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
        newSlotId
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
          description: `Rescheduled booking by ${user?.login_email || 'Unknown'}\nBooking #${booking.bookingNumber ?? booking._id}`,
          start,
          end,
          colorId: getCalendarColorIdByStatus(booking.paymentStatus), // Preserve payment status color
          metadata: booking.metadata as Record<string, string>,
        });
      } catch (error) {
        console.error('[BookingService] Failed to update calendar event on reschedule:', error);
      }
    }

    // Step 6: Release slot lock — under the same key namespace it was asserted with.
    await this.slotLockService.release(newSlotId, lockOwnerId, scopeToOwner);

    // Step 7: Tell the customer, with BOTH times — a message carrying only the
    // new one is indistinguishable from a duplicate of the original booking.
    await this.emitBookingRescheduledEvent(booking, previousStartAt);

    return booking;
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
   * @returns Updated booking
   */
  async updateBookingStatus(
    bookingId: string,
    vendorId: string,
    newStatus: BookingStatus
  ): Promise<IBooking> {
    // Booking status transition rules
    const VALID_TRANSITIONS: Record<string, string[]> = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['completed', 'cancelled', 'no-show'],
      completed: [],    // Terminal state
      'no-show': [],    // Terminal state — no calendar sync
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

    // Update status
    booking.status = newStatus;
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
              description: `Booked by ${user?.login_email || 'Unknown'}\nBooking #${booking.bookingNumber ?? booking._id}`,
              start: booking.startAt,
              end: booking.endAt,
              colorId,
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
        await earningsCompletionService.onSourceCompleted('booking', booking._id.toString());
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
      await this.emitBookingCancelledEvent(booking, 'vendor');
    }

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

    booking.status = BookingStatus.CANCELLED;
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
          paymentStatus: booking.paymentStatus
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
    cancelledByRole: 'customer' | 'vendor' | 'system' = 'vendor'
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

  /** Emit booking.rescheduled — carries BOTH times so the move is verifiable. */
  private async emitBookingRescheduledEvent(
    booking: IBooking,
    previousStartAt: Date
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
          startAt: booking.startAt,
          endAt: booking.endAt,
          previousStartAt
        }
      });
    } catch (error: any) {
      console.error('[BookingService] Failed to emit booking.rescheduled event:', error);
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

  /** The vendor's display name, or null. Same never-throws rule as above. */
  private async resolveVendorName(vendorId: string): Promise<string | null> {
    try {
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
      return {
        vendorName: vendor?.display_name ?? null,
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
