// Builds the new `build all texts` body from the LIVE one by anchored insertion,
// and proves the only change to its output is metadata.image_files.
//
//   node patch-build-all-texts.js <live-build-all-texts.js> <out.js>
//
// Each anchor must match EXACTLY ONCE, or this throws -- a patch that silently
// matched nothing would leave the new body equal to the live one and every check
// below would pass against the wrong subject (deploy-day-harness rule 1).
const fs = require('fs');
const path = require('path');
const { runCode } = require('../../deploy-day-harness/n8n-sim.js');

const [liveFile, outFile] = process.argv.slice(2);
const live = fs.readFileSync(liveFile, 'utf8');

const once = (src, anchor, replacement) => {
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`anchor matched ${n} times: ${anchor.slice(0, 70)}`);
  return src.replace(anchor, replacement);
};

// The function, exactly as tested. Its file header (which explains how the file
// is pasted HERE) and its module.exports line are not carried into the node;
// the header is replaced by one line saying what the function is for.
const src = fs.readFileSync(path.join(__dirname, 'nodes', 'embeddable-images.js'), 'utf8');
const start = src.indexOf('// Which images, and why:');
const end = src.indexOf('\n// In `build all texts`');
if (start < 0 || end < 0) throw new Error('embeddable-images.js no longer has the expected header/footer anchors');
const fn = '// ── embeddableImages(p): the photos the image arm embeds (README § 15) ────────\n' +
  '// It only LISTS them into metadata.image_files; wi-mall-image-vectoriser embeds them.\n//\n' +
  src.slice(start, end).trimEnd() + '\n';

let next = once(live, '\nfunction emptyDebug() {', '\n' + fn + '\nfunction emptyDebug() {');
next = once(next,
  "    images: images.slice(0, 5).map(function (f) { return clean(f.url); }),\n",
  "    images: images.slice(0, 5).map(function (f) { return clean(f.url); }),\n" +
  "    // The image arm's own key (README § 15). NOT `images` above, which is five\n" +
  "    // bare URL strings with readers of its own; product_vectors' trigger reads this.\n" +
  "    image_files: embeddableImages(p),\n");
fs.writeFileSync(outFile, next);

// ── prove it: run both bodies on the same real-shaped payloads ──────────────
const cdn = (id, ext = 'jpg') => `https://cdn.fante.cloud/products/2026/09/${id}.${ext}`;
const payload = (id, extra = {}) => ({
  product_id: id, title: 'Robe ' + id, description: 'Une robe', category: 'Mode', tags: ['robe'], type: 'physical',
  status: 'active', slug: 'robe-' + id, seo: {}, vendor: { id: 'v1', business_name: 'Boutique', country: 'CM' },
  images: [{ id: 'g1-' + id, url: cdn('g1-' + id), mimeType: 'image/jpeg' }, { id: 'vid-' + id, url: cdn('vid', 'mp4'), mimeType: 'video/mp4' }],
  variants: [{ id: 'va-' + id, sku: 'SKU-' + id, price: 15000, stock: 3, options: [{ option: 'Taille', value: 'M' }],
               files: [{ id: 'f1-' + id, url: cdn('f1-' + id, 'png'), mimeType: 'image/png' }], bargain: { minPrice: 12000, maxPrice: 15000 } }],
  delivery: null, ...extra,
});
const input = [
  { json: { product_id: 'p1', product: payload('p1') } },
  { json: { product_id: 'p2', product: payload('p2', { images: [], variants: [] }) } },
  { json: { product_id: 'p3', product: null, resolve_error: 'jovi-mall returned no payload' } },
];
const before = runCode(live, { input });
const after = runCode(next, { input });

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? '  ✔' : '  ✘'} ${label}`); if (!ok) bad++; };
const strip = (items) => JSON.stringify(items, (k, v) => (k === 'image_files' ? undefined : v));
check(strip(before) === strip(after), 'every output field except image_files is byte-identical to the live node');
const meta = (items, pid) => items.find(i => i.json.kind === 'chunk').json.products.find(p => p.product_id === pid).metadata;
check(JSON.stringify(meta(after, 'p1').image_files.map(i => i.file_id)) === JSON.stringify(['g1-p1', 'f1-p1']),
  'p1: gallery photo + variant photo, the video skipped');
check(meta(after, 'p1').image_files[1].variant_id === 'va-p1', 'p1: the variant photo carries its variant id');
check(Array.isArray(meta(after, 'p2').image_files) && meta(after, 'p2').image_files.length === 0, 'p2: no photos → []');
check(after.some(i => i.json.kind === 'failed' && i.json.product_id === 'p3'), 'p3: a missing payload still fails exactly as before');
check(JSON.stringify(meta(after, 'p1').images) === JSON.stringify(meta(before, 'p1').images), 'the legacy `images` key is untouched');
check(!after.find(i => i.json.kind === 'chunk').json.products[0].text.includes('cdn.fante.cloud'), 'no URL entered the embedded TEXT');
process.exit(bad);
