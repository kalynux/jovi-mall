// The owner's third handset test (2026-09-22, core execs 2819–2903; phone clock 4 h behind n8n).
//
// ⛔ WHAT IT FOUND: A TURN WHOSE MESSAGE A TOOL DREW IS FORGOTTEN, WHOLE.
//
// n8n's agent does not save a turn to the chat memory when its final answer is EMPTY — not the
// customer's message, not the tool calls, not their results. Measured: exec 2884 ("The
// biscuits!!") searched, added two packs to the basket and drew the order summary with Place
// order / Not now, and its agent metadata reads `ai.agent.memory.saves: 0`. The next turn (2892,
// "Yes please") loaded a history that ENDS at "Your cart is empty…", and answered "Which item
// would you like me to add 2 of?". Same shape one turn earlier: 2827 ("I want to order same
// again") drew the order card and filled the basket, saved nothing, and 2834 ("Place order
// please") was answered "Your order was already placed" — the memory's last word was the old
// payment settling.
//
// The empty answers were OURS. The prompt said "Write nothing yourself" / "write nothing" wherever
// a tool's own message carries the turn, and the model did exactly that.
//
// THE FIX: nothing is spelt `[sent]`. The prompt asks for `[sent]` everywhere it asked for
// nothing, and `compose agent reply` removes it before anything is sent. The customer sees what
// they saw before; the memory keeps the turn.
//
// ⚠ What this harness cannot prove offline: that n8n SAVES a non-empty answer. That is read from
// the first live execution after the apply (`ai.agent.memory.saves: 1` on a drawn-reply turn).
//
// Usage: node build-memory-marker.js <fresh core get_workflow_details dump> [ops out]
const fs = require('fs');
const { runCode, check, report, j } = require('./n8n-sim');

const [freshPath, opsOut] = process.argv.slice(2);
const live = (() => { const f = JSON.parse(fs.readFileSync(freshPath, 'utf8')); return f.workflow || f; })();
const node = (name) => live.nodes.find((n) => n.name === name);

// ── § 0 · drift ─────────────────────────────────────────────────────────────────────────────
const S0 = '§ 0 · written against the live version';
check(S0, 'live draft is ba3096cf and it is the active version',
  live.versionId === 'ba3096cf-ef43-494c-a23c-7924726717a8' && live.activeVersionId === live.versionId, live.versionId);

// ── § 1 · the prompt ────────────────────────────────────────────────────────────────────────
const S1 = '§ 1 · the prompt asks for [sent], never for nothing';
const LIVE_PROMPT = node('AI Agent').parameters.options.systemMessage;
const EDITS = [
  ['with buttons to answer. Write nothing yourself.',
    'with buttons to answer. Your whole answer is then `[sent]`.'],
  ['the payment instructions are sent for you. Write nothing.',
    'the payment instructions are sent for you: answer `[sent]`.'],
  ['Write one short line or nothing, and ⛔ never type the orders out yourself.',
    'Write one short line or `[sent]`, and ⛔ never type the orders out yourself.'],
  ['- Write at most ONE short line leading into it, or nothing at all.',
    '- Write at most ONE short line leading into it, or `[sent]`.'],
  ['When its message says it all, write nothing.',
    'When its message says it all, answer `[sent]`.'],
  ['that message is sent to the customer automatically, straight after yours, buttons and all.\n',
    'that message is sent to the customer automatically, straight after yours, buttons and all.\n\n'
    + '- ⭐ `[sent]` is how you say nothing. When the tools\' messages say it all, your whole answer is exactly `[sent]`. '
    + 'It is removed before anything is sent, so the customer never sees it — but an EMPTY answer makes this conversation '
    + 'forget the whole turn: what you looked up, what you put in the basket, and the question you just asked them. '
    + '⛔ Never answer with nothing at all.\n'],
];
let NEW_PROMPT = LIVE_PROMPT;
for (const [from, to] of EDITS) {
  const count = LIVE_PROMPT.split(from).length - 1;
  check(S1, `anchor found exactly once: "${from.slice(0, 48)}…"`, count === 1, `found ${count}`);
  NEW_PROMPT = NEW_PROMPT.replace(from, to);
}
const nothingLeft = (p) => (p.match(/write nothing|nothing at all\.|or nothing[,.]/gi) || []).filter((m) => !/never answer with nothing at all/i.test(m));
check(S1, 'no instruction to write nothing survives', nothingLeft(NEW_PROMPT.replace(/⛔ Never answer with nothing at all\./g, '')).length === 0,
  nothingLeft(NEW_PROMPT).join(' | '));
check(S1, 'MUTANT (live prompt) still asks for nothing in several places', nothingLeft(LIVE_PROMPT).length >= 4, nothingLeft(LIVE_PROMPT).join(' | '));
check(S1, 'the rule that explains why is present, once', NEW_PROMPT.split('`[sent]` is how you say nothing').length - 1 === 1);
// Every live line survives except the ones an edit replaced: this is an edit, not a rewrite.
const replacedLines = new Set(EDITS.map(([from]) => from.split('\n')[0]));
const lostLines = LIVE_PROMPT.split('\n').filter((l) => l.trim() && !NEW_PROMPT.includes(l) && ![...replacedLines].some((r) => l.includes(r)));
check(S1, 'every other live line survives byte for byte', lostLines.length === 0, lostLines.join('\n'));
check(S1, 'the expression prefix and the botToken line are untouched',
  NEW_PROMPT.startsWith('=') && NEW_PROMPT.includes("botToken: {{ $('sync identity').item.json.data?.customer?.botToken }}"));

// ── § 2 · compose agent reply ───────────────────────────────────────────────────────────────
const S2 = '§ 2 · the marker never reaches the customer';
const LIVE_COMPOSE = node('compose agent reply').parameters.jsCode;
const LIVE_DROP = node('drop duplicate reply').parameters.jsCode;
const ANCHOR = "const answer = String($('AI Agent').first().json.output ?? '').trim();\n";
const REPLACEMENT = [
  "// ⭐ `[sent]` IS HOW THE MODEL SAYS NOTHING, AND IT IS NEVER SENT (handset test 3, 2026-09-22).",
  "// An EMPTY agent answer is not saved to the chat memory at all: n8n's agent skips the save, tool",
  "// calls and all (exec 2884: `ai.agent.memory.saves: 0`). So a turn whose message a TOOL drew --",
  "// the order summary with Place order / Not now -- vanished from memory, and the next \"yes please\"",
  "// was answered as if it had never been sent (exec 2892). The prompt now asks for `[sent]` wherever",
  "// it used to ask for nothing; it is removed here, before anything goes out.",
  "// ⚠ indexOf, not a regex: this body travels inside JSON twice and a backslash is what goes missing.",
  "const MARKER = '[sent]';",
  "const withoutMarker = function (s) {",
  "  let t = String(s);",
  "  let at = t.toLowerCase().indexOf(MARKER);",
  "  while (at >= 0) { t = t.slice(0, at) + t.slice(at + MARKER.length); at = t.toLowerCase().indexOf(MARKER); }",
  "  t = t.trim();",
  "  // A bare `sent` / `Sent.` / `[ sent ]` is the same marker, mistyped: it is not an answer either.",
  "  return t.toLowerCase().replace(/[^a-z]/g, '') === 'sent' ? '' : t;",
  "};",
  "const answer = withoutMarker($('AI Agent').first().json.output ?? '');",
  '',
].join('\n');
check(S2, 'anchor found exactly once in the live node', LIVE_COMPOSE.split(ANCHOR).length - 1 === 1);
const NEW_COMPOSE = LIVE_COMPOSE.replace(ANCHOR, REPLACEMENT);
check(S2, 'the new body has no backslash the live body did not have',
  (NEW_COMPOSE.match(/\\/g) || []).length === (LIVE_COMPOSE.match(/\\/g) || []).length);

const WA = '237600000001';
const MSG = 'wamid.sim-h3';
const bodyFor = (text) => ({ messaging_product: 'whatsapp', to: WA, type: 'interactive',
  interactive: { type: 'button', body: { text }, action: { buttons: [{ type: 'reply', reply: { id: 'yes:co:ia_x', title: 'Place order' } }] } } });
const step = (tool, envelope) => ({ action: { tool: 'wi_mall_MCP_' + tool }, observation: JSON.stringify([{ response: [{ type: 'text', text: JSON.stringify([envelope]) }] }]) });
function turn(composeBody, sc) {
  const steps = (sc.tools || []).map((t) => step(t.tool, Object.assign({ success: true, data: {} },
    t.text ? { reply: { channel: 'whatsapp', method: 'messages', body: bodyFor(t.text) } } : {})));
  const nodes = {
    Inbound: [j({ channel: 'whatsapp', externalId: WA, messageId: MSG })],
    'sync identity': [j({ data: { fallback: { assistantUnavailable: 'Sorry, I could not answer that just now.' } } })],
    'check display': [j({ displayEcho: null })],
    'AI Agent': [j({ output: sc.answer, intermediateSteps: steps })],
  };
  const composed = runCode(composeBody, { nodes, input: [j({})] });
  const dropped = runCode(LIVE_DROP, { nodes: Object.assign({}, nodes, { 'compose agent reply': composed }), input: [j({})] });
  return dropped.filter((i) => i.json.reply).map((i) => {
    const b = i.json.reply.body;
    return [i.json.role, (b.text && (b.text.body || b.text)) || (b.interactive && b.interactive.body && b.interactive.body.text) || ''];
  });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SUMMARY = 'Please check your order:\n2 × Digestive Biscuits — 300 XAF\n\nShall I place the order?';
const REVIEW = [{ tool: 'checkout_review', text: SUMMARY }];

const exec2884 = { answer: '[sent]', tools: REVIEW };
check(S2, 'MUTANT (live node) sends "[sent]" to the customer beside the summary',
  same(turn(LIVE_COMPOSE, exec2884), [['model', '[sent]'], ['tool', SUMMARY]]), JSON.stringify(turn(LIVE_COMPOSE, exec2884)));
check(S2, '⭐ exec 2884 with the marker: the summary goes out ALONE, exactly as the customer saw it',
  same(turn(NEW_COMPOSE, exec2884), [['tool', SUMMARY]]), JSON.stringify(turn(NEW_COMPOSE, exec2884)));
check(S2, 'and exactly what the live node sent for the EMPTY answer that lost the memory',
  same(turn(NEW_COMPOSE, exec2884), turn(LIVE_COMPOSE, { answer: '', tools: REVIEW })));
const CASES = [
  ['"[Sent]" in any case', { answer: '[Sent]', tools: REVIEW }, [['tool', SUMMARY]]],
  ['"[sent]." with trailing punctuation', { answer: '[sent].', tools: REVIEW }, [['tool', SUMMARY]]],
  ['a bare "Sent" (the marker mistyped)', { answer: 'Sent', tools: REVIEW }, [['tool', SUMMARY]]],
  ['a lead-in plus the marker keeps the lead-in', { answer: 'Here is your order. [sent]', tools: REVIEW }, [['model', 'Here is your order.'], ['tool', SUMMARY]]],
  ['a real answer is untouched', { answer: 'Your payment went through.', tools: [] }, [['model', 'Your payment went through.']]],
  ['"sent" inside a real sentence is untouched', { answer: 'The request was sent to your phone.', tools: [] }, [['model', 'The request was sent to your phone.']]],
  ['⚠ the marker with NOTHING sent falls back to the stand-in, never to silence',
    { answer: '[sent]', tools: [{ tool: 'cart_get' }] }, [['standIn', 'Sorry, I could not answer that just now.']]],
];
for (const [name, sc, want] of CASES) {
  const got = turn(NEW_COMPOSE, sc);
  check(S2, name, same(got, want), JSON.stringify(got));
}
// The live behaviour for every answer WITHOUT a marker is unchanged.
const UNCHANGED = [
  { answer: 'Here is what we have.', tools: REVIEW },
  { answer: 'Your order is 300 XAF,', tools: REVIEW },
  { answer: '', tools: REVIEW },
  { answer: '', tools: [] },
  { answer: 'Anything else?', tools: [] },
];
check(S2, 'an answer without the marker composes byte-identically to the live node',
  UNCHANGED.every((sc) => same(turn(NEW_COMPOSE, sc), turn(LIVE_COMPOSE, sc))));

// ── § 3 · the operations ────────────────────────────────────────────────────────────────────
const ops = [
  { type: 'setNodeParameter', nodeName: 'AI Agent', path: '/options/systemMessage', value: NEW_PROMPT },
  { type: 'setNodeParameter', nodeName: 'compose agent reply', path: '/jsCode', value: NEW_COMPOSE },
];
check('§ 3 · operations', 'two operations, on the two nodes named', ops.length === 2);

const failed = report();
if (!failed && opsOut) {
  fs.writeFileSync(opsOut, JSON.stringify(ops));
  fs.writeFileSync(__dirname + '/new/h3_system_message.txt', NEW_PROMPT);
  fs.writeFileSync(__dirname + '/new/h3_compose_agent_reply.txt', NEW_COMPOSE);
  console.log('ops written:', opsOut);
}
process.exitCode = failed ? 1 : 0;
