// § 1 (A1 routing) and § 2 (completed WhatsApp forms), against the LIVE node code and the new.
const fs = require('fs');
const path = require('path');
const { runCode, evalExpr, check, j } = require('./n8n-sim');
const { NEW, live, liveWaNormalize } = require('./build-new');

// The repo root, four levels up from api-doc/n8n/deploy-day-harness/.
const JOVI = process.env.JOVI_MALL || path.join(__dirname, '..', '..', '..');

// ════════════════════════════════════════════════════════════════════════════
// § 1 · A1
// ════════════════════════════════════════════════════════════════════════════
const S1 = '§ 1 · A1 route turn';

// The corpus is DERIVED from the backend's own verb list, never hand-kept.
const actionIdSrc = fs.readFileSync(path.join(JOVI, 'src/modules/bot-surface/domain/bot-action-id.ts'), 'utf8').replace(/\r\n/g, '\n');
const block = /export const BOT_ACTION_VERBS = Object\.freeze\(\[([\s\S]*?)\] as const\)/.exec(actionIdSrc);
const verbs = block ? [...block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : [];
// ⚠ A scan that stops matching returns nothing, and nothing satisfies "every verb routes".
check(S1, `the verb scan found the backend's vocabulary (${verbs.length} verbs)`, verbs.length >= 20 && verbs.includes('add') && verbs.includes('ord'), JSON.stringify(verbs));

const inboundTap = (token, kind = 'token') => ({ Inbound: [j({ channel: 'telegram', externalId: '900', messageId: 'cb1', kind, token, text: '' })] });
const routes = (expr, token, kind) => evalExpr(expr, { nodes: inboundTap(token, kind) }) === true;

const liveRule = NEW['core:route turn.rule3.old'];
const newRule = NEW['core:route turn.rule3'];

// `skip:` is the ONE verb that belongs to /identity/onboarding, not to the dispatcher
// (bot-surface.md § 14.6), so it is excluded by name and everything else routes.
for (const v of verbs) {
  const token = v === 'skip' ? 'skip:email' : `${v}:68b0aa0000000000000000aa`;
  const was = routes(liveRule, token);
  const now = routes(newRule, token);
  const want = v !== 'skip';
  check(S1, `${token.padEnd(34)} live=${was ? 'backend' : 'ASSISTANT'}  new=${now ? 'backend' : (v === 'skip' ? 'onboarding/assistant — by design' : 'ASSISTANT')}`, now === want);
}
// A LIVE skip is one taken while a step is still pending, and rule 2 claims that turn before
// rule 3 is ever evaluated. Asserted against the live rule 2 expression, with a skip in hand.
const rule2 = live['route turn'].parameters.rules.values[1].conditions.conditions[0].leftValue;
const onboardingClaims = (next) => evalExpr(rule2, { nodes: inboundTap('skip:email'), json: { data: { onboarding: { next } } } }) === true;
check(S1, 'a LIVE skip (a step still pending) is claimed by rule 2 and never reaches the tap rule', onboardingClaims({ step: 'email', kind: 'text' }) === true);
check(S1, 'a STALE skip (nothing pending) is not claimed by rule 2 — it is excluded by name instead', onboardingClaims(null) === false && routes(newRule, 'skip:email') === false);
check(S1, 'a verb requested this round and not yet declared (acct:addr) still routes — no list in n8n', routes(newRule, 'acct:addr') === true);
check(S1, 'a bare geo-candidate handle (gc_…) does NOT route to /catalog/action', routes(newRule, 'gc_Zx81kP') === false);
check(S1, 'an empty token does not route', routes(newRule, '') === false);
check(S1, 'typed text never routes, even when it looks like a token', routes(newRule, 'ord:1', 'text') === false);
check(S1, 'a malformed token still routes (the dispatcher words the refusal)', routes(newRule, 'no-colon-here') === true);

// Rule ORDER is what protects onboarding: rule 2 (`onboarding`) must be evaluated before this one.
const rules = live['route turn'].parameters.rules.values.map((r) => r.outputKey);
check(S1, `rule order is error → onboarding → tap (live: ${rules.join(' → ')})`, rules[0] === 'error' && rules[1] === 'onboarding' && rules.length === 3);
check(S1, 'the switch falls back to the assistant for everything else', live['route turn'].parameters.options.fallbackOutput === 'extra');

// Guard bites: the same assertions against the LIVE rule must fail for the new verbs.
const liveMisses = verbs.filter((v) => !['add', 'buy', 'more'].includes(v)).filter((v) => !routes(liveRule, `${v}:x`));
check(S1, `guard bites — the live rule drops ${liveMisses.length} of ${verbs.length} verbs to the assistant`, liveMisses.length === verbs.length - 3, liveMisses.join(','));

// ════════════════════════════════════════════════════════════════════════════
// § 2 · completed WhatsApp forms
// ════════════════════════════════════════════════════════════════════════════
const S2a = '§ 2 · wa-adapter normalize (live vs new)';

const meta = (message) => ({ 'WhatsApp Trigger': [j({ messages: [Object.assign({ from: '237672745831', id: 'wamid.X' }, message)], contacts: [{ wa_id: '237672745831', profile: { name: 'Ulrich' } }] })] });
const runNormalize = (code, message) => runCode(code, { nodes: meta(message), input: [j({})], mode: 'each' })[0].json;

const PRODUCT = '68b0aa0000000000000000aa';
const fixtures = [
  ['text', { type: 'text', text: { body: 'hello' } }],
  ['button_reply', { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'ord:abc', title: 'My orders' } } }],
  ['list_reply', { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'lang:fr', title: 'Français' } } }],
  ['template quick-reply', { type: 'button', button: { payload: 'pay:st:tx1', text: 'Check status' } }],
  ['location', { type: 'location', location: { latitude: 4.05, longitude: 9.7 } }],
  ['sticker', { type: 'sticker', sticker: { id: 's1' } }],
];
for (const [name, msg] of fixtures) {
  const a = runNormalize(liveWaNormalize, msg);
  const b = runNormalize(NEW['wa:normalize'], msg);
  const bWithoutForm = Object.assign({}, b); delete bWithoutForm.form;
  check(S2a, `${name}: identical to live, plus form: null`, JSON.stringify(a) === JSON.stringify(bWithoutForm) && b.form === null, JSON.stringify({ a, b }));
}

const nfm = (responseJson) => ({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: responseJson } } });
const formCases = [
  ['listing, product chosen', JSON.stringify({ flow_token: 'ia_abc', screen: 'pl', productId: PRODUCT }), { flow_token: 'ia_abc', screen: 'pl', productId: PRODUCT }],
  ['checkout closed, spent token absent', JSON.stringify({ screen: 'co', outcome: 'notice' }), { screen: 'co', outcome: 'notice' }],
  ['a future form with its own params (passthrough)', JSON.stringify({ flow_token: 'ia_x', screen: 'bk', slot: 'slot_1_2', extra: { a: 1 } }), { flow_token: 'ia_x', screen: 'bk', slot: 'slot_1_2', extra: { a: 1 } }],
  ['malformed response_json', '{not json', null],
  ['response_json is an array', '[1,2]', null],
  ['response_json missing', undefined, null],
];
for (const [name, rj, expected] of formCases) {
  const a = runNormalize(liveWaNormalize, nfm(rj));
  const b = runNormalize(NEW['wa:normalize'], nfm(rj));
  check(S2a, `nfm_reply — ${name}: live kind=${a.kind} text=${JSON.stringify(a.text)} → new kind=${b.kind}`, a.kind === 'unsupported' && a.text === '' && b.kind === 'form' && JSON.stringify(b.form) === JSON.stringify(expected), JSON.stringify(b));
}
check(S2a, 'a form keeps the sender as externalId (bare digits) — the backend authorises on it', runNormalize(NEW['wa:normalize'], nfm('{}')).externalId === '237672745831');

// ── core: detect command ─────────────────────────────────────────────────────
const S2b = '§ 2 · core detect command / run command / command reply';
const syncOk = { success: true, data: { onboarding: { next: null } } };
const form = { flow_token: 'ia_abc', screen: 'pl', productId: PRODUCT };
const inForm = { channel: 'whatsapp', externalId: '237672745831', messageId: 'wamid.F', kind: 'form', text: '', token: '', form };
const detect = (code, inbound, sync) => runCode(code, { nodes: { Inbound: [j(inbound)] }, input: [j(sync)] })[0].json;

const dLive = detect(live['detect command'].parameters.jsCode, inForm, syncOk);
const dNew = detect(NEW['core:detect command'], inForm, syncOk);
check(S2b, `form: live _kind=${JSON.stringify(dLive._kind)} (→ assistant) · new _kind=${JSON.stringify(dNew._kind)}`, dLive._kind === '' && dNew._kind === 'form' && JSON.stringify(dNew._payload) === JSON.stringify(form));
check(S2b, 'form with a failed /identity/sync is left to route turn (the refusal renders itself)', detect(NEW['core:detect command'], inForm, { success: false, error: {} })._kind === '');
for (const [name, inbound, sync] of [
  ['slash', { channel: 'telegram', externalId: '9', kind: 'text', text: '/orders' }, syncOk],
  ['contact after onboarding', { channel: 'telegram', externalId: '9', kind: 'contact', contact: { phoneNumber: '+237', userId: 9 } }, syncOk],
  ['contact during onboarding', { channel: 'telegram', externalId: '9', kind: 'contact', contact: { phoneNumber: '+237', userId: 9 } }, { success: true, data: { onboarding: { next: { step: 'phone' } } } }],
  ['plain text', { channel: 'whatsapp', externalId: '2', kind: 'text', text: 'hi' }, syncOk],
  ['tap', { channel: 'whatsapp', externalId: '2', kind: 'token', token: 'ord:1', text: '' }, syncOk],
]) {
  check(S2b, `unchanged — ${name}`, JSON.stringify(detect(live['detect command'].parameters.jsCode, inbound, sync)) === JSON.stringify(detect(NEW['core:detect command'], inbound, sync)));
}

// ── core: run command (URL unchanged, body names the command) ───────────────
const runNodes = (inbound) => ({ Inbound: [j(inbound)] });
const url = evalExpr(live['run command'].parameters.url, { nodes: runNodes(inForm), json: dNew, env: { JOVI_MALL_BASE_URL: 'http://jovi-mall:8022' } });
check(S2b, `form posts to ${url.replace('http://jovi-mall:8022', '')}`, url === 'http://jovi-mall:8022/api/webhooks/whatsapp');
const body = JSON.parse(evalExpr(NEW['core:run command.jsonBody'], { nodes: runNodes(inForm), json: dNew }));
check(S2b, 'form body = { is_command, command: flow_complete, payload: <form untouched>, reply_to: <sender> }',
  body.is_command === true && body.command === 'flow_complete' && JSON.stringify(body.payload) === JSON.stringify(form) && body.reply_to === '237672745831' && Object.keys(body).length === 4, JSON.stringify(body));
const contactIn = { channel: 'whatsapp', externalId: '237600', kind: 'contact', contact: { phoneNumber: '+237600', userId: 1 } };
const dContact = detect(live['detect command'].parameters.jsCode, contactIn, syncOk);
check(S2b, 'unchanged — the contact command body', evalExpr(live['run command'].parameters.jsonBody, { nodes: runNodes(contactIn), json: dContact }) === evalExpr(NEW['core:run command.jsonBody'], { nodes: runNodes(contactIn), json: dContact }));
const slashIn = { channel: 'telegram', externalId: '9', kind: 'text', text: '/orders' };
const dSlash = detect(live['detect command'].parameters.jsCode, slashIn, syncOk);
check(S2b, 'unchanged — the slash command body', evalExpr(live['run command'].parameters.jsonBody, { nodes: runNodes(slashIn), json: dSlash }) === evalExpr(NEW['core:run command.jsonBody'], { nodes: runNodes(slashIn), json: dSlash }));

// ── core: command reply + the new `ends silently?` gate ──────────────────────
const cmdReply = (code, inbound, response) => runCode(code, { nodes: { Inbound: [j(inbound)] }, input: [j(response)] });
const ENDS = '={{ $json.endTurn === true }}';
const endsSilently = (item) => evalExpr(ENDS, { json: item.json });
const aReply = { channel: 'whatsapp', method: 'messages', body: { to: '237672745831', type: 'interactive' } };

let out = cmdReply(NEW['core:command reply'], inForm, { message: 'Inbound recorded', reply: aReply });
check(S2b, 'form + reply (listing chose a product) → the reply is sent', out.length === 1 && out[0].json.reply === aReply && !endsSilently(out[0]));
out = cmdReply(NEW['core:command reply'], inForm, { message: '', completedScreen: 'co', params: {} });
const outLive = cmdReply(live['command reply'].parameters.jsCode, inForm, { message: '', completedScreen: 'co', params: {} });
check(S2b, `form, no reply → turn ENDS (live: reply ${JSON.stringify(outLive[0].json.reply)} → has reply? false → the assistant greets)`, out.length === 1 && out[0].json.reply === null && endsSilently(out[0]) === true);
let threw = null;
try { cmdReply(NEW['core:command reply'], inForm, { success: false, error: { code: 'VALIDATION_ERROR', customerMessage: 'x' } }); } catch (e) { threw = e.message; }
check(S2b, 'form refused (e.g. unreadable response_json → null payload) → the run FAILS and is reported, nothing worded', threw && /flow_complete refused/.test(threw) && /VALIDATION_ERROR/.test(threw), String(threw));
for (const [name, response] of [
  ['command with its own reply', { reply: aReply }],
  ['error with a customer sentence', { success: false, error: { customerMessage: 'Désolé' } }],
  ['error with no sentence at all', { success: false, error: {} }],
]) {
  const a = cmdReply(live['command reply'].parameters.jsCode, contactIn, response);
  const b = cmdReply(NEW['core:command reply'], contactIn, response);
  check(S2b, `unchanged for a non-form command — ${name}`, JSON.stringify(a) === JSON.stringify(b) && !endsSilently(b[0]));
}
