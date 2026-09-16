import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { DEFAULT_VARIANT_SIGNATURE } from '../../services/variants/constants';
import { Product } from '../../../repositories/mappers/product.mapper';
import { AvailabilityService } from '../../../../booking/services/availability.service';
import { SlotGeneratorService } from '../../../../booking/services/slot-generator.service';
import { BookingService } from '../../../../booking/services/booking.service';
import { groupBookingService as groupBookingServiceSingleton } from '../../../../booking/services/group-booking.service';
import { IBooking } from '../../../../booking/models/booking.model';
import { Slot } from '../../../../booking/types/booking.types';
import { BookedWindow, fullWindows, spotsRemainingFor } from '../../../../booking/utils/availability-windows.util';
import { BookingPriceResolver, ResolvedPrice } from './BookingPriceResolver';
import { SlotLockFacade } from './SlotLockFacade';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { isPublishableProduct } from '../public-catalog.filter';

export interface BookProductResult {
  booking: IBooking;
  price: ResolvedPrice;
}

/**
 * How far BEFORE the caller's `from` availability is computed, before being cut back to it.
 *
 * ⚠ **This is what makes a slot a fixed thing rather than a function of the question.** The
 * rule windows are clipped to the range they are computed over (`clipWindow`), and slots are
 * laid back-to-back from each window's START. Computed over exactly [from, to], a window already
 * in progress at `from` is re-anchored AT `from` — so asking at 14:37:12 offered 14:37:12–15:37:12,
 * and asking a minute later offered a different set. With the offered set depending on the
 * caller's clock, "is this a slot we offer" had no answer, and the booking path never asked it.
 *
 * Forty-eight hours is longer than any window a weekly rule can produce — an overnight rule ends
 * at most 24 hours after its own start — so every window that can reach [from, to] is computed
 * from its real start. Slots then anchor to the shop's opening time, or to the end of an earlier
 * appointment plus its buffer, exactly as before, and never to the caller.
 */
export const AVAILABILITY_LOOKBEHIND_MS = 48 * 60 * 60 * 1000;

/** A slot the caller named that the service really offers, as instants. */
export interface OfferedSlot {
  start: Date;
  end: Date;
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
    private readonly slotLockFacade: SlotLockFacade = new SlotLockFacade(),
    private readonly groupBookingService = groupBookingServiceSingleton
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

    /**
     * ⚠️ **This route is unauthenticated.**
     *
     * `GET /api/products/:productId/availability` carries no `requireAuth`, unlike its
     * three siblings on the same router (`/slots/:slotId/lock`, `/book`,
     * `/slots/:slotId/unlock`). Combined with `findByIdUnscoped` above and a check on
     * `type` alone, a logged-out caller could read the booking calendar — every busy
     * window, i.e. the vendor's whole appointment book — of a `draft`, `archived` or
     * `suspended` product. A draft is a product its owner has not published; a suspended
     * one is a product an administrator or an agency has taken down.
     *
     * The publishable predicate is the same one the storefront uses, so "bookable" and
     * "visible in the catalogue" cannot drift apart.
     *
     * It answers `CATALOG_BOOKING_PRODUCT_NOT_FOUND` — the same 404 as an id that does not
     * exist — deliberately: a 403 would confirm the product is real, which is exactly the
     * fact a competitor enumerating ids is after.
     */
    if (!isPublishableProduct(product)) {
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

    /**
     * ⚠ **Computed from `computeFrom`, then cut back to [fromDate, toDate] in step 4.** See
     * `AVAILABILITY_LOOKBEHIND_MS`. Bookings, calendar busy time and rule windows must ALL use the
     * widened start: an appointment that ended just before `fromDate` is what anchors the next slot
     * after it, so leaving it out would move the grid as surely as the clipping did.
     */
    const computeFrom = new Date(fromDate.getTime() - AVAILABILITY_LOOKBEHIND_MS);

    // The product's OWN bookings decide its occupancy — for every mode, not just
    // capacity. Reading occupancy from Google Calendar alone meant a `manual`
    // booking (which writes no calendar event until the vendor approves it) never
    // blocked its own slot, so the same hour could be sold without limit.
    const bookedWindows = await this.bookingService.findActiveBookingWindows(
      productId,
      computeFrom,
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
      computeFrom,
      toDate,
      {
        ownBookedWindows,
        fullBookedWindows,
        bufferBeforeMinutes: serviceConfig.bufferBeforeMinutes,
        bufferAfterMinutes: serviceConfig.bufferAfterMinutes,
      }
    );

    // Step 3: Generate bookable slots, from each window's REAL start.
    const generated = this.slotGenerator.generateSlots(
      availableWindows,
      serviceConfig.durationMinutes
    );

    /**
     * Step 4: keep only the slots that lie wholly inside what was asked for.
     *
     * The same membership the clipping produced before — a slot starting at or after `fromDate`
     * and ending at or before `toDate` — with the one difference that matters: a window in
     * progress at `fromDate` now offers the shop's own grid (15:00, 16:00, …) rather than a grid
     * starting at whatever instant the caller happened to ask.
     */
    const slots = generated.filter(
      (slot) => slot.start.getTime() >= fromDate.getTime() && slot.end.getTime() <= toDate.getTime()
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

    /**
     * Step 2: the slot must be one this service really offers — BEFORE anything is priced.
     *
     * ⚠ **The price below is prorated from the interval**, `price / durationMinutes × minutes`,
     * and until 2026-09-16 the interval came straight out of a caller-supplied slot id checked
     * for its FORMAT only. A one-minute slot of a one-hour service was priced, snapshotted and
     * charged at a sixtieth; a slot at 3am, on a closed day, in the past or eight hours long was
     * booked as readily as a real one. `assertOfferedSlot` is what stops that, and
     * `test:booking-slot-offer` pins that no price is resolved before it has run.
     */
    const { start, end } = await this.assertOfferedSlot(productId, slotId);

    // Step 3: Resolve price — only ever from an interval the service offers.
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
    /**
     * ⚠ **A hold is validated exactly as a booking is.** A fabricated slot that could merely be
     * HELD still blocks real customers from that interval for the life of the hold — the
     * "block a shop's whole day" case, fifteen minutes at a time and renewable. Every door that
     * holds a slot reaches this method (the storefront's lock route and the bot's create and
     * reschedule), so checking here closes all of them without opening a route file.
     */
    await this.assertOfferedSlot(productId, slotId);

    const scopeToOwner = await this.isCapacityProduct(productId);
    return this.slotLockFacade.lockSlot(slotId, userId, ttlSeconds, scopeToOwner);
  }

  /**
   * The slot a caller named, as instants — but only if this service really offers it right now.
   *
   * ── WHAT "OFFERS" MEANS, AND WHY IT IS THE AVAILABILITY READ ITSELF ──────────
   * A slot is offered when `getAvailability` would list it: inside the shop's published rules,
   * clear of its other commitments and its buffers, not full, and the exact length the service is
   * sold in. That read already encodes every one of those rules, so this asks it rather than
   * writing a second opinion about any of them. It only became possible to ask once availability
   * stopped depending on the caller's clock — see `AVAILABILITY_LOOKBEHIND_MS`.
   *
   * Asked over exactly [start, end]: with the grid fixed, the only slot that can lie wholly inside
   * that range is one that starts at `start` and ends at `end`, so an exact match is the whole test.
   * A real slot shifted by a minute, shortened, lengthened or moved off the grid finds nothing.
   *
   * ── THE REFUSAL ─────────────────────────────────────────────────────────────
   * Every failure is `BOOKING_SLOT_UNAVAILABLE` 409 — true in each case from where the customer
   * stands, and already handled by every client as "pick another time". A malformed id is still
   * `parseSlotId`'s 400. `details.reason` distinguishes them for whoever reads the log.
   *
   * ⚠ **Also refuses a product the storefront would not show**, because the availability read
   * does: a draft, a suspended or a deleted service answers 404 here as it does to a browser.
   *
   * @param now Injectable for the suites; production passes nothing.
   */
  async assertOfferedSlot(productId: string, slotId: string, now: Date = new Date()): Promise<OfferedSlot> {
    const { start, end } = this.slotGenerator.parseSlotId(slotId);

    const refuse = (reason: 'inverted' | 'not_future' | 'not_offered'): never => {
      throw createAppError(
        ERROR_CODES.BOOKING_SLOT_UNAVAILABLE,
        409,
        'That time is not available. Please choose another slot.',
        { slotId, reason }
      );
    };

    // Cheap structural refusals first: neither needs a read, and an inverted interval would
    // otherwise reach the availability computation as a range that ends before it starts.
    if (end.getTime() <= start.getTime()) refuse('inverted');
    if (start.getTime() <= now.getTime()) refuse('not_future');

    const offered = await this.getAvailability(productId, start, end);
    const match = offered.some(
      (slot) => slot.start.getTime() === start.getTime() && slot.end.getTime() === end.getTime()
    );
    if (!match) refuse('not_offered');

    return { start, end };
  }

  /**
   * Releases a slot hold the caller owns. Mode-aware to match lockSlot's key namespace.
   */
  async unlockSlot(productId: string, slotId: string, userId: string): Promise<boolean> {
    const scopeToOwner = await this.isCapacityProduct(productId);
    return this.slotLockFacade.releaseSlot(slotId, userId, scopeToOwner);
  }

  /**
   * Whether the product's active service variant is in capacity booking mode — i.e.
   * whether a hold on its slots is owner-scoped.
   *
   * Delegates to `GroupBookingService`, which is the single definition of "is this a
   * group service". It used to decide independently here, and `BookingService.reschedule`
   * did not ask at all: three call sites, two answers, and a customer who could not move a
   * class booking (KI-1). One definition is what stops that recurring.
   *
   * The swallow-to-`false` is kept: a product with no usable service variant simply falls
   * back to exclusive locking, and the booking path raises the real error a moment later.
   */
  private async isCapacityProduct(productId: string): Promise<boolean> {
    try {
      return await this.groupBookingService.isGroupService(productId);
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
