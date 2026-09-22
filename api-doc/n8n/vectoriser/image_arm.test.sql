-- ═══════════════════════════════════════════════════════════════════════════
-- image_arm.test.sql — behaviour proofs for the image arm (README § 15).
--
-- Runs against a THROWAWAY pgvector/pgvector:pg17 container, never vector_db:
-- it TRUNCATEs product_image_vectors and writes t-prefixed products.
--
--   docker run -d --name pv-test -e POSTGRES_PASSWORD=t pgvector/pgvector:pg17
--   docker cp product_vectors.sql pv-test:/tmp/pv.sql
--   docker cp image_arm.test.sql  pv-test:/tmp/t.sql
--   docker exec pv-test psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/pv.sql
--   docker exec pv-test psql -U postgres -q -f /tmp/t.sql 2>&1 | grep -E "pass:|FAIL|ALL"
--
-- (Git Bash: export MSYS_NO_PATHCONV=1 first, or /tmp becomes a Windows path.)
--
-- 47 checks, stops at the first failure. Four guards were proven to BITE on
-- 2026-09-21 by applying a broken copy of the schema: the churn guard (1e), the
-- settle claim-id match (3e), retry isolation (4b) and the image floor (6f).
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP 1
SET client_min_messages = warning;

-- a unit vector pointing mostly along dimension k, with a little spread so that
-- vectors are NOT mutually orthogonal (orthogonal fixtures put every distance at
-- 1.0 and every tie breaks arbitrarily -- the trap the README records).
CREATE OR REPLACE FUNCTION t_vec(k int, mix int DEFAULT NULL, w float DEFAULT 0.0)
RETURNS vector LANGUAGE sql IMMUTABLE AS $$
  SELECT l2_normalize(array(
    SELECT CASE WHEN i = k THEN 1.0
                WHEN mix IS NOT NULL AND i = mix THEN w
                ELSE 0.01 END
    FROM generate_series(1,1024) i)::vector)
$$;
CREATE OR REPLACE FUNCTION t_check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE WARNING 'pass: %', label;
END $$;
CREATE OR REPLACE FUNCTION t_meta(pid text, images jsonb, status text DEFAULT 'active', country text DEFAULT 'CM', title text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('product_id', pid, 'title', coalesce(title, 'Test product ' || pid), 'status', status,
    'country', country, 'type', 'physical', 'category', 'test', 'price_min', 5000, 'in_stock', true,
    'bargain_windows', jsonb_build_array(jsonb_build_object('minPrice', 4000, 'maxPrice', 6000)),
    'image_files', images)
$$;
CREATE OR REPLACE FUNCTION t_upsert(pid text, images jsonb, status text DEFAULT 'active', country text DEFAULT 'CM', title text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO product_vectors (text, metadata, embedding)
  VALUES ('text of ' || pid, t_meta(pid, images, status, country, title), t_vec(900))
  ON CONFLICT (product_id) DO UPDATE SET text = EXCLUDED.text, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding
$$;
CREATE OR REPLACE FUNCTION t_img(fid text, variant text DEFAULT NULL, host text DEFAULT 'https://cdn.example')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('file_id', fid, 'url', host || '/images/' || fid || '.jpg', 'variant_id', variant, 'mime_type', 'image/jpeg')
$$;

-- ── 1 · the sync trigger ────────────────────────────────────────────────────
SELECT t_upsert('tA', jsonb_build_array(
  t_img('a1'), t_img('a2', 'vA'), t_img('a1'),                      -- a1 duplicated
  jsonb_build_object('file_id', 'bad', 'url', 'ftp://x/y.jpg'),      -- not http(s)
  jsonb_build_object('url', 'https://cdn.example/no-id.jpg'),        -- no file id
  '"just a string"'::jsonb));
SELECT t_check((SELECT count(*) FROM product_image_vectors WHERE product_id = 'tA') = 2, '1a insert: 2 valid distinct images out of 6 entries');
SELECT t_check((SELECT position FROM product_image_vectors WHERE product_id = 'tA' AND file_id = 'a1') = 0, '1b gallery image keeps position 0');
SELECT t_check((SELECT variant_id FROM product_image_vectors WHERE product_id = 'tA' AND file_id = 'a2') = 'vA', '1c variant id carried');
SELECT t_check((SELECT bool_and(status = 'pending' AND attempts = 0) FROM product_image_vectors WHERE product_id = 'tA'), '1d new rows are pending');

CREATE TEMP TABLE t_x AS SELECT file_id, xmin::text AS x FROM product_image_vectors WHERE product_id = 'tA';
SELECT t_upsert('tA', jsonb_build_array(t_img('a1'), t_img('a2', 'vA'), t_img('a1')));  -- same list, different junk
UPDATE product_vectors SET metadata = metadata || '{"price_min": 7000}'::jsonb WHERE product_id = 'tA';
SELECT t_check((SELECT count(*) FROM product_image_vectors p JOIN t_x USING (file_id) WHERE p.product_id = 'tA' AND p.xmin::text = t_x.x) = 2,
               '1e re-index with the same images rewrites NO image row');

SELECT t_upsert('tA', jsonb_build_array(t_img('a1'), t_img('a3')));
SELECT t_check((SELECT array_agg(file_id ORDER BY file_id) FROM product_image_vectors WHERE product_id = 'tA') = ARRAY['a1','a3'], '1f removed image deleted, added image inserted');
SELECT t_upsert('tA', '[]'::jsonb);
SELECT t_check((SELECT count(*) FROM product_image_vectors WHERE product_id = 'tA') = 0, '1g empty list clears the product''s images');
UPDATE product_vectors SET metadata = metadata - 'image_files' WHERE product_id = 'tA';
SELECT t_check((SELECT count(*) FROM product_image_vectors WHERE product_id = 'tA') = 0, '1h missing images key = no images, no error');

-- URL move: embedded keeps its vector, failed gets a fresh start
SELECT t_upsert('tA', jsonb_build_array(t_img('a1'), t_img('a2')));
UPDATE product_image_vectors SET status = 'embedded', embedding = t_vec(10) WHERE product_id = 'tA' AND file_id = 'a1';
UPDATE product_image_vectors SET status = 'failed', attempts = 3, last_error = '404', next_attempt_at = now() + interval '1 hour' WHERE product_id = 'tA' AND file_id = 'a2';
SELECT t_upsert('tA', jsonb_build_array(t_img('a1', NULL, 'https://cdn2.example'), t_img('a2', NULL, 'https://cdn2.example')));
SELECT t_check((SELECT status = 'embedded' AND embedding IS NOT NULL AND image_url LIKE 'https://cdn2%' FROM product_image_vectors WHERE product_id = 'tA' AND file_id = 'a1'),
               '1i URL move keeps an embedded image''s vector');
SELECT t_check((SELECT status = 'pending' AND attempts = 0 AND last_error IS NULL AND next_attempt_at <= now() FROM product_image_vectors WHERE product_id = 'tA' AND file_id = 'a2'),
               '1j URL move resets a failed image');

-- /status style archive (jsonb_set on metadata, images untouched) does not touch image rows
DELETE FROM t_x; INSERT INTO t_x SELECT file_id, xmin::text FROM product_image_vectors WHERE product_id = 'tA';
UPDATE product_vectors SET metadata = jsonb_set(metadata, '{status}', '"archived"') WHERE product_id = 'tA';
SELECT t_check((SELECT count(*) FROM product_image_vectors p JOIN t_x USING (file_id) WHERE p.product_id = 'tA' AND p.xmin::text = t_x.x) = 2,
               '1k /status archive leaves image rows alone');
UPDATE product_vectors SET metadata = jsonb_set(metadata, '{status}', '"active"') WHERE product_id = 'tA';

DELETE FROM product_vectors WHERE product_id = 'tA';
SELECT t_check((SELECT count(*) FROM product_image_vectors WHERE product_id = 'tA') = 0, '1l /delete cascades to the images');

-- ── 2 · claim ───────────────────────────────────────────────────────────────
TRUNCATE product_image_vectors;
SELECT t_upsert('tB', jsonb_build_array(t_img('b1'), t_img('b2')));
SELECT t_upsert('tC', jsonb_build_array(t_img('c1'), t_img('c2')));
SELECT t_upsert('tD', jsonb_build_array(t_img('d1'), t_img('d2')));
SELECT t_upsert('tZ', jsonb_build_array(t_img('z1')), 'archived');

CREATE TEMP TABLE t_c1 AS SELECT * FROM product_image_claim('run-1', p_max_images => 2);
SELECT t_check((SELECT count(*) FROM t_c1) = 2, '2a claims p_max_images rows');
SELECT t_check((SELECT bool_and(file_id LIKE '_1') FROM t_c1), '2b primary images first, across products (fairness)');
SELECT t_check((SELECT count(*) FROM product_image_vectors WHERE claim_id = 'run-1' AND status = 'claimed') = 2, '2c claimed rows stamped');
CREATE TEMP TABLE t_c2 AS SELECT * FROM product_image_claim('run-2', p_max_images => 2);
SELECT t_check((SELECT count(*) FROM t_c2 WHERE file_id LIKE '_1') = 1 AND (SELECT count(*) FROM t_c2) = 2,
               '2d second run takes the last primary, then a second image');
SELECT t_check(NOT EXISTS (SELECT 1 FROM t_c1 JOIN t_c2 USING (product_id, file_id)), '2e no row claimed twice');
SELECT t_check(NOT EXISTS (SELECT 1 FROM product_image_vectors WHERE product_id = 'tZ' AND status <> 'pending'), '2f archived product''s images are not claimed');
DO $$ BEGIN PERFORM * FROM product_image_claim(''); RAISE EXCEPTION 'FAIL: empty claim id accepted'; EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF; RAISE WARNING 'pass: 2g empty claim id refused'; END $$;

-- ── 3 · settle ──────────────────────────────────────────────────────────────
-- run-1 settles: one embedded, one failed
CREATE TEMP TABLE t_s1 AS
SELECT * FROM product_image_settle('run-1', (
  SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'file_id', file_id,
           'outcome', CASE WHEN n = 1 THEN 'embedded' ELSE 'failed' END,
           'embedding', CASE WHEN n = 1 THEN to_jsonb(t_vec(20)::real[]) END,
           'error', CASE WHEN n = 2 THEN 'Voyage 400: could not fetch image' END,
           'image_pixels', 1000000))
  FROM (SELECT *, row_number() OVER (ORDER BY product_id) n FROM t_c1) q));
SELECT t_check((SELECT count(*) FROM t_s1) = 2, '3a settle returns the rows it wrote');
SELECT t_check((SELECT count(*) FROM product_image_vectors WHERE status = 'embedded' AND embedding IS NOT NULL AND image_pixels = 1000000 AND claim_id IS NULL) = 1, '3b embedded row stored');
SELECT t_check((SELECT attempts = 1 AND last_error LIKE 'Voyage 400%' AND next_attempt_at > now() + interval '50 seconds'
                FROM product_image_vectors WHERE status = 'failed'), '3c failed row: attempt counted, backed off ~1 min');

-- a second settle of the same claim is a no-op (duplicate delivery)
SELECT t_check((SELECT count(*) FROM product_image_settle('run-1', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'file_id', file_id, 'outcome', 'failed')) FROM t_c1))) = 0,
               '3d duplicate settle writes nothing');
-- a settle under the wrong claim id is a no-op
SELECT t_check((SELECT count(*) FROM product_image_settle('run-X', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'file_id', file_id, 'outcome', 'failed')) FROM t_c2))) = 0,
               '3e foreign claim id writes nothing');

-- run-2: one deferred (a 429), one "embedded" with no embedding
CREATE TEMP TABLE t_s2 AS
SELECT * FROM product_image_settle('run-2', (
  SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'file_id', file_id,
           'outcome', CASE WHEN n = 1 THEN 'deferred' ELSE 'embedded' END, 'error', CASE WHEN n = 1 THEN '429' END))
  FROM (SELECT *, row_number() OVER (ORDER BY product_id) n FROM t_c2) q));
SELECT t_check((SELECT count(*) FROM t_s2 WHERE status = 'pending' AND attempts = 0) = 1, '3f deferred: back to pending, NOT an attempt');
SELECT t_check((SELECT count(*) FROM t_s2 WHERE status = 'failed' AND attempts = 1) = 1, '3g "embedded" without a vector is refused as a failure');

-- wrong dimension fails the whole call and writes nothing
CREATE TEMP TABLE t_c3 AS SELECT * FROM product_image_claim('run-3', p_max_images => 1);
DO $$ BEGIN
  PERFORM * FROM product_image_settle('run-3', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'file_id', file_id, 'outcome', 'embedded', 'embedding', '[1,2,3]'::jsonb)) FROM t_c3));
  RAISE EXCEPTION 'FAIL: a 3-dim embedding was accepted';
EXCEPTION WHEN data_exception THEN RAISE WARNING 'pass: 3h wrong dimension refused (%)', SQLERRM; END $$;
SELECT t_check((SELECT bool_and(status = 'claimed') FROM product_image_vectors p JOIN t_c3 USING (product_id, file_id)), '3i ...and left the claim untouched');

-- ── 4 · retries are claimed ALONE, fresh work first ─────────────────────────
UPDATE product_image_vectors SET next_attempt_at = now() - interval '1 second' WHERE status IN ('pending','failed');
-- fresh work still exists → a fresh batch, no retry mixed in
CREATE TEMP TABLE t_c4 AS SELECT * FROM product_image_claim('run-4', p_max_images => 5);
SELECT t_check((SELECT bool_and(attempts = 0) FROM t_c4) AND (SELECT count(*) FROM t_c4) >= 1, '4a fresh work is preferred and never mixed with retries');
SELECT product_image_settle('run-4', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'file_id', file_id, 'outcome', 'embedded', 'embedding', to_jsonb(t_vec(30)::real[]))) FROM t_c4));
UPDATE product_image_vectors SET next_attempt_at = now() - interval '1 second' WHERE status IN ('pending','failed');
CREATE TEMP TABLE t_c5 AS SELECT * FROM product_image_claim('run-5', p_max_images => 5);
SELECT t_check((SELECT count(*) FROM t_c5) = 1 AND (SELECT attempts FROM t_c5) > 0, '4b with no fresh work, exactly ONE retry is claimed');

-- ── 5 · abandoned claims and exhaustion ─────────────────────────────────────
UPDATE product_image_vectors SET claimed_at = now() - interval '11 minutes' WHERE claim_id = 'run-5';
CREATE TEMP TABLE t_before AS SELECT product_id, file_id, attempts FROM product_image_vectors WHERE claim_id = 'run-5';
CREATE TEMP TABLE t_c6 AS SELECT * FROM product_image_claim('run-6', p_max_images => 1);
-- (the recovered row may be re-claimed by run-6 itself; what matters is that the
-- abandonment was COUNTED and recorded, and the old claim id is gone)
SELECT t_check((SELECT p.attempts = b.attempts + 1 AND p.last_error LIKE 'claim abandoned%' AND p.claim_id IS DISTINCT FROM 'run-5'
                FROM product_image_vectors p JOIN t_before b USING (product_id, file_id)), '5a stale claim recovered AND counted as an attempt');
SELECT t_check((SELECT count(*) FROM product_image_settle('run-5', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'file_id', file_id, 'outcome', 'embedded', 'embedding', to_jsonb(t_vec(40)::real[]))) FROM t_before))) = 0,
               '5c a settle arriving after its claim went stale writes nothing');
UPDATE product_image_vectors SET status = 'failed', attempts = 5, next_attempt_at = now() - interval '1 second', claim_id = NULL, claimed_at = NULL WHERE status <> 'embedded';
SELECT t_check((SELECT count(*) FROM product_image_claim('run-7', p_max_images => 5)) = 0, '5b exhausted images are never claimed again');

-- ── 6 · product_search with the image arm ───────────────────────────────────
DELETE FROM product_vectors WHERE product_id LIKE 't%';
SELECT t_upsert('tRed',  jsonb_build_array(t_img('r1'), t_img('r2'), t_img('r3')), 'active',   'CM', 'Robe rouge a fleurs');
SELECT t_upsert('tBlue', jsonb_build_array(t_img('b1')),                            'active',   'CM', 'Chemise bleue');
SELECT t_upsert('tArch', jsonb_build_array(t_img('x1')),                            'archived', 'CM', 'Ancienne lampe');
SELECT t_upsert('tUS',   jsonb_build_array(t_img('u1')),                            'active',   'US', 'Casquette');
SELECT t_upsert('tPend', jsonb_build_array(t_img('p1')),                            'active',   'CM', 'Tabouret');
UPDATE product_image_vectors SET status = 'embedded', embedding = CASE file_id
    WHEN 'r1' THEN t_vec(100) WHEN 'r2' THEN t_vec(101) WHEN 'b1' THEN t_vec(200)
    WHEN 'x1' THEN t_vec(300) WHEN 'u1' THEN t_vec(400) END
 WHERE file_id IN ('r1','r2','b1','x1','u1');   -- r3 and p1 stay pending

CREATE TEMP TABLE t_q0 AS SELECT * FROM product_search(t_vec(900), 'chemise', p_match_count => 10);
SELECT t_check((SELECT count(*) FROM t_q0) > 0 AND (SELECT bool_and(image_rank IS NULL) FROM t_q0), '6a arm is OFF by default: an existing call is unchanged');

CREATE TEMP TABLE t_q1 AS SELECT * FROM product_search(NULL, '', p_match_count => 5, p_image_embedding => t_vec(200));
SELECT t_check((SELECT product_id FROM t_q1 ORDER BY score DESC LIMIT 1) = 'tBlue', '6b photo-only search: the matching product ranks first');
SELECT t_check((SELECT bool_and(semantic_rank IS NULL AND keyword_rank IS NULL AND fuzzy_rank IS NULL) FROM t_q1), '6c photo-only: the three text arms sit out');

CREATE TEMP TABLE t_q2 AS SELECT * FROM product_search(NULL, '', p_match_count => 5, p_image_embedding => t_vec(101));
SELECT t_check((SELECT product_id FROM t_q2 ORDER BY score DESC LIMIT 1) = 'tRed', '6d a product is as close as its CLOSEST photo');

SELECT t_check((SELECT count(*) FROM product_search(NULL, '', p_match_count => 5, p_image_embedding => t_vec(700))) > 0,
               '6e (the hazard) with no floor, a photo that matches nothing still returns products');
SELECT t_check((SELECT count(*) FROM product_search(NULL, '', p_match_count => 5, p_image_embedding => t_vec(700), p_max_image_distance => 0.2)) = 0,
               '6f with a floor, it returns nothing');
SELECT t_check((SELECT count(*) FROM product_search(NULL, '', p_match_count => 5, p_image_embedding => t_vec(200), p_max_image_distance => 0.2)) = 1,
               '6g ...while a genuine match still comes back');

SELECT t_check(NOT EXISTS (SELECT 1 FROM product_search(NULL, '', p_match_count => 50, p_image_embedding => t_vec(300)) WHERE product_id = 'tArch'),
               '6h an archived product is never returned by the image arm');
SELECT t_check(NOT EXISTS (SELECT 1 FROM product_search(NULL, '', p_match_count => 50, p_image_embedding => t_vec(400), p_country => 'CM') WHERE product_id = 'tUS'),
               '6i filters apply to the image arm (country)');
SELECT t_check(EXISTS (SELECT 1 FROM product_search(NULL, '', p_match_count => 50, p_image_embedding => t_vec(400)) WHERE product_id = 'tUS'),
               '6j ...and without the filter it is found');
SELECT t_check(NOT EXISTS (SELECT 1 FROM product_search(NULL, '', p_match_count => 50, p_image_embedding => t_vec(700)) WHERE product_id = 'tPend'),
               '6k a product whose photos are still pending is not in the image arm');
SELECT t_check(NOT EXISTS (SELECT 1 FROM product_search(NULL, '', p_match_count => 50, p_image_embedding => t_vec(100)) WHERE metadata ? 'bargain_windows'),
               '6l bargain_windows still stripped on image-arm results');

-- fusion: words + photo agreeing beat either alone
CREATE TEMP TABLE t_q3 AS SELECT * FROM product_search(t_vec(900), 'robe rouge', p_match_count => 5, p_image_embedding => t_vec(100));
SELECT t_check((SELECT product_id FROM t_q3 ORDER BY score DESC LIMIT 1) = 'tRed'
               AND (SELECT image_rank = 1 AND keyword_rank IS NOT NULL FROM t_q3 WHERE product_id = 'tRed'),
               '6m text + photo: the product both arms agree on ranks first, found by both');
SELECT t_check((SELECT score FROM t_q3 WHERE product_id = 'tRed') > (SELECT max(score) FROM t_q3 WHERE product_id <> 'tRed'),
               '6n ...with a strictly higher fused score');

-- the image arm's plan: filters first, no HNSW needed, no seq scan over the fillers' images
EXPLAIN (COSTS OFF) SELECT * FROM product_search(NULL, '', p_image_embedding => t_vec(100));

\echo ALL IMAGE-ARM CHECKS PASSED
