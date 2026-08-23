function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A customer's own lists of products — the bounds (Phase 6 · 6.E.1 / 6.E.2).
 */
export const CUSTOMER_CATALOG_CONFIG = Object.freeze({
  /**
   * How many products the recently-viewed list keeps per customer.
   *
   * A **cap, not a page size** — the two are different numbers and conflating them is how a
   * list quietly becomes unbounded. The page size is `?limit`, bounded at 100 by the
   * platform pagination contract; this is how many rows exist at all, enforced on every
   * write by evicting the oldest beyond it.
   *
   * The list must be capped rather than time-windowed, and the reason is the write path: a
   * TTL prunes on Mongo's own schedule (up to 60 s late, and only while the sweeper runs),
   * so a customer browsing quickly would see a list that is sometimes 20 long and sometimes
   * 200. An explicit eviction makes the length a fact the reader can rely on.
   *
   * 20 is chosen to fill a "recently viewed" strip two or three screens deep and no more —
   * this is a convenience row on a storefront, not a browsing history feature. Raising it
   * costs one row per customer per product, which is cheap; the reason not to raise it far
   * is that nothing prunes by age, so the cap IS the retention policy for what is, in
   * effect, a record of what a person looked at.
   */
  RECENTLY_VIEWED_CAP: intEnv('CUSTOMER_RECENTLY_VIEWED_CAP', 20),
});
