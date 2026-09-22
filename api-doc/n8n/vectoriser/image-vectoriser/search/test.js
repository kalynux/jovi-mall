// Offline proofs for the product-search changes (README § 15.7). No n8n, no Voyage.
//   node search/test.js          exit code = number of failures
const fs = require('fs');
const path = require('path');
const { runCode, evalExpr, check, report, j } = require('../../../deploy-day-harness/n8n-sim.js');
const X = require('./expressions.js');

const code = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const NORMALISE = code('normalise-query.js');
const SHAPE_IMAGE = code('shape-image-vector.js');
const SHAPE_RESULT = code('shape-result.js');
const SHAPE_FALLBACK = code('shape-fallback-result.js');
const vec = (seed, dims = 1024) => Array.from({ length: dims }, (_, i) => Math.sin(seed * 3.1 + i * 0.29) / 10);
const norm = (input) => runCode(NORMALISE, { input: [j(input)] })[0].json;

// ── A · Normalise Query ─────────────────────────────────────────────────────
// What wi-mall-core's tool node really sends (execution 1335, 2026-09-17).
const real = norm({ query: 'chaussures', limit: 0, category: '', maxPrice: 0, inStockOnly: false, country: null, maxDistance: 0 });
check('A · Normalise Query', 'maxPrice 0 (no budget) → null, not a 0 XAF ceiling', real.maxPrice === null);
check('A · Normalise Query', 'maxDistance 0 → the measured default 0.60, not a 0.00 floor', real.maxDistance === 0.6);
check('A · Normalise Query', 'a real budget still passes', norm({ query: 'x', maxPrice: 20000 }).maxPrice === 20000);
check('A · Normalise Query', 'a real floor override still passes', norm({ query: 'x', maxDistance: 0.4 }).maxDistance === 0.4);
check('A · Normalise Query', 'limit 0 → 5, limit 50 → capped 10', real.limit === 5 && norm({ query: 'x', limit: 50 }).limit === 10);
check('A · Normalise Query', 'words only: image arm ON for text, keyed text:<key>, floor 0.72',
  real.has_text && !real.has_photo && real.image_arm && real.image_query_key === 'text:chaussures' && real.imageMaxDistance === 0.72);
const photoOnly = norm({ query: '', usePhoto: true, photoBase64: '/9j/4AAQ', photoMimeType: 'image/jpeg' });
check('A · Normalise Query', 'photo only: image arm ON, floor 0.50, NO cache key (never stored)',
  photoOnly.has_photo && !photoOnly.has_text && photoOnly.image_arm && photoOnly.image_query_key === null && photoOnly.imageMaxDistance === 0.5);
const photoWords = norm({ query: 'en rouge', usePhoto: true, photoBase64: 'iVBORw0', photoMimeType: 'image/png; charset=binary' });
check('A · Normalise Query', 'photo + words: both, photo floor, photo not cached, mime normalised',
  photoWords.has_photo && photoWords.has_text && photoWords.image_query_key === null && photoWords.photo_mime === 'image/png');
check('A · Normalise Query', 'a PDF "photo" is not a photo', !norm({ query: 'x', usePhoto: true, photoBase64: 'JVBER', photoMimeType: 'application/pdf' }).has_photo);
check('A · Normalise Query', 'a picture the MODEL did not ask to search by is ignored (usePhoto false / absent)',
  !norm({ query: 'x', usePhoto: false, photoBase64: '/9j/', photoMimeType: 'image/jpeg' }).has_photo && !norm({ query: 'x', photoBase64: '/9j/', photoMimeType: 'image/jpeg' }).has_photo);
check('A · Normalise Query', 'usePhoto as the string "true" (a typed input may arrive as text) still counts', norm({ query: '', usePhoto: 'true', photoBase64: '/9j/', photoMimeType: 'image/jpeg' }).has_photo);
check('A · Normalise Query', 'an empty photo string is not a photo', !norm({ query: 'x', usePhoto: true, photoBase64: '  ', photoMimeType: 'image/jpeg' }).has_photo);
check('A · Normalise Query', 'the photo bytes are NOT copied into the output', !JSON.stringify(photoOnly).includes('/9j/4AAQ'));

// ── B · the branch conditions ───────────────────────────────────────────────
const nodesFor = (n, extra = {}) => ({ 'Normalise Query': [j(n)], ...extra });
check('B · conditions', 'Has Text? false for a photo-only search', evalExpr(X.HAS_TEXT_CONDITION, { nodes: nodesFor(photoOnly) }) === false);
check('B · conditions', 'Image Arm? true for words and for a photo',
  evalExpr(X.IMAGE_ARM_CONDITION, { nodes: nodesFor(real) }) === true && evalExpr(X.IMAGE_ARM_CONDITION, { nodes: nodesFor(photoOnly) }) === true);
check('B · conditions', 'Image Cached? on a cache hit / on the empty always-output item',
  evalExpr(X.IMAGE_CACHED_CONDITION, { json: { image_embedding: '[0.1]' } }) === true && evalExpr(X.IMAGE_CACHED_CONDITION, { json: {} }) === false);
check('B · conditions', 'Image Cache Lookup key for a photo is null (matches no row)',
  JSON.stringify(evalExpr(X.IMAGE_CACHE_LOOKUP_REPLACEMENT, { nodes: nodesFor(photoOnly) })) === '[null]');

// ── C · the multimodal request body ─────────────────────────────────────────
const bodyPhoto = JSON.parse(evalExpr(X.EMBED_IMAGE_QUERY_BODY, {
  nodes: nodesFor(photoOnly, { 'Search Request': [j({ photoBase64: ' /9j/4AAQ ' })] }),
}));
check('C · Embed Image Query body', 'a photo goes as image_base64 with its data-URL prefix, input_type query',
  bodyPhoto.input_type === 'query' && bodyPhoto.model === 'voyage-multimodal-3.5'
  && bodyPhoto.inputs[0].content[0].type === 'image_base64' && bodyPhoto.inputs[0].content[0].image_base64 === 'data:image/jpeg;base64,/9j/4AAQ');
const bodyPrefixed = JSON.parse(evalExpr(X.EMBED_IMAGE_QUERY_BODY, {
  nodes: nodesFor(photoOnly, { 'Search Request': [j({ photoBase64: 'data:image/jpeg;base64,/9j/4AAQ' })] }),
}));
check('C · Embed Image Query body', 'an already-prefixed photo is not double-prefixed',
  bodyPrefixed.inputs[0].content[0].image_base64 === 'data:image/jpeg;base64,/9j/4AAQ');
const bodyText = JSON.parse(evalExpr(X.EMBED_IMAGE_QUERY_BODY, { nodes: nodesFor(real) }));
const bodyTestRun = JSON.parse(evalExpr(X.EMBED_IMAGE_QUERY_BODY, { nodes: nodesFor(photoOnly, { 'Test Query': [j({ photoBase64: '/9j/TEST' })] }) }));
check('C · Embed Image Query body', 'from the editor Test Run, the photo is read from Test Query', bodyTestRun.inputs[0].content[0].image_base64 === 'data:image/jpeg;base64,/9j/TEST');
check('C · Embed Image Query body', 'words go as text -- and Search Request is never touched (Test Run path)',
  bodyText.inputs[0].content[0].type === 'text' && bodyText.inputs[0].content[0].text === 'chaussures');

// ── D · Shape Image Vector ──────────────────────────────────────────────────
const shapeImg = (res, n = real) => runCode(SHAPE_IMAGE, { nodes: nodesFor(n), input: [j(res)] })[0].json;
const good = shapeImg({ data: [{ index: 0, embedding: vec(1) }], usage: { total_tokens: 4 } });
check('D · Shape Image Vector', 'a 1024-dim answer → a vector string + the text cache key',
  good.image_embedding.startsWith('[') && good.image_query_key === 'text:chaussures' && good.image_tokens === 4);
check('D · Shape Image Vector', 'a 429 (the node error item) → null, and it does NOT throw',
  shapeImg({ error: { message: '429 - rate limited' } }).image_embedding === null);
check('D · Shape Image Vector', 'a wrong dimension → null', shapeImg({ data: [{ embedding: vec(1, 512) }] }).image_embedding === null);
check('D · Shape Image Vector', 'a photo\'s key stays null (never cached)', shapeImg({ data: [{ embedding: vec(1) }] }, photoOnly).image_query_key === null);

// ── E · Run Hybrid Search parameters, per path ─────────────────────────────
const params = (nodes) => evalExpr(X.RUN_HYBRID_SEARCH_REPLACEMENT, { nodes });
const textVec = '[0.1,0.2]';
// words, text cache hit, image arm fresh embed
const pFresh = params(nodesFor(real, { 'Text Vector Ready': [j({ embedding: textVec })], 'Image Cache Lookup': [j({})], 'Shape Image Vector': [j(good)] }));
check('E · Run Hybrid Search', '10 parameters, in the query\'s order', pFresh.length === 10 && X.RUN_HYBRID_SEARCH_QUERY.includes('$10::float'));
check('E · Run Hybrid Search', 'words + fresh image vector: both vectors, text floor 0.72, price null, distance 0.60',
  pFresh[0] === textVec && pFresh[8] === good.image_embedding && pFresh[9] === 0.72 && pFresh[5] === null && pFresh[7] === 0.6);
// image cache hit (Shape Image Vector never ran)
const pHit = params(nodesFor(real, { 'Text Vector Ready': [j({ embedding: textVec })], 'Image Cache Lookup': [j({ image_embedding: '[9]' })] }));
check('E · Run Hybrid Search', 'image cache hit: the cached vector is used', pHit[8] === '[9]' && pHit[9] === 0.72);
// image arm off (neither ran)
const pOff = params(nodesFor({ ...real, image_arm: false }, { 'Text Vector Ready': [j({ embedding: textVec })] }));
check('E · Run Hybrid Search', 'image arm off: no image vector AND no image floor', pOff[8] === null && pOff[9] === null);
// image embed failed: no image vector, and the floor must not be sent alone
const pFailed = params(nodesFor(real, { 'Text Vector Ready': [j({ embedding: textVec })], 'Image Cache Lookup': [j({})], 'Shape Image Vector': [j({ image_embedding: null })] }));
check('E · Run Hybrid Search', 'image embed failed: the search still runs on its text arms', pFailed[0] === textVec && pFailed[8] === null && pFailed[9] === null);
// photo only: no text vector (Text Vector Ready carries the empty cache row)
const pPhoto = params(nodesFor(photoOnly, { 'Text Vector Ready': [j({})], 'Image Cache Lookup': [j({})], 'Shape Image Vector': [j({ image_embedding: '[7]' })] }));
check('E · Run Hybrid Search', 'photo only: no text vector, the photo vector, the PHOTO floor 0.50', pPhoto[0] === null && pPhoto[8] === '[7]' && pPhoto[9] === 0.5 && pPhoto[1] === '');

// ── F · the result shapers ──────────────────────────────────────────────────
const collected = { rows: [{ product_id: 'p1', product_text: 'Robe rouge ...' }, { product_id: 'gone', product_text: '...' }] };
const hydration = { data: { products: [{ id: 'p1', title: 'Robe rouge', price: 15000, currency: 'XAF', inStock: true, category: 'Mode',
  store: { slug: 'boutique', name: 'Boutique' }, slug: 'robe-rouge', image: { url: 'https://cdn.fante.cloud/x.jpg' } }] } };
const shape = (n, extra = {}) => runCode(SHAPE_RESULT, { nodes: { 'Collect Ids': [j(collected)], 'Normalise Query': [j(n)], ...extra }, input: [j(hydration)] })[0].json;
const sPhoto = shape(photoOnly, { 'Shape Image Vector': [j({ image_embedding: '[7]' })] });
check('F · Shape Result', 'photo search: searchedPhoto true, told to CONFIRM, withdrawn one counted',
  sPhoto.searchedPhoto === true && /confirm with the customer/.test(sPhoto.note) && /withdrawn/.test(sPhoto.note) && sPhoto.count === 1);
const sText = shape(real);
check('F · Shape Result', 'words only: searchedPhoto false, no photo note', sText.searchedPhoto === false && !/photo/i.test(sText.note || ''));
const sPhotoFailed = shape(photoWords, { 'Shape Image Vector': [j({ image_embedding: null })] });
check('F · Shape Result', 'photo + words, photo embed failed: says the words alone matched', /words only/.test(sPhotoFailed.note));
check('F · Shape Result', 'the allowlist never carries metadata or bargain data', !JSON.stringify(sPhoto).match(/bargain|metadata|minPrice/));

const fallback = (n, list, extra = {}) => runCode(SHAPE_FALLBACK, { nodes: { 'Normalise Query': [j(n)], ...extra }, input: [j({ data: list })] })[0].json;
const listing = [{ id: 'z', title: 'Unrelated', price: 1, currency: 'XAF', inStock: true, category: 'x', store: { slug: 's', name: 'S' }, slug: 'z' }];
const fPhoto = fallback(photoOnly, listing, { 'Shape Image Vector': [j({ image_embedding: '[7]' })] });
check('F · Shape Fallback Result', 'photo only, nothing matched: NO products (the empty-query listing is refused)',
  fPhoto.count === 0 && fPhoto.source === 'photo' && fPhoto.note === 'No products matched this photo.');
const fPhotoFailed = fallback(photoOnly, listing, { 'Shape Image Vector': [j({ image_embedding: null })] });
check('F · Shape Fallback Result', 'photo only, embed failed: asks for words, shows nothing', fPhotoFailed.count === 0 && /describe the item in words/.test(fPhotoFailed.note));
const fNone = fallback({ ...photoOnly, has_photo: false }, listing);
check('F · Shape Fallback Result', 'no words and no photo: nothing, honestly', fNone.count === 0 && fNone.source === 'none');
const fWords = fallback(real, listing);
check('F · Shape Fallback Result', 'words: the keyword listing as before', fWords.count === 1 && fWords.source === 'keyword' && fWords.note === null);

// ── G · the guards BITE ─────────────────────────────────────────────────────
const mutate = (src, from, to) => { if (!src.includes(from)) throw new Error('mutation anchor missed: ' + from); return src.replace(from, to); };
const oldZero = mutate(NORMALISE, 'return n !== null && n > 0 ? n : null;', 'return n;');
check('G · guards bite', 'without the zero rule, maxPrice 0 becomes a 0 XAF ceiling again',
  runCode(oldZero, { input: [j({ query: 'x', maxPrice: 0 })] })[0].json.maxPrice === 0);
const noEmptyGuard = mutate(SHAPE_FALLBACK, 'if (!n.has_text) {', 'if (false) {');
check('G · guards bite', 'without the empty-query guard, a photo gets an unrelated listing',
  runCode(noEmptyGuard, { nodes: { 'Normalise Query': [j(photoOnly)] }, input: [j({ data: listing })] })[0].json.count === 1);
const floorAlone = X.RUN_HYBRID_SEARCH_REPLACEMENT.replace('image ? n.imageMaxDistance : null', 'n.imageMaxDistance');
check('G · guards bite', 'without the pairing rule, a floor is sent with no image vector',
  evalExpr(floorAlone, { nodes: nodesFor({ ...real, image_arm: false }, { 'Text Vector Ready': [j({ embedding: textVec })] }) })[9] === 0.72);

process.exit(report());
