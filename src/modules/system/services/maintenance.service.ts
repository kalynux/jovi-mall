import { SYSTEM_CONFIG } from '../config/system.config';
import {
    MaintenanceMode,
    MaintenanceState,
    MAINTENANCE_OFF,
    blocksWorkers,
    effectiveMode,
    isMaintenanceMode,
} from '../domain/maintenance-mode';
import { ISystemState, MAINTENANCE_STATE_ID, SystemStateModel } from '../models/system-state.model';

/**
 * The stateful half of maintenance mode: Mongo for truth, a short in-process cache for cost.
 *
 * ── Why there is a cache at all ───────────────────────────────────────────────
 * The middleware runs on every request under `/api/*`. A Mongo read per request to answer a
 * question whose answer is "off" all but a few hours a year is not a trade worth making. So the
 * verdict is cached for `MAINTENANCE_CACHE_TTL_MS` (default 5s), refreshed lazily on the first
 * request after expiry, and busted eagerly on whichever instance served the mutation.
 *
 * The consequence is honest and bounded: another instance may serve up to ~5s of stale verdict.
 * That number is **reported in the mutation response**, exactly as wi-admin's `setFlag` already
 * reports its own flag-cache convergence, rather than left for an operator to discover during
 * an incident.
 *
 * ── The failure direction is the whole design ─────────────────────────────────
 * If the refresh read FAILS, this keeps the last known state. Both alternatives are worse:
 *
 *   default to `off`    a transient Mongo wobble reopens the platform for writes in the middle
 *                       of the migration the window exists to protect.
 *   default to `down`   a transient Mongo wobble takes the whole site offline.
 *
 * Last-known-plus-a-loud-log is the only defensible choice, and on a cold process the last
 * known state is `off` — which is the same fail-open posture the pure layer takes for every
 * other unknown.
 */

let cached: MaintenanceState = MAINTENANCE_OFF;
let cachedAt = 0;
let refreshing: Promise<void> | null = null;

function fromDocument(doc: ISystemState | null): MaintenanceState {
    if (!doc || !isMaintenanceMode(doc.mode)) return MAINTENANCE_OFF;
    return {
        mode: doc.mode,
        reason: doc.reason ?? null,
        startedAt: doc.started_at ?? null,
        expiresAt: doc.expires_at ?? null,
        blockWebhooks: doc.block_webhooks ?? false,
        pauseWorkers: doc.pause_workers ?? false,
        actorId: doc.actor_id ?? null,
        actorName: doc.actor_name ?? null,
    };
}

/**
 * Read Mongo and replace the cache. The only place `cached` is assigned from the database.
 *
 * Concurrent callers share one in-flight read: on a busy instance the TTL expiring would
 * otherwise let every request in that millisecond issue its own query.
 */
async function refresh(): Promise<void> {
    if (refreshing) return refreshing;

    refreshing = (async () => {
        try {
            const doc = await SystemStateModel.findById(MAINTENANCE_STATE_ID).lean<ISystemState | null>();
            cached = fromDocument(doc);
            cachedAt = Date.now();
        } catch (error) {
            // Keep the last known state — see this file's header. Still stamp `cachedAt` so a
            // failing database does not turn into a refresh storm on every request.
            cachedAt = Date.now();
            console.error('[MaintenanceService] Failed to refresh maintenance state; keeping last known', error);
        } finally {
            refreshing = null;
        }
    })();

    return refreshing;
}

/**
 * The synchronous read every hot path uses.
 *
 * Returns the cached verdict immediately and kicks off a background refresh when it is stale.
 * Synchronous on purpose: the middleware and the twelve worker tick sites all need an answer
 * without awaiting, and an `await` at a `setInterval` tick site is how a "quick check" becomes
 * a source of unhandled rejections.
 */
export function currentMaintenance(): MaintenanceState {
    if (Date.now() - cachedAt > SYSTEM_CONFIG.MAINTENANCE_CACHE_TTL_MS) {
        void refresh();
    }
    return cached;
}

/** What a scheduled sweep asks at its tick site. */
export function maintenanceBlocksWorkers(now: Date = new Date()): boolean {
    return blocksWorkers(currentMaintenance(), now);
}

export function currentMaintenanceMode(now: Date = new Date()): MaintenanceMode {
    return effectiveMode(currentMaintenance(), now);
}

/**
 * Load the state once at boot, before the first request is served.
 *
 * Without this an instance starting during a window would serve one full cache window of writes
 * against a platform that is supposed to be closed — the exact thing the window exists to stop,
 * happening precisely when a deploy is rolling instances.
 */
export async function primeMaintenanceState(): Promise<MaintenanceState> {
    await refresh();
    return cached;
}

export interface SetMaintenanceInput {
    mode: MaintenanceMode;
    reason: string | null;
    expiresAt: Date | null;
    blockWebhooks: boolean;
    pauseWorkers: boolean;
    actorId: string | null;
    actorName: string | null;
}

export interface SetMaintenanceResult {
    changed: boolean;
    state: MaintenanceState;
    previousMode: MaintenanceMode;
    /** Worst-case seconds before other instances agree. Stated rather than discovered. */
    convergenceSeconds: number;
}

/** Write the singleton and bust this instance's cache immediately. */
export async function setMaintenance(input: SetMaintenanceInput): Promise<SetMaintenanceResult> {
    const before = await SystemStateModel.findById(MAINTENANCE_STATE_ID).lean<ISystemState | null>();
    const previous = fromDocument(before);
    const previousMode = previous.mode;

    const now = new Date();
    const doc = await SystemStateModel.findByIdAndUpdate(
        MAINTENANCE_STATE_ID,
        {
            $set: {
                mode: input.mode,
                reason: input.mode === 'off' ? null : input.reason,
                block_webhooks: input.mode === 'off' ? false : input.blockWebhooks,
                pause_workers: input.mode === 'off' ? false : input.pauseWorkers,
                // `started_at` marks when THIS window opened, so re-issuing the same mode with a
                // new reason does not restart the clock an operator is timing against.
                started_at: input.mode === 'off' ? null : (previousMode === input.mode ? previous.startedAt ?? now : now),
                expires_at: input.mode === 'off' ? null : input.expiresAt,
                actor_id: input.actorId,
                actor_name: input.actorName,
            },
        },
        { new: true, upsert: true },
    ).lean<ISystemState | null>();

    cached = fromDocument(doc);
    cachedAt = Date.now();

    return {
        changed: previousMode !== input.mode,
        state: cached,
        previousMode,
        convergenceSeconds: Math.ceil(SYSTEM_CONFIG.MAINTENANCE_CACHE_TTL_MS / 1000),
    };
}

/** Test seam — the DB-free suite drives the pure layer, but this keeps state from leaking. */
export function __resetMaintenanceCacheForTests(state: MaintenanceState = MAINTENANCE_OFF): void {
    cached = state;
    cachedAt = Date.now();
}
