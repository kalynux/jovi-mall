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
   * How many ranked candidates to snapshot onto an auto offer's pool. The
   * timeout/reject branch walks this list to the next agent WITHOUT recomputing
   * (the spec's "next agent in the previously computed list"), so it also caps
   * how many agents one auto-assignment will ever try.
   */
  MAX_AUTO_CANDIDATES: intEnv('SHIPMENT_ASSIGNMENT_MAX_CANDIDATES', 10),

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
