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

module.exports = {};
