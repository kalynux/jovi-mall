import { Slot, TimeWindow } from '../types/booking.types';
import crypto from 'crypto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

export class SlotGeneratorService {
  /**
   * Generates bookable slots from free time windows.
   * @param freeWindows Array of available time windows
   * @param durationMinutes Duration of each slot in minutes
   * @returns Array of slots
   */
  generateSlots(freeWindows: TimeWindow[], durationMinutes: number): Slot[] {
    const slots: Slot[] = [];

    for (const window of freeWindows) {
      const windowStart = window.start.getTime();
      const windowEnd = window.end.getTime();
      const slotDuration = durationMinutes * 60 * 1000; // Convert to milliseconds

      let currentStart = windowStart;

      while (currentStart + slotDuration <= windowEnd) {
        const currentEnd = currentStart + slotDuration;

        const slot: Slot = {
          id: this.generateSlotId(new Date(currentStart), new Date(currentEnd)),
          start: new Date(currentStart),
          end: new Date(currentEnd),
          available: true,
        };

        slots.push(slot);
        currentStart = currentEnd; // No overlap, slots are back-to-back
      }
    }

    return slots;
  }

  /**
   * Generates a deterministic slot ID based on start and end times.
   * Format: slot_{startISO}_{endISO}_hash
   */
  private generateSlotId(start: Date, end: Date): string {
    const data = `${start.toISOString()}_${end.toISOString()}`;
    const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 8);
    return `slot_${start.getTime()}_${end.getTime()}_${hash}`;
  }

  /**
   * Parses a slot ID to extract start and end times.
   */
  parseSlotId(slotId: string): { start: Date; end: Date } {
    const parts = slotId.split('_');
    if (parts.length < 3 || parts[0] !== 'slot') {
      throw createAppError(ERROR_CODES.BOOKING_INVALID_SLOT_ID, 400, 'Invalid slot ID format');
    }

    const startTime = parseInt(parts[1], 10);
    const endTime = parseInt(parts[2], 10);

    if (isNaN(startTime) || isNaN(endTime)) {
      throw createAppError(ERROR_CODES.BOOKING_INVALID_SLOT_ID, 400, 'Invalid slot ID: timestamps are not numbers');
    }

    return {
      start: new Date(startTime),
      end: new Date(endTime),
    };
  }
}
