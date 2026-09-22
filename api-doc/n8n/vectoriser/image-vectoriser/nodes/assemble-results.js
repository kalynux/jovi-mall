// ── assemble results ────────────────────────────────────────────────────────
// Code node, "Run Once for All Items". Turns Voyage's answer into one settle
// payload: an outcome for EVERY claimed row, never fewer -- a row left out of
// the settle stays 'claimed' until stale recovery, and that costs it an attempt
// it did not deserve.
//
// `embed images` runs with neverError + fullResponse, and onError
// continueRegularOutput, so this node always receives exactly one item:
//   { statusCode, headers, body }   an HTTP answer, whatever its status
//   { error }                       no HTTP answer at all (DNS, timeout, reset)
//
// ⚠ WHOSE FAULT IT WAS DECIDES THE OUTCOME, because only 'failed' spends an
// attempt (product_image_settle):
//   200                       → embedded, per row, after the count + dimension guards
//   400 / 413 / 415 / 422     → failed   -- the request carried something Voyage
//                                refused, and the only variable part is the images
//   429                       → deferred -- the free tier's 3 RPM / 10K TPM
//   401 / 403 / 5xx / other   → deferred, AND an alarm: nothing is lost, but a
//                                refused credential or an outage is a human's job
//   no answer                 → deferred, AND an alarm
//
// ⚠ A batch that fails with a 400 fails EVERY image in it, including the good
// ones: Voyage rejects the request, not the input. That is why the claim takes
// retries one at a time -- the second attempt of each image is alone, and only
// the bad one keeps failing.

const EXPECTED_DIMS = 1024;           // vector(1024) in product_image_vectors
const IMAGE_FAULT = new Set([400, 413, 415, 422]);

const req = $('build embed request').first().json;
const { claim_id, rows } = req;
const res = $input.first().json || {};

const describe = (body) => {
  if (body == null) return '';
  if (typeof body === 'string') return body.slice(0, 500);
  return String(body.detail ?? body.error?.message ?? body.message ?? JSON.stringify(body)).slice(0, 500);
};
const everyRow = (outcome, error) => rows.map(r => ({ product_id: r.product_id, file_id: r.file_id, outcome, error }));

let results;
let alarm = null;
const status = Number(res.statusCode) || 0;

if (!status) {
  const why = res.error?.message ?? res.error ?? 'no response';
  results = everyRow('deferred', `transport: ${String(why).slice(0, 300)}`);
  alarm = `Voyage unreachable: ${String(why).slice(0, 300)}`;
} else if (status === 429) {
  results = everyRow('deferred', `429: ${describe(res.body)}`);
} else if (IMAGE_FAULT.has(status)) {
  results = everyRow('failed', `${status}: ${describe(res.body)}`);
} else if (status !== 200) {
  results = everyRow('deferred', `${status}: ${describe(res.body)}`);
  alarm = `Voyage answered ${status}: ${describe(res.body)}`;
} else {
  const data = Array.isArray(res.body?.data) ? res.body.data.slice().sort((a, b) => a.index - b.index) : [];
  if (data.length !== rows.length) {
    // Never pair by position on a mismatch: a vector attached to the wrong image
    // makes a product findable by somebody else's photo. README § 11's rule.
    results = everyRow('failed', `Voyage returned ${data.length} embeddings for ${rows.length} images`);
  } else {
    // image_pixels is per REQUEST. Exact for a one-image request; for more, the
    // split between images is unknown and a guessed split is worse than none.
    const pixels = rows.length === 1 ? Number(res.body?.usage?.image_pixels) || null : null;
    results = rows.map((r, i) => {
      const e = data[i]?.embedding;
      const ok = Array.isArray(e) && e.length === EXPECTED_DIMS && e.every(Number.isFinite);
      return ok
        ? { product_id: r.product_id, file_id: r.file_id, outcome: 'embedded', embedding: e, image_pixels: pixels }
        : { product_id: r.product_id, file_id: r.file_id, outcome: 'failed',
            error: `embedding malformed: ${Array.isArray(e) ? e.length + ' dims' : typeof e}` };
    });
  }
}

return [{
  json: {
    claim_id,
    status,
    alarm,
    tokens: Number(res.body?.usage?.total_tokens) || null,
    results,
  },
}];
