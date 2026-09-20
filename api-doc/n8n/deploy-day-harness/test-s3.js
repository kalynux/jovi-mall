// § 3 · A2 — a turn of several messages is sent whole, in order.
const { runCode, evalExpr, check, j } = require('./n8n-sim');
const { NEW, live } = require('./build-new');

const S3 = '§ 3 · A2 expand replies / send loop / refusals';
const INB = { channel: 'whatsapp', externalId: '237672745831', messageId: 'wamid.A', kind: 'text', text: 'shoes' };
const TG = { channel: 'telegram', externalId: '900000881', messageId: '55', kind: 'text', text: 'shoes' };

const waText = (body, to = INB.externalId) => ({ channel: 'whatsapp', method: 'messages', body: { messaging_product: 'whatsapp', to, type: 'text', text: { body } } });
const tgText = (text, chat = 900000881) => ({ channel: 'telegram', method: 'sendMessage', body: { chat_id: chat, text } });
const tgPhoto = (caption) => ({ channel: 'telegram', method: 'sendPhoto', body: { chat_id: '900000881', photo: 'https://x/a.jpg', caption } });

const expand = (inbound, items) => runCode(NEW['core:expand replies'], { nodes: { Inbound: [j(inbound)] }, input: items.map(j) });
const textsOf = (out) => out.map((i) => { const b = i.json.reply.body; return b.text && b.text.body ? b.text.body : (b.text || b.caption); });

// ── the shapes the backend actually sends ────────────────────────────────────
let out = expand(INB, [{ success: true, data: { shown: 3 }, reply: waText('Here is what we have.'), replies: [waText('Here is what we have.'), waText('card 1'), waText('card 2'), waText('See more')] }]);
check(S3, 'a product page: `replies` is sent WHOLE and in order (live sends `reply` alone — 3 of 4 messages lost)',
  out.length === 4 && JSON.stringify(textsOf(out)) === JSON.stringify(['Here is what we have.', 'card 1', 'card 2', 'See more']), JSON.stringify(textsOf(out)));
check(S3, 'a one-message turn is unchanged: `reply` alone → exactly one message', expand(INB, [{ reply: waText('Your order is on its way.') }]).length === 1);
check(S3, '`replies` INCLUDES the body in `reply` — it is never sent twice', (() => {
  const o = expand(INB, [{ reply: waText('a'), replies: [waText('a'), waText('b')] }]);
  return o.length === 2 && JSON.stringify(textsOf(o)) === JSON.stringify(['a', 'b']);
})());
check(S3, 'the agent path: several single-reply items (cards) keep their order', (() => {
  const o = expand(TG, [{ reply: tgText('Here they are.') }, { reply: tgPhoto('card 1') }, { reply: tgPhoto('card 2') }]);
  return o.length === 3 && JSON.stringify(textsOf(o)) === JSON.stringify(['Here they are.', 'card 1', 'card 2']);
})());
check(S3, 'an empty `replies` array falls back to `reply`', expand(INB, [{ reply: waText('x'), replies: [] }]).length === 1);
check(S3, 'a null reply yields nothing to send (send guard already drops these)', expand(INB, [{ reply: null }]).length === 0);
check(S3, 'a Telegram chat_id that is a NUMBER still matches the conversation', expand(TG, [{ reply: tgText('hi', 900000881) }]).length === 1);

// ── the refusals, which must be loud ─────────────────────────────────────────
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
check(S3, '⛔ a body addressed to ANOTHER chat fails the turn, never quietly dropped', throws(() => expand(INB, [{ reply: waText('hi', '237600000999') }]), /addressed to whatsapp:237600000999/));
check(S3, '⛔ a reply for the other channel fails the turn', throws(() => expand(INB, [{ reply: tgText('hi') }]), /addressed to telegram/));
check(S3, '⛔ a reply with no body fails the turn', throws(() => expand(INB, [{ reply: { channel: 'whatsapp', method: 'messages' } }]), /without channel\/method\/body/));

// ── per-message channel routing (the LIVE `is telegram?` node, unchanged) ────
const isTelegram = (item) => evalExpr(live['is telegram?'].parameters.conditions.conditions[0].leftValue, { json: item.json });
check(S3, 'the live `is telegram?` node routes each expanded message on its own reply', isTelegram(j({ reply: tgText('a') })) === true && isTelegram(j({ reply: waText('a') })) === false);

// ── a refused send is remembered, and the run still fails ONCE, at the end ──
const noteRefused = (errorJson) => runCode(NEW['core:note refused send'], { nodes: { Inbound: [j(INB)] }, input: [j(errorJson)], mode: 'each' })[0].json;
const metaRefusal = noteRefused({ error: { message: 'Request failed with status code 400', statusCode: 400, error: { error: { message: '(#131030) Recipient not in allowed list', code: 131030 } }, description: 'Bad Request' }, details: {} });
check(S3, 'a Meta refusal is recorded with its status and its own words', metaRefusal._refused.httpCode === '400' && /131030/.test(metaRefusal._refused.description), JSON.stringify(metaRefusal));
const buildFailure = noteRefused({ error: 'Invalid URL' });
check(S3, 'a request that could not even be built is recorded too (HttpRequest emits a STRING there)', buildFailure._refused.message === 'Invalid URL' && buildFailure._refused.httpCode === null, JSON.stringify(buildFailure));
check(S3, 'the refusal names the channel of the turn', metaRefusal._refused.channel === 'whatsapp');

const verdict = (items) => runCode(NEW['core:any send refused?'], { nodes: { Inbound: [j(INB)] }, input: items.map(j) });
check(S3, 'every message accepted → the turn succeeds', verdict([{ messages: [{ id: 'wamid.1' }] }, { messages: [{ id: 'wamid.2' }] }]).length === 2);
check(S3, '⛔ one refusal among many → the run FAILS once, at the end, naming how many (ADR-022 kept)',
  throws(() => verdict([{ messages: [{ id: 'wamid.1' }] }, metaRefusal, { messages: [{ id: 'wamid.3' }] }]), /1 of 3 outbound message\(s\) refused.*131030/));

// ── the loop, modelled: n8n's Loop Over Items + the two send nodes ───────────
// ⚠ A MODEL of the node graph, not proof of n8n's own semantics: it encodes that `send loop`
// hands one item at a time and only continues when that item comes back. n8n's sequential
// behaviour itself is checked live on deploy day (§ 12).
function runTurn(inbound, items, refuseAt = []) {
  const expanded = expand(inbound, items);
  const attempted = [];
  const returned = [];
  expanded.forEach((item, i) => {
    attempted.push(textsOf([item])[0]);
    if (refuseAt.includes(i)) {
      returned.push(j(noteRefused({ error: { message: 'Request failed with status code 400', statusCode: 400, description: 'refused' } })));
    } else {
      returned.push(j({ messages: [{ id: 'wamid.' + i }] }));
    }
  });
  let failed = null;
  try { verdict(returned.map((r) => r.json)); } catch (e) { failed = e.message; }
  return { attempted, failed };
}
const five = [{ replies: [waText('intro'), waText('c1'), waText('c2'), waText('c3'), waText('See more')] }];
let t = runTurn(INB, five);
check(S3, 'five messages: each is started only after the previous one is accepted, in order', JSON.stringify(t.attempted) === JSON.stringify(['intro', 'c1', 'c2', 'c3', 'See more']) && t.failed === null);
t = runTurn(INB, five, [1]);
check(S3, '⛔ card 1 refused: the other four are STILL SENT, and the run fails afterwards',
  t.attempted.length === 5 && /1 of 5/.test(t.failed || ''), JSON.stringify(t));
t = runTurn(INB, five, [0, 4]);
check(S3, 'two refusals are counted together in one failure', /2 of 5/.test(t.failed || ''));

// ── what must not break: the single-message turns that exist today ───────────
for (const [name, inbound, item] of [
  ['an onboarding prompt', TG, { reply: tgText('First, I need your phone number…') }],
  ['a refusal built from error.customerMessage', TG, { success: false, error: { customerMessage: 'x' }, reply: tgText('x') }],
  ['a WhatsApp interactive card', INB, { reply: { channel: 'whatsapp', method: 'messages', body: { to: INB.externalId, type: 'interactive', interactive: {} } } }],
]) {
  const o = expand(inbound, [item]);
  check(S3, `unchanged — ${name}: exactly one message, body untouched`, o.length === 1 && JSON.stringify(o[0].json.reply) === JSON.stringify(item.reply));
}
