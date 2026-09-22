// The core agent's system prompt for the handset test of 2026-09-22 — the chat-surfaces stream's
// three rules (ORDERS · never copy a tool's sentence · WHEN THE CUSTOMER TYPES INSTEAD OF
// TAPPING, built by test-chat-without-buttons.js --write) PLUS the checkout rule from the
// payments stream's new tools. Run `node build-checkout-prompt.js` to test, `--write` to emit
// new/final_system_message.txt.
//
// Why a CHECKOUT section at all: the live prompt (63c59a2f) never mentions checkout, addresses
// or phone numbers. On the handset the bargainer asked for "your delivery address and number",
// the customer said they were on the account, and the assistant — with no rule and no tool —
// answered "I can't save or change your address or phone number here" (execs 1920, 1924).
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const check = (name, ok, extra) => {
  if (ok) { passed++; console.log('  ✔ ' + name); } else { failed++; console.log('  ✘ ' + name + (extra ? '  → ' + extra : '')); }
};

const LIVE_PATH = process.env.CORE_SNAPSHOT || 'C:/Users/Fante/Desktop/wi-mall-deploy/wi-mall-core-63c59a2f.json';
const CHAT_PATH = path.join(__dirname, 'new', 'chat_system_message.txt');
if (!fs.existsSync(LIVE_PATH) || !fs.existsSync(CHAT_PATH)) {
  console.log('  ✘ refusing to run: need ' + LIVE_PATH + ' and ' + CHAT_PATH + ' (node test-chat-without-buttons.js --write)');
  process.exit(1);
}
const LIVE = JSON.parse(fs.readFileSync(LIVE_PATH, 'utf8'));
const liveNodes = LIVE.nodes || (LIVE.data && LIVE.data.nodes);
const LIVE_PROMPT = liveNodes.find((n) => n.name === 'AI Agent').parameters.options.systemMessage;
const CHAT_PROMPT = fs.readFileSync(CHAT_PATH, 'utf8');

const patch = (label, body, pairs) => {
  let out = body;
  for (const [a, b] of pairs) {
    const n = out.split(a).length - 1;
    if (n !== 1) throw new Error(label + ': anchor found ' + n + ' times: ' + a.slice(0, 60));
    out = out.replace(a, () => b);
  }
  return out;
};

// ── the two edits ────────────────────────────────────────────────────────────
const REF_OLD = "If `cart_add_item` is refused because of it, add the item again without it and tell the customer plainly that the price they agreed is no longer available.\n";
const REF_NEW = REF_OLD
  + "When the price was agreed, the platform normally put the item in their basket at that price straight away: check with `cart_get` before adding it again, and when it is there, go straight to CHECKOUT below.\n";

const ORDERS_HEADING = '## ORDERS\n';
const CHECKOUT = [
  '## CHECKOUT',
  'When the customer wants to buy what is in their basket ("checkout", "I\'ll take it", "place the order", "let\'s pay"), call `checkout_review`. It already knows their saved delivery address (the default, unless they choose another) and the mobile-money number on their account.',
  '- Tell them in one or two short lines the total, where it will be delivered and the masked number the payment request will go to, and ask them to confirm.',
  '- When they confirm, call `checkout_place` with the `checkoutRef` and the `delivery.address.id` from that review. Never call it without that yes, and never twice.',
  '- ⛔ Never ask for a delivery address or a phone number: they are on the account and the review shows them. For another saved address, call `checkout_review` again with its `deliveryAddressId`. With no saved address, give them the `addAddressUrl`: new addresses are added on the website. Offer to carry on once it is saved.',
  '- After `checkout_place`: `waiting` means tell them to approve the payment on their phone, and the result arrives in this chat. `failed` means no payment request is coming: say so plainly and offer to send it again with `checkout_retry_payment` once they agree.',
  '- "Did my payment go through?" is `checkout_payment_status`. Payment is by mobile money.',
  '',
  '',
].join('\n');

const FINAL = patch('systemMessage', CHAT_PROMPT, [
  [REF_OLD, REF_NEW],
  [ORDERS_HEADING, CHECKOUT + ORDERS_HEADING],
]);

// ── checks ───────────────────────────────────────────────────────────────────
console.log('\n── the base is the live prompt ──');
check('the live snapshot is 63c59a2f (or CORE_SNAPSHOT points elsewhere on purpose)',
  String(LIVE.versionId || '').startsWith('63c59a2f') || !!process.env.CORE_SNAPSHOT, LIVE.versionId);
const CHAT_INSERTS = ['## ORDERS\n', "- ⛔ Never copy a sentence out of a tool's answer", '## WHEN THE CUSTOMER TYPES INSTEAD OF TAPPING\n'];
check('the chat-stream prompt carries its three rules', CHAT_INSERTS.every((s) => CHAT_PROMPT.includes(s)));
// Every line of the live prompt survives, in order, in the final one (only insertions were made).
const liveLines = LIVE_PROMPT.split('\n');
let cursor = 0;
const finalLines = FINAL.split('\n');
const lost = [];
for (const l of liveLines) {
  const at = finalLines.indexOf(l, cursor);
  if (at === -1) lost.push(l.slice(0, 60)); else cursor = at + 1;
}
check('every line of the live prompt survives, in order — the changes are insertions only', lost.length === 0, lost.join(' | '));
check('the n8n expressions are untouched (same {{ }} count as live)',
  (FINAL.match(/\{\{/g) || []).length === (LIVE_PROMPT.match(/\{\{/g) || []).length);

console.log('\n── the checkout rule ──');
const order = ['## HAGGLING OVER PRICE', '### A PRICE ALREADY AGREED', '## CHECKOUT', '## ORDERS', '## MESSAGES YOUR TOOLS SEND', '## WHEN THE CUSTOMER TYPES INSTEAD OF TAPPING', '## RULES'];
const idx = order.map((h) => FINAL.indexOf(h + '\n'));
check('sections in order: haggling → agreed price → CHECKOUT → ORDERS → tool messages → typing → rules',
  idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), idx.join(','));
check('it names the two new tools, in order: review, then place', FINAL.indexOf('`checkout_review`') < FINAL.indexOf('`checkout_place`') && FINAL.includes('`checkout_place`'));
check('⛔ it forbids asking for an address or a phone number', /Never ask for a delivery address or a phone number/.test(FINAL));
check('the place needs the customer\'s yes', /Never call it without that yes/.test(FINAL));
check('no saved address → the website, never collected in chat', FINAL.includes('`addAddressUrl`') && FINAL.includes('added on the website'));
check('a failed charge is said plainly, and retry needs their agreement', FINAL.includes('no payment request is coming') && FINAL.includes('`checkout_retry_payment` once they agree'));
check('payment status has its tool, and there is no card promise', FINAL.includes('`checkout_payment_status`') && !/card/i.test(CHECKOUT));
check('an agreed price: check the basket before adding again', FINAL.includes('check with `cart_get` before adding it again'));
check('every tool named in the new text is one the catalogue offers the model', (() => {
  const cat = require('../tools/catalog.json').tools;
  const offered = new Set(cat.filter((t) => t.tier !== 'flow_only' && t.status === 'available').map((t) => t.name));
  const named = [...(CHECKOUT + REF_NEW).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => /_/.test(n) && !/^(checkoutRef|addAddressUrl)$/.test(n) && !n.includes('.'));
  const missing = named.filter((n) => !offered.has(n));
  return named.length >= 5 && missing.length === 0 || (console.log('     named', named.join(','), 'missing', missing.join(',')), false);
})());

console.log('\n── transport safety ──');
check('no backslash anywhere in the final prompt', !FINAL.includes(String.fromCharCode(92)));
check('it ends exactly as the live prompt ends', FINAL.endsWith(LIVE_PROMPT.slice(-60)));
check('it stays under 12,500 characters (live ' + LIVE_PROMPT.length + ', final ' + FINAL.length + ')', FINAL.length < 12500);

console.log('\n── guard bites ──');
const mutant = FINAL.replace('Never ask for a delivery address or a phone number', 'Ask for their delivery address and phone number');
check('MUTANT — the address rule check fails on a prompt that asks for them', !/Never ask for a delivery address or a phone number/.test(mutant) && mutant !== FINAL);
// ⚠ A DISTINCTIVE line, present once: a blank or repeated line would make this mutant change
// nothing (it did, on the first draft — liveLines[20] is blank) and so prove nothing.
const target = liveLines.find((l) => l.length > 40 && FINAL.split(l).length === 2);
const dropped = FINAL.replace(target + '\n', '');
check('MUTANT — dropping one live line is caught by the survival check', (() => {
  const fl = dropped.split('\n'); let c = 0; let miss = 0;
  for (const l of liveLines) { const a = fl.indexOf(l, c); if (a === -1) miss++; else c = a + 1; }
  return miss > 0 && dropped !== FINAL;
})());

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (process.argv.includes('--write') && failed === 0) {
  fs.writeFileSync(path.join(__dirname, 'new', 'final_system_message.txt'), FINAL);
  console.log('wrote new/final_system_message.txt (' + FINAL.length + ' chars)');
}
process.exit(failed === 0 ? 0 : 1);
