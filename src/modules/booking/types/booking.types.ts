export interface TimeWindow {
  start: Date;
  end: Date;
}

export interface Slot {
  id: string;
  start: Date;
  end: Date;
  available: boolean;
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
