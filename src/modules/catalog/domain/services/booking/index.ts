/**
 * Booking Services - Product-centric booking orchestration
 * 
 * These services provide a product-focused interface for interacting
 * with the booking infrastructure while maintaining clean separation
 * between catalog and booking modules.
 */

export { ProductBookingService, BookProductResult } from './ProductBookingService';
export { SlotLockFacade } from './SlotLockFacade';
export { BookingPriceResolver, ResolvedPrice, PriceBreakdown } from './BookingPriceResolver';
