/**
 * COD (cash on delivery) configuration.
 *
 * Central, env-overridable knobs for delivery-code verification, agent cash
 * exposure, trust scoring, deposit deadlines and the rolling reserve. Mirrors
 * the module-config pattern of `src/modules/earnings/config/earnings.config.ts`.
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

export const COD_CONFIG = {
  // ── Delivery-code (OTP) verification ────────────────────────────────────────
  /** Wrong-code attempts before the code locks and must be regenerated. */
  OTP_MAX_ATTEMPTS: intEnv('COD_OTP_MAX_ATTEMPTS', 5),
  /** Minimum seconds between code (re)sends for one collection. */
  OTP_RESEND_MIN_SECONDS: intEnv('COD_OTP_RESEND_MIN_SECONDS', 60),

  // ── Agent cash exposure ─────────────────────────────────────────────────────
  /**
   * Default cap on the cash an agent may be exposed to (held + expected from
   * assigned uncollected COD shipments). Agencies can override per agent.
   */
  AGENT_MAX_EXPOSURE_DEFAULT: intEnv('COD_AGENT_MAX_EXPOSURE_DEFAULT', 300_000),

  // ── Trust scoring ───────────────────────────────────────────────────────────
  /** Score at/above which the agent gets their full exposure limit. */
  TRUST_FULL_THRESHOLD: intEnv('COD_TRUST_FULL_THRESHOLD', 80),
  /**
   * Score at/above which the agent still qualifies for COD, but with the
   * reduced exposure multiplier. Below this, COD assignment is blocked.
   */
  TRUST_REDUCED_THRESHOLD: intEnv('COD_TRUST_REDUCED_THRESHOLD', 50),
  /** Exposure multiplier applied between the reduced and full thresholds. */
  TRUST_REDUCED_MULTIPLIER: 0.5,
  TRUST_PENALTY_LATE_DEPOSIT: intEnv('COD_TRUST_PENALTY_LATE_DEPOSIT', 5),
  TRUST_PENALTY_SHORTFALL: intEnv('COD_TRUST_PENALTY_SHORTFALL', 20),

  // ── Deposits & reconciliation ───────────────────────────────────────────────
  /**
   * Days an agent may sit on collected cash before the sweep opens a
   * `late_deposit` discrepancy (and applies the trust penalty).
   */
  DEPOSIT_DEADLINE_DAYS: intEnv('COD_DEPOSIT_DEADLINE_DAYS', 2),
  /** Cron for the daily deposit-deadline sweep (01/02/03/05 are taken). */
  DEPOSIT_SWEEP_CRON: process.env.COD_DEPOSIT_SWEEP_CRON || '0 4 * * *',

  // ── Rolling reserve (agency COD earnings) ───────────────────────────────────
  /** Percent of each released COD agency allocation diverted to reserve. */
  RESERVE_PERCENT: intEnv('COD_RESERVE_PERCENT', 10),
  /** Days a reserve hold matures before it can release (discrepancy-free). */
  RESERVE_DAYS: intEnv('COD_RESERVE_DAYS', 30),

  /** Max documents processed per sweep stage (back-pressure). */
  BATCH_SIZE: intEnv('COD_BATCH_SIZE', 200),
} as const;

/** A `Date` `days` in the future relative to `now`. */
export function daysFromNow(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * DAY);
}

/** A `Date` `days` in the past relative to `now`. */
export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY);
}
