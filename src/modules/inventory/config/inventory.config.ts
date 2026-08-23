function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}

/**
 * The agency-inventory schedules (Phase 6 · Step 14).
 *
 * Both workers derive their `WorkerSchedule` from the values here — never from a literal
 * typed into the registry, which `test:system` compares against the expression the worker
 * actually holds.
 */
export const INVENTORY_CONFIG = Object.freeze({
  /**
   * How often the stored-SKU roster is rebuilt from the catalogue.
   *
   * ⚠ **This used to be a debounced call on the READ path** (`reconcileIfStale`, 60 s), and
   * that was right while rows were pure configuration: a stale roster cost nothing, and an
   * agency that had just connected a vendor saw their SKUs immediately instead of at 03:00.
   *
   * Counted stock changes the calculus in both directions. The pass now also corrects drift
   * between a row's counters and its movement ledger, which is not work to do inside a
   * customer-facing GET; and a reconcile that runs on somebody's page load is one that never
   * runs for an agency nobody is looking at. Fifteen minutes rather than nightly because the
   * roster is what an agency records intake against — a SKU that will not appear for hours is
   * a SKU whose delivery cannot be booked in.
   */
  // Read directly rather than through a helper: `test:env`'s census recognises a literal
  // read of the variable by name and a fixed set of helper names, and a string one it cannot
  // see is a variable that silently escapes the .env.example contract. Same shape as
  // AGENT_TRUST_RECOMPUTE_CRON.
  RECONCILE_CRON: process.env.AGENCY_INVENTORY_RECONCILE_CRON || '*/15 * * * *',
  RECONCILE_ENABLED: boolEnv('AGENCY_INVENTORY_RECONCILE_ENABLED', true),

  /**
   * When the previous month's storage invoices are issued.
   *
   * 02:00 on the 1st: after midnight so the month it bills is closed, and early enough that
   * an agency opening its screen on the 1st finds the statement already there. The generator
   * is idempotent on `(agency, vendor, period)`, so a re-run — a restart, a manual trigger,
   * two instances — issues nothing twice.
   */
  STORAGE_INVOICE_CRON: process.env.AGENCY_STORAGE_INVOICE_CRON || '0 2 1 * *',
  STORAGE_INVOICE_ENABLED: boolEnv('AGENCY_STORAGE_INVOICE_ENABLED', true),
});
