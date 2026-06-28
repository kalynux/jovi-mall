/**
 * Unpaid-order auto-cancel sweep configuration.
 *
 * Central, env-overridable knobs for the daily worker that cancels orders left
 * unpaid past each vendor's configured window. Mirrors the module-config pattern
 * used by `src/modules/earnings/config/earnings.config.ts`.
 */

const DAY = 86_400_000;

/** Parse a non-negative integer env var, falling back to `fallback`. */
function intEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

export const UNPAID_ORDER_CANCEL_CONFIG = {
  /** Master switch — set to false to disable the sweep entirely. */
  ENABLED: boolEnv('UNPAID_ORDER_CANCEL_ENABLED', true),

  /** When true, log what would be cancelled without mutating anything. */
  DRY_RUN: boolEnv('UNPAID_ORDER_CANCEL_DRY_RUN', false),

  /** Cron expression for the daily sweep (default 05:00 server time). */
  CRON: process.env.UNPAID_ORDER_CANCEL_CRON || '0 5 * * *',

  /** Max orders processed per sweep (back-pressure). */
  BATCH_SIZE: intEnv('UNPAID_ORDER_CANCEL_BATCH_SIZE', 200),
} as const;

/** A `Date` `days` in the past relative to `now`. */
export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY);
}
