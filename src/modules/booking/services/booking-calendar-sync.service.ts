import { IBooking, BookingPaymentStatus } from '../models/booking.model';
import { CalendarClientFactory } from '../../integrations/calendar/calendar-client.factory';
import {
  getCalendarColorIdByStatus,
  getStatusPrefix
} from '../../integrations/calendar/utils/calendar-event-colors.util';
import { ProductModel } from '../../catalog/models';
import { UserModel } from '../../users/user.model';
import { bookingEventDescription } from '../utils/calendar-description.util';
import { GroupBookingService } from './group-booking.service';
import { calendarLocationOf } from '../domain/appointment';

/**
 * BookingCalendarSyncService - Sync booking payment status to Google Calendar
 * 
 * RESPONSIBILITIES:
 * - Update calendar event titles with payment status prefix
 * - Apply color coding based on payment status
 * - Keep calendar in sync with payment lifecycle
 * 
 * STATUS MAPPING:
 * - unpaid  → 🟡 Yellow - [UNPAID] Service Name - Customer
 * - pending → 🟠 Orange - [PENDING] Service Name - Customer
 * - paid    → 🟢 Green - [PAID] Service Name - Customer
 * - failed  → 🔴 Red - [FAILED] Service Name - Customer
 * - refunded → 🟣 Purple - [REFUNDED] Service Name - Customer
 */
export class BookingCalendarSyncService {

  /**
   * Sync booking payment status to calendar
   * 
   * Updates the calendar event title and color to reflect current payment status
   * 
   * @param booking - Booking to sync
   */
  async syncBookingPaymentStatus(booking: IBooking): Promise<void> {
    // Skip if no calendar event
    if (!booking.externalCalendarEventId) {
      console.log(`[BookingCalendarSync] No calendar event for booking ${booking._id}, skipping sync`);
      return;
    }

    try {
      // A capacity slot's event is SHARED by every seat in the class. Rewriting it
      // with one seat's payment would replace the whole class with that customer.
      // `resolveCapacity` throws on a misconfigured group — treat that as a group too.
      const isGroupSlot = await new GroupBookingService()
        .resolveCapacity(booking.productId.toString())
        .then((g) => g !== null, () => true);
      if (isGroupSlot) return;

      // Get calendar client for vendor
      const calendarClient = await CalendarClientFactory.forVendor(
        booking.vendorId.toString()
      );

      // Same title and description `createBooking` writes, with the payment state
      // swapped in. This used to write raw ids ("Booking - Product 6f3a…",
      // "Booking by user 6f3b…") and dropped the customer's note.
      const [product, user] = await Promise.all([
        ProductModel.findById(booking.productId).select('title').lean(),
        UserModel.findById(booking.userId).select('login_email').lean(),
      ]);
      const statusPrefix = getStatusPrefix(booking.paymentStatus);
      const title = `${statusPrefix} ${product?.title ?? 'Booking'}`;

      // Get color ID based on payment status
      const colorId = getCalendarColorIdByStatus(booking.paymentStatus);

      // Update calendar event
      await calendarClient.updateEvent(booking.externalCalendarEventId, {
        title,
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
        colorId, // Apply color based on payment status
        // ⚠ The Google client REPLACES the event (`events.update`), so a field left out here is
        // erased — the appointment's address / link would vanish on every payment change.
        location: calendarLocationOf(booking.location, booking.access),
        metadata: {
          bookingId: booking._id.toString(),
          paymentStatus: booking.paymentStatus,
          paymentMethod: booking.paymentMethod || 'unknown',
        },
      });

      console.log(`[BookingCalendarSync] Updated calendar event for booking ${booking._id}: ${title}`);
    } catch (error: any) {
      console.error(`[BookingCalendarSync] Failed to sync booking ${booking._id}:`, error);
      // Don't throw - calendar sync failures shouldn't block payment processing
    }
  }


}
