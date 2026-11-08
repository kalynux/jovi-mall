// `_debug` carries every product's full embedded text for the data table. It is
// stripped HERE, deliberately: the callback is a per-product OUTCOME report, and
// posting the whole catalogue's prose back to jovi-mall would make that request
// enormous to tell it nothing it asked for.
const results = $input.all().map(function (i) {
  const r = i.json || {};
  // A service listing is reported as jovi-mall's listing row (`kind: 'listing'`, `listing_id`), which
  // the callback splits off to the listing service before the product half is read (2026-11-08).
  const pid = String(r.product_id || '');
  if (pid.indexOf('listing:') === 0) {
    return { kind: 'listing', listing_id: pid.slice(8), status: r.status, vectorised_id: r.vectorised_id || null, error: r.error || null, tokens: r.token_estimate, tokens_are_estimated: r.tokens_are_estimated };
  }
  return {
    product_id: r.product_id,
    status: r.status,
    vectorised_id: r.vectorised_id,
    error: r.error,
    tokens: r.token_estimate,
    tokens_are_estimated: r.tokens_are_estimated,
  };
});

const succeeded = results.filter(function (r) { return r.status === 'completed'; });
const tokensTotal = results.reduce(function (a, r) { return a + (r.tokens || 0); }, 0);

// The chunk TOTAL from the provider is exact; the per-product split is only
// proportional unless a chunk held one product. So the sum below is exact
// whenever every chunk reported usage, and the flag describes the SPLIT.
const anyEstimated = results.some(function (r) { return r.tokens_are_estimated !== false; });

return [{ json: {
  job_id: $execution.id,
  finished_at: new Date().toISOString(),
  total: results.length,
  succeeded: succeeded.length,
  failed: results.length - succeeded.length,
  tokens_total: tokensTotal,
  tokens_are_estimated: anyEstimated,
  results: results,
} }];