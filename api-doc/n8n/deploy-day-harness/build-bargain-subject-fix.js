// Bargain `resolve variant` reads its subject from `Inbound`, not from the node before it.
//
// ⛔ A REGRESSION OF OURS, LIVE 06:18 → fix. Bargain version 10d4f6fd (build-handset-2.js) put
// `read answered` → `was answered?` → `answered already?` between `route mode` and
// `resolve variant`. `resolve variant` built its body from `$json.productId` / `$json.variantId`,
// and `$json` there is now `{ answeredEcho, alreadyAnswered }`. So every open sent `{}`, jovi-mall
// answered NEGOTIATION_TOOL_SUBJECT_REQUIRED, `pick variant` turned that into
// `product_not_found`, and no haggle could start at all (owner's handset, core exec 2850 →
// bargain 2851, 2026-09-22 14:06 UTC). build-handset-2.js tested the three new nodes and never
// evaluated the node AFTER them — the one whose input it had changed.
//
// So this harness pins the general property as well as the one fix: no node that now sits
// behind the answered check may read an Inbound field off `$json`.
//
// Usage: node build-bargain-subject-fix.js <fresh get_workflow_details dump> <10d4f6fd snapshot> <ops out>
const fs = require('fs');
const { evalExpr, check, report } = require('./n8n-sim');

const [freshPath, snapshotPath, opsOut] = process.argv.slice(2);
const load = (p) => { const f = JSON.parse(fs.readFileSync(p, 'utf8')); return f.workflow || f.data || f; };
const live = load(freshPath);
const snap = load(snapshotPath);

// ── 0. Drift: the live workflow is still the version this fix is written against ──────────
check('0 drift', 'live draft is 10d4f6fd and it is the active version',
  live.versionId === '10d4f6fd-dcbb-4b2e-9771-864aa592cfb5' && live.activeVersionId === live.versionId,
  `versionId ${live.versionId} active ${live.activeVersionId}`);
const canon = (w) => JSON.stringify({
  nodes: [...w.nodes].sort((a, b) => a.name.localeCompare(b.name)).map((n) => ({ name: n.name, type: n.type, parameters: n.parameters })),
  connections: w.connections,
});
check('0 drift', 'live nodes + connections are byte-identical to the 10d4f6fd snapshot', canon(live) === canon(snap));

const byName = new Map(live.nodes.map((n) => [n.name, n]));
const resolve = byName.get('resolve variant');
const OLD_BODY = '={{ JSON.stringify($json.productId ? { productId: $json.productId } : { variantId: $json.variantId }) }}';
const NEW_BODY = "={{ JSON.stringify($('Inbound').first().json.productId ? { productId: $('Inbound').first().json.productId } : { variantId: $('Inbound').first().json.variantId }) }}";
check('0 drift', 'resolve variant still carries the $json body this replaces', resolve && resolve.parameters.jsonBody === OLD_BODY,
  resolve && resolve.parameters.jsonBody);

// ── 1. The body, evaluated with what actually reaches the node now ────────────────────────
// `$json` is what `answered already?` passes on (its output 1 = not answered yet).
const AFTER_CHECK = { answeredEcho: null, alreadyAnswered: false };
const inbound = (extra) => ({ mode: 'open', channel: 'whatsapp', externalId: '237600000001', messageId: 'wamid.sim', text: 'can I have it for 100?', language: 'en', quantity: 2, customerOffer: 100, ...extra });
const body = (expr, inb) => JSON.parse(evalExpr(expr, { nodes: { Inbound: [{ json: inb }] }, json: AFTER_CHECK }));

const P = '6ab20f6119b322f9b93349b8';
const V = '6ab20f6119b322f9b93349bc';
check('1 body', 'product + variant handed over → the product id is sent (as before 06:18)',
  JSON.stringify(body(NEW_BODY, inbound({ productId: P, variantId: V }))) === JSON.stringify({ productId: P }));
check('1 body', 'only a variant handed over → the variant id is sent',
  JSON.stringify(body(NEW_BODY, inbound({ variantId: V }))) === JSON.stringify({ variantId: V }));
check('1 body', 'nothing handed over → `{}`, and the server still says "name the product first"',
  JSON.stringify(body(NEW_BODY, inbound({}))) === '{}');
// Mutant: the live body, fed what reaches it today, reproduces exec 2851 exactly.
check('1 body', 'MUTANT (live body) sends {} for the owner\'s exact hand-over — the 2851 defect',
  JSON.stringify(body(OLD_BODY, inbound({ productId: P, variantId: V }))) === '{}');

// ── 2. The general property: nothing behind the answered check reads Inbound off $json ────
const INBOUND_FIELDS = ['mode', 'channel', 'externalId', 'messageId', 'text', 'language', 'variantId', 'productId', 'quantity', 'customerOffer'];
const CHECK_NODES = new Set(['read answered', 'was answered?', 'answered already?']);
const predecessors = (name) => Object.entries(live.connections).filter(([, c]) =>
  (c.main || []).some((out) => (out || []).some((t) => t.node === name))).map(([src]) => src);
function offenders(parametersOf) {
  const out = [];
  for (const n of live.nodes) {
    if (!predecessors(n.name).some((p) => CHECK_NODES.has(p)) || CHECK_NODES.has(n.name)) continue;
    const src = JSON.stringify(parametersOf(n));
    for (const f of INBOUND_FIELDS) if (new RegExp('\\$json\\.' + f + '\\b').test(src)) out.push(`${n.name} reads $json.${f}`);
  }
  return out;
}
const behind = live.nodes.filter((n) => !CHECK_NODES.has(n.name) && predecessors(n.name).some((p) => CHECK_NODES.has(p))).map((n) => n.name);
check('2 property', 'the scan has something to scan: resolve variant is behind the answered check (sentinel)', behind.includes('resolve variant'), behind.join(', '));
const patched = (n) => (n.name === 'resolve variant' ? { ...n.parameters, jsonBody: NEW_BODY } : n.parameters);
check('2 property', 'after the fix, no node behind the check reads an Inbound field off $json', offenders(patched).length === 0, offenders(patched).join('; '));
check('2 property', 'MUTANT (live parameters) is caught by the same scan', offenders((n) => n.parameters).includes('resolve variant reads $json.productId'), offenders((n) => n.parameters).join('; '));

// ── 3. Nothing else changes ───────────────────────────────────────────────────────────────
const ops = [{ type: 'setNodeParameter', nodeName: 'resolve variant', path: '/jsonBody', value: NEW_BODY }];
check('3 ops', 'exactly one operation, on resolve variant /jsonBody', ops.length === 1);

const failed = report();
if (!failed && opsOut) { fs.writeFileSync(opsOut, JSON.stringify(ops)); console.log('ops written:', opsOut); }
process.exitCode = failed ? 1 : 0;
