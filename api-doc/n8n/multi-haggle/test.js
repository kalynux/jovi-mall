// Offline proofs for SEVERAL HAGGLES AT ONCE (2026-10-25). No n8n, no Redis.
//   node test.js          exit code = number of failures
//
// Replays the owner's handset test: Bargain on the bottle, Bargain on the shoes, then REPLY under the
// bottle's "make me an offer" with "Do you take 6.5k here!?" -- which the old single-item flag
// haggled about the SHOES. Each file here is a node body exactly as published (see README).
const fs = require('fs');
const path = require('path');
const code = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

function run(file, nodes, input) {
    const $ = (name) => {
        const executed = Object.prototype.hasOwnProperty.call(nodes, name);
        const json = executed ? nodes[name] : {};
        return { isExecuted: executed, first: () => ({ json }), item: { json }, all: () => [{ json }] };
    };
    const $input = { first: () => ({ json: input || {} }), item: { json: input || {} }, all: () => [{ json: input || {} }] };
    const out = new Function('$', '$input', code(file))($, $input);
    return Array.isArray(out) ? out[0].json : out.json;
}

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? '✅' : '❌'} ${name}`); if (!ok) failed++; };

const BOTTLE = { productId: 'p_bottle', variantId: 'v_bottle', title: 'Water Bottle' };
const SHOES = { productId: 'p_shoes', variantId: 'v_shoes', title: 'Nike Air Max 90' };
const tapData = (p) => ({ data: { outcome: 'chat', verb: 'bargain', productId: p.productId, variantId: p.variantId, productTitle: p.title } });

// 1 · two Bargain taps, the second must NOT erase the first
let flag = null;
flag = run('core.merge-flag-tap.js', { 'product action': tapData(BOTTLE) }, { prevFlag: flag }).value;
flag = run('core.merge-flag-tap.js', { 'product action': tapData(SHOES) }, { prevFlag: flag }).value;
const f = JSON.parse(flag);
check('two taps → two open items, newest first', f.items.length === 2 && f.items[0].variantId === 'v_shoes' && f.items[1].variantId === 'v_bottle');
check('top-level mirrors the newest (old readers keep working)', f.variantId === 'v_shoes' && new Date(f.expiresAt) > new Date());

// 1b · an OLD-shape flag (written before the change) is read as a list of one
const old = JSON.stringify({ variantId: 'v_old', productId: 'p_old', quantity: 1, expiresAt: new Date(Date.now() + 60000).toISOString() });
const merged = JSON.parse(run('core.merge-flag-tap.js', { 'product action': tapData(BOTTLE) }, { prevFlag: old }).value);
check('old-shape flag is kept as an item when a new tap arrives', merged.items.length === 2 && merged.items[1].variantId === 'v_old');

// 2 · the tap turn's journal tags the bargain question with its item
const journal1 = run('core.journal-turn.js', {
    Inbound: { kind: 'token', channel: 'whatsapp', messageId: 'in1' },
    'product action': tapData(BOTTLE),
    'send loop': {}, 'expand replies': { reply: { body: { type: 'interactive', interactive: { body: { text: 'Water Bottle — color: green\n\nMake me an offer' } } } } },
    'recall journal': { journal: '[]' },
}, { messages: [{ id: 'wamid.BOTTLE_Q' }] });
const j1 = JSON.parse(journal1.journal);
check('journal: the bottle question is tagged with the bottle', j1.length === 1 && j1[0].id === 'wamid.BOTTLE_Q' && j1[0].variantId === 'v_bottle');

// 3 · the customer REPLIES under the bottle's question
const rr = run('core.resolve-reply.js', {
    Inbound: { replyTo: { messageId: 'wamid.BOTTLE_Q' } },
    'sync identity': { data: {} },
    'recall journal': { journal: journal1.journal },
});
check('resolve reply: finds the text AND the item tag', rr._reply.found && rr._reply.variantId === 'v_bottle');

const routed = run('core.read-bargain-flag.js', {
    Inbound: { kind: 'text', channel: 'whatsapp', externalId: '2376', messageId: 'in2', text: 'Do you take 6.5k here!?' },
    'sync identity': { data: { customer: { language: 'en' } } },
    'check bargain': { bargainFlag: flag },
    'resolve reply': rr,
}, { priceLock: null });
check('routing: bargaining, and the subject is the BOTTLE (the replied-to item), not the newest', routed.bargaining === true && routed.variantId === 'v_bottle');
const oi = JSON.parse(routed.openItems);
check('routing: the bargainer gets both items, pickedBy=reply', oi.pickedBy === 'reply' && oi.items.length === 2);

// 3b · no reply, two open → newest, flagged as a guess
const guessed = run('core.read-bargain-flag.js', {
    Inbound: { kind: 'text', channel: 'whatsapp', externalId: '2376', messageId: 'in3', text: '6.5k for the bottle' },
    'sync identity': { data: { customer: { language: 'en' } } },
    'check bargain': { bargainFlag: flag },
}, { priceLock: null });
check('no reply, two open → newest, pickedBy=latest', guessed.variantId === 'v_shoes' && JSON.parse(guessed.openItems).pickedBy === 'latest');

// 3c · one open → no list at all (the single-item turn is unchanged)
const single = run('core.read-bargain-flag.js', {
    Inbound: { kind: 'text', channel: 'whatsapp', externalId: '2376', messageId: 'in4', text: '6k?' },
    'sync identity': { data: { customer: { language: 'en' } } },
    'check bargain': { bargainFlag: old },
}, { priceLock: null });
check('one open item → same as before, openItems empty', single.variantId === 'v_old' && single.openItems === '');

// 4 · the bargainer's turn input carries the list
const turn = run('bargain.compose-turn.js', {
    Inbound: { variantId: 'v_bottle', productId: 'p_bottle', quantity: 1, language: 'en', channel: 'whatsapp', text: 'Do you take 6.5k here!?', openItems: routed.openItems },
}, { success: true, data: { content: 'PLAYBOOK', version: 1 } });
check('compose turn: <open_haggles> lists both titles and names the reply as the reason',
    turn.userTurn.includes('<open_haggles>') && turn.userTurn.includes('"Water Bottle"') && turn.userTurn.includes('"Nike Air Max 90"') && turn.userTurn.includes('pressed REPLY'));
check('compose turn: the system prompt (playbook) is untouched — cache prefix intact', turn.playbook === 'PLAYBOOK');
const turnSingle = run('bargain.compose-turn.js', { Inbound: { variantId: 'v_old', quantity: 1, text: 'x', openItems: '' } }, { success: true, data: { content: 'P' } });
check('compose turn: a single haggle gets no block', !turnSingle.userTurn.includes('open_haggles'));
check('compose turn: prices for two items in one message → answer one, then ASK for the other again (never silence)',
    turn.userTurn.includes('separate prices for SEVERAL items') && turn.userTurn.includes('send their price for it again') && !turnSingle.userTurn.includes('SEVERAL items'));

// 5 · the agent closed the SHOES (switched mid-turn) → only the shoes leave the list
const echo = JSON.stringify({ __messageId: 'in2', success: true, data: { verdict: 'approved', reply: 'Deal at 70 000', lock: { ref: 'nlk_x', unitPrice: 70000, expiresAt: 'z' }, subject: { productId: 'p_shoes', variantId: 'v_shoes', quantity: 1 } } });
const decided = run('bargain.decide-send.js', {
    Inbound: { messageId: 'in2', channel: 'whatsapp', externalId: '2376', variantId: 'v_bottle', productId: 'p_bottle', quantity: 1, openItems: routed.openItems },
    'read gate echo': { gateEcho: echo },
});
check('decide send: the lock is bound to the GATE\'s item (shoes), not the envelope\'s (bottle)', decided.lockVariantId === 'v_shoes' && decided.subjectVariantId === 'v_shoes' && decided.closeScope === 'item');
const afterClose = JSON.parse(run('bargain.drop-item-close.js', { 'decide send': decided }, { prevFlag: flag }).value);
check('close: the shoes leave, the bottle haggle stays open', afterClose.items.length === 1 && afterClose.items[0].variantId === 'v_bottle');

// 5b · a backend without `subject` → the envelope, exactly as before
const echoOld = JSON.stringify({ __messageId: 'in2', success: true, data: { verdict: 'approved', reply: 'Deal', lock: { ref: 'r', unitPrice: 1, expiresAt: 'z' } } });
const decidedOld = run('bargain.decide-send.js', { Inbound: { messageId: 'in2', channel: 'whatsapp', externalId: '2376', variantId: 'v_bottle', quantity: 1 }, 'read gate echo': { gateEcho: echoOld } });
check('decide send without subject → envelope variant (old behaviour)', decidedOld.lockVariantId === 'v_bottle');

// 5c · "which one do you mean?" after a guess is NOT tagged with the guessed item
const decidedQ = run('bargain.decide-send.js', {
    Inbound: { messageId: 'in3', channel: 'whatsapp', externalId: '2376', variantId: 'v_shoes', quantity: 1, openItems: guessed.openItems },
    'Bargain Agent': { output: 'Is that for the bottle or the shoes?' },
});
check('an unpriced turn on a guessed item is sent but carries no item tag', decidedQ.handled === true && decidedQ.tagVariantId === null);

// 5d · #HANDBACK# closes every item
const decidedHB = run('bargain.decide-send.js', { Inbound: { messageId: 'in5', variantId: 'v_bottle' }, 'Bargain Agent': { output: '#HANDBACK#' } });
const afterHB = JSON.parse(run('bargain.drop-item-close.js', { 'decide send': decidedHB }, { prevFlag: flag }).value);
check('#HANDBACK# → every item closes, and the flag reads as lapsed', afterHB.items.length === 0 && new Date(afterHB.expiresAt) < new Date() && afterHB.variantId === null);

// 6 · a BUTTON close in core drops only that item
const afterBtn = JSON.parse(run('core.drop-item-close.js', { 'product action': { data: { negotiation: { closed: true, variantId: 'v_bottle' } } } }, { prevFlag: flag }).value);
check('button close (Lock it in / Buy at) drops only that item', afterBtn.items.length === 1 && afterBtn.items[0].variantId === 'v_shoes');

// 7 · open mode merges too
const opened = run('bargain.merge-flag-open.js', {
    'pick variant': { productId: 'p_new', variantId: 'v_new', quantity: 1 },
    'open session': { data: { expiresAt: new Date(Date.now() + 1800000).toISOString() } },
    'resolve variant': { data: { product: { title: 'Sports Socks' } } },
}, { prevFlag: flag });
const of = JSON.parse(opened.value);
check('open_negotiation adds to the list instead of replacing it', of.items.length === 3 && of.items[0].title === 'Sports Socks');

// 8 · return to core tags what the bargainer sent
const back = run('bargain.return-to-core.js', {
    Inbound: { mode: 'turn' },
    'decide send': decided,
    'send whatsapp': { messages: [{ id: 'wamid.DEAL' }] },
});
check('return to core: sent carries the item tag', back.sent.length === 1 && back.sent[0].variantId === 'v_shoes');

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all scenarios pass');
process.exit(failed);
