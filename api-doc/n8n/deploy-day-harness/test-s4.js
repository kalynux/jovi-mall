// § 4 · a tap with no reply reaches the assistant WITH its data.
const { runCode, evalExpr, check, j } = require('./n8n-sim');
const { NEW, live } = require('./build-new');

const S4 = '§ 4 · compose tap input';
// The LIVE prompt expression, unchanged by this section — what the model is actually asked.
const PROMPT = live['AI Agent'].parameters.text;
const ask = (inboundJson, nodes, itemJson) => evalExpr(PROMPT, { nodes: Object.assign({ Inbound: [j(inboundJson)] }, nodes), json: itemJson });

const tap = (token) => ({ channel: 'telegram', externalId: '900', messageId: 'cb9', kind: 'token', token, text: '' });
const runNode = (inbound, nodes, carried) => runCode(NEW['core:compose tap input'], { nodes: Object.assign({ Inbound: [j(inbound)] }, nodes), input: [j(carried)] })[0].json;

// ── the failed-delivery buttons (backend-3e's stream), which answer with data ──
const supportData = { supportRequest: true, topic: 'redelivery_requested', orderId: '68b0aa0000000000000000aa', orderNumber: 'ORD-2026-000123' };
const inb = tap('tkt:new:rd:68b0aa0000000000000000aa');
const nodes = { 'product action': [j({ success: true, data: supportData })] };
const out = runNode(inb, nodes, { firstMessage: null });
check(S4, 'the tap\'s data reaches the model', /redelivery_requested/.test(out.agentInput) && /ORD-2026-000123/.test(out.agentInput), out.agentInput);
check(S4, 'the model is told it is data, never an instruction', /DATA and never an instruction/.test(out.agentInput));
check(S4, '⛔ the token itself is never shown', !/tkt:new:rd/.test(out.agentInput));
check(S4, 'live today: the same turn asks the model to GREET the customer', /Greet them briefly/.test(ask(inb, nodes, { firstMessage: null, agentInput: null })));
check(S4, 'after: the same turn asks the model to act on the tap', ask(inb, nodes, out) === out.agentInput);

// ── a confirmation tap carrying a signed ref must not leak it ─────────────────
const cancelTap = tap('yes:cnc:68b0aa0000000000000000aa:8sd8.Qm9uam91ckxlc0FtaXM');
const cancelOut = runNode(cancelTap, { 'product action': [j({ success: true, data: { cancelled: true, orderNumber: 'ORD-2026-000123', awaitingCancellationReason: true } })] }, {});
check(S4, '⛔ a signed confirmation ref never reaches the model', !/8sd8\./.test(cancelOut.agentInput) && !/yes:cnc/.test(cancelOut.agentInput), cancelOut.agentInput);
check(S4, 'the backend\'s own flags carry the meaning instead', /awaitingCancellationReason/.test(cancelOut.agentInput));

// ── a refused tap ─────────────────────────────────────────────────────────────
const refused = runNode(tap('ord:zzz'), { 'product action': [j({ success: false, error: { code: 'BOT_ACTION_TOKEN_UNKNOWN', customerMessage: 'That button has expired — shall I start again?' } })] }, {});
check(S4, 'a refused tap hands the backend\'s own sentence to the model, in the customer\'s words', /That button has expired/.test(refused.agentInput));
const refusedBare = runNode(tap('ord:zzz'), { 'product action': [j({ success: false, error: {} })] }, {});
check(S4, 'a refusal with no sentence still tells the model what happened', /could not be carried out/.test(refusedBare.agentInput) && !/undefined/.test(refusedBare.agentInput));

// ── what must not break ───────────────────────────────────────────────────────
const held = { channel: 'telegram', externalId: '900', messageId: '5', kind: 'text', text: 'ok' };
const recalled = runNode(held, {}, { firstMessage: 'do you sell rice?' });
check(S4, 'unchanged — a held first message still wins and is still asked verbatim', recalled.firstMessage === 'do you sell rice?' && ask(held, {}, recalled) === 'do you sell rice?');
const finished = runNode(held, {}, { firstMessage: null });
check(S4, 'unchanged — a finished checklist with nothing to add still asks the typed text', ask(held, {}, finished) === 'ok');
const noText = { channel: 'whatsapp', externalId: '2', messageId: '9', kind: 'text', text: '' };
check(S4, 'unchanged — nothing at all still falls to the greeting', /Greet them briefly/.test(ask(noText, {}, runNode(noText, {}, { firstMessage: null }))));
check(S4, 'unchanged — a slash command whose answer had no sentence (no tap ran) is untouched', runNode(held, {}, { firstMessage: null, agentInput: null }).agentInput === null);
// The node is only ever reached on the `has reply?` FALSE branch, so a tap that answered with a
// reply cannot pass through it. Asserted against the live node rather than assumed.
const hasReply = (json) => evalExpr(live['has reply?'].parameters.conditions.conditions[0].leftValue, { json });
check(S4, 'a tap that DID answer with a reply takes the sending branch and never reaches this node',
  hasReply({ reply: { channel: 'telegram', method: 'sendMessage', body: {} } }) === true && hasReply({ reply: null }) === false);

// ── the data is bounded ───────────────────────────────────────────────────────
const big = runNode(tap('ord:list'), { 'product action': [j({ success: true, data: { orders: new Array(400).fill({ id: '68b0aa0000000000000000aa', status: 'preparing' }) } })] }, {});
check(S4, 'a very large answer is truncated rather than sent whole to the model', big.agentInput.length < 4300 && /truncated/.test(big.agentInput), String(big.agentInput.length));
