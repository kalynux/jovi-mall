// The model's half of "a typed yes = the Yes button" (owner's decision, 2026-09-22).
//
// jovi-mall 6008fda records the Yes/No question it draws (place order, confirm delivery, cancel
// order, close a support request, disconnect an app — never account closure) and hands it to the
// model on every message as `data.customer.pendingQuestion` { context, text, askedAt }. The tool
// `chat_answer_question` { answer: yes|no } runs that question's own button token, so a typed
// answer does exactly what the tap does.
//
// Found on the owner's third handset test (core 2892): "Yes please" under the drawn order summary
// was answered "Which item would you like me to add 2 of?". Two causes; `build-memory-marker.js`
// fixed the memory half. This is the half that does not depend on memory at all — and the only
// half that works after a TAP drew the question, because taps never pass the model.
//
// ⚠ Apply AFTER jovi-mall 6008fda is deployed and the MCP server serves chat_answer_question.
//
// Usage: node build-typed-answer-prompt.js <fresh core dump> [ops out]
const fs = require('fs');
const { evalExpr, check, report, j } = require('./n8n-sim');

const [corePath, opsOut] = process.argv.slice(2);
const core = (() => { const f = JSON.parse(fs.readFileSync(corePath, 'utf8')); return f.workflow || f; })();
const CORE_VERSION = process.env.CORE_VERSION || 'b59c40a2-7a70-45af-b272-9bc8ec661857';

const S0 = '§ 0 · written against the live version';
check(S0, `core is ${CORE_VERSION.slice(0, 8)} and active`, core.versionId === CORE_VERSION && core.activeVersionId === core.versionId, core.versionId);

const LIVE = core.nodes.find((n) => n.name === 'AI Agent').parameters.options.systemMessage;
const S1 = '§ 1 · the prompt';

const WAITING_LINE = "waiting question: {{ $('sync identity').item.json.data?.customer?.pendingQuestion ? JSON.stringify($('sync identity').item.json.data.customer.pendingQuestion.text) : 'none' }}";
const SECTION = [
  '## A QUESTION WAITING FOR THEIR ANSWER',
  WAITING_LINE,
  '',
  'That line is `none`, or a question the platform has just asked this customer with Yes / No buttons: place this order, did the parcel arrive, cancel this order, close this support request, disconnect the other app.',
  '- When it is not `none` and the customer\'s latest message ANSWERS it in words — "yes", "yes please", "ok", "go ahead", "place it", "no", "not now", "leave it", in any language — call `chat_answer_question` with `yes` or `no`. It does exactly what tapping the button does, and its message is sent for you: answer `[sent]`.',
  '- A question back is not an answer ("how much is delivery?", "have you placed it?"): answer it, and leave their question waiting.',
  '- ⛔ Never answer it on their behalf, and never call it for anything else. If it says no question is waiting, tell them in one line to tap the button or say what they want.',
  '',
  '',
].join('\n');
const SECTION_ANCHOR = '## PAYMENT STATUS\n';
const CHECKOUT_FROM = '- Only a clear yes to that summary places the order ("yes", "go ahead", "place it"): then call `checkout_place` with the `checkoutRef` and the `delivery.address.id` from that review, or the id of the saved address they chose.';
const CHECKOUT_TO = '- Only a clear yes to that summary places the order ("yes", "go ahead", "place it"). When the summary was sent for you, it is the waiting question below: answer it with `chat_answer_question`. Only when no question is waiting, call `checkout_place` with the `checkoutRef` and the `delivery.address.id` from that review, or the id of the saved address they chose.';

check(S1, 'the checkout sentence is found exactly once', LIVE.split(CHECKOUT_FROM).length - 1 === 1);
check(S1, 'the section anchor is found exactly once', LIVE.split(SECTION_ANCHOR).length - 1 === 1);
check(S1, 'the live prompt does not know the tool yet', !LIVE.includes('chat_answer_question'));
const NEW = LIVE.replace(CHECKOUT_FROM, CHECKOUT_TO).replace(SECTION_ANCHOR, SECTION + SECTION_ANCHOR);
// The one edited line is the one that contains the checkout anchor; its tail must survive too.
const lost = LIVE.split('\n').filter((l) => l.trim() && !NEW.includes(l) && !l.includes(CHECKOUT_FROM));
const editedTail = LIVE.split('\n').find((l) => l.includes(CHECKOUT_FROM)).slice(CHECKOUT_FROM.length);
check(S1, 'the edited checkout line keeps its tail ("Never call it without that yes…")',
  editedTail.startsWith(' Never call it without that yes') && NEW.includes(CHECKOUT_TO + editedTail));
check(S1, 'every other live line survives byte for byte', lost.length === 0, lost.join('\n'));
check(S1, 'the new section sits between CHECKOUT and PAYMENT STATUS',
  NEW.indexOf('## CHECKOUT') < NEW.indexOf('## A QUESTION WAITING') && NEW.indexOf('## A QUESTION WAITING') < NEW.indexOf('## PAYMENT STATUS'));
check(S1, 'account closure is not offered as a typed answer', !/close (your|the|their) account/i.test(SECTION));

// The waiting line, rendered as n8n will render it.
const render = (pq) => String(evalExpr('={{' + WAITING_LINE.slice(WAITING_LINE.indexOf('{{') + 2, WAITING_LINE.lastIndexOf('}}')) + '}}',
  { nodes: { 'sync identity': [j({ data: { customer: pq === undefined ? {} : { pendingQuestion: pq } } })] } }));
check(S1, 'no question → none', render(null) === 'none' && render(undefined) === 'none');
const Q = { context: 'co', text: 'Please check your order:\n2 × Digestive Biscuits — 300 XAF\n\nShall I place the order?', askedAt: '2026-09-22T14:12:24.000Z' };
check(S1, 'a question → its words on ONE line, quoted (newlines escaped, never a raw break)',
  render(Q) === JSON.stringify(Q.text) && !render(Q).includes('\n'), render(Q));
check(S1, 'never the tokens: only `.text` is read', !WAITING_LINE.includes('Token') && !WAITING_LINE.includes('context'));

// The tool the prompt names is one the catalogue offers the model.
const cat = require('../tools/catalog.json').tools;
const tool = cat.find((t) => t.name === 'chat_answer_question');
check(S1, 'chat_answer_question is in the catalogue, model-facing and available',
  !!tool && tool.tier !== 'flow_only' && tool.status === 'available' && tool.operation.path === '/api/internal/bot/chat/answer');

const ops = [{ type: 'setNodeParameter', nodeName: 'AI Agent', path: '/options/systemMessage', value: NEW }];
check('§ 2 · operations', 'one operation', ops.length === 1);

const failed = report();
if (!failed && opsOut) {
  fs.writeFileSync(opsOut, JSON.stringify(ops));
  fs.writeFileSync(__dirname + '/new/h3_system_message_typed_answer.txt', NEW);
  console.log('ops written:', opsOut);
}
process.exitCode = failed ? 1 : 0;
