// SERVICE LISTINGS in the hybrid answer (SERVICE-LISTINGS-PLAN § n8n, 2026-11-08).
//
// product_search() returns a listing as a row keyed `listing:<id>`. Collect Ids kept those rows
// out of the price hydration, and they are added back HERE, after Shape Result, so its product
// allowlist (the bargaining floor never reaches the model) is untouched.
//
// A listing is a local business the customer contacts directly; nothing is bought. The index
// holds no contact detail (jovi-mall's listing payload carries none, L-26), so nothing here can
// leak one, and the note tells the model the only thing it may do: draw the cards with
// listings_display. A contact is unlocked only by the customer's tap.
const shaped = $input.first().json || {};
const rows = $("Collect Ids").first().json.listing_rows || [];

function snippetOf(t) {
  const s = String(t || "").split(String.fromCharCode(10)).join(" ").trim();
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

const listings = rows.map(function (r) {
  return { kind: "listing", listingId: String(r.product_id).slice(8), title: r.title, snippet: snippetOf(r.product_text) };
});

if (listings.length === 0) {
  return [{ json: shaped }];
}

const note = listings.length + " service listing(s) matched: local businesses the customer contacts directly, not products for sale. "
  + "Show them with listings_display, passing their listingId values in this order. Never pass a listingId to Show-Products, "
  + "never present a listing as a product, and never state a phone number, WhatsApp, address or any other contact for one.";
const productCount = Array.isArray(shaped.products) ? shaped.products.length : 0;

return [{ json: Object.assign({}, shaped, {
  count: productCount + listings.length,
  listings: listings,
  note: productCount === 0 ? note : [shaped.note, note].filter(Boolean).join(" "),
}) }];
