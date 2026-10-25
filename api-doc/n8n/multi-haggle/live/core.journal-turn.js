// WHAT WAS SAID IN THIS CHAT, BY MESSAGE ID -- so a WhatsApp reply can be resolved later.
//
// WhatsApp tells us only the ID of a message the customer replies to (`context.id`), never its
// text, and nothing else in the platform keeps a map from Meta's message ids to what they said.
// So the end of every turn appends to one key per chat: the customer's message (Inbound's own
// id) and every message `send loop` delivered (the id Meta or Telegram answered with, paired
// with the body `expand replies` produced, in the same order -- the loop is batch size 1).
//
// ⚠ ONE key per chat, bounded: the last 30 entries and nothing older than 48 hours. The n8n Redis
// node's `set` exposes no TTL, so a key per message would never expire; this one is overwritten
// in place and never grows.
//
// ⚠ Reached from `send loop` (done), from `bargain handled?`, and -- since 2026-10-05 -- from
// `send guard`'s FALSE branch: a turn whose only sentence was suppressed because the bargainer
// had already spoken used to end there and journal NOTHING, not even the customer's message.
// Never fails the turn: the reply is already sent.
//
// ⭐ The BARGAINER's messages are journaled too (2026-10-05). It sends its own reply, so it never
// passes the send loop, and until this change a reply to a haggling message ('How many are you
// taking?' -> '4') resolved as 'no longer available' and the model asked (core 22471, the
// message bargain 22360 sent). See the block after the customer's message below.
//
// URLs are replaced by [link] before storing, for the reason `resolve reply` gives.
const inbound = $('Inbound').first().json;
const MAX = 30;
const KEEP_MS = 48 * 60 * 60 * 1000;
const now = Date.now();

// Written with no backslashes on purpose: they do not survive the trip into a node body.
function clean(s, max) {
  let out = '';
  let space = false;
  for (const ch of String(s || '')) {
    if (ch.charCodeAt(0) <= 32) {
      if (!space) { out += ' '; }
      space = true;
    } else {
      out += ch;
      space = false;
    }
  }
  return out.trim().split(' ')
    .map(function (w) { return /^https?:[/][/]/i.test(w) ? '[link]' : w; })
    .join(' ').slice(0, max);
}

function textOf(b) {
  if (!b || typeof b !== 'object') return '';
  if (b.text && typeof b.text === 'object') return String(b.text.body || '');
  if (typeof b.text === 'string') return b.text;
  if (typeof b.caption === 'string') return b.caption;
  const it = b.interactive;
  if (it && typeof it === 'object') {
    const parts = [];
    if (it.header && it.header.text) parts.push(it.header.text);
    if (it.body && it.body.text) parts.push(it.body.text);
    const a = it.action || {};
    const buttons = (a.buttons || []).map(function (x) { return x && x.reply && x.reply.title; }).filter(Boolean);
    if (buttons.length) parts.push('[buttons: ' + buttons.join(' | ') + ']');
    const rows = [];
    (a.sections || []).forEach(function (s) { (s.rows || []).forEach(function (row) { if (row && row.title) rows.push(row.title); }); });
    if (rows.length) parts.push('[options: ' + rows.join(' | ') + ']');
    return parts.join(' ');
  }
  if (b.image) return b.image.caption || '[a picture]';
  if (b.document) return b.document.caption || '[a document]';
  if (b.template) return '[template ' + String(b.template.name || '') + ']';
  return '';
}

let journal = [];
try {
  const raw = $('recall journal').isExecuted ? $('recall journal').first().json.journal : null;
  journal = raw ? JSON.parse(String(raw)) : [];
} catch (e) { journal = []; }
if (!Array.isArray(journal)) journal = [];

const at = new Date(now).toISOString();
function add(id, who, text) {
  const t = clean(text, 400);
  // One entry per message id: the bargainer's message can be reported by two routes.
  if (id && journal.some(function (e) { return e && String(e.id) === String(id); })) return;
  if (id && t) journal.push({ id: String(id), who: who, text: t, at: at });
}

// The customer's own message. A tap is not something they wrote.
if (inbound.kind !== 'token') {
  const typed = String(inbound.text || '').trim();
  add(inbound.messageId, 'customer', typed || (inbound.kind === 'media' ? '[a file]' : ''));
}

// What the BARGAINER sent this turn. Two routes, one per mode, and both carry { id, body }:
//   turn -- `hand to bargainer`'s return value has `sent` (wi-mall-bargain `return to core`).
//   open -- the open_negotiation tool's return value goes to the MAIN AGENT, so by design it
//           carries no text; the same pairs ride `echo answered` in Redis, read here through
//           `read bargain echo`, and only when stamped with THIS message (the key outlives a
//           turn by up to ten minutes, and a turn-mode run never clears it).
// What is filed is the sentence the customer RECEIVED, already approved by the gate -- never
// the window (negotiation-tools.md forbids forwarding `window.floor`; nothing here reads it).
const bargainSent = [];
try {
  if ($('hand to bargainer').isExecuted) {
    const s = ($('hand to bargainer').first().json || {}).sent;
    if (Array.isArray(s)) s.forEach(function (x) { bargainSent.push(x); });
  }
} catch (e) { /* the bargainer's error branch carries nothing to journal */ }
if ($('read bargain echo').isExecuted) {
  try {
    const raw = ($('read bargain echo').first().json || {}).bargainAnswered;
    const echo = raw ? JSON.parse(String(raw)) : null;
    if (echo && String(echo.messageId) === String(inbound.messageId) && Array.isArray(echo.sent)) {
      echo.sent.forEach(function (x) { bargainSent.push(x); });
    }
  } catch (e) { /* a malformed echo journals nothing */ }
}
bargainSent.forEach(function (x) { if (x && x.id) add(x.id, 'bot', textOf(x.body)); });

// What was delivered this turn, when this run came through the send loop.
if ($('send loop').isExecuted && $('expand replies').isExecuted) {
  const sent = $input.all();
  const asked = $('expand replies').all();
  for (let i = 0; i < sent.length && i < asked.length; i++) {
    const res = sent[i].json || {};
    const reply = asked[i].json && asked[i].json.reply;
    if (!reply) continue;
    const id = inbound.channel === 'telegram'
      ? (res.result && res.result.message_id)
      : (res.messages && res.messages[0] && res.messages[0].id);
    add(id, 'bot', textOf(reply.body));
  }
}

journal = journal
  .filter(function (e) { const t = Date.parse(e && e.at); return isFinite(t) && now - t < KEEP_MS; })
  .slice(-MAX);

return [{ json: { journal: JSON.stringify(journal) } }];
