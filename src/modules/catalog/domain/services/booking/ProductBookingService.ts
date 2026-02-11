import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { Product } from '../../../repositories/mappers/product.mapper';
import { AvailabilityService } from '../../../../booking/services/availability.service';
import { SlotGeneratorService } from '../../../../booking/services/slot-generator.service';
import { BookingService } from '../../../../booking/services/booking.service';
import { IBooking } from '../../../../booking/models/booking.model';
import { Slot } from '../../../../booking/types/booking.types';
import { BookingPriceResolver, ResolvedPrice } from './BookingPriceResolver';
import { ValidationError } from '../../../../../core/errors';

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
    private readonly priceResolver: BookingPriceResolver
  ) { }

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
      throw new ValidationError(`Product ${productId} not found`);
    }

    if (product.type !== 'service') {
      throw new ValidationError(
        `Product ${productId} is not a service product. Type: ${product.type}`
      );
    }

    if (!product.serviceConfig) {
      throw new ValidationError(
        `Service product ${productId} is missing serviceConfig`
      );
    }

    // Step 2: Get availability windows
    const availableWindows = await this.availabilityService.getAvailability(
      productId,
      product.vendorId,
      fromDate,
      toDate
    );

    // Step 3: Generate bookable slots
    const slots = this.slotGenerator.generateSlots(
      availableWindows,
      product.serviceConfig.durationMinutes
    );

    return slots;
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
      throw new ValidationError(`Product ${productId} not found`);
    }

    if (product.type !== 'service') {
      throw new ValidationError(
        `Product ${productId} is not a service product`
      );
    }

    if (product.status !== 'active') {
      throw new ValidationError(
        `Product ${productId} is not active. Status: ${product.status}`
      );
    }

    if (!product.serviceConfig) {
      throw new ValidationError(
        `Service product ${productId} is missing serviceConfig`
      );
    }

    // Step 2: Parse slot to get timing
    const { start, end } = this.slotGenerator.parseSlotId(slotId);

    // Step 3: Resolve price
    const price = await this.priceResolver.resolvePrice(
      product,
      { start, end },
      userId
    );

    // Step 4: Create booking
    // Note: For Phase 8.3, we create confirmed bookings immediately
    // Phase 9 will introduce PENDING_PAYMENT status and conditional calendar creation
    const booking = await this.bookingService.createBooking(
      {
        productId,
        userId,
        vendorId: product.vendorId,
        slotId,
        priceSnapshot: price.amount, // Add price snapshot for booking record
        metadata: {
          ...metadata,
          price: price.amount,
          currency: price.currency,
        },
      },
      lockOwnerId
    );

    return {
      booking,
      price,
    };
  }

  /**
   * Gets bookings for a specific product.
   * 
   * @param productId - The product ID
   * @param fromDate - Optional start date filter
   * @param toDate - Optional end date filter
   * @returns Array of bookings
   */
  async getProductBookings(
    productId: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<IBooking[]> {
    // This would require adding a method to BookingService
    // For now, we'll throw a not implemented error
    throw new Error('Not yet implemented. Add BookingService.getProductBookings()');
  }
}
