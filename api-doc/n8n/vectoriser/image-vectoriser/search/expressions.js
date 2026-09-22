// The n8n expressions the product-search changes use, kept here so test.js can
// evaluate them exactly as stored. Each is the literal parameter value.

// Run Hybrid Search → options.queryReplacement
// Named references, never $json: this node is reached by three paths (image arm
// off, image cache hit, fresh image embed), and the text vector arrived before
// all of them, through `Text Vector Ready`.
const RUN_HYBRID_SEARCH_REPLACEMENT = `={{ (() => {
  const n = $('Normalise Query').first().json;
  const text = $('Text Vector Ready').first().json.embedding || null;
  let image = null;
  if ($('Shape Image Vector').isExecuted) image = $('Shape Image Vector').first().json.image_embedding || null;
  else if ($('Image Cache Lookup').isExecuted) image = $('Image Cache Lookup').first().json.image_embedding || null;
  return [text, n.query, n.limit, n.country, n.category, n.maxPrice, n.inStockOnly, n.maxDistance, image, image ? n.imageMaxDistance : null];
})() }}`;

const RUN_HYBRID_SEARCH_QUERY = `SELECT product_id, title, product_text, score, semantic_rank, keyword_rank, fuzzy_rank, image_rank
FROM product_search(
  $1::vector(1024),
  $2,
  p_match_count        => $3::int,
  p_country            => $4,
  p_category           => $5,
  p_price_max          => $6::numeric,
  p_in_stock_only      => $7::boolean,
  p_max_distance       => $8::float,
  p_image_embedding    => $9::vector(1024),
  p_max_image_distance => $10::float
);`;

// Embed Image Query → jsonBody. The bytes are read from whichever entry ran --
// Search Request in production, Test Query from the editor's Test Run -- so the
// photo path can be exercised by hand. A photo goes as base64 (it came from the chat,
// there is no public URL for it); words go as text. input_type is QUERY -- the
// product photos were embedded as 'document'.
const EMBED_IMAGE_QUERY_BODY = `={{ JSON.stringify({ model: 'voyage-multimodal-3.5', input_type: 'query', inputs: [ { content: [ $('Normalise Query').first().json.has_photo ? { type: 'image_base64', image_base64: 'data:' + $('Normalise Query').first().json.photo_mime + ';base64,' + String(($('Search Request').isExecuted ? $('Search Request') : $('Test Query')).first().json.photoBase64).trim().replace(/^data:[^,]*,/, '') } : { type: 'text', text: $('Normalise Query').first().json.query } ] } ] }) }}`;

const IMAGE_CACHE_LOOKUP_QUERY = `UPDATE product_image_query_cache
   SET hits = hits + 1, last_used_at = now()
 WHERE query_key = $1
   AND last_used_at > now() - interval '30 days'
RETURNING embedding::text AS image_embedding;`;
const IMAGE_CACHE_LOOKUP_REPLACEMENT = `={{ [$('Normalise Query').first().json.image_query_key] }}`;

// Both parameters are CAST, and cast the same way every time they appear: an
// untyped $1 inside IS NOT NULL is "could not determine data type" (measured).
// A photo's key is null, so it never reaches the table (owner decision: the
// customer's photo is searched and dropped, not saved -- nor is its vector).
const CACHE_IMAGE_EMBEDDING_QUERY = `INSERT INTO product_image_query_cache (query_key, embedding)
SELECT $1::text, $2::vector(1024)
WHERE $1::text IS NOT NULL AND $2::vector(1024) IS NOT NULL
ON CONFLICT (query_key) DO UPDATE
   SET embedding = EXCLUDED.embedding, last_used_at = now()
RETURNING query_key;`;
const CACHE_IMAGE_EMBEDDING_REPLACEMENT = `={{ [$json.image_query_key, $json.image_embedding] }}`;

const HAS_TEXT_CONDITION = `={{ $('Normalise Query').first().json.has_text === true }}`;
const IMAGE_ARM_CONDITION = `={{ $('Normalise Query').first().json.image_arm === true }}`;
const IMAGE_CACHED_CONDITION = `={{ $json.image_embedding != null && $json.image_embedding !== "" }}`;

module.exports = {
  RUN_HYBRID_SEARCH_REPLACEMENT, RUN_HYBRID_SEARCH_QUERY, EMBED_IMAGE_QUERY_BODY,
  IMAGE_CACHE_LOOKUP_QUERY, IMAGE_CACHE_LOOKUP_REPLACEMENT,
  CACHE_IMAGE_EMBEDDING_QUERY, CACHE_IMAGE_EMBEDDING_REPLACEMENT,
  HAS_TEXT_CONDITION, IMAGE_ARM_CONDITION, IMAGE_CACHED_CONDITION,
};
