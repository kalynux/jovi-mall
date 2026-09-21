// § 5.1 · the two defects § 5 surfaced on the owner's handset (2026-09-21).
// Run with run-deployed.js (these bodies are what the server holds) or run.js.
const { runCode, check, j } = require('./n8n-sim');
const { FIX, live } = require('./build-live-fixes');

const S1 = '§ 5.1 · the sentence is rewritten for its channel';
const S2 = '§ 5.1 · guard bites';
const S3 = '§ 5.1 · the prompt';
const MSG = 'wamid.51';
const BODY = FIX['compose agent reply'];

/** What the customer receives from compose agent reply, as [role, text] pairs. */
function send(body, { channel = 'telegram', answer = '', toolText = null, cards = 0 } = {}) {
  const inbound = { channel, externalId: channel === 'telegram' ? '42' : '237600000000', messageId: MSG };
  const toolReply = toolText == null ? null : (channel === 'telegram'
    ? { channel, method: 'sendMessage', body: { chat_id: '42', text: toolText } }
    : { channel, method: 'messages', body: { messaging_product: 'whatsapp', to: '237600000000', type: 'text', text: { body: toolText } } });
  const steps = toolReply
    ? [{ action: { tool: 'wi_mall_MCP_tickets_list' }, observation: JSON.stringify([{ response: [{ type: 'text', text: JSON.stringify([{ success: true, data: [], reply: toolReply }]) }] }]) }]
    : [];
  const echo = cards > 0 ? JSON.stringify({ __messageId: MSG, expiresAt: new Date(Date.now() + 60000).toISOString(),
    replies: Array.from({ length: cards }, (_, i) => ({ channel, method: 'sendPhoto', body: { chat_id: '42', photo: 'x', caption: `**Card ${i + 1}**` } })) }) : null;
  const nodes = {
    Inbound: [j(inbound)],
    'sync identity': [j({ data: { fallback: { assistantUnavailable: 'Sorry, I could not answer that just now.' } } })],
    'check display': [j({ displayEcho: echo })],
    'AI Agent': [j({ output: answer, intermediateSteps: steps })],
  };
  return runCode(body, { nodes, input: [j({})] })
    .filter((i) => i.json.reply)
    .map((i) => [i.json.role, (i.json.reply.body.text && (i.json.reply.body.text.body || i.json.reply.body.text)) || i.json.reply.body.caption]);
}
const sentence = (out) => (out.find(([role]) => role === 'model' || role === 'standIn') || [])[1];

// ── the behaviour ────────────────────────────────────────────────────────────
const CASES = [
  ['Telegram: a bold pair loses its stars', { channel: 'telegram', answer: 'Your request is **Closed**.' }, 'Your request is Closed.'],
  ['WhatsApp: a bold pair becomes WhatsApp bold', { channel: 'whatsapp', answer: 'Your request is **Closed**.' }, 'Your request is *Closed*.'],
  ["two pairs in one line (the owner's own screenshot)", { channel: 'telegram', answer: '**#D5BFF5** is new, **#AA002A** is closed.' }, '#D5BFF5 is new, #AA002A is closed.'],
  ['a heading loses its hashes', { channel: 'telegram', answer: '## Your orders\nNone yet.' }, 'Your orders\nNone yet.'],
  ['WhatsApp single-star bold is left alone', { channel: 'whatsapp', answer: 'It is *Received*.' }, 'It is *Received*.'],
  ['a lone pair of stars that is not markup is left as typed', { channel: 'telegram', answer: 'Rated 5 ** 3 times' }, 'Rated 5 ** 3 times'],
  ['a hashtag mid-line is not a heading', { channel: 'telegram', answer: 'Ticket #AA002A' }, 'Ticket #AA002A'],
  ['plain text is unchanged', { channel: 'whatsapp', answer: 'Here you go.' }, 'Here you go.'],
];
const baseline = {};
for (const [name, sc, want] of CASES) {
  const got = sentence(send(BODY, sc));
  baseline[name] = got === want;
  check(S1, name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const toolOut = send(BODY, { channel: 'telegram', answer: 'Here they are.', toolText: 'Which **request**?' });
const toolOk = JSON.stringify(toolOut) === JSON.stringify([['model', 'Here they are.'], ['tool', 'Which **request**?']]);
check(S1, "⛔ a TOOL message is never rewritten — it is the backend's, already rendered", toolOk, JSON.stringify(toolOut));

const cardOut = send(BODY, { channel: 'telegram', answer: 'Look.', cards: 1 });
const cardOk = JSON.stringify(cardOut) === JSON.stringify([['model', 'Look.'], ['card', '**Card 1**']]);
check(S1, '⛔ a card caption is never rewritten', cardOk, JSON.stringify(cardOut));

const standOut = send(BODY, { channel: 'telegram' });
check(S1, 'the stand-in still goes out when nothing else does',
  JSON.stringify(standOut) === JSON.stringify([['standIn', 'Sorry, I could not answer that just now.']]), JSON.stringify(standOut));

// ── mutants — each must APPLY, COMPILE, and flip a check that was PASSING ─────
function mutant(label, from, to, wasPassing, probe) {
  const count = BODY.split(from).length - 1;
  if (count !== 1) { check(S2, `${label} — mutant did not apply (anchor x${count})`, false); return; }
  const m = BODY.replace(from, () => to);
  let ok;
  try { ok = probe(m); } catch (e) { check(S2, `${label} — mutant crashed instead of failing: ${e.message}`, false); return; }
  check(S2, `guard bites — ${label}`, wasPassing === true && ok === false, `baseline passing=${wasPassing}, mutant passing=${ok}`);
}
const telegramBold = (m) => sentence(send(m, { channel: 'telegram', answer: 'Your request is **Closed**.' })) === 'Your request is Closed.';
mutant('the rewrite removed entirely',
  'const chosen = plainFor(answer || standIn);', 'const chosen = (answer || standIn);',
  baseline['Telegram: a bold pair loses its stars'], telegramBold);
mutant("Telegram given WhatsApp's single stars",
  "whatsapp ? '*$1*' : '$1'", "'*$1*'",
  baseline['Telegram: a bold pair loses its stars'], telegramBold);
mutant('tool messages rewritten too',
  "out.push({ json: { role: 'tool', reply: m.reply } });",
  "out.push({ json: { role: 'tool', reply: Object.assign({}, m.reply, { body: Object.assign({}, m.reply.body, { text: plainFor(m.reply.body.text) }) }) } });",
  toolOk,
  (m) => JSON.stringify(send(m, { channel: 'telegram', answer: 'Here they are.', toolText: 'Which **request**?' }))
    === JSON.stringify([['model', 'Here they are.'], ['tool', 'Which **request**?']]));

// ── the prompt ───────────────────────────────────────────────────────────────
const OLD = live['AI Agent'].parameters.options.systemMessage;
const NEWP = FIX['systemMessage'];
check(S3, 'still an n8n expression (leading =)', NEWP.startsWith('=') && OLD.startsWith('='));
const exprCount = (s) => s.split('{{').length - 1;
check(S3, 'no expression added or lost', exprCount(NEWP) === exprCount(OLD), `${exprCount(OLD)} -> ${exprCount(NEWP)}`);
const sectionStart = NEWP.indexOf('\n\n## MESSAGES YOUR TOOLS SEND\n');
const sectionEnd = NEWP.indexOf('\n\n## RULES\n');
const bulletLine = '- Never use markdown: no double asterisks, no # headings, no [text](link) links. On Telegram use no asterisks at all — they are shown exactly as typed. On WhatsApp you may put a word in *single asterisks* to make it bold, rarely.\n';
const restored = NEWP.slice(0, sectionStart) + NEWP.slice(sectionEnd).replace(bulletLine, '');
check(S3, 'removing the two insertions gives back the live prompt byte for byte', restored === OLD);
check(S3, 'the new section sits immediately before RULES', sectionStart > 0 && sectionEnd > sectionStart);
check(S3, "it tells the model not to repeat a tool's message", NEWP.slice(sectionStart, sectionEnd).includes('Do not repeat it'));
check(S3, 'it tells the model a FAILED tool sends nothing', NEWP.includes('Only a tool that SUCCEEDED sends its message'));

// ── § 5.2 · the token paragraph ──────────────────────────────────────────────
const S4 = '§ 5.2 · the token paragraph';
const { TOKEN_PARA_OLD, TOKEN_PARA_NEW } = require('./build-live-fixes');
const P52 = FIX['systemMessage.52'];
check(S4, 'the old "do not retry" paragraph is gone', !P52.includes(TOKEN_PARA_OLD) && NEWP.includes(TOKEN_PARA_OLD));
check(S4, 'the new paragraph is present exactly once', P52.split(TOKEN_PARA_NEW).length - 1 === 1);
check(S4, 'putting the old paragraph back gives the § 5.1 prompt byte for byte', P52.replace(TOKEN_PARA_NEW, TOKEN_PARA_OLD) === NEWP);
check(S4, 'the botToken expression line itself is untouched',
  P52.includes("botToken: {{ $('sync identity').item.json.data?.customer?.botToken }}\n\n" + TOKEN_PARA_NEW));
check(S4, 'no expression added or lost', exprCount(P52) === exprCount(OLD), `${exprCount(OLD)} -> ${exprCount(P52)}`);
check(S4, 'still an n8n expression (leading =)', P52.startsWith('='));
check(S4, 'it says to retry ONCE with the fresh value, and only then ask the customer',
  TOKEN_PARA_NEW.includes('make that same call once more') && TOKEN_PARA_NEW.includes('Only if that is refused too'));
check(S4, "it names the real source of stale tokens — this chat's earlier tool calls",
  TOKEN_PARA_NEW.includes('earlier tool calls of this chat'));

// ── § 4.6 · the awaiting carry, as shipped (ahead of § 8) ────────────────────
const S5 = '§ 4.6 · as shipped';
const S6 = '§ 4.6 · guard bites';
const { evalExpr } = require('./n8n-sim');
const { NEW } = require('./build-new');
const { LIVE_NOW, AWAIT_KEY, RULES_46 } = require('./build-live-fixes');
const fs = require('fs');
const path = require('path');
const BS = String.fromCharCode(92);
const CAI = FIX['compose agent input'];
const LIVE_CAI = LIVE_NOW.nodes['compose agent input'].parameters.jsCode;
const N46 = Object.fromEntries(FIX['4.6 nodes'].map((n) => [n.name, n]));

// — what it is built on is what is live —
check(S5, 'built on what is LIVE: the § 5.2 prompt is the live prompt, byte for byte',
  FIX['systemMessage.52'] === LIVE_NOW.nodes['AI Agent'].parameters.options.systemMessage);
// ⚠ CRLF-normalised: `core.autocrlf=true` turns this committed LF file into CRLF on a Windows
// checkout, and n8n's body is LF — an un-normalised compare fails on correct code.
check(S5, 'built on what is LIVE: the live compose agent input is the § 6-only body that was shipped',
  LIVE_CAI === fs.readFileSync(path.join(__dirname, 'new', 's6only_compose_agent_input.txt'), 'utf8').replace(/\r\n/g, '\n'));

// — the node body —
check(S5, 'compose agent input carries no backslash (the one escape became its literal character)', CAI.split(BS).length - 1 === 0);
let di = 0; while (CAI[di] === LIVE_CAI[di]) di += 1;
const insLen = CAI.length - LIVE_CAI.length;
check(S5, 'compose agent input = the live body plus ONE contiguous block, nothing else touched',
  insLen > 0 && CAI.slice(0, di) + CAI.slice(di + insLen) === LIVE_CAI, `insertion at ${di}, ${insLen} chars`);
check(S5, '⛔ the § 8.5 layer is NOT in it — that ships with § 8', !CAI.includes('hand to bargainer'));

const TAP = 'tap-reply-1';
const tapItem = { success: true, data: { ticketId: '68c0ffee0000000000000001', subject: 'I am trying to verify my account', status: 'received', awaitingReply: true } };
const inboundOf = (messageId, text, kind = 'text') => ({ channel: 'whatsapp', externalId: '237600000000', messageId, kind, text });
const nextTurn = (body, carry, messageId = 'm-next', text = 'My email still shows as unverified') => runCode(body, {
  nodes: { Inbound: [j(inboundOf(messageId, text))], 'recall awaiting': [j({ awaitingCarry: carry })] },
  input: [j({})], mode: 'each',
})[0].json.agentInput;

// ⭐ Feed what `remember awaiting` WOULD write to what `recall awaiting` hands `compose agent input`.
const written = evalExpr(N46['remember awaiting'].parameters.value, { nodes: { Inbound: [j(inboundOf(TAP, ''))] }, json: tapItem });
const armed = evalExpr(N46['awaiting answer?'].parameters.conditions.conditions[0].leftValue, { json: tapItem }) === true;
check(S5, 'a support-request Reply tap arms the carry (the flag, not the verb)', armed);
const carried = nextTurn(CAI, written);
check(S5, '⭐ the chain: what remember WRITES, recall hands to compose, and the next message arrives WITH the request it answers',
  carried.includes('68c0ffee0000000000000001') && carried.includes('awaitingReply') && carried.endsWith('My email still shows as unverified'), carried);
check(S5, 'the swapped apostrophe reaches the model exactly as the escaped one would',
  carried === nextTurn(NEW['core:compose agent input@4.6'], written) && carried.includes('customer’s own words'));
check(S5, 'the carry is refused on the turn that wrote it', nextTurn(CAI, written, TAP) === 'My email still shows as unverified');
check(S5, 'no carry (the normal turn) → the message exactly as today', nextTurn(CAI, null) === runCode(LIVE_CAI, {
  nodes: { Inbound: [j(inboundOf('m-next', 'My email still shows as unverified'))] }, input: [j({})], mode: 'each',
})[0].json.agentInput);

// — what the simulator cannot see: names, keys, credential, wiring, order —
const liveNames = new Set(LIVE_NOW.nodeNames);
const allNames = new Set([...liveNames, ...Object.keys(N46)]);
const refsIn = (s) => [...new Set([...String(s).matchAll(/[$][(]'([^']+)'[)]/g)].map((m) => m[1]))];
const exprText = [CAI, FIX['systemMessage.46'], ...FIX['4.6 nodes'].map((n) => JSON.stringify(n.parameters))].join('\n');
const missing = refsIn(exprText).filter((r) => !allNames.has(r));
check(S5, "⛔ every $('…') the shipped bodies name exists once the four nodes are added (n8n throws on a missing one)", missing.length === 0, `missing: ${missing.join(', ')}`);
check(S5, 'no new node takes a name the workflow already has', Object.keys(N46).every((n) => !liveNames.has(n)));

const keysAgree = (nodes) => {
  const ks = ['remember awaiting', 'recall awaiting', 'forget awaiting'].map((n) => nodes[n].parameters.key);
  return ks.every((k) => k === ks[0]) && ks[0] === AWAIT_KEY;
};
check(S5, '⭐ set, get and delete use the SAME key — a mismatch is a carry that never arrives, silently', keysAgree(N46));
check(S5, "recall's output property is the one compose agent input reads",
  N46['recall awaiting'].parameters.propertyName === 'awaitingCarry' && CAI.includes("$('recall awaiting').item.json || {}).awaitingCarry"));
check(S5, 'the Redis credential is the one the working first-message carry uses',
  FIX['4.6 nodes'].filter((n) => n.type === 'n8n-nodes-base.redis').every((n) => JSON.stringify(n.credentials) === JSON.stringify(LIVE_NOW.nodes['recall first message'].credentials)));
check(S5, 'node versions match their live siblings (Redis v1 as the first-message carry, IF 2.3 as has reply?)',
  N46['recall awaiting'].typeVersion === LIVE_NOW.nodes['recall first message'].typeVersion
  && N46['awaiting answer?'].typeVersion === LIVE_NOW.nodes['has reply?'].typeVersion);
check(S5, "⭐ 'awaiting answer?' sits ABOVE 'has reply?' — v1 runs sibling branches top to bottom, so the carry is written before a slow assistant turn",
  LIVE_NOW.settings.executionOrder === 'v1' && N46['awaiting answer?'].position[1] < LIVE_NOW.nodes['has reply?'].position[1]);
const conn = (src, out) => ((LIVE_NOW.connections[src] || {}).main || [])[out] || [];
check(S5, "the connection being replaced exists live: bargaining? (false) → is media?", conn('bargaining?', 1).some((c) => c.node === 'is media?'));
check(S5, "product action's existing branch is kept — the carry is ADDED beside has reply?",
  conn('product action', 0).some((c) => c.node === 'has reply?') && !FIX['4.6 wiring'].some((op) => op.type === 'removeConnection' && op.source === 'product action'));

// — the prompt —
const P46 = FIX['systemMessage.46'];
check(S5, 'the two filing rules are in RULES, once', P46.split(RULES_46).length - 1 === 1);
check(S5, 'taking them out gives the live prompt byte for byte', P46.replace(RULES_46, '') === FIX['systemMessage.52']);
check(S5, 'no expression added or lost', exprCount(P46) === exprCount(FIX['systemMessage.52']));

// — mutants —
const mutKey = JSON.parse(JSON.stringify(N46));
mutKey['recall awaiting'].parameters.key = mutKey['recall awaiting'].parameters.key.replace('wi-mall:awaiting:', 'wi-mall:await:');
check(S6, 'guard bites — a recall key that differs from the set key is caught', keysAgree(N46) === true && keysAgree(mutKey) === false);
const mutProp = CAI.replace("$('recall awaiting').item.json || {}).awaitingCarry", "$('recall awaiting').item.json || {}).carry");
check(S6, 'guard bites — compose reading a different property loses the carry',
  mutProp !== CAI && !nextTurn(mutProp, written).includes('awaitingReply') && carried.includes('awaitingReply'));

// ── § 4.8 · an `awaiting…` flag is read the right way round ──────────────────
const S8 = '§ 4.8 · the awaiting flag means the CUSTOMER is expected';
const CTI = FIX['compose tap input'];
const LIVE_CTI = LIVE_NOW.nodes['compose tap input'].parameters.jsCode;
const tapNote = (body, data, { kind = 'token', success = true } = {}) => runCode(body, {
  nodes: {
    Inbound: [j({ channel: 'whatsapp', externalId: '237600000000', messageId: 'tap-1', kind })],
    'product action': [j(success ? { success: true, data } : { success: false, error: { customerMessage: 'That request is closed.' } })],
  },
  input: [j({ firstMessage: null })],
})[0].json.agentInput;
const REPLY_TAP = { ticketId: '6ab0c501865937d254d5bff5', subject: 'Something else: A general question', status: 'open', awaitingReply: true };

const replyNote = tapNote(CTI, REPLY_TAP);
check(S8, '⭐ the Reply tap (exec 1502) tells the model the platform waits for the CUSTOMER, and to ask for it',
  replyNote.includes('WAITING FOR THE CUSTOMER') && replyNote.includes('(awaitingReply)') && replyNote.includes('do not report a status'), replyNote);
check(S8, 'the data still reaches the model, before the ask', replyNote.indexOf('6ab0c501865937d254d5bff5') > -1 && replyNote.indexOf('6ab0c501865937d254d5bff5') < replyNote.indexOf('WAITING'));
for (const [name, data, opts] of [
  ['an ordinary data tap (no flag)', { cartCount: 2 }, {}],
  ['a flag present but FALSE', { awaitingReply: false }, {}],
  ['a key that merely mentions the word', { notAwaiting: true }, {}],
  ['a refused tap', null, { success: false }],
  ['a typed turn (not a tap)', { awaitingReply: true }, { kind: 'text' }],
]) {
  check(S8, `unchanged against the LIVE node — ${name}`, tapNote(CTI, data, opts) === tapNote(LIVE_CTI, data, opts));
}
// The two nodes that read the flag must agree on which taps are questions.
const armsCarry = (data) => evalExpr(N46['awaiting answer?'].parameters.conditions.conditions[0].leftValue, { json: { success: true, data } }) === true;
const asks = (data) => tapNote(CTI, data).includes('WAITING FOR THE CUSTOMER');
const samples = [REPLY_TAP, { awaitingCancellationReason: true }, { awaitingSomethingNew: true }, { cartCount: 1 }, { awaitingReply: false }, { notAwaiting: true }, {}];
check(S8, "⭐ it asks exactly when `awaiting answer?` arms the carry — the two readers of the flag never disagree",
  samples.every((d) => asks(d) === armsCarry(d)));
check(S8, 'no backslash in the body', CTI.split(BS).length - 1 === 0);
let ctiAt = 0; while (CTI[ctiAt] === LIVE_CTI[ctiAt]) ctiAt += 1;
check(S8, 'the live body is otherwise untouched (one contiguous change)', CTI.endsWith(LIVE_CTI.slice(LIVE_CTI.indexOf("  }\n}\n\nreturn [{ json:"))));
const mutAsk = CTI.replace("      + ask\n", '');
check(S8, 'guard bites — without the ask, the Reply tap is reported as a status again', mutAsk !== CTI && !tapNote(mutAsk, REPLY_TAP).includes('WAITING FOR THE CUSTOMER'));

// ── § 3 · A2 as shipped: the send path, merged with the owner's reporting ────
const S9 = '§ 3 · as shipped (merged with report channel down)';
const S10 = '§ 3 · guard bites';
const { LIVE_SEND, REPORT_OLD_ERROR } = require('./build-live-fixes');
const EXPAND = FIX['3 nodes'][0].parameters.jsCode;
const REPORT_NEW = FIX['3 report body'];
const REPORT_OLD = LIVE_SEND.nodes['report channel down'].parameters.jsonBody;

/** Apply update_workflow connection ops to a copy of a connections object, exactly as n8n would. */
function applyWiring(connections, ops) {
  const c = JSON.parse(JSON.stringify(connections));
  for (const op of ops) {
    const outs = ((c[op.source] = c[op.source] || {}).main = c[op.source].main || []);
    while (outs.length <= op.sourceIndex) outs.push([]);
    const list = outs[op.sourceIndex] || (outs[op.sourceIndex] = []);
    const at = list.findIndex((t) => t.node === op.target && t.index === op.targetIndex);
    if (op.type === 'removeConnection') {
      if (at === -1) throw new Error(`removeConnection: ${op.source}[${op.sourceIndex}] -> ${op.target} does not exist`);
      list.splice(at, 1);
    } else {
      if (at !== -1) throw new Error(`addConnection: ${op.source}[${op.sourceIndex}] -> ${op.target} already exists`);
      list.push({ node: op.target, type: 'main', index: op.targetIndex });
    }
  }
  return c;
}
const targets = (c, src, out) => (((c[src] || {}).main || [])[out] || []).map((t) => t.node);
const sourcesOf = (c, node) => Object.entries(c).flatMap(([src, t]) => ((t.main || []).flatMap((list, i) => (list || []).filter((x) => x.node === node).map(() => `${src}:${i}`))));

/**
 * Walk the send sub-graph of `conns` for one turn, the way n8n v1 would: `send loop` hands over
 * one item, the item follows the wires, and the NEXT item is handed over only if the path came
 * back to `send loop`. A path that does not return STALLS the loop — every later message is lost.
 */
function runSendPath(conns, entry, inputItems, platform) {
  const inbound = { channel: inputItems[0].json.reply.channel, externalId: inputItems[0].json.reply.channel === 'telegram' ? '42' : '237600000000', messageId: 'm' };
  const expanded = runCode(EXPAND, { nodes: { Inbound: [j(inbound)] }, input: inputItems });
  if (!targets(conns, entry, 0).includes('expand replies')) return { sent: [], reports: [], stalled: true, reason: `${entry} does not feed expand replies` };
  const sent = []; const reports = [];
  for (let i = 0; i < expanded.length; i += 1) {
    const reply = expanded[i].json.reply;
    if (!targets(conns, 'send loop', 1).includes('is telegram?')) return { sent, reports, stalled: true, reason: 'loop does not feed is telegram?' };
    const sender = reply.channel === 'telegram' ? targets(conns, 'is telegram?', 0)[0] : targets(conns, 'is telegram?', 1)[0];
    const result = platform(reply, i);
    let next;
    if (result.ok) {
      sent.push(reply);
      next = targets(conns, sender, 0);
    } else {
      const onError = targets(conns, sender, 1);
      if (onError.includes('report channel down')) {
        reports.push(JSON.parse(evalExpr(REPORT_BODY_UNDER_TEST, { nodes: { Inbound: [j(inbound)] }, json: { error: result.error } })));
        next = targets(conns, 'report channel down', 0);
      } else next = onError;
    }
    if (!next.includes('send loop')) return { sent, reports, stalled: i < expanded.length - 1, reason: `${sender} path does not return to send loop` };
  }
  return { sent, reports, stalled: false };
}
let REPORT_BODY_UNDER_TEST = REPORT_NEW;

const WIRED = applyWiring(LIVE_SEND.connections, FIX['3 wiring']);

// — the graph after the ops —
check(S9, 'every connection the ops remove exists live, and none they add already does', (() => { try { applyWiring(LIVE_SEND.connections, FIX['3 wiring']); return true; } catch (e) { return false; } })());
check(S9, 'has reply? (true) and send guard (true) now feed expand replies, and nothing else',
  JSON.stringify(targets(WIRED, 'has reply?', 0)) === '["expand replies"]' && JSON.stringify(targets(WIRED, 'send guard', 0)) === '["expand replies"]');
check(S9, "has reply?'s false branch is untouched", JSON.stringify(targets(WIRED, 'has reply?', 1)) === JSON.stringify(targets(LIVE_SEND.connections, 'has reply?', 1)));
check(S9, 'expand replies → send loop; the loop output → is telegram?; the done output → nothing',
  JSON.stringify(targets(WIRED, 'expand replies', 0)) === '["send loop"]' && JSON.stringify(targets(WIRED, 'send loop', 1)) === '["is telegram?"]' && targets(WIRED, 'send loop', 0).length === 0);
check(S9, 'is telegram? is fed by the loop alone', JSON.stringify(sourcesOf(WIRED, 'is telegram?')) === '["send loop:1"]');
check(S9, "⭐ every path out of a send returns to the loop — success, refusal via the owner's report, both channels",
  ['send telegram', 'send whatsapp'].every((s) => JSON.stringify(targets(WIRED, s, 0)) === '["send loop"]' && JSON.stringify(targets(WIRED, s, 1)) === '["report channel down"]')
  && JSON.stringify(targets(WIRED, 'report channel down', 0)) === '["send loop"]');
const edgeSet = (c) => new Set(Object.entries(c).flatMap(([s, t]) => Object.entries(t).flatMap(([ty, outs]) => (outs || []).flatMap((l, i) => (l || []).map((x) => `${s}[${ty}:${i}]->${x.node}`)))));
const before = edgeSet(LIVE_SEND.connections); const after = edgeSet(WIRED);
check(S9, 'nothing else in the graph moved (the diff is exactly the nine ops)',
  [...before].filter((e) => !after.has(e)).length === 2 && [...after].filter((e) => !before.has(e)).length === 7);
check(S9, 'the new nodes land on free canvas, clear of every live node',
  FIX['3 nodes'].every((n) => Object.values(LIVE_SEND.positions).every((p) => Math.abs(p[0] - n.position[0]) >= 150 || Math.abs(p[1] - n.position[1]) >= 100)));

// — a turn, walked through that graph —
const tgCard = (n) => ({ channel: 'telegram', method: 'sendPhoto', body: { chat_id: '42', photo: `https://cdn/x${n}.jpg`, caption: `Card ${n}` } });
const waText = (t) => ({ channel: 'whatsapp', method: 'messages', body: { messaging_product: 'whatsapp', to: '237600000000', type: 'text', text: { body: t } } });
const intro = { channel: 'telegram', method: 'sendMessage', body: { chat_id: '42', text: 'Here is what we have.' } };
const page = [intro, tgCard(1), tgCard(2), tgCard(3), tgCard(4)];
const ok = () => ({ ok: true });

const whole = runSendPath(WIRED, 'has reply?', [j({ reply: page[0], replies: page })], ok);
check(S9, '⭐ a five-message page tapped open: all five are sent, in order, the first not repeated',
  !whole.stalled && JSON.stringify(whole.sent) === JSON.stringify(page));
const single = runSendPath(WIRED, 'has reply?', [j({ reply: intro })], ok);
check(S9, 'a one-message turn (almost every turn): exactly one send, body byte-identical, no report',
  !single.stalled && single.sent.length === 1 && JSON.stringify(single.sent[0]) === JSON.stringify(intro) && single.reports.length === 0);
const agent = runSendPath(WIRED, 'send guard', [j({ role: 'model', reply: waText('Hi') }), j({ role: 'tool', reply: waText('Which request?') })], ok);
check(S9, 'the agent path (several items from drop duplicate reply): each sent, in order',
  !agent.stalled && JSON.stringify(agent.sent.map((r) => r.body.text.body)) === '["Hi","Which request?"]');
const META_131047 = { message: 'Bad request - please check your parameters', description: '(#131047) Re-engagement message' };
const refusedAt2 = runSendPath(WIRED, 'has reply?', [j({ reply: page[0], replies: page })], (r, i) => (i === 1 ? { ok: false, error: META_131047 } : { ok: true }));
check(S9, "⭐ a refusal at message 2 of 5: messages 3–5 still go out, and the owner's report carries the platform's reason",
  !refusedAt2.stalled && refusedAt2.sent.length === 4 && refusedAt2.reports.length === 1
  && refusedAt2.reports[0].errorMessage.includes('(#131047)') && refusedAt2.reports[0].kind === 'degraded_turn');
let threw = false;
try { runSendPath(WIRED, 'has reply?', [j({ reply: { channel: 'telegram', method: 'sendMessage', body: { chat_id: '999', text: 'x' } } })], ok); } catch (e) { threw = /addressed to/.test(e.message); }
check(S9, '⛔ a message addressed to another conversation fails the turn loudly', threw);
check(S9, "expand replies is byte-identical to the spec's (test-s3's checks on it hold)", EXPAND === NEW['core:expand replies'] && EXPAND.split(BS).length - 1 === 0);

// — the owner's report node —
const reasonOf = (body, error) => JSON.parse(evalExpr(body, { nodes: { Inbound: [j({ channel: 'telegram', externalId: '42', messageId: 'm' })] }, json: { error } })).errorMessage;
const SHAPES = [
  ['a Telegram rejection', { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 'Bad Request: chat not found'],
  ["n8n's generic message plus the platform's description", META_131047, 'Bad request - please check your parameters -- (#131047) Re-engagement message'],
  ["Meta's nested error", { error: { message: '(#131047) Re-engagement message', code: 131047 } }, '(#131047) Re-engagement message'],
  ['a request that could not be built (a string)', 'getaddrinfo ENOTFOUND api.telegram.org', 'getaddrinfo ENOTFOUND api.telegram.org'],
  ['no error detail at all', undefined, 'the chat platform refused the message'],
  ['the same words twice', { message: 'x', description: 'x' }, 'x'],
];
for (const [name, error, want] of SHAPES) check(S9, `report reason — ${name}`, reasonOf(REPORT_NEW, error) === want, `got ${JSON.stringify(reasonOf(REPORT_NEW, error))}`);
check(S9, 'report reason — capped at 1000 characters', reasonOf(REPORT_NEW, { message: 'x'.repeat(5000) }).length === 1000);
check(S9, "measured, the defect being fixed: the LIVE body loses Telegram's and Meta's reason",
  reasonOf(REPORT_OLD, SHAPES[0][1]) === 'the chat platform refused the message' && reasonOf(REPORT_OLD, SHAPES[2][1]) === 'the chat platform refused the message');
const rep = JSON.parse(evalExpr(REPORT_NEW, { nodes: { Inbound: [j({ channel: 'whatsapp', externalId: '237600000000', messageId: 'm' })] }, json: { error: 'x' } }));
check(S9, 'every other field of the report is as before (kind, node, channel, id, a UTC time)',
  rep.kind === 'degraded_turn' && rep.nodeName === 'send whatsapp' && rep.channel === 'whatsapp' && rep.externalId === '237600000000' && /Z$/.test(rep.occurredAt) && rep.workflowName === 'UP-wi-mall-core');
check(S9, "no `$('Inbound').item` left in the report — lineage tracing is what breaks inside a loop", !REPORT_NEW.includes("$('Inbound').item"));
check(S9, 'the report body changed in exactly the two intended ways',
  REPORT_NEW.replace(REPORT_NEW.slice(REPORT_NEW.indexOf('errorMessage: ['), REPORT_NEW.indexOf('"the chat platform refused the message"') + 39), REPORT_OLD_ERROR).split("$('Inbound').first().json").join("$('Inbound').item.json") === REPORT_OLD);
check(S9, 'the send nodes lose `batching` and keep every other option',
  ['send telegram', 'send whatsapp'].every((s) => !('batching' in FIX['3 send options'][s]) && JSON.stringify(FIX['3 send options'][s]) === JSON.stringify({ timeout: 20000 })));
check(S9, "the send nodes' error routing (the owner's) is already continueErrorOutput live — nothing to change there",
  ['send telegram', 'send whatsapp'].every((s) => LIVE_SEND.nodes[s].onError === 'continueErrorOutput'));
const allNames3 = new Set([...LIVE_SEND.nodeNames, ...FIX['3 nodes'].map((n) => n.name)]);
const missing3 = refsIn([EXPAND, REPORT_NEW].join('\n')).filter((r) => !allNames3.has(r));
check(S9, "⛔ every $('…') in the new bodies names a node that will exist", missing3.length === 0, missing3.join(', '));

// — mutants —
const noReturn = applyWiring(LIVE_SEND.connections, FIX['3 wiring'].filter((op) => !(op.source === 'report channel down')));
const stalls = runSendPath(noReturn, 'has reply?', [j({ reply: page[0], replies: page })], (r, i) => (i === 1 ? { ok: false, error: META_131047 } : { ok: true }));
check(S10, 'guard bites — if the report does not hand back to the loop, a refusal at 2 of 5 LOSES messages 3–5', stalls.stalled && stalls.sent.length === 1);
const noLoopBack = applyWiring(LIVE_SEND.connections, FIX['3 wiring'].filter((op) => !(op.source === 'send whatsapp' && op.target === 'send loop')));
const waPage = [waText('a'), waText('b'), waText('c')];
check(S10, 'guard bites — a send that does not return to the loop stops the turn after one message',
  runSendPath(noLoopBack, 'has reply?', [j({ reply: waPage[0], replies: waPage })], ok).sent.length === 1);
REPORT_BODY_UNDER_TEST = REPORT_OLD;
const oldReport = runSendPath(WIRED, 'has reply?', [j({ reply: page[0], replies: page })], (r, i) => (i === 1 ? { ok: false, error: { error: { message: '(#131047) Re-engagement message' } } } : { ok: true }));
REPORT_BODY_UNDER_TEST = REPORT_NEW;
check(S10, "guard bites — with the live report body, Meta's reason never reaches the failures board", !oldReport.reports[0].errorMessage.includes('131047'));

// ── § 5.3 · the token paragraph for v2 ───────────────────────────────────────
const S7 = '§ 5.3 · the token paragraph for v2';
const { TOKEN_PARA_53 } = require('./build-live-fixes');
const P53 = FIX['systemMessage.53'];
check(S7, 'the § 5.2 paragraph is replaced, once', !P53.includes(TOKEN_PARA_NEW) && P53.split(TOKEN_PARA_53).length - 1 === 1);
check(S7, 'putting it back gives the § 4.6 prompt byte for byte', P53.replace(TOKEN_PARA_53, TOKEN_PARA_NEW) === P46);
check(S7, '⛔ it no longer calls earlier tokens "old" — under v2 they are the same string, and "old" invites renewing one',
  !P53.includes('no longer work') && !P53.includes('new on every message'));
check(S7, 'it forbids rebuilding one, and keeps retry-once-then-ask',
  TOKEN_PARA_53.includes('rebuild') && TOKEN_PARA_53.includes('make that same call once more') && TOKEN_PARA_53.includes('Only if that is refused too'));
check(S7, 'no expression added or lost', exprCount(P53) === exprCount(P46));

// ── § 2 · completed WhatsApp forms, as shipped on top of 1050e7c3 ─────────────
const S11 = '§ 2 · as shipped (on the § 3 graph)';
const S12 = '§ 2 · guard bites';
const { LIVE_FORMS } = require('./build-live-fixes');
const ENDS = FIX['2 node'].parameters.conditions.conditions[0].leftValue;
const endsTrue = (json) => evalExpr(ENDS, { json }) === true;

check(S11, 'the shipped bodies are the ones test-s1-s2 proved (byte for byte)',
  FIX['2 wa normalize'] === NEW['wa:normalize'] && FIX['2 detect command'] === NEW['core:detect command']
  && FIX['2 run command jsonBody'] === NEW['core:run command.jsonBody'] && FIX['2 command reply'] === NEW['core:command reply']);
check(S11, "the gate's condition is the one test-s1-s2 evaluated", ENDS === '={{ $json.endTurn === true }}');
check(S11, 'the gate is true ONLY for endTurn === true',
  endsTrue({ endTurn: true }) && !endsTrue({ reply: { body: {} } }) && !endsTrue({}) && !endsTrue({ endTurn: 'true' }) && !endsTrue({ endTurn: 1 }));

const W2 = applyWiring(LIVE_FORMS.connections, FIX['2 wiring']);
check(S11, "live today: command reply feeds has reply? directly (the anchor the wiring removes)", JSON.stringify(targets(LIVE_FORMS.connections, 'command reply', 0)) === '["has reply?"]');
check(S11, 'command reply now feeds ONLY the gate', JSON.stringify(targets(W2, 'command reply', 0)) === '["ends silently?"]');
check(S11, "the gate's TRUE output is unconnected — the turn ends there, with an item", targets(W2, 'ends silently?', 0).length === 0);
check(S11, "the gate's FALSE output feeds has reply?", JSON.stringify(targets(W2, 'ends silently?', 1)) === '["has reply?"]');
const hrBefore = sourcesOf(LIVE_FORMS.connections, 'has reply?').sort();
const hrAfter = sourcesOf(W2, 'has reply?').sort();
check(S11, "has reply? keeps every other feed (11), loses command reply's, gains the gate's",
  JSON.stringify(hrAfter) === JSON.stringify(hrBefore.filter((x) => x !== 'command reply:0').concat('ends silently?:1').sort()) && hrAfter.length === 12, hrAfter.join(', '));
const eb2 = edgeSet(LIVE_FORMS.connections); const ea2 = edgeSet(W2);
check(S11, 'the edge-set diff is exactly the three wiring ops', [...ea2].filter((e) => !eb2.has(e)).length === 2 && [...eb2].filter((e) => !ea2.has(e)).length === 1);
check(S11, "the gate's position is free on the live canvas",
  !Object.values(LIVE_FORMS.positions).some((p) => p[0] === FIX['2 node'].position[0] && p[1] === FIX['2 node'].position[1]));
check(S11, "the name 'ends silently?' is not already taken", !LIVE_FORMS.nodeNames.includes('ends silently?'));

// Walk: command reply's real output, through the gate, on the wired graph.
const inForm2 = { channel: 'whatsapp', externalId: '237600000000', messageId: 'wamid.F', kind: 'form', text: '', token: '', form: { screen: 'co' } };
const inContact2 = { channel: 'whatsapp', externalId: '237600000000', kind: 'contact', contact: { phoneNumber: '+237600000000', userId: 1 } };
const reach = (conns, inbound, response) => {
  const out = runCode(FIX['2 command reply'], { nodes: { Inbound: [j(inbound)] }, input: [j(response)] })[0].json;
  const next = targets(conns, 'command reply', 0);
  if (next.includes('has reply?')) return 'has reply?';
  if (!next.includes('ends silently?')) return 'nowhere';
  const branch = endsTrue(out) ? 0 : 1;
  const t = targets(conns, 'ends silently?', branch);
  return t.length ? t.join('+') : 'END';
};
const aReply2 = { channel: 'whatsapp', method: 'messages', body: { to: '237600000000', type: 'interactive' } };
check(S11, 'a silent completion (checkout closed) ENDS the turn — no assistant greeting', reach(W2, inForm2, { message: '', completedScreen: 'co' }) === 'END');
check(S11, 'a completion WITH a reply (listing chose a product) reaches has reply? and is sent', reach(W2, inForm2, { reply: aReply2 }) === 'has reply?');
check(S11, 'unchanged — a contact command with its reply still reaches has reply?', reach(W2, inContact2, { reply: aReply2 }) === 'has reply?');
check(S11, 'unchanged — a refused contact command still reaches has reply? (its sentence renders itself)', reach(W2, inContact2, { success: false, error: { customerMessage: 'x' } }) === 'has reply?');
check(S11, 'live today: the same silent completion reaches has reply? → the assistant greets over the closing screen', reach(LIVE_FORMS.connections, inForm2, { message: '', completedScreen: 'co' }) === 'has reply?');

const missing2 = refsIn([FIX['2 detect command'], FIX['2 run command jsonBody'], FIX['2 command reply']].join(' ')).filter((r) => !LIVE_FORMS.nodeNames.includes(r));
check(S11, "⛔ every $('…') in the three core bodies names a live node", missing2.length === 0, missing2.join(', '));
check(S11, "the adapter body references no other node but the trigger", refsIn(FIX['2 wa normalize']).every((r) => r === 'WhatsApp Trigger'), refsIn(FIX['2 wa normalize']).join(', '));

// — mutants: each APPLIES, and flips a check that was passing —
const trueWired = applyWiring(LIVE_FORMS.connections, [FIX['2 wiring'][0], FIX['2 wiring'][1], { ...FIX['2 wiring'][2], sourceIndex: 0 }]);
check(S12, "guard bites — the gate wired on its TRUE output sends a silent completion on to the assistant", reach(trueWired, inForm2, { message: '', completedScreen: 'co' }) !== 'END');
const keptOld = applyWiring(LIVE_FORMS.connections, FIX['2 wiring'].slice(1));
check(S12, "guard bites — leaving the old command reply → has reply? edge in place bypasses the gate", reach(keptOld, inForm2, { message: '', completedScreen: 'co' }) === 'has reply?');
const oldReplyBody = LIVE_FORMS.nodes['command reply'].parameters.jsCode;
const outOld = runCode(oldReplyBody, { nodes: { Inbound: [j(inForm2)] }, input: [j({ message: '', completedScreen: 'co' })] })[0].json;
check(S12, "guard bites — the live command reply body never sets endTurn, so the gate alone would change nothing", !endsTrue(outOld));

// ── § 4.9 · a waiting tap files nothing; a file reference is spent after one turn ──
const S13 = '§ 4.9 · a waiting tap files nothing; old file references are not reused';
const S14 = '§ 4.9 · guard bites';
const { ASK_NEW, FILE_OLD, FILE_NEW } = require('./build-live-fixes');
const TAP49 = FIX['compose tap input.49'];
const P49 = FIX['systemMessage.49'];
const tapRun = (code, res) => runCode(code, {
  nodes: { Inbound: [j({ channel: 'telegram', externalId: '42', kind: 'token', token: 'tkt:6ab0d1fe865937d254d5cba7:rp', text: '' })], 'product action': [j(res)] },
  input: [j({ firstMessage: null, agentInput: null })],
  executed: ['product action'],
})[0].json.agentInput;
const waiting = { success: true, data: { ticketId: '6ab0d1fe865937d254d5cba7', subject: 'A question', status: 'open', awaitingReply: true } };
const notWaiting = { success: true, data: { ticketId: '6ab0d1fe865937d254d5cba7', status: 'open', supportRequest: true } };
const refused = { success: false, error: { customerMessage: 'That request is closed.' } };
const n1590 = tapRun(TAP49, waiting);
check(S13, 'exec 1590 replayed: the note still asks for the reply in one sentence', typeof n1590 === 'string' && n1590.includes('WAITING FOR THE CUSTOMER') && n1590.includes('Ask them for it in one short sentence'), String(n1590).slice(0, 160));
check(S13, 'exec 1590 replayed: the note now forbids filing or attaching on this turn', n1590.includes('call no tool that files, attaches, adds or changes anything on this turn'));
check(S13, 'a tap that is NOT waiting gets exactly the note it got before', tapRun(TAP49, notWaiting) === tapRun(FIX['compose tap input'], notWaiting));
check(S13, 'a refused tap gets exactly the note it got before', tapRun(TAP49, refused) === tapRun(FIX['compose tap input'], refused));
check(S13, 'the tap node changed in that one sentence only', TAP49.replace(ASK_NEW, ASK_OLD_49()) === FIX['compose tap input']);
function ASK_OLD_49() { return require('./build-live-fixes').ASK_OLD; }
check(S13, 'the file rule is replaced once, and putting it back gives the § 5.3 prompt byte for byte', P49.split(FILE_NEW).length - 1 === 1 && !P49.includes(FILE_OLD) && P49.replace(FILE_NEW, FILE_OLD) === FIX['systemMessage.53']);
check(S13, 'it keeps the one legitimate cross-turn use (a typed answer to "which request?")', FILE_NEW.includes('the message just before it when they are now telling you which request it belongs to'));
check(S13, 'it says why an older one fails — a button may have spent it unseen', FILE_NEW.includes('a button may already have attached it without you seeing'));
check(S13, 'no expression added or lost, no backslash, no escaped quote', exprCount(P49) === exprCount(FIX['systemMessage.53']) && !P49.includes(String.fromCharCode(92)) && !TAP49.slice(TAP49.indexOf(ASK_NEW) - 5, TAP49.indexOf(ASK_NEW) + ASK_NEW.length).includes(String.fromCharCode(92)));
check(S13, "every $('…') in the tap node names a live node", refsIn(TAP49).every((r) => LIVE_FORMS.nodeNames.includes(r)), refsIn(TAP49).join(', '));
// — mutant: the live body, replayed on exec 1590, does NOT forbid the write —
check(S14, 'guard bites — the live tap node, on exec 1590, says nothing against filing', !tapRun(FIX['compose tap input'], waiting).includes('call no tool'));

module.exports = {};
