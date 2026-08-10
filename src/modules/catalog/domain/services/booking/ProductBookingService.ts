import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { DEFAULT_VARIANT_SIGNATURE } from '../../services/variants/constants';
import { Product } from '../../../repositories/mappers/product.mapper';
import { AvailabilityService } from '../../../../booking/services/availability.service';
import { SlotGeneratorService } from '../../../../booking/services/slot-generator.service';
import { BookingService } from '../../../../booking/services/booking.service';
import { IBooking } from '../../../../booking/models/booking.model';
import { Slot } from '../../../../booking/types/booking.types';
import { BookedWindow, fullWindows, spotsRemainingFor } from '../../../../booking/utils/availability-windows.util';
import { BookingPriceResolver, ResolvedPrice } from './BookingPriceResolver';
import { SlotLockFacade } from './SlotLockFacade';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';

export interface BookProductResult {
  booking: IBooking;
  price: ResolvedPrice;
}

/**
 * ProductBookingService - Product-centric orchestration for service bookings
 * 
 * This service provides a product-focused interface for booking operations,
 * orchestrating calls to the underlying booking infrastructure.
 */
export class ProductBookingService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly availabilityService: AvailabilityService,
    private readonly slotGenerator: SlotGeneratorService,
    private readonly bookingService: BookingService,
    private readonly priceResolver: BookingPriceResolver,
    private readonly variantRepository: IVariantRepository,
    private readonly slotLockFacade: SlotLockFacade = new SlotLockFacade()
  ) { }

  /**
   * Fetches the single default service variant — the carrier of serviceConfig + price.
   * @throws AppError if there is no active default variant with a serviceConfig.
   */
  private async getServiceVariant(productId: string): Promise<Variant> {
    const variants = await this.variantRepository.findByProduct(productId);
    const serviceVariant = variants.find(
      v => v.status === 'active' && v.optionSignature === DEFAULT_VARIANT_SIGNATURE && v.serviceConfig
    );
    if (!serviceVariant || !serviceVariant.serviceConfig) {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_MISSING_SERVICE_CONFIG, 422, undefined, { productId });
    }
    return serviceVariant;
  }

  /**
   * Gets available booking slots for a service product.
   * 
   * @param productId - The service product ID
   * @param fromDate - Start of date range
   * @param toDate - End of date range
   * @returns Array of available slots
   * @throws ValidationError if product is not a service or doesn't exist
   */
  async getAvailability(
    productId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<Slot[]> {
    // Step 1: Fetch and validate product
    const product = await this.productRepository.findByIdUnscoped(productId);
    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_FOUND, 404, undefined, { productId });
    }

    if (product.type !== 'service') {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_INVALID_PRODUCT_TYPE, 422, undefined, { productId, type: product.type });
    }

    // The service config (incl. slot duration) lives on the default service variant.
    const serviceVariant = await this.getServiceVariant(productId);
    const serviceConfig = serviceVariant.serviceConfig!;
    const isCapacity = serviceConfig.bookingMode === 'capacity';
    const seats = isCapacity ? (serviceConfig.maxBookings ?? 1) : 1;

    // The product's OWN bookings decide its occupancy — for every mode, not just
    // capacity. Reading occupancy from Google Calendar alone meant a `manual`
    // booking (which writes no calendar event until the vendor approves it) never
    // blocked its own slot, so the same hour could be sold without limit.
    const bookedWindows = await this.bookingService.findActiveBookingWindows(
      productId,
      fromDate,
      toDate
    );

    // Two different jobs, hence two lists:
    // - ownBookedWindows: drop this product's own calendar events from busy time so
    //   a partially-filled capacity slot is not subtracted out of existence.
    // - fullBookedWindows: the windows that are genuinely full, subtracted as busy.
    const ownBookedWindows = bookedWindows.map((w) => ({ start: w.start, end: w.end }));
    const fullBookedWindows = fullWindows(bookedWindows, seats);

    // Step 2: Get availability windows
    const availableWindows = await this.availabilityService.getAvailability(
      productId,
      product.vendorId,
      fromDate,
      toDate,
      {
        ownBookedWindows,
        fullBookedWindows,
        bufferBeforeMinutes: serviceConfig.bufferBeforeMinutes,
        bufferAfterMinutes: serviceConfig.bufferAfterMinutes,
      }
    );

    // Step 3: Generate bookable slots
    const slots = this.slotGenerator.generateSlots(
      availableWindows,
      serviceConfig.durationMinutes
    );

    if (!isCapacity) {
      return slots;
    }

    // Step 4 (capacity): annotate each slot with its seat count. Full windows were
    // already subtracted above, so anything still here has at least one seat.
    return slots.map((slot) => {
      const spotsRemaining = spotsRemainingFor(slot, bookedWindows, seats);
      return {
        ...slot,
        maxBookings: seats,
        spotsRemaining,
        available: spotsRemaining > 0,
      };
    });
  }

  /**
   * Books a service product for a specific slot.
   * 
   * @param productId - The service product ID
   * @param slotId - The slot ID to book
   * @param userId - The user making the booking
   * @param lockOwnerId - The ID of the entity that locked the slot (typically same as userId)
   * @param metadata - Optional metadata for the booking
   * @returns Booking record with price information
   * @throws ValidationError if product validation fails
   * @throws Error if slot is not locked by the owner
   */
  async bookProduct(
    productId: string,
    slotId: string,
    userId: string,
    lockOwnerId: string,
    metadata?: Record<string, any>
  ): Promise<BookProductResult> {
    // Step 1: Fetch and validate product
    const product = await this.productRepository.findByIdUnscoped(productId);
    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_FOUND, 404, undefined, { productId });
    }

    if (product.type !== 'service') {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_INVALID_PRODUCT_TYPE, 422, undefined, { productId });
    }

    if (product.status !== 'active') {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_ACTIVE, 422, undefined, { productId, status: product.status });
    }

    // Ensure the product has a usable default service variant before pricing.
    // Its serviceConfig.bookingMode decides how the booking is created:
    // - calendar: confirmed immediately + calendar event
    // - manual: held PENDING for vendor approval
    // - capacity: confirmed immediately, multiple seats share one calendar event
    const serviceVariant = await this.getServiceVariant(productId);
    const serviceConfig = serviceVariant.serviceConfig!;
    const bookingMode = serviceConfig.bookingMode;

    // Step 2: Parse slot to get timing
    const { start, end } = this.slotGenerator.parseSlotId(slotId);

    // Step 3: Resolve price
    const price = await this.priceResolver.resolvePrice(
      product,
      { start, end },
      userId
    );

    const bookingInput = {
      productId,
      userId,
      vendorId: product.vendorId,
      slotId,
      priceSnapshot: price.amount, // Add price snapshot for booking record
      bookingMode,
      metadata: {
        ...metadata,
        price: price.amount,
        currency: price.currency,
      },
    };

    // Step 4: Create booking — capacity mode uses the multi-seat path.
    let booking: IBooking;
    if (bookingMode === 'capacity') {
      const maxBookings = serviceConfig.maxBookings;
      if (!maxBookings || maxBookings < 1) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_CAPACITY, 422, undefined, { productId });
      }
      booking = await this.bookingService.createCapacityBooking(bookingInput, maxBookings, lockOwnerId);
    } else {
      booking = await this.bookingService.createBooking(bookingInput, lockOwnerId);
    }

    return {
      booking,
      price,
    };
  }

  /**
   * Locks a slot for checkout. Mode-aware so capacity products allow concurrent holds:
   * - calendar/manual: exclusive hold (one user per slot).
   * - capacity: per-user hold (`slot:lock:{slotId}:{userId}`), so up to maxBookings users
   *   can each hold the slot during checkout. Capacity is enforced at booking time.
   *
   * @returns true if the hold was acquired, false if already held (exclusive mode).
   */
  async lockSlot(productId: string, slotId: string, userId: string, ttlSeconds?: number): Promise<boolean> {
    const scopeToOwner = await this.isCapacityProduct(productId);
    return this.slotLockFacade.lockSlot(slotId, userId, ttlSeconds, scopeToOwner);
  }

  /**
   * Releases a slot hold the caller owns. Mode-aware to match lockSlot's key namespace.
   */
  async unlockSlot(productId: string, slotId: string, userId: string): Promise<boolean> {
    const scopeToOwner = await this.isCapacityProduct(productId);
    return this.slotLockFacade.releaseSlot(slotId, userId, scopeToOwner);
  }

  /** Whether the product's active service variant is in capacity booking mode. */
  private async isCapacityProduct(productId: string): Promise<boolean> {
    try {
      const variant = await this.getServiceVariant(productId);
      return variant.serviceConfig!.bookingMode === 'capacity';
    } catch {
      // No usable service variant → not capacity; fall back to exclusive locking.
      return false;
    }
  }

  /**
   * The windows this product is booked in, and how many bookings occupy each.
   *
   * Was a `501 NOT_IMPLEMENTED` stub. It is now the same query availability uses
   * to decide occupancy, so there is exactly one definition of "is this product
   * booked at time T".
   *
   * @param productId - The product ID
   * @param fromDate - Start of the range (defaults to now)
   * @param toDate - End of the range (defaults to 30 days out)
   */
  async getProductBookings(
    productId: string,
    fromDate: Date = new Date(),
    toDate: Date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  ): Promise<BookedWindow[]> {
    return this.bookingService.findActiveBookingWindows(productId, fromDate, toDate);
  }
}
