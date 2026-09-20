// § 6 · a file the customer sent can itself carry a question — send it, and tell the model.
const { runCode, check, j } = require('./n8n-sim');
const { NEW, live } = require('./build-new');

const S6 = '§ 6 · /files/inbound reply';
const INB = { channel: 'telegram', externalId: '42', messageId: 'm7', kind: 'media', text: '' };
const picker = { channel: 'telegram', method: 'sendMessage', body: { chat_id: '42', text: 'Which request is this for?', reply_markup: { inline_keyboard: [[{ text: 'Order ORD-123', callback_data: 'tkt:t1:att_x' }]] } } };
const stored = { success: true, data: { ref: 'att_abc', fileName: 'receipt.jpg', kind: 'image' } };

const composeInput = (code, uploadJson, perceived) => {
  const nodes = { Inbound: [j(INB)], 'upload inbound file': [j(uploadJson)] };
  if (perceived) nodes['call perceive'] = [j(perceived)];
  return runCode(code, { nodes, input: [j({})], mode: 'each' })[0].json.agentInput;
};

const withPicker = composeInput(NEW['core:compose agent input'], Object.assign({ reply: picker }, stored), { perceived: true, kind: 'image', text: 'a receipt' });
check(S6, 'the model is told the customer has ALREADY been asked, and not to spend the one-use reference', /already been asked, with buttons/.test(withPicker) && /Do not attach it yourself/.test(withPicker), withPicker);
check(S6, 'the reference and its rules are still handed over as before', /att_abc/.test(withPicker) && /works ONCE/.test(withPicker));

for (const [name, upload] of [
  ['a stored file with no question (today, and whenever they have no open requests)', stored],
  ['a file the backend refused', { success: false, error: { customerMessage: 'That file is too large' } }],
]) {
  const a = composeInput(live['compose agent input'].parameters.jsCode, upload, { perceived: true, kind: 'image', text: 'a receipt' });
  const b = composeInput(NEW['core:compose agent input'], upload, { perceived: true, kind: 'image', text: 'a receipt' });
  check(S6, `unchanged — ${name}`, a === b, `${a}\n      ${b}`);
}

// The question itself is SENT, after the agent's sentence.
const nodes = {
  Inbound: [j(INB)], 'sync identity': [j({ data: { fallback: { assistantUnavailable: 'SI' } } })],
  'check display': [j({ displayEcho: null })], 'AI Agent': [j({ output: 'Thanks for the photo.' })],
  'upload inbound file': [j(Object.assign({ reply: picker }, stored))],
};
const out = runCode(NEW['core:compose agent reply'], { nodes, input: [j({})] }).map((i) => ({ role: i.json.role, text: i.json.reply.body.text }));
check(S6, 'the question is sent, after the agent\'s sentence', JSON.stringify(out.map((o) => o.text)) === JSON.stringify(['Thanks for the photo.', 'Which request is this for?']) && out[1].role === 'tool', JSON.stringify(out));
const liveOut = runCode(live['compose agent reply'].parameters.jsCode, { nodes, input: [j({})] }).map((i) => i.json.reply.body.text);
check(S6, 'live today: the question is composed and never sent', JSON.stringify(liveOut) === JSON.stringify(['Thanks for the photo.']));

const noReply = { Inbound: nodes.Inbound, 'sync identity': nodes['sync identity'], 'check display': nodes['check display'], 'AI Agent': nodes['AI Agent'], 'upload inbound file': [j(stored)] };
check(S6, 'unchanged — an upload with no question adds no message', JSON.stringify(runCode(NEW['core:compose agent reply'], { nodes: noReply, input: [j({})] }).map((i) => i.json.reply.body.text)) === JSON.stringify(['Thanks for the photo.']));
const noUpload = { Inbound: nodes.Inbound, 'sync identity': nodes['sync identity'], 'check display': nodes['check display'], 'AI Agent': nodes['AI Agent'] };
check(S6, 'unchanged — a turn with no file at all (the node never ran)', JSON.stringify(runCode(NEW['core:compose agent reply'], { nodes: noUpload, input: [j({})] }).map((i) => i.json.reply.body.text)) === JSON.stringify(['Thanks for the photo.']));
