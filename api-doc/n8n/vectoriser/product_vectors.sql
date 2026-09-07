-- ═══════════════════════════════════════════════════════════════════════════
-- product_vectors — the wi-mall product index the shopping bot searches.
--
-- Run this ONCE against the Postgres behind n8n's "Postgres account" credential,
-- BEFORE the wi-mall-vectoriser workflow is activated. It is idempotent and
-- re-running it after a schema addition is safe: every DDL statement is
-- IF NOT EXISTS, and product_search() is dropped-then-created rather than merely
-- REPLACEd, because REPLACE does not remove an overload with a different
-- signature. See the note above the function.
--
-- Two halves. The DDL is the index the workflow WRITES. The product_search()
-- function at the bottom is the hybrid query the shopping bot READS, and it is
-- the newer half -- applied separately if the table is already in place.
--
-- ── WHY THE TABLE IS PRE-CREATED ───────────────────────────────────────────
-- The LangChain PGVector node will happily auto-create its own table, and that
-- table has four columns: id, text, metadata, embedding. Every filter the bot
-- needs -- "active products only", "under 50,000 XAF", "in Cameroon", "in
-- stock" -- would then be a jsonb operator with no index behind it, and the
-- keyword half of hybrid search would not exist at all.
--
-- So we create it first, with the same four columns the node expects, and hang
-- GENERATED columns off the metadata jsonb. The node keeps writing exactly what
-- it always wrote; Postgres derives the typed, indexed columns itself. Nothing
-- in n8n has to know these columns exist.
--
-- ── THE ONE THING THAT IS A CONSTRAINT, NOT A CONVENTION ───────────────────
-- product_vectors_product_id_key is UNIQUE. One row per product is not a habit
-- we are keeping, it is enforced: it is what stops the same product appearing
-- twice in a five-item chat list, half of it at a stale price.
--
-- It is also the ARBITER the workflow upserts against --
-- INSERT ... ON CONFLICT (product_id) DO UPDATE -- so a re-index replaces the
-- row in one statement and the product is never briefly absent from search.
-- (This comment described a delete-then-insert with exactly that gap until
-- 2026-09-06; the batched HTTP embed removed it. README section 11.)
--
-- ── THE DIMENSION IS LOAD-BEARING ──────────────────────────────────────────
-- vector(1024) matches voyage-4 at its default outputDimension. Changing the
-- model or the dimension in the workflow without changing it here fails every
-- insert -- which is the intended outcome, because the alternative is a mixed
-- index that returns nonsense. Changing it deliberately means re-indexing the
-- entire catalogue.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy title match; chat input is typo-prone

-- gen_random_uuid() is core from PostgreSQL 13 onward, so on any modern server
-- this block does nothing. It is conditional rather than unconditional because
-- CREATE EXTENSION is a privilege the role running this may not have, and
-- asking for one we do not need is how a bootstrap fails on a least-privileged
-- database for no reason. (Verified 2026-09-06: vector_db runs 17.11.)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
    END IF;
END $$;

-- ── the four columns the PGVector node writes ──────────────────────────────
CREATE TABLE IF NOT EXISTS product_vectors (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    text       text,
    metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    embedding  vector(1024),
    indexed_at timestamptz NOT NULL DEFAULT now()
);

-- ── everything below is derived; nothing writes to these directly ──────────
-- Keys must match the `metadata` object built by the "build product text" Code
-- node in the wi-mall-vectoriser workflow. Renaming one there without renaming
-- it here silently nulls the column and the filter stops matching anything.
ALTER TABLE product_vectors
    ADD COLUMN IF NOT EXISTS product_id   text    GENERATED ALWAYS AS (metadata->>'product_id')            STORED,
    ADD COLUMN IF NOT EXISTS title        text    GENERATED ALWAYS AS (metadata->>'title')                 STORED,
    ADD COLUMN IF NOT EXISTS slug         text    GENERATED ALWAYS AS (metadata->>'slug')                  STORED,
    ADD COLUMN IF NOT EXISTS vendor_id    text    GENERATED ALWAYS AS (metadata->>'vendor_id')             STORED,
    ADD COLUMN IF NOT EXISTS vendor_name  text    GENERATED ALWAYS AS (metadata->>'vendor_name')           STORED,
    ADD COLUMN IF NOT EXISTS category     text    GENERATED ALWAYS AS (metadata->>'category')              STORED,
    ADD COLUMN IF NOT EXISTS product_type text    GENERATED ALWAYS AS (metadata->>'type')                  STORED,
    ADD COLUMN IF NOT EXISTS status       text    GENERATED ALWAYS AS (metadata->>'status')                STORED,
    ADD COLUMN IF NOT EXISTS country      text    GENERATED ALWAYS AS (metadata->>'country')               STORED,
    ADD COLUMN IF NOT EXISTS currency     text    GENERATED ALWAYS AS (metadata->>'currency')              STORED,
    ADD COLUMN IF NOT EXISTS price_min    numeric GENERATED ALWAYS AS ((metadata->>'price_min')::numeric)  STORED,
    ADD COLUMN IF NOT EXISTS price_max    numeric GENERATED ALWAYS AS ((metadata->>'price_max')::numeric)  STORED,
    ADD COLUMN IF NOT EXISTS in_stock     boolean GENERATED ALWAYS AS ((metadata->>'in_stock')::boolean)   STORED,
    ADD COLUMN IF NOT EXISTS bargainable  boolean GENERATED ALWAYS AS ((metadata->>'bargainable')::boolean) STORED;

-- Weighted keyword vector: a query word that hits the product TITLE must beat
-- the same word buried in a description. 'simple' rather than 'english' or
-- 'french' on purpose -- the catalogue is mixed FR/EN and a stemmer guessing
-- wrong is worse than no stemmer at all.
ALTER TABLE product_vectors
    ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(metadata->>'title', '')), 'A') ||
        setweight(to_tsvector('simple',
            coalesce(metadata->>'category', '') || ' ' ||
            coalesce(metadata->>'vendor_name', '') || ' ' ||
            coalesce(metadata->>'tags', '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(text, '')), 'C')
    ) STORED;

-- ── indexes ────────────────────────────────────────────────────────────────
-- HNSW needs pgvector >= 0.5. Rather than pin a version this deployment may not
-- have, ask the server which access methods it actually has and take the best
-- one present. On an older pgvector this silently lands on ivfflat; on a build
-- with neither, it creates no vector index and search still works, slowly.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_am WHERE amname = 'hnsw') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS product_vectors_embedding_idx
                 ON product_vectors USING hnsw (embedding vector_cosine_ops)';
    ELSIF EXISTS (SELECT 1 FROM pg_am WHERE amname = 'ivfflat') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS product_vectors_embedding_idx
                 ON product_vectors USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS product_vectors_product_id_key
    ON product_vectors (product_id);

CREATE INDEX IF NOT EXISTS product_vectors_tsv_idx
    ON product_vectors USING gin (tsv);

CREATE INDEX IF NOT EXISTS product_vectors_title_trgm_idx
    ON product_vectors USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS product_vectors_filter_idx
    ON product_vectors (status, country, product_type, category);

CREATE INDEX IF NOT EXISTS product_vectors_price_idx
    ON product_vectors (price_min);


-- ═══════════════════════════════════════════════════════════════════════════
-- product_search_query_cache — the same query, embedded once.
--
-- Every customer search needs the query text as a vector before product_search
-- can be called, and that is a paid round trip to Voyage on the critical path of
-- a chat reply. Shoppers repeat themselves ("shoes", "chaussures femme", "air
-- fryer") far more than they invent, so this is a high-hit-rate cache.
--
-- ── WHY POSTGRES AND NOT REDIS ─────────────────────────────────────────────
-- The n8n Redis node's `set` operation exposes NO ttl (its `expire`/`ttl` fields
-- belong to `incr`), so a Redis cache here would grow without bound and need a
-- sweeper anyway. Postgres also stores the vector as a real vector(1024) rather
-- than a ~20 KB JSON string that has to be serialised on write and parsed on
-- every read, and the connection is already open — product_search is the very
-- next statement.
--
-- ── THE LOOKUP IS A WRITE, DELIBERATELY ────────────────────────────────────
-- Reading the cache is an UPDATE ... RETURNING, not a SELECT: it fetches the
-- vector and stamps last_used_at in ONE statement and one round trip, which
-- makes the expiry a SLIDING window (a query stays cached while people keep
-- asking it) and makes the hit/miss verdict a returned ROW rather than a node
-- reporting success. Same rule as the write path — verify the row, never the node.
--
--   UPDATE product_search_query_cache
--      SET hits = hits + 1, last_used_at = now()
--    WHERE query_key = $1
--      AND last_used_at > now() - interval '30 days'
--   RETURNING embedding;
--
-- ── PRUNING IS NOT AUTOMATIC ───────────────────────────────────────────────
-- Nothing deletes from this table. A row is ~4 KB (1024 float4s plus overhead),
-- so ten thousand distinct queries is about 40 MB — small enough that a sweeper
-- on the search path would cost more latency than it saves space. Run this when
-- it matters, not on a timer:
--
--   DELETE FROM product_search_query_cache
--    WHERE last_used_at < now() - interval '30 days';
--
-- ⚠ **The cached vector is model-specific.** It is voyage-4 at 1024 dimensions
-- with input_type=query. Changing the embedding model or the dimension means
-- TRUNCATING this table in the same change — a stale vector here is not a stale
-- price, it is a vector from a different space, and it will return confident
-- nonsense rather than failing.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS product_search_query_cache (
    query_key    text PRIMARY KEY,
    embedding    vector(1024) NOT NULL,
    hits         bigint      NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now()
);

-- Supports the prune above. The lookup itself hits the primary key.
CREATE INDEX IF NOT EXISTS product_search_query_cache_last_used_idx
    ON product_search_query_cache (last_used_at);


-- ═══════════════════════════════════════════════════════════════════════════
-- product_search — the hybrid search this schema exists to serve.
--
-- Kept beside the DDL because a schema whose query lives in another repository
-- is a schema nobody can check. It is a FUNCTION rather than a comment block for
-- one reason above the others: the bargain-window strip below has to happen, and
-- a rule enforced at the database boundary cannot be forgotten by a caller.
--
-- Reciprocal Rank Fusion over independent rankings. RRF rather than a weighted
-- sum of scores because cosine distance, ts_rank_cd and trigram similarity are
-- on three incomparable scales, and any fixed weight between raw scores is a
-- number nobody can defend. RRF only ever compares an item's POSITION within one
-- ranking against its position within another, so the scales never meet.
--
-- ── HOW THIS DIFFERS FROM SUPABASE'S hybrid_search, AND WHY ────────────────
-- (https://supabase.com/docs/guides/ai/hybrid-search — the reference design.)
--
--  1. THREE arms, not two. Supabase fuses semantic + full-text. This adds a
--     TRIGRAM arm on the title, because chat input is typo-prone and the other
--     two both fail on a misspelling: websearch_to_tsquery('simple','nikee')
--     produces a lexeme that matches nothing, and an embedding of a typo is not
--     reliably near the embedding of the word. product_vectors_title_trgm_idx
--     was created for exactly this and the previous reference query never used
--     it. RRF is what makes a third arm nearly free — it generalises to N
--     rankings, which is also why the arms are UNIONed and LEFT JOINed here
--     rather than FULL OUTER JOINed as in the two-arm original.
--
--  2. Cosine (<=>), not inner product (<#>). Supabase indexes with
--     vector_ip_ops; this table is vector_cosine_ops. Voyage returns unit-norm
--     vectors so the two rank identically — but an operator that does not match
--     the index class gets NO index at all, and the query silently degrades to a
--     sequential scan over the whole catalogue. Do not "optimise" this to <#>
--     without rebuilding the index in the same change.
--
--  3. The candidate pool is FIXED, not derived from match_count. Supabase takes
--     least(match_count,30)*2, which for a bot showing 5 results is a pool of
--     10 — too shallow for fusion to do anything, because an item ranked 11th
--     semantically and 1st lexically is invisible before the join. The pool is
--     what fusion has to work with; the match count is only what gets displayed.
--
--  4. rrf_k defaults to 60, not 50 — the value from the original RRF paper
--     (Cormack, Clarke & Buettcher, 2009). Both are arbitrary smoothing
--     constants; this one is at least cited. Larger k flattens the advantage of
--     the top ranks and lets agreement ACROSS arms matter more.
--
--     ⚠ A WEIGHT BELOW 1.0 CAN DISABLE AN ARM ENTIRELY, and the arithmetic is
--     not obvious. This function shipped with p_fuzzy_weight 0.5 for about an
--     hour, which reads as "counts half as much" and is not: a fuzzy-only
--     rank-1 hit scores 0.5/(60+1) = 0.0082, while a semantic-only rank-FIFTY
--     hit scores 1.0/(60+50) = 0.0091. Since the semantic arm has no relevance
--     floor and therefore always returns a full pool, a product found ONLY by
--     the trigram arm could never enter a top-5 at all. Measured, not reasoned
--     about — the typo query that motivated the arm returned five unrelated
--     products. Weights are multipliers on a curve that is already steep;
--     halving one does not halve its influence, it can remove it.
--
--  5. It filters. Supabase's example searches everything. status = 'active' is
--     not optional here — an archived product must never be offered — and the
--     rest are the columns product_vectors_filter_idx exists for.
--
--  6. It strips metadata.bargain_windows. See below; this is the one difference
--     that is a safety rule rather than a preference.
--
-- ── ⚠ THE BARGAIN WINDOW MUST NOT LEAVE THIS FUNCTION ──────────────────────
-- metadata.bargain_windows holds each variant's minPrice and maxPrice, where
-- minPrice IS the selling price and maxPrice is the ceiling haggling may reach.
-- That is the negotiating agent's hand, and search results are read straight
-- into a customer-facing model's context. `metadata - 'bargain_windows'` removes
-- it here, once, for every caller. A server-side caller that genuinely needs the
-- window reads the row directly and does not come through this function.
--
-- ── ⚠ THE PGVECTOR FILTER HAZARD ──────────────────────────────────────────
-- The filters sit INSIDE the semantic CTE, so HNSW returns its candidates and
-- the filter is applied to them. A highly selective filter can therefore yield
-- fewer than p_candidate_pool rows — the index does not go back for more. With
-- status = 'active' being nearly every row this is immaterial; with a narrow
-- country or price band it is not. Two levers if it bites: raise
-- hnsw.ef_search for the session, or add a partial HNSW index
--   CREATE INDEX ... USING hnsw (embedding vector_cosine_ops) WHERE status = 'active'
-- which makes the dominant filter free. Not created here: it doubles the vector
-- index's build cost and memory, and the right moment to decide is when the
-- table has enough rows to measure.
--
-- ── ⚠ CALL IT WITH NAMED ARGUMENTS ────────────────────────────────────────
-- Thirteen parameters, eleven of them optional and eight of them defaulting to
-- NULL/1.0, is a positional call waiting to break. It already did: inserting
-- p_max_distance after p_rrf_k shifted every filter one place right, and the
-- first positional caller got
--   invalid input syntax for type double precision: "CM"
-- -- a type error, which is the LUCKY version. Two adjacent parameters of the
-- same type would have silently swapped a price ceiling for a rank constant.
-- PostgreSQL's => syntax removes the whole class of failure.
--
-- Usage:
--   SELECT * FROM product_search(
--     $1::vector(1024),          -- voyage-4, inputType=query, 1024 dims
--     $2,                        -- the raw query text, as the customer typed it
--     p_match_count   => 5,
--     p_country       => 'CM',
--     p_category      => NULL,
--     p_price_max     => NULL,
--     p_in_stock_only => false
--   );
-- ═══════════════════════════════════════════════════════════════════════════

-- ⚠ DROP FIRST, AND DROP EVERY OVERLOAD -- "CREATE OR REPLACE" IS NOT ENOUGH.
-- A function's identity in PostgreSQL is name + argument types, so replacing one
-- whose SIGNATURE changed does not replace it: it creates a SECOND function
-- beside the first, and every existing call site then fails with
--   function product_search(vector, unknown, integer) is not unique
-- which is a failure of the CALLERS, at their next request, and not of the
-- deploy that caused it. This happened here the first time a parameter was
-- added. The loop drops all overloads by OID so this file stays re-appliable
-- however the signature moves.
DO $drop_search$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT oid::regprocedure AS sig
        FROM pg_proc
        WHERE proname = 'product_search'
          AND pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE 'DROP FUNCTION ' || r.sig;
    END LOOP;
END
$drop_search$;

CREATE OR REPLACE FUNCTION product_search(
    p_query_embedding  vector(1024),
    p_query_text       text,
    p_match_count      int     DEFAULT 5,
    p_candidate_pool   int     DEFAULT 50,
    p_semantic_weight  float   DEFAULT 1.0,
    p_keyword_weight   float   DEFAULT 1.0,
    p_fuzzy_weight     float   DEFAULT 1.0,
    p_rrf_k            int     DEFAULT 60,
    p_max_distance     float   DEFAULT NULL,
    p_country          text    DEFAULT NULL,
    p_product_type     text    DEFAULT NULL,
    p_category         text    DEFAULT NULL,
    p_price_max        numeric DEFAULT NULL,
    p_in_stock_only    boolean DEFAULT false
)
RETURNS TABLE (
    product_id    text,
    title         text,
    product_text  text,
    metadata      jsonb,
    score         float,
    semantic_rank int,
    keyword_rank  int,
    fuzzy_rank    int
)
LANGUAGE sql
STABLE
AS $$
WITH filtered AS (
    SELECT pv.id, pv.embedding, pv.tsv, pv.title
    FROM product_vectors pv
    WHERE pv.status = 'active'
      AND (p_country      IS NULL   OR pv.country      = p_country)
      AND (p_product_type IS NULL   OR pv.product_type = p_product_type)
      AND (p_category     IS NULL   OR pv.category     = p_category)
      AND (p_price_max    IS NULL   OR pv.price_min   <= p_price_max)
      AND (p_in_stock_only IS NOT TRUE OR pv.in_stock IS TRUE)
),
semantic AS (
    -- ⚠ This is the ONLY arm with no natural relevance floor. The keyword arm
    -- has @@ and the fuzzy arm has <%, so both return nothing when nothing
    -- matches; a nearest-neighbour scan always returns p_candidate_pool rows,
    -- however unrelated they are. p_max_distance is the floor, and it is NULL by
    -- default on purpose -- a threshold picked without measuring real voyage-4
    -- distances would silently drop good results, which is worse than ranking
    -- some weak ones. Calibrate it against the live index, then set it.
    SELECT f.id,
           ROW_NUMBER() OVER (ORDER BY f.embedding <=> p_query_embedding)::int AS rank
    FROM filtered f
    WHERE f.embedding IS NOT NULL
      AND (p_max_distance IS NULL OR (f.embedding <=> p_query_embedding) <= p_max_distance)
    ORDER BY f.embedding <=> p_query_embedding
    LIMIT p_candidate_pool
),
keyword AS (
    -- 'simple' matches the tsv column's configuration. A stemmer guessing wrong
    -- on a mixed FR/EN catalogue is worse than no stemmer, and a query parsed
    -- with a different configuration than the index was built with matches
    -- nothing at all.
    SELECT k.id,
           ROW_NUMBER() OVER (ORDER BY ts_rank_cd(k.tsv, websearch_to_tsquery('simple', p_query_text)) DESC)::int AS rank
    FROM filtered k
    WHERE k.tsv @@ websearch_to_tsquery('simple', p_query_text)
    ORDER BY ts_rank_cd(k.tsv, websearch_to_tsquery('simple', p_query_text)) DESC
    LIMIT p_candidate_pool
),
fuzzy AS (
    -- word_similarity, not similarity: `similarity('nike', 'Nike Air Max 270
    -- Running Shoe')` is low because it compares whole strings, while
    -- word_similarity asks how well the query matches SOME PART of the title —
    -- which is the actual question when someone types two words at a catalogue.
    -- The <% operator is what reaches product_vectors_title_trgm_idx; the
    -- function call only orders what the operator already found.
    SELECT z.id,
           ROW_NUMBER() OVER (ORDER BY word_similarity(p_query_text, z.title) DESC)::int AS rank
    FROM filtered z
    WHERE p_query_text <% z.title
    ORDER BY word_similarity(p_query_text, z.title) DESC
    LIMIT p_candidate_pool
),
candidates AS (
    SELECT id FROM semantic
    UNION
    SELECT id FROM keyword
    UNION
    SELECT id FROM fuzzy
),
-- Fused in its own CTE so every reference below is qualified. The RETURNS
-- TABLE columns are OUT parameters and therefore visible inside the body, so a
-- bare `ORDER BY score` is a name that could resolve two ways.
fused AS (
    SELECT pv.product_id  AS f_product_id,
           pv.title       AS f_title,
           pv.text        AS f_text,
           -- ⚠ The strip. See the header. Never select pv.metadata whole here.
           pv.metadata - 'bargain_windows' AS f_metadata,
           pv.indexed_at  AS f_indexed_at,
           (COALESCE(1.0 / (p_rrf_k + s.rank), 0.0) * p_semantic_weight
          + COALESCE(1.0 / (p_rrf_k + k.rank), 0.0) * p_keyword_weight
          + COALESCE(1.0 / (p_rrf_k + z.rank), 0.0) * p_fuzzy_weight)::float AS f_score,
           s.rank AS f_semantic_rank,
           k.rank AS f_keyword_rank,
           z.rank AS f_fuzzy_rank
    FROM candidates c
    JOIN product_vectors pv ON pv.id = c.id
    LEFT JOIN semantic s ON s.id = c.id
    LEFT JOIN keyword  k ON k.id = c.id
    LEFT JOIN fuzzy    z ON z.id = c.id
)
SELECT fused.f_product_id,
       fused.f_title,
       fused.f_text,
       fused.f_metadata,
       fused.f_score,
       fused.f_semantic_rank,
       fused.f_keyword_rank,
       fused.f_fuzzy_rank
FROM fused
ORDER BY fused.f_score DESC, fused.f_indexed_at DESC
LIMIT p_match_count;
$$;

-- The three per-arm ranks are returned on purpose. The weights above are the one
-- part of this that cannot be reasoned to a correct value — they have to be
-- tuned by looking at real queries, and a result set that says WHICH arm found
-- each row is the difference between tuning and guessing. A caller shipping to a
-- customer drops the three columns; a caller tuning keeps them.
