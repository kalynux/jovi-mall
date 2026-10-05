// A LISTING of jovi-mall's live catalogue under the customer's filters, shaped by
// the same allowlist as Shape Result (2026-10-05). It answers two questions, and
// which one is decided by the path that reached it:
//
// 1. BROWSE -- "products under 10k". The customer named a budget or a category and
//    nothing to search for. These ARE the answer, so they go in `products`.
//
// 2. ALTERNATIVES -- "red shoes under 10k" and no red shoes exist. The search
//    found nothing; these are OTHER products within the same budget/category. They
//    go in `alternatives`, NEVER in `products`, and `count` stays 0 -- `count`
//    means "matched what was asked for", and a model reading 5 there would present
//    a kettle as the red shoes. Owner decision: alternatives are offered, and they
//    are always CLEARLY labelled as alternatives.
//
// Live data, so the prices are the ones the customer is quoted.
const n = $("Normalise Query").first().json;
const isAlternatives = $("Shape Fallback Result").isExecuted;
const body = $input.first().json || {};
const list = Array.isArray(body.data) ? body.data : [];

// THE FALLBACK IS THE PRODUCTION STOREFRONT -- this URL is put in front of a CUSTOMER.
let base = "https://wi-mall.com";
try { base = String(($env && $env.STOREFRONT_BASE_URL) || "https://wi-mall.com").replace(/\/+$/, ""); } catch (e) { base = "https://wi-mall.com"; }

// jovi-mall already filtered on ?maxPrice=, against the displayed price. Checked
// again because this answer is put in front of a customer as "within your budget",
// and the check costs nothing.
const items = list
  .filter(function (p) { return n.maxPrice == null || typeof p.price !== "number" || p.price <= n.maxPrice; })
  .map(function (p) {
    const path = "/shop/stores/" + p.store.slug + "/products/" + p.slug;
    return {
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
      snippet: null,
    };
  });

const filters = [];
if (n.maxPrice != null) filters.push("priced at most " + n.maxPrice + " XAF");
if (n.category != null) filters.push('in the category "' + n.category + '"');
if (n.inStockOnly) filters.push("in stock");
const within = filters.join(", ");
// Real matches above the budget, from the hybrid search (Shape Result), if it ran.
const aboveBudget = $("Shape Result").isExecuted ? ($("Shape Result").first().json.aboveBudget || []) : [];
const aboveNote = aboveBudget.length === 0 ? ""
  : " " + aboveBudget.length + " product(s) matching what they asked for DO exist above the budget, under aboveBudget: mention them first, WITH their price, as over budget.";
const order = n.browse_sort === "price_desc" ? " Listed from the highest price within the budget down." : "";

if (isAlternatives) {
  const fallback = $("Shape Fallback Result").first().json;
  return [{ json: {
    query: n.query,
    source: fallback.source,
    searchedPhoto: n.has_photo,
    count: 0,
    products: [],
    alternatives: items,
    aboveBudget: aboveBudget,
    note: (items.length === 0
      ? "No products matched, and there are no other products " + within + " to suggest."
      : 'NOTHING matched "' + n.query + '" ' + within + '. The ' + items.length + " alternatives are NOT what the customer asked for: "
        + "they are other products " + within + ". Tell the customer clearly that you found no " + n.query + " " + within
        + ", then offer these as alternatives. Never present an alternative as a match.") + aboveNote,
  } }];
}

return [{ json: {
  query: n.query,
  source: "browse",
  searchedPhoto: false,
  count: items.length,
  products: items,
  alternatives: [],
  aboveBudget: [],
  note: items.length === 0
    ? "No products are " + within + "."
    : "The customer named no particular product, so these are products " + within + "." + order
      + " There may be more: offer to narrow down by what they are looking for.",
} }];
