// § 4.6 · the one-shot carry — a tap that ANSWERED but left a question open.
const { runCode, evalExpr, check, j } = require('./n8n-sim');
const { NEW, live } = require('./build-new');

const S46 = '§ 4.6 · the awaiting carry';
const ORDER = '68b0aa0000000000000000aa';
const TAP_MSG = 'cb-cancel';
const NEXT_MSG = 'm-next';
const inbound = (messageId, text) => ({ channel: 'telegram', externalId: '42', messageId, kind: 'text', text });

// ── which responses arm the carry ────────────────────────────────────────────
const arms = (data) => evalExpr(NEW['core:awaiting answer?'], { json: { success: true, data } }) === true;
check(S46, 'an order cancelled, reason outstanding → armed', arms({ cancelled: true, orderId: ORDER, orderNumber: 'ORD-1', awaitingCancellationReason: true }));
check(S46, 'a ticket Reply tap → armed by the SAME rule, no verb anywhere', arms({ ticketId: 't1', subject: 'x', status: 'open', awaitingReply: true }));
check(S46, '⭐ a flag nobody has invented yet → armed, so the next one needs no n8n edit', arms({ awaitingSomethingNew: true }));
for (const [name, data] of [
  ['an ordinary add to cart', { cartCount: 2 }],
  ['a tap with no data at all', undefined],
  ['a flag that is present but FALSE', { awaitingReply: false }],
  ['a key that merely mentions the word', { notAwaitingAnything: true, wasAwaiting: true }],
]) {
  check(S46, `${name} → not armed`, arms(data) === false, JSON.stringify(data));
}

// ── what is stored ───────────────────────────────────────────────────────────
const data = { cancelled: true, orderId: ORDER, orderNumber: 'ORD-2026-000123', awaitingCancellationReason: true };
const stored = JSON.parse(evalExpr(NEW['core:remember awaiting.value'], {
  nodes: { Inbound: [j(inbound(TAP_MSG, ''))] },
  json: { success: true, data },
}));
check(S46, 'the carry stores the data, the message it was written for, and an expiry',
  JSON.stringify(stored.data) === JSON.stringify(data) && stored.messageId === TAP_MSG && (new Date(stored.expiresAt) - Date.now()) / 60000 > 14, JSON.stringify(stored));

// ── what the assistant is asked on the NEXT turn ─────────────────────────────
const composeWith = (carryValue, messageId = NEXT_MSG, text = 'the shop never replied') => runCode(NEW['core:compose agent input'], {
  nodes: { Inbound: [j(inbound(messageId, text))], 'recall awaiting': [j({ awaitingCarry: carryValue })] },
  input: [j({})],
  mode: 'each',
})[0].json.agentInput;

const noted = composeWith(JSON.stringify(stored));
check(S46, 'the outstanding question reaches the assistant with the customer\'s words', /awaitingCancellationReason/.test(noted) && /the shop never replied/.test(noted), noted);
check(S46, 'and it is told to file it in the customer\'s OWN words', /in the customer’s own words/.test(noted));
check(S46, '⛔ and to ignore it entirely if this message does not answer it', /If it does not, ignore this entirely/.test(noted));
check(S46, '⛔ no token and no signed ref is carried — only the data', !/yes:cnc/.test(noted) && !/ref/.test(noted.replace(/never replied/, '')));

// ── the refusals ─────────────────────────────────────────────────────────────
const expired = JSON.stringify(Object.assign({}, stored, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
check(S46, 'an expired carry is ignored (the Redis node cannot expire it, so the value is the authority)', composeWith(expired) === 'the shop never replied');
check(S46, '⛔ a carry written for THIS message is ignored — that would be reading back the turn that wrote it', composeWith(JSON.stringify(stored), TAP_MSG) === 'the shop never replied');
check(S46, 'a malformed carry is ignored rather than throwing', composeWith('{not json') === 'the shop never replied');
check(S46, 'an empty carry (the normal case) changes nothing', composeWith(null) === 'the shop never replied');
check(S46, 'unchanged — a turn where the carry node never ran', runCode(NEW['core:compose agent input'], {
  nodes: { Inbound: [j(inbound(NEXT_MSG, 'hello'))] }, input: [j({})], mode: 'each',
})[0].json.agentInput === 'hello');
check(S46, 'unchanged against the LIVE node when there is no carry', composeWith(null) === runCode(live['compose agent input'].parameters.jsCode, {
  nodes: { Inbound: [j(inbound(NEXT_MSG, 'the shop never replied'))] }, input: [j({})], mode: 'each',
})[0].json.agentInput);

// ── ⭐ one turn, and only one ────────────────────────────────────────────────
// `forget awaiting` deletes unconditionally, so the SECOND message after the tap sees nothing.
// Modelled as the graph does it: read, delete, then the next turn reads an empty key.
let key = JSON.stringify(stored);
const turnOne = composeWith(key, 'm-1', 'sorry, wrong button');
key = null;                                   // forget awaiting, unconditional
const turnTwo = composeWith(key, 'm-2', 'anyway, where is my other order?');
check(S46, '⭐ the question is asked once: turn one carries it even when the answer is unrelated…', /awaitingCancellationReason/.test(turnOne));
check(S46, '…and turn two does not — a question can never come back two messages later', turnTwo === 'anyway, where is my other order?');

// guard bites: a carry that is not deleted would ask again
let bit = false;
const notForgotten = composeWith(JSON.stringify(stored), 'm-2', 'anyway, where is my other order?');
if (/awaitingCancellationReason/.test(notForgotten)) bit = true;
check(S46, 'guard bites — a carry left undeleted does ask again, which is the failure the delete prevents', bit);
