import { Booking, IBooking } from '../../../../booking/models/booking.model';
import { BookingService } from '../../../../booking/services/booking.service';
import { BookingStatus } from '../../../../booking/types/booking.types';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { BookingPriceResolver, ResolvedPrice } from './BookingPriceResolver';
import { VendorRepository } from '../../../../vendors/vendor.repository';
import { CustomerModel } from '../../../../customers/customer.model';
import { getCustomerNotificationHandler } from '../../../../notifications/customer-notification-event-consumer';
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
  /** What the customer has actually paid so far (0 unless the booking is `paid`). */
  amountPaid: number;
  additionalAmountDue: number;  // max(0, finalPrice - amountPaid) — payable
  /** max(0, amountPaid - finalPrice) — recorded, never auto-refunded. */
  creditDue: number;
  recalculated?: ResolvedPrice; // present when priced from duration (not fixedPrice)
}

/**
 * CompletionPricingService — settles a service booking's final price when the
 * vendor marks the appointment completed, then transitions it to `completed`.
 *
 * ── The shortfall is now REQUESTED, not silently dropped ────────────────────
 *
 * This used to compute `additionalAmountDue`, write it into `metadata`, return it
 * and stop — no charge, no message, nothing. A vendor whose job ran two hours long
 * saw a number on their screen that meant nothing to anybody else.
 *
 * It now writes a first-class `booking.settlement` and, when a balance is owed,
 * asks the customer for it (`booking.balance.due`). It still does NOT charge
 * automatically, and that is deliberate: the customer agreed to the quoted price,
 * not to whatever the vendor types afterwards. They settle it themselves — online
 * via `POST /api/customer/bookings/:id/pay-balance`, or in cash, which the vendor
 * records with `POST /api/vendor/bookings/:id/settle-balance`.
 *
 * ── The mirror case is recorded, not refunded ──────────────────────────────
 *
 * Settling BELOW what the customer paid produces `creditDue`. By product
 * decision it is surfaced and not auto-refunded — a discount is usually goodwill
 * the vendor means to hand back themselves — but it is no longer invisible.
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

    // What the customer has ACTUALLY paid — not what they were quoted.
    //
    // Comparing against `priceSnapshot` (as this used to) bills an unpaid customer
    // only for the overrun and lets the original price vanish: quote 5,000, never
    // pay, vendor settles at 6,000, and the "balance" came out as 1,000.
    const amountPaid = booking.paymentStatus === 'paid' ? booking.priceSnapshot : 0;
    const additionalAmountDue = Math.max(0, finalPrice - amountPaid);
    const creditDue = Math.max(0, amountPaid - finalPrice);

    booking.settlement = {
      finalPrice,
      pricingMode: input.fixedPrice !== undefined ? 'fixed' : 'duration',
      settledAt: new Date(),
      balanceDue: additionalAmountDue,
      balancePaid: 0,
      creditDue,
    };

    // The breakdown stays in metadata — it is display detail, not money owed.
    booking.metadata = {
      ...(booking.metadata ?? {}),
      completion: {
        finalPrice,
        additionalAmountDue,
        creditDue,
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

    // Tell the customer it is done, and — separately — ask for anything owed.
    // Two messages, because "thanks for visiting" and "you owe us money" are
    // different asks and the second must be able to stand on its own in an inbox.
    await this.bookingService.emitBookingCompletedEvent(updated, finalPrice, additionalAmountDue);

    if (additionalAmountDue > 0) {
      await this.requestBalance(updated, finalPrice, additionalAmountDue);
    }

    return {
      booking: updated,
      priceSnapshot: booking.priceSnapshot,
      finalPrice,
      amountPaid,
      additionalAmountDue,
      creditDue,
      recalculated,
    };
  }

  /**
   * Ask the customer for the outstanding balance.
   *
   * Best-effort: a notification failure must not undo a completed appointment.
   * The balance is already durable on `booking.settlement`, so the money is not
   * lost even if the message is — it shows on the booking and on the vendor's
   * outstanding-balance report either way.
   */
  private async requestBalance(
    booking: IBooking,
    finalPrice: number,
    balanceDue: number
  ): Promise<void> {
    try {
      const [product, vendor] = await Promise.all([
        this.productRepository.findByIdUnscoped(booking.productId.toString()),
        new VendorRepository().findById(booking.vendorId.toString()),
      ]);

      const customer = await CustomerModel.findOne({ user_id: booking.userId }).select('_id');
      if (!customer) return; // Not a customer account — nobody to ask.

      await getCustomerNotificationHandler().notify({
        situation: 'booking.balance.due',
        customerId: customer._id.toString(),
        aggregateType: 'booking',
        aggregateId: booking._id.toString(),
        // Keyed on the amount as well as the booking: a vendor may correct a
        // settlement, and the corrected figure is a new thing to say.
        idempotencyKey: `customer.booking.balance.due:${booking._id}:${balanceDue}`,
        context: {
          bookingId: booking._id.toString(),
          serviceName: product?.title ?? '',
          vendorName: vendor?.display_name ?? '',
          currency: booking.currency,
          finalPriceFormatted: new Intl.NumberFormat('en-US').format(Math.round(finalPrice)),
          balanceFormatted: new Intl.NumberFormat('en-US').format(Math.round(balanceDue)),
          reasonLine:
            booking.settlement?.pricingMode === 'duration'
              ? 'The service ran longer than the time you booked.'
              : '',
        },
      });
    } catch (error) {
      console.error('[CompletionPricingService] Failed to request booking balance:', error);
    }
  }
}
