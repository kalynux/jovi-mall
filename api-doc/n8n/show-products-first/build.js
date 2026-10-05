// Builds the 2026-10-05 "show a product before talking about it" texts from the live copies.
//   node build.js        writes system-message.txt + show-products-description.txt, exit 1 on a missed anchor
//
// Owner rule (2026-10-05): the FIRST time any product comes into the conversation — one or
// several — the customer is shown it as a card (picture, price) before being told about it,
// like a market seller holding the item up. Follow-up questions about a product the customer
// has already seen are answered in text. Replaces "a single product gets a sentence", which is
// what made core 22508 describe a photo match without showing it and then ask the customer to
// confirm a product they could not see.
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

function replaceOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0) throw new Error('anchor missed: ' + label);
  if (src.indexOf(from, at + 1) >= 0) throw new Error('anchor not unique: ' + label);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

// ── The main assistant's instructions, § SHOWING PRODUCTS ───────────────────
let sm = read('live/system-message.txt');
sm = replaceOnce(sm,
  'Whenever you are presenting MORE THAN ONE product, call `Show-Products` with their ids, in the order you want them shown, and then write ONE short sentence introducing them. That sentence is all you write: the products themselves are drawn as real cards with pictures and buttons.',
  'The FIRST time any product comes into the conversation, show it before you talk about it: call `Show-Products` with its id, whether it is ONE product or several, in the order you want them shown, and then write ONE short sentence. That applies whatever brought the product up: a search, a photo the customer sent, or a product they named. Nobody can judge, compare or confirm a product they have not seen, just as a seller at the market holds the item up before answering "do you have green earbuds?". That sentence is all you write: the products themselves are drawn as real cards with pictures, prices and buttons. When the customer asked something specific ("how much is it?"), the sentence answers it.',
  'showing rule');
sm = replaceOnce(sm,
  'Do NOT call it for a single product the customer asked a specific question about — "how much is the fan?" is answered in a sentence. It is for a SET they are meant to choose from.',
  'Once the customer HAS seen a product in this conversation, answer their follow-up questions about it in text, without drawing it again — after the fan\'s card was shown, "does it come in white?" is answered in a sentence. Asking the customer to confirm a product is the one they mean (always after a photo match) needs its card if they have not seen it yet: they cannot confirm what they cannot see.',
  'single-product rule');
fs.writeFileSync(path.join(__dirname, 'system-message.txt'), sm);

// ── The Show-Products tool's own description ────────────────────────────────
let sp = read('live/show-products-description.txt');
sp = replaceOnce(sp,
  'Call this EVERY time you are presenting more than one product, and then write ONE short sentence introducing them.',
  'Call this EVERY time a product comes into the conversation for the first time, whether it is ONE product or several (from a search, a photo, or a product the customer names), and then write ONE short sentence, which may also answer their question.',
  'tool: when to call');
sp = replaceOnce(sp,
  'Do not call it for a single product the customer asked a specific question about: answer that in a sentence.',
  'Once the customer has already seen a product in this conversation, answer follow-up questions about it in a sentence without drawing it again. Asking the customer to confirm a product is the one they mean always needs its card if they have not seen it.',
  'tool: when not to call');
fs.writeFileSync(path.join(__dirname, 'show-products-description.txt'), sp);

console.log('ok', sm.length, sp.length);
