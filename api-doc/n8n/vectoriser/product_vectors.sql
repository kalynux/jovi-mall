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
-- product_image_vectors — what the product PHOTOS look like, one row per image.
--
-- The fourth retrieval arm (README § 15). A text query ("robe rouge à fleurs")
-- reaches a dress whose text never says "floral", and a customer's photo reaches
-- the products that look like it.
--
-- ── A DIFFERENT MODEL, SO A DIFFERENT TABLE ────────────────────────────────
-- These vectors are voyage-multimodal-3.5. product_vectors.embedding is voyage-4.
-- The two are NOT one vector space -- Voyage's shared space covers the four
-- voyage-4 text models only -- so a distance between a row here and a row there
-- means nothing. They never meet in SQL: each arm ranks against its own query
-- vector, and RRF compares positions, never distances.
--
-- ── IMAGE ONLY, NO CAPTION ─────────────────────────────────────────────────
-- Each row embeds the picture alone. Interleaving the title would make this arm
-- re-find what the three text arms already find, and RRF would count the same
-- evidence twice. The arm exists to add what the text does not say.
--
-- ── WHO WRITES IT ──────────────────────────────────────────────────────────
-- Nothing in the wi-mall-vectoriser flow has to know this table exists -- the
-- same stance as the generated columns above. The flow writes
-- product_vectors.metadata.image_files; the trigger below turns that list into rows
-- here, in the same transaction as the text upsert, so the set of images a
-- product SHOULD have can never disagree with the text row it belongs to.
--
--   metadata.image_files = [ { "file_id": "...", "url": "https://...",
--                         "variant_id": null | "...", "mime_type": "image/jpeg" }, ... ]
--
-- ⚠ NOT metadata.images. That key already exists and means something else: up
-- to five bare URL strings, written by the same node since before this table,
-- and possibly read by consumers of product_search() results. Reading objects
-- out of it would have matched no entry and created no row -- silently -- so the
-- image arm has a key of its own.
--
-- Keys must match the "build all texts" node, exactly as for the generated
-- columns. That node decides WHICH images (PNG/JPEG/WEBP/GIF only -- no video,
-- no digital asset -- gallery first, then variants, deduplicated, at most 6).
-- This table decides nothing about that; it embeds what it is given.
--
-- ── WHO EMBEDS IT ──────────────────────────────────────────────────────────
-- A separate scheduled workflow, wi-mall-image-vectoriser, one Voyage request
-- per minute, through product_image_claim() and product_image_settle() below.
-- Deliberately NOT the text flow: sized for Voyage's no-payment-method limits
-- (3 RPM, 10K TPM) an image costs up to ~3,572 tokens (2M pixels / 560), so one
-- 32-product text chunk carrying its photos would be ~100x over the minute's
-- budget. A queue drained at a fixed pace fits any catalogue into those limits;
-- a faster tier is a change of two numbers, not of shape.
--
-- ⚠ Rows are deleted with their product: the FOREIGN KEY cascades from
-- product_vectors, so /delete needs no change. /status needs none either -- the
-- image arm joins product_vectors and inherits its status filter.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS product_image_vectors (
    product_id      text         NOT NULL
                    REFERENCES product_vectors (product_id) ON DELETE CASCADE,
    file_id         text         NOT NULL,
    image_url       text         NOT NULL,
    variant_id      text,                          -- NULL = the product gallery
    position        int          NOT NULL,         -- 0 = the product's primary image
    status          text         NOT NULL DEFAULT 'pending',
    embedding       vector(1024),                  -- voyage-multimodal-3.5, input_type=document
    attempts        int          NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at timestamptz  NOT NULL DEFAULT now(),
    claim_id        text,
    claimed_at      timestamptz,
    image_pixels    bigint,                        -- as Voyage billed it; exact for a 1-image request
    embedded_at     timestamptz,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, file_id),
    CONSTRAINT product_image_vectors_status_chk
        CHECK (status IN ('pending', 'claimed', 'embedded', 'failed')),
    -- "embedded" is a claim about a vector, so it must come with one.
    CONSTRAINT product_image_vectors_embedded_chk
        CHECK ((status = 'embedded') = (embedding IS NOT NULL))
);

-- The drainer's queue scan. Partial: embedded rows, the vast majority, are not work.
CREATE INDEX IF NOT EXISTS product_image_vectors_work_idx
    ON product_image_vectors (position, created_at)
    WHERE status IN ('pending', 'failed', 'claimed');

-- No HNSW index, on purpose. The image arm is an EXACT scan over the images of
-- the products that pass the filters (see product_search): the filters apply
-- first, so a narrow country or price band cannot starve it the way it starves an
-- HNSW scan, and at a few thousand images an exact scan is milliseconds. When it
-- stops being milliseconds, the lever is an HNSW index here plus
-- hnsw.iterative_scan (pgvector >= 0.8) -- not before, because an index the
-- planner cannot use still costs every write.


-- ── metadata.image_files → rows, in the text upsert's own transaction ──────
-- Fires on INSERT, and on an UPDATE only when the image list actually changed,
-- so a re-index with the same photos (the common case: a price edit) touches no
-- row here and re-embeds nothing. An embedded image keeps its vector when only
-- its URL moves (a storage migration): same file id, same bytes. A FAILED image
-- whose URL moved gets a fresh start, since a new address is the likeliest fix.
CREATE OR REPLACE FUNCTION product_image_vectors_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.product_id IS NULL THEN
        RETURN NULL;
    END IF;

    WITH desired AS (
        -- DISTINCT ON is a guard, not the rule: the build node already dedupes.
        SELECT DISTINCT ON (e.img->>'file_id')
               e.img->>'file_id'                 AS file_id,
               e.img->>'url'                     AS image_url,
               NULLIF(e.img->>'variant_id', '')  AS variant_id,
               (e.ord - 1)::int                  AS position
        FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(NEW.metadata->'image_files') = 'array'
                      THEN NEW.metadata->'image_files' ELSE '[]'::jsonb END
             ) WITH ORDINALITY AS e(img, ord)
        WHERE jsonb_typeof(e.img) = 'object'
          AND coalesce(e.img->>'file_id', '') <> ''
          AND coalesce(e.img->>'url', '') ~* '^https?://'
        ORDER BY e.img->>'file_id', e.ord
    ),
    gone AS (
        DELETE FROM product_image_vectors piv
        WHERE piv.product_id = NEW.product_id
          AND NOT EXISTS (SELECT 1 FROM desired d WHERE d.file_id = piv.file_id)
    )
    INSERT INTO product_image_vectors AS piv (product_id, file_id, image_url, variant_id, position)
    SELECT NEW.product_id, d.file_id, d.image_url, d.variant_id, d.position
    FROM desired d
    ON CONFLICT (product_id, file_id) DO UPDATE
       SET image_url       = EXCLUDED.image_url,
           variant_id      = EXCLUDED.variant_id,
           position        = EXCLUDED.position,
           status          = CASE WHEN piv.status = 'failed' AND piv.image_url <> EXCLUDED.image_url
                                  THEN 'pending' ELSE piv.status END,
           attempts        = CASE WHEN piv.status = 'failed' AND piv.image_url <> EXCLUDED.image_url
                                  THEN 0 ELSE piv.attempts END,
           last_error      = CASE WHEN piv.status = 'failed' AND piv.image_url <> EXCLUDED.image_url
                                  THEN NULL ELSE piv.last_error END,
           next_attempt_at = CASE WHEN piv.status = 'failed' AND piv.image_url <> EXCLUDED.image_url
                                  THEN now() ELSE piv.next_attempt_at END
     -- Without this every sync would rewrite every row: dead tuples for nothing.
     WHERE (piv.image_url, piv.variant_id, piv.position)
           IS DISTINCT FROM (EXCLUDED.image_url, EXCLUDED.variant_id, EXCLUDED.position);

    RETURN NULL;
END
$$;

-- CREATE OR REPLACE TRIGGER needs PostgreSQL 14+ (vector_db is 17.11). One
-- statement each, so the schema applier can give each its own node.
CREATE OR REPLACE TRIGGER product_vectors_images_insert
    AFTER INSERT ON product_vectors
    FOR EACH ROW EXECUTE FUNCTION product_image_vectors_sync();

-- INSERT ... ON CONFLICT DO UPDATE fires the UPDATE trigger for a re-index.
CREATE OR REPLACE TRIGGER product_vectors_images_update
    AFTER UPDATE OF metadata ON product_vectors
    FOR EACH ROW
    WHEN (OLD.metadata->'image_files' IS DISTINCT FROM NEW.metadata->'image_files')
    EXECUTE FUNCTION product_image_vectors_sync();


-- ── the drainer's two calls: claim, then settle ────────────────────────────
-- Same idempotency idea as jovi-mall's vectorisationJob.jobId: a claim stamps
-- claim_id, and settle only writes rows still carrying THAT claim_id. A late
-- settle -- after the claim went stale and another run re-took the row, or after
-- a re-index removed the image -- matches nothing, and the returned rows say so.
--
-- ⚠ ONE VOYAGE FAILURE FAILS THE WHOLE REQUEST. If one URL in a batch cannot be
-- fetched, every image in the batch comes back failed. So fresh work is claimed
-- in batches, but a RETRY is always claimed ALONE: a bad image fails its
-- batch-mates once, then each is retried by itself, the good ones succeed and the
-- bad one exhausts its attempts without taking anybody else down with it.
--
-- ⚠ Ordered by position first: every product's primary image is embedded before
-- any product's second one. At one request a minute that is the difference
-- between a catalogue that is visually searchable in an hour and one that is
-- fully embedded for a few products and absent for the rest.

-- Drop-then-create for the same reason as product_search below: a signature
-- change must not leave an overload behind.
DO $drop_image_fns$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT oid::regprocedure AS sig
        FROM pg_proc
        WHERE proname IN ('product_image_claim', 'product_image_settle')
          AND pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE 'DROP FUNCTION ' || r.sig;
    END LOOP;
END
$drop_image_fns$;

CREATE FUNCTION product_image_claim(
    p_claim_id     text,
    p_max_images   int      DEFAULT 2,
    p_max_attempts int      DEFAULT 5,
    p_stale_after  interval DEFAULT interval '10 minutes'
)
RETURNS TABLE (product_id text, file_id text, image_url text, attempts int)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
BEGIN
    IF coalesce(p_claim_id, '') = '' THEN
        RAISE EXCEPTION 'product_image_claim: p_claim_id is required';
    END IF;

    -- An execution that died between claim and settle leaves rows 'claimed'
    -- forever. Recovering them COUNTS as an attempt: an image that kills its run
    -- every time must still stop being retried.
    UPDATE product_image_vectors piv
       SET status          = 'failed',
           attempts        = piv.attempts + 1,
           last_error      = 'claim abandoned: nothing settled it within ' || p_stale_after::text,
           next_attempt_at = now(),
           claim_id        = NULL,
           claimed_at      = NULL
     WHERE piv.status = 'claimed'
       AND piv.claimed_at < now() - p_stale_after;

    -- Fresh work, as many as the batch allows. Only products currently active:
    -- an archived product's photos wait rather than spend the budget.
    RETURN QUERY
    WITH picked AS (
        SELECT piv.product_id, piv.file_id
        FROM product_image_vectors piv
        JOIN product_vectors pv ON pv.product_id = piv.product_id
        WHERE piv.status = 'pending'
          AND piv.attempts = 0
          AND piv.next_attempt_at <= now()
          AND pv.status = 'active'
        ORDER BY piv.position, piv.created_at, piv.product_id, piv.file_id
        LIMIT greatest(p_max_images, 1)
        FOR UPDATE OF piv SKIP LOCKED
    )
    UPDATE product_image_vectors t
       SET status = 'claimed', claim_id = p_claim_id, claimed_at = now()
      FROM picked
     WHERE t.product_id = picked.product_id AND t.file_id = picked.file_id
    RETURNING t.product_id, t.file_id, t.image_url, t.attempts;

    IF FOUND THEN
        RETURN;
    END IF;

    -- Nothing fresh: exactly ONE retry, alone. See the header.
    RETURN QUERY
    WITH picked AS (
        SELECT piv.product_id, piv.file_id
        FROM product_image_vectors piv
        JOIN product_vectors pv ON pv.product_id = piv.product_id
        WHERE piv.status IN ('pending', 'failed')
          AND piv.attempts > 0
          AND piv.attempts < p_max_attempts
          AND piv.next_attempt_at <= now()
          AND pv.status = 'active'
        ORDER BY piv.next_attempt_at, piv.position
        LIMIT 1
        FOR UPDATE OF piv SKIP LOCKED
    )
    UPDATE product_image_vectors t
       SET status = 'claimed', claim_id = p_claim_id, claimed_at = now()
      FROM picked
     WHERE t.product_id = picked.product_id AND t.file_id = picked.file_id
    RETURNING t.product_id, t.file_id, t.image_url, t.attempts;
END
$$;

-- p_results: [{ product_id, file_id, outcome, embedding?, error?, image_pixels? }]
--   outcome 'embedded'  → the vector is stored; it must be 1024 numbers or the
--                         whole call fails, which is correct -- the assembling
--                         node checks the count and the dimension before this
--   outcome 'deferred'  → NOT the image's fault: a 429, a Voyage 5xx, a refused
--                         credential, a timeout. Back to pending in a minute and
--                         NOT counted as an attempt -- otherwise one afternoon of
--                         Voyage outage would exhaust every image in the queue
--   anything else       → failed, attempts + 1, retried after 2^attempts minutes
--                         (1, 2, 4, 8 ...) up to p_max_attempts in the claim.
--                         Reserved for what the IMAGE caused: Voyage could not
--                         fetch it, or refused it as an image
-- 'embedded' with no embedding is treated as a failure rather than trusted.
-- Returns the rows actually written -- verify the ROW, never the node.
CREATE FUNCTION product_image_settle(p_claim_id text, p_results jsonb)
RETURNS TABLE (product_id text, file_id text, status text, attempts int)
LANGUAGE sql
AS $$
WITH r AS (
    SELECT x.product_id AS r_product_id,
           x.file_id    AS r_file_id,
           CASE WHEN x.outcome = 'embedded' AND x.embedding IS NOT NULL THEN 'embedded'
                WHEN x.outcome = 'deferred'  THEN 'deferred'
                ELSE 'failed' END AS r_outcome,
           x.embedding  AS r_embedding,
           CASE WHEN x.outcome = 'embedded' AND x.embedding IS NULL
                THEN 'reported embedded without an embedding'
                ELSE left(x.error, 2000) END AS r_error,
           x.image_pixels AS r_image_pixels
    FROM jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
         AS x(product_id text, file_id text, outcome text,
              embedding vector(1024), error text, image_pixels bigint)
)
UPDATE product_image_vectors piv
   SET status          = CASE r.r_outcome WHEN 'embedded'  THEN 'embedded'
                                          WHEN 'deferred'  THEN 'pending'
                                          ELSE 'failed' END,
       embedding       = CASE WHEN r.r_outcome = 'embedded' THEN r.r_embedding END,
       embedded_at     = CASE WHEN r.r_outcome = 'embedded' THEN now() ELSE piv.embedded_at END,
       image_pixels    = CASE WHEN r.r_outcome = 'embedded' THEN r.r_image_pixels ELSE piv.image_pixels END,
       attempts        = CASE WHEN r.r_outcome = 'failed' THEN piv.attempts + 1 ELSE piv.attempts END,
       last_error      = CASE WHEN r.r_outcome = 'embedded' THEN NULL ELSE r.r_error END,
       next_attempt_at = CASE r.r_outcome
                             WHEN 'embedded'  THEN piv.next_attempt_at
                             WHEN 'deferred'  THEN now() + interval '1 minute'
                             ELSE now() + least(interval '1 minute' * power(2, piv.attempts),
                                                interval '1 day')
                         END,
       claim_id        = NULL,
       claimed_at      = NULL
  FROM r
 WHERE piv.product_id = r.r_product_id
   AND piv.file_id    = r.r_file_id
   AND piv.claim_id   = p_claim_id
   AND piv.status     = 'claimed'
RETURNING piv.product_id, piv.file_id, piv.status, piv.attempts;
$$;

-- Where the images stand -- the first thing to run when photo search seems thin:
--
--   SELECT status, count(*) AS images,
--          count(*) FILTER (WHERE attempts >= 5) AS gave_up,
--          min(next_attempt_at) FILTER (WHERE status <> 'embedded') AS next_due
--   FROM product_image_vectors GROUP BY status;


-- ═══════════════════════════════════════════════════════════════════════════
-- product_image_query_cache — query vectors for the IMAGE arm.
--
-- Same shape and same UPDATE ... RETURNING lookup as product_search_query_cache,
-- and a separate table for the reason the image vectors are: this is
-- voyage-multimodal-3.5, that is voyage-4, and a row from one answering a lookup
-- for the other returns confident nonsense rather than failing.
--
--   query_key = 'text:'  || <the same normalised key the text cache uses>
--             | 'photo:' || <sha256 of the photo bytes, hex>
--
-- A photo key is a hash, never the bytes: a customer forwarding the same promo
-- picture twice costs one Voyage call, and no photo is stored here.
--
-- ⚠ TRUNCATE this table in the same change as any change of multimodal model or
-- dimension -- the rule stated above for the text cache, for the same reason.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS product_image_query_cache (
    query_key    text PRIMARY KEY,
    embedding    vector(1024) NOT NULL,
    hits         bigint      NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_image_query_cache_last_used_idx
    ON product_image_query_cache (last_used_at);


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
-- Seventeen parameters (fourteen until the image arm, § 15), fifteen of them
-- optional, is a positional call waiting to break. It already did: inserting
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
--     p_in_stock_only => false,
--     -- the image arm, optional -- omit all three and it sits out:
--     p_image_embedding    => $3::vector(1024),  -- voyage-multimodal-3.5, input_type=query
--     p_max_image_distance => <MEASURED floor>   -- never omit when p_image_embedding is set
--   );
--
-- A photo with no words: pass NULL for $1 and '' for $2. The three text arms
-- then find nothing and the image arm alone ranks.
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
    p_in_stock_only    boolean DEFAULT false,
    -- The image arm (README § 15). Appended LAST so every existing named-argument
    -- call is untouched. NULL embedding = the arm is off, which is the default.
    p_image_embedding    vector(1024) DEFAULT NULL,   -- voyage-multimodal-3.5, input_type=query
    p_image_weight       float        DEFAULT 1.0,
    p_max_image_distance float        DEFAULT NULL
)
RETURNS TABLE (
    product_id    text,
    title         text,
    product_text  text,
    metadata      jsonb,
    score         float,
    semantic_rank int,
    keyword_rank  int,
    fuzzy_rank    int,
    image_rank    int
)
LANGUAGE sql
STABLE
AS $$
WITH filtered AS (
    -- ⚠ Referenced by every arm, so PostgreSQL MATERIALISES it (a CTE used more
    -- than once is not inlined). The consequence, measured 2026-09-21 with
    -- EXPLAIN on PG 17.11 + pgvector 0.8.6: the semantic arm below is a
    -- sequential scan plus sort over this CTE, NOT an HNSW index scan -- the
    -- index on product_vectors.embedding is never reached from here. At today's
    -- catalogue size that is exact search at millisecond cost, and exact is more
    -- accurate than HNSW. It stops being free somewhere in the tens of thousands
    -- of products; README § 15 records it.
    SELECT pv.id, pv.product_id, pv.embedding, pv.tsv, pv.title
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
    --
    -- p_query_embedding may be NULL: a photo with no words is a search with no
    -- text vector, and this arm simply sits out.
    SELECT f.id,
           ROW_NUMBER() OVER (ORDER BY f.embedding <=> p_query_embedding)::int AS rank
    FROM filtered f
    WHERE p_query_embedding IS NOT NULL
      AND f.embedding IS NOT NULL
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
image AS (
    -- What the product LOOKS like. The query vector is either a customer's photo
    -- or their words embedded by the same multimodal model -- both land in the
    -- space the product photos were embedded in. A product is as close as its
    -- CLOSEST photo: one good angle is a match, and averaging would let five
    -- unrelated shots bury it.
    --
    -- An exact scan over the images of FILTERED products, not an HNSW scan: the
    -- filters apply first, so the pgvector filter hazard described in the header
    -- cannot starve this arm. See the product_image_vectors note on when that
    -- stops being cheap.
    --
    -- ⚠ Like the semantic arm, it has no natural floor, and it is worse here: for
    -- a TEXT query a cross-modal nearest neighbour always exists. Without
    -- p_max_image_distance, "chaussures de sport" against a catalogue with no
    -- shoes gets five confident pictures of something else -- the § 14 failure,
    -- back through a new door. Callers must pass a MEASURED floor, and the
    -- text-query floor and the photo-query floor are different numbers.
    SELECT f.id,
           ROW_NUMBER() OVER (ORDER BY min(piv.embedding <=> p_image_embedding))::int AS rank
    FROM filtered f
    JOIN product_image_vectors piv ON piv.product_id = f.product_id
    WHERE p_image_embedding IS NOT NULL
      AND piv.embedding IS NOT NULL
    GROUP BY f.id
    HAVING p_max_image_distance IS NULL
        OR min(piv.embedding <=> p_image_embedding) <= p_max_image_distance
    ORDER BY min(piv.embedding <=> p_image_embedding)
    LIMIT p_candidate_pool
),
candidates AS (
    SELECT id FROM semantic
    UNION
    SELECT id FROM keyword
    UNION
    SELECT id FROM fuzzy
    UNION
    SELECT id FROM image
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
          + COALESCE(1.0 / (p_rrf_k + z.rank), 0.0) * p_fuzzy_weight
          + COALESCE(1.0 / (p_rrf_k + i.rank), 0.0) * p_image_weight)::float AS f_score,
           s.rank AS f_semantic_rank,
           k.rank AS f_keyword_rank,
           z.rank AS f_fuzzy_rank,
           i.rank AS f_image_rank
    FROM candidates c
    JOIN product_vectors pv ON pv.id = c.id
    LEFT JOIN semantic s ON s.id = c.id
    LEFT JOIN keyword  k ON k.id = c.id
    LEFT JOIN fuzzy    z ON z.id = c.id
    LEFT JOIN image    i ON i.id = c.id
)
SELECT fused.f_product_id,
       fused.f_title,
       fused.f_text,
       fused.f_metadata,
       fused.f_score,
       fused.f_semantic_rank,
       fused.f_keyword_rank,
       fused.f_fuzzy_rank,
       fused.f_image_rank
FROM fused
ORDER BY fused.f_score DESC, fused.f_indexed_at DESC
LIMIT p_match_count;
$$;

-- The three per-arm ranks are returned on purpose. The weights above are the one
-- part of this that cannot be reasoned to a correct value — they have to be
-- tuned by looking at real queries, and a result set that says WHICH arm found
-- each row is the difference between tuning and guessing. A caller shipping to a
-- customer drops the three columns; a caller tuning keeps them.
