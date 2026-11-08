const fs = require('fs');
const S = __dirname;
const w = JSON.parse(fs.readFileSync(S + '/vectoriser-before-677326ee.json', 'utf8')).workflow;
const code = (n) => w.nodes.find((x) => x.name === n).parameters.jsCode;
const must = (s, a) => { if (s.split(a).length !== 2) throw new Error('anchor not unique/absent: ' + a.slice(0, 60)); };
const NL = 'String.fromCharCode(10)';

// ── normalise json payload ──
let norm = code('normalise json payload');
const nA = "  const p = list[i] || {};\n";
must(norm, nA);
norm = norm.replace(nA, nA + [
  "  // A SERVICE LISTING (SERVICE-LISTINGS-PLAN L-18, 2026-11-08). jovi-mall sends `kind: 'listing'` and",
  "  // `listing_id`, never `product_id`. It is keyed `listing:<id>` from here on, so it shares the",
  "  // product_vectors upsert and delete without ever colliding with a product. Always a full payload:",
  "  // there is no listing reference to resolve.",
  "  if (p.kind === 'listing') {",
  "    const lid = String(p.listing_id || '').trim();",
  "    if (!lid) { out.push({ json: { source: 'json', mode: 'reject', product_id: null, reason: 'no listing_id on entry ' + i } }); continue; }",
  "    if (!p.title) { out.push({ json: { source: 'json', mode: 'reject', product_id: 'listing:' + lid, reason: 'listing payload has no title' } }); continue; }",
  "    out.push({ json: { source: 'json', mode: 'full', product_id: 'listing:' + lid, product: p, callback_url_requested: envelope.callbackUrl || envelope.callback_url || null } });",
  "    continue;",
  "  }",
  "",
].join('\n') + '\n');

// ── build all texts ──
let build = code('build all texts');
const bA = "function emptyDebug() {";
must(build, bA);
const listingFn = [
  "// ── buildListingText(p): a SERVICE LISTING (SERVICE-LISTINGS-PLAN L-18, L-26, 2026-11-08) ──",
  "// jovi-mall's listing payload holds public fields only: no contact, no vendor block, no pin. The",
  "// row is keyed `listing:<id>`, typed `listing` (so a product-type filter never returns it) and",
  "// carries no price and no stock (a price or in-stock filter excludes it, which is right: a",
  "// listing is not sold). No `image_files`: listing photos are not in the image arm in v1.",
  "function buildListingText(p) {",
  "  const id = clean(p.listing_id);",
  "  const title = clean(p.title);",
  "  const company = clean(p.company_name);",
  "  const categories = (Array.isArray(p.categories) ? p.categories : []).map(clean).filter(Boolean);",
  "  const category = clean(p.category) || categories[0] || null;",
  "  const place = [clean(p.area), clean(p.city), country(p.country)].filter(Boolean).join(', ');",
  "  const lines = [];",
  "  lines.push('Service listing: ' + title + (company ? ', by ' + company : '') + '.');",
  "  lines.push('A local business that provides this service in person. The customer unlocks its contact details on Wi-Mall; nothing is bought through Wi-Mall.');",
  "  if (categories.length) lines.push('Categories: ' + list(categories) + '.');",
  "  if (place) lines.push('Location: ' + place + '.');",
  "  const hours = (Array.isArray(p.opening_hours) ? p.opening_hours : []).map(function (h) {",
  "    if (!h || !h.day) return '';",
  "    const day = clean(h.day).charAt(0).toUpperCase() + clean(h.day).slice(1);",
  "    return h.is_closed ? day + ' closed' : day + ' ' + clean(h.open_time) + '-' + clean(h.close_time);",
  "  }).filter(Boolean);",
  "  if (hours.length) lines.push('Opening hours: ' + hours.join('; ') + '.');",
  "  const description = clean(p.description);",
  "  if (description) lines.push('Description: ' + description);",
  "  lines.push('Reference: listing ' + id + ', slug ' + clean(p.slug) + '.');",
  "  let text = lines.join(" + NL + ").trim();",
  "  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 3) + '...';",
  "  const images = (Array.isArray(p.images) ? p.images : []).map(function (f) { return f && typeof f.url === 'string' ? clean(f.url) : ''; }).filter(Boolean);",
  "  const metadata = {",
  "    product_id: 'listing:' + id,",
  "    kind: 'listing',",
  "    listing_id: id,",
  "    title: title,",
  "    slug: clean(p.slug),",
  "    type: 'listing',",
  "    status: 'active',",
  "    category: category,",
  "    categories: categories,",
  "    tags: [],",
  "    vendor_id: null,",
  "    vendor_name: company || null,",
  "    country: clean(p.country) || null,",
  "    city: clean(p.city) || null,",
  "    area: clean(p.area) || null,",
  "    currency: null,",
  "    price_min: null,",
  "    price_max: null,",
  "    in_stock: null,",
  "    bargainable: false,",
  "    variant_count: 0,",
  "    primary_image: images.length ? images[0] : null,",
  "    images: images.slice(0, 5),",
  "  };",
  "  return { text: text, metadata: metadata };",
  "}",
  "",
  "",
].join('\n');
build = build.replace(bA, listingFn + bA);
const bB = "    const built = buildProductText(p);";
must(build, bB);
build = build.replace(bB, "    const built = p.kind === 'listing' ? buildListingText(p) : buildProductText(p);");

// ── compose report ──
let comp = code('compose report');
const cA = "const results = $input.all().map(function (i) {\n  const r = i.json || {};\n  return {";
must(comp, cA);
comp = comp.replace(cA, [
  "const results = $input.all().map(function (i) {",
  "  const r = i.json || {};",
  "  // A service listing is reported as jovi-mall's listing row (`kind: 'listing'`, `listing_id`), which",
  "  // the callback splits off to the listing service before the product half is read (2026-11-08).",
  "  const pid = String(r.product_id || '');",
  "  if (pid.indexOf('listing:') === 0) {",
  "    return { kind: 'listing', listing_id: pid.slice(8), status: r.status, vectorised_id: r.vectorised_id || null, error: r.error || null, tokens: r.token_estimate, tokens_are_estimated: r.tokens_are_estimated };",
  "  }",
  "  return {",
].join('\n'));

const accept = "={{ JSON.stringify({ success: true, job_id: $execution.id, accepted: $('accept job').all().filter(i => i.json.accepted).map(i => String(i.json.product_id).indexOf('listing:') === 0 ? String(i.json.product_id).slice(8) : i.json.product_id), rejected: $('accept job').all().filter(i => !i.json.accepted).map(i => String(i.json.product_id || '').indexOf('listing:') === 0 ? ({ kind: 'listing', listing_id: String(i.json.product_id).slice(8), reason: i.json.reason }) : ({ product_id: i.json.product_id, reason: i.json.reason })), callback_url: $('accept job').first().json.callback_url }) }}";
const del = "={{ [$json.body.kind === 'listing' ? 'listing:' + String($json.body.listing_id || '') : $json.body.product_id] }}";
for (const [f, t] of [['normalise.js', norm], ['build.js', build], ['compose.js', comp], ['accept.expr', accept], ['delete.expr', del]]) fs.writeFileSync(S + '/' + f, t);
console.log('ok', norm.length, build.length, comp.length, 'backslash in new listing text:', listingFn.includes('\\'));
