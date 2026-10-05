# Reply journal — the bargainer's messages (2026-10-05)

## How a reply is resolved (wi-mall-core)

| Node | Job |
|---|---|
| `Inbound` | carries `replyTo { messageId, fromBot, text }`. Telegram fills `text`. **WhatsApp sends only the id.** |
| `recall journal` → `journal turn` → `save journal` | one Redis key per chat, `wi-mall:journal:<channel>:<externalId>`: the last 30 messages, 48 h, each `{ id, who, text, at }` |
| `resolve reply` | WhatsApp: looks the replied-to id up in the journal |
| `compose agent input` | tells the model what the quoted message said, or that it is "no longer available" |

## The defect

`wi-mall-bargain` sends its own messages, so they never pass core's send loop and were never
journaled. Core 22471: the customer replied "4" to the bargainer's "… How many are you taking?"
(sent by bargain 22360); the id was not in the journal; the bot asked "which message?".

A second hole sat beside it. In open mode, when core suppressed its own sentence because the
bargainer had already spoken, `send guard`'s false branch went nowhere, and that turn journaled
**nothing**, not even the customer's message.

## The fix

| Workflow | Node | Change |
|---|---|---|
| wi-mall-bargain | `return to core` | **turn mode only**: adds `sent: [{ id, body }]` |
| wi-mall-bargain | `echo answered` | the Redis value also carries `sent: [{ id, body }]` |
| wi-mall-core | `journal turn` | files the bargainer's messages from either route, one entry per id; an echo counts only when stamped with this message |
| wi-mall-core | connection | `send guard` false → `journal turn` |

⚠ **Why two routes.** An `open` return value lands in the MAIN AGENT's context and must carry
no prices (negotiation-tools.md § 1, `return to core`'s allowlist). So open mode reports through
the echo, which core reads in code nodes only. What is journaled is the sentence the customer
received, already approved by the gate, and never `window.floor`.

## Files

- `return-to-core.js`, `journal-turn.js`, `echo-answered.value.txt`: the bodies as published,
  byte-identical (checked against the drafts before publishing).
- `live/`: the bodies before this change, plus `resolve-reply.js` (unchanged, used by the test).
- `test.js`: `node test.js`, **20/20**, including the live round trip ("4" now resolves) and
  three mutation checks.

Published: bargain `2f73e1bb` (was `246d1d51`), core `4d6c4ce4` (was `d578b0a3`).
