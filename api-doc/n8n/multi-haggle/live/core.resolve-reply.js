// WHICH EARLIER MESSAGE IS THE CUSTOMER REPLYING TO? -- and nothing more than that.
//
// Both channels let a customer press REPLY on a message and write underneath it. Until this
// node the quoted message was dropped by both adapters, so 'I mean this one' with a finger
// pointing up arrived as a sentence about nothing, and the model answered about whatever it
// remembered last (measured 2026-10-01: core 15964, the customer replied to the powerbank and
// the bot went on about shoes).
//
// The adapters put what the channel itself says on the envelope as `replyTo`:
//   Telegram -- the quoted TEXT (or caption), and whether the bot wrote it.
//   WhatsApp -- only the quoted message's ID. Meta never resends the text.
// So for WhatsApp the text is looked up in this chat's own journal (`recall journal`), which
// `journal turn` writes at the end of every turn: what the customer said and what was sent.
//
// It passes `sync identity`'s output through untouched, plus `_reply`, so every node after it
// that reads $json still sees the identity exactly as before. Readers of the note use
// $('resolve reply') BY NAME.
//
// URLs are cut out of the quoted text: some links this platform sends ARE credentials (sign-in,
// password reset, payment), and this text lands in a prompt and an execution log.
const inbound = $('Inbound').item.json;
const sync = $('sync identity').item.json;
const r = (inbound && inbound.replyTo && typeof inbound.replyTo === 'object') ? inbound.replyTo : null;

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

let reply = null;
if (r && r.messageId) {
  let quoted = clean(r.text, 600);
  let who = r.fromBot === true ? 'bot' : (r.fromBot === false ? 'customer' : '');
  if (!quoted) {
    let journal = [];
    try {
      const raw = $('recall journal').isExecuted ? $('recall journal').item.json.journal : null;
      journal = raw ? JSON.parse(String(raw)) : [];
    } catch (e) { journal = []; }
    const hit = Array.isArray(journal) ? journal.find(function (e) { return e && String(e.id) === String(r.messageId); }) : null;
    if (hit) {
      quoted = clean(hit.text, 600);
      who = hit.who || who;
    }
  }
  reply = { found: !!quoted, who: who, text: quoted };
}

return { json: Object.assign({}, sync, { _reply: reply }) };
