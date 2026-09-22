// The same allowlist as Shape Result, over jovi-mall's own $text search.
//
// This path runs when the semantic half could not answer: Voyage returned no
// vector, vector_db was unreachable, the hydration failed, or the hybrid search
// matched nothing. It is a WEAKER search -- Mongo $text is whole-word with no
// stemming, so "dres" will not find "dress" -- but it is live jovi-mall data, so
// the prices are right and the customer still gets an answer.
//
// `source` says which engine answered. The agent does not brief the customer on
// it; it is here so a human reading an execution can tell a degraded turn from a
// healthy one.
const n = $("Normalise Query").first().json;

// ⚠ NO WORDS, NO KEYWORD SEARCH. A photo sent without a caption reaches here when
// the image arm found nothing (or could not run). jovi-mall answers an EMPTY
// query with a plain listing, and relaying it would present five unrelated
// products as if they matched the picture -- the exact failure the relevance
// floors exist to prevent. So an empty query answers "nothing", honestly.
if (!n.has_text) {
  const imageFailed = n.has_photo && $("Shape Image Vector").isExecuted
    && !$("Shape Image Vector").first().json.image_embedding;
  return [{ json: {
    query: n.query,
    source: n.has_photo ? "photo" : "none",
    searchedPhoto: n.has_photo,
    count: 0,
    products: [],
    note: !n.has_photo
      ? "Nothing to search for: no words and no photo."
      : (imageFailed
        ? "The photo could not be searched just now. Ask the customer to describe the item in words."
        : "No products matched this photo."),
  } }];
}

const body = $input.first().json || {};
const list = Array.isArray(body.data) ? body.data : [];

// THE FALLBACK IS THE PRODUCTION STOREFRONT -- this URL is put in front of a CUSTOMER.
// An empty base used to yield url: null, and a dev value would send them to a laptop.
let base = "https://wi-mall.com";
try { base = String(($env && $env.STOREFRONT_BASE_URL) || "https://wi-mall.com").replace(/\/+$/, ""); } catch (e) { base = "https://wi-mall.com"; }

const products = list.map(function (p) {
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

return [{ json: {
  query: n.query,
  source: "keyword",
  searchedPhoto: n.has_photo,
  count: products.length,
  products: products,
  note: products.length === 0
    ? "No products matched."
    : (n.has_photo ? "These matched the customer's words only; the photo did not find a match." : null),
} }];
