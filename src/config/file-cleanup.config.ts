/**
 * File Cleanup & Storage Lifecycle Configuration
 *
 * Central, env-overridable knobs for the storage lifecycle system (see
 * `src/modules/file-cleanup`). Mirrors the module-config pattern used by
 * `src/modules/billing/config/credit.config.ts`.
 *
 * The lifecycle is a two-stage process driven entirely by these values:
 *   Stage A (detach) — product media is detached after `productInactivityDays`
 *     of no paid order; ticket attachments are detached `ticketTerminalGraceDays`
 *     after the ticket reaches a terminal status.
 *   Stage B (delete) — a file with no live references ("lonely") for
 *     `lonelyGraceDays` is permanently deleted.
 *
 * Everything is configurable so thresholds can be tuned per-environment without a
 * code change, and `dryRun` lets the sweep run in log-only mode (default ON) until
 * an operator is confident in what it would remove.
 */

const DAY = 86_400_000;

/** Parse a positive integer env var, falling back to `fallback`. */
function intEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Parse a boolean env var. `true`/`1` → true; `false`/`0` → false; else fallback. */
function boolEnv(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

/** Parse a comma-separated list env var into a trimmed, non-empty string array. */
function listEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

/** Parse a comma-separated list of percentages into a sorted ascending number array. */
function percentListEnv(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
  return parsed.length > 0 ? parsed.sort((a, b) => a - b) : fallback;
}

export interface FileCleanupConfig {
  /** Master switch. When false the worker never schedules and `runSweep` is a no-op. */
  enabled: boolean;
  /** Log-only mode: compute and audit what WOULD change, but never detach/delete. */
  dryRun: boolean;
  /** Cron expression for the daily sweep. */
  cron: string;
  /** Max entities/files processed per stage per sweep (back-pressure). */
  batchSize: number;

  // ── Stage A: detach ───────────────────────────────────────────────────────
  /** Days of no paid order after which a product's media files are detached. */
  productInactivityDays: number;
  /** Days after a ticket reaches a terminal status before its attachments are detached. */
  ticketTerminalGraceDays: number;
  /** order `payment_status` values that count as activity (reset the inactivity clock). */
  activeOrderStatuses: string[];
  /** Ticket statuses considered terminal (eligible for attachment cleanup). */
  terminalTicketStatuses: string[];

  // ── Stage B: delete ───────────────────────────────────────────────────────
  /** Days a file may stay lonely (zero live references) before permanent deletion. */
  lonelyGraceDays: number;
  /** Never detach/delete a file backing a live customer download entitlement. */
  protectDigitalEntitlements: boolean;

  // ── Per-stage toggles ─────────────────────────────────────────────────────
  stages: {
    productDetach: boolean;
    ticketDetach: boolean;
    lonelyDelete: boolean;
    storageAlert: boolean;
  };

  // ── Storage alerts ────────────────────────────────────────────────────────
  /** Usage-percentage thresholds (ascending) at which a vendor is alerted. */
  alertThresholds: number[];
  /** Fallback per-vendor storage cap (bytes) when no plan limit is resolvable. */
  defaultStorageLimitBytes: number;
}

/**
 * Build the cleanup config from environment variables, with safe production
 * defaults. Read once at startup by the worker; pass the result down to services
 * so a single config object drives the whole sweep.
 */
export function loadFileCleanupConfig(): FileCleanupConfig {
  return {
    enabled: boolEnv('FILE_CLEANUP_ENABLED', true),
    // Safe-by-default: first deploys observe before deleting. Flip to false to act.
    dryRun: boolEnv('FILE_CLEANUP_DRY_RUN', true),
    cron: process.env.FILE_CLEANUP_CRON || '0 4 * * *',
    batchSize: intEnv('FILE_CLEANUP_BATCH_SIZE', 200),

    productInactivityDays: intEnv('FILE_CLEANUP_PRODUCT_DAYS', 45),
    ticketTerminalGraceDays: intEnv('FILE_CLEANUP_TICKET_DAYS', 15),
    activeOrderStatuses: listEnv('FILE_CLEANUP_ORDER_STATUSES', ['paid']),
    terminalTicketStatuses: listEnv('FILE_CLEANUP_TICKET_STATUSES', ['resolved', 'closed']),

    lonelyGraceDays: intEnv('FILE_CLEANUP_LONELY_DAYS', 15),
    protectDigitalEntitlements: boolEnv('FILE_CLEANUP_PROTECT_ENTITLEMENTS', true),

    stages: {
      productDetach: boolEnv('FILE_CLEANUP_STAGE_DETACH_ENABLED', true),
      ticketDetach: boolEnv('FILE_CLEANUP_STAGE_TICKET_ENABLED', true),
      lonelyDelete: boolEnv('FILE_CLEANUP_STAGE_DELETE_ENABLED', true),
      storageAlert: boolEnv('FILE_CLEANUP_STAGE_ALERT_ENABLED', true),
    },

    alertThresholds: percentListEnv('FILE_CLEANUP_ALERT_THRESHOLDS', [80, 90, 100]),
    defaultStorageLimitBytes: intEnv('FILE_CLEANUP_DEFAULT_STORAGE_BYTES', 5 * 1024 * 1024 * 1024),
  };
}

/** Convert a day count to a cutoff `Date` in the past relative to `now`. */
export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY);
}
