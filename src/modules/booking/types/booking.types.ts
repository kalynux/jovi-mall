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
  CANCELLED = 'cancelled',
}
