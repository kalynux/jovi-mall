import type { AppointmentAccessSetting, BookingLocationSnapshot } from '../domain/appointment';

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
  /** The id of the booked interval — one slot's own id, or a span id for consecutive slots. */
  slotId: string;
  /**
   * The slots the caller holds for this booking, each under its own checkout hold. Omitted means
   * `[slotId]`. Every one is asserted held before the write and released after it.
   */
  heldSlotIds?: string[];
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
  /** Where it happens, frozen now — `AppointmentLocationService.snapshotForBooking`. */
  location?: BookingLocationSnapshot | null;
  /** The service's link and instructions, copied now — `accessSnapshotFor`. */
  access?: AppointmentAccessSetting | null;
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
