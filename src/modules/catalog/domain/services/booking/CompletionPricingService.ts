import { Booking, IBooking } from '../../../../booking/models/booking.model';
import { BookingService } from '../../../../booking/services/booking.service';
import { BookingStatus } from '../../../../booking/types/booking.types';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { BookingPriceResolver, ResolvedPrice } from './BookingPriceResolver';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';

/**
 * How the vendor wants to settle a service appointment at completion time.
 *
 * Exactly one pricing mode is expected:
 *  - `fixedPrice`: a flat final price, regardless of how long the service actually took.
 *  - `actualEndAt` / `additionalMinutes`: recompute the price from the actual elapsed
 *    duration (base price per configured unit, prorated, plus peak surcharge).
 *  - none: settle at the originally booked duration (`booking.endAt`).
 */
export interface CompleteBookingInput {
  actualEndAt?: string;       // ISO timestamp the service actually ended
  additionalMinutes?: number; // extra minutes beyond the booked end
  fixedPrice?: number;        // flat final price, overrides duration-based pricing
}

export interface CompleteBookingResult {
  booking: IBooking;
  priceSnapshot: number;        // the originally booked estimate
  finalPrice: number;           // the recomputed/flat final price
  additionalAmountDue: number;  // max(0, finalPrice - priceSnapshot)
  recalculated?: ResolvedPrice; // present when priced from duration (not fixedPrice)
}

/**
 * CompletionPricingService — recomputes a service booking's final price when the vendor
 * marks the appointment completed, then transitions it to `completed`.
 *
 * NOTE: the additional-payment request is intentionally STUBBED. When the recomputed
 * price exceeds the booked snapshot, we record the shortfall on the booking metadata and
 * return it, but we do NOT yet create a payment transaction or notify the customer. The
 * fixed-price and additional-time inputs are fully wired so the frontend contract is
 * stable; settling the extra charge is future work (see the TODO below).
 */
export class CompletionPricingService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly priceResolver: BookingPriceResolver,
    private readonly bookingService: BookingService,
  ) { }

  async completeBooking(
    bookingId: string,
    vendorId: string,
    input: CompleteBookingInput,
  ): Promise<CompleteBookingResult> {
    const booking = await Booking.findOne({ _id: bookingId, vendorId, deletedAt: null });
    if (!booking) {
      throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
    }

    // Resolve the final price.
    let finalPrice: number;
    let recalculated: ResolvedPrice | undefined;

    if (input.fixedPrice !== undefined) {
      finalPrice = Math.round(input.fixedPrice);
    } else {
      const product = await this.productRepository.findByIdUnscoped(booking.productId.toString());
      if (!product) {
        throw createAppError(ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_FOUND, 404, undefined, { productId: booking.productId.toString() });
      }

      const start = booking.startAt;
      const end = input.actualEndAt
        ? new Date(input.actualEndAt)
        : input.additionalMinutes
          ? new Date(booking.endAt.getTime() + input.additionalMinutes * 60_000)
          : booking.endAt;

      if (isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
        throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Actual end must be after the booking start');
      }

      recalculated = await this.priceResolver.resolvePrice(product, { start, end });
      finalPrice = recalculated.amount;
    }

    const additionalAmountDue = Math.max(0, finalPrice - booking.priceSnapshot);

    // Record the settlement on the booking. priceSnapshot stays the booked estimate; the
    // recomputed figures live under metadata.completion so the original quote is preserved.
    booking.metadata = {
      ...(booking.metadata ?? {}),
      completion: {
        finalPrice,
        additionalAmountDue,
        pricingMode: input.fixedPrice !== undefined ? 'fixed' : 'duration',
        recalculatedAt: new Date().toISOString(),
        ...(recalculated ? { breakdown: recalculated.breakdown } : {}),
      },
    };
    await booking.save();

    // Transition to completed via the state machine (validates confirmed → completed,
    // handles calendar sync).
    const updated = await this.bookingService.updateBookingStatus(
      bookingId,
      vendorId,
      BookingStatus.COMPLETED,
    );

    // TODO(stub): when additionalAmountDue > 0, request the extra payment from the customer
    // — create a pending PaymentTransaction for the delta and notify them (or, for a fixed
    // price set below the snapshot, trigger a partial refund). Not implemented yet.

    return {
      booking: updated,
      priceSnapshot: booking.priceSnapshot,
      finalPrice,
      additionalAmountDue,
      recalculated,
    };
  }
}
