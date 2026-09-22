// The n8n half of the administrators' "reset the bot's memory for this customer" (owner, 2026-09-22).
//
// jovi-mall owns a per-customer MEMORY EPOCH (`/identity/sync` → `data.customer.memoryEpoch`,
// bumped by `POST /api/internal/admin/users/:userId/bot-memory/reset`, which wi-admin exposes to
// all three tiers). n8n folds it into both memory keys: epoch 0 — every customer who was never
// reset — keeps TODAY'S key byte for byte, epoch N > 0 appends `:e<N>`. A reset therefore makes the
// old memory unreachable at once, and the old keys expire on their own (core 2 h, bargain 1 h).
// jovi-mall never touches n8n's Redis, and nothing here depends on how n8n stores a message.
//
// Safe to apply BEFORE the backend ships: with no `memoryEpoch` on the sync answer every key is
// unchanged.
//
// ⚠ The bargainer is reached two ways (`open_negotiation` for a new haggle, `hand to bargainer`
// for a turn in one) and BOTH must pass the epoch, or a reset clears the haggle's memory on one path
// and not the other. The new Inbound input is UNTYPED on purpose: a blank `type: number` input
// throws before the callee runs (see the n8n typed sub-workflow input trap).
//
// Usage: node build-memory-epoch.js <fresh core dump> <fresh bargain dump> [core ops out] [bargain ops out]
const fs = require('fs');
const { evalExpr, check, report, j } = require('./n8n-sim');

const [corePath, bargainPath, coreOut, bargainOut] = process.argv.slice(2);
const load = (p) => { const f = JSON.parse(fs.readFileSync(p, 'utf8')); return f.workflow || f; };
const core = load(corePath);
const bargain = load(bargainPath);
const nodeOf = (w, name) => w.nodes.find((n) => n.name === name);

// ── § 0 · drift ─────────────────────────────────────────────────────────────────────────────
const S0 = '§ 0 · written against the live versions';
const CORE_VERSION = process.env.CORE_VERSION || '8942c69b-fe83-4e40-a66f-58c901d572e1';
const BARGAIN_VERSION = process.env.BARGAIN_VERSION || 'bd7930c9-528d-44da-9281-3f6bb2ca4b36';
check(S0, `core is ${CORE_VERSION.slice(0, 8)} and active`, core.versionId === CORE_VERSION && core.activeVersionId === core.versionId, core.versionId);
check(S0, `bargain is ${BARGAIN_VERSION.slice(0, 8)} and active`, bargain.versionId === BARGAIN_VERSION && bargain.activeVersionId === bargain.versionId, bargain.versionId);

// ── § 1 · the expressions ───────────────────────────────────────────────────────────────────
const S1 = '§ 1 · epoch 0 keeps today\'s key; epoch N appends :eN';
const CORE_MEM = nodeOf(core, 'Chat Memory');
const BARG_MEM = nodeOf(bargain, 'Bargain Memory');
const LIVE_CORE_KEY = CORE_MEM.parameters.sessionKey;
const LIVE_BARG_KEY = BARG_MEM.parameters.sessionKey;
check(S1, 'core key is the one this was written against',
  LIVE_CORE_KEY === "=wi-mall:chat:{{ $('Inbound').item.json.channel }}:{{ $('Inbound').item.json.externalId }}", LIVE_CORE_KEY);
check(S1, 'bargain key ends with the product segment this appends after', LIVE_BARG_KEY.endsWith("|| 'any' }}"), LIVE_BARG_KEY);

// One definition of "the epoch", read defensively: a missing, null, zero, negative or non-numeric
// value is 0, so a malformed sync answer can never move a customer onto an empty memory.
const EPOCH_OF = (src) => `(Math.trunc(Number(${src})) > 0 ? ':e' + Math.trunc(Number(${src})) : '')`;
const CORE_EPOCH_SRC = "($('sync identity').isExecuted ? $('sync identity').item.json.data?.customer?.memoryEpoch : 0)";
const NEW_CORE_KEY = LIVE_CORE_KEY + '{{ ' + EPOCH_OF(CORE_EPOCH_SRC) + ' }}';
const NEW_BARG_KEY = LIVE_BARG_KEY + "{{ " + EPOCH_OF("$('Inbound').first().json.memoryEpoch") + ' }}';

// A template evaluator: `=text{{a}}text{{b}}` (n8n-sim's evalExpr takes one `={{ }}` only).
const render = (tmpl, ctx) => tmpl.slice(1).replace(/\{\{([^]*?)\}\}/g, (all, inner) => String(evalExpr('={{' + inner + '}}', ctx)));
const coreCtx = (epoch, synced = true) => ({ nodes: Object.assign(
  { Inbound: [j({ channel: 'whatsapp', externalId: '237600000001' })] },
  synced ? { 'sync identity': [j({ data: { customer: epoch === undefined ? {} : { memoryEpoch: epoch } } })] } : {}) });
const TODAY = 'wi-mall:chat:whatsapp:237600000001';
for (const [label, epoch] of [['absent', undefined], ['0', 0], ['null', null], ['"0"', '0'], ['negative', -2], ['garbage', 'abc']]) {
  check(S1, `core, epoch ${label} → today's key, byte for byte`, render(NEW_CORE_KEY, coreCtx(epoch)) === TODAY, render(NEW_CORE_KEY, coreCtx(epoch)));
}
check(S1, 'core, epoch 3 → today\'s key + ":e3"', render(NEW_CORE_KEY, coreCtx(3)) === TODAY + ':e3');
check(S1, 'core, epoch "4" (a string) → ":e4"', render(NEW_CORE_KEY, coreCtx('4')) === TODAY + ':e4');
check(S1, 'core, sync identity did not run → today\'s key (never a throw)', render(NEW_CORE_KEY, coreCtx(3, false)) === TODAY);
check(S1, 'MUTANT: the live key ignores a reset (epoch 3 → the same memory as before)', render(LIVE_CORE_KEY, coreCtx(3)) === TODAY);

const bargCtx = (epoch) => ({ nodes: {
  Inbound: [j(Object.assign({ channel: 'whatsapp', externalId: '237600000001', productId: 'P1' }, epoch === undefined ? {} : { memoryEpoch: epoch }))],
  'pick variant': [j({ productId: 'P1' })] } });
const BTODAY = 'wi-mall:bargain-chat:whatsapp:237600000001:P1';
check(S1, 'bargain, no epoch passed → today\'s key', render(NEW_BARG_KEY, bargCtx(undefined)) === BTODAY, render(NEW_BARG_KEY, bargCtx(undefined)));
check(S1, 'bargain, epoch "0" → today\'s key', render(NEW_BARG_KEY, bargCtx('0')) === BTODAY);
check(S1, 'bargain, epoch "3" → today\'s key + ":e3"', render(NEW_BARG_KEY, bargCtx('3')) === BTODAY + ':e3');
check(S1, 'the live bargain key renders as today\'s (the evaluator agrees with production)', render(LIVE_BARG_KEY, bargCtx(undefined)) === BTODAY);

// ── § 2 · both callers pass it, and the bargainer accepts it ───────────────────────────────
const S2 = '§ 2 · both roads into the bargainer carry the epoch';
const EPOCH_INPUT = "={{ String($('sync identity').isExecuted ? ($('sync identity').first().json.data?.customer?.memoryEpoch ?? 0) : 0) }}";
const SCHEMA_ROW = { id: 'memoryEpoch', displayName: 'memoryEpoch', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' };
const withEpoch = (node) => {
  const wi = JSON.parse(JSON.stringify(node.parameters.workflowInputs));
  wi.value.memoryEpoch = EPOCH_INPUT;
  wi.schema = wi.schema.filter((r) => r.id !== 'memoryEpoch').concat([SCHEMA_ROW]);
  return wi;
};
const callers = ['open_negotiation', 'hand to bargainer'].map((name) => nodeOf(core, name));
callers.forEach((n, i) => {
  const name = ['open_negotiation', 'hand to bargainer'][i];
  check(S2, `${name} exists, calls the bargainer, and does not pass an epoch yet`,
    n && n.parameters.workflowId.value === 'lJdli0uwOtWBGx5R' && !('memoryEpoch' in n.parameters.workflowInputs.value));
  const wi = withEpoch(n);
  check(S2, `${name}: every live input survives unchanged`, Object.keys(n.parameters.workflowInputs.value).every((k) => wi.value[k] === n.parameters.workflowInputs.value[k]));
  check(S2, `${name}: the schema gains exactly one string row`, wi.schema.length === n.parameters.workflowInputs.schema.length + 1 && wi.schema[wi.schema.length - 1].type === 'string');
});
check(S2, 'the epoch input renders "3" / "0" / "0" (no sync) — a string, never a blank number',
  evalExpr(EPOCH_INPUT, coreCtx(3)) === '3' && evalExpr(EPOCH_INPUT, coreCtx(undefined)) === '0' && evalExpr(EPOCH_INPUT, coreCtx(3, false)) === '0');
const INBOUND = nodeOf(bargain, 'Inbound');
const NEW_INBOUND_VALUES = INBOUND.parameters.workflowInputs.values.concat([{ name: 'memoryEpoch' }]);
check(S2, 'the bargainer\'s Inbound gains memoryEpoch, UNTYPED (a typed blank would throw)',
  !INBOUND.parameters.workflowInputs.values.some((v) => v.name === 'memoryEpoch') && !('type' in NEW_INBOUND_VALUES[NEW_INBOUND_VALUES.length - 1]));

// ── § 3 · operations ────────────────────────────────────────────────────────────────────────
const coreOps = [
  { type: 'setNodeParameter', nodeName: 'Chat Memory', path: '/sessionKey', value: NEW_CORE_KEY },
  { type: 'setNodeParameter', nodeName: 'open_negotiation', path: '/workflowInputs', value: withEpoch(callers[0]) },
  { type: 'setNodeParameter', nodeName: 'hand to bargainer', path: '/workflowInputs', value: withEpoch(callers[1]) },
];
const bargainOps = [
  { type: 'setNodeParameter', nodeName: 'Inbound', path: '/workflowInputs/values', value: NEW_INBOUND_VALUES },
  { type: 'setNodeParameter', nodeName: 'Bargain Memory', path: '/sessionKey', value: NEW_BARG_KEY },
];
check('§ 3 · operations', 'core 3 ops, bargain 2 ops', coreOps.length === 3 && bargainOps.length === 2);

const failed = report();
if (!failed && coreOut && bargainOut) {
  fs.writeFileSync(coreOut, JSON.stringify(coreOps));
  fs.writeFileSync(bargainOut, JSON.stringify(bargainOps));
  console.log('ops written:', coreOut, bargainOut);
}
process.exitCode = failed ? 1 : 0;
