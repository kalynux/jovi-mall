function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Agent domain configuration.
 *
 * Every assumption the domain's rules depend on is a value here, never a
 * literal in the rule itself — geo-tracker will later supply signals (device
 * location) that jovi-mall cannot observe today, and the switch from
 * "unknown, so allow" to "unknown, so deny" must be a config change rather
 * than a code change. The same principle applies to every bound below.
 */
export const AGENT_CONFIG = Object.freeze({
  // ── COD threshold allocation ──────────────────────────────────────────────
  /**
   * Ceiling / floor on an agent's OWN global COD threshold — the total cash
   * they may hold across every agency combined. The agent sets their own value
   * within these bounds.
   */
  COD_THRESHOLD_MAX: intEnv('AGENT_COD_THRESHOLD_MAX', 5_000_000),
  COD_THRESHOLD_MIN: intEnv('AGENT_COD_THRESHOLD_MIN', 0),

  /**
   * Ceiling / floor on a SINGLE contract's COD threshold. A contract threshold
   * is a sub-allocation of the agent's global threshold, so it is bounded twice:
   * by this absolute cap, and by the agent's remaining headroom.
   */
  CONTRACT_COD_THRESHOLD_MAX: intEnv('AGENCY_AGENT_COD_THRESHOLD_MAX', 1_000_000),
  CONTRACT_COD_THRESHOLD_MIN: intEnv('AGENCY_AGENT_COD_THRESHOLD_MIN', 0),

  // ── Tracking Allow reconciliation (plan step 3.A.3) ───────────────────────
  /**
   * How often `TrackingAllowReconcileWorker` re-pushes outstanding tracking REVOCATIONS to
   * geo-tracker, and how many agents one pass covers.
   *
   * ── This is a BACKSTOP interval, not a delivery latency ────────────────────
   * The real push is transactional and immediate (`AgentTrackingPolicyService
   * .setTrackingAllowed` writes the outbox row in the same transaction as the flag, and the
   * dispatcher drains every 2 s). This sweep exists only for the case where the row committed
   * and delivery then failed for long enough that the dispatcher **parked it as `failed`** —
   * after which nothing replays it. So the number to reason about is not "how fast should a
   * revocation arrive" but "how long may a *stuck* one go uncorrected".
   *
   * 15 minutes is chosen against that: long enough that a healthy system re-pushes almost
   * nothing (the sweep is bounded by how many agents are revoked at all, which is small), short
   * enough that a delivery outage does not leave an agent broadcasting for an hour after an
   * administrator revoked them. Raising it above the dispatcher's own backoff-to-parked window
   * is the mistake to avoid — that is what makes it a backstop rather than a second timer.
   *
   * The batch is a ceiling against a pathological population (a migration that revoked
   * everybody), not a page size: passes are ordered oldest-decision-first, so a larger revoked
   * set is covered across successive passes rather than flooding one.
   */
  TRACKING_ALLOW_RECONCILE_INTERVAL_MS: intEnv('TRACKING_ALLOW_RECONCILE_INTERVAL_MS', 15 * 60 * 1000),
  TRACKING_ALLOW_RECONCILE_BATCH: intEnv('TRACKING_ALLOW_RECONCILE_BATCH', 200),

  // ── Capacity ──────────────────────────────────────────────────────────────
  /**
   * Bounds on an agent's own `capacity.max_active_shipments`. Capacity is a
   * single agent-level cap shared across every agency — unlike COD, it is NOT
   * sub-allocated per contract. An agent full with agency A's work cannot
   * absorb agency B's.
   *
   * The cap is now PLAN-DRIVEN: an agent's active pricing plan sets this value
   * (free tier = 20, see the agent plan seed). `MAX` is the config ceiling for a
   * plan-driven or admin value (raised well above any tier); `DEFAULT` matches
   * the free agent plan cap so a plan-less agent behaves like a free subscriber.
   */
  MAX_ACTIVE_SHIPMENTS_MAX: intEnv('AGENT_MAX_ACTIVE_SHIPMENTS_MAX', 100),
  MAX_ACTIVE_SHIPMENTS_MIN: intEnv('AGENT_MAX_ACTIVE_SHIPMENTS_MIN', 1),
  MAX_ACTIVE_SHIPMENTS_DEFAULT: intEnv('AGENT_MAX_ACTIVE_SHIPMENTS_DEFAULT', 20),

  /** How many ALLOCATING contracts one agent may hold at once. */
  MAX_AGENCY_RELATIONSHIPS: intEnv('AGENT_MAX_AGENCY_RELATIONSHIPS', 5),

  // ── Trust score ───────────────────────────────────────────────────────────
  /**
   * Composite weights. These are business policy, supplied by the product
   * owner — not derived, not guessed. They must sum to 100; the domain asserts
   * this at load rather than silently normalising, because a weight set that
   * doesn't sum to 100 means someone edited one value and forgot another, and
   * a silently rescaled score is worse than a loud failure.
   */
  TRUST_WEIGHTS: Object.freeze({
    COD_TRACK_RECORD: intEnv('AGENT_TRUST_WEIGHT_COD', 30),
    ACTIVITY: intEnv('AGENT_TRUST_WEIGHT_ACTIVITY', 20),
    CUSTOMER_RATING: intEnv('AGENT_TRUST_WEIGHT_CUSTOMER', 30),
    AGENCY_RATING: intEnv('AGENT_TRUST_WEIGHT_AGENCY', 10),
    VENDOR_RATING: intEnv('AGENT_TRUST_WEIGHT_VENDOR', 10),
  }),

  /**
   * Score bounds. 0–100 is not free choice: COD_CONFIG.TRUST_FULL_THRESHOLD (80)
   * and TRUST_REDUCED_THRESHOLD (50) already read this scale.
   */
  TRUST_SCORE_MIN: 0,
  TRUST_SCORE_MAX: 100,

  /**
   * Score for an agent with no signals at all. A new agent is trusted by
   * default (matching the previous delta model, which started everyone at 100
   * and subtracted); starting them at 0 would lock every new agent out of COD.
   */
  TRUST_SCORE_SEED: intEnv('AGENT_TRUST_SCORE_SEED', 100),

  /**
   * Minimum observations before a rating factor is trusted on its own. Below
   * this, the factor is blended toward the seed — one angry customer must not
   * define an agent's reputation.
   */
  TRUST_MIN_OBSERVATIONS: intEnv('AGENT_TRUST_MIN_OBSERVATIONS', 5),

  /**
   * Cash volume (minor units) at which the COD track record earns full credit
   * for scale. Returning 5M cleanly is stronger evidence than returning 5k
   * cleanly, and the spec asks for that to weigh positively rather than binary.
   */
  TRUST_COD_VOLUME_FULL_CREDIT: intEnv('AGENT_TRUST_COD_VOLUME_FULL_CREDIT', 5_000_000),

  // ── Agency / geo-tracker seams ────────────────────────────────────────────
  /**
   * Whether an agent must have device location confirmed enabled to receive
   * shipments. geo-tracker is the only component that can observe this and is
   * not wired yet, so this defaults OFF — turning it on before geo-tracker
   * reports device state would make every agent permanently ineligible.
   */
  REQUIRE_DEVICE_LOCATION: process.env.AGENT_REQUIRE_DEVICE_LOCATION === 'true',

  /**
   * How a device-location signal of `null` (never reported / provider offline)
   * is treated when REQUIRE_DEVICE_LOCATION is on:
   *   'allow' — unknown is not a blocker (fail-open; a geo-tracker outage doesn't halt dispatch)
   *   'deny'  — unknown blocks assignment (fail-closed)
   * An explicit `false` always blocks, under either policy.
   */
  UNKNOWN_DEVICE_LOCATION_POLICY: (process.env.AGENT_UNKNOWN_DEVICE_LOCATION_POLICY || 'allow') as 'allow' | 'deny',

  /**
   * Age past which a reported tracking state is considered stale rather than
   * live. Business reference only — geo-tracker owns the real liveness signal.
   */
  TRACKING_STATE_STALE_AFTER_SECONDS: intEnv('AGENT_TRACKING_STATE_STALE_AFTER_SECONDS', 120),

  /** Tracking allow default for a newly created agent. */
  TRACKING_ALLOWED_BY_DEFAULT: process.env.AGENT_TRACKING_ALLOWED_BY_DEFAULT !== 'false',

  /**
   * Shared secret for service-to-service calls from geo-tracker. Must equal
   * geo-tracker's NODE_API_SERVICE_TOKEN. Empty disables the internal API
   * outright (fail-closed — an unset secret never means "allow everyone").
   */
  INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN || '',

  /** Nightly trust recompute (cron). Recompute is batch-only by product decision. */
  TRUST_RECOMPUTE_CRON: process.env.AGENT_TRUST_RECOMPUTE_CRON || '0 3 * * *',
  TRUST_RECOMPUTE_ENABLED: process.env.AGENT_TRUST_RECOMPUTE_ENABLED !== 'false',
});

/** Shipment statuses that count as "in flight" for an agent's working state. */
export const ACTIVE_SHIPMENT_STATUSES = Object.freeze([
  'assigned',
  'handing_over',
  'picked_up',
  'in_transit',
  'agent_delivered',
  'failed',
] as const);

/**
 * A weight set that doesn't sum to 100 is an editing mistake, not a
 * configuration. Fail at import rather than quietly produce scores on a scale
 * nobody intended.
 *
 * A bare Error, not createAppError, and deliberately: this runs at module load
 * with no request in flight and nothing to catch it. An AppError exists to be
 * shaped into an HTTP response by the global handler, and there is no response
 * here — the process must refuse to boot.
 */
const weightSum = Object.values(AGENT_CONFIG.TRUST_WEIGHTS).reduce((a, b) => a + b, 0);
if (weightSum !== 100) {
  // eslint-disable-next-line no-restricted-syntax
  throw new Error(
    `[AgentConfig] Trust weights must sum to 100, got ${weightSum}. ` +
      `Check AGENT_TRUST_WEIGHT_* env vars: ${JSON.stringify(AGENT_CONFIG.TRUST_WEIGHTS)}`
  );
}

/** True when the internal (geo-tracker facing) API is usable. */
export function internalApiEnabled(): boolean {
  return AGENT_CONFIG.INTERNAL_SERVICE_TOKEN !== '';
}
