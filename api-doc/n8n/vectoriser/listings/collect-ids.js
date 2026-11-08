// Collapses the ranked rows into ONE item, so the hydration call runs once with
// a comma list rather than once per product. It also carries the RRF order
// forward: /products/by-ids answers in the order it is asked, so the ranking
// survives hydration without anything having to re-sort it.
//
// SERVICE LISTINGS (SERVICE-LISTINGS-PLAN § n8n, 2026-11-08) are rows keyed `listing:<id>`. They
// are not products: a listing has no price and no stock, and /products/by-ids does not know it.
// So they are kept OUT of the hydration and carried to `Add Listings`, after Shape Result. When
// only listings matched, the hydration still runs, on a placeholder id: an empty `ids` is a 400,
// and that error output would drop the whole answer to the keyword fallback.
const all = $input.all().map(function (i) { return i.json; })
  .filter(function (r) { return r && r.product_id; });
const isListing = function (r) { return String(r.product_id).indexOf("listing:") === 0; };
const rows = all.filter(function (r) { return !isListing(r); });
const listingRows = all.filter(isListing);
const ids = rows.map(function (r) { return r.product_id; }).join(",");

return [{ json: {
  ids: ids || "000000000000000000000000",
  rows: rows,
  listing_rows: listingRows,
} }];
