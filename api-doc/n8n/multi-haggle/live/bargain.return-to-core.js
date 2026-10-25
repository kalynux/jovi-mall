// What wi-mall-core does next. `handled: false` means this turn was NOT answered here
// and the main agent should take it — in the same execution, so the customer waits once.
//
// TWO callers now, and they read different fields:
//
//   `turn` — reached from wi-mall-core's `hand to bargainer`. Reads `handled`, and its true
//            branch simply ends the turn.
//   `open` — reached from the `open_negotiation` TOOL. Since 2026-09-08 the open branch
//            chains straight into a full bargaining turn rather than stopping at
//            `shape handover`, so this value lands in the MAIN AGENT's context.
//
// ⚠ That second caller is why the shape below matters. It carries the same three flags
// `shape handover` returns and NOT ONE NUMBER — no price, no floor, no counter, not even the
// session id. negotiation-tools.md: nothing downstream of these responses may forward the
// window to the main agent. An allowlist, not a redaction; add a field here only after
// checking it against that rule.
//
// `alreadyAnswered` is what the main agent's prompt keys `#ANSWERED#` on: the customer has
// already received the bargainer's sentence from inside this tool call, so anything the agent
// says now would be a second message. wi-mall-core does not trust it on its own — `echo
// answered` is the mechanical half of that pair.
const d = $('decide send').first().json || {};
const opened = String(($('Inbound').first().json || {}).mode || '') === 'open';
const handled = d.handled === true;

const out = {
  handled: handled,
  handBack: d.handBack === true,
  verdict: d.verdict || 'none',
  lockIssued: d.lockIssued === true,
};

// ⭐ WHAT THIS RUN SENT, for wi-mall-core's reply journal (2026-10-05) -- TURN MODE ONLY.
//
// The bargainer sends its own message, so it never passes core's send loop, and `journal turn`
// never learned its WhatsApp id: a customer pressing REPLY on "How many are you taking?" and
// typing "4" reached the main agent as a reply to a message "no longer available" (core 22471,
// the message bargain 22360 sent). The pair { id, body } is what core needs to file it.
//
// ⚠ NOT in open mode, and that is the allowlist above, not an oversight: an open's return value
// lands in the MAIN AGENT'S context, and the body carries prices. Open mode reaches the
// journal through `echo answered`'s value instead, which core reads in code nodes only.
// In turn mode this value goes to core's `bargain handled?` and `journal turn`, no model.
//
// What is journaled is the sentence the CUSTOMER RECEIVED -- already approved by the gate --
// never the window: negotiation-tools.md's rule is about `window.floor`, and nothing here
// reads it.
if (!opened) {
  const sent = [];
  const reply = d.reply;
  for (const nm of ['send whatsapp', 'send telegram']) {
    if (!$(nm).isExecuted || !reply || !reply.body) continue;
    const res = $(nm).first().json || {};
    const id = (res.messages && res.messages[0] && res.messages[0].id) || (res.result && res.result.message_id);
    if (id) sent.push({ id: String(id), body: reply.body });
  }
  out.sent = sent;
}

if (opened) {
  // Reaching here in open mode means the variant resolved AND the session opened: both
  // failure branches stop at `shape handover` and never come this way.
  out.handedOver = true;
  out.negotiable = true;
  out.reason = 'ready';
  out.alreadyAnswered = handled;
}

return [{ json: out }];