import { Booking } from '../models/booking.model';
import { BookingStatus } from '../types/booking.types';
import { BOOKING_CONFIG } from '../config/booking.config';
import { BookingService } from '../services/booking.service';

/**
 * UnpaidBookingCancelWorker — releases slots held by bookings nobody paid for.
 *
 * WHY: creating a booking and paying for it are two separate calls, and nothing
 * ever connected them. A `confirmed` booking sitting `unpaid` held its slot and
 * blocked the vendor's calendar indefinitely — a customer could reserve every
 * hour of a vendor's week for free and never pay. Physical orders have had an
 * equivalent sweep (`unpaidOrderCancelWorker`) all along; bookings had none.
 *
 * ── What it deliberately does NOT touch ─────────────────────────────────────
 *
 * `pending` bookings. In `manual` mode a booking sits `pending` while it waits on
 * the VENDOR, and the customer cannot reasonably be asked to pay for something not
 * yet accepted. Cancelling those would punish the customer for the vendor's delay.
 *
 * Free bookings (`requiresPayment: false`) are auto-marked paid at creation, so
 * they never match anyway — but the filter states it rather than relying on that.
 */
export class UnpaidBookingCancelWorker {
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private sweeping = false;
  private readonly bookingService = new BookingService();

  start(): void {
    if (!BOOKING_CONFIG.unpaidExpiry.enabled) {
      console.log('[UnpaidBookingCancelWorker] Disabled via config, not starting');
      return;
    }
    if (this.running) return;

    this.running = true;
    const { intervalMs, afterMinutes } = BOOKING_CONFIG.unpaidExpiry;
    console.log(
      `[UnpaidBookingCancelWorker] Starting — cancelling bookings unpaid after ${afterMinutes} min, every ${intervalMs / 1000}s`
    );

    void this.sweep();
    this.interval = setInterval(() => void this.sweep(), intervalMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.running = false;
  }

  /**
   * One pass. Guarded against overlapping runs so a slow pass cannot stack up
   * behind the interval.
   */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;

    try {
      const { afterMinutes, batchSize } = BOOKING_CONFIG.unpaidExpiry;
      const cutoff = new Date(Date.now() - afterMinutes * 60_000);

      const stale = await Booking.find({
        // Confirmed only — see the class docstring on why `pending` is excluded.
        status: BookingStatus.CONFIRMED,
        requiresPayment: true,
        // 'pending' means a gateway call is in flight; leave it to resolve.
        paymentStatus: { $in: ['unpaid', 'failed'] },
        createdAt: { $lte: cutoff },
        deletedAt: null,
      })
        .limit(batchSize)
        .select('_id vendorId');

      if (stale.length === 0) return 0;

      let cancelled = 0;
      for (const booking of stale) {
        try {
          // Route through the service so the calendar event is removed and
          // `booking.cancelled` is emitted — the same treatment a manual vendor
          // cancellation gets. There is nothing to refund by definition.
          await this.bookingService.cancelVendorBooking(
            booking._id.toString(),
            booking.vendorId.toString(),
            'Automatically cancelled — payment was not completed in time',
            // Attributed to the system, not the vendor: the customer's
            // notification names who cancelled, and blaming the vendor for a
            // sweep they did not run would be a lie.
            'system'
          );
          cancelled++;
        } catch (error) {
          console.error(
            `[UnpaidBookingCancelWorker] Failed to cancel booking ${booking._id}:`,
            error
          );
        }
      }

      console.log(
        `[UnpaidBookingCancelWorker] Swept ${stale.length} stale booking(s), cancelled ${cancelled}`
      );
      return cancelled;
    } catch (error) {
      console.error('[UnpaidBookingCancelWorker] Sweep failed:', error);
      return 0;
    } finally {
      this.sweeping = false;
    }
  }
}

export const unpaidBookingCancelWorker = new UnpaidBookingCancelWorker();
