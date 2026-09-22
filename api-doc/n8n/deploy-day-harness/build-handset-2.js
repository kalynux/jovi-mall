// The owner's second handset test (2026-09-22, core execs 2245–2317, bargain 2259/2266) — what it
// found, and the n8n half of the fix. Run `node build-handset-2.js` to test, `--write` to emit the
// new bodies into new/ and the two operation batches into the scratchpad directory given as
// H2_OPS_DIR (default: this folder's new/).
//
// What the executions showed (phone clock 4 h behind n8n; 01:34 on the phone = 05:34 UTC):
//
//   1 · MEMORY REPLAYED AN OLD HAGGLE. "I use to buy it at 75" (exec 2258) made the main model call
//       `open_negotiation` TWICE in one turn — first for the POWER BANK, copying the exact
//       arguments of a call four and a half hours old ("6k", productId 6ab1cf6e…), then for the
//       biscuits. Each call starts the bargainer, and the bargainer SENDS: the customer got two
//       answers, the first about the wrong product ("Yes — 7 500 for you, same as always"). The
//       first biscuits turn (2245) spent 940 tokens and answered about shoes without searching.
//       The chat memory held 20 interactions for three days; every prompt was ~25 000 tokens, most
//       of it stale tool output, including an OLD botToken.
//   2 · THE BARGAINER'S MEMORY IS KEYED TO THE CUSTOMER, NOT TO THE HAGGLE (`externalId` alone), so
//       a new haggle on the biscuits opened with the last hour of the power-bank haggle loaded.
//   3 · THE MAIN MODEL TRUNCATED ITS OWN ANSWERS — finish_reason "stop", mid-sentence: "I'll see
//       what can" (2258), "Your order is 200 XAF," (2294), "The basket" (2300). The second was the
//       checkout confirmation: the customer never saw the question, and the order was placed two
//       turns later on "Have you placed the order?". The backend half of this change makes the
//       SERVER draw that confirmation; this half drops a cut-off sentence when a tool is carrying
//       the turn's message anyway.
//   4 · "I approved already" was answered with an offer to "send a fresh payment request". The
//       payment settled a minute later (05:52:10). A waiting payment gets patience, never a second
//       request.
const fs = require('fs');
const path = require('path');
const { runCode, evalExpr, check, report, j } = require('./n8n-sim');

const CORE_PATH = process.env.CORE_SNAPSHOT || 'C:/Users/Fante/Desktop/wi-mall-deploy/wi-mall-core-05616e98-fresh.json';
const BARGAIN_PATH = process.env.BARGAIN_SNAPSHOT || 'C:/Users/Fante/Desktop/wi-mall-deploy/wi-mall-bargain-331e790e.json';
for (const p of [CORE_PATH, BARGAIN_PATH]) {
  if (!fs.existsSync(p)) { console.log('  ✘ refusing to run: need ' + p); process.exit(1); }
}
const CORE = JSON.parse(fs.readFileSync(CORE_PATH, 'utf8'));
const BARGAIN = JSON.parse(fs.readFileSync(BARGAIN_PATH, 'utf8'));
const nodeOf = (wf, name) => {
  const n = (wf.nodes || wf.data.nodes).find((x) => x.name === name);
  if (!n) throw new Error('no node ' + name);
  return n;
};

const patch = (label, body, pairs) => {
  let out = body;
  for (const [a, b] of pairs) {
    const n = out.split(a).length - 1;
    if (n !== 1) throw new Error(label + ': anchor found ' + n + ' times: ' + a.slice(0, 70));
    out = out.replace(a, () => b);
  }
  return out;
};

// ════════════════════════════════════════════════════════════════════════════════════════
//  CORE — the system prompt
// ════════════════════════════════════════════════════════════════════════════════════════
const LIVE_PROMPT = nodeOf(CORE, 'AI Agent').parameters.options.systemMessage;

const HAGGLE_ANCHOR = 'call `open_negotiation` with that product\'s id, the variant id if you know which one, the quantity, and the figure they named if they named one.\n';
const HAGGLE_NEW = HAGGLE_ANCHOR
  + 'Call it at most once for each message the customer sends, and only for the product that message is about: never for a product from earlier in the chat that they have not just mentioned again.\n';

const CHECKOUT_START = '## CHECKOUT\n';
const ORDERS_START = '## ORDERS\n';
const OLD_CHECKOUT = LIVE_PROMPT.slice(LIVE_PROMPT.indexOf(CHECKOUT_START), LIVE_PROMPT.indexOf(ORDERS_START));
const NEW_CHECKOUT = [
  '## CHECKOUT',
  'When the customer wants to buy what is in their basket ("checkout", "I\'ll take it", "place the order", "let\'s pay"), call `checkout_review`. It already knows their saved delivery addresses and the mobile-money number on their account.',
  '- When its answer contains `reply`, the order summary and the question are sent to the customer for you, with buttons to answer. Write nothing yourself.',
  '- When it has no `reply`, tell them in one or two short lines the total, where it will be delivered and the masked number the payment request will go to, and ask them to confirm.',
  '- Only a clear yes to that summary places the order ("yes", "go ahead", "place it"): then call `checkout_place` with the `checkoutRef` and the `delivery.address.id` from that review, or the id of the saved address they chose. Never call it without that yes, and never twice. A question is not a yes: "have you placed it?" is answered "not yet", and they are asked again.',
  '- ⛔ Never ask for a delivery address or a phone number: they are on the account and the review shows them. For another saved address, call `checkout_review` again with its `deliveryAddressId`. With no saved address, give them the `addAddressUrl` unless a message already carries it: new addresses are added on the website. Offer to carry on once it is saved.',
  '- After `checkout_place`: when its answer contains `reply`, the payment instructions are sent for you. Write nothing. Otherwise `waiting` means tell them to approve the payment on their phone, and the result arrives in this chat; `failed` means no payment request is coming: say so plainly and offer to send it again with `checkout_retry_payment` once they agree.',
  '',
  '## PAYMENT STATUS',
  '"Did my payment go through?", "I have approved it", "I paid" are `checkout_payment_status`. Payment is by mobile money.',
  '- `waiting`: kindly ask them to be patient. A mobile-money payment can take a few minutes to go through after it is approved, and a message will arrive here as soon as it has. ⛔ Never offer or send a new payment request while a payment is waiting, and never suggest it has failed.',
  '- `settled`: tell them it went through.',
  '- `failed`: tell them no money was taken, and offer to send a new request with `checkout_retry_payment` once they agree.',
  '',
  '',
].join('\n');

const RULE_ANCHOR = '- NEVER invent product data, prices, stock or order status. Use a tool.\n';
const RULE_NEW = RULE_ANCHOR
  + '- The chat history can be old, or about something else. Act on the customer\'s latest message: never repeat a tool call, a product, a price or an address from earlier in the chat unless they have just brought it up again.\n';

const NEW_PROMPT = patch('systemMessage', LIVE_PROMPT, [
  [HAGGLE_ANCHOR, HAGGLE_NEW],
  [OLD_CHECKOUT, NEW_CHECKOUT],
  [RULE_ANCHOR, RULE_NEW],
]);

// ════════════════════════════════════════════════════════════════════════════════════════
//  CORE — `compose agent reply`: a cut-off sentence never rides beside a message that says it all
// ════════════════════════════════════════════════════════════════════════════════════════
const LIVE_COMPOSE = nodeOf(CORE, 'compose agent reply').parameters.jsCode;
const LIVE_DROP = nodeOf(CORE, 'drop duplicate reply').parameters.jsCode;

const OWN_ANCHOR = "// Punctuation left over from a removed sentence is not a sentence.\nconst ownAnswer = wordsOf(unrepeated).length > 0 ? unrepeated : '';\n";
const OWN_NEW = [
  '// ⚠ A SENTENCE THE MODEL DID NOT FINISH IS NEVER SENT BESIDE A MESSAGE THAT SAYS IT ALL.',
  '// Measured 2026-09-22 (exec 2294): the main model\'s whole answer came back as "Your order is',
  '// 200 XAF," -- finish_reason "stop", mid-sentence -- on the turn that had to ask "shall I place',
  '// it?". When a tool\'s own message or the product cards carry this turn, a fragment adds nothing',
  '// but confusion, so it is dropped. With nothing else to send it still goes: half an answer beats',
  '// silence, and the stand-in would claim the assistant had failed when it had not.',
  '// "Cut" = it ends on a letter, a digit or a comma-like mark. A sentence ending in . ! ? … ) or',
  '// an emoji is finished. No backslash on purpose: this body travels inside JSON twice.',
  "const CUT_ENDINGS = 'abcdefghijklmnopqrstuvwxyzàâäçéèêëîïôöùûüÿñãõáíóú0123456789,;:–—-';",
  'const looksCut = function (s) {',
  '  const t = String(s).trim();',
  '  if (!t) { return false; }',
  '  const last = t.charAt(t.length - 1).toLowerCase();',
  '  const code = last.charCodeAt(0);',
  '  return CUT_ENDINGS.indexOf(last) >= 0 || (code >= 0x0621 && code <= 0x064A);',
  '};',
  'const carriedElsewhere = toolReplyCount > 0 || cards.length > 0;',
  '// Punctuation left over from a removed sentence is not a sentence.',
  "const ownAnswer = (wordsOf(unrepeated).length > 0 && !(carriedElsewhere && looksCut(unrepeated))) ? unrepeated : '';",
  '',
].join('\n');
const NEW_COMPOSE = patch('compose agent reply', LIVE_COMPOSE, [[OWN_ANCHOR, OWN_NEW]]);

// ════════════════════════════════════════════════════════════════════════════════════════
//  BARGAIN — memory per haggle, and one bargaining answer per customer message
// ════════════════════════════════════════════════════════════════════════════════════════
const LIVE_MEMORY = nodeOf(BARGAIN, 'Bargain Memory').parameters;
// ⚠ The product as `pick variant` resolved it on OPEN, and as the flag carries it on every TURN —
// `set bargain flag` stores exactly `$('pick variant').first().json.productId`, so both modes
// name the same key. The model's own productId on open is NOT used: it may be absent (a
// variant-only call) and would then split one haggle across two keys.
const NEW_MEMORY_KEY = "=wi-mall:bargain-chat:{{ $('Inbound').first().json.channel }}:{{ $('Inbound').first().json.externalId }}:{{ ($('pick variant').isExecuted ? $('pick variant').first().json.productId : '') || $('Inbound').first().json.productId || $('Inbound').first().json.variantId || 'any' }}";
const NEW_MEMORY_WINDOW = 10;

const WAS_ANSWERED_CODE = [
  '// HAS THE BARGAINER ALREADY ANSWERED THIS VERY MESSAGE?',
  '//',
  '// `open_negotiation` is a TOOL, and a model may call a tool twice in one turn. Measured',
  '// 2026-09-22 (core exec 2258): one customer message opened TWO haggles -- the first for a product',
  '// from four hours earlier in the chat -- and because this workflow SENDS, the customer got two',
  '// bargaining answers, the first about the wrong product. `echo answered` records the message',
  '// every send answered; a second open for the SAME message is answered from here, sending nothing.',
  '// One customer message, at most one bargaining answer.',
  'const inbound = $(\'Inbound\').first().json || {};',
  'const item = $input.first().json || {};',
  'let already = false;',
  'try {',
  '  const echo = item.answeredEcho ? JSON.parse(String(item.answeredEcho)) : null;',
  '  already = !!echo',
  '    && String(echo.messageId || \'\') !== \'\'',
  '    && String(echo.messageId) === String(inbound.messageId || \'\')',
  '    && !!echo.expiresAt && new Date(echo.expiresAt).getTime() > Date.now();',
  '} catch (e) {',
  '  already = false;',
  '}',
  'return [{ json: Object.assign({}, item, { alreadyAnswered: already }) }];',
].join('\n');

const ANSWERED_ALREADY_CODE = [
  '// What the main agent is told when this message was already answered by an earlier open in the',
  '// same turn. The SAME allowlist `return to core` uses for an open -- three flags and no number --',
  '// with `alreadyAnswered: true`, so the core drops its own sentence exactly as after a real send.',
  'return [{ json: {',
  '  handled: true,',
  '  handBack: false,',
  '  verdict: \'none\',',
  '  lockIssued: false,',
  '  handedOver: true,',
  '  negotiable: true,',
  '  reason: \'already_answered\',',
  '  alreadyAnswered: true,',
  '} }];',
].join('\n');

const REDIS_CRED = nodeOf(BARGAIN, 'echo answered').credentials;
const ANSWERED_KEY = nodeOf(BARGAIN, 'echo answered').parameters.key;

// ════════════════════════════════════════════════════════════════════════════════════════
//  CHECKS
// ════════════════════════════════════════════════════════════════════════════════════════
const S1 = '§ 1 · the prompt';
check(S1, 'the base is the live prompt (05616e98)', String(CORE.versionId || '').startsWith('05616e98') || !!process.env.CORE_SNAPSHOT, CORE.versionId);
const liveLines = LIVE_PROMPT.split('\n');
const oldCheckoutLines = new Set(OLD_CHECKOUT.split('\n'));
const finalLines = NEW_PROMPT.split('\n');
let cursor = 0;
const lost = [];
for (const l of liveLines) {
  if (oldCheckoutLines.has(l)) continue; // the one section this change REPLACES
  const at = finalLines.indexOf(l, cursor);
  if (at === -1) lost.push(l.slice(0, 60)); else cursor = at + 1;
}
check(S1, 'every live line outside CHECKOUT survives, in order', lost.length === 0, lost.join(' | '));
check(S1, 'the n8n expressions are untouched (same {{ }} count)', (NEW_PROMPT.match(/\{\{/g) || []).length === (LIVE_PROMPT.match(/\{\{/g) || []).length);
check(S1, 'no backslash anywhere', !NEW_PROMPT.includes(String.fromCharCode(92)));
check(S1, 'it still ends as the live prompt ends', NEW_PROMPT.endsWith(LIVE_PROMPT.slice(-60)));
check(S1, 'size stays sane (live ' + LIVE_PROMPT.length + ', new ' + NEW_PROMPT.length + ')', NEW_PROMPT.length < 14000);
const order = ['## HAGGLING OVER PRICE', '## CHECKOUT', '## PAYMENT STATUS', '## ORDERS', '## RULES'];
const idx = order.map((h) => NEW_PROMPT.indexOf(h + '\n'));
check(S1, 'sections in order: haggling → checkout → payment status → orders → rules', idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), idx.join(','));
check(S1, '⭐ a tool that drew the confirmation is not narrated again', NEW_PROMPT.includes('the order summary and the question are sent to the customer for you'));
check(S1, '⭐ a question is not a yes', NEW_PROMPT.includes('A question is not a yes'));
check(S1, 'the place still needs the yes, and happens once', NEW_PROMPT.includes('Never call it without that yes, and never twice'));
check(S1, '⭐ waiting = patience, and never a second request', NEW_PROMPT.includes('kindly ask them to be patient') && NEW_PROMPT.includes('Never offer or send a new payment request while a payment is waiting'));
check(S1, '⛔ still never asks for an address or a phone number', NEW_PROMPT.includes('Never ask for a delivery address or a phone number'));
check(S1, '⭐ one open_negotiation per message, for the product that message is about', NEW_PROMPT.includes('Call it at most once for each message the customer sends'));
check(S1, '⭐ the history is not a to-do list', NEW_PROMPT.includes('Act on the customer\'s latest message'));
check(S1, 'every tool named in the new text is one the catalogue offers the model', (() => {
  const cat = require('../tools/catalog.json').tools;
  const offered = new Set(cat.filter((t) => t.tier !== 'flow_only' && t.status === 'available').map((t) => t.name));
  const text = NEW_CHECKOUT + HAGGLE_NEW + RULE_NEW;
  const named = [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => /_/.test(n) && !/^(checkout_ref|add_address_url)$/.test(n));
  const missing = [...new Set(named)].filter((n) => n !== 'open_negotiation' && !offered.has(n));
  return named.length >= 5 && missing.length === 0 || (console.log('     named', named.join(','), 'missing', missing.join(',')), false);
})());

// ── § 2 · compose agent reply ─────────────────────────────────────────────────────────────
const S2 = '§ 2 · a cut-off sentence';
const WA = '237600000001';
const MSG = 'wamid.sim-h2';
const bodyFor = (kind, text) => (kind === 'text'
  ? { messaging_product: 'whatsapp', to: WA, type: 'text', text: { body: text } }
  : { messaging_product: 'whatsapp', to: WA, type: 'interactive', interactive: { type: 'button', body: { text }, action: { buttons: [{ type: 'reply', reply: { id: 'x', title: 'Yes' } }] } } });
const step = (tool, envelope) => ({ action: { tool: 'wi_mall_MCP_' + tool }, observation: JSON.stringify([{ response: [{ type: 'text', text: JSON.stringify([envelope]) }] }]) });
function turn(composeBody, sc) {
  const steps = (sc.tools || []).map((t) => step(t.tool, Object.assign({ success: true, data: t.data || {} },
    t.text ? { reply: { channel: 'whatsapp', method: 'messages', body: bodyFor(t.kind || 'button', t.text) } } : {})));
  const echo = sc.cards ? JSON.stringify({ __messageId: MSG, expiresAt: new Date(Date.now() + 60000).toISOString(),
    replies: Array.from({ length: sc.cards }, (_, i) => ({ channel: 'whatsapp', method: 'messages', body: { type: 'image', image: { caption: 'Card ' + (i + 1) } } })) }) : null;
  if (sc.cards) steps.push({ action: { tool: 'Show-Products' }, observation: '{"shown":1}' });
  const nodes = {
    Inbound: [j({ channel: 'whatsapp', externalId: WA, messageId: MSG })],
    'sync identity': [j({ data: { fallback: { assistantUnavailable: 'Sorry, I could not answer that just now.' } } })],
    'check display': [j({ displayEcho: echo })],
    'AI Agent': [j({ output: sc.answer || '', intermediateSteps: steps })],
  };
  const composed = runCode(composeBody, { nodes, input: [j({})] });
  const dropped = runCode(LIVE_DROP, { nodes: Object.assign({}, nodes, { 'compose agent reply': composed }), input: [j({})] });
  return dropped.filter((i) => i.json.reply).map((i) => {
    const b = i.json.reply.body;
    return [i.json.role, (b.text && (b.text.body || b.text)) || (b.interactive && b.interactive.body && b.interactive.body.text) || (b.image && b.image.caption) || ''];
  });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CONFIRM = 'Please check your order: 2 × Digestive Biscuits — 200 XAF. Shall I place the order?';

const e2294 = { answer: 'Your order is 200 XAF,', tools: [{ tool: 'checkout_review', text: CONFIRM }] };
check(S2, 'the LIVE node sends the fragment beside the confirmation (the defect, once the server draws it)',
  same(turn(LIVE_COMPOSE, e2294), [['model', 'Your order is 200 XAF,'], ['tool', CONFIRM]]), JSON.stringify(turn(LIVE_COMPOSE, e2294)));
check(S2, '⭐ after: exec 2294 sends the confirmation alone', same(turn(NEW_COMPOSE, e2294), [['tool', CONFIRM]]), JSON.stringify(turn(NEW_COMPOSE, e2294)));
const CASES = [
  ['a finished lead-in is kept', { answer: 'Here is your order.', tools: [{ tool: 'checkout_review', text: CONFIRM }] }, [['model', 'Here is your order.'], ['tool', CONFIRM]]],
  ['a fragment beside product cards is dropped', { answer: 'Here are the', cards: 2 }, [['card', 'Card 1'], ['card', 'Card 2']]],
  ['a finished sentence beside cards is kept', { answer: 'Here is what we have.', cards: 1 }, [['model', 'Here is what we have.'], ['card', 'Card 1']]],
  ['⭐ a fragment with NOTHING else to send still goes (never silence)', { answer: 'The basket', tools: [{ tool: 'cart_get', data: { items: [] } }] }, [['model', 'The basket']]],
  ['an emoji ending is finished', { answer: 'Deal done 😊', tools: [{ tool: 'checkout_review', text: CONFIRM }] }, [['model', 'Deal done 😊'], ['tool', CONFIRM]]],
  ['a question is finished', { answer: 'Anything else?', tools: [{ tool: 'checkout_review', text: CONFIRM }] }, [['model', 'Anything else?'], ['tool', CONFIRM]]],
  ['French fragment ending on an accented letter is dropped', { answer: 'Votre commande est prête', tools: [{ tool: 'checkout_review', text: CONFIRM }] }, [['tool', CONFIRM]]],
  ['Arabic fragment ending on a letter is dropped', { answer: 'طلبك جاهز', tools: [{ tool: 'checkout_review', text: CONFIRM }] }, [['tool', CONFIRM]]],
  ['Arabic sentence with its question mark is kept', { answer: 'هل تريد شيئا آخر؟', tools: [{ tool: 'checkout_review', text: CONFIRM }] }, [['model', 'هل تريد شيئا آخر؟'], ['tool', CONFIRM]]],
  ['no tool message at all, so the fragment still goes', { answer: 'Your order is', tools: [] }, [['model', 'Your order is']]],
];
for (const [name, sc, want] of CASES) {
  const got = turn(NEW_COMPOSE, sc);
  check(S2, name, same(got, want), JSON.stringify(got));
}
check(S2, 'no backslash in the new body', !NEW_COMPOSE.includes(String.fromCharCode(92)));
check(S2, 'the change is one insertion at one anchor', NEW_COMPOSE.length > LIVE_COMPOSE.length && NEW_COMPOSE.startsWith(LIVE_COMPOSE.slice(0, LIVE_COMPOSE.indexOf(OWN_ANCHOR))));

// ── § 3 · the bargainer's memory key ──────────────────────────────────────────────────────
const S3 = '§ 3 · one memory per haggle';
const POWERBANK = '6ab1cf6ec274b2697c8ee0f6';
const BISCUITS = '6ab20f6119b322f9b93349b8';
const inb = (extra) => [j(Object.assign({ channel: 'whatsapp', externalId: WA, messageId: MSG, variantId: '', productId: '' }, extra))];
// A TEMPLATE (`=text{{ a }}text{{ b }}`), evaluated piece by piece exactly as n8n renders one —
// `evalExpr` takes a single `={{ … }}` only.
const keyOf = (expr, nodes) => {
  const body = String(expr).replace(/^=/, '');
  return body.replace(/\{\{([^]*?)\}\}/g, (all, inner) => String(evalExpr('={{' + inner + '}}', { nodes })));
};
const liveKeyA = keyOf(LIVE_MEMORY.sessionKey, { Inbound: inb({ productId: POWERBANK }) });
const liveKeyB = keyOf(LIVE_MEMORY.sessionKey, { Inbound: inb({ productId: BISCUITS }) });
check(S3, 'LIVE: the power bank and the biscuits share one memory (the defect)', liveKeyA === liveKeyB, liveKeyA + ' vs ' + liveKeyB);
const openKey = keyOf(NEW_MEMORY_KEY, { Inbound: inb({ mode: 'open', productId: '', variantId: 'v1' }), 'pick variant': [j({ ok: true, productId: BISCUITS, variantId: 'v1' })] });
const turnKey = keyOf(NEW_MEMORY_KEY, { Inbound: inb({ mode: 'turn', productId: BISCUITS, variantId: 'v1' }) });
const otherKey = keyOf(NEW_MEMORY_KEY, { Inbound: inb({ mode: 'turn', productId: POWERBANK, variantId: 'v9' }) });
check(S3, '⭐ open (model gave only a variant) and the next turn name the SAME key', openKey === turnKey, openKey + ' vs ' + turnKey);
check(S3, '⭐ a different product is a different memory', turnKey !== otherKey);
check(S3, 'the key is namespaced like every wi-mall key and carries the channel', turnKey === 'wi-mall:bargain-chat:whatsapp:' + WA + ':' + BISCUITS, turnKey);
check(S3, 'the window shrinks to ' + NEW_MEMORY_WINDOW + ' (live ' + LIVE_MEMORY.contextWindowLength + ')', NEW_MEMORY_WINDOW < LIVE_MEMORY.contextWindowLength);
check(S3, 'the TTL is left as it is (an hour)', LIVE_MEMORY.sessionTTL === 3600);

// ── § 4 · one bargaining answer per customer message ─────────────────────────────────────
const S4 = '§ 4 · one answer per message';
const echoOf = (messageId, minutes) => JSON.stringify({ messageId, expiresAt: new Date(Date.now() + minutes * 60000).toISOString() });
const was = (answeredEcho) => runCode(WAS_ANSWERED_CODE, { nodes: { Inbound: inb({ mode: 'open', productId: BISCUITS }) },
  input: [j({ mode: 'open', productId: BISCUITS, variantId: '', messageId: MSG, answeredEcho })] })[0].json;
check(S4, '⭐ the same message, answered a moment ago → already answered', was(echoOf(MSG, 9)).alreadyAnswered === true);
check(S4, 'a different (earlier) message → not answered', was(echoOf('wamid.earlier', 9)).alreadyAnswered === false);
check(S4, 'an expired echo → not answered', was(echoOf(MSG, -1)).alreadyAnswered === false);
check(S4, 'no echo → not answered', was(null).alreadyAnswered === false);
check(S4, 'garbage in the key → not answered, never a throw', was('{not json').alreadyAnswered === false);
check(S4, 'the item passes through intact for `resolve variant` ($json.productId)', was(null).productId === BISCUITS && was(null).mode === 'open');
const answeredOut = runCode(ANSWERED_ALREADY_CODE, { input: [j({})] })[0].json;
check(S4, 'the answer carries the open flags and alreadyAnswered', answeredOut.handedOver === true && answeredOut.alreadyAnswered === true && answeredOut.handled === true);
check(S4, '⛔ and not one number (the floor rule)', Object.values(answeredOut).every((v) => typeof v !== 'number'));
check(S4, 'it reads the key `echo answered` writes', /wi-mall:bargain:answered:/.test(ANSWERED_KEY));
check(S4, 'the Redis credential is the one every other Redis node here uses', !!(REDIS_CRED && REDIS_CRED.redis && REDIS_CRED.redis.id));

// ── § 5 · guard bites ─────────────────────────────────────────────────────────────────────
const S5 = '§ 5 · the guards bite';
const unguarded = NEW_COMPOSE.replace('!(carriedElsewhere && looksCut(unrepeated))', 'true');
check(S5, 'MUTANT applied (the guard expression was present)', unguarded !== NEW_COMPOSE);
check(S5, 'MUTANT — without the guard, 2294 sends the fragment again', !same(turn(unguarded, e2294), [['tool', CONFIRM]]));
const keyMutant = NEW_MEMORY_KEY.replace(/:\{\{ \(\$\('pick variant'\)[^]*$/, '');
check(S5, 'MUTANT — a key without the product shares memory again', keyOf(keyMutant, { Inbound: inb({ productId: BISCUITS }) }) === keyOf(keyMutant, { Inbound: inb({ productId: POWERBANK }) }) && keyMutant !== NEW_MEMORY_KEY);
const wasMutant = WAS_ANSWERED_CODE.replace("String(echo.messageId) === String(inbound.messageId || '')", 'true');
check(S5, 'MUTANT — a guard that ignores the message id blocks a NEW message', wasMutant !== WAS_ANSWERED_CODE
  && runCode(wasMutant, { nodes: { Inbound: inb({}) }, input: [j({ answeredEcho: echoOf('wamid.earlier', 9) })] })[0].json.alreadyAnswered === true);

const failed = report();

// ════════════════════════════════════════════════════════════════════════════════════════
//  OPERATIONS
// ════════════════════════════════════════════════════════════════════════════════════════
const CORE_OPS = [
  { type: 'setNodeParameter', nodeName: 'AI Agent', path: '/options/systemMessage', value: NEW_PROMPT },
  { type: 'setNodeParameter', nodeName: 'compose agent reply', path: '/jsCode', value: NEW_COMPOSE },
  { type: 'setNodeParameter', nodeName: 'Chat Memory', path: '/contextWindowLength', value: 6 },
  { type: 'setNodeParameter', nodeName: 'Chat Memory', path: '/sessionTTL', value: 7200 },
];
const BARGAIN_OPS = [
  { type: 'setNodeParameter', nodeName: 'Bargain Memory', path: '/sessionKey', value: NEW_MEMORY_KEY },
  { type: 'setNodeParameter', nodeName: 'Bargain Memory', path: '/contextWindowLength', value: NEW_MEMORY_WINDOW },
  { type: 'addNode', node: { name: 'read answered', type: 'n8n-nodes-base.redis', typeVersion: 1, position: [-1552, 432],
    credentials: REDIS_CRED,
    parameters: { operation: 'get', propertyName: 'answeredEcho', key: ANSWERED_KEY, keyType: 'string', options: { dotNotation: false } } } },
  { type: 'addNode', node: { name: 'was answered?', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-1328, 432],
    parameters: { jsCode: WAS_ANSWERED_CODE } } },
  { type: 'addNode', node: { name: 'answered already?', type: 'n8n-nodes-base.if', typeVersion: 2.3, position: [-1104, 432],
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 }, combinator: 'and',
      conditions: [{ id: 'already-answered', leftValue: '={{ $json.alreadyAnswered === true }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }] },
    looseTypeValidation: true, options: {} } } },
  { type: 'addNode', node: { name: 'answered already', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-880, 560],
    parameters: { jsCode: ANSWERED_ALREADY_CODE } } },
  { type: 'removeConnection', source: 'route mode', sourceIndex: 0, target: 'resolve variant', targetIndex: 0 },
  { type: 'addConnection', source: 'route mode', sourceIndex: 0, target: 'read answered', targetIndex: 0 },
  { type: 'addConnection', source: 'read answered', sourceIndex: 0, target: 'was answered?', targetIndex: 0 },
  { type: 'addConnection', source: 'was answered?', sourceIndex: 0, target: 'answered already?', targetIndex: 0 },
  { type: 'addConnection', source: 'answered already?', sourceIndex: 0, target: 'answered already', targetIndex: 0 },
  { type: 'addConnection', source: 'answered already?', sourceIndex: 1, target: 'resolve variant', targetIndex: 0 },
];

if (process.argv.includes('--write') && failed === 0) {
  const dir = path.join(__dirname, 'new');
  fs.writeFileSync(path.join(dir, 'h2_system_message.txt'), NEW_PROMPT);
  fs.writeFileSync(path.join(dir, 'h2_compose_agent_reply.txt'), NEW_COMPOSE);
  fs.writeFileSync(path.join(dir, 'h2_bargain_was_answered.txt'), WAS_ANSWERED_CODE);
  const opsDir = process.env.H2_OPS_DIR || dir;
  fs.writeFileSync(path.join(opsDir, 'h2-core-ops.json'), JSON.stringify(CORE_OPS, null, 1));
  fs.writeFileSync(path.join(opsDir, 'h2-bargain-ops.json'), JSON.stringify(BARGAIN_OPS, null, 1));
  console.log('wrote new/h2_*.txt and ' + CORE_OPS.length + ' + ' + BARGAIN_OPS.length + ' operations to ' + opsDir);
}
process.exit(failed === 0 ? 0 : 1);
