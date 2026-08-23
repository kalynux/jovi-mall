/**
 * The month a storage invoice bills, and how it is named.
 *
 * Pure — no I/O, no ambient clock (the instant is a parameter) — so every boundary case is
 * testable without a database and without waiting for a month to turn over.
 *
 * ## UTC, and why that is a decision rather than a default
 *
 * A `period_key` is the idempotency key of the whole generator, so it has to mean the same
 * thing to every instance that computes it. The platform runs agencies in several timezones
 * and its own servers in another; resolving "which month is it" against a local clock would
 * let two instances — or one instance either side of a deploy — disagree about `2026-08` at
 * the boundary, and the unique index would then reject the second as a duplicate of a month
 * it does not think it is billing. UTC is the one answer every process already shares.
 *
 * The cost is a few hours of skew at the very start and end of a month for an agency far
 * from UTC, against a monthly rent figure. That is the right trade, and it is stated in the
 * api-doc rather than hidden.
 */

export interface StoragePeriod {
  /** `YYYY-MM`. */
  key: string;
  start: Date;
  /** Exclusive — the first instant of the following month. */
  end: Date;
}

/** The UTC calendar month containing `instant`. */
export function periodContaining(instant: Date): StoragePeriod {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  return {
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

/**
 * The month before the one containing `instant` — what a run on the 1st is billing.
 *
 * `Date.UTC` normalises an out-of-range month, so January (month 0) correctly rolls back to
 * December of the previous year without a special case.
 */
export function previousPeriod(instant: Date): StoragePeriod {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  return periodContaining(start);
}

/** `2026-08` → its period. Refuses anything else, so a hand-typed key cannot silently mis-bill. */
export function parsePeriodKey(key: string): StoragePeriod | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return periodContaining(new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)));
}
