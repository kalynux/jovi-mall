import { Product } from '../../../repositories/mappers/product.mapper';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { DEFAULT_VARIANT_SIGNATURE } from '../../services/variants/constants';
import { VendorModel } from '../../../../vendors/vendor.model';
import { BOOKING_CONFIG } from '../../../../booking/config/booking.config';
import { peakOverlapMinutes } from '../../../../booking/utils/availability-timezone.util';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';

export interface PriceBreakdown {
  basePrice: number;
  peakHoursSurcharge?: number;
  // Future extensions:
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
 * The service config + base price live on the product's single default variant
 * (`variant.serviceConfig`, `variant.price`). The base price is the cost per
 * `serviceConfig.durationMinutes`; the booking price is prorated by the booking's
 * actual elapsed duration, plus an optional peak-hours surcharge applied only to the
 * minutes overlapping the configured peak window.
 *
 * The same method serves both booking-time estimation (the booked slot) and
 * completion-time recalculation (the actual elapsed interval) — callers pass the
 * relevant { start, end }.
 *
 * Peak windows are wall-clock times, so they are evaluated in the VENDOR's
 * timezone. Reading the server's clock instead (as this did) meant the surcharge
 * applied at the wrong hours for every vendor not colocated with the server.
 */
export class BookingPriceResolver {
  constructor(private readonly variantRepository: IVariantRepository) { }

  /**
   * Resolves the price for a booking interval.
   *
   * @param product - The service product being booked
   * @param slot - The interval being priced ({ start, end }); pass the booked slot at
   *               booking time, or the actual elapsed interval at completion time
   * @param userId - Optional user ID for user-specific pricing (not used in this phase)
   * @returns Resolved price with breakdown
   * @throws AppError if the product has no default service variant, the price is invalid,
   *         or the variant has no serviceConfig
   */
  async resolvePrice(
    product: Product,
    slot: { start: Date; end: Date },
    userId?: string
  ): Promise<ResolvedPrice> {
    // 1. Fetch the default active variant — it carries the service config + base price.
    const variants = await this.variantRepository.findByProduct(product.id);
    const activeVariants = variants.filter(v => v.status === 'active');

    if (activeVariants.length === 0) {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_INVALID_PRICE, 422, undefined, { productId: product.id, reason: 'no_active_variants' });
    }

    const defaultVariant = activeVariants.find(
      v => v.optionSignature === DEFAULT_VARIANT_SIGNATURE
    );

    if (!defaultVariant) {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_INVALID_PRICE, 422, undefined, { productId: product.id, reason: 'no_default_variant' });
    }

    if (defaultVariant.price < 0) {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_INVALID_PRICE, 422, undefined, { productId: product.id, reason: 'negative_price' });
    }

    const serviceConfig = defaultVariant.serviceConfig;
    if (!serviceConfig) {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_MISSING_SERVICE_CONFIG, 422, undefined, { productId: product.id });
    }

    const configuredDurationMinutes = serviceConfig.durationMinutes;
    if (configuredDurationMinutes <= 0) {
      throw createAppError(ERROR_CODES.CATALOG_BOOKING_INVALID_PRICE, 422, undefined, { productId: product.id, reason: 'invalid_duration' });
    }

    // 2. Base price prorated by the actual elapsed duration. The variant price is the
    //    cost for one configured-duration unit (e.g. 5000 / 60 min); a 2h30 booking of a
    //    per-hour service costs 5000 × 2.5.
    const pricePerMinute = defaultVariant.price / configuredDurationMinutes;
    const actualMinutes = (slot.end.getTime() - slot.start.getTime()) / (1000 * 60);
    const baseAmount = pricePerMinute * actualMinutes;

    // 3. Peak surcharge — applies only to the minutes overlapping the peak window on the
    //    selected days. Percentage surcharges scale the peak-portion price; fixed surcharges
    //    add a flat amount when any peak overlap exists.
    let surcharge = 0;
    const peak = serviceConfig.peakHours;
    if (peak) {
      const timezone = await this.resolveVendorTimezone(product.vendorId);
      const peakMinutes = peakOverlapMinutes(slot.start, slot.end, peak, timezone);
      if (peakMinutes > 0) {
        surcharge = peak.priceType === 'percentage'
          ? (pricePerMinute * peakMinutes) * (peak.value / 100)
          : peak.value;
      }
    }

    const basePrice = Math.round(baseAmount);
    const peakHoursSurcharge = Math.round(surcharge);
    const amount = basePrice + peakHoursSurcharge;

    const breakdown: PriceBreakdown = { basePrice };
    if (peakHoursSurcharge > 0) breakdown.peakHoursSurcharge = peakHoursSurcharge;

    return {
      amount,
      currency: 'XAF',
      breakdown,
    };
  }

  /**
   * The vendor's wall-clock zone — the same source of truth availability uses, so a
   * peak window and the slots it prices can never disagree about what "18:00" means.
   * @private
   */
  private async resolveVendorTimezone(vendorId: string): Promise<string> {
    const vendor = await VendorModel.findById(vendorId).select('timezone').lean();
    return vendor?.timezone || BOOKING_CONFIG.defaultTimezone;
  }
}
