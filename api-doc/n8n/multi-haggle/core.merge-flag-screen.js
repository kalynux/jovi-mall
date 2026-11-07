// The open-haggles flag, rewritten from what was there a moment ago (2026-10-25). It used to hold
// ONE product and every write replaced it; it now holds a LIST, newest first, each item with its
// own 30-minute expiry, and the top-level fields mirror the newest item so a reader of the old
// shape keeps working. `read bargain flag` decides which item a message is about.
//
// ⚠ Read-then-write, a few milliseconds apart. Two Bargain taps landing in the same instant could
// lose one of them -- the same exposure the reply journal accepts, and a human tap is seconds apart.
const MAX_ITEMS = 5;
const TTL_MS = 30 * 60 * 1000;
const nowMs = Date.now();

function parse(raw) {
  try { return raw ? JSON.parse(String(raw)) : null; } catch (e) { return null; }
}
function openItems(flag) {
  let list = [];
  if (flag && Array.isArray(flag.items)) {
    list = flag.items;
  } else if (flag && flag.variantId) {
    list = [{ productId: flag.productId || null, variantId: flag.variantId, quantity: flag.quantity || 1, title: flag.title || '', askedAt: flag.askedAt || flag.expiresAt, expiresAt: flag.expiresAt }];
  }
  return list.filter(function (i) { return !!i && !!i.variantId && !!i.expiresAt && new Date(i.expiresAt).getTime() > nowMs; });
}
function flagValue(items) {
  const kept = items.slice(0, MAX_ITEMS);
  const top = kept[0] || null;
  let latest = 0;
  kept.forEach(function (i) { const t = new Date(i.expiresAt).getTime(); if (t > latest) latest = t; });
  // An empty list is written with an expiry in the past rather than deleted: every reader treats a
  // lapsed flag as absent, and it keeps this one node instead of a branch.
  return JSON.stringify({
    v: 2,
    items: kept,
    variantId: top ? top.variantId : null,
    productId: top ? top.productId : null,
    quantity: top ? (top.quantity || 1) : 1,
    expiresAt: new Date(latest || (nowMs - 1000)).toISOString(),
  });
}

// A Bargain pressed on the product SCREEN, handed over by `sync identity` as `pendingBargain`.
const p = (($('sync identity').first().json || {}).data || {}).pendingBargain || {};
const prev = openItems(parse($input.first().json.prevFlag));
const items = prev.filter(function (i) { return String(i.variantId) !== String(p.variantId); });
items.unshift({
  productId: p.productId || null,
  variantId: p.variantId,
  quantity: Number(p.quantity) || 1,
  title: String(p.productTitle || ''),
  askedAt: new Date(nowMs).toISOString(),
  expiresAt: new Date(nowMs + TTL_MS).toISOString(),
});
return [{ json: { value: flagValue(items) } }];
