// THE SEND DECISION — AND D-4 IS ENFORCED HERE, NOT BY ASKING THE MODEL NICELY.
//
// The gate returns the approved sentence verbatim. What goes to the customer is THAT,
// read from the Redis echo, and not whatever the model happened to write as its final
// answer. So a price the cart could not honour is never spoken — even by a model that,
// having been refused, went on to say the refused number anyway.
//
// Five outcomes, and only two of them send anything:
//   approved       -> send the gate's sentence. A lock may have been minted with it, and
//                     a lock is the end of the haggle: execution (cart, address, payment)
//                     is the main agent's job and its tools.
//   revise (last)  -> send NOTHING, hand back. The model was refused and stopped without
//                     a valid re-draft. The session STAYS OPEN: one bad draft is not the
//                     end of a haggle, and the next message comes back here.
//   call_failed    -> the gate refused the CALL (session expired, unknown, variant no
//                     longer negotiable). Close the session and hand back.
//   no gate at all -> a turn with no price in it: a product question, a greeting, a
//                     delivery detail. The playbook routes those around the gate, so the
//                     model's own words go. #HANDBACK# means it has left the subject.
//   unavailable    -> no playbook, or the agent errored. Hand back with the session
//                     INTACT; the main agent serves this turn at the asking price, which
//                     is the plan's own designed degradation.
const inbound = $('Inbound').first().json || {};
const messageId = String(inbound.messageId || '');

let echo = null;
if ($('read gate echo').isExecuted) {
  const raw = $('read gate echo').first().json.gateEcho;
  if (raw) {
    try { echo = JSON.parse(String(raw)); } catch (e) { echo = null; }
  }
}
// A key left behind by an earlier turn is not this turn's verdict. The stamp is what lets
// the key be conversation-scoped instead of turn-scoped, which matters because the n8n
// Redis node cannot expire it: one key read-and-deleted beats one key per turn forever.
if (echo && String(echo.__messageId || '') !== messageId) { echo = null; }

let text = null;
// ⭐ THE GATE MAY NOW SEND A BODY RATHER THAN A SENTENCE. `data.outbound` is a channel-ready
// reply in the bot surface's own shape (same renderer), carrying the approved sentence PLUS
// one 'Lock it in' button, so a customer can accept by pressing instead of typing. It is a
// SIBLING of `data.reply`, never a replacement: `reply` keeps its exact meaning and value, and
// a gate that sends no `outbound` (a model-closed turn, a `revise` verdict) behaves as before.
//
// ⚠ D-4 is untouched. What goes out is still the GATE's words, never the model's -- this only
// changes whether they arrive as a plain message or as a message with a button.
let outbound = null;
let handBack = false;
let closeSession = false;
let lockIssued = false;
let verdict = 'none';

// THE AGREED PRICE, ON ITS WAY TO THE BASKET.
//
// The gate's `lock.ref` is a single-use claim on the price this customer just agreed. The
// bargaining MODEL never sees it (`shape tool result` strips it) and does not need it — it
// has no cart tools. wi-mall-core's main agent does: it is the one that fills the basket,
// and without the ref the customer is charged the shelf price and the whole negotiation is
// silently undone at the till.
//
// ⚠ It is bound server-side to (customer, variant, quantity), single-use, and re-validated
// when it is spent, so a leaked ref buys its own owner their own agreed price and nobody
// else anything. That is what makes it safe to hand across — strictly weaker than the
// botToken the same system prompt already carries.
let lockRef = null;
let lockUnitPrice = null;
let lockExpiresAt = null;

if (echo && echo.success === true && echo.data) {
  verdict = String(echo.data.verdict || '');
  if (verdict === 'approved') {
    text = String(echo.data.reply || '').trim();
    const ob = echo.data.outbound;
    if (ob && ob.channel && ob.method && ob.body) { outbound = ob; }
    lockIssued = !!echo.data.lock;
    closeSession = lockIssued;
    if (echo.data.lock) {
      lockRef = echo.data.lock.ref || null;
      lockUnitPrice = echo.data.lock.unitPrice != null ? echo.data.lock.unitPrice : null;
      lockExpiresAt = echo.data.lock.expiresAt || null;
    }
  } else {
    handBack = true;
  }
} else if (echo && echo.success !== true) {
  verdict = 'call_failed';
  handBack = true;
  closeSession = true;
} else if ($('Bargain Agent').isExecuted) {
  const agentJson = $('Bargain Agent').first().json || {};
  // The agent's ERROR output carries no `output` at all. Reading that as an empty answer
  // would end a negotiation the customer is still in the middle of, on the strength of a
  // model timeout, so it is a transient failure and the session survives it.
  if (agentJson.output === undefined || agentJson.output === null || agentJson.error !== undefined) {
    verdict = 'unavailable';
    handBack = true;
  } else {
    const out = String(agentJson.output).trim();
    if (out === '' || out === '#HANDBACK#') {
      verdict = 'handback';
      handBack = true;
      closeSession = true;
    } else {
      verdict = 'unpriced';
      text = out;
    }
  }
} else {
  verdict = 'unavailable';
  handBack = true;
}

if (text && text.length > 4000) { text = text.slice(0, 3997) + '…'; }

// ⭐ WHICH ITEM THIS TURN WAS ABOUT (2026-10-25, several items open at once). The agent may move
// to another open item inside a turn, so the envelope's variant is not necessarily the one a
// verdict closed. The gate now names it (`data.subject`); a backend from before that change
// does not, and the envelope is the fallback -- exactly the old behaviour.
let subject = null;
if (echo && echo.success === true && echo.data && echo.data.subject && echo.data.subject.variantId) {
  subject = echo.data.subject;
}
let pickedBy = '';
try { pickedBy = inbound.openItems ? String(JSON.parse(String(inbound.openItems)).pickedBy || '') : ''; } catch (e) { pickedBy = ''; }
const subjectVariantId = (subject && subject.variantId) || inbound.variantId || null;
const subjectProductId = (subject && subject.productId) || inbound.productId || null;
// What the message SENT is tagged with in core's reply journal, so a reply under it comes back to
// this item. Not when the item was only guessed and the gate did not confirm it: a "which one do
// you mean?" question is about no single item, and a wrong tag would route the answer wrongly.
const tagVariantId = subject ? subject.variantId : (pickedBy === 'latest' ? null : (inbound.variantId || null));

let reply = null;
if (outbound) {
  // Already rendered by the backend for this channel. Sent verbatim, like every other reply.
  reply = outbound;
} else if (text) {
  reply = inbound.channel === 'telegram'
    ? { channel: 'telegram', method: 'sendMessage', body: { chat_id: String(inbound.externalId), text: text } }
    : { channel: 'whatsapp', method: 'messages', body: {
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to: String(inbound.externalId), type: 'text', text: { body: text } } };
}

return [{ json: {
  handled: reply != null,
  handBack: handBack,
  closeSession: closeSession,
  lockIssued: lockIssued,
  verdict: verdict,
  reply: reply,
  lockRef: lockRef,
  lockUnitPrice: lockUnitPrice,
  lockExpiresAt: lockExpiresAt,
  // The line the lock is bound to: the gate's `subject` when it names one (2026-10-25), the
  // envelope otherwise. A wrong hint stays harmless: the server re-checks the binding and refuses
  // a mismatch, and the main agent is told to retry without the ref.
  lockVariantId: subjectVariantId,
  lockQuantity: (subject && Number(subject.quantity) > 0)
    ? Math.trunc(Number(subject.quantity))
    : (Number(inbound.quantity) > 0 ? Math.trunc(Number(inbound.quantity)) : 1),
  subjectVariantId: subjectVariantId,
  subjectProductId: subjectProductId,
  tagVariantId: tagVariantId,
  tagProductId: tagVariantId ? subjectProductId : null,
  // `#HANDBACK#` means the customer left the price talk altogether: every open item closes. Any
  // other close (a deal, a refused call) is about ONE item and the others stay open.
  closeScope: verdict === 'handback' ? 'all' : 'item',
} }];