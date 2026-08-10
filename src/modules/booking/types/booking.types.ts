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
   * - 'calendar' (default): booking is CONFIRMED immediately, single occupancy. A
   *   calendar event is mirrored best-effort after the commit.
   * - 'manual': booking is created PENDING; the vendor must confirm it
   *   (PATCH /bookings/:id/status → confirmed), which then creates the calendar event.
   *   The booking row blocks the slot from creation regardless — it does not wait
   *   for the calendar event.
   * - 'capacity': CONFIRMED immediately, up to `serviceConfig.maxBookings` seats per
   *   slot sharing one calendar event, via `createCapacityBooking`.
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
