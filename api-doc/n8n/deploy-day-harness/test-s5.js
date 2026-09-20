// § 5 · A5 — a message prepared by an assistant TOOL reaches the customer.
//
// The equivalence half re-runs A3's OWN sixteen scenarios (its harness lives in backend-3b's
// scratchpad) against the live pair and the new pair: the bargaining suppression, the fallbacks
// and the card handling must come out byte-identical.
const { runCode, check, j } = require('./n8n-sim');
const { NEW, live } = require('./build-new');

const S5a = '§ 5 · A3 equivalence (live pair vs new pair)';
const S5b = '§ 5 · A5 tool messages';

const LIVE_COMPOSE = live['compose agent reply'].parameters.jsCode;
const LIVE_DROP = live['drop duplicate reply'].parameters.jsCode;
const STAND_IN = 'Sorry, I could not answer that just now.';
const MSG = 'wamid.123';

const card = (n, channel) => (channel === 'telegram'
  ? { channel, method: 'sendPhoto', body: { chat_id: '42', photo: `https://cdn/x${n}.jpg`, caption: `Card ${n}` } }
  : { channel, method: 'messages', body: { messaging_product: 'whatsapp', to: '237600000000', type: 'interactive', interactive: { n } } });

/** A tool answer as it really arrives: the backend body, JSON, inside an MCP text block. */
const mcpStep = (tool, body) => ({ action: { tool: `wi_mall_MCP_${tool}` }, observation: JSON.stringify([{ response: [{ type: 'text', text: JSON.stringify([body]) }] }]) });
const displayStep = () => ({ action: { tool: 'Show_Products' }, observation: JSON.stringify([{ shown: 2, total: 5, hasMore: true }]) });
const toolReply = (text, channel = 'telegram') => (channel === 'telegram'
  ? { channel, method: 'sendMessage', body: { chat_id: '42', text } }
  : { channel, method: 'messages', body: { messaging_product: 'whatsapp', to: '237600000000', type: 'text', text: { body: text } } });

function scenarioNodes({ channel = 'telegram', answer = '', cards = 0, bargain = null, fallback = null, steps = null }) {
  const inbound = { channel, externalId: channel === 'telegram' ? '42' : '237600000000', messageId: MSG };
  const sync = { data: { fallback: { assistantUnavailable: STAND_IN } } };
  const nodes = { Inbound: [j(inbound)], 'sync identity': [j(sync)] };
  if (fallback) {
    const text = fallback === 'outage' ? 'Service down.' : STAND_IN;
    nodes[fallback === 'outage' ? 'outage fallback' : 'agent fallback'] = [j({ reply: { channel, method: channel === 'telegram' ? 'sendMessage' : 'messages', body: channel === 'telegram' ? { chat_id: '42', text } : { type: 'text', text: { body: text } } } })];
  } else {
    const echo = cards > 0 ? JSON.stringify({ __messageId: MSG, expiresAt: new Date(Date.now() + 60000).toISOString(), replies: Array.from({ length: cards }, (_, i) => card(i + 1, channel)) }) : null;
    nodes['check display'] = [j({ displayEcho: echo })];
    nodes['AI Agent'] = [j(steps ? { output: answer, intermediateSteps: steps } : { output: answer })];
  }
  if (bargain) {
    const e = {
      live: { messageId: MSG, expiresAt: new Date(Date.now() + 60000).toISOString() },
      stale: { messageId: MSG, expiresAt: new Date(Date.now() - 1000).toISOString() },
      otherTurn: { messageId: 'wamid.OTHER', expiresAt: new Date(Date.now() + 60000).toISOString() },
      malformed: '{not json',
    }[bargain];
    nodes['read bargain echo'] = [j({ bargainAnswered: typeof e === 'string' ? e : JSON.stringify(e) })];
  } else {
    nodes['read bargain echo'] = [j({ bargainAnswered: null })];
  }
  return nodes;
}

/** Run compose → drop, as the live graph does, and describe what the customer receives. */
function turn(sc, useNew) {
  const nodes = scenarioNodes(sc);
  if (!sc.fallback) {
    nodes['compose agent reply'] = runCode(useNew ? NEW['core:compose agent reply'] : LIVE_COMPOSE, { nodes, input: [j({})] });
  }
  return runCode(useNew ? NEW['core:drop duplicate reply'] : LIVE_DROP, { nodes, input: [j({})] })
    .map((i) => i.json.reply)
    .map((r) => (r == null ? 'null' : (r.body.text && (r.body.text.body || r.body.text)) || r.body.caption || `card:${JSON.stringify(r.body.interactive || r.body.photo)}`));
}

// ── A3's sixteen, unchanged ──────────────────────────────────────────────────
const A3 = [
  ['sentence + 3 cards', { answer: 'Here you go', cards: 3 }, ['Here you go', 'Card 1', 'Card 2', 'Card 3']],
  ['cards only (model silent)', { cards: 2 }, ['Card 1', 'Card 2']],
  ['sentence only', { answer: 'Hello' }, ['Hello']],
  ['model silent, no cards → stand-in', {}, [STAND_IN]],
  ['⛔ bargained + sentence → nothing', { answer: 'Looking at the price', bargain: 'live' }, ['null']],
  ['⛔ bargained + sentence + 2 cards → the CARDS survive', { answer: 'Looking', cards: 2, bargain: 'live' }, ['Card 1', 'Card 2']],
  ['⛔ bargained + model silent + 1 card → the card survives', { cards: 1, bargain: 'live' }, ['Card 1']],
  ['bargained + model silent + no cards → stand-in dropped', { bargain: 'live' }, ['null']],
  ['stale bargain echo → everything kept', { answer: 'Hi', cards: 2, bargain: 'stale' }, ['Hi', 'Card 1', 'Card 2']],
  ['echo from another turn → everything kept', { answer: 'Hi', cards: 1, bargain: 'otherTurn' }, ['Hi', 'Card 1']],
  ['malformed echo → everything kept', { answer: 'Hi', bargain: 'malformed' }, ['Hi']],
  ['agent fallback → its sentence', { fallback: 'agent' }, [STAND_IN]],
  ['agent fallback + bargained → nothing', { fallback: 'agent', bargain: 'live' }, ['null']],
  ['outage fallback → its sentence', { fallback: 'outage' }, ['Service down.']],
  ['WhatsApp: bargained + sentence + 2 cards → cards survive', { channel: 'whatsapp', answer: 'Looking', cards: 2, bargain: 'live' }, ['card:{"n":1}', 'card:{"n":2}']],
  ['WhatsApp: sentence + 1 card', { channel: 'whatsapp', answer: 'Voilà', cards: 1 }, ['Voilà', 'card:{"n":1}']],
];
for (const [name, sc, expected] of A3) {
  const before = turn(sc, false);
  const after = turn(sc, true);
  check(S5a, `${name}`, JSON.stringify(after) === JSON.stringify(expected) && JSON.stringify(before) === JSON.stringify(after), `live=${JSON.stringify(before)} new=${JSON.stringify(after)} want=${JSON.stringify(expected)}`);
}

// ── A5 itself ────────────────────────────────────────────────────────────────
const closure = { success: true, data: { canClose: true }, reply: toolReply('Closing your account keeps your orders as records. Continue?'), replyStandsAlone: true };
const door = { success: true, data: {}, reply: toolReply('Open your basket') };

let before = turn({ answer: 'Sure — here is what that means.', steps: [mcpStep('account_close_preview', closure)] }, false);
let after = turn({ answer: 'Sure — here is what that means.', steps: [mcpStep('account_close_preview', closure)] }, true);
check(S5b, 'a tool message reaches the customer (live sends the model\'s line only)', JSON.stringify(before) === JSON.stringify(['Sure — here is what that means.']) && after.includes('Closing your account keeps your orders as records. Continue?'), JSON.stringify({ before, after }));
check(S5b, '⭐ `replyStandsAlone` suppresses the model\'s paraphrase — the tool\'s sentence is the whole turn', JSON.stringify(after) === JSON.stringify(['Closing your account keeps your orders as records. Continue?']), JSON.stringify(after));
after = turn({ answer: 'Here it is.', steps: [mcpStep('inapp_open_listing', door)] }, true);
check(S5b, 'without the flag the model\'s sentence is KEPT and goes first', JSON.stringify(after) === JSON.stringify(['Here it is.', 'Open your basket']), JSON.stringify(after));

after = turn({ answer: '', steps: [mcpStep('inapp_open_listing', door)] }, true);
check(S5b, 'a tool message suppresses the "could not answer" stand-in, as a card does', JSON.stringify(after) === JSON.stringify(['Open your basket']), JSON.stringify(after));

// order: tools in call order, cards at the display tool's place
after = turn({ answer: 'Two things.', cards: 2, steps: [mcpStep('t1', { success: true, reply: toolReply('first tool') }), displayStep(), mcpStep('t2', { success: true, reply: toolReply('last tool') })] }, true);
check(S5b, 'order: sentence, then tools and cards in the order the model called them', JSON.stringify(after) === JSON.stringify(['Two things.', 'first tool', 'Card 1', 'Card 2', 'last tool']), JSON.stringify(after));

// failures and junk degrade to today's behaviour
const failures = [
  ['a refused tool (its reply is the error sentence the model retries past)', [mcpStep('cart_add_item', { success: false, error: { customerMessage: 'That variant is gone' }, reply: toolReply('That variant is gone') })]],
  ['an observation that is not JSON', [{ action: { tool: 'wi_mall_MCP_x' }, observation: 'not json at all' }]],
  ['an observation of the shape nobody expects', [{ action: { tool: 'wi_mall_MCP_x' }, observation: JSON.stringify([{ weird: { nested: [1, 2] } }]) }]],
  ['a tool answer with no reply (data only)', [mcpStep('orders_list_groups', { success: true, data: { orders: [] } })]],
  ['an error object instead of an observation', [{ action: { tool: 'wi_mall_MCP_x' }, observation: JSON.stringify({ error: 'Received tool input did not match expected schema' }) }]],
  ['intermediateSteps missing entirely (the option not yet on)', null],
];
for (const [name, steps] of failures) {
  const sc = { answer: 'Here you go', cards: 0, steps };
  check(S5b, `unchanged — ${name}`, JSON.stringify(turn(sc, true)) === JSON.stringify(turn(sc, false)), JSON.stringify(turn(sc, true)));
}

// a tool message on a BARGAINED turn: the agent's line goes, the tool's message stays
after = turn({ answer: 'Let me look at the price.', bargain: 'live', steps: [mcpStep('inapp_open_listing', door)] }, true);
check(S5b, '⛔ bargained + a tool message: the agent\'s line is suppressed, the tool\'s message survives', JSON.stringify(after) === JSON.stringify(['Open your basket']), JSON.stringify(after));

// the same body returned twice in one turn is sent once
after = turn({ answer: 'ok', steps: [mcpStep('a', door), mcpStep('b', door)] }, true);
check(S5b, 'the same message prepared twice in one turn is sent once', JSON.stringify(after) === JSON.stringify(['ok', 'Open your basket']), JSON.stringify(after));

// ── guard bites: break the new code and confirm the proofs fail ──────────────
const mutants = [
  ['suppression by position instead of role', NEW['core:drop duplicate reply'].replace("items.filter(function (j) { return j.role === 'card' || j.role === 'tool'; })", 'items.slice(1)')],
  ['relaying a REFUSED tool\'s reply too', NEW['core:compose agent reply'].replace('if (value.success !== true) { return; }', '')],
];
for (const [name, mutated] of mutants) {
  const isDrop = /drop duplicate/.test(name) || /position/.test(name);
  let bit = false;
  for (const [, sc, expected] of A3.concat([['tool', { answer: 'Here you go', steps: [mcpStep('x', { success: false, error: {}, reply: toolReply('nope') })] }, ['Here you go']]])) {
    const nodes = scenarioNodes(sc);
    if (!sc.fallback) {
      try { nodes['compose agent reply'] = runCode(isDrop ? NEW['core:compose agent reply'] : mutated, { nodes, input: [j({})] }); } catch (e) { bit = true; break; }
    }
    let got;
    try { got = runCode(isDrop ? mutated : NEW['core:drop duplicate reply'], { nodes, input: [j({})] }).map((i) => i.json.reply).map((r) => (r == null ? 'null' : (r.body.text && (r.body.text.body || r.body.text)) || r.body.caption || `card:${JSON.stringify(r.body.interactive || r.body.photo)}`)); } catch (e) { bit = true; break; }
    if (JSON.stringify(got) !== JSON.stringify(expected)) { bit = true; break; }
  }
  check(S5b, `guard bites — ${name} is caught`, bit);
}
