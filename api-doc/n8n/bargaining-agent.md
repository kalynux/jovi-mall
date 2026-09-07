# The bargaining sub-agent — the n8n half

**Stream F of [BARGAINING-AGENT-PLAN.md](./BARGAINING-AGENT-PLAN.md). Built 2026-09-07.**
The backend half is Streams A (session, profile, gate), B (the five read tools) and C+E
(the lock and the money split); this page is the automation layer that uses them.

Four workflows, two of them new:

| Workflow | id | What |
|---|---|---|
| **wi-mall-bargain** | `lJdli0uwOtWBGx5R` | the sub-agent: the playbook, the model, the memory, the seven tools, the send |
| **wi-mall-bargain-tools** | `tdCmCgwaGwp7epEV` | one door for all seven tool calls: seals the identity, builds the request, echoes the gate |
| **wi-mall-core** | `vvbouV2136P5weCs` | ⚠ **edited, live** — a routing flag check, one new tool, and the agreed price in the system prompt. Nothing else on any existing path changed |
| **wi-mall-mcp** | `3X8oYCQZkCi7Wg4r` | ⚠ **edited, live** — `cart_add_item` alone, regenerated from the catalogue so the agreed price can be spent (§ 7) |

---

## 1 · The shape of a haggle

```
customer: "c'est trop cher, 35000?"
   │
   ├─ wi-mall-core · main agent · calls open_negotiation(productId, quantity, 35000)
   │     └─ wi-mall-bargain [open]  resolve variant → open session → set flag
   │        returns { handedOver: true, negotiable: true }   ← NO PRICES
   │  main agent: "Laisse-moi voir ce que je peux faire sur le prix."
   │
customer: "alors?"
   │
   └─ wi-mall-core · check bargain → flag is live → hand to bargainer
         └─ wi-mall-bargain [turn]
              fetch playbook → SYSTEM position, byte-identical
              user turn: subject + language + the customer's words
              Bargain Agent (claude-sonnet-5, 5m prompt caching, shared chat memory)
                 negotiation_context  ← the floor arrives HERE, as a tool result
                 …reads…
                 negotiation_record   ← the gate. Echoes its verdict to Redis
              decide send → sends THE SENTENCE THE GATE APPROVED
   │
   … they agree. The gate mints a lock; `store price lock` leaves the ref in Redis,
   the flag is cleared, and the conversation goes back to wi-mall-core.
   │
customer: "ok, mets-le dans mon panier"
   │
   └─ wi-mall-core · check price lock → the ref is in the system prompt
        main agent · cart_add_item(… , negotiationLockRef) → charged what they agreed
```

**A hand-off costs one conversational turn**, deliberately. The main agent says a bridging
line ("let me see what I can do") and the sub-agent takes the next message. The alternative —
running the sub-agent inside the main agent's turn — makes both agents write to one shared
chat memory in the same turn, which duplicates the customer's message in the transcript both
of them read. The bridging beat is natural in a market conversation; the duplicate is not.

---

## 2 · The two hard constraints, and where each is discharged

### The playbook is the SYSTEM position, byte-identical

`fetch playbook` → `compose turn` → the agent node's `systemMessage`, unmodified. **Nothing
per-customer is interpolated into it.** Anthropic's prompt cache keys on an exact prefix; one
interpolated character misses it, and the document is ~17 000 characters, so a miss on every
turn multiplies the bill roughly tenfold for identical behaviour (plan § 6, invariant 6).

Everything that varies is in the **user turn**, and it is deliberately tiny:

```
<negotiation_subject> variantId / productId / quantity </negotiation_subject>
<customer> language / channel </customer>
<routing> …when to write #HANDBACK#… </routing>
<customer_message> …what they actually said… </customer_message>
```

⚠ **The negotiation's own state is NOT in the prompt** — not the window, not the round, not
the prior offers, not the durable profile. All of it arrives through the
`negotiation_context` **tool**, which the playbook already makes the first act of every turn.
That is not only cheaper. See § 3.

### wi-mall-core is live

Every edit was an `update_workflow` operation with a `versionName`, never a wholesale replace.
Across three versions the diff is **eight added nodes**, two removed connections, eleven added
connections, and **two modified nodes** — the AI Agent's `systemMessage` (previous text preserved
byte-for-byte, two sections inserted) and `read bargain flag`, which is itself new. No
pre-existing node's parameters, credentials or wiring were otherwise touched, and the same rule
governed `wi-mall-mcp`: **one** node changed there, regenerated from the catalogue rather than
hand-edited.

---

## 3 · ⚠ Why the context is a tool and not part of the prompt

`negotiation_context` returns the vendor's **floor**. Plan **D-2** discloses it to this model
and to nothing else; [negotiation-tools.md](./negotiation-tools.md) states the rule as
*"Nothing downstream of these responses may forward `window.floor` to a customer, to the main
agent, or into any log a customer's transcript is assembled from."*

n8n's chat memory persists the agent's **input** and its **output**. It never persists tool
results. And the bargaining agent shares its memory key with wi-mall-core's main agent, as
§ 6 of the plan requires. So:

| The floor arrives as… | Who ends up seeing it |
|---|---|
| a tool result | this model, for this turn ✅ |
| part of the user turn | this model — **and the main agent, forever, from the shared transcript** ❌ |

That is the whole reason the state does not travel in the prompt. It also keeps the user turn
small, which is the caching win, so the two constraints agree rather than compete.

**The other three floor exits are closed the same way:**

- `shape handover` returns `{ handedOver, negotiable, reason }` to the main agent. Three
  flags, no numbers, not even a session id — an allowlist, not a redaction.
- `shape tool result` strips the lock's **`ref`** before the model sees it. A ref is a bearer
  credential for a price; the model has no use for it and the playbook forbids mentioning
  locks at all.
- `set bargain flag` writes the subject and an expiry into Redis. No price of any kind.

---

## 4 · The gate, and why D-4 is mechanical here

Plan **D-4**: the gate runs before the reply reaches the customer. The playbook already tells
the model to send exactly what `negotiation_record` approved — but *told to* is not *cannot
otherwise*, and a model that has just been refused is precisely the one likely to say the
refused number anyway.

So `negotiation_record` is a tool that **echoes its verdict to Redis**, and the flow sends
what it reads back:

```
negotiation_record → jovi-mall → echo verdict (Redis) → the model sees the verdict and loops
                                        │
Bargain Agent finishes → read gate echo ┘ → clear gate echo → decide send
```

`decide send` has five outcomes and only two of them send anything:

| Verdict | Sent | Session |
|---|---|---|
| `approved` | **the gate's `reply`, verbatim** | open, or **closed** if a lock was minted |
| `revise` (last submission) | nothing — hand back | **stays open**: one bad draft is not the end of a haggle |
| gate refused the *call* (session expired / unknown / no longer negotiable) | nothing — hand back | closed |
| no gate call at all | the model's own words | open — a turn with no price in it |
| `#HANDBACK#`, or the agent errored / no playbook | nothing — hand back | closed on `#HANDBACK#` only |

⚠ **The echo key is conversation-scoped and stamped with the `messageId`**, and the flow
deletes it after reading. That is not tidiness: **the n8n Redis node's `set` exposes no TTL**
(measured — it is the same limitation that put wi-mall-product-search's query cache in
Postgres). A turn-scoped key would be one key per bargaining message that never expires; a
conversation-scoped key read-and-deleted is at most one per conversation, and the stamp is
what stops a leftover key being read as this turn's verdict.

---

## 5 · Handing back

`wi-mall-bargain` returns `{ handled, handBack, verdict, lockIssued }`. **`handled: false`
means nothing was sent**, and wi-mall-core falls straight through to the ordinary agent path
**in the same execution** — so the customer waits once and is answered at the asking price.
That is the plan's own designed degradation: *"the sub-agent hands back to the main agent, and
customers are still served — they simply pay the asking price."*

Everything fails in that direction. `check bargain` and every Redis write are
`continueRegularOutput`; `hand to bargainer` is `continueErrorOutput` wired to the normal
path; a missing playbook, an unreachable backend and a model error all hand back.

**A media message mid-haggle is not a haggle.** `read bargain flag` routes only
`kind === 'text'` into the sub-agent — it has seven tools and none of them touches a file, an
address or an order. The flag stays set, so the next typed message resumes the negotiation.

---

## 6 · The seven tools

All seven go through `wi-mall-bargain-tools`, which switches on a `tool` literal. The tool
nodes are named exactly as the playbook's `compatibility:` line declares them.

| Tool node | jovi-mall |
|---|---|
| `negotiation_context` | `POST /api/internal/negotiation/context` |
| `negotiation_record` | `POST /api/internal/negotiation/record` |
| `get_product_details` | `POST …/negotiation/tools/product-details` |
| `find_alternative_product` | `POST …/tools/alternatives` |
| `find_complementary_products` | `POST …/tools/complements` |
| `quote_delivery` | `POST …/tools/delivery-promise` |
| `check_promotion` | `POST …/tools/promotion` |

One credential — the existing `jovi-mall-Bearer Auth account`, which carries
`INTERNAL_SERVICE_TOKEN` — because `/tools/*` is a sub-router of the
`/api/internal/negotiation` mount and inherits its `requireServiceToken`. No
`X-Webhook-Secret`: that is the bot surface's second guard and this mount does not have it.

**Identity is mapped from the flow envelope on every tool node** (`channel`, `externalId`,
`messageId` as plain expressions), never from `$fromAI`. Only the arguments come from the
model. A model that invents an `externalId` gets its own value ignored rather than another
customer's session — the same rule `/api/internal/bot/*` enforces, and the reason there is no
`customerId` parameter anywhere on this surface.

**`args` is one `$fromAI`-bearing expression per tool**, and `build request` parses it,
coerces types and drops unset optionals. That is deliberate rather than incidental:
`toolHttpRequest`'s `{placeholder}` substitution is textual, so an omitted optional **number**
renders `{"quantity": }`, and a quoted one fails the strict Zod schemas on the far side. A
`toolWorkflow` with typed `$fromAI` arguments and one coercion point avoids both.

---

## 7 · ✅ The agreed price reaches the basket — and how it gets there

**This section used to open with a ⛔.** `negotiationLockRef` was plumbed through the backend by
Stream C+E — `cart.validator.ts`, `cart.service.ts`, `cart.model.ts` and `bot.validators.ts:155`
all accept it — but `tools/catalog.json`'s `cart_add_item` did not carry it, so the MCP tool the
main agent fills the basket with had no way to spend a lock and every lock this feature minted
expired unspent. Closed 2026-09-07 on the owner's instruction.

Three pieces, and the middle one is the interesting part:

1. **The catalogue** gained `negotiationLockRef` on `cart_add_item` (plus the five
   `NEGOTIATION_LOCK_*` failures, each telling the model to retry **without** it), and
   `npm run gen:mcp-workflow` re-rendered the node. One `updateNodeParameters` was applied to the
   live `wi-mall-mcp`; nothing else on that server was touched.
2. **The reference travels through Redis, not through the model.** `decide send` reads
   `lock.ref` off the gate echo and `store price lock` writes
   `wi-mall:bargain:lock:{channel}:{externalId}`. wi-mall-core's `check price lock` reads it back
   and `read bargain flag` renders it; the main agent's system prompt carries it beside
   `botToken`, in the same shape and for the same reason.
3. **The bargaining model still never sees it.** `shape tool result` strips `lock.ref` exactly as
   before — that model has no cart tools and the playbook forbids mentioning locks at all.

### ⚠ Why it is safe for the MAIN agent to hold a ref, and not the bargaining one

Not a contradiction, and worth stating because the two look alike. The lock is bound server-side
to **(customer, variant, quantity)**, is single-use, and is re-validated when it is spent
(D-10). So a leaked ref buys its own owner their own already-agreed price and buys anyone else
nothing at all — strictly weaker than the `botToken` the same prompt already carries, which acts
on the account. The bargaining model is denied it not because it is dangerous there but because
it is **useless** there: giving a model a credential it has no call to spend is how one ends up
in a sentence to a customer.

⚠ **The variant and quantity in the prompt come from the routing flag, not from the gate** — the
gate's response does not echo them. A model that pivoted to a different variant mid-haggle
therefore produces a hint that is wrong. It fails safely: the server re-checks the binding and
answers `NEGOTIATION_LOCK_VARIANT_MISMATCH`, and the assistant is told to add the item again
without the ref.

⚠ **A spent ref stays in Redis until it expires** (the n8n Redis node's `set` has no TTL), so a
customer adding the same item again inside the lock's 20 minutes can present a consumed one. That
is a `NEGOTIATION_LOCK_CONSUMED` refusal the prompt handles by retrying without it — the customer
pays the shelf price and is told so, rather than the add failing.

### The better shape, if this is ever revisited

Have the **backend** resolve it: `POST /api/internal/bot/cart/items` could look up the caller's
own live lock for that variant and quantity when no ref is presented. No credential in any model
context, no stale-ref refusal, and nothing to keep in step across three workflows. It was not
done here because it is new code in `modules/negotiation` and `modules/bot-surface` — two
modules this stream does not own — and because the n8n route delivers the same customer outcome
today.

## 8 · Known artifacts, measured not guessed

- **A hand-back turn writes `#HANDBACK#` into the shared transcript**, followed by the main
  agent writing the same customer message again. Both agents read one memory key, and only one
  agent per turn writes to it *except* on this path, where the sub-agent declines to answer and
  the main agent then does. Harmless to a model, ugly to a human reading it. The fix, if it ever
  matters, is a memory the flow controls rather than the agent node.
- **The routing flag's quantity does not follow a line change.** If the model moves to a new
  quantity mid-negotiation (a new line, per invariant 2), the flag still names the old one, so
  the next turn's `negotiation_context` default is stale. The model can and does pass `quantity`
  explicitly, and the context tool is authoritative — but the default is wrong until it does.
- **The main agent's own system prompt already interpolates per-customer values** (name,
  language, `botToken`), so its cached prefix has always been per-conversation rather than
  per-deployment. Adding a static section does not make that worse, and it is not this stream's
  to fix — but it means wi-mall-core's caching profile is not the sub-agent's.

### Deliberately not built

- ~~**No lock ref stored in n8n's Redis.**~~ **REVERSED the same day, and the original reasoning
  is why.** It read *"stashing a bearer credential for a price in the automation layer, for a
  consumer that does not exist yet, buys nothing"* — and the second clause was the load-bearing
  one. The consumer exists now (§ 7), so the ref is stored and the argument no longer holds.
- **No copy table.** Every sentence a customer reads on this path is either the gate's approved
  `reply` or the main agent's. When bargaining cannot answer it sends nothing and hands the turn
  back, rather than inventing a fallback line in a language n8n cannot translate into.
- **No eighth tool.** The playbook's `compatibility:` line declares seven, and the hand-back is a
  routing signal rather than a backend operation.

---

## 9 · Publishing

All four are **published and live**, 2026-09-07. Every failure path on the new branch falls back
to the ordinary agent (§ 5), so a rollback is a convenience rather than the safety net — but the
version history holds each step:

| Workflow | Versions, in order |
|---|---|
| `wi-mall-bargain-tools` | *Skeleton* → *Seven tools behind one door + gate echo* → *Redis echo fails soft* |
| `wi-mall-bargain` | *Skeleton* → *Open + turn branches…* → *Error routing…* → *The seven tools* → *Design notes on canvas* → *An agent error is not a handback* → *Hand the agreed price back for the basket* |
| `wi-mall-core` | *Hand price haggling to wi-mall-bargain* → *Bargaining hand-off: error routing + agent brief* → *The assistant can spend the agreed price* |
| `wi-mall-mcp` | *cart_add_item carries the agreed price* |
