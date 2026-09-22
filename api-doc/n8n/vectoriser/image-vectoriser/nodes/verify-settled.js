// ── verify settled ──────────────────────────────────────────────────────────
// Code node, "Run Once for All Items". Input: the rows product_image_settle()
// RETURNED. `settle images` has alwaysOutputData on, so zero rows still arrives
// here as one empty item -- which is the case this node exists to catch.
//
// Verify the ROW, never the node (README § 10): the Postgres node reporting
// success means the statement ran, not that it wrote anything.
//
// It THROWS in two situations, so the run lands on the automation failure board
// through this workflow's errorWorkflow:
//   · fewer rows written than outcomes sent. Either the claim went stale (the run
//     took over 10 minutes and another run re-took the images) or a re-index
//     removed an image mid-flight. The second is harmless; the first is not, and
//     from here the two cannot be told apart.
//   · an alarm from `assemble results`: a refused credential, a Voyage outage, or
//     no answer at all. Nothing was lost -- the images were deferred, not failed --
//     but it will not fix itself.
// A 429 does NOT throw. On the free tier it is weather, not an incident.

const sent = $('assemble results').first().json;
const written = $input.all().map(i => i.json).filter(r => r && r.product_id && r.file_id);

const count = (status) => written.filter(r => r.status === status).length;
const summary = {
  claim_id: sent.claim_id,
  voyage_status: sent.status,
  tokens: sent.tokens,
  sent: sent.results.length,
  written: written.length,
  embedded: count('embedded'),
  failed: count('failed'),
  deferred: count('pending'),
};

if (written.length !== sent.results.length) {
  throw new Error(
    `image vectoriser: settled ${written.length} of ${sent.results.length} images for claim ${sent.claim_id}. ` +
    'Either the claim went stale (this run took longer than the 10-minute claim window) or a re-index ' +
    'removed the image meanwhile (harmless). ' + JSON.stringify(summary),
  );
}
if (sent.alarm) {
  throw new Error(`image vectoriser: ${sent.alarm} -- ${summary.deferred} image(s) deferred, none lost. ` + JSON.stringify(summary));
}

return [{ json: summary }];
