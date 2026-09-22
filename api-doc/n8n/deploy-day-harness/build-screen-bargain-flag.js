// § 8.2a — Bargain pressed on the in-app DETAIL SCREEN sets the bargaining flag.
//
// Asked for by the session building the screen half (its backend change is in the tree, not yet
// committed): a screen press goes page → jovi-mall and NEVER through n8n, so `bargain key change?`
// never sees it, the flag is never set, and the customer's offer reaches the main assistant with no
// product in view. jovi-mall now hands the press over ONCE, on the next `/identity/sync`, as
// `data.pendingBargain = { productId, variantId, quantity }`; this writes the same flag a TAP writes.
//
// ⛔ ONE DEPARTURE FROM THE SPEC I WAS HANDED, AND IT IS WHY THIS HARNESS EXISTS.
// The spec wires `sync identity → [pendingBargain?] → clear price lock (screen) → set bargain flag
// (screen) → detect command`. `detect command` reads its sync body from `$input.first().json`, and a
// Redis node's output is an API result, NOT the item that entered it (this workflow's own
// `compose agent reply` carries that warning about a Redis DELETE). So the spec as written feeds
// `detect command` a Redis result on every screen-press turn — `data.customer.botToken` and the
// whole identity would vanish downstream. Same shape as the bargain regression of this morning:
// inserting a node before another changes what that other node reads.
// The fix here: `detect command` reads `$('sync identity')` by name, which is correct on BOTH paths
// and cannot be broken by whatever is inserted before it again.
//
// Usage: node build-screen-bargain-flag.js <fresh core dump> [ops out]
const fs = require('fs');
const { runCode, evalExpr, check, report, j } = require('./n8n-sim');

const [corePath, opsOut] = process.argv.slice(2);
const core = (() => { const f = JSON.parse(fs.readFileSync(corePath, 'utf8')); return f.workflow || f; })();
const nodeOf = (name) => core.nodes.find((n) => n.name === name);
const CORE_VERSION = process.env.CORE_VERSION || 'b59c40a2-7a70-45af-b272-9bc8ec661857';

const S0 = '§ 0 · drift';
check(S0, `core is ${CORE_VERSION.slice(0, 8)} and active`, core.versionId === CORE_VERSION && core.activeVersionId === core.versionId, core.versionId);
check(S0, 'sync identity still feeds detect command on output 0',
  JSON.stringify(core.connections['sync identity'].main[0]) === JSON.stringify([{ node: 'detect command', type: 'main', index: 0 }]),
  JSON.stringify(core.connections['sync identity'].main[0]));
check(S0, 'none of the three new nodes exists yet',
  ['pendingBargain?', 'clear price lock (screen)', 'set bargain flag (screen)'].every((n) => !nodeOf(n)));

// ── § 1 · the flag a SCREEN press writes is the flag a TAP writes ───────────────────────────
const S1 = '§ 1 · the same flag as a tap';
const TAP_FLAG = nodeOf('set bargain flag (tap)');
const LOCK = nodeOf('clear price lock (reopen)');
const REDIS_CREDS = TAP_FLAG.credentials;
const KEY = TAP_FLAG.parameters.key;
const LOCK_KEY = LOCK.parameters.key;
const SCREEN_VALUE = "={{ JSON.stringify({ variantId: $('sync identity').first().json.data.pendingBargain.variantId, productId: $('sync identity').first().json.data.pendingBargain.productId, quantity: Number($('sync identity').first().json.data.pendingBargain.quantity) || 1, expiresAt: $now.plus({ minutes: 30 }).toISO() }) }}";
const IF_EXPR = "={{ !!$('sync identity').item.json.data?.pendingBargain?.variantId }}";

const inbound = { channel: 'whatsapp', externalId: '237600000001', messageId: 'wamid.sim', kind: 'text', text: 'can you do 9000?' };
const syncBody = (pendingBargain) => ({
  success: true,
  data: {
    registered: true, state: 'customer',
    customer: { displayName: 'Ama', language: 'en', botToken: 'v2.sim-token', memoryEpoch: 0, pendingQuestion: null },
    onboarding: { complete: true, next: null },
    ...(pendingBargain === undefined ? {} : { pendingBargain }),
  },
});
const ctx = (pendingBargain, extra = {}) => ({ nodes: Object.assign({
  Inbound: [j(inbound)],
  'sync identity': [j(syncBody(pendingBargain))],
  'product action': [j({ data: { variantId: 'V-tap', productId: 'P-tap' } })],
}, extra) });
const PB = { productId: 'P-screen', variantId: 'V-screen', quantity: 1 };

check(S1, 'the key is the tap\'s key, character for character', KEY === "=wi-mall:bargain:{{ $('Inbound').first().json.channel }}:{{ $('Inbound').first().json.externalId }}");
const render = (tmpl, c) => tmpl.slice(1).replace(/\{\{([^]*?)\}\}/g, (all, inner) => String(evalExpr('={{' + inner + '}}', c)));
check(S1, 'and it renders to the very key `check bargain` reads',
  render(KEY, ctx(PB)) === render(nodeOf('check bargain').parameters.key, ctx(PB)), render(KEY, ctx(PB)));
const tapValue = JSON.parse(evalExpr(TAP_FLAG.parameters.value, ctx(PB)));
const screenValue = JSON.parse(evalExpr(SCREEN_VALUE, ctx(PB)));
check(S1, 'the value has exactly the tap\'s fields, in the same order',
  JSON.stringify(Object.keys(screenValue)) === JSON.stringify(Object.keys(tapValue)), Object.keys(screenValue).join(','));
check(S1, 'and it carries the SCREEN\'s product, not the tap node\'s',
  screenValue.variantId === 'V-screen' && screenValue.productId === 'P-screen' && screenValue.quantity === 1);
check(S1, 'the expiry is half an hour out, like the tap\'s', Math.abs(new Date(screenValue.expiresAt) - new Date(tapValue.expiresAt)) < 1000
  && new Date(screenValue.expiresAt).getTime() - Date.now() > 29 * 60000);
check(S1, 'a quantity the backend did not set still writes 1',
  JSON.parse(evalExpr(SCREEN_VALUE, ctx({ productId: 'P', variantId: 'V' }))).quantity === 1);

check(S1, 'the IF fires on a hand-over', evalExpr(IF_EXPR, ctx(PB)) === true);
for (const [label, pb] of [['absent', undefined], ['null', null], ['no variantId', { productId: 'P' }], ['empty variantId', { productId: 'P', variantId: '' }]]) {
  check(S1, `the IF does NOT fire: pendingBargain ${label}`, evalExpr(IF_EXPR, ctx(pb)) === false, String(evalExpr(IF_EXPR, ctx(pb))));
}
check(S1, 'the lock cleared is the price lock, the tap\'s own key', LOCK_KEY === "=wi-mall:bargain:lock:{{ $('Inbound').first().json.channel }}:{{ $('Inbound').first().json.externalId }}");

// ── § 2 · detect command must still see the SYNC body, not a Redis result ───────────────────
const S2 = '§ 2 · the node after the insertion';
const LIVE_DETECT = nodeOf('detect command').parameters.jsCode;
const FROM = 'const sync = $input.first().json;';
const TO = [
  "// ⚠ READ BY NAME, NOT FROM WHATEVER RAN LAST. Since § 8.2a there are Redis nodes between",
  "// `sync identity` and this one on a screen-press turn, and a Redis node's output is an API",
  "// result rather than the item that entered it -- so `$input` here would be `{ success: true }`",
  "// and every identity field downstream (the botToken included) would be gone.",
  "const sync = $('sync identity').first().json;",
].join('\n');
check(S2, 'the live line is found exactly once', LIVE_DETECT.split(FROM).length - 1 === 1);
const NEW_DETECT = LIVE_DETECT.replace(FROM, TO);
const REDIS_RESULT = [j({ success: true })];           // what a Redis set/delete emits
const runDetect = (code, input) => runCode(code, { nodes: ctx(PB).nodes, input })[0].json;
check(S2, 'MUTANT: the LIVE node, fed a Redis result, loses the whole identity',
  runDetect(LIVE_DETECT, REDIS_RESULT).data === undefined && runDetect(LIVE_DETECT, REDIS_RESULT).success === true);
const after = runDetect(NEW_DETECT, REDIS_RESULT);
check(S2, '⭐ the new node keeps the identity on a screen-press turn',
  after.data && after.data.customer && after.data.customer.botToken === 'v2.sim-token' && after.data.pendingBargain.variantId === 'V-screen');
// An ordinary turn: nothing is inserted, so `sync identity`'s item IS this node's input — the two
// readings must agree exactly. (The fixture must hand both the SAME sync body, or it proves nothing.)
const ordinary = { nodes: ctx(undefined).nodes, input: [j(syncBody(undefined))] };
check(S2, 'and is byte-identical to the live node on an ordinary turn',
  JSON.stringify(runCode(NEW_DETECT, ordinary)[0].json) === JSON.stringify(runCode(LIVE_DETECT, ordinary)[0].json));
check(S2, 'a slash command is still detected either way', runDetect(NEW_DETECT, REDIS_RESULT, '/login')._kind !== undefined
  && runCode(NEW_DETECT, { nodes: Object.assign({}, ctx(PB).nodes, { Inbound: [j({ ...inbound, text: '/login' })] }), input: REDIS_RESULT })[0].json._kind === 'slash');

// ── § 3 · the operations ────────────────────────────────────────────────────────────────────
const S3 = '§ 3 · operations';
const ops = [
  { type: 'addNode', node: { name: 'pendingBargain?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [-1232, 1808],
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 }, combinator: 'and',
      conditions: [{ id: 'screen-bargain', leftValue: IF_EXPR, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
      looseTypeValidation: true, options: {} } } },
  { type: 'addNode', node: { name: 'clear price lock (screen)', type: 'n8n-nodes-base.redis', typeVersion: 1, position: [-1232, 1952],
    parameters: { operation: 'delete', key: LOCK_KEY }, credentials: REDIS_CREDS } },
  { type: 'addNode', node: { name: 'set bargain flag (screen)', type: 'n8n-nodes-base.redis', typeVersion: 1, position: [-1008, 1952],
    parameters: { operation: 'set', key: KEY, value: SCREEN_VALUE }, credentials: REDIS_CREDS } },
  { type: 'removeConnection', source: 'sync identity', target: 'detect command', sourceIndex: 0, targetIndex: 0 },
  { type: 'addConnection', source: 'sync identity', target: 'pendingBargain?', sourceIndex: 0, targetIndex: 0 },
  { type: 'addConnection', source: 'pendingBargain?', target: 'clear price lock (screen)', sourceIndex: 0, targetIndex: 0 },
  { type: 'addConnection', source: 'pendingBargain?', target: 'detect command', sourceIndex: 1, targetIndex: 0 },
  { type: 'addConnection', source: 'clear price lock (screen)', target: 'set bargain flag (screen)', sourceIndex: 0, targetIndex: 0 },
  { type: 'addConnection', source: 'set bargain flag (screen)', target: 'detect command', sourceIndex: 0, targetIndex: 0 },
  { type: 'setNodeParameter', nodeName: 'detect command', path: '/jsCode', value: NEW_DETECT },
];
check(S3, 'three new nodes, the same Redis credential as the tap path', ops.filter((o) => o.type === 'addNode').length === 3
  && ops.filter((o) => o.node && o.node.type === 'n8n-nodes-base.redis').every((o) => JSON.stringify(o.node.credentials) === JSON.stringify(REDIS_CREDS)));
check(S3, 'both ways out of the IF reach detect command — no turn is dropped',
  ops.some((o) => o.type === 'addConnection' && o.source === 'pendingBargain?' && o.sourceIndex === 1 && o.target === 'detect command')
  && ops.some((o) => o.type === 'addConnection' && o.source === 'set bargain flag (screen)' && o.target === 'detect command'));
check(S3, 'the flag is written INLINE, before detect command — never a side branch',
  !ops.some((o) => o.type === 'addConnection' && o.source === 'sync identity' && o.target !== 'pendingBargain?'));
check(S3, 'the error output of sync identity is untouched',
  !ops.some((o) => (o.type === 'removeConnection' || o.type === 'addConnection') && o.source === 'sync identity' && o.sourceIndex === 1));

const failed = report();
if (!failed && opsOut) {
  fs.writeFileSync(opsOut, JSON.stringify(ops));
  fs.writeFileSync(__dirname + '/new/h3_detect_command.txt', NEW_DETECT);
  console.log('ops written:', opsOut);
}
process.exitCode = failed ? 1 : 0;
