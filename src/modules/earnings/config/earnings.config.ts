/**
 * Earnings (commission, escrow & release) configuration.
 *
 * Central, env-overridable knobs for the earnings ledger. Mirrors the
 * module-config pattern used by `src/config/file-cleanup.config.ts`.
 *
 * Money values are integers in minor currency units (same convention as
 * `order.total_amount`).
 */

const DAY = 86_400_000;

/** Parse a non-negative integer env var, falling back to `fallback`. */
function intEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export const EARNINGS_CONFIG = {
  /** Default currency for newly-created accounts/allocations. */
  DEFAULT_CURRENCY: (process.env.EARNINGS_CURRENCY || 'XAF').toUpperCase(),

  /**
   * Days held AFTER an order/booking is completed before funds move from
   * `pending_balance` to `available_balance`. Per spec: 7 days.
   */
  HOLD_DAYS: intEnv('EARNINGS_HOLD_DAYS', 7),

  /**
   * Days a `delivered`/`fulfilled` order may sit without a customer confirmation
   * before the system auto-confirms it (which then starts the HOLD_DAYS window).
   */
  AUTO_CONFIRM_DAYS: intEnv('EARNINGS_AUTO_CONFIRM_DAYS', 7),

  /**
   * Flat delivery fee deducted from the order pot per distinct delivery agency,
   * in minor units. Placeholder until full agency-policy pricing lands.
   */
  DELIVERY_FLAT_FEE: intEnv('EARNINGS_DELIVERY_FLAT_FEE', 0),

  /** Cron expression for the daily release / auto-confirm sweep. */
  CRON: process.env.EARNINGS_CRON || '0 1 * * *',

  /** Max allocations/orders processed per sweep stage (back-pressure). */
  BATCH_SIZE: intEnv('EARNINGS_BATCH_SIZE', 200),
} as const;

/** A `Date` `days` in the future relative to `now`. */
export function daysFromNow(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * DAY);
}

/** A `Date` `days` in the past relative to `now`. */
export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY);
}
