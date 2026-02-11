import { Product } from '../../../repositories/mappers/product.mapper';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { DEFAULT_VARIANT_SIGNATURE } from '../../services/variants/constants';
import { ValidationError } from '../../../../../core/errors';

export interface PriceBreakdown {
  basePrice: number;
  // Future extensions:
  // peakHoursSurcharge?: number;
  // staffPremium?: number;
  // durationDiscount?: number;
  // promoDiscount?: number;
}

export interface ResolvedPrice {
  amount: number;
  currency: string;
  breakdown: PriceBreakdown;
}

/**
 * BookingPriceResolver - Centralized pricing logic for service bookings
 * 
 * Current phase: Variant-based base price resolution with duration multiplier
 * Future: Dynamic pricing based on time, staff, demand, etc.
 */
export class BookingPriceResolver {
  constructor(private readonly variantRepository: IVariantRepository) { }

  /**
   * Resolves the price for a booking based on product variant and slot duration.
   * 
   * Pricing Logic:
   * - Fetches the default variant for the product
   * - Uses variant.price as the base price for the configured service duration
   * - Applies duration multiplier: actualPrice = variantPrice × (slotDuration / configuredDuration)
   * - Currency is the system default ('XAF')
   * 
   * @param product - The service product being booked
   * @param slot - The time slot being booked
   * @param userId - Optional user ID for user-specific pricing (not used in this phase)
   * @returns Resolved price with breakdown
   * @throws ValidationError if product has no default variant or variant price is invalid
   */
  async resolvePrice(
    product: Product,
    slot: { start: Date; end: Date },
    userId?: string
  ): Promise<ResolvedPrice> {
    // 1. Fetch all variants for the product
    const variants = await this.variantRepository.findByProduct(product.id);

    // 2. Filter for active variants only
    const activeVariants = variants.filter(v => v.status === 'active');

    if (activeVariants.length === 0) {
      throw new ValidationError(
        `Product ${product.id} has no active variants. Cannot determine price.`
      );
    }

    // 3. Find the default variant
    const defaultVariant = activeVariants.find(
      v => v.optionSignature === DEFAULT_VARIANT_SIGNATURE
    );

    if (!defaultVariant) {
      throw new ValidationError(
        `Product ${product.id} has no default variant. Unable to resolve booking price.`
      );
    }

    // 4. Validate variant price
    if (defaultVariant.price < 0) {
      throw new ValidationError(
        `Invalid variant price for product ${product.id}: price cannot be negative`
      );
    }

    // 5. Calculate duration multiplier
    // The variant price represents the cost for the configured service duration.
    // If the actual slot duration differs, we prorate the price accordingly.
    const slotDurationMinutes = (slot.end.getTime() - slot.start.getTime()) / (1000 * 60);

    if (!product.serviceConfig) {
      throw new ValidationError(
        `Service product ${product.id} is missing serviceConfig`
      );
    }

    const configuredDurationMinutes = product.serviceConfig.durationMinutes;

    if (configuredDurationMinutes <= 0) {
      throw new ValidationError(
        `Invalid service duration for product ${product.id}: must be greater than 0`
      );
    }

    const durationMultiplier = slotDurationMinutes / configuredDurationMinutes;

    // 6. Calculate final price
    const basePrice = Math.round(defaultVariant.price * durationMultiplier);

    // 7. Resolve currency (system default)
    const currency = 'XAF';

    const breakdown: PriceBreakdown = {
      basePrice,
    };

    return {
      amount: basePrice,
      currency,
      breakdown,
    };

    // Future extensions (Phase 9+):
    // - Check if slot is during peak hours (weekend, evening)
    // - Apply staff-based pricing multiplier
    // - Apply promotional discounts
    // - Check user-specific pricing (VIP, loyalty)
    // - Apply demand-based surge pricing
  }

  /**
   * Checks if a given time slot falls within peak hours.
   * @private
   * @note Currently unused - reserved for future peak pricing implementation
   */
  private isPeakHours(slot: { start: Date; end: Date }): boolean {
    const dayOfWeek = slot.start.getDay();
    const hour = slot.start.getHours();

    // Weekend
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return true;
    }

    // Weekday evenings (6 PM - 9 PM)
    if (hour >= 18 && hour < 21) {
      return true;
    }

    return false;
  }
}
