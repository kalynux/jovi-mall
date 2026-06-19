export interface TimeWindow {
  start: Date;
  end: Date;
}

export interface Slot {
  id: string;
  start: Date;
  end: Date;
  available: boolean;
  // Capacity-mode only: total seats per slot and how many remain. Undefined for
  // calendar/manual products (which are strictly single-occupancy).
  maxBookings?: number;
  spotsRemaining?: number;
}

export interface SlotLockData {
  ownerId: string;
  expiresAt: number;
}

export interface CreateBookingInput {
  slotId: string;
  userId: string;
  productId: string;
  vendorId: string;
  metadata?: Record<string, any>;
  priceSnapshot: number;
  currency?: string;
  requiresPayment?: boolean;
  /**
   * Booking mode from the service variant's serviceConfig. Drives how the booking is
   * created:
   * - 'calendar' (default): booking is CONFIRMED immediately and a calendar event is created.
   * - 'manual': booking is created PENDING with no calendar event; the vendor must confirm
   *   it (PATCH /bookings/:id/status → confirmed), which then creates the calendar event.
   * - 'capacity': not yet implemented; treated as 'calendar'.
   */
  bookingMode?: 'calendar' | 'manual' | 'capacity';
}

export enum BookingStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  COMPLETED = 'completed',
  NO_SHOW = 'no-show',
  CANCELLED = 'cancelled',
}

/**
 * Shape of a single booking entry within a calendar day group,
 * returned by BookingService.getCalendarView().
 */
export interface CalendarDayBooking {
  bookingId: string;
  startAt: Date;
  endAt: Date;
  status: string;
  paymentStatus: string;
  productId: string | null;
  productTitle: string | null;
  customerEmail: string | null;
  externalCalendarEventId: string | null;
}
