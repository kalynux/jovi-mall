// Builds the n8n half of "a photo is shopping; one quiet button offers a support request"
// (owner decision 2026-10-05) from the live copies in live/.
//   node build.js      writes compose-agent-input.js + system-message.txt, exit 1 on a missed anchor
//
// ⛔ PUBLISH ONLY AFTER jovi-mall IS DEPLOYED with `tkt:file:` (bot-file.controller.ts). Before that
// the upload still answers with the which-request LIST, and the note below would tell the model the
// customer was offered one button when they were in fact shown a list.
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

function replaceOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0) throw new Error('anchor missed: ' + label);
  if (src.indexOf(from, at + 1) >= 0) throw new Error('anchor not unique: ' + label);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

// ── compose agent input: the note on a photo turn ──────────────────────────
let cai = read('live/compose-agent-input.js');
cai = replaceOnce(cai,
  "  // ⚠ THE PLATFORM MAY HAVE ALREADY ASKED THE CUSTOMER WHICH REQUEST THIS FILE IS FOR, with\n" +
  "  // buttons (a picker it renders when they have open requests). That question is SENT this\n" +
  "  // turn, so the model must not spend the one-use reference racing it: whoever loses gets\n" +
  "  // 'send the file again'. ⏳ The exact wording is the orders stream's to confirm.\n" +
  "  if (res.reply) {\n" +
  "    note = note + ' [The customer has already been asked, with buttons, which request this file belongs to. Do not attach it yourself unless they name one in words.]';\n" +
  "  }\n",
  "  // ⚠ THE PLATFORM MAY HAVE SENT ONE BUTTON UNDER THIS FILE -- \"Add to a request\" -- when the\n" +
  "  // customer has an open support request (owner decision 2026-10-05; jovi-mall `tkt:file:`). It\n" +
  "  // used to be the whole which-request list, drawn under every photo, and a shopper was asked which\n" +
  "  // complaint their product photo belonged to (core 22508). The photo is answered as shopping now;\n" +
  "  // the button is sent after the answer, and the model must neither repeat it nor spend the one-use\n" +
  "  // reference racing it: whoever loses gets 'send the file again'.\n" +
  "  if (res.reply) {\n" +
  "    note = note + ' [The platform has sent the customer one button, after your answer, to add this file to one of their open support requests instead. Answer the picture as something they want to buy unless their words say it is about a problem. Never mention that button, and do not attach the file yourself unless they name a request in words.]';\n" +
  "  }\n",
  'compose agent input: the reply note');
fs.writeFileSync(path.join(__dirname, 'compose-agent-input.js'), cai);

// ── the assistant's instructions: FILES THE CUSTOMER SENDS ──────────────────
let sm = read('live/system-message.txt');
sm = replaceOnce(sm,
  "You cannot see images. When the customer sends a photo or a PDF you are told its file name and a reference in square brackets — nothing about what is in it. Never describe, read or guess at its contents; refer to it only as what the customer called it. If it is evidence for a support request, call `tickets_add_attachment` with that exact reference (open the ticket first if there is not one).",
  "You cannot see images. When the customer sends a photo, a description of it written by another model is given to you in square brackets: speak only about what that description says, and never claim to have seen the picture. A PDF comes with its file name only.\n" +
  "⭐ A photo is something the customer wants to buy unless their words say otherwise — with or without a caption. Search for it with `Search-Products`, setting usePhoto to true and putting key words from the description in query, then show what it finds with `Show-Products` (see SHOWING PRODUCTS).\n" +
  "Only when their words say the file is about a problem (a damaged parcel, a wrong item, a receipt for a support request) is it evidence: call `tickets_add_attachment` with the exact reference you were given (open the ticket first if there is not one). When you are told the platform has sent them a button to add the file to a support request, never mention that button.",
  'system message: files section');
fs.writeFileSync(path.join(__dirname, 'system-message.txt'), sm);

console.log('ok', cai.length, sm.length);
