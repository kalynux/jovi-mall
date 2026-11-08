const fs = require('fs');
const D = __dirname + '/';
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
function run(src, items, nodes = {}) {
  const $input = { all: () => items.map((j) => ({ json: j })), first: () => ({ json: items[0] }) };
  const $ = (n) => ({ first: () => ({ json: nodes[n] }), isExecuted: !!nodes[n] });
  return new Function('$input', '$', src)($input, $).map((i) => i.json);
}
const collect = fs.readFileSync(D + 'collect-ids.js', 'utf8');
const add = fs.readFileSync(D + 'add-listings.js', 'utf8');
const L = 'listing:6a1b2c3d4e5f60718293a4b5';
const P1 = '6a0000000000000000000001', P2 = '6a0000000000000000000002';
const row = (id, t) => ({ product_id: id, title: t, product_text: 'Service listing: ' + t + '.' + String.fromCharCode(10) + 'Location: Bastos.' });

console.log('\nCollect Ids');
const mixed = run(collect, [row(P1, 'Bottle'), row(L, 'Plombier'), row(P2, 'Cup')])[0];
check('products keep their RRF order in ids', mixed.ids === P1 + ',' + P2 && mixed.rows.length === 2);
check('listing rows set aside, not hydrated', mixed.listing_rows.length === 1 && mixed.listing_rows[0].product_id === L && !mixed.ids.includes('listing'));
const onlyL = run(collect, [row(L, 'Plombier')])[0];
check('only listings → placeholder id, never an empty ids (a 400)', onlyL.ids === '000000000000000000000000' && onlyL.rows.length === 0);
const onlyP = run(collect, [row(P1, 'Bottle')])[0];
check('products only → same ids and rows as before', onlyP.ids === P1 && onlyP.rows.length === 1 && onlyP.listing_rows.length === 0);

console.log('\nAdd Listings');
const shapedNone = { query: 'plombier', source: 'hybrid', count: 0, products: [], alternatives: [], aboveBudget: [], note: 'No products matched.' };
const a1 = run(add, [shapedNone], { 'Collect Ids': onlyL })[0];
check('only listings → count = listings, Any Live? passes (count > 0)', a1.count === 1 && a1.listings.length === 1);
check('listing item: kind, bare listingId, title, one-line snippet', a1.listings[0].kind === 'listing' && a1.listings[0].listingId === '6a1b2c3d4e5f60718293a4b5' && a1.listings[0].title === 'Plombier' && !a1.listings[0].snippet.includes(String.fromCharCode(10)));
check('note replaces "No products matched." and names listings_display', !a1.note.includes('No products matched') && a1.note.includes('listings_display'));
const shapedSome = { query: 'x', source: 'hybrid', count: 2, products: [{ id: P1 }, { id: P2 }], note: null };
const a2 = run(add, [shapedSome], { 'Collect Ids': mixed })[0];
check('mixed → count = products + listings, products untouched', a2.count === 3 && a2.products.length === 2 && a2.listings.length === 1);
const a3 = run(add, [shapedSome], { 'Collect Ids': onlyP })[0];
check('no listing → Shape Result item passes through UNCHANGED', JSON.stringify(a3) === JSON.stringify(shapedSome));
check('no backslash in either node', !collect.includes('\\') && !add.includes('\\'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
