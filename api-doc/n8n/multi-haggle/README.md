# Several haggles at once (2026-10-25)

## The defect

Owner's handset test: two product cards (Water Bottle, Nike Air Max 90), a Bargain tap on each, then
REPLY under the bottle's *"Make me an offer"* with *"Do you take 6.5k here!?"*. The bot answered
about the **shoes**, and even said so: *"The message you replied to says 'Water Bottle'; did you
mean these shoes?"*

Cause: the routing flag `wi-mall:bargain:<channel>:<externalId>` held **one** product, and every
Bargain tap overwrote it ("latest press wins"). The reply resolved correctly, but only as text for
the model; the bargainer was bound to the shoes, and its `negotiation_context` tool told it to
switch items only after the customer agreed to.

jovi-mall was never the limit: negotiation sessions are keyed per (customer, variant, quantity),
so several can be open at once. The fix is almost entirely here.

## The design

**The flag is a LIST of open items**, newest first, at most 5, each `{ productId, variantId,
quantity, title, askedAt, expiresAt }` with its own 30-minute expiry. The top-level `variantId` /
`productId` / `quantity` / `expiresAt` mirror the newest item, so a reader of the old shape keeps
working; a flag written before this change is read as a list of one.

**Which item a message is about** — `core.read-bargain-flag.js`, in this order:

1. the message the customer pressed REPLY on, when the journal tagged it with an item;
2. the only open item;
3. the newest — a guess, and the bargainer is told so.

With more than one item open, the bargainer gets `openItems` and `<open_haggles>` in its user turn
(never in the system prompt — the playbook stays byte-identical for the cache): work on the item the
customer means, ask which one when unclear, and **price each item separately** when the customer
names one figure for several (owner decision, 2026-10-25: ask per item, never split a figure).

**Tags.** `journal turn` tags a Bargain question and the bargainer's messages with their item;
`resolve reply` reads the tag on both channels.

**Closing removes ONE item.** A deal (spoken or pressed), a Buy-at-price press, or a refused call
drops that item only; `#HANDBACK#` (the customer left the price talk) drops them all. The closed
item comes from the gate's new `data.subject` (jovi-mall, 2026-10-25), because the agent may switch
items inside a turn; without it, the envelope is used, as before.

| Workflow | Node | Change |
|---|---|---|
| wi-mall-core | `read bargain flag` | list, routing order above, `openItems` out |
| wi-mall-core | `resolve reply` | journal read on both channels; carries the item tag |
| wi-mall-core | `journal turn` | tags the Bargain question and the bargainer's messages |
| wi-mall-core | `read flag (tap)` → `merge flag (tap)` → `set bargain flag (tap)` | merge instead of overwrite |
| wi-mall-core | `read flag (screen)` → `merge flag (screen)` → `set bargain flag (screen)` | same, for a product-screen press |
| wi-mall-core | `read flag (close)` → `drop item (close)` → `update bargain flag (close)` | was `clear bargain flag (tap)` (delete all) |
| wi-mall-core | `hand to bargainer` | new `openItems` input |
| wi-mall-bargain | `Inbound` | new typed input `openItems` (string) |
| wi-mall-bargain | `compose turn` | `<open_haggles>` block |
| wi-mall-bargain | `decide send` | `subject` from the gate; `tagVariantId`; `closeScope` |
| wi-mall-bargain | `return to core`, `echo answered` | what was sent carries its item |
| wi-mall-bargain | `read flag (open)` → `merge flag (open)` → `set bargain flag` | open_negotiation merges too |
| wi-mall-bargain | `read flag (close)` → `drop item (close)` → `update bargain flag (close)` | was `clear bargain flag` |
| wi-mall-bargain | `negotiation_context` | may move to another item in `<open_haggles>` |

⚠ **Read-then-write.** Each flag write reads the key a few milliseconds earlier. Two taps landing in
the same instant could lose one — the exposure the reply journal already accepts.

⚠ **Two jovi-mall fields make it complete, and the workflows tolerate their absence:**
`productTitle` on a Bargain tap's response (titles in `<open_haggles>`; without it the line says
the agent can look the name up) and `subject` on an approved gate verdict (which item closed).

## Versions

| Workflow | Published | Rollback to |
|---|---|---|
| UP-wi-mall-bargain `lJdli0uwOtWBGx5R` | `67868ccb` | `e31972f0` |
| UP-wi-mall-core `vvbouV2136P5weCs` | `2535dc27` | `b0fd5058` |
| UP-wi-mall-core — tool catch-up (categories, Orange `paymentCode`, reviews), same day | `23c4243e` | `2535dc27` |

Core's publish also carried two other changes: `delivery_fees_propose` / `delivery_fees_withdraw`
and the `orders_get_order` who-pays note (generated from `tools/catalog.json`), and the
`contact` guide-topic draft from 2026-10-19 that was waiting for its jovi-mall deploy.

## Files

- `core.*.js`, `bargain.*.js` — the bodies as published, byte-identical (diffed against the live
  drafts before publishing).
- `live/` — the bodies they replaced.
- `test.js` — `node test.js`; replays the screenshot and the close / handback / open paths.
  `../reply-journal/test.js` was also run against the new bodies (20/0).
