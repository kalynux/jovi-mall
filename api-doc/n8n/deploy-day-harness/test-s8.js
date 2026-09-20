// § 8 · bargaining — the routing keys follow the buttons, and the counter-offer can carry one.
const { runCode, evalExpr, check, j } = require('./n8n-sim');
const { NEW, live, liveBargain } = require('./build-new');

const MSG_85 = 'wamid.ALT';
const S8 = '§ 8 · bargaining keys and the gate\'s body';
const PRODUCT = '68b0aa0000000000000000aa';
const VARIANT = '68c0bb0000000000000000bb';
const INB = { channel: 'whatsapp', externalId: '237672745831', messageId: 'wamid.B', kind: 'token', token: 'x', text: '' };

const switchOn = (expr, data) => evalExpr(expr, { json: { success: true, data } });
const CLOSED = NEW['core:bargain key change?.closed'];
const REOPEN = NEW['core:bargain key change?.reopen'];

// ── which branch a real response takes ───────────────────────────────────────
const responses = [
  ['lock it in — the deal closed by a press', { outcome: 'deal_locked', negotiation: { closed: true, closedBy: 'button', sessionId: 's1', productId: PRODUCT, variantId: VARIANT, quantity: 1, unitPrice: 18000, currency: 'XAF' } }, 'closed'],
  ['bargain button — a haggle re-opened', { outcome: 'chat', verb: 'bargain', productId: PRODUCT, variantId: VARIANT }, 'reopen'],
  ['⚠ a Bargain card whose window the vendor has CLOSED — the server re-resolved the rung', { outcome: 'cart', verb: 'add', productId: PRODUCT, variantId: VARIANT }, 'none'],
  ['⚠ a book: tap — a booking names a product and a slot, variantId is null', { outcome: 'chat', verb: 'book', productId: PRODUCT, variantId: null }, 'none'],
  ['⚠ a chat tap of some other verb', { outcome: 'chat', verb: 'tkt', productId: null, variantId: null }, 'none'],
  ['an ordinary add to cart', { outcome: 'cart', verb: 'add' }, 'none'],
  ['an answer with no data at all', undefined, 'none'],
];
for (const [name, data, want] of responses) {
  const got = switchOn(CLOSED, data) ? 'closed' : (switchOn(REOPEN, data) ? 'reopen' : 'none');
  check(S8, `${name} → ${got}`, got === want, JSON.stringify({ data, got, want }));
}
check(S8, '⛔ a re-opened haggle is never also read as a close (the two rules are exclusive)',
  !(switchOn(CLOSED, { outcome: 'chat', verb: 'bargain', variantId: VARIANT }) && switchOn(REOPEN, { outcome: 'chat', verb: 'bargain', variantId: VARIANT })));

// ── ⭐ the cross-workflow pin: what n8n WRITES must satisfy what core READS ───
// `set bargain flag (tap)` and `read bargain flag` are different nodes and nothing compares
// them — the same shape of trap as this platform's shared secrets. So the written value is fed
// to the LIVE reader and the verdict is asserted.
const written = JSON.parse(evalExpr(NEW['core:set bargain flag (tap).value'], {
  nodes: { 'product action': [j({ success: true, data: { outcome: 'chat', verb: 'bargain', productId: PRODUCT, variantId: VARIANT } })] },
  json: {},
}));
check(S8, 'the flag carries variantId, productId, quantity 1 and an expiry', written.variantId === VARIANT && written.productId === PRODUCT && written.quantity === 1 && typeof written.expiresAt === 'string', JSON.stringify(written));
check(S8, 'the expiry is 30 minutes out — it mirrors NEGOTIATION_SESSION_TTL_MINUTES, which n8n cannot read', (() => {
  const mins = (new Date(written.expiresAt).getTime() - Date.now()) / 60000;
  return mins > 29 && mins <= 30.5;
})(), written.expiresAt);

const readFlag = (flagValue, lockValue, kind = 'text') => runCode(live['read bargain flag'].parameters.jsCode, {
  nodes: {
    Inbound: [j(Object.assign({}, INB, { kind, text: 'can you do better?' }))],
    'sync identity': [j({ data: { customer: { language: 'fr' } } })],
    'check bargain': [j({ bargainFlag: flagValue })],
  },
  input: [j({ priceLock: lockValue })],
  mode: 'each',
})[0].json;

let verdict = readFlag(JSON.stringify(written), null);
check(S8, '⭐ the LIVE reader accepts it: the next typed line goes to the bargainer', verdict.bargaining === true && verdict.variantId === VARIANT && verdict.productId === PRODUCT && verdict.quantity === 1, JSON.stringify(verdict));
check(S8, 'and it carries no agreed price — a re-opened haggle has nothing agreed yet', verdict.agreedPrice === 'none');

// the guard that makes the `book:` exclusion matter
const withoutVariant = JSON.stringify({ variantId: null, productId: PRODUCT, quantity: 1, expiresAt: new Date(Date.now() + 1800000).toISOString() });
check(S8, '⛔ a flag without variantId is REFUSED by the reader — which is why § 8.2 declines to write one', readFlag(withoutVariant, null).bargaining === false);
const expired = JSON.stringify(Object.assign({}, written, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
check(S8, 'an expired flag is treated as absent (the Redis node cannot set a TTL, so the value is the authority)', readFlag(expired, null).bargaining === false);
check(S8, 'a tap mid-haggle still does not go to the bargainer — it wants typed text', readFlag(JSON.stringify(written), null, 'token').bargaining === false);

// ── deleting the keys on a close: what the reader says afterwards ────────────
check(S8, 'after the close deletes both keys, the next line reaches the MAIN agent', readFlag(null, null).bargaining === false);
const staleLock = JSON.stringify({ ref: 'nlk_stale', variantId: VARIANT, quantity: 1, unitPrice: 18000, expiresAt: new Date(Date.now() + 600000).toISOString() });
check(S8, '⛔ a lock left behind by a button close would still be offered to the model as spendable — which is why it is deleted', /^ref nlk_stale/.test(readFlag(null, staleLock).agreedPrice), readFlag(null, staleLock).agreedPrice);

// ── § 8.4 · the gate's channel-ready body ────────────────────────────────────
const S84 = '§ 8.4 · decide send prefers data.outbound';
const bargainInb = { channel: 'telegram', externalId: '42', messageId: 'm9', text: '15000', variantId: VARIANT, quantity: 1, mode: 'turn' };
const gateEcho = (data) => JSON.stringify(Object.assign({ __messageId: 'm9' }, data));
const decide = (code, echoData, agentOut) => {
  const nodes = { Inbound: [j(bargainInb)], 'read gate echo': [j({ gateEcho: echoData === null ? null : gateEcho(echoData) })] };
  if (agentOut !== undefined) nodes['Bargain Agent'] = [j({ output: agentOut })];
  return runCode(code, { nodes, input: [j({})] })[0].json;
};
const approved = { success: true, data: { verdict: 'approved', reply: 'I can do 18 000 XAF.' } };
const outbound = { channel: 'telegram', method: 'sendMessage', body: { chat_id: '42', text: 'I can do 18 000 XAF.', reply_markup: { inline_keyboard: [[{ text: 'Lock it in · 18 000 XAF', callback_data: 'deal:s1:2' }]] } } };

let a = decide(liveBargain['decide send'].parameters.jsCode, approved);
let b = decide(NEW['bargain:decide send'], approved);
check(S84, 'unchanged — an approved turn with no outbound still sends the gate\'s sentence as plain text', JSON.stringify(a) === JSON.stringify(b) && b.reply.body.text === 'I can do 18 000 XAF.');
b = decide(NEW['bargain:decide send'], { success: true, data: Object.assign({ outbound }, approved.data) });
check(S84, 'with outbound: the customer gets the same sentence WITH a Lock-it-in button', JSON.stringify(b.reply) === JSON.stringify(outbound) && b.handled === true, JSON.stringify(b.reply));
b = decide(NEW['bargain:decide send'], { success: true, data: Object.assign({ outbound: { channel: 'telegram' } }, approved.data) });
check(S84, 'a malformed outbound falls back to the sentence rather than sending nothing', b.reply.body.text === 'I can do 18 000 XAF.');

for (const [name, echoData, agentOut] of [
  ['a revise verdict sends nothing and hands back', { success: true, data: { verdict: 'revise' } }, 'whatever'],
  ['a failed gate call closes the session', { success: false, error: { code: 'X' } }, 'whatever'],
  ['no gate at all — the model\'s own words go', null, 'Delivery is 1 000 XAF.'],
  ['#HANDBACK# ends the haggle', null, '#HANDBACK#'],
  ['an agent error keeps the session and hands back', null, undefined],
]) {
  const x = decide(liveBargain['decide send'].parameters.jsCode, echoData, agentOut);
  const y = decide(NEW['bargain:decide send'], echoData, agentOut);
  check(S84, `unchanged — ${name}`, JSON.stringify(x) === JSON.stringify(y), `${JSON.stringify(x)}\n      ${JSON.stringify(y)}`);
}

// guard bites: a version that sends `outbound` even when the gate did not approve
const mutant = NEW['bargain:decide send'].replace("    const ob = echo.data.outbound;\n    if (ob && ob.channel && ob.method && ob.body) { outbound = ob; }\n", '')
  .replace('let reply = null;\nif (outbound) {', 'let reply = null;\nif (echo && echo.data && echo.data.outbound) { reply = echo.data.outbound; } else if (false) {');
let bit = false;
try {
  const m = decide(mutant, { success: true, data: { verdict: 'revise', outbound } });
  if (m.handled === true) bit = true;
} catch (e) { bit = true; }
check(S84, 'guard bites — sending the gate\'s body on a REVISE verdict is caught', bit);

// ── § 8.5 · the alternatives the bargainer handed back ───────────────────────
const S85 = '§ 8.5 · alternatives handed back to the main agent';
const ID1 = '68b0aa0000000000000000aa';
const ID2 = '68c0bb0000000000000000bb';
const HANDED = NEW['core:alternatives handed back?'];

check(S85, 'a return carrying product ids continues to the main agent', evalExpr(HANDED, { json: { handled: true, handoff: { productIds: [ID1, ID2] } } }) === true);
for (const [name, ret] of [
  ['an ordinary bargained turn (no alternatives)', { handled: true, verdict: 'unpriced' }],
  ['an empty list', { handled: true, handoff: { productIds: [] } }],
  ['a handoff of the wrong shape', { handled: true, handoff: { productIds: 'nope' } }],
]) {
  check(S85, `${name} → the turn still ends with the bargainer, as today`, evalExpr(HANDED, { json: ret }) === false);
}

const composeWithHandoff = (handoffJson, kind = 'text') => runCode(NEW['core:compose agent input'], {
  nodes: {
    Inbound: [j({ channel: 'telegram', externalId: '42', messageId: 'm1', kind, text: 'too expensive' })],
    'hand to bargainer': [j(handoffJson)],
  },
  input: [j({})],
  mode: 'each',
})[0].json.agentInput;

const noted = composeWithHandoff({ handled: true, handoff: { productIds: [ID1, ID2] } });
check(S85, 'the model is told to draw exactly those ids, in order', noted.indexOf(ID1) < noted.indexOf(ID2) && /Call Show-Products with exactly those ids/.test(noted), noted);
check(S85, '⛔ and to write nothing of its own — the seller has the floor', /write nothing of your own/.test(noted) && /Never mention a price/.test(noted));
check(S85, '⛔ junk ids from another workflow never reach the model', !/drop table|<script>/i.test(composeWithHandoff({ handoff: { productIds: ['drop table x', '<script>', ID1] } })) && composeWithHandoff({ handoff: { productIds: ['drop table x', ID1] } }).indexOf(ID1) > 0);
check(S85, 'a handoff of ten-plus ids is capped', (composeWithHandoff({ handoff: { productIds: new Array(30).fill(ID1) } }).match(/68b0aa/g) || []).length === 10);

const liveInput = (handoffJson) => runCode(live['compose agent input'].parameters.jsCode, {
  nodes: { Inbound: [j({ channel: 'telegram', externalId: '42', messageId: 'm1', kind: 'text', text: 'too expensive' })], 'hand to bargainer': [j(handoffJson)] },
  input: [j({})],
  mode: 'each',
})[0].json.agentInput;
for (const [name, ret] of [
  ['a bargained turn with no alternatives', { handled: true }],
  ['no handoff key at all', {}],
]) {
  check(S85, `unchanged — ${name}`, composeWithHandoff(ret) === liveInput(ret), `${composeWithHandoff(ret)} vs ${liveInput(ret)}`);
}
check(S85, 'unchanged — a turn where the bargainer never ran (the node is guarded)', runCode(NEW['core:compose agent input'], {
  nodes: { Inbound: [j({ channel: 'telegram', externalId: '42', messageId: 'm1', kind: 'text', text: 'hello' })] }, input: [j({})], mode: 'each',
})[0].json.agentInput === 'hello');

// The cards survive the bargain suppression, the agent's own line does not — the property the
// whole hand-back rests on. Proven against the pair of nodes that actually decide it.
const inbound = { channel: 'telegram', externalId: '42', messageId: MSG_85, kind: 'text', text: 'too expensive' };
const cards = [
  { channel: 'telegram', method: 'sendPhoto', body: { chat_id: '42', photo: 'https://cdn/1.jpg', caption: 'Alternative 1' } },
  { channel: 'telegram', method: 'sendPhoto', body: { chat_id: '42', photo: 'https://cdn/2.jpg', caption: 'Alternative 2' } },
];
const composed = runCode(NEW['core:compose agent reply'], {
  nodes: {
    Inbound: [j(inbound)], 'sync identity': [j({ data: { fallback: { assistantUnavailable: 'SI' } } })],
    'check display': [j({ displayEcho: JSON.stringify({ __messageId: MSG_85, expiresAt: new Date(Date.now() + 60000).toISOString(), replies: cards }) })],
    'AI Agent': [j({ output: 'Here are two others.' })],
  },
  input: [j({})],
});
const dropped = runCode(NEW['core:drop duplicate reply'], {
  nodes: {
    Inbound: [j(inbound)], 'compose agent reply': composed,
    'read bargain echo': [j({ bargainAnswered: JSON.stringify({ messageId: MSG_85, expiresAt: new Date(Date.now() + 60000).toISOString() }) })],
  },
  input: [j({})],
}).map((i) => i.json.reply.body.caption || i.json.reply.body.text);
check(S85, '⭐ on that turn the cards go out and the agent\'s own line does NOT — one sender keeps the pen', JSON.stringify(dropped) === JSON.stringify(['Alternative 1', 'Alternative 2']), JSON.stringify(dropped));
