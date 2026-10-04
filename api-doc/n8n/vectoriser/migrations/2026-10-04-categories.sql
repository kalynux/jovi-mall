-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-10-04 · several categories per product — the vectoriser's half (owner decision C-6).
-- Record: PRODUCTION-READINESS/PRODUCT-CATEGORIES-PLAN.md · README.md § 16.
--
-- For a product_vectors table that ALREADY EXISTS. A fresh install gets all of this from
-- product_vectors.sql directly. Idempotent: safe to run twice.
--
-- Why a separate file: product_vectors.sql adds columns with ADD COLUMN IF NOT EXISTS, which
-- cannot CHANGE an existing generated expression — the `tsv` column would silently keep its
-- old expression on every deployed database. PostgreSQL 17 can (`SET EXPRESSION`); vector_db
-- runs 17.11 (verified 2026-09-06). SET EXPRESSION rewrites the table once.
--
-- ORDER, and why it matters:
--   1. Run THIS file.
--   2. Re-run product_vectors.sql (it drops-then-creates product_search(), which picks up the
--      `OR pv.categories ? p_category` filter).
--   3. Publish the `build all texts` change (README § 16) so new rows carry metadata.categories.
--   4. (Optional, and NOT done — owner, 2026-10-04: no re-vectorising.) Rows indexed before
--      this match on their primary `category` alone — exactly what they did before.
--
-- ✅ APPLIED 2026-10-04 through wi-mall-vectoriser-schema (nodes 2k–2m, execution 20823);
-- build all texts published the same day. README § 16 records the live proof.
-- Steps 1–2 are harmless with an un-updated workflow: `categories` is simply `[]`.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE product_vectors
    ADD COLUMN IF NOT EXISTS categories jsonb GENERATED ALWAYS AS (coalesce(metadata->'categories', '[]'::jsonb)) STORED;

ALTER TABLE product_vectors
    ALTER COLUMN tsv SET EXPRESSION AS (
        setweight(to_tsvector('simple', coalesce(metadata->>'title', '')), 'A') ||
        setweight(to_tsvector('simple',
            coalesce(metadata->>'category', '') || ' ' ||
            coalesce(metadata->>'categories', '') || ' ' ||
            coalesce(metadata->>'vendor_name', '') || ' ' ||
            coalesce(metadata->>'tags', '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(text, '')), 'C')
    );

CREATE INDEX IF NOT EXISTS product_vectors_categories_idx
    ON product_vectors USING gin (categories);
