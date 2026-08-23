function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Related products — the bounds and the window (Phase 6 · 6.E.3).
 *
 * Every value here is a decision about a **recommendation**, which is a different kind of
 * thing from the rest of this service: it is allowed to be approximate, allowed to be
 * slightly stale, and must never be allowed to be slow. Where a bound trades accuracy for
 * predictability, it takes the trade.
 */
export const RELATED_PRODUCTS_CONFIG = Object.freeze({
  /** How many related products one request returns. A strip, not a second catalogue. */
  LIMIT: intEnv('RELATED_PRODUCTS_LIMIT', 8),

  /**
   * How long a computed list is served before it is recomputed.
   *
   * Six hours, because the input barely moves: co-occurrence is a count over *historical*
   * orders, so one more sale shifts a ranking by a fraction and never inverts a strip. The
   * cost of being stale is that a product which started selling this morning appears in
   * related strips this afternoon rather than immediately — which nobody can perceive.
   *
   * The cost of a SHORT TTL is real, though, and is the reason this is hours rather than
   * minutes: the miss path is an aggregation over `orders`, and a popular product page is
   * exactly the one whose key expires under load.
   */
  CACHE_TTL_SECONDS: intEnv('RELATED_PRODUCTS_CACHE_TTL_SECONDS', 6 * 60 * 60),

  /**
   * How far back the co-occurrence scan looks.
   *
   * A bound on the QUERY, not a judgement about relevance. Without it the scan grows with
   * the lifetime of the platform, so the endpoint gets slower every month in a way nobody
   * notices until it is slow. A year is long enough to include a full seasonal cycle.
   */
  CO_OCCURRENCE_WINDOW_DAYS: intEnv('RELATED_PRODUCTS_WINDOW_DAYS', 365),

  /**
   * How many of the subject's orders to consider.
   *
   * The ceiling that makes the aggregation's cost independent of how popular the subject
   * is. A best-seller with 50 000 orders and one with 500 do the same amount of work, and
   * the ranking from a 500-order sample is not meaningfully different from the full one —
   * co-occurrence is a frequency estimate, and estimates converge long before this.
   *
   * ⚠ It is a *sample*, and the api-doc says so. Pretending it is exhaustive is the
   * "do not invent a metric" rule this feature is bound by — the same rule the blog and
   * the JSON-LD work follow.
   */
  CO_OCCURRENCE_ORDER_SAMPLE: intEnv('RELATED_PRODUCTS_ORDER_SAMPLE', 500),

  /**
   * Below this many co-occurring orders, a pairing is dropped as noise.
   *
   * Two people buying two things together is a coincidence; the strip should not present it
   * as a pattern. Set to 1 to keep every pairing, which is the honest setting on a young
   * catalogue with few orders — and is why the fallback below exists rather than this being
   * lowered to hide an empty strip.
   */
  MIN_CO_OCCURRENCE: intEnv('RELATED_PRODUCTS_MIN_CO_OCCURRENCE', 1),
});
