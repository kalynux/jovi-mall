import { randomUUID } from 'crypto';
import { getRedisClient, WORKER_LOCK_DB } from '../../infra/redis/redis.factory';
import { recordWorkerRun } from '../../modules/system/metrics/metrics';

/**
 * The overlap guard for background sweeps — F-19.
 *
 * ── What was wrong ────────────────────────────────────────────────────────────
 * Nine of the thirteen workers could begin a pass while the previous pass was still running.
 * `ObservableWorker.executing` made that *visible* (Phase 14 deliberately stopped there) but
 * nothing prevented it: `cron.schedule` fired `void this.runSweep()` and a sweep slower than its
 * own cadence simply stacked. Two concurrent passes over the same rows double-process, and two of
 * these move money — `EarningsReleaseWorker` releases matured escrow holds, `CodDepositDeadlineWorker`
 * applies late-deposit flags and trust penalties.
 *
 * ── Two layers, and only one of them can fail ─────────────────────────────────
 *
 *   1. **In-process** — a `Set` of keys held by THIS process. Unconditional, no dependency, and
 *      it is what actually closes the defect on a single-instance deploy, which is every deploy
 *      today. It also covers the case the registry's own docstring flagged: a manual
 *      `POST /dev-tools/workers/:key/run` landing on top of a scheduled tick.
 *   2. **Redis** — `SET <key> <token> NX PX <ttl>` on `WORKER_LOCK_DB`, which is what makes
 *      running more than one instance safe. This is the layer the audit's recommended fix names.
 *
 * **The Redis layer FAILS OPEN, and that is not negotiable.** If it failed closed, a Redis outage
 * would silently stop every sweep in the platform — including the two that move money — and the
 * only symptom would be work quietly not happening. Failing open degrades to layer 1, i.e. to
 * exactly the guarantee a single-instance deploy needs anyway. Same reasoning as
 * `api/rate-limit/fail-open-store.ts`: a cache that is down must not become a single point of
 * failure for the thing it was added to protect.
 *
 * ── Why the guard is INSIDE the body, unlike the maintenance guard ────────────
 * `maintenanceBlocksWorkers()` is checked at the tick site so that an operator can deliberately
 * run a worker during a maintenance window (ADR-014 D-4). This guard sits *inside* `runSweep`,
 * where a manual trigger cannot route around it — because the two are different kinds of rule.
 * Maintenance is a policy an operator is entitled to override. Overlap is a correctness
 * constraint, and an operator's intent does not make two concurrent writes to the same earnings
 * row safe.
 *
 * ── Renewal, and why release is a compare-and-delete ──────────────────────────
 * A TTL long enough for the slowest sweep is also long enough to strand the lock after a crash,
 * so the TTL is short and a timer extends it while the sweep is alive. Both the extension and the
 * release are Lua compare-and-swaps on the token: without them, a sweep that overran its TTL
 * would delete a *successor's* lock on the way out and hand a third pass the key.
 *
 * ── What it deliberately is NOT ───────────────────────────────────────────────
 * Not a fencing token — nothing downstream validates one, so handing out a monotonic counter
 * would be ceremony. Not a substitute for idempotent writes: the CAS-guarded paths
 * (`AssignmentSweepWorker`) stay CAS-guarded, because a fail-open lock is a narrowing, not a
 * guarantee.
 */

const KEY_PREFIX = 'worker-lock:';

/** Long enough that renewal is the normal path; short enough that a crash strands little. */
export const DEFAULT_LOCK_TTL_MS = 10 * 60_000;

/** Extend at a third of the TTL, so two consecutive failures still leave a margin. */
const RENEW_DIVISOR = 3;

/**
 * After a Redis failure, stop trying for this long.
 *
 * Without it, `TrackingDispatchWorker` (every 2 seconds) would attempt a fresh connection on every
 * tick while Redis is down — `getRedisClient` only caches a client it managed to connect — and
 * fill the log with one connection error per tick. Failing open is quiet by design.
 */
const REDIS_BACKOFF_MS = 60_000;

/**
 * Hard ceiling on any single Redis call made by this file.
 *
 * ⚠ This is what makes "fails open" true rather than merely intended, and it was found by
 * testing rather than reasoning. A dead Redis host does **not** reject promptly: node-redis
 * retries the initial connect on a backoff, so `getRedisClient` can sit unresolved for minutes.
 * Without a bound, `claimInRedis`'s `catch` never runs — the sweep parks on connect and never
 * starts, and a Redis outage becomes a TOTAL worker outage. That is strictly worse than the
 * overlap this file exists to prevent, and it would look like every sweep silently dying.
 *
 * Two seconds is generous for a `SET` and short enough that a daily sweep loses nothing.
 */
const REDIS_OP_TIMEOUT_MS = 2_000;

/** Resolved instead of thrown, so no call site needs an error code for "Redis was slow". */
const TIMED_OUT = Symbol('worker-lock-redis-timeout');

function withTimeout<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), REDIS_OP_TIMEOUT_MS);
        timer.unref();
    });
    // The loser keeps running. Swallow its settlement so a late rejection is not an unhandled one.
    void work.catch(() => undefined);
    return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

/** Only the holder may extend or delete. See the header. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0`;

/** Keys held by this process. The layer that cannot fail. */
const heldInProcess = new Set<string>();

let redisUnavailableUntil = 0;

/**
 * The cross-instance layer's off switch. On by default; `WORKER_LOCK_REDIS=false` disables it.
 *
 * Read per call rather than at module load, so it is a real operational lever and not a boot
 * constant. Turning it off leaves layer 1 intact — which is the whole guarantee on a
 * single-instance deploy — so this is a safe thing for an operator to reach for if the lock
 * database itself becomes the problem. It is also what lets `test:system` drive the in-process
 * behaviour without a Redis to talk to.
 */
function redisLayerEnabled(): boolean {
    return process.env.WORKER_LOCK_REDIS !== 'false';
}

/** Test seam. Never called in production code. */
export function __resetWorkerLocksForTest(): void {
    heldInProcess.clear();
    redisUnavailableUntil = 0;
}

/** Which sweeps this process believes it is running. Read by the operations surface. */
export function locksHeldInProcess(): string[] {
    return [...heldInProcess].sort();
}

function markRedisDown(context: string, error: unknown): void {
    const wasUp = redisUnavailableUntil === 0;
    redisUnavailableUntil = Date.now() + REDIS_BACKOFF_MS;
    // Logged once per backoff window rather than once per tick — see REDIS_BACKOFF_MS.
    if (wasUp) {
        console.warn(
            `[WorkerLock] Redis unavailable during ${context}; falling back to the in-process `
            + `guard for ${REDIS_BACKOFF_MS / 1000}s. Overlap across INSTANCES is unguarded until `
            + 'it returns.',
            error,
        );
    }
}

interface RedisClaim {
    token: string;
    renewTimer: NodeJS.Timeout;
}

/**
 * Try to claim the key in Redis.
 *
 * Three outcomes, and they are not two: `'held-elsewhere'` means another instance provably owns
 * the sweep and we must skip; `null` means we could not ask, which is the fail-open path and must
 * NOT be confused with the first.
 */
async function claimInRedis(
    key: string,
    ttlMs: number,
): Promise<RedisClaim | null | 'held-elsewhere'> {
    if (!redisLayerEnabled()) return null;
    if (Date.now() < redisUnavailableUntil) return null;

    const token = randomUUID();
    const redisKey = `${KEY_PREFIX}${key}`;

    try {
        const client = await withTimeout(getRedisClient(WORKER_LOCK_DB));
        if (client === TIMED_OUT) {
            markRedisDown('lock acquisition', 'timed out');
            return null;
        }
        const claimed = await withTimeout(client.set(redisKey, token, { NX: true, PX: ttlMs }));
        if (claimed === TIMED_OUT) {
            markRedisDown('lock acquisition', 'timed out');
            return null;
        }
        // Only a definite `null` from Redis means somebody else holds it. A timeout above is a
        // "don't know", and the two must never collapse — treating "don't know" as "held" would
        // fail closed, which is the one thing this layer must not do.
        if (claimed === null) return 'held-elsewhere';

        redisUnavailableUntil = 0;

        const renewTimer = setInterval(() => {
            void (async () => {
                try {
                    const live = await withTimeout(getRedisClient(WORKER_LOCK_DB));
                    if (live === TIMED_OUT) {
                        markRedisDown('lock renewal', 'timed out');
                        return;
                    }
                    await withTimeout(live.eval(RENEW_SCRIPT, {
                        keys: [redisKey],
                        arguments: [token, String(ttlMs)],
                    }));
                } catch (error) {
                    // A failed extension is survivable: the key expires, another instance may
                    // start a pass, and the in-process guard still holds this one to one.
                    markRedisDown('lock renewal', error);
                }
            })();
        }, Math.max(1_000, Math.floor(ttlMs / RENEW_DIVISOR)));

        // Never let a lock renewal keep the event loop — and therefore the process — alive.
        renewTimer.unref();

        return { token, renewTimer };
    } catch (error) {
        markRedisDown('lock acquisition', error);
        return null;
    }
}

async function releaseInRedis(key: string, claim: RedisClaim): Promise<void> {
    clearInterval(claim.renewTimer);
    if (Date.now() < redisUnavailableUntil) return;
    try {
        const client = await withTimeout(getRedisClient(WORKER_LOCK_DB));
        if (client === TIMED_OUT) {
            markRedisDown('lock release', 'timed out');
            return;
        }
        await withTimeout(client.eval(RELEASE_SCRIPT, {
            keys: [`${KEY_PREFIX}${key}`],
            arguments: [claim.token],
        }));
    } catch (error) {
        // The TTL is the backstop. Nothing to do but say so.
        markRedisDown('lock release', error);
    }
}

export interface WorkerLockOptions {
    /** Defaults to `DEFAULT_LOCK_TTL_MS`. Set it near the worker's cadence for fast sweeps. */
    ttlMs?: number;
    /**
     * Labels the skip metric. Defaults to `'scheduled'` — pass `'manual'` from the
     * `POST /dev-tools/workers/:key/run` path so a refused trigger is distinguishable from a
     * refused tick.
     */
    trigger?: 'scheduled' | 'manual';
}

/**
 * Returned instead of the body's value when the lock was not obtained.
 *
 * A sentinel rather than `undefined` or `null`, because several sweeps legitimately return
 * `undefined` and two return `0` — "skipped" and "did nothing" are different facts and the
 * registry renders them differently.
 */
export const SWEEP_SKIPPED = Symbol('worker-sweep-skipped');

/**
 * Run `body` unless this sweep is already running here or on another instance.
 *
 * Returns `SWEEP_SKIPPED` when it did not run. A skip is recorded as
 * `worker_runs_total{outcome="skipped"}` and, deliberately, does NOT advance
 * `worker_last_success_timestamp_seconds` — so a permanently stuck lock still trips the documented
 * staleness alert instead of hiding behind a worker that looks busy.
 */
export async function withWorkerLock<T>(
    key: string,
    body: () => Promise<T>,
    options: WorkerLockOptions = {},
): Promise<T | typeof SWEEP_SKIPPED> {
    const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    const trigger = options.trigger ?? 'scheduled';

    if (heldInProcess.has(key)) {
        recordWorkerRun(key, trigger, 'skipped', 0);
        console.log(`[WorkerLock] "${key}" skipped — the previous pass is still running here`);
        return SWEEP_SKIPPED;
    }
    heldInProcess.add(key);

    let claim: RedisClaim | null = null;
    try {
        const result = await claimInRedis(key, ttlMs);
        if (result === 'held-elsewhere') {
            recordWorkerRun(key, trigger, 'skipped', 0);
            console.log(`[WorkerLock] "${key}" skipped — another instance holds it`);
            return SWEEP_SKIPPED;
        }
        claim = result;

        return await body();
    } finally {
        // Order matters: drop the in-process key LAST, so a Redis release that hangs cannot let
        // the next tick in behind it.
        if (claim) await releaseInRedis(key, claim);
        heldInProcess.delete(key);
    }
}
