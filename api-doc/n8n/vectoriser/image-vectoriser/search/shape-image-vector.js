// Turns the voyage-multimodal-3.5 answer into ONE vector string, or null.
//
// ⚠ It NEVER throws, unlike Shape Vector. The image arm is best-effort: when the
// multimodal call fails -- a 429 on the free tier above all -- the search goes on
// with its three text arms exactly as it did before the image arm existed. A
// customer must not lose a search because the photo half could not answer.
//
// A vector that is not 1024 finite numbers is refused rather than passed on: the
// arm would rank the catalogue against noise, and a floor cannot catch that.
const res = $input.first().json || {};
const first = Array.isArray(res.data) ? res.data[0] : null;
const e = first && first.embedding;
const ok = Array.isArray(e) && e.length === 1024 && e.every(Number.isFinite);
const n = $("Normalise Query").first().json;

return [{ json: {
  image_embedding: ok ? "[" + e.join(",") + "]" : null,
  // null for a photo: photos are never cached (owner decision 2026-09-21).
  image_query_key: n.image_query_key,
  image_error: ok ? null : String(res.detail || (res.error && (res.error.message || res.error)) || "no embedding returned").slice(0, 300),
  image_tokens: (res.usage && typeof res.usage.total_tokens === "number") ? res.usage.total_tokens : null,
} }];
