function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Shipment-assignment (agent-acceptance) configuration.
 *
 * Every tunable the offer lifecycle and auto-assignment scoring depend on lives
 * here, never inline. The timeout is a PLATFORM default (product decision): one
 * value for every agency, not a per-agency knob. Scoring weights are policy —
 * kept here so the ranking can be re-weighted without touching the algorithm.
 */
export const ASSIGNMENT_CONFIG = Object.freeze({
  // ── Offer timeout ─────────────────────────────────────────────────────────
  /**
   * How long an agent has to accept an offer before it expires (the "Ignore ⇒
   * timeout" branch). Platform-wide; there is deliberately no per-agency
   * override. Seconds.
   */
  OFFER_TIMEOUT_SECONDS: intEnv('SHIPMENT_OFFER_TIMEOUT_SECONDS', 120),

  /**
   * How often the expiry sweep runs. Wants to be well under OFFER_TIMEOUT so an
   * ignored offer is reaped promptly (an auto offer's next candidate should not
   * wait a full extra cycle). Milliseconds.
   */
  OFFER_EXPIRY_SWEEP_INTERVAL_MS: intEnv('SHIPMENT_OFFER_EXPIRY_SWEEP_INTERVAL_MS', 30_000),

  /** Max offers reaped per sweep tick — bounds the work each cycle does. */
  OFFER_EXPIRY_SWEEP_BATCH: intEnv('SHIPMENT_OFFER_EXPIRY_SWEEP_BATCH', 100),

  // ── Auto-assignment candidate ranking ─────────────────────────────────────
  /**
   * How many ranked candidates to snapshot onto an auto assignment session. The
   * broadcast walks this list to the next agent WITHOUT recomputing (the spec's
   * "next agent in the previously computed list"), so it also caps how many
   * agents one auto-assignment will ever try. The requirement's ceiling is 20.
   */
  MAX_AUTO_CANDIDATES: intEnv('SHIPMENT_ASSIGNMENT_MAX_CANDIDATES', 20),

  /**
   * How many full passes over the ranking the broadcast makes before giving up
   * and notifying the agency that automatic assignment failed. The requirement
   * fixes this at TWO: round 1 offers each candidate once; round 2 re-nudges the
   * agents who ignored (never the ones who rejected); after round 2 the agency
   * is told to intervene, but any standing (ignored) offer stays acceptable
   * until the shipment is assigned or its ranking is disposed of.
   */
  MAX_ROUNDS: intEnv('SHIPMENT_ASSIGNMENT_MAX_ROUNDS', 2),

  /**
   * Minimum trust score (0..100) an agent must hold to receive ANY auto-assigned
   * shipment — the requirement's "threshold score allows receiving the order".
   * Applies to every order, COD or prepaid (COD carries its own, stricter, cash
   * gate on top). Default 0 = the floor is inert, preserving today's behaviour
   * until the platform decides to raise it. Product policy, not algorithm.
   */
  MIN_TRUST_SCORE: numEnv('SHIPMENT_ASSIGNMENT_MIN_TRUST_SCORE', 0),

  /**
   * "Current location is available" — the requirement makes a resolvable
   * position a hard eligibility cut BEFORE the geo provider is called (an agent
   * with no coordinates cannot be ranked by proximity). When false (the default)
   * a stale live position or the declared home base still counts as "available",
   * so a deployment without geo-tracker pushing positions keeps working. When
   * true, ONLY a live position reported within POSITION_FRESHNESS_SECONDS counts,
   * and agents without one are dropped from the pool.
   */
  REQUIRE_LIVE_POSITION: boolEnv('SHIPMENT_ASSIGNMENT_REQUIRE_LIVE_POSITION', false),

  /**
   * How recent a pushed live position must be to count as the agent's "current"
   * location. Older than this, the mirror is treated as stale (used only as a
   * ranking fallback, never as proof of a current location when
   * REQUIRE_LIVE_POSITION is on).
   */
  POSITION_FRESHNESS_SECONDS: intEnv('SHIPMENT_ASSIGNMENT_POSITION_FRESHNESS_SECONDS', 300),

  // ── Geo Provider (proximity ranking via geo-tracker's routing) ─────────────
  /**
   * Path geo-tracker exposes for the pairwise distance/duration matrix. The
   * proximity ranking calls it with the agent positions as sources and the
   * pickup as the single target; it is off the critical path — any failure or a
   * missing GEO_TRACKER_BASE_URL falls back to local haversine (see
   * GeoRoutingClient), so auto-assignment never blocks on geo-tracker.
   */
  GEO_MATRIX_PATH: process.env.SHIPMENT_ASSIGNMENT_GEO_MATRIX_PATH || '/routing/matrix',
  /** Per-request timeout (ms) for the matrix call. Kept tight — we fall back fast. */
  GEO_REQUEST_TIMEOUT_MS: intEnv('SHIPMENT_ASSIGNMENT_GEO_TIMEOUT_MS', 3000),
  /**
   * Claims for the short-lived service JWT minted to call geo-tracker routing.
   * geo-tracker verifies HS256 with the SHARED `JWT_SECRET` and reads `{ userId,
   * role }`; the routing endpoints admit any authenticated caller, so `admin`
   * (the broadest, always-accepted role) is the safe default. The token lives
   * only for the length of one matrix call.
   */
  GEO_SERVICE_TOKEN_SUBJECT: process.env.SHIPMENT_ASSIGNMENT_GEO_TOKEN_SUBJECT || 'jovi-mall-assignment',
  GEO_SERVICE_TOKEN_ROLE: process.env.SHIPMENT_ASSIGNMENT_GEO_TOKEN_ROLE || 'admin',
  GEO_SERVICE_TOKEN_TTL_SECONDS: intEnv('SHIPMENT_ASSIGNMENT_GEO_TOKEN_TTL_SECONDS', 60),

  /**
   * Relative weights of the three scored factors. Not required to sum to 100 —
   * each factor is normalised to 0..1 first, so these are pure relative
   * importance and the weighted sum is renormalised by their total.
   *
   * COD is NOT a weight: it is a hard filter (an agent over their COD headroom
   * is removed from the pool entirely), matching the spec — "is the order COD?
   * if yes check the agent's COD threshold; if no, assign to any [eligible]".
   */
  WEIGHTS: Object.freeze({
    DISTANCE: numEnv('SHIPMENT_ASSIGNMENT_WEIGHT_DISTANCE', 50),
    FREE_CAPACITY: numEnv('SHIPMENT_ASSIGNMENT_WEIGHT_CAPACITY', 20),
    TRUST: numEnv('SHIPMENT_ASSIGNMENT_WEIGHT_TRUST', 30),
  }),

  /**
   * Distance normalisation. An agent at (or nearer than) DISTANCE_FULL_SCORE_KM
   * scores 1 on the distance factor; one at (or beyond) DISTANCE_ZERO_SCORE_KM
   * scores 0; linear in between. When pickup or agent coordinates are unknown,
   * the distance factor is neutral (see UNKNOWN_DISTANCE_SCORE) rather than
   * zero, so a missing location degrades gracefully instead of always losing.
   */
  DISTANCE_FULL_SCORE_KM: numEnv('SHIPMENT_ASSIGNMENT_DISTANCE_FULL_KM', 1),
  DISTANCE_ZERO_SCORE_KM: numEnv('SHIPMENT_ASSIGNMENT_DISTANCE_ZERO_KM', 25),
  UNKNOWN_DISTANCE_SCORE: numEnv('SHIPMENT_ASSIGNMENT_UNKNOWN_DISTANCE_SCORE', 0.5),
});
