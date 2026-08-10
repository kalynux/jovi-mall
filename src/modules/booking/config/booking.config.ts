/**
 * Booking domain configuration.
 *
 * Every assumption the booking service makes about time lives here rather than
 * inline, so a deployment can move it without a code change — and so the
 * assumptions are enumerable in one place.
 */
export const BOOKING_CONFIG = {
  /**
   * Fallback wall-clock zone for an availability rule whose vendor has none.
   *
   * The real source of truth is `Vendor.timezone` (required, itself defaulting to
   * `Africa/Douala`); this only covers a vendor row that predates that field.
   * Deliberately NOT the server's zone — that is the bug this replaces.
   */
  defaultTimezone: process.env.BOOKING_DEFAULT_TIMEZONE || 'Africa/Douala',

  /** How long a checkout hold on a slot survives, in seconds. */
  slotHoldTtlSeconds: parseInt(process.env.BOOKING_SLOT_HOLD_TTL_SECONDS || '900', 10),

  /**
   * Unpaid-booking sweep: how long a booking that requires payment may sit
   * unpaid before it is cancelled and its slot released.
   *
   * Without this, a confirmed-but-unpaid booking holds the slot and the vendor's
   * calendar forever. Physical orders already have an equivalent sweep
   * (`unpaidOrderCancelWorker`); bookings had none.
   */
  unpaidExpiry: {
    enabled: process.env.BOOKING_UNPAID_EXPIRY_ENABLED !== 'false',
    /** Grace period before an unpaid booking is cancelled. */
    afterMinutes: parseInt(process.env.BOOKING_UNPAID_EXPIRY_AFTER_MINUTES || '1440', 10), // 24h
    /** How often the sweep runs. */
    intervalMs: parseInt(process.env.BOOKING_UNPAID_EXPIRY_INTERVAL_MS || '900000', 10), // 15 min
    /** Max bookings cancelled per pass, so one sweep cannot stall the loop. */
    batchSize: parseInt(process.env.BOOKING_UNPAID_EXPIRY_BATCH_SIZE || '200', 10),
  },

  /**
   * Pre-appointment reminders.
   *
   * The platform records `no-show` against customers, so it owes them a reminder
   * first. Time-based, hence a worker rather than an event subscription.
   */
  reminder: {
    enabled: process.env.BOOKING_REMINDER_ENABLED !== 'false',
    /**
     * How far ahead of `startAt` to remind, in minutes. 24h by default — long
     * enough to rearrange a day, short enough to still be remembered.
     */
    leadMinutes: parseInt(process.env.BOOKING_REMINDER_LEAD_MINUTES || '1440', 10),
    /**
     * The sweep's own cadence. Each pass covers the window
     * [lead, lead + interval), so the interval IS the granularity: run it every
     * 15 minutes and a reminder lands within 15 minutes of exactly 24h out.
     */
    intervalMs: parseInt(process.env.BOOKING_REMINDER_INTERVAL_MS || '900000', 10), // 15 min
    batchSize: parseInt(process.env.BOOKING_REMINDER_BATCH_SIZE || '500', 10),
  },
} as const;
