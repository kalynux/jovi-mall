// Verifies wi-mall-core's Search-Products tool node AS STORED in n8n.
//
//   node check-core-tool.js <core get_workflow_details dump> [<pre-edit dump>]
//
// Evaluates the stored photo expressions (never re-typed copies) against the
// kinds of message core receives, and -- given a pre-edit dump -- proves that
// Search-Products is the ONLY node that changed. Core is edited by several
// sessions; an edit here must not carry anyone else's work with it.
const fs = require('fs');
const path = require('path');
const { evalExpr } = require('../../deploy-day-harness/n8n-sim.js');

const load = (f) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.workflow || j; };
const [nowFile, beforeFile] = process.argv.slice(2);
const w = load(nowFile);
const tool = w.nodes.find((n) => n.name === 'Search-Products');
const v = tool.parameters.workflowInputs.value;

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? '  ✔' : '  ✘'} ${label}`); if (!ok) bad++; };
const run = (expr, inbound) => evalExpr(expr, { nodes: { Inbound: [{ json: inbound }] } });

const image = { kind: 'media', media: { mimeType: 'image/jpeg', contentBase64: '/9j/abc' } };
const imageParams = { kind: 'media', media: { mimeType: 'IMAGE/PNG; charset=binary', contentBase64: 'iVBOR' } };
const text = { kind: 'text', text: 'bonjour' };
const pdf = { kind: 'media', media: { mimeType: 'application/pdf', contentBase64: 'JVBERi' } };
const voice = { kind: 'media', media: { mimeType: 'audio/ogg; codecs=opus', contentBase64: 'T2dn' } };

check(run(v.photoBase64, image) === '/9j/abc', 'an image message passes its bytes');
check(run(v.photoBase64, imageParams) === 'iVBOR', 'an image with mime parameters / capitals passes its bytes');
check(run(v.photoBase64, text) === '', 'a text message passes no bytes');
check(run(v.photoBase64, pdf) === '', 'a PDF passes no bytes');
check(run(v.photoBase64, voice) === '', 'a voice note passes no bytes');
check(run(v.photoMimeType, image) === 'image/jpeg' && run(v.photoMimeType, text) === '', 'photoMimeType: the mime, or empty');
check(/^=\{\{ \$fromAI\('usePhoto', '[^']*', 'boolean'\) \}\}$/.test(v.usePhoto),
  'usePhoto is a STANDALONE from-AI boolean (the proven shape, like inStockOnly)');
check(v.limit === 0 && v.maxDistance === 0, 'limit / maxDistance unchanged (0 = not given; product-search reads it so)');
const ids = tool.parameters.workflowInputs.schema.map((s) => `${s.id}:${s.type}`);
check(['photoBase64:string', 'photoMimeType:string', 'usePhoto:boolean'].every((x) => ids.includes(x)), 'schema declares the three new inputs');
check(/usePhoto/.test(tool.parameters.description) && /PICTURE/.test(tool.parameters.description), 'the tool description tells the model about usePhoto');

if (beforeFile) {
  const o = load(beforeFile);
  const changed = o.nodes.filter((n) => {
    const m = w.nodes.find((x) => x.name === n.name);
    return !m || JSON.stringify(m.parameters) !== JSON.stringify(n.parameters) || JSON.stringify(m.credentials) !== JSON.stringify(n.credentials);
  }).map((n) => n.name);
  check(changed.length === 1 && changed[0] === 'Search-Products', `only Search-Products changed (changed: ${changed.join(', ') || 'none'})`);
  check(w.nodes.length === o.nodes.length, `node count unchanged (${o.nodes.length} → ${w.nodes.length})`);
  check(JSON.stringify(w.connections) === JSON.stringify(o.connections), 'connections unchanged');
}
console.log(`draft ${w.versionId} · published ${w.activeVersionId}`);
process.exit(bad);
