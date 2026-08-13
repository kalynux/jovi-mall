import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
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
export class UnpaidBookingCancelWorker implements ObservableWorker {
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private sweeping = false;

  get schedules(): WorkerSchedule[] {
    return [{
      kind: 'interval',
      everyMs: BOOKING_CONFIG.unpaidExpiry.intervalMs,
      source: 'BOOKING_UNPAID_EXPIRY_INTERVAL_MS',
    }];
  }

  get scheduled(): boolean {
    return this.interval !== null;
  }

  /**
   * `sweeping`, not `running` — and that distinction is the whole point of these getters.
   *
   * In THIS worker `running` means "start() was called"; in `TrackingDispatchWorker` the field
   * with the same name means "a pass is in flight"; in the registry it meant "an operator
   * triggered it manually". One word, three meanings, and `GET /dev-tools/workers` reported the
   * third — so a sweep churning away for ten minutes showed `running: false`.
   */
  get executing(): boolean {
    return this.sweeping;
  }

  get enabled(): boolean {
    return BOOKING_CONFIG.unpaidExpiry.enabled;
  }
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
    this.interval = setInterval(() => {
      if (maintenanceBlocksWorkers()) return;
      void this.sweep();
    }, intervalMs);
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
