import { IBooking, BookingPaymentStatus } from '../models/booking.model';
import { CalendarClientFactory } from '../../integrations/calendar/calendar-client.factory';
import {
  getCalendarColorIdByStatus,
  getStatusPrefix
} from '../../integrations/calendar/utils/calendar-event-colors.util';

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
      // Get calendar client for vendor
      const calendarClient = await CalendarClientFactory.forVendor(
        booking.vendorId.toString()
      );

      // Build event title with payment status
      const statusPrefix = getStatusPrefix(booking.paymentStatus);
      const title = `${statusPrefix} Booking - Product ${booking.productId}`;

      // Get color ID based on payment status
      const colorId = getCalendarColorIdByStatus(booking.paymentStatus);

      // Update calendar event
      await calendarClient.updateEvent(booking.externalCalendarEventId, {
        title,
        description: `Booking by user ${booking.userId} | Payment: ${booking.paymentStatus}`,
        start: booking.startAt,
        end: booking.endAt,
        colorId, // Apply color based on payment status
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
