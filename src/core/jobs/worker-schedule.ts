/**
 * How a background worker says when it runs — and why it is a value rather than a string.
 *
 * ── The defect this replaces ──────────────────────────────────────────────────
 * `dev-tools/worker-registry.ts` carried a hand-typed `schedule: string` per worker, for the
 * `GET /dev-tools/workers` read. It was **wrong for eight of ten entries**: `plan-expiry`
 * advertised `daily 00:05` against a real `0 3 * * *`, `earnings-release` advertised `hourly`
 * against a daily `0 1 * * *`, `unpaid-order-cancel` advertised `every 10 minutes` against a
 * daily `0 5 * * *`. An operator reading that page was told a sweep had run six hours ago when
 * it had not run at all.
 *
 * The root cause is not carelessness — it is that `schedule` **duplicated a fact that lives
 * somewhere else** (a cron literal in `start()`, or a `*_CONFIG` value read from an env var).
 * Duplicated facts drift. Patching the ten strings would have left the mechanism intact and
 * they would have drifted again on the next cadence change.
 *
 * So the fix is structural: a worker **derives** its schedule from the same value it schedules
 * with, and the registry has nowhere to type a literal. `npm run test:system` asserts that each
 * worker's reported expression is identical to the value the worker itself holds, so retyping a
 * literal into the registry fails the suite rather than misleading an operator.
 *
 * ── Why `schedules` is a list ─────────────────────────────────────────────────
 * `InboundCalendarSyncWorker` holds two intervals with different horizons (near-future and
 * far-future). A list makes that the ordinary case rather than a special one.
 */

export type WorkerSchedule =
  | {
      kind: 'cron';
      /** The expression actually handed to `cron.schedule`. */
      expression: string;
      /** Env var name it came from, or `'hardcoded'`. Tells an operator what they can change. */
      source: string;
    }
  | {
      kind: 'interval';
      /** The milliseconds actually handed to `setInterval`. */
      everyMs: number;
      source: string;
    };

/**
 * Every worker exposes this, so the inventory can be built by iteration rather than by hand.
 *
 * ── Three booleans, because three different things were all called `running` ──
 * Before this, `running` meant three incompatible things in three places: a manual-trigger
 * claim in the registry, "has been started" in the two booking sweeps, and "a pass is in
 * flight" in the dispatcher. `GET /dev-tools/workers` reported the first one, so a scheduled
 * sweep churning away for ten minutes showed `running: false`.
 *
 *   scheduled  a cron task or timer object exists — `start()` was called and `stop()` was not
 *   executing  a pass is in flight RIGHT NOW, whoever started it
 *
 * (The third, `manualClaim`, belongs to the registry rather than the worker — it is a property
 * of the trigger endpoint, not of the job.)
 *
 * ── `executing` is still an OBSERVATION, and it is no longer the only thing ────
 * This interface made overlap *visible* and deliberately did not prevent it; the resulting defect
 * was **F-19**, and nine of the thirteen workers turned out to be exposed rather than the seven
 * the note here named (`analytics-aggregation` and both `inbound-calendar-sync` loops had the same
 * shape). Overlap is now prevented by `core/jobs/worker-lock.ts`, which every worker's entry point
 * goes through.
 *
 * `executing` keeps its meaning exactly: it answers "is a pass in flight", not "would a pass be
 * allowed". Do NOT re-derive one from the other — a worker can be idle here and still refused,
 * because another instance holds the lock, and collapsing the two would make that state
 * unreportable. See `api-doc/admin/system.md`.
 */
export interface ObservableWorker {
  readonly schedules: WorkerSchedule[];
  readonly scheduled: boolean;
  readonly executing: boolean;
  /** False when a config switch turns this worker off entirely — never confuse with "idle". */
  readonly enabled: boolean;
  /**
   * Halt the timer or cron task. Idempotent — a second call on a stopped worker does nothing.
   *
   * ── Why this is on the INTERFACE and not a list somewhere ─────────────────
   * Every worker already had one. What did not exist was anywhere that said so, so
   * "every worker can be stopped" was true by accident, and `lifecycle.ts`'s drain would
   * have had to keep a hand-written list of fourteen — the exact shape of duplicated fact
   * this file's header objects to about `schedule` strings, and the shape that let
   * `AssignmentSweepWorker` go missing from the registry for a whole phase.
   *
   * Declared here, `stopAllWorkers()` is a loop over `WORKER_INVENTORY` and a worker that
   * loses its `stop()` is a compile error rather than a sweep that outlives its process.
   *
   * The return type is a union because `InboundCalendarSyncWorker` awaits an in-flight sync
   * pass before clearing its two intervals; the other thirteen clear a handle synchronously.
   * Callers must `await` regardless — a `void` is trivially awaitable and pretending
   * otherwise would make the one asynchronous stop silently non-blocking.
   */
  stop(): void | Promise<void>;
}

const CRON_FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const;

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Render a schedule for a human — **echoing what it cannot describe.**
 *
 * This handles the subset of cron actually in use here: five fields, each a star, an integer, or
 * a step (star-slash-n). That covers all ten expressions in the codebase. Anything else returns
 * the raw expression verbatim rather than a guess.
 *
 * That last property is the point of the function. The whole defect it exists to prevent was a
 * confident English sentence that did not match the machine-readable truth beside it, so a
 * renderer that invents a description for a pattern it does not understand would recreate the
 * bug in a new place. `describeSchedule` is allowed to return an unrendered cron expression.
 */
export function describeSchedule(schedule: WorkerSchedule): string {
  if (schedule.kind === 'interval') return describeInterval(schedule.everyMs);

  const fields = schedule.expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_NAMES.length) return schedule.expression;

  const [minute, hour, dom, month, dow] = fields;

  const simple = (f: string) => f === '*' || /^\d+$/.test(f) || /^\*\/\d+$/.test(f);
  if (![minute, hour, dom, month, dow].every(simple)) return schedule.expression;

  // Every-n-minutes, at any hour.
  if (/^\*\/\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `every ${minute.slice(2)} minutes`;
  }
  // Hourly at a fixed minute.
  if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `hourly at :${pad(minute)}`;
  }
  // Daily / weekly at a fixed time.
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*') {
    const at = `${pad(hour)}:${pad(minute)}`;
    if (dow === '*') return `daily at ${at}`;
    if (/^\d+$/.test(dow)) {
      const name = DOW_NAMES[Number(dow) % 7];
      return `weekly on ${name} at ${at}`;
    }
  }

  return schedule.expression;
}

function describeInterval(everyMs: number): string {
  if (everyMs % 3_600_000 === 0) return `every ${everyMs / 3_600_000} hour(s)`;
  if (everyMs % 60_000 === 0) return `every ${everyMs / 60_000} minute(s)`;
  if (everyMs % 1_000 === 0) return `every ${everyMs / 1_000} second(s)`;
  return `every ${everyMs}ms`;
}

function pad(value: string): string {
  return value.padStart(2, '0');
}
