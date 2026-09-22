// ── build embed request ─────────────────────────────────────────────────────
// Code node, "Run Once for All Items". Input: the rows product_image_claim()
// returned (0 rows never reaches here -- the Postgres node emits nothing and the
// run ends). Output: ONE item carrying the claim and the Voyage request body.
//
// The image goes to Voyage as its URL, and Voyage fetches it. The bytes never
// pass through n8n, which keeps this workflow's memory flat however large the
// photos are. The cost of that choice: the URL must be reachable from the public
// internet -- true of the R2 CDN in production, never true of a dev laptop's
// storage (which is why `build all texts` only lists https URLs).
//
// input_type 'document' -- the search side embeds with 'query'. Voyage's
// embeddings are asymmetric; see README § 11.

const claimId = $('mint claim id').first().json.claim_id;
const rows = $input.all()
  .map(i => i.json)
  .filter(r => r && r.product_id && r.file_id && r.image_url);

if (rows.length === 0) {
  // The claim returned rows the filter above refused. Nothing to embed, and
  // nothing to settle: those rows stay 'claimed' and the claim function's stale
  // recovery returns them in 10 minutes, counted as an attempt.
  return [];
}

return [{
  json: {
    claim_id: claimId,
    rows: rows.map(r => ({
      product_id: String(r.product_id),
      file_id: String(r.file_id),
      image_url: String(r.image_url),
      attempts: Number(r.attempts) || 0,
    })),
    body: {
      model: 'voyage-multimodal-3.5',
      input_type: 'document',
      inputs: rows.map(r => ({ content: [{ type: 'image_url', image_url: String(r.image_url) }] })),
    },
  },
}];
