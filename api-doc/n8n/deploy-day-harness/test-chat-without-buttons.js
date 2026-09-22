// CHAT-SURFACES stream — the n8n half of "the assistant must survive without buttons" (2026-09-22).
//
// Run:  node test-chat-without-buttons.js        (no n8n, no network, no database)
//       exit code = number of failures
//
// What happened on the owner's handset (UP-wi-mall-core 754ad009, WhatsApp):
//   · exec 1942 — "Sho my orders". The model called `inapp_open_orders`; its reply was a cta_url
//     whose body read "Here are a few more." and the model ALSO wrote "Here are a few more." as its
//     own answer. `compose agent reply` emitted both; `drop duplicate reply` kept both.
//   · The backend sets no `replyStandsAlone` anywhere (the flag § 5.2 says is owed), so the live
//     node's one suppression path never fired — and nothing compared the two texts.
//
// This file BUILDS two changes from the live snapshot by anchored replacement, and proves them:
//   1. `compose agent reply` — a sentence of the model's that is a copy of a sentence a TOOL
//      prepared this turn is dropped. Nothing else the model said is touched.
//   2. the `AI Agent` system prompt — three rule blocks (orders in chat; typing replaces tapping;
//      never copy a tool's sentence). ⚠ The coordinator owns the core prompt and merges rules from
//      every stream; this file proves the text anchors cleanly and changes nothing else.
//
// ⚠ It does NOT edit build-live-fixes.js / test-live-fixes.js, and it writes nothing to n8n.
// ⚠ Every new body is BACKSLASH-FREE — checked below, because a backslash is the character that
// has gone missing on the trip into n8n before.
const fs = require('fs');
const path = require('path');
const { runCode, check, report, j } = require('./n8n-sim');

// ── the live snapshot ─────────────────────────────────────────────────────────
// The live version is not in this repository (it is the owner's deploy folder); the in-repo
// c36d16e7 snapshot holds a BYTE-IDENTICAL `compose agent reply` and `drop duplicate reply`
// (verified 2026-09-22, and re-verified below whenever both are present). The prompt changed
// between the two, so the prompt half REQUIRES the live file and is refused rather than skipped.
const LIVE_PATH = process.env.CORE_SNAPSHOT || 'C:/Users/Fante/Desktop/wi-mall-deploy/wi-mall-core-754ad009.json';
const INREPO_PATH = path.join(__dirname, 'live-core-c36d16e7.json');
const nodeOf = (wf, name) => (Array.isArray(wf.nodes) ? wf.nodes.find((n) => n.name === name) : wf.nodes[name]);

const haveLive = fs.existsSync(LIVE_PATH);
const LIVE = haveLive ? JSON.parse(fs.readFileSync(LIVE_PATH, 'utf8')) : null;
const INREPO = JSON.parse(fs.readFileSync(INREPO_PATH, 'utf8'));
const S0 = 'provenance';
check(S0, 'the live core snapshot is present (set CORE_SNAPSHOT to point at it)', haveLive, LIVE_PATH);
if (haveLive) {
  check(S0, 'it is version 754ad009 — the one the owner tested on', String(LIVE.versionId || '').startsWith('754ad009'), LIVE.versionId);
  for (const name of ['compose agent reply', 'drop duplicate reply']) {
    check(S0, `live \`${name}\` is byte-identical to the in-repo c36d16e7 copy`,
      nodeOf(LIVE, name).parameters.jsCode === nodeOf(INREPO, name).parameters.jsCode);
  }
}
const SOURCE = haveLive ? LIVE : INREPO;
const LIVE_COMPOSE = nodeOf(SOURCE, 'compose agent reply').parameters.jsCode;
const LIVE_DROP = nodeOf(SOURCE, 'drop duplicate reply').parameters.jsCode;

/** Exact, single-occurrence replacement — an anchor that misses or repeats is an error, never a no-op. */
function patch(label, src, pairs) {
  let out = src;
  for (const [from, to] of pairs) {
    const count = out.split(from).length - 1;
    if (count !== 1) { throw new Error(`${label}: anchor occurs ${count} times: ${JSON.stringify(from.slice(0, 60))}`); }
    out = out.replace(from, () => to);
  }
  return out;
}

// ── 1 · compose agent reply: a tool's sentence, typed again by the model, goes out once ─────
const DEDUPE = [
  '// ⭐ A TOOL\'S OWN SENTENCE, TYPED AGAIN BY THE MODEL, GOES OUT ONCE (chat-surfaces, 2026-09-22).',
  '// Core exec 1942: "Sho my orders" was answered by a button whose body read "Here are a few more.",',
  '// and the model, reading that body in its tool result, wrote "Here are a few more." as its whole',
  '// answer. Both were sent. The backend sets no `replyStandsAlone` on a door, and nothing here',
  '// compared the two texts.',
  '//',
  '// So each sentence of the model\'s is compared with the text of every message a TOOL prepared this',
  '// turn, and a sentence that IS one of them, or is a run of three or more of its words, is dropped.',
  '// Everything else the model said is kept: this never removes a sentence the tool did not say,',
  '// which is the failure `replyStandsAlone` stays off by default to avoid.',
  '//',
  '// ⚠ Exact copies only, after folding case, spacing and punctuation. A paraphrase is kept, and must',
  '// be: a paraphrase may carry something the tool\'s message does not.',
  '// ⚠ Char codes and character classes, not escapes: this body travels through JSON to reach n8n.',
  'const toolTextOf = function (body) {',
  '  if (!body || typeof body !== \'object\') { return \'\'; }',
  '  if (typeof body.text === \'string\') { return body.text; }',
  '  if (body.text && typeof body.text.body === \'string\') { return body.text.body; }',
  '  if (typeof body.caption === \'string\') { return body.caption; }',
  '  if (body.interactive && body.interactive.body && typeof body.interactive.body.text === \'string\') { return body.interactive.body.text; }',
  '  return \'\';',
  '};',
  'const wordsOf = function (s) {',
  '  const lower = String(s).toLowerCase();',
  '  let folded = \'\';',
  '  for (let i = 0; i < lower.length; i += 1) {',
  '    const code = lower.charCodeAt(i);',
  '    folded += (code <= 32 || code === 160) ? \' \' : lower.charAt(i);',
  '  }',
  '  return folded.replace(/[.,!?;:…"\'«»“”‘’*_~()¿¡،؟·—–-]/g, \' \').split(\' \').filter(function (w) { return w.length > 0; });',
  '};',
  'const containsRun = function (hay, needle) {',
  '  for (let i = 0; i + needle.length <= hay.length; i += 1) {',
  '    let same = true;',
  '    for (let k = 0; k < needle.length; k += 1) { if (hay[i + k] !== needle[k]) { same = false; break; } }',
  '    if (same) { return true; }',
  '  }',
  '  return false;',
  '};',
  'const toolSentences = toolMessages',
  '  .filter(function (m) { return !m.isDisplay && m.reply; })',
  '  .map(function (m) { return wordsOf(toolTextOf(m.reply.body)); })',
  '  .filter(function (w) { return w.length > 0; });',
  '// One shared word ("done", "yes") is never evidence of copying; the whole sentence or a run of three is.',
  'const isCopy = function (piece) {',
  '  const words = wordsOf(piece);',
  '  if (words.length === 0) { return false; }',
  '  return toolSentences.some(function (t) {',
  '    return (words.length === t.length || words.length >= 3) && containsRun(t, words);',
  '  });',
  '};',
  'const pieces = toolSentences.length > 0 ? (answer.match(/[^.!?…؟]+[.!?…؟]*/g) || []) : [];',
  'const keptPieces = pieces.filter(function (p) { return !isCopy(p); });',
  'const unrepeated = keptPieces.length === pieces.length ? answer : keptPieces.join(\'\').trim();',
  '// Punctuation left over from a removed sentence is not a sentence.',
  'const ownAnswer = wordsOf(unrepeated).length > 0 ? unrepeated : \'\';',
  '',
].join('\n');

const COMPOSE_ANCHOR = 'const chosen = plainFor(answer || standIn);\n';
const NEW_COMPOSE = patch('compose agent reply', LIVE_COMPOSE, [
  [COMPOSE_ANCHOR, DEDUPE + 'const chosen = plainFor(ownAnswer || standIn);\n'],
]);

// ── 2 · the prompt: three rule blocks ────────────────────────────────────────
const RULE_ORDERS =
  '## ORDERS\n' +
  'When the customer asks to see, show or check their orders ("my orders", "show my orders", "what have I bought", "did my order go through"), call `orders_list_groups`. It draws their five most recent orders in the chat as a list they can pick from, with a Load more row that opens the rest. Write one short line or nothing, and ⛔ never type the orders out yourself.\n' +
  'Call `inapp_open_orders` only when they ask for ALL their orders or older ones, or for more than the list showed. It is never the first answer to "show my orders".\n\n';
const RULE_TYPING =
  '## WHEN THE CUSTOMER TYPES INSTEAD OF TAPPING\n' +
  'Anything a button offers, the customer may ask for in words instead: "add the second one", "show me that one", "the blue one", "track it". Do it with your tools exactly as if they had tapped. Never tell them they have to tap a button, and never say you cannot do something a button can do. If none of your tools can do it, say plainly that you cannot do that from here yet, and do not invent a way.\n' +
  'When they say to use the address or phone number already on their account, that is what happens: never ask them to type it again, and never say you cannot use it.\n\n';
const RULE_NO_COPY =
  '- ⛔ Never copy a sentence out of a tool\'s answer, not even as your only line. When its message says it all, write nothing.\n';

const PROMPT_LIVE = haveLive ? nodeOf(LIVE, 'AI Agent').parameters.options.systemMessage : null;
const MSG_HEADING = '## MESSAGES YOUR TOOLS SEND\n';
const RULES_HEADING = '## RULES\n';
const LEAD_BULLET = '- Write at most ONE short line leading into it, or nothing at all.\n';
const NEW_PROMPT = PROMPT_LIVE && patch('systemMessage', PROMPT_LIVE, [
  [MSG_HEADING, RULE_ORDERS + MSG_HEADING],
  [LEAD_BULLET, LEAD_BULLET + RULE_NO_COPY],
  [RULES_HEADING, RULE_TYPING + RULES_HEADING],
]);

// ── the scenario runner ──────────────────────────────────────────────────────
const MSG = 'wamid.cs1';
const TG = '900000001';
const WA = '237600000001';

/** A channel-ready body with `text`, the way the backend renders it for each channel. */
function bodyFor(channel, kind, text) {
  if (channel === 'telegram') {
    return kind === 'button'
      ? { chat_id: TG, text, reply_markup: { inline_keyboard: [[{ text: 'See all', web_app: { url: 'https://api.test/s/ol/ia_x' } }]] } }
      : { chat_id: TG, text };
  }
  return kind === 'button'
    ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: WA, type: 'interactive',
      interactive: { type: 'cta_url', body: { text }, action: { name: 'cta_url', parameters: { display_text: 'See all', url: 'https://api.test/s/ol/ia_x' } } } }
    : { messaging_product: 'whatsapp', recipient_type: 'individual', to: WA, type: 'text', text: { body: text } };
}

/** One MCP tool call's intermediate step — JSON inside JSON, exactly as § 5.2 read it from n8n's source. */
function step(tool, envelope) {
  return { action: { tool: `wi_mall_MCP_${tool}` }, observation: JSON.stringify([{ response: [{ type: 'text', text: JSON.stringify([envelope]) }] }]) };
}

/**
 * What the customer receives, as [role, text] pairs, from `compose agent reply` then
 * `drop duplicate reply` — the two nodes between the agent and the send loop.
 */
function turn(composeBody, sc) {
  const channel = sc.channel || 'whatsapp';
  const inbound = { channel, externalId: channel === 'telegram' ? TG : WA, messageId: MSG };
  const steps = (sc.tools || []).map((t) => step(t.tool, {
    success: t.success !== false,
    data: t.data || {},
    reply: { channel, method: channel === 'telegram' ? 'sendMessage' : 'messages', body: bodyFor(channel, t.kind || 'button', t.text) },
    ...(t.standsAlone ? { replyStandsAlone: true } : {}),
  }));
  const echo = sc.cards ? JSON.stringify({ __messageId: MSG, expiresAt: new Date(Date.now() + 60000).toISOString(),
    replies: Array.from({ length: sc.cards }, (_, i) => ({ channel, method: 'sendPhoto', body: { chat_id: TG, photo: 'x', caption: `Card ${i + 1}` } })) }) : null;
  if (sc.cards) { steps.push({ action: { tool: 'Show-Products' }, observation: '{"shown":1}' }); }
  const nodes = {
    Inbound: [j(inbound)],
    'sync identity': [j({ data: { fallback: { assistantUnavailable: 'Sorry, I could not answer that just now.' } } })],
    'check display': [j({ displayEcho: echo })],
    'AI Agent': [j({ output: sc.answer || '', intermediateSteps: steps })],
  };
  const composed = runCode(composeBody, { nodes, input: [j({})] });
  const dropped = runCode(LIVE_DROP, { nodes: Object.assign({}, nodes, { 'compose agent reply': composed }), input: [j({})] });
  return dropped
    .filter((i) => i.json.reply)
    .map((i) => {
      const b = i.json.reply.body;
      const text = (b.text && (b.text.body || b.text)) || b.caption || (b.interactive && b.interactive.body && b.interactive.body.text) || '';
      return [i.json.role, text];
    });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── § A · the owner's turn ───────────────────────────────────────────────────
const SA = '§ A · exec 1942, replayed';
const E1942 = { answer: 'Here are a few more.', tools: [{ tool: 'inapp_open_orders', text: 'Here are a few more.', data: { opened: 'orders' } }] };
const live1942 = turn(LIVE_COMPOSE, E1942);
check(SA, 'the LIVE nodes reproduce the defect: the same sentence goes out twice',
  same(live1942, [['model', 'Here are a few more.'], ['tool', 'Here are a few more.']]), JSON.stringify(live1942));
const new1942 = turn(NEW_COMPOSE, E1942);
const pass1942 = same(new1942, [['tool', 'Here are a few more.']]);
check(SA, '⭐ after: the customer gets the door once, with its button', pass1942, JSON.stringify(new1942));

const E1942b = { answer: 'Tap below to see all your orders.', tools: [{ tool: 'inapp_open_orders', text: 'Tap below to see all your orders.' }] };
const newB = turn(NEW_COMPOSE, E1942b);
check(SA, 'and with the backend\'s corrected sentence, a copy of THAT is dropped too',
  same(newB, [['tool', 'Tap below to see all your orders.']]), JSON.stringify(newB));

// ── § B · what is dropped, and what is kept ──────────────────────────────────
const SB = '§ B · only the copy goes';
const CASES = [
  ['a lead-in before the copy is kept', { answer: 'Sure! Here are a few more.', tools: [{ tool: 'inapp_open_orders', text: 'Here are a few more.' }] },
    [['model', 'Sure!'], ['tool', 'Here are a few more.']]],
  ['⭐ the answer to the OTHER half of the question is kept', { answer: 'Yes, it comes in blue. Tap below to see them with pictures and prices.', tools: [{ tool: 'inapp_open_product', text: 'Tap below to see them with pictures and prices.' }] },
    [['model', 'Yes, it comes in blue.'], ['tool', 'Tap below to see them with pictures and prices.']]],
  ['case, spacing and punctuation do not hide a copy', { answer: 'here are   a FEW more', tools: [{ tool: 'inapp_open_orders', text: 'Here are a few more.' }] },
    [['tool', 'Here are a few more.']]],
  ['markdown stars do not hide a copy', { answer: '**Here are a few more.**', tools: [{ tool: 'inapp_open_orders', text: 'Here are a few more.' }] },
    [['tool', 'Here are a few more.']]],
  ['a run of three words out of a longer tool sentence is a copy', { answer: 'This cannot be undone.', tools: [{ tool: 'account_close_preview', text: 'Closing your account removes your details. This cannot be undone.' }] },
    [['tool', 'Closing your account removes your details. This cannot be undone.']]],
  ['a one-word answer that happens to be in the tool\'s sentence is KEPT', { answer: 'Done.', tools: [{ tool: 'cart_add_item', kind: 'text', text: 'Done — it is in your basket.' }] },
    [['model', 'Done.'], ['tool', 'Done — it is in your basket.']]],
  ['a two-word fragment is KEPT (never evidence enough)', { answer: 'Your orders.', tools: [{ tool: 'orders_list_groups', text: 'Which of your orders would you like to see?' }] },
    [['model', 'Your orders.'], ['tool', 'Which of your orders would you like to see?']]],
  // ⚠ A stated limit, not an accident: cutting a copy out of the MIDDLE of a sentence would garble it.
  ['a copy embedded inside a longer sentence is KEPT (never garble a sentence)', { answer: 'Sure, here are a few more.', tools: [{ tool: 'inapp_open_orders', text: 'Here are a few more.' }] },
    [['model', 'Sure, here are a few more.'], ['tool', 'Here are a few more.']]],
  ['a paraphrase is KEPT', { answer: 'Here are some more of your orders.', tools: [{ tool: 'inapp_open_orders', text: 'Here are a few more.' }] },
    [['model', 'Here are some more of your orders.'], ['tool', 'Here are a few more.']]],
  ['French, with its own punctuation', { answer: 'Bien sûr ! Appuyez ci-dessous pour voir toutes vos commandes.', tools: [{ tool: 'inapp_open_orders', text: 'Appuyez ci-dessous pour voir toutes vos commandes.' }] },
    [['model', 'Bien sûr !'], ['tool', 'Appuyez ci-dessous pour voir toutes vos commandes.']]],
  ['Arabic, with its own question mark', { answer: 'اضغط أدناه لرؤية جميع طلباتك.', tools: [{ tool: 'inapp_open_orders', text: 'اضغط أدناه لرؤية جميع طلباتك.' }] },
    [['tool', 'اضغط أدناه لرؤية جميع طلباتك.']]],
  ['Telegram: a copy of a web_app door is dropped', { channel: 'telegram', answer: 'Here are a few more.', tools: [{ tool: 'inapp_open_orders', text: 'Here are a few more.' }] },
    [['tool', 'Here are a few more.']]],
  ['a copy of ONE of two tool messages is dropped; the rest stays in call order', { answer: 'Which order would you like to see?', tools: [
    { tool: 'orders_list_groups', text: 'Which order would you like to see?' }, { tool: 'inapp_open_orders', text: 'Tap below to see all your orders.' }] },
    [['tool', 'Which order would you like to see?'], ['tool', 'Tap below to see all your orders.']]],
  ['a FAILED tool\'s text never suppresses the model (nothing was sent for it)', { answer: 'Here are a few more.', tools: [{ tool: 'inapp_open_orders', success: false, text: 'Here are a few more.' }] },
    [['model', 'Here are a few more.']]],
  ['`replyStandsAlone` still suppresses the whole sentence, exactly as live', { answer: 'Closing is permanent — are you sure?', tools: [{ tool: 'account_close_preview', standsAlone: true, text: 'Closing your account cannot be undone.' }] },
    [['tool', 'Closing your account cannot be undone.']]],
  ['cards keep their place after a dropped copy', { answer: 'Here is what we have.', cards: 2, tools: [{ tool: 'inapp_open_listing', text: 'Here is what we have.' }] },
    [['tool', 'Here is what we have.'], ['card', 'Card 1'], ['card', 'Card 2']]],
];
const baseline = {};
for (const [name, sc, want] of CASES) {
  const got = turn(NEW_COMPOSE, sc);
  baseline[name] = same(got, want);
  check(SB, name, baseline[name], `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── § C · equivalence: where nothing is copied, NOTHING changes ──────────────
const SC = '§ C · no copy → byte-identical to live';
const EQUIV = [
  ['no tool at all', { answer: 'Hello! How can I help?' }],
  ['no tool, WhatsApp markdown', { answer: 'Your request is **Closed**.' }],
  ['no tool, Telegram', { channel: 'telegram', answer: 'Here are a few more.' }],
  ['a tool message the model did not copy', { answer: 'Here you go.', tools: [{ tool: 'orders_list_groups', text: 'Which order would you like to see?' }] }],
  ['the model silent, a tool message', { answer: '', tools: [{ tool: 'inapp_open_product', text: 'Tap below to see them with pictures and prices.' }] }],
  ['nothing at all — the stand-in', { answer: '' }],
  ['cards and a sentence', { answer: 'Look at these.', cards: 3 }],
  ['a number with a decimal point, and a tool', { answer: 'It costs 20.000 XAF.', tools: [{ tool: 'cart_add_item', kind: 'text', text: 'Added to your basket.' }] }],
];
for (const [name, sc] of EQUIV) {
  const a = turn(LIVE_COMPOSE, sc);
  const b = turn(NEW_COMPOSE, sc);
  check(SC, name, same(a, b), `live ${JSON.stringify(a)} · new ${JSON.stringify(b)}`);
}

// ── § D · guard bites — each mutant must APPLY, COMPILE and flip a check that PASSED ─────
const SD = '§ D · guard bites';
function mutant(label, from, to, wasPassing, probe) {
  const count = NEW_COMPOSE.split(from).length - 1;
  if (count !== 1) { check(SD, `${label} — mutant did not apply (anchor x${count})`, false); return; }
  const m = NEW_COMPOSE.replace(from, () => to);
  let ok;
  try { ok = probe(m); } catch (e) { check(SD, `${label} — mutant crashed instead of failing: ${e.message}`, false); return; }
  check(SD, `guard bites — ${label}`, wasPassing === true && ok === false, `baseline passing=${wasPassing}, mutant passing=${ok}`);
}
const caseProbe = (name) => (m) => {
  const [, sc, want] = CASES.find(([n]) => n === name);
  return same(turn(m, sc), want);
};
mutant('the comparison removed (the live behaviour)',
  'const chosen = plainFor(ownAnswer || standIn);', 'const chosen = plainFor(answer || standIn);',
  pass1942, (m) => same(turn(m, E1942), [['tool', 'Here are a few more.']]));
mutant('the whole answer compared instead of each sentence',
  "const pieces = toolSentences.length > 0 ? (answer.match(/[^.!?…؟]+[.!?…؟]*/g) || []) : [];",
  'const pieces = toolSentences.length > 0 ? [answer] : [];',
  baseline['a lead-in before the copy is kept'], caseProbe('a lead-in before the copy is kept'));
mutant('any shared word counted as a copy',
  '(words.length === t.length || words.length >= 3)', '(words.length >= 1)',
  baseline['a one-word answer that happens to be in the tool\'s sentence is KEPT'], caseProbe('a one-word answer that happens to be in the tool\'s sentence is KEPT'));
mutant('a match anywhere suppresses the whole answer (a hidden standsAlone)',
  "const unrepeated = keptPieces.length === pieces.length ? answer : keptPieces.join('').trim();",
  "const unrepeated = keptPieces.length === pieces.length ? answer : '';",
  baseline['⭐ the answer to the OTHER half of the question is kept'], caseProbe('⭐ the answer to the OTHER half of the question is kept'));
mutant('markdown stars not folded',
  "/[.,!?;:…\"'«»“”‘’*_~()¿¡،؟·—–-]/g", "/[.,!?;:…\"'«»“”‘’_~()¿¡،؟·—–-]/g",
  baseline['markdown stars do not hide a copy'], caseProbe('markdown stars do not hide a copy'));

// ── § E · the prompt ─────────────────────────────────────────────────────────
const SE = '§ E · the prompt rules (the coordinator merges them)';
if (!NEW_PROMPT) {
  check(SE, 'the live prompt is needed for this section and is not present — REFUSED, not skipped', false, LIVE_PATH);
} else {
  const exprCount = (s) => s.split('{{').length - 1;
  check(SE, 'still an n8n expression (leading =)', NEW_PROMPT.startsWith('='));
  check(SE, 'no expression added or lost', exprCount(NEW_PROMPT) === exprCount(PROMPT_LIVE), `${exprCount(PROMPT_LIVE)} -> ${exprCount(NEW_PROMPT)}`);
  const restored = NEW_PROMPT.replace(RULE_ORDERS, '').replace(RULE_NO_COPY, '').replace(RULE_TYPING, '');
  check(SE, 'removing the three insertions gives back the live prompt byte for byte', restored === PROMPT_LIVE);
  check(SE, 'ORDERS sits before MESSAGES YOUR TOOLS SEND; TYPING sits immediately before RULES',
    NEW_PROMPT.indexOf('## ORDERS\n') < NEW_PROMPT.indexOf(MSG_HEADING)
    && NEW_PROMPT.indexOf(RULE_TYPING + RULES_HEADING) > NEW_PROMPT.indexOf(MSG_HEADING));
  check(SE, 'it names the chat list as the FIRST answer and the screen as the second',
    RULE_ORDERS.includes('call `orders_list_groups`') && RULE_ORDERS.includes('never the first answer'));
  check(SE, 'the no-copy rule sits inside MESSAGES YOUR TOOLS SEND, under the lead-in rule',
    NEW_PROMPT.includes(LEAD_BULLET + RULE_NO_COPY)
    && NEW_PROMPT.indexOf(RULE_NO_COPY) > NEW_PROMPT.indexOf(MSG_HEADING)
    && NEW_PROMPT.indexOf(RULE_NO_COPY) < NEW_PROMPT.indexOf(RULES_HEADING));
  // A rule naming a tool the model is not given is a rule it can only break. The names are READ
  // out of the rule text and each must be a model-callable, available tool in the catalogue.
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'catalog.json'), 'utf8'));
  const named = (RULE_ORDERS + RULE_TYPING + RULE_NO_COPY).match(/`[a-z_]+`/g) || [];
  const callable = (name) => catalog.tools.some((t) => t.name === name && t.status === 'available'
    && t.tier !== 'flow_only' && t.surface !== 'webhook_command');
  check(SE, 'every tool the rules name is one the model is actually given',
    named.length === 2 && named.every((n) => callable(n.slice(1, -1))), named.join(' '));
}

// ── § F · the bodies are safe to carry into n8n ──────────────────────────────
const SF = '§ F · carriable';
const BS = String.fromCharCode(92);
check(SF, 'the live body had no backslash, and the new one still has none', !LIVE_COMPOSE.includes(BS) && !NEW_COMPOSE.includes(BS),
  `live ${LIVE_COMPOSE.split(BS).length - 1}, new ${NEW_COMPOSE.split(BS).length - 1}`);
check(SF, 'the inserted code itself is backslash-free', !DEDUPE.includes(BS));
if (NEW_PROMPT) { check(SF, 'the inserted prompt text is backslash-free', ![RULE_ORDERS, RULE_TYPING, RULE_NO_COPY].some((s) => s.includes(BS))); }
check(SF, 'the new body still compiles as a Code node', (() => { try { new Function('$', '$input', '$json', '$now', NEW_COMPOSE); return true; } catch (e) { return false; } })());

module.exports = { NEW_COMPOSE, NEW_PROMPT, RULE_ORDERS, RULE_TYPING, RULE_NO_COPY, DEDUPE, COMPOSE_ANCHOR };

if (require.main === module) {
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.join(__dirname, 'new'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'new', 'chat_compose_agent_reply.txt'), NEW_COMPOSE);
    if (NEW_PROMPT) { fs.writeFileSync(path.join(__dirname, 'new', 'chat_system_message.txt'), NEW_PROMPT); }
  }
  process.exitCode = report();
}
