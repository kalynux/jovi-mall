/**
 * Every assumption the system-operations surface depends on, as a value.
 *
 * Same shape and same rule as `modules/agents/config/agent.config.ts`: read through a frozen
 * object built at import time, never a literal in a rule and never a bare `process.env` read at
 * a call site.
 */

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function listEnv(key: string): string[] {
  const raw = process.env[key];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const SYSTEM_CONFIG = Object.freeze({
  /**
   * Per-dependency probe budget. Every probe runs under `Promise.allSettled` with this timeout,
   * so one hung dependency degrades its own row rather than hanging the whole endpoint.
   */
  HEALTH_PROBE_TIMEOUT_MS: intEnv('HEALTH_PROBE_TIMEOUT_MS', 1500),

  /**
   * Whether `/api/health/ready` requires Redis.
   *
   * Default **false**, and that is the important half. Redis connects lazily and never at boot,
   * so a required-Redis readiness probe would *provision* a connection to DB 0 — which nothing
   * in this codebase uses — on every probe interval. It would also fail the whole instance for a
   * partial capability loss: with Redis down this process still serves catalogue, orders,
   * payments and shipments. An operator who wants hard coupling can have it; the default does
   * not silently create a connection.
   */
  HEALTH_READY_REQUIRE_REDIS: boolEnv('HEALTH_READY_REQUIRE_REDIS', false),

  /** Budget for an on-demand integration probe (`?probe=smtp`). */
  INTEGRATION_PROBE_TIMEOUT_MS: intEnv('SYSTEM_INTEGRATION_PROBE_TIMEOUT_MS', 3000),

  /**
   * How long an instance may serve a cached maintenance verdict before re-reading Mongo.
   *
   * This is the cross-instance convergence bound, and it is stated on the wire in the mutation
   * response rather than left for an operator to discover — the same thing wi-admin's feature
   * flags already do.
   */
  MAINTENANCE_CACHE_TTL_MS: intEnv('MAINTENANCE_CACHE_TTL_MS', 5000),

  /** Cache-flush ceilings. Both bound the SCAN loop; whichever trips first wins. */
  CACHE_FLUSH_MAX_KEYS: intEnv('CACHE_FLUSH_MAX_KEYS', 1000),
  CACHE_FLUSH_BUDGET_MS: intEnv('CACHE_FLUSH_BUDGET_MS', 5000),

  /**
   * Ceiling for the read-only key inspector (Phase 15). Lower than the flush's, deliberately:
   * a listing renders into a dashboard and 500 rows is already more than anyone reads, whereas
   * a flush is trying to clear a keyspace.
   */
  CACHE_INSPECT_MAX_KEYS: intEnv('CACHE_INSPECT_MAX_KEYS', 500),

  /**
   * Wall-clock budget for the database inspector (Phase 15).
   *
   * 182 collections × 2 commands is real work on a primary. The sweep stops at this bound and
   * reports which collections it never reached, rather than running unbounded because a caller
   * asked for everything.
   */
  DB_INSPECT_BUDGET_MS: intEnv('DB_INSPECT_BUDGET_MS', 5000),

  /**
   * `/metrics` exposure. Enabled by default for parity with geo-tracker
   * (`METRICS_ENABLED`, also default true) — but see `metrics.routes.ts`: in production a
   * missing `METRICS_SCRAPE_TOKEN` refuses to serve rather than serving openly, because unlike
   * geo-tracker this service is internet-facing.
   */
  METRICS_ENABLED: boolEnv('METRICS_ENABLED', true),
  METRICS_SCRAPE_TOKEN: process.env.METRICS_SCRAPE_TOKEN ?? '',
  METRICS_ALLOWED_IPS: listEnv('METRICS_ALLOWED_IPS'),

  /** How long a scraped outbox-depth aggregation may be reused. See `metrics.ts`. */
  METRICS_COLLECT_CACHE_MS: intEnv('METRICS_COLLECT_CACHE_MS', 10_000),
  METRICS_COLLECT_TIMEOUT_MS: intEnv('METRICS_COLLECT_TIMEOUT_MS', 2000),
});
