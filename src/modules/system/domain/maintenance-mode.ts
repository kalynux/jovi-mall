/**
 * Maintenance mode — the pure half. No Mongo, no Express, no clock of its own.
 *
 * Everything here is a total function of (state, now, method, path), which is what lets
 * `npm run test:system` drive the entire exemption table without a database. The stateful half
 * — reading the singleton, caching it, busting the cache — is `services/maintenance.service.ts`.
 *
 * ── The two decisions that shape this file ────────────────────────────────────
 *
 * **1. Every unknown fails OPEN.** An unrecognised mode, a corrupt document, an unparseable
 * expiry — all resolve to `off`. That is the opposite of the usual instinct, and it is
 * deliberate: the failure mode of failing *closed* here is a platform that is down and whose
 * own operator door may be part of what is down. A maintenance window nobody can exit is worse
 * than a window that ended early, because the second one is visible and fixable and the first
 * one needs a redeploy or a hand-written Mongo update.
 *
 * **2. Expiry is evaluated, never written.** `expires_at < now` reads as `off` here and no
 * write happens — a read path that writes is a read path that fails under load and surprises
 * whoever profiles it. The stored value and the effective one are both reported on
 * `/system/maintenance`, so the difference is visible rather than mysterious.
 */

export const MAINTENANCE_MODES = ['off', 'readonly', 'down'] as const;
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];

export function isMaintenanceMode(value: unknown): value is MaintenanceMode {
  return typeof value === 'string' && (MAINTENANCE_MODES as readonly string[]).includes(value);
}

export interface MaintenanceState {
  mode: MaintenanceMode;
  reason: string | null;
  startedAt: Date | null;
  expiresAt: Date | null;
  /** Whether inbound gateway webhooks are refused too. Default false — see `isExempt`. */
  blockWebhooks: boolean;
  /** Whether scheduled sweeps skip their tick. Defaults to `mode === 'down'`. */
  pauseWorkers: boolean;
  actorId: string | null;
  actorName: string | null;
}

export const MAINTENANCE_OFF: MaintenanceState = Object.freeze({
  mode: 'off',
  reason: null,
  startedAt: null,
  expiresAt: null,
  blockWebhooks: false,
  pauseWorkers: false,
  actorId: null,
  actorName: null,
});

/** The mode in force right now, which is not always the stored one. */
export function effectiveMode(state: MaintenanceState, now: Date): MaintenanceMode {
  if (!isMaintenanceMode(state.mode)) return 'off';
  if (state.mode === 'off') return 'off';
  if (state.expiresAt && state.expiresAt.getTime() <= now.getTime()) return 'off';
  return state.mode;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Prefixes that stay reachable in EVERY mode.
 *
 * Each one is here because blocking it converts a maintenance window into an outage, and in two
 * cases into somebody else's outage. Ordered by how expensive the mistake would be.
 */
const ALWAYS_EXEMPT: ReadonlyArray<{ prefix: string; why: string }> = Object.freeze([
  {
    prefix: '/api/internal/admin',
    // The door the operator uses to turn maintenance OFF. Blocking it is a self-inflicted
    // lockout recoverable only by redeploy or a hand-written Mongo update. The WHOLE prefix,
    // not just the maintenance endpoint — an operator also needs `/system/*` to decide when to
    // exit, and reading the outbox depth is how they know the backlog has drained.
    why: 'the operator door — blocking it locks the exit',
  },
  {
    prefix: '/api/internal/agents',
    // geo-tracker's authorization door, and the one a naive implementation gets wrong. It is a
    // READ-ONLY verdict; nothing about it writes. Block it and geo-tracker cannot answer "may
    // this viewer track this agent", so every live subscription fails authorization and every
    // watcher is dropped — a jovi-mall maintenance window becomes a geo-tracker outage.
    why: 'geo-tracker authorization — read-only, and blocking it drops every live watcher',
  },
  {
    prefix: '/api/tracking',
    why: 'geo-tracker visibility policy — same family, read-only',
  },
  {
    prefix: '/api/health',
    // If readiness 503s during maintenance the orchestrator kills the instances and the window
    // becomes an outage nobody can exit. Draining traffic is a load-balancer action, not a
    // maintenance-mode side effect.
    why: 'a probe must always answer, or the orchestrator restarts the fleet',
  },
]);

/**
 * Gateway webhooks — exempt by DEFAULT, overridable per window.
 *
 * This is a trade, not a rule, and it is worth stating as one:
 *
 *  - "Gateways retry" is *true* for Stripe (3 days, exponential backoff) and *assumed* for
 *    NotchPay and MyCoolPay. Betting money on an assumption about a regional PSP's retry
 *    policy is the bad half of the trade.
 *  - A dropped payment event is not "the order stays unpaid". This service's payment path
 *    grants digital entitlements, opens escrow holds, mints shipments and fires four
 *    notification stacks. A missed success event is a customer who has been charged and has
 *    nothing, reconciled by hand.
 *  - The counter-argument is real: a webhook is a write, and `readonly` exists to stop writes.
 *    The resolution is that webhook writes are narrow and idempotent by construction — they key
 *    off a gateway reference and are already re-entrant, because gateways send duplicates
 *    anyway. They are the one write class safe to leave open in a way that
 *    `POST /customer/orders` is not.
 *  - **Residual risk, stated plainly:** if the window exists *because of* a migration on orders
 *    or payments, an open webhook path writes into the collection being migrated. That is what
 *    `blockWebhooks` is for — the operator running that migration sets it and accepts the retry
 *    queue. A per-incident decision, which is what it actually is, rather than a permanent bet.
 */
const WEBHOOK_PREFIX = '/api/webhooks';

/**
 * Burning a single-use download token is technically a write, and exactly the write that must
 * not be lost mid-download. Exempt in `readonly`; blocked in `down`, which is meant to be short.
 */
const DOWNLOAD_PREFIX = '/api/digital/download';

export interface MaintenanceVerdict {
  allowed: boolean;
  mode: MaintenanceMode;
  /** Why it was allowed — null when the verdict is a refusal. Surfaces in tests and logs. */
  exemption: string | null;
}

/**
 * The whole decision, as one pure function.
 *
 * `path` is the URL path with no query string (`req.path`). `method` is upper-case.
 */
export function evaluateMaintenance(
  state: MaintenanceState,
  now: Date,
  method: string,
  path: string,
): MaintenanceVerdict {
  const mode = effectiveMode(state, now);
  if (mode === 'off') return { allowed: true, mode, exemption: null };

  for (const rule of ALWAYS_EXEMPT) {
    if (isUnder(path, rule.prefix)) {
      return { allowed: true, mode, exemption: rule.why };
    }
  }

  if (isUnder(path, WEBHOOK_PREFIX)) {
    return state.blockWebhooks
      ? { allowed: false, mode, exemption: null }
      : { allowed: true, mode, exemption: 'gateway webhook — idempotent, and a dropped one costs money' };
  }

  if (isUnder(path, DOWNLOAD_PREFIX) && mode === 'readonly') {
    return { allowed: true, mode, exemption: 'a download in flight must not lose its token' };
  }

  if (mode === 'readonly' && SAFE_METHODS.has(method.toUpperCase())) {
    return { allowed: true, mode, exemption: 'read-only window, and this is a read' };
  }

  return { allowed: false, mode, exemption: null };
}

/**
 * Whether a scheduled sweep should skip its tick.
 *
 * `readonly` deliberately does NOT pause workers. A read-only window usually means a schema
 * change on one collection, and the sweeps are the platform's correctness machinery: pausing
 * `tracking-dispatch` means geo-tracker goes on broadcasting a delivered shipment's position,
 * and pausing `unpaid-booking-cancel` means slots stay held for free. Pausing them is worse
 * than letting them run. `down` means nothing touches the data, and a cron sweep firing
 * mid-migration is exactly what `down` exists to stop.
 */
export function blocksWorkers(state: MaintenanceState, now: Date): boolean {
  const mode = effectiveMode(state, now);
  if (mode === 'off') return false;
  return state.pauseWorkers;
}

/**
 * Prefix match on a path SEGMENT boundary.
 *
 * `startsWith` alone would exempt `/api/healthcheck-bypass` along with `/api/health`, and an
 * exemption list that can be extended by naming a route is not an exemption list.
 */
function isUnder(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  return path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}
