// THE ALLOWLIST. Everything the agent sees is built here, field by field.
//
// Two reasons it is an allowlist and not a passthrough of the index row:
//
// 1. metadata.bargain_windows is the NEGOTIATING HAND -- minPrice IS the selling
//    price and maxPrice the haggling ceiling. product_search() already strips
//    it, and this never reads metadata at all, so leaking it into a
//    customer-facing model context would take two independent mistakes.
// 2. product_text is 500-900 characters of generated prose per product. Five of
//    those is 4 KB of context for no benefit, so only a short snippet survives.
//
// PRICE AND STOCK COME FROM THE HYDRATION, NEVER FROM THE INDEX. The index is a
// snapshot; stock in particular only refreshes when a product is re-vectorised.
const collected = $("Collect Ids").first().json;
const rows = collected.rows || [];
const body = $input.first().json || {};
const hydrated = (body.data && body.data.products) || [];
const n = $("Normalise Query").first().json;

const byId = {};
hydrated.forEach(function (p) { byId[p.id] = p; });

// $env is readable because the container sets N8N_BLOCK_ENV_ACCESS_IN_NODE=false.
// THE FALLBACK IS THE PRODUCTION STOREFRONT, and that matters more here than anywhere
// else in the bot: this URL is put in front of a CUSTOMER. An empty base used to yield
// url: null, and a dev value would send them to a laptop.
let base = "https://wi-mall.com";
try { base = String(($env && $env.STOREFRONT_BASE_URL) || "https://wi-mall.com").replace(/\/+$/, ""); } catch (e) { base = "https://wi-mall.com"; }

function snippetOf(t) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

// ⚠ THE BUDGET IS CHECKED AGAINST THE LIVE PRICE (2026-10-05). product_search()
// filters on the INDEXED price -- a snapshot, and on a bargainable product the
// vendor's floor rather than the price the customer is quoted -- so "under 7 000"
// could return a bottle the storefront shows at 7 500. `p.price` is the price
// the card displays, which is exactly what jovi-mall's own ?maxPrice= filters on
// (public-catalog.repository.mongo.ts), so both paths apply one rule.
const aboveBudget = [];
const products = [];
rows.forEach(function (r) {
  const p = byId[r.product_id];
  // Absent from the hydration means no longer publishable -- archived, suspended
  // or deleted since it was indexed. Dropping it here is the freshness gate.
  if (!p) { return; }
  const path = "/shop/stores/" + p.store.slug + "/products/" + p.slug;
  // A real match priced over the budget is NOT dropped silently: it goes to
  // aboveBudget, which every later answer carries, so the bot can say "we have one
  // at 7 500, just above your budget" rather than "we have no water bottle".
  const overBudget = n.maxPrice != null && typeof p.price === "number" && p.price > n.maxPrice;
  (overBudget ? aboveBudget : products).push({
    id: p.id,
    title: p.title,
    price: p.price,
    currency: p.currency,
    priceRange: p.priceRange || null,
    compareAtPrice: p.compareAtPrice == null ? null : p.compareAtPrice,
    inStock: p.inStock,
    category: p.category,
    store: p.store.name,
    rating: p.rating || null,
    image: p.image ? p.image.url : null,
    url: base ? base + path : null,
    path: path,
    snippet: snippetOf(r.product_text),
  });
});

const dropped = rows.length - products.length - aboveBudget.length;

// ── What the photo did (README § 15) ────────────────────────────────────────
// A photo match finds THE SAME item in another picture, not look-alikes
// (measured: a different car sat further from a Porsche photo than an empty
// road did). So the agent is told to CONFIRM, never to assert "this is it".
const imageFailed = n.has_photo && $("Shape Image Vector").isExecuted
  && !$("Shape Image Vector").first().json.image_embedding;
const notes = [];
if (dropped > 0) notes.push(String(dropped) + " match(es) were withdrawn from sale and omitted.");
if (aboveBudget.length > 0) notes.push(String(aboveBudget.length) + " match(es) cost more than the customer's budget of " + n.maxPrice + " XAF: they are under aboveBudget. You may mention them WITH their price, never as within budget.");
if (n.has_photo && imageFailed) notes.push("The customer's photo could not be searched just now; these matched their words only.");
else if (n.has_photo && products.length > 0) notes.push("Found using the customer's photo. A photo match finds the same item in another picture, not look-alikes -- confirm with the customer that this is the item they mean. Show it to them with Show-Products first, so they can compare it with their picture.");

return [{ json: {
  query: n.query,
  source: "hybrid",
  searchedPhoto: n.has_photo,
  count: products.length,
  products: products,
  alternatives: [],
  aboveBudget: aboveBudget,
  note: products.length === 0 ? "No products matched." : (notes.length ? notes.join(" ") : null),
} }];
