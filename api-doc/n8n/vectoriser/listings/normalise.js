// The backend posts ONE payload object, or an array of them, or {products:[...]}.
// It also -- optionally -- names where to report back. Everything downstream sees
// the same three fields, so nothing after this node knows which shape arrived.
const raw = $input.first().json || {};
const body = raw.body !== undefined ? raw.body : raw;

let list = [];
let envelope = {};
if (Array.isArray(body)) {
  list = body;
} else if (body && Array.isArray(body.products)) {
  list = body.products;
  envelope = body;
} else if (body && typeof body === 'object') {
  list = [body];
  envelope = body;
}

const out = [];
for (let i = 0; i < list.length; i++) {
  const p = list[i] || {};
  // A SERVICE LISTING (SERVICE-LISTINGS-PLAN L-18, 2026-11-08). jovi-mall sends `kind: 'listing'` and
  // `listing_id`, never `product_id`. It is keyed `listing:<id>` from here on, so it shares the
  // product_vectors upsert and delete without ever colliding with a product. Always a full payload:
  // there is no listing reference to resolve.
  if (p.kind === 'listing') {
    const lid = String(p.listing_id || '').trim();
    if (!lid) { out.push({ json: { source: 'json', mode: 'reject', product_id: null, reason: 'no listing_id on entry ' + i } }); continue; }
    if (!p.title) { out.push({ json: { source: 'json', mode: 'reject', product_id: 'listing:' + lid, reason: 'listing payload has no title' } }); continue; }
    out.push({ json: { source: 'json', mode: 'full', product_id: 'listing:' + lid, product: p, callback_url_requested: envelope.callbackUrl || envelope.callback_url || null } });
    continue;
  }

  const id = String(p.product_id || p.productId || p._id || p.id || '').trim();
  if (!id) {
    out.push({ json: { source: 'json', mode: 'reject', product_id: null, reason: 'no product_id on entry ' + i } });
    continue;
  }
  // A payload with a title and variants is complete; anything less is a
  // reference we have to go and resolve against jovi-mall.
  const full = !!p.title && Array.isArray(p.variants);
  out.push({ json: {
    source: 'json',
    mode: full ? 'full' : 'id',
    product_id: id,
    product: full ? p : null,
    callback_url_requested: envelope.callbackUrl || envelope.callback_url || null,
  } });
}
return out;