const fs = require('fs');
const S = __dirname;
const D = S + '/';
const w = JSON.parse(fs.readFileSync(S + '/vectoriser-before-677326ee.json', 'utf8')).workflow;
const liveCode = (n) => w.nodes.find((x) => x.name === n).parameters.jsCode;
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

// A Code node, run the way n8n runs "Run Once for All Items".
function run(src, items, nodes = {}) {
  const $input = { all: () => items.map((j) => ({ json: j })), first: () => ({ json: items[0] }) };
  const $ = (n) => ({ first: () => ({ json: nodes[n] }), all: () => (nodes[n + '#all'] || []).map((j) => ({ json: j })), isExecuted: !!nodes[n] });
  const fn = new Function('$input', '$', '$env', '$execution', src);
  return fn($input, $, {}, { id: 'exec-1' }).map((i) => i.json);
}

const LID = '6a1b2c3d4e5f60718293a4b5';
const listing = {
  kind: 'listing', listing_id: LID, slug: 'kamga-plomberie', status: 'live', title: 'Plombier à domicile',
  company_name: 'Kamga Plomberie', description: 'Fuites, chauffe-eau, installations.', category: 'Plomberie',
  categories: ['Plomberie', 'Réparations'], country: 'CM', city: 'Yaoundé', area: 'Bastos',
  images: [{ id: 'f1', url: 'https://cdn.wi-mall.com/x.jpg', mimeType: 'image/jpeg', size: 10 }],
  opening_hours: [{ day: 'monday', open_time: '08:00', close_time: '18:00', is_closed: false }, { day: 'sunday', open_time: '', close_time: '', is_closed: true }],
};
const product = { product_id: '6a0000000000000000000001', title: 'Water bottle', slug: 'water-bottle', status: 'active', type: 'physical',
  variants: [{ id: 'v1', sku: 'WB', price: 1500, stock: 5 }], vendor: { id: 'v', name: 'Shop', country: 'CM' }, images: [] };

console.log('\nnormalise json payload');
const normNew = fs.readFileSync(D + 'normalise.js', 'utf8');
const n1 = run(normNew, [{ body: [listing, product, { kind: 'listing' }, { kind: 'listing', listing_id: LID }] }]);
check('listing → full, keyed listing:<id>, payload kept', n1[0].mode === 'full' && n1[0].product_id === 'listing:' + LID && n1[0].product === listing);
check('product unchanged', JSON.stringify(n1[1]) === JSON.stringify(run(liveCode('normalise json payload'), [{ body: [product] }])[0]));
check('listing with no listing_id → reject', n1[2].mode === 'reject' && n1[2].product_id === null);
check('listing with no title → reject, keyed', n1[3].mode === 'reject' && n1[3].product_id === 'listing:' + LID);

console.log('\nbuild all texts');
const buildNew = fs.readFileSync(D + 'build.js', 'utf8');
const b1 = run(buildNew, [{ product_id: 'listing:' + LID, product: listing }]);
const chunk = b1.find((x) => x.kind === 'chunk');
const row = chunk && chunk.products[0];
check('listing builds into a chunk', !!row && row.product_id === 'listing:' + LID);
check('metadata: kind/listing_id/type/status', row.metadata.kind === 'listing' && row.metadata.listing_id === LID && row.metadata.type === 'listing' && row.metadata.status === 'active');
check('metadata: no price, no stock, no image_files', row.metadata.price_min === null && row.metadata.in_stock === null && !('image_files' in row.metadata));
check('text names title, company, place, hours, description', ['Plombier à domicile', 'Kamga Plomberie', 'Bastos, Yaoundé, Cameroon', 'Monday 08:00-18:00', 'Sunday closed', 'Fuites'].every((s) => row.text.includes(s)));
check('text is multi-line (newline join works without a backslash)', row.text.split(String.fromCharCode(10)).length >= 6);
const bLive = run(liveCode('build all texts'), [{ product_id: product.product_id, product }]);
const bNewP = run(buildNew, [{ product_id: product.product_id, product }]);
check('product text + metadata byte-identical to live', JSON.stringify(bLive) === JSON.stringify(bNewP));

console.log('\ncompose report');
const compNew = fs.readFileSync(D + 'compose.js', 'utf8');
const items = [
  { product_id: 'listing:' + LID, status: 'completed', vectorised_id: 'listing:' + LID, error: null, token_estimate: 40, tokens_are_estimated: false },
  { product_id: product.product_id, status: 'completed', vectorised_id: product.product_id, error: null, token_estimate: 60, tokens_are_estimated: true },
];
const r1 = run(compNew, items)[0];
check('listing row → { kind: listing, listing_id, status, vectorised_id }', r1.results[0].kind === 'listing' && r1.results[0].listing_id === LID && r1.results[0].status === 'completed' && r1.results[0].vectorised_id === 'listing:' + LID);
const rLive = run(liveCode('compose report'), [items[1]])[0];
const rNewP = run(compNew, [items[1]])[0];
delete rLive.finished_at; delete rNewP.finished_at;
check('product-only report byte-identical to live', JSON.stringify(rLive) === JSON.stringify(rNewP));
check('totals still count both', r1.total === 2 && r1.succeeded === 2 && r1.tokens_total === 100);

console.log('\naccept response and delete parameter (expressions)');
const ev = (expr, ctx) => new Function('$', '$json', '$execution', 'return ' + expr.slice(4, -3) + ';')(ctx.$, ctx.$json, { id: 'exec-1' });
const acceptItems = [{ accepted: true, product_id: 'listing:' + LID, callback_url: 'cb' }, { accepted: true, product_id: product.product_id, callback_url: 'cb' }, { accepted: false, product_id: 'listing:bad', reason: 'listing payload has no title' }, { accepted: false, product_id: null, reason: 'no product_id on entry 3' }];
const $acc = (n) => ({ all: () => acceptItems.map((j) => ({ json: j })), first: () => ({ json: acceptItems[0] }) });
const resp = JSON.parse(ev(fs.readFileSync(D + 'accept.expr', 'utf8'), { $: $acc }));
check('accepted holds the BARE listing id (jovi-mall checks accepted.has(listingId))', resp.accepted[0] === LID && resp.accepted[1] === product.product_id);
check('rejected listing → { kind, listing_id, reason }; product reject unchanged', resp.rejected[0].kind === 'listing' && resp.rejected[0].listing_id === 'bad' && resp.rejected[1].product_id === null);
const delExpr = fs.readFileSync(D + 'delete.expr', 'utf8');
check('delete: listing → listing:<id>', ev(delExpr, { $json: { body: { kind: 'listing', listing_id: LID } } })[0] === 'listing:' + LID);
check('delete: product unchanged', ev(delExpr, { $json: { body: { product_id: 'p1' } } })[0] === 'p1');
check('delete: listing with no id matches nothing real', ev(delExpr, { $json: { body: { kind: 'listing' } } })[0] === 'listing:');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
