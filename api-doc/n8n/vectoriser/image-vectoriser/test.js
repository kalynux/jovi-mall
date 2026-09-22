// Offline proofs for the image vectoriser's n8n half.  No n8n, no Voyage.
//
//   node build-workflow.js && node test.js        exit code = number of failures
//
// Section E feeds the nodes' output into the REAL SQL, so it needs a throwaway
// pgvector container with product_vectors.sql applied (see ../image_arm.test.sql):
//   PV_CONTAINER=pv-test node test.js
// Without one, E fails with NOT RUN rather than passing -- a check that finds
// nothing and says "passed" retires a worry it has not earned.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runCode, check, report, j } = require('../../deploy-day-harness/n8n-sim.js');
const { embeddableImages, MAX_IMAGES_PER_PRODUCT } = require('./nodes/embeddable-images.js');

const code = (f) => fs.readFileSync(path.join(__dirname, 'nodes', f), 'utf8');
const BUILD = code('build-embed-request.js');
const ASSEMBLE = code('assemble-results.js');
const VERIFY = code('verify-settled.js');
const vec = (seed, dims = 1024) => Array.from({ length: dims }, (_, i) => Math.sin(seed * 7.3 + i * 0.37) / 10);
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ── A · which images a product offers ───────────────────────────────────────
// The shape buildPayload() actually sends (VectorisationService.ts): gallery in
// `images`, each variant's in `variants[].files`, every file { id, url, mimeType }.
const cdn = (id, ext = 'jpg') => `https://cdn.fante.cloud/products/2026/09/${id}.${ext}`;
const payload = {
  product_id: 'p1',
  images: [
    { id: 'g1', url: cdn('g1'), mimeType: 'image/jpeg' },
    { id: 'vid', url: cdn('vid', 'mp4'), mimeType: 'video/mp4' },
    { id: 'dev', url: 'http://100.124.149.1:8022/api/files/products/x.jpg', mimeType: 'image/jpeg' },
    { id: 'blocked', url: null, mimeType: 'image/png' },
    { id: 'g2', url: cdn('g2', 'webp'), mimeType: 'IMAGE/WEBP; charset=binary' },
    { id: 'svg', url: cdn('svg', 'svg'), mimeType: 'image/svg+xml' },
  ],
  variants: [
    { id: 'v1', files: [{ id: 'g1', url: cdn('g1'), mimeType: 'image/jpeg' }, { id: 'v1a', url: cdn('v1a', 'png'), mimeType: 'image/png' }],
      digitalConfig: { asset: { id: 'asset1', originalName: 'ebook.pdf', mimeType: 'application/pdf' } } },
    { id: 'v2', files: [{ id: 'v2a', url: cdn('v2a', 'gif'), mimeType: 'image/gif' }] },
  ],
};
const imgs = embeddableImages(payload);
check('A · embeddableImages', 'keeps exactly the embeddable pictures, gallery first',
  JSON.stringify(imgs.map(i => i.file_id)) === JSON.stringify(['g1', 'g2', 'v1a', 'v2a']), JSON.stringify(imgs));
check('A · embeddableImages', 'a video in the gallery is skipped', !imgs.some(i => i.file_id === 'vid'));
check('A · embeddableImages', 'a digital asset is never read', !JSON.stringify(imgs).includes('asset1'));
check('A · embeddableImages', 'an http:// (dev storage) URL is skipped', !imgs.some(i => i.file_id === 'dev'));
check('A · embeddableImages', 'a withheld (null) URL is skipped', !imgs.some(i => i.file_id === 'blocked'));
check('A · embeddableImages', 'SVG is skipped (Voyage takes PNG/JPEG/WEBP/GIF only)', !imgs.some(i => i.file_id === 'svg'));
check('A · embeddableImages', 'mime parameters and case are normalised', imgs.find(i => i.file_id === 'g2')?.mime_type === 'image/webp');
check('A · embeddableImages', 'a gallery photo reused on a variant is one image, kept as gallery',
  imgs.filter(i => i.file_id === 'g1').length === 1 && imgs[0].variant_id === null);
check('A · embeddableImages', 'variant photos carry their variant id', imgs.find(i => i.file_id === 'v2a')?.variant_id === 'v2');
const many = { images: Array.from({ length: 10 }, (_, i) => ({ id: 'm' + i, url: cdn('m' + i), mimeType: 'image/jpeg' })) };
check('A · embeddableImages', `capped at ${MAX_IMAGES_PER_PRODUCT}`, embeddableImages(many).length === MAX_IMAGES_PER_PRODUCT);
check('A · embeddableImages', 'a product with no images, or junk, gives []',
  embeddableImages({}).length === 0 && embeddableImages({ images: 'x', variants: [null, { files: 3 }] }).length === 0);

// ── B · build embed request ─────────────────────────────────────────────────
const claimed = [
  { product_id: 'p1', file_id: 'g1', image_url: cdn('g1'), attempts: 0 },
  { product_id: 'p2', file_id: 'h1', image_url: cdn('h1'), attempts: 0 },
];
const mint = { 'mint claim id': [j({ claim_id: 'img-42-1' })] };
const built = runCode(BUILD, { nodes: mint, input: claimed.map(j) });
const req = built[0]?.json;
check('B · build embed request', 'one item for the whole claim', built.length === 1);
check('B · build embed request', 'the claim id comes from `mint claim id`', req?.claim_id === 'img-42-1');
check('B · build embed request', 'model voyage-multimodal-3.5, input_type document',
  req?.body.model === 'voyage-multimodal-3.5' && req?.body.input_type === 'document');
check('B · build embed request', 'one image_url input per claimed row, in order',
  req?.body.inputs.length === 2 && req.body.inputs[1].content[0].type === 'image_url' && req.body.inputs[1].content[0].image_url === cdn('h1'));
check('B · build embed request', 'rows the claim returned malformed produce nothing',
  runCode(BUILD, { nodes: mint, input: [j({ product_id: 'p1' }), j({})] }).length === 0);

// ── C · assemble results ────────────────────────────────────────────────────
const assemble = (response) => runCode(ASSEMBLE, { nodes: { 'build embed request': built }, input: [j(response)] })[0].json;
const ok200 = (data, usage = { image_pixels: 2000000, total_tokens: 7143 }) => ({ statusCode: 200, headers: {}, body: { data, usage } });

// Voyage answers with `index`; the order of `data` is not a promise.
const happy = assemble(ok200([{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }]));
check('C · assemble results', '200: every row embedded', happy.results.every(r => r.outcome === 'embedded'));
check('C · assemble results', '200: vectors paired by `index`, not by array position',
  happy.results[0].file_id === 'g1' && happy.results[0].embedding[0] === vec(1)[0] && happy.results[1].embedding[0] === vec(2)[0]);
check('C · assemble results', '200 with two images: pixels NOT apportioned (null)', happy.results.every(r => r.image_pixels === null));
check('C · assemble results', 'no alarm on success', happy.alarm === null && happy.tokens === 7143);

const short = assemble(ok200([{ index: 0, embedding: vec(1) }]));
check('C · assemble results', '200 with fewer vectors than images: ALL failed, none paired by position',
  short.results.length === 2 && short.results.every(r => r.outcome === 'failed' && !r.embedding));
const badDims = assemble(ok200([{ index: 0, embedding: vec(1, 512) }, { index: 1, embedding: vec(2) }]));
check('C · assemble results', '200 with a 512-dim vector: that row failed, the other embedded',
  badDims.results[0].outcome === 'failed' && badDims.results[1].outcome === 'embedded');
const nan = assemble(ok200([{ index: 0, embedding: [...vec(1).slice(1), NaN] }, { index: 1, embedding: vec(2) }]));
check('C · assemble results', '200 with a NaN inside a vector: that row failed', nan.results[0].outcome === 'failed');

const r400 = assemble({ statusCode: 400, body: { detail: 'Failed to fetch image from URL' } });
check('C · assemble results', '400: failed (the images\' fault), with Voyage\'s reason, no alarm',
  r400.results.every(r => r.outcome === 'failed' && r.error.includes('Failed to fetch image')) && r400.alarm === null);
const r429 = assemble({ statusCode: 429, body: { detail: 'You have not yet added your payment method ... 3 RPM and 10K TPM' } });
check('C · assemble results', '429: deferred, NOT failed, and no alarm (free-tier weather)',
  r429.results.every(r => r.outcome === 'deferred') && r429.alarm === null);
const r401 = assemble({ statusCode: 401, body: { detail: 'Provided API key is invalid.' } });
check('C · assemble results', '401: deferred AND an alarm (a human must fix the credential)',
  r401.results.every(r => r.outcome === 'deferred') && /401/.test(r401.alarm));
const r503 = assemble({ statusCode: 503, body: '<html>Service Unavailable</html>' });
check('C · assemble results', '503 with an HTML body: deferred AND an alarm', r503.results.every(r => r.outcome === 'deferred') && !!r503.alarm);
const netErr = assemble({ error: { message: 'getaddrinfo ENOTFOUND api.voyageai.com' } });
check('C · assemble results', 'no HTTP answer at all: deferred AND an alarm',
  netErr.results.every(r => r.outcome === 'deferred') && /ENOTFOUND/.test(netErr.alarm));

const single = runCode(ASSEMBLE, {
  nodes: { 'build embed request': runCode(BUILD, { nodes: mint, input: [j(claimed[0])] }) },
  input: [j(ok200([{ index: 0, embedding: vec(1) }], { image_pixels: 1481760, total_tokens: 2646 }))],
})[0].json;
check('C · assemble results', 'a one-image request records its exact pixels', single.results[0].image_pixels === 1481760);

// ── D · verify settled ──────────────────────────────────────────────────────
const verify = (sent, written) => runCode(VERIFY, { nodes: { 'assemble results': [j(sent)] }, input: written.map(j) });
const settledRows = happy.results.map(r => ({ product_id: r.product_id, file_id: r.file_id, status: 'embedded', attempts: 0 }));
const summary = verify(happy, settledRows)[0].json;
check('D · verify settled', 'all written: a summary, no throw', summary.embedded === 2 && summary.written === 2);
check('D · verify settled', 'fewer rows written than sent: THROWS',
  /settled 1 of 2/.test(throws(() => verify(happy, settledRows.slice(0, 1)))?.message || ''));
check('D · verify settled', 'zero rows (alwaysOutputData\'s empty item): THROWS',
  /settled 0 of 2/.test(throws(() => verify(happy, [{}]))?.message || ''));
check('D · verify settled', 'an alarm THROWS even when every row was written',
  /401/.test(throws(() => verify(r401, settledRows.map(r => ({ ...r, status: 'pending' }))))?.message || ''));
check('D · verify settled', 'a 429 does NOT throw', !throws(() => verify(r429, settledRows.map(r => ({ ...r, status: 'pending' })))));

// ── E · the nodes' output against the REAL SQL ──────────────────────────────
const container = process.env.PV_CONTAINER;
const psql = (sql) => execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-qtAX', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
if (!container) {
  check('E · against product_vectors.sql', 'NOT RUN — set PV_CONTAINER to a pgvector container with product_vectors.sql applied', false);
} else {
  psql("DELETE FROM product_vectors WHERE product_id LIKE 'e2e-%';");
  // metadata.image_files exactly as `build product text` would write it
  const meta = { product_id: 'e2e-p1', title: 'E2E product', status: 'active', country: 'CM', images: ['https://legacy.example/url-strings-are-ignored.jpg'], image_files: embeddableImages(payload) };
  psql(`INSERT INTO product_vectors (text, metadata) VALUES ('e2e', ${lit(JSON.stringify(meta))}::jsonb);`);
  const rows = psql("SELECT file_id || ':' || coalesce(variant_id,'-') || ':' || position FROM product_image_vectors WHERE product_id = 'e2e-p1' ORDER BY position;").split('\n');
  check('E · against product_vectors.sql', 'metadata.image_files → the trigger writes one pending row per embeddable image',
    JSON.stringify(rows) === JSON.stringify(['g1:-:0', 'g2:-:1', 'v1a:v1:2', 'v2a:v2:3']), JSON.stringify(rows));

  // claim two, embed them with the real node code, settle with the real function
  const claimRows = psql("SELECT json_agg(c) FROM product_image_claim('e2e-claim', p_max_images => 2) c;");
  const claimedE2E = JSON.parse(claimRows || '[]');
  const builtE2E = runCode(BUILD, { nodes: { 'mint claim id': [j({ claim_id: 'e2e-claim' })] }, input: claimedE2E.map(j) });
  const assembled = runCode(ASSEMBLE, {
    nodes: { 'build embed request': builtE2E },
    input: [j(ok200(claimedE2E.map((_, i) => ({ index: i, embedding: vec(i + 10) }))))],
  })[0].json;
  const settled = JSON.parse(psql(`SELECT json_agg(s) FROM product_image_settle(${lit(assembled.claim_id)}, ${lit(JSON.stringify(assembled.results))}::jsonb) s;`) || '[]');
  check('E · against product_vectors.sql', 'claim → build → assemble → settle: every claimed image written',
    claimedE2E.length === 2 && settled.length === 2 && settled.every(s => s.status === 'embedded'), JSON.stringify(settled));
  // (the claim takes the oldest position-0 images across ALL products, so on a
  // shared container they need not be e2e-p1's -- check the rows actually claimed)
  const pairs = claimedE2E.map(c => `(${lit(c.product_id)}, ${lit(c.file_id)})`).join(', ');
  const stored = psql(`SELECT count(*) FROM product_image_vectors WHERE (product_id, file_id) IN (${pairs}) AND status = 'embedded' AND vector_dims(embedding) = 1024;`);
  check('E · against product_vectors.sql', 'the stored vectors are 1024-dim', stored === '2', stored);
  check('E · against product_vectors.sql', 'verify settled accepts what the SQL returned',
    !throws(() => runCode(VERIFY, { nodes: { 'assemble results': [j(assembled)] }, input: settled.map(j) })));

  // a 429 through the same path: deferred rows come back pending, attempts untouched
  const claim2 = JSON.parse(psql("SELECT json_agg(c) FROM product_image_claim('e2e-claim-2', p_max_images => 2) c;") || '[]');
  const built2 = runCode(BUILD, { nodes: { 'mint claim id': [j({ claim_id: 'e2e-claim-2' })] }, input: claim2.map(j) });
  const deferred = runCode(ASSEMBLE, { nodes: { 'build embed request': built2 }, input: [j({ statusCode: 429, body: { detail: 'rate' } })] })[0].json;
  const settled2 = JSON.parse(psql(`SELECT json_agg(s) FROM product_image_settle(${lit(deferred.claim_id)}, ${lit(JSON.stringify(deferred.results))}::jsonb) s;`) || '[]');
  check('E · against product_vectors.sql', 'a 429 settles as pending with no attempt spent',
    settled2.length === 2 && settled2.every(s => s.status === 'pending' && s.attempts === 0), JSON.stringify(settled2));
  psql("DELETE FROM product_vectors WHERE product_id LIKE 'e2e-%';");
}

// ── F · the guards BITE ─────────────────────────────────────────────────────
const mutant = (src, from, to) => {
  if (!src.includes(from)) throw new Error('mutation anchor missed: ' + from);
  return src.replace(from, to);
};
const noSort = mutant(ASSEMBLE, '.slice().sort((a, b) => a.index - b.index)', '.slice()');
const noSortOut = runCode(noSort, { nodes: { 'build embed request': built }, input: [j(ok200([{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }]))] })[0].json;
check('F · guards bite', 'without the index sort, the pairing check FAILS', noSortOut.results[0].embedding[0] !== vec(1)[0]);
const noCount = mutant(ASSEMBLE, 'if (data.length !== rows.length) {', 'if (false) {');
const noCountOut = runCode(noCount, { nodes: { 'build embed request': built }, input: [j(ok200([{ index: 0, embedding: vec(1) }]))] })[0].json;
check('F · guards bite', 'without the count guard, a short answer is half-embedded', noCountOut.results[0].outcome === 'embedded');
const all429 = mutant(ASSEMBLE, '} else if (status === 429) {', '} else if (false) {');
const as400 = runCode(all429, { nodes: { 'build embed request': built }, input: [j({ statusCode: 429, body: {} })] })[0].json;
check('F · guards bite', 'without the 429 branch, a rate limit would spend attempts (or alarm)', as400.results[0].outcome !== 'deferred' || as400.alarm !== null);
const verifyNoCount = mutant(VERIFY, 'if (written.length !== sent.results.length) {', 'if (false) {');
check('F · guards bite', 'without the row count, a zero-row settle passes silently',
  !throws(() => runCode(verifyNoCount, { nodes: { 'assemble results': [j(happy)] }, input: [j({})] })));

// ── G · the shipped workflow is the tested code ─────────────────────────────
const wfPath = path.join(__dirname, 'wi-mall-image-vectoriser.json');
if (!fs.existsSync(wfPath)) {
  check('G · workflow JSON', 'NOT BUILT — run `node build-workflow.js` first', false);
} else {
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  const node = (n) => wf.nodes.find(x => x.name === n);
  check('G · workflow JSON', 'build embed request ships the tested body', node('build embed request')?.parameters.jsCode === BUILD);
  check('G · workflow JSON', 'assemble results ships the tested body', node('assemble results')?.parameters.jsCode === ASSEMBLE);
  check('G · workflow JSON', 'verify settled ships the tested body', node('verify settled')?.parameters.jsCode === VERIFY);
  check('G · workflow JSON', 'failures reach the automation board (errorWorkflow set)', wf.settings.errorWorkflow === 'd2JZ7jA2jJCg0O9S');
  check('G · workflow JSON', 'settle keeps alwaysOutputData (zero rows must reach verify)', node('settle images')?.alwaysOutputData === true);
  check('G · workflow JSON', 'embed images: neverError + fullResponse + continueRegularOutput',
    node('embed images')?.parameters.options.response.response.neverError === true
    && node('embed images')?.parameters.options.response.response.fullResponse === true
    && node('embed images')?.onError === 'continueRegularOutput');
  check('G · workflow JSON', 'both query replacements are ARRAY expressions',
    ['claim images', 'settle images'].every(n => /^=\{\{\s*\[/.test(node(n)?.parameters.options.queryReplacement)));
  const chain = []; let cur = 'every minute';
  while (cur) { chain.push(cur); cur = wf.connections[cur]?.main?.[0]?.[0]?.node; }
  check('G · workflow JSON', 'one straight chain through all eight nodes', chain.length === 8 && chain.length === wf.nodes.length, chain.join(' → '));
}

process.exit(report());
