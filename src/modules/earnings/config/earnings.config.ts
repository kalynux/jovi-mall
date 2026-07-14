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
   * Defensive fallback fee (minor units) used ONLY when a shipment's agency
   * has no `policies` configured yet — should not occur in practice, since
   * agency onboarding Step 4 (policy setup) is required and only
   * fully-onboarded agencies are selectable by vendors. The real per-shipment
   * fee is computed from the agency's own `policies.pricing`
   * (see EarningsSplitService.computeAgencyDeliveryFees). Defaults to 0 —
   * charge nothing rather than a fabricated number.
   */
  DELIVERY_FLAT_FEE: intEnv('EARNINGS_DELIVERY_FLAT_FEE', 0),

  /** Cron expression for the daily release / auto-confirm sweep. */
  CRON: process.env.EARNINGS_CRON || '0 1 * * *',

  /** Max allocations/orders processed per sweep stage (back-pressure). */
  BATCH_SIZE: intEnv('EARNINGS_BATCH_SIZE', 200),

  /**
   * Minimum `available_balance` a vendor/agency may request a payout for
   * (manual or auto-triggered). Below this, both `POST .../earnings/payout`
   * and the auto-threshold sweep refuse with EARNINGS_PAYOUT_BELOW_MINIMUM.
   */
  MIN_PAYOUT_AMOUNT: intEnv('EARNINGS_MIN_PAYOUT_AMOUNT', 10_000),

  /**
   * `available_balance` level at which the platform automatically opens a
   * payout request on the vendor/agency's behalf (same ticket/notification
   * flow as a manual request), so balances never grow unbounded into money
   * the platform owes. Checked daily by EarningsReleaseWorker. Vendor/agency
   * only — agents have no EarningsAccount today.
   */
  AUTO_PAYOUT_THRESHOLD: intEnv('EARNINGS_AUTO_PAYOUT_THRESHOLD', 2_000_000),
} as const;

/** A `Date` `days` in the future relative to `now`. */
export function daysFromNow(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * DAY);
}

/** A `Date` `days` in the past relative to `now`. */
export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY);
}
