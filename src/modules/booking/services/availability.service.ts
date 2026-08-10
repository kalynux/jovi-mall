import { AvailabilityRule } from '../models/availability-rule.model';
import { ExternalCalendarBlock } from '../models/external-calendar-block.model';
import { TimeWindow } from '../types/booking.types';
import { CalendarClientFactory } from '../../integrations/calendar/calendar-client.factory';
import { BusySlot } from '../../integrations/calendar/interfaces/calendar-client.interface';
import { isCalendarNotConnected } from '../utils/calendar-error.util';
import { VendorModel } from '../../vendors/vendor.model';
import { BOOKING_CONFIG } from '../config/booking.config';
import {
  AvailabilityRuleLike,
  buildTheoreticalWindows,
  subtractBusyWindows,
  unionWindows,
  windowsEqual,
} from '../utils/availability-windows.util';

export interface GetAvailabilityOptions {
  /**
   * Windows the product's OWN bookings occupy. Excluded from calendar-derived
   * busy time so a shared capacity event doesn't subtract a slot that is still
   * partially free, and so a booking is never counted twice.
   */
  ownBookedWindows?: TimeWindow[];
  /**
   * Windows that are genuinely unavailable because the product's own bookings
   * have filled them. Subtracted as busy time. This — not Google Calendar — is
   * the authority on the product's own occupancy.
   */
  fullBookedWindows?: TimeWindow[];
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
}

export class AvailabilityService {
  /**
   * Gets the free time windows for a product within a date range.
   *
   * Busy time is the union of three sources, and the ordering of authority
   * matters:
   *
   * 1. **The product's own bookings** (`fullBookedWindows`, passed in) — the
   *    authority on its own occupancy. Previously availability read occupancy
   *    only from Google Calendar, which meant a `manual` booking (which writes no
   *    calendar event until the vendor approves it) never blocked its own slot,
   *    and the same hour could be sold without limit.
   * 2. **Persisted external calendar blocks** — the vendor's other commitments,
   *    cached by `InboundCalendarSyncWorker`.
   * 3. **A live calendar query** — the same commitments, read fresh.
   *
   * 2 and 3 are UNIONED rather than treated as either/or. Subtracting the same
   * interval twice is idempotent, so a union can only ever over-block (a deleted
   * external event may linger until the next sync, which self-heals) and never
   * under-block. It also means a failed live call degrades to cached data instead
   * of silently reporting everything free.
   *
   * Wall-clock rule times are resolved in the rule's own timezone, falling back
   * to the vendor's. Never the server's clock.
   */
  async getAvailability(
    productId: string,
    vendorId: string,
    fromDate: Date,
    toDate: Date,
    options: GetAvailabilityOptions = {}
  ): Promise<TimeWindow[]> {
    const {
      ownBookedWindows = [],
      fullBookedWindows = [],
      bufferBeforeMinutes = 0,
      bufferAfterMinutes = 0,
    } = options;

    // Step 1: load the vendor's active rules for this product.
    const rules = await AvailabilityRule.find({
      productId,
      vendorId,
      isActive: true,
      deletedAt: null,
    });

    if (rules.length === 0) {
      return [];
    }

    // Step 2: expand the rules into concrete windows, in the correct timezone.
    const fallbackTimezone = await this.resolveVendorTimezone(vendorId);
    const theoreticalWindows = buildTheoreticalWindows(
      rules as unknown as AvailabilityRuleLike[],
      fromDate,
      toDate,
      fallbackTimezone
    );

    if (theoreticalWindows.length === 0) {
      return [];
    }

    // Step 3: collect the vendor's other commitments from both calendar sources.
    const externalBusy = await this.collectExternalBusy(vendorId, fromDate, toDate);

    // The product's own bookings are accounted for by `fullBookedWindows`, so
    // drop their calendar events to avoid double-counting a partially-filled
    // capacity slot out of existence.
    //
    // NOTE: a vendor's personal event landing on exactly the same interval as one
    // of this product's booked slots is also dropped here. Rare, and the booking
    // itself already blocks that interval.
    const filteredExternalBusy = ownBookedWindows.length === 0
      ? externalBusy
      : externalBusy.filter(
          (busy) => !ownBookedWindows.some((own) => windowsEqual(own, busy))
        );

    const busy = unionWindows([...filteredExternalBusy, ...fullBookedWindows]);

    // Step 4: subtract busy time, padding each busy interval by the variant's buffers.
    return subtractBusyWindows(
      theoreticalWindows,
      busy,
      bufferBeforeMinutes,
      bufferAfterMinutes
    );
  }

  /**
   * The zone used for any rule that carries none. The vendor's `timezone` is the
   * platform's source of truth for a vendor's wall clock (required on the model,
   * defaulting to `Africa/Douala`).
   */
  private async resolveVendorTimezone(vendorId: string): Promise<string> {
    const vendor = await VendorModel.findById(vendorId).select('timezone').lean();
    return vendor?.timezone || BOOKING_CONFIG.defaultTimezone;
  }

  /**
   * The union of persisted external blocks and a live calendar query.
   *
   * A missing calendar connection is not an error — the vendor's own bookings
   * still block correctly (see the class docstring), so availability degrades to
   * "rules minus own bookings" rather than failing the request.
   */
  private async collectExternalBusy(
    vendorId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<TimeWindow[]> {
    const busy: TimeWindow[] = [];

    const externalBlocks = await ExternalCalendarBlock.find({
      vendorId,
      isActive: true,
      endTime: { $gte: fromDate },
      startTime: { $lte: toDate },
    });

    for (const block of externalBlocks) {
      busy.push({ start: block.startTime, end: block.endTime });
    }

    try {
      const calendarClient = await CalendarClientFactory.forVendor(vendorId);
      const liveBusy: BusySlot[] = await calendarClient.getBusySlots(fromDate, toDate);
      for (const slot of liveBusy) {
        busy.push({ start: slot.start, end: slot.end });
      }
    } catch (error) {
      if (isCalendarNotConnected(error)) {
        console.warn(
          `[AvailabilityService] Vendor ${vendorId} has no calendar connected; using rules + own bookings only.`
        );
      } else {
        // A transient calendar failure must not fail availability outright when we
        // still hold cached blocks — but with nothing cached, reporting every hour
        // free would oversell the vendor. Rethrow only in that case.
        console.error('[AvailabilityService] Live calendar query failed:', error);
        if (externalBlocks.length === 0) throw error;
      }
    }

    return busy;
  }
}
