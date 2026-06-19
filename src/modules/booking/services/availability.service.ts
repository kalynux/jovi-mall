import { AvailabilityRule } from '../models/availability-rule.model';
import { TimeWindow } from '../types/booking.types';
import { CalendarClientFactory } from '../../integrations/calendar/calendar-client.factory';
import { BusySlot } from '../../integrations/calendar/interfaces/calendar-client.interface';
import { CalendarNotConnectedError } from '../../integrations/calendar/errors/calendar.errors';

export class AvailabilityService {
  /**
   * Gets available time windows for a product within a date range.
   * @param productId Product ID
   * @param vendorId Vendor ID (owns the calendar)
   * @param fromDate Start of date range
   * @param toDate End of date range
   * @param excludeWindows Busy windows to ignore (e.g. a capacity product's own slot events)
   * @param bufferBeforeMinutes Padding before each busy slot (from the variant's serviceConfig)
   * @param bufferAfterMinutes Padding after each busy slot (from the variant's serviceConfig)
   * @returns Array of free time windows
   */
  async getAvailability(
    productId: string,
    vendorId: string,
    fromDate: Date,
    toDate: Date,
    excludeWindows: TimeWindow[] = [],
    bufferBeforeMinutes = 0,
    bufferAfterMinutes = 0
  ): Promise<TimeWindow[]> {
    // Step 1: Load availability rules
    const rules = await AvailabilityRule.find({
      productId,
      vendorId,
      isActive: true,
    });

    if (rules.length === 0) {
      return [];
    }

    // Step 2: Generate theoretical availability windows based on rules
    const theoreticalWindows = this.generateTheoreticalWindows(rules, fromDate, toDate);

    // Step 3: Get busy slots - PREFER persisted external blocks to prevent double-counting
    let busySlots: BusySlot[] = [];

    // Load persisted external calendar blocks
    const ExternalCalendarBlock = (await import('../models/external-calendar-block.model')).ExternalCalendarBlock;
    const externalBlocks = await ExternalCalendarBlock.find({
      vendorId,
      isActive: true,
      endTime: { $gte: fromDate },
      startTime: { $lte: toDate },
    });

    if (externalBlocks.length > 0) {
      // Use persisted blocks (already synced, deterministic)
      busySlots = externalBlocks.map(block => ({
        start: block.startTime,
        end: block.endTime,
      }));

      console.log(`[AvailabilityService] Using ${busySlots.length} persisted external calendar blocks for vendor ${vendorId}`);
    } else {
      // Fallback to real-time calendar query if no synced blocks exist
      try {
        const calendarClient = await CalendarClientFactory.forVendor(vendorId);
        busySlots = await calendarClient.getBusySlots(fromDate, toDate);

        console.log(`[AvailabilityService] Fallback to real-time calendar for vendor ${vendorId}: ${busySlots.length} busy slots`);
      } catch (error) {
        if (error instanceof CalendarNotConnectedError) {
          // Log warning but proceed with 0 busy slots
          console.warn(`Vendor ${vendorId} has no calendar connected. Assuming all slots free (subject to rules).`);
        } else {
          throw error;
        }
      }
    }

    // For capacity products, drop busy slots that exactly match the product's own
    // shared capacity events: a partially-booked capacity slot must stay bookable, so
    // its own calendar event must not subtract it from availability. Matched by exact
    // [start,end] equality (capacity events live at the deterministic slot window).
    // NOTE: a vendor personal event coinciding exactly with a slot window would also be
    // excluded here — rare and acceptable.
    const effectiveBusySlots = excludeWindows.length === 0
      ? busySlots
      : busySlots.filter(
          (busy) =>
            !excludeWindows.some(
              (w) => w.start.getTime() === busy.start.getTime() && w.end.getTime() === busy.end.getTime()
            )
        );

    // Step 4: Subtract busy slots + apply buffers (buffers come from the
    // variant's serviceConfig, passed in by the caller).
    const freeWindows = this.subtractBusySlots(
      theoreticalWindows,
      effectiveBusySlots,
      bufferBeforeMinutes,
      bufferAfterMinutes
    );

    return freeWindows;
  }

  /**
   * Generates theoretical availability windows based on rules.
   */
  private generateTheoreticalWindows(
    rules: any[],
    fromDate: Date,
    toDate: Date
  ): TimeWindow[] {
    const windows: TimeWindow[] = [];
    const currentDate = new Date(fromDate);

    while (currentDate <= toDate) {
      const dayOfWeek = currentDate.getDay();

      // Find rules for this day
      const dayRules = rules.filter((r) => r.dayOfWeek === dayOfWeek);

      for (const rule of dayRules) {
        const [startHour, startMin] = rule.startTime.split(':').map(Number);
        const [endHour, endMin] = rule.endTime.split(':').map(Number);

        const start = new Date(currentDate);
        start.setHours(startHour, startMin, 0, 0);

        const end = new Date(currentDate);
        end.setHours(endHour, endMin, 0, 0);

        // Only include if within date range
        if (start >= fromDate && end <= toDate) {
          windows.push({ start, end });
        }
      }

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return windows;
  }

  /**
   * Subtracts busy slots from available windows and applies buffers.
   */
  private subtractBusySlots(
    windows: TimeWindow[],
    busySlots: BusySlot[],
    bufferBeforeMinutes: number,
    bufferAfterMinutes: number
  ): TimeWindow[] {
    const freeWindows: TimeWindow[] = [];

    for (const window of windows) {
      let current: TimeWindow[] = [window];

      // For each busy slot, split the window
      for (const busy of busySlots) {
        const temp: TimeWindow[] = [];

        for (const candidate of current) {
          const result = this.splitWindow(candidate, busy, bufferBeforeMinutes, bufferAfterMinutes);
          temp.push(...result);
        }

        current = temp;
      }

      freeWindows.push(...current);
    }

    return freeWindows;
  }

  /**
   * Splits a time window around a busy slot, applying buffers.
   */
  private splitWindow(
    window: TimeWindow,
    busy: BusySlot,
    bufferBeforeMinutes: number,
    bufferAfterMinutes: number
  ): TimeWindow[] {
    const busyStart = busy.start.getTime();
    const busyEnd = busy.end.getTime();
    const windowStart = window.start.getTime();
    const windowEnd = window.end.getTime();

    const bufferBefore = bufferBeforeMinutes * 60 * 1000;
    const bufferAfter = bufferAfterMinutes * 60 * 1000;

    const busyStartWithBuffer = busyStart - bufferBefore;
    const busyEndWithBuffer = busyEnd + bufferAfter;

    // No overlap
    if (busyEndWithBuffer <= windowStart || busyStartWithBuffer >= windowEnd) {
      return [window];
    }

    // Completely covers window
    if (busyStartWithBuffer <= windowStart && busyEndWithBuffer >= windowEnd) {
      return [];
    }

    const result: TimeWindow[] = [];

    // Before busy slot
    if (windowStart < busyStartWithBuffer) {
      result.push({
        start: new Date(windowStart),
        end: new Date(Math.min(busyStartWithBuffer, windowEnd)),
      });
    }

    // After busy slot
    if (windowEnd > busyEndWithBuffer) {
      result.push({
        start: new Date(Math.max(busyEndWithBuffer, windowStart)),
        end: new Date(windowEnd),
      });
    }

    return result;
  }
}
