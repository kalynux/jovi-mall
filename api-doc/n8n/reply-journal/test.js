// Offline proofs for the bargainer → reply-journal change (2026-10-05). No n8n, no Redis.
//   node test.js          exit code = number of failures
//
// The live defect: core 22471. The customer pressed REPLY on the bargainer's
// "… How many are you taking?" (sent by bargain 22360) and typed "4"; the message was never
// journaled, so `resolve reply` found nothing and the bot asked "which message?".
const fs = require('fs');
const path = require('path');
const { runCode, evalExpr, check, report, j } = require('../deploy-day-harness/n8n-sim.js');

const code = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const RETURN = code('return-to-core.js');
const JOURNAL = code('journal-turn.js');
const ECHO = code('echo-answered.value.txt').trim();
const RESOLVE = code('live/resolve-reply.js');

const SENT_ID = 'wamid.HBgMMjM3NjcyNzQ1ODMxFQIAERgSODJFQzhFMzRGOEI5RDkxNTRCAA==';
const BODY = { messaging_product: 'whatsapp', to: '237672745831', type: 'interactive', interactive: { type: 'button',
  body: { text: 'Yes boss, bottles are in stock. The green one here is 7,500 FCFA. How many are you taking?' },
  action: { buttons: [{ type: 'reply', reply: { id: 'deal:abc:1', title: '✓ 7 500 XAF' } }] } } };
const decide = { handled: true, handBack: false, verdict: 'approved', lockIssued: false, reply: { channel: 'whatsapp', method: 'messages', body: BODY } };
const waRes = { messaging_product: 'whatsapp', messages: [{ id: SENT_ID }] };
const inboundTurn = { channel: 'whatsapp', externalId: '237672745831', messageId: 'wamid.CUSTOMER-BOTTLES', kind: 'text', text: 'Can I buy some bottles?', replyTo: null };

// ── A · return to core ──────────────────────────────────────────────────────
const ret = (mode, extra = {}) => runCode(RETURN, { nodes: { 'decide send': [j(decide)], Inbound: [j({ mode })], ...extra } })[0].json;
const rTurn = ret('turn', { 'send whatsapp': [j(waRes)] });
check('A · return to core', 'turn mode: reports what was sent, { id, body }',
  Array.isArray(rTurn.sent) && rTurn.sent.length === 1 && rTurn.sent[0].id === SENT_ID && rTurn.sent[0].body === BODY);
check('A · return to core', 'turn mode keeps the old flags unchanged', rTurn.handled === true && rTurn.verdict === 'approved' && rTurn.lockIssued === false);
const rOpen = ret('open', { 'send whatsapp': [j(waRes)] });
check('A · return to core', 'OPEN mode carries no sent field and no text or price (it lands in the main agent)',
  !('sent' in rOpen) && !/7,500|7 500|How many/.test(JSON.stringify(rOpen)) && rOpen.alreadyAnswered === true);
check('A · return to core', 'nothing sent (send guard false) → sent: []', ret('turn').sent.length === 0);
check('A · return to core', 'Telegram id read from result.message_id',
  ret('turn', { 'send telegram': [j({ ok: true, result: { message_id: 4242 } })] }).sent[0].id === '4242');

// ── B · echo answered ───────────────────────────────────────────────────────
const echoVal = JSON.parse(evalExpr(ECHO, { json: waRes, nodes: { Inbound: [j(inboundTurn)], 'decide send': [j(decide)] } }));
check('B · echo answered', 'still carries messageId + expiresAt (drop duplicate reply reads those)',
  echoVal.messageId === 'wamid.CUSTOMER-BOTTLES' && typeof echoVal.expiresAt === 'string');
check('B · echo answered', 'now also carries the sent { id, body }',
  echoVal.sent.length === 1 && echoVal.sent[0].id === SENT_ID && echoVal.sent[0].body.interactive.body.text === BODY.interactive.body.text);
const echoNoId = JSON.parse(evalExpr(ECHO, { json: {}, nodes: { Inbound: [j(inboundTurn)], 'decide send': [j(decide)] } }));
check('B · echo answered', 'a send with no id → sent: [] (never an entry with an empty id)', echoNoId.sent.length === 0);

// ── C · journal turn ────────────────────────────────────────────────────────
const runJournal = (nodes, recalled = '[]') => JSON.parse(runCode(JOURNAL, {
  nodes: { Inbound: [j(inboundTurn)], 'recall journal': [j({ journal: recalled })], ...nodes }, input: [],
})[0].json.journal);
const jTurn = runJournal({ 'hand to bargainer': [j(rTurn)] });
check('C · journal turn', "turn mode: customer message, then the bargainer's message with its buttons",
  jTurn.length === 2 && jTurn[0].who === 'customer' && jTurn[1].who === 'bot' && jTurn[1].id === SENT_ID
  && /How many are you taking\? \[buttons: ✓ 7 500 XAF\]/.test(jTurn[1].text));
const jOpen = runJournal({ 'read bargain echo': [j({ bargainAnswered: JSON.stringify(echoVal) })] });
check('C · journal turn', 'open mode: the echo stamped with THIS message is journaled', jOpen.some((e) => e.id === SENT_ID));
const stale = JSON.stringify({ ...echoVal, messageId: 'wamid.SOME-EARLIER-TURN' });
check('C · journal turn', 'an echo stamped with ANOTHER message is ignored',
  !runJournal({ 'read bargain echo': [j({ bargainAnswered: stale })] }).some((e) => e.id === SENT_ID));
check('C · journal turn', 'a malformed echo journals nothing and does not throw',
  runJournal({ 'read bargain echo': [j({ bargainAnswered: '{not json' })] }).length === 1);
const jBoth = runJournal({ 'hand to bargainer': [j(rTurn)], 'read bargain echo': [j({ bargainAnswered: JSON.stringify(echoVal) })] });
check('C · journal turn', 'reported by both routes → journaled ONCE', jBoth.filter((e) => e.id === SENT_ID).length === 1);
const prior = JSON.stringify([{ id: SENT_ID, who: 'bot', text: 'x', at: new Date().toISOString() }]);
check('C · journal turn', 'an id already in the journal is not added again',
  runJournal({ 'hand to bargainer': [j(rTurn)] }, prior).filter((e) => e.id === SENT_ID).length === 1);
check('C · journal turn', 'no bargainer at all → unchanged behaviour (customer message only)', runJournal({}).length === 1);

// ── D · the round trip that failed live: REPLY "4" on that message ──────────
const replyInbound = { channel: 'whatsapp', externalId: '237672745831', messageId: 'wamid.FOUR', kind: 'text', text: '4',
  replyTo: { messageId: SENT_ID, fromBot: true, text: null } };
const resolveWith = (journal) => runCode(RESOLVE, { nodes: { Inbound: [j(replyInbound)], 'sync identity': [j({ success: true })],
  'recall journal': [j({ journal: JSON.stringify(journal) })] } }).json._reply; // this node returns one item, not an array
const resolved = resolveWith(jTurn);
check('D · round trip', 'REPLY "4" on the bargainer\'s question now resolves to its text',
  resolved.found === true && resolved.who === 'bot' && /How many are you taking/.test(resolved.text));
check('D · round trip', 'without the change it does not (the live failure, reproduced)', resolveWith(runJournal({})).found === false);

// ── E · the guards BITE ─────────────────────────────────────────────────────
const mutate = (src, from, to) => { if (!src.includes(from)) throw new Error('mutation anchor missed: ' + from); return src.replace(from, to); };
const leaky = mutate(RETURN, 'if (!opened) {\n  const sent', 'if (true) {\n  const sent');
check('E · guards bite', 'without the turn-only rule, an OPEN return carries the priced sentence',
  /How many/.test(JSON.stringify(runCode(leaky, { nodes: { 'decide send': [j(decide)], Inbound: [j({ mode: 'open' })], 'send whatsapp': [j(waRes)] } })[0].json)));
const noStamp = mutate(JOURNAL, 'String(echo.messageId) === String(inbound.messageId) && ', '');
check('E · guards bite', 'without the stamp check, a stale echo is journaled',
  JSON.parse(runCode(noStamp, { nodes: { Inbound: [j(inboundTurn)], 'recall journal': [j({ journal: '[]' })], 'read bargain echo': [j({ bargainAnswered: stale })] }, input: [] })[0].json.journal).some((e) => e.id === SENT_ID));
const noDedupe = mutate(JOURNAL, "  if (id && journal.some(function (e) { return e && String(e.id) === String(id); })) return;\n", '');
check('E · guards bite', 'without the one-entry-per-id rule, a message reported twice is journaled twice',
  JSON.parse(runCode(noDedupe, { nodes: { Inbound: [j(inboundTurn)], 'recall journal': [j({ journal: '[]' })], 'hand to bargainer': [j(rTurn)], 'read bargain echo': [j({ bargainAnswered: JSON.stringify(echoVal) })] }, input: [] })[0].json.journal).filter((e) => e.id === SENT_ID).length === 2);

process.exit(report());
