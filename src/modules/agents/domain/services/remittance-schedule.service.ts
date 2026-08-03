import { RemittanceCadence } from '../../models/agent-agency-membership.model';

/**
 * When cash collected under a contract becomes LATE.
 *
 * `remittance_terms` (cadence + grace_hours) was stored, validated, exposed on
 * the DTO and read by nothing: the COD late-deposit sweep used a platform-wide
 * `DEPOSIT_DEADLINE_DAYS` of 2 for every contract regardless. A negotiated
 * cadence that changes no behaviour is a term the parties only think they
 * agreed. This is the function that makes it real.
 *
 * ── Two policy decisions, stated here because nothing else states them ───────
 *
 * **Everything is UTC, not the agent's local time.** The agent carries a
 * `timezone`; the contract does not. Using the agent's would make one agent's
 * two contracts disagree about when "today" ended, for a sweep that runs on a
 * single UTC cron — and would silently move a deadline whenever an agent edited
 * their profile. A daily cadence therefore means "by 00:00 UTC", plus grace.
 *
 * **`on_demand` means there is NO deadline.** It returns null, and the sweep
 * skips the contract entirely: cash under an on-demand contract is never late,
 * because nothing was ever due. That disables the agency's own late-deposit
 * protection for that agent — their choice to make, and one the DTO surfaces so
 * it can be made knowingly.
 *
 * Pure, and takes `since` rather than reading the clock, which is what lets the
 * DB-free test harness cover every branch.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Midnight UTC on the calendar day containing `at`. */
function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * The deadline for settling cash held since `since`, or null if none exists.
 *
 * @param cadence     how often this contract settles
 * @param dayOfWeek   0=Sunday … 6=Saturday. Used by weekly/biweekly only.
 * @param dayOfMonth  1–28. Used by monthly only.
 * @param graceHours  added to every computed boundary
 * @param since       when the cash was collected — the only clock input
 */
export function nextRemittanceDueAt(
  cadence: RemittanceCadence,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  graceHours: number,
  since: Date
): Date | null {
  const grace = Math.max(0, graceHours) * HOUR_MS;
  const sinceMs = since.getTime();

  switch (cadence) {
    // No schedule, so nothing is ever overdue. See the header.
    case 'on_demand':
      return null;

    // Due as soon as it is collected; only the grace period protects the agent.
    case 'per_delivery':
      return new Date(sinceMs + grace);

    case 'daily': {
      // The next midnight STRICTLY after `since` — cash collected at 00:00 sharp
      // is due at the end of that day, not instantly.
      const next = startOfUtcDay(since).getTime() + DAY_MS;
      return new Date(next + grace);
    }

    case 'weekly':
    case 'biweekly': {
      const stride = cadence === 'weekly' ? 7 : 14;
      if (dayOfWeek === null) {
        // No settlement day agreed: fall back to a rolling window from
        // collection, which is the same promise without a fixed calendar date.
        return new Date(sinceMs + stride * DAY_MS + grace);
      }
      const start = startOfUtcDay(since);
      // Days until the next occurrence; 0 would mean "today", but cash collected
      // today is not due today, so an exact hit rolls forward a full stride.
      const delta = (dayOfWeek - start.getUTCDay() + 7) % 7 || stride;
      return new Date(start.getTime() + delta * DAY_MS + grace);
    }

    case 'monthly': {
      if (dayOfMonth === null) {
        return new Date(sinceMs + 30 * DAY_MS + grace);
      }
      // Bounded to 28 by the schema, so this date exists in every month and
      // needs no short-month clamping.
      const y = since.getUTCFullYear();
      const m = since.getUTCMonth();
      let due = Date.UTC(y, m, dayOfMonth);
      // On or before `since` ⇒ this month's date has passed; take next month's.
      if (due <= startOfUtcDay(since).getTime()) due = Date.UTC(y, m + 1, dayOfMonth);
      return new Date(due + grace);
    }
  }
}

/**
 * Is cash held since `since` overdue as of `now`?
 *
 * `null` from `nextRemittanceDueAt` (i.e. `on_demand`) is never overdue — the
 * one place that distinction must not be flattened to a boolean by the caller.
 */
export function isRemittanceOverdue(
  cadence: RemittanceCadence,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  graceHours: number,
  since: Date,
  now: Date
): boolean {
  const due = nextRemittanceDueAt(cadence, dayOfWeek, dayOfMonth, graceHours, since);
  return due !== null && now.getTime() > due.getTime();
}
