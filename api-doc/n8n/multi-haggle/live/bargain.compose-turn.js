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