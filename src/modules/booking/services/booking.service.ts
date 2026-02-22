import { Booking, IBooking } from '../models/booking.model';
import { CreateBookingInput, BookingStatus, CalendarDayBooking } from '../types/booking.types';
import { SlotLockService } from './slot-lock.service';
import { SlotGeneratorService } from './slot-generator.service';
import { CalendarClientFactory } from '../../integrations/calendar/calendar-client.factory';
import { CalendarEventInput } from '../../integrations/calendar/interfaces/calendar-client.interface';
import { ProductModel } from "../../catalog/models";
import { UserModel } from "../../users/user.model";
import { getCalendarColorIdByStatus } from '../../integrations/calendar/utils/calendar-event-colors.util';
import { eventBus } from '../../../core/events/event-bus';
import { BookingCalendarSyncService } from './booking-calendar-sync.service';
import { ConflictError, NotFoundError, ValidationError, ForbiddenError } from '../../../core/errors';
import { format } from 'date-fns';

export class BookingService {
  private slotLockService: SlotLockService;
  private slotGenerator: SlotGeneratorService;

  constructor() {
    this.slotLockService = new SlotLockService();
    this.slotGenerator = new SlotGeneratorService();
  }

  /**
   * Creates a booking after verifying slot lock.
   * @param input Booking details
   * @param lockOwnerId The ID of the entity that locked the slot
   * @returns Created booking
   */
  async createBooking(input: CreateBookingInput, lockOwnerId: string): Promise<IBooking> {
    const { slotId, userId, productId, vendorId, metadata, priceSnapshot, currency, requiresPayment } = input;

    const product = await ProductModel.findById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    // Step 1: Assert slot is locked by the owner
    await this.slotLockService.assertLocked(slotId, lockOwnerId);

    // Step 2: Parse slot to get start/end times
    const { start, end } = this.slotGenerator.parseSlotId(slotId);

    // Step 3: Get calendar client for vendor (not customer)
    const calendarClient = await CalendarClientFactory.forVendor(vendorId);

    // Determine payment status for calendar title and color
    const needsPayment = requiresPayment !== false; // Default to true
    const paymentPrefix = needsPayment ? '[UNPAID]' : '[FREE]';
    const paymentStatus = needsPayment ? 'unpaid' : 'paid';
    const colorId = getCalendarColorIdByStatus(paymentStatus);

    // Step 4: Create calendar event
    const eventInput: CalendarEventInput = {
      title: `${paymentPrefix} ${product.title} `,
      description: `Booked by ${user.login_email} \nPrice: ${priceSnapshot} ${currency} \nNotes: ${metadata?.notes}`,
      start,
      end,
      colorId, // Apply color based on payment status
      metadata: {
        ...metadata,
        bookingUserId: userId,
        bookingProductId: productId,
      },
    };

    const calendarEvent = await calendarClient.createEvent(eventInput, {
      idempotencyKey: slotId, // Use slotId for idempotency
    });

    // Step 5: Create booking record
    const booking = await Booking.create({
      productId,
      userId,
      vendorId,
      startAt: start,
      endAt: end,
      status: BookingStatus.CONFIRMED,
      externalCalendarEventId: calendarEvent.externalId,
      metadata,
      priceSnapshot,
      currency: currency || 'XAF',
      requiresPayment: needsPayment,
    });

    // Step 6: Release slot lock
    await this.slotLockService.release(slotId, lockOwnerId);

    // Step 7: Emit booking.created event
    await this.emitBookingCreatedEvent(booking, product.title);

    return booking;
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
      throw new Error('Booking not found');
    }

    // Verify ownership
    if (booking.userId.toString() !== userId) {
      throw new Error('Unauthorized to cancel this booking');
    }

    if (booking.status === BookingStatus.CANCELLED) {
      throw new Error('Booking is already cancelled');
    }

    // Delete from calendar if exists
    if (booking.externalCalendarEventId) {
      try {
        const calendarClient = await CalendarClientFactory.forVendor(
          booking.vendorId.toString()
        );
        await calendarClient.deleteEvent(booking.externalCalendarEventId);
      } catch (error) {
        console.error('Failed to delete calendar event:', error);
        // Continue with cancellation even if calendar delete fails
      }
    }

    // Update booking status
    booking.status = BookingStatus.CANCELLED;
    booking.cancelledAt = new Date();
    booking.cancelledReason = reason;
    await booking.save();

    // Emit booking.cancelled event
    await this.emitBookingCancelledEvent(booking);

    return booking;
  }

  /**
   * Reschedules a booking to a new slot.
   * @param bookingId Existing booking ID
   * @param newSlotId New slot ID
   * @param lockOwnerId Owner of the new slot lock
   */
  async rescheduleBooking(
    bookingId: string,
    newSlotId: string,
    lockOwnerId: string
  ): Promise<IBooking> {
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      throw new Error('Booking not found');
    }

    if (booking.status === BookingStatus.CANCELLED) {
      throw new Error('Cannot reschedule a cancelled booking');
    }

    // Step 1: Assert new slot is locked
    await this.slotLockService.assertLocked(newSlotId, lockOwnerId);

    // Step 2: Parse new slot
    const { start, end } = this.slotGenerator.parseSlotId(newSlotId);

    // Step 3: Get calendar client for vendor
    const calendarClient = await CalendarClientFactory.forVendor(
      booking.vendorId.toString()
    );

    // Step 4: Update calendar event
    if (booking.externalCalendarEventId) {
      try {
        // Preserve payment status color when rescheduling
        const colorId = getCalendarColorIdByStatus(booking.paymentStatus);

        await calendarClient.updateEvent(booking.externalCalendarEventId, {
          title: `Booking for Product ${booking.productId}`,
          description: `Rescheduled booking by user ${booking.userId}`,
          start,
          end,
          colorId, // Preserve payment status color
          metadata: booking.metadata as Record<string, string>,
        });
      } catch (error) {
        console.error('Failed to update calendar event:', error);
        throw new Error('Failed to reschedule in calendar');
      }
    }

    // Step 5: Update booking
    booking.startAt = start;
    booking.endAt = end;
    await booking.save();

    // Step 6: Release slot lock
    await this.slotLockService.release(newSlotId, lockOwnerId);

    return booking;
  }

  /**
   * Gets bookings for a user.
   */
  async getUserBookings(userId: string, status?: BookingStatus): Promise<IBooking[]> {
    const query: any = { userId };
    if (status) {
      query.status = status;
    }
    return Booking.find(query).sort({ startAt: -1 });
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
      throw new Error('Booking not found');
    }

    const currentStatus = booking.status;

    // Validate transition
    if (!VALID_TRANSITIONS[currentStatus]?.includes(newStatus)) {
      throw new Error(
        `Cannot transition from ${currentStatus} to ${newStatus}. ` +
        `Allowed transitions: ${VALID_TRANSITIONS[currentStatus]?.join(', ') || 'none (terminal state)'}`
      );
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
              description: `Booked by ${user?.login_email || 'Unknown'}\nBooking #${booking._id}`,
              start: booking.startAt,
              end: booking.endAt,
              colorId,
            });

            // Update booking with calendar event ID
            booking.externalCalendarEventId = calendarEvent.externalId;
            await booking.save();
          }
        } else if (
          currentStatus === 'confirmed' &&
          newStatus === 'cancelled' &&
          booking.externalCalendarEventId
        ) {
          // Delete calendar event when cancelling a confirmed booking
          await calendarClient.deleteEvent(booking.externalCalendarEventId);
        }
        // no-show: intentionally no calendar action
      }
    } catch (calendarError) {
      // Log but don't block status update
      console.error('[BookingService] Calendar sync error during status update:', calendarError);
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
      throw new NotFoundError('Booking not found');
    }

    if (!booking.requiresPayment) {
      throw new ValidationError('This booking does not require payment');
    }

    if (booking.paymentStatus === 'paid') {
      throw new ConflictError('Booking is already marked as paid');
    }

    // Only allow for bookings that are cash or have no payment method yet
    if (booking.paymentMethod && booking.paymentMethod !== 'cash') {
      throw new ValidationError(
        `Cannot manually mark a '${booking.paymentMethod}' booking as paid. Only cash bookings are eligible.`
      );
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
    reason?: string
  ): Promise<IBooking> {
    const booking = await Booking.findOne({
      _id: bookingId,
      vendorId,
      deletedAt: null,
    });

    if (!booking) {
      throw new NotFoundError('Booking not found');
    }

    if (booking.status === BookingStatus.CANCELLED) {
      throw new ConflictError('Booking is already cancelled');
    }

    // Cannot cancel terminal states other than 'cancelled'
    if (
      booking.status === BookingStatus.COMPLETED ||
      booking.status === BookingStatus.NO_SHOW
    ) {
      throw new ConflictError(
        `Cannot cancel a booking that is already '${booking.status}'`
      );
    }

    // Delete from calendar (non-blocking, once)
    if (booking.externalCalendarEventId) {
      try {
        const calendarClient = await CalendarClientFactory.forVendor(vendorId);
        await calendarClient.deleteEvent(booking.externalCalendarEventId);
      } catch (calendarError) {
        console.error('[BookingService] Failed to delete calendar event on vendor cancel:', calendarError);
      }
    }

    booking.status = BookingStatus.CANCELLED;
    booking.cancelledAt = new Date();
    booking.cancelledReason = reason;
    await booking.save();

    await this.emitBookingCancelledEvent(booking);

    return booking;
  }

  /**
   * Returns bookings for a vendor grouped by date, for calendar display.
   *
   * Groups are keyed as 'YYYY-MM-DD' in UTC.
   * N+1 queries are avoided by using a single populated query.
   *
   * @param vendorId Authenticated vendor
   * @param startDate Start of the date range (inclusive, UTC)
   * @param endDate End of the date range (inclusive, UTC)
   */
  async getCalendarView(
    vendorId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ date: string; bookings: CalendarDayBooking[] }[]> {
    const bookings = await Booking.find({
      vendorId,
      startAt: { $gte: startDate },
      endAt: { $lte: endDate },
      deletedAt: null,
    })
      .sort({ startAt: 1 })
      .populate<{ productId: { _id: any; title: string } }>('productId', 'title')
      .populate<{ userId: { _id: any; login_email: string } }>('userId', 'login_email')
      .lean();

    // Group by date (YYYY-MM-DD in UTC)
    const grouped = new Map<string, CalendarDayBooking[]>();

    for (const booking of bookings) {
      const dateKey = format(booking.startAt, 'yyyy-MM-dd');

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
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bookings]) => ({ date, bookings }));
  }

  /**
   * Emit booking.created event
   * 
   * Called after booking is successfully created to notify vendors.
   * 
   * @param booking - Created booking
   * @param productTitle - Product title for notification message
   */
  private async emitBookingCreatedEvent(booking: IBooking, productTitle: string): Promise<void> {
    try {
      await eventBus.publish('booking.created', {
        eventType: 'booking.created',
        aggregateId: booking._id.toString(),
        occurredAt: new Date(),
        payload: {
          bookingId: booking._id.toString(),
          vendorId: booking.vendorId.toString(),
          userId: booking.userId.toString(),
          productId: booking.productId.toString(),
          productTitle,
          startAt: booking.startAt,
          endAt: booking.endAt,
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
   * Called after booking is successfully cancelled to notify vendors.
   * 
   * @param booking - Cancelled booking
   */
  private async emitBookingCancelledEvent(booking: IBooking): Promise<void> {
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
          startAt: booking.startAt,
          endAt: booking.endAt,
          cancelledAt: booking.cancelledAt!,
          cancelledReason: booking.cancelledReason
        }
      });

      console.log(`[BookingService] Emitted booking.cancelled event for booking ${booking._id}`);
    } catch (error: any) {
      console.error('[BookingService] Failed to emit booking.cancelled event:', error);
      // Don't throw - this is a secondary operation
    }
  }
}
