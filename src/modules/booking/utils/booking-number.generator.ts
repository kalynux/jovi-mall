import { nextSequenceValue } from '../../../core/database/sequence.model';

/**
 * Booking Number Generator
 *
 * Every booking is stamped with a human-readable number the moment it is
 * created. It is never typed in and never editable — it is the booking's handle:
 * what the vendor's notification names, what a customer quotes on the phone, and
 * what support searches for.
 *
 * Format — `BKG-YYYY-NNNNNN`, e.g. `BKG-2026-000123`:
 *
 *   BKG      what kind of thing this is
 *   YYYY     the UTC calendar year it was created in — UTC because the platform
 *            spans time zones and a number whose year depends on who reads it is
 *            worse than one that is always the same number. Same reason the rest
 *            of the model stores UTC dates, and the same choice the shipment
 *            tracking number makes
 *   NNNNNN   that year's sequence, zero-padded to six
 *
 * Deliberately the same shape as `ORD-2026-000123`
 * (`orders/utils/order-number-generator.ts`), because a vendor reads both on the
 * same screen and they should read as one system.
 *
 * ── What is NOT copied from the order generator ─────────────────────────────
 *
 * The order generator derives its sequence from `countDocuments() + 1`, which is
 * a read-then-write race — two bookings committed in the same instant would both
 * count N, both claim N+1, and the second would lose to the unique index. Here
 * the sequence comes from an atomic `$inc` on a counter document
 * (`core/database/sequence.model.ts`) instead. Same format, no race.
 *
 * ── The sequence is unique, not dense ───────────────────────────────────────
 *
 * The number is drawn BEFORE the booking row is written and outside its
 * transaction, so a booking that then fails burns its number. `BKG-2026-000042`
 * therefore does NOT mean "the 42nd booking of 2026" — do not report it as a
 * count. Uniqueness is what matters and it is guaranteed twice: by the counter,
 * and by the partial unique index on `Booking.bookingNumber`.
 *
 * ── The year rolls over ─────────────────────────────────────────────────────
 *
 * The sequence is keyed per year (`booking:2026`), so the first booking of
 * January is `-000001` again. The year segment is what keeps the whole number
 * unique across the rollover.
 */

/** The sequence key for a year. Scoped so the number means what its format says. */
function sequenceKey(year: number): string {
  return `booking:${year}`;
}

/** Digits in the sequence segment. Six carries a million bookings in a year. */
const SEQUENCE_WIDTH = 6;

/**
 * Shape of a generated booking number. Exported for the tests, and for any
 * caller that needs to tell a generated number from a legacy null (bookings
 * created before generation existed carry `null` — see the model).
 */
export const BOOKING_NUMBER_PATTERN = /^BKG-\d{4}-\d{6,}$/;

/**
 * Assemble a booking number from a year and a sequence value. Pure formatting —
 * uniqueness is the caller's problem. Exported so the tests can assert the
 * format without a database.
 *
 * A sequence past 999999 widens rather than truncating: a wrong-but-unique
 * number beats a duplicate that the unique index would reject at insert time.
 */
export function formatBookingNumber(year: number, sequence: number): string {
  return `BKG-${year}-${String(sequence).padStart(SEQUENCE_WIDTH, '0')}`;
}

export class BookingNumberGenerator {
  /**
   * Draw the next booking number.
   *
   * Call it OUTSIDE the transaction that writes the booking. The counter is a
   * single document, so incrementing it inside a transaction would make every
   * concurrent booking conflict on the same row — an atomic increment turned
   * into a retry storm. Burning a number on a failed booking is the cheaper
   * trade, and the format promises no density.
   *
   * @param now Injectable clock, for the tests. Defaults to the current instant.
   */
  static async generate(now: Date = new Date()): Promise<string> {
    const year = now.getUTCFullYear();
    const sequence = await nextSequenceValue(sequenceKey(year));
    return formatBookingNumber(year, sequence);
  }
}
