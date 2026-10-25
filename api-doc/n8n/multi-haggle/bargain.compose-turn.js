// THE TWO POSITIONS, AND THE WHOLE REASON THEY ARE SEPARATE.
//
// `playbook` goes into the model request's SYSTEM position, byte-identical on every turn
// of every conversation. Nothing is interpolated into it — not the customer, not the
// product, not a price — because Anthropic's prompt cache keys on an exact prefix, and a
// single interpolated character misses it. The playbook is ~17 000 characters; missing
// that cache on every turn multiplies the bill roughly tenfold for identical behaviour.
// Plan section 6, invariant 6.
//
// `userTurn` is everything that varies — and it is deliberately SMALL. The negotiation's
// own state (the window, the round, every prior offer, the durable profile) is NOT here:
// it arrives through the negotiation_context TOOL, which the playbook makes the first act
// of every turn. That is not only cheaper, it is what keeps the vendor's floor out of the
// shared chat transcript — n8n's chat memory persists the input and the output, and never
// the tool results.
const req = $('Inbound').first().json || {};
const res = $input.first().json || {};

const content = (res && res.success === true && res.data) ? String(res.data.content || '') : '';

if (!content) {
  // No playbook, no bargaining. Refusing here rather than improvising a system prompt is
  // the same call the backend makes when nothing is published: the turn hands back and
  // the customer is served at the asking price.
  return [{ json: { ok: false, playbook: '', userTurn: '' } }];
}

const quantity = Number(req.quantity) > 0 ? Math.trunc(Number(req.quantity)) : 1;

const lines = [];
lines.push('<negotiation_subject>');
lines.push('variantId: ' + String(req.variantId || ''));
lines.push('productId: ' + String(req.productId || ''));
lines.push('quantity: ' + String(quantity));
lines.push('</negotiation_subject>');
lines.push('');
lines.push('<customer>');
lines.push('language: ' + String(req.language || 'fr'));
lines.push('channel: ' + String(req.channel || ''));
lines.push('</customer>');
lines.push('');
lines.push('<routing>');
lines.push('You are handling this conversation for as long as it is about THIS product, its price, or closing this deal.');
lines.push('If the customer has moved on to something else entirely - another order, a delivery or payment problem, an account question, or a different product they have not asked you to price - reply with exactly #HANDBACK# and nothing else, and call no tool. The colleague who handles the rest of the shop picks it up from there.');
lines.push('That token is the only thing you may ever write that is not a message to the customer.');
lines.push('</routing>');
lines.push('');
// ⭐ SEVERAL ITEMS OPEN AT ONCE (owner, 2026-10-25). wi-mall-core picked the subject above -- from
// the message the customer replied to, or as the newest open item, which is only a GUESS -- and
// passes the whole list. Ids and public titles only; every price still comes from
// negotiation_context, per item. In OPEN mode the list is the one `merge flag (open)` just wrote.
let open = null;
try { open = req.openItems ? JSON.parse(String(req.openItems)) : null; } catch (e) { open = null; }
if (!open && $('merge flag (open)').isExecuted) {
  open = { pickedBy: 'latest', items: ($('merge flag (open)').first().json || {}).openItems || [] };
}
const openList = (open && Array.isArray(open.items)) ? open.items.filter(function (i) { return i && i.variantId; }) : [];
if (openList.length > 1) {
  const why = open.pickedBy === 'reply'
    ? 'the customer pressed REPLY on a message about it'
    : 'it is the item opened most recently - that is a GUESS, not something the customer said';
  lines.push('<open_haggles>');
  lines.push('This customer has ' + openList.length + ' items open for a price talk in this chat, newest first. Each one is its own haggle, with its own price:');
  openList.forEach(function (i) {
    lines.push('- ' + (i.title ? '"' + String(i.title) + '"' : '(name not given - get_product_details has it)') + ' · productId ' + String(i.productId || '') + ' · variantId ' + String(i.variantId));
  });
  lines.push('The subject above was chosen because ' + why + '.');
  lines.push('Before you name or judge ANY price, be sure which item this message is about: the product they name, what they describe, or the message they replied to.');
  lines.push('- If it is about another item in this list, work on THAT item: call negotiation_context with its variantId. Never carry an offer for one item over to another.');
  lines.push('- If you cannot tell which item they mean, ask which one in one short sentence, naming the items. Name no price, and do not call negotiation_record.');
  lines.push('- If they give ONE figure for several items together, do not split it yourself: say you agree a price for each item separately, and ask what they would pay for each one. Name no price.');
  lines.push('- An item in this list is never "a different product": do not answer #HANDBACK# for it.');
  lines.push('</open_haggles>');
  lines.push('');
}
lines.push('<customer_message>');
lines.push(String(req.text || ''));
lines.push('</customer_message>');

return [{ json: {
  ok: true,
  playbook: content,
  userTurn: lines.join('\n'),
  playbookVersion: res.data.version || null,
  playbookChecksum: res.data.checksum || null,
} }];