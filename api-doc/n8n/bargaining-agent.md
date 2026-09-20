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
   └─ wi-mall-core · main agent · calls open_negotiation(productId, quantity, 35000)
         └─ wi-mall-bargain [open]  resolve variant → open session → set flag
                                    …and falls straight through into ↓
         └─ wi-mall-bargain [turn]  (same execution, inside the tool call)
              fetch playbook → SYSTEM position, byte-identical
              user turn: subject + language + the customer's words
              Bargain Agent (claude-sonnet-5, 5m prompt caching, shared chat memory)
                 negotiation_context  ← the floor arrives HERE, as a tool result
                 …reads…
                 negotiation_record   ← the gate. Echoes its verdict to Redis
              decide send → sends THE SENTENCE THE GATE APPROVED
              echo answered → Redis, stamped with this messageId
   │        returns { handedOver, negotiable, alreadyAnswered: true }  ← NO PRICES
   │  main agent: "#ANSWERED#" → wi-mall-core reads the echo and sends NOTHING
   │
customer: "40000 et je prends"
   │
   └─ wi-mall-core · check bargain → flag is live → hand to bargainer
         └─ wi-mall-bargain [turn]  → the same loop, and this time it owns the send
   │
   … they agree. The gate mints a lock; `store price lock` leaves the ref in Redis,
   the flag is cleared, and the conversation goes back to wi-mall-core.
   │
customer: "ok, mets-le dans mon panier"
   │
   └─ wi-mall-core · check price lock → the ref is in the system prompt
        main agent · cart_add_item(… , negotiationLockRef) → charged what they agreed
```

⚠ **This used to read "a hand-off costs one conversational turn, deliberately", and that beat
is gone — reversed 2026-09-08, see § 12.** It cost more than the sentence admitted: the
customer's *own price message* was consumed by a turn that answered with a bridging line, so a
customer who had already named their figure was asked to name it again, and a line like *"let
me see what I can do"* promises a follow-up that the design never intended to send. The open
branch now chains into a full bargaining turn, so the first priced answer arrives in the same
turn the customer asked for it.

The shared-memory objection the old paragraph rested on is real and was accepted rather than
solved: the Bargain Agent writes to the shared key from inside the main agent's tool call, so
its turn lands in the transcript *before* the main agent's. What the main agent then writes is
`#ANSWERED#` rather than a sentence nobody saw — the same convention as `#HANDBACK#`, and a
marker is a much better artifact than a phantom.

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
| `revise` with `NEGOTIATION_SESSION_CLOSED` (⭐ the customer pressed **Lock it in** mid-turn) | nothing — hand back | **closed**: the deal is done at `details.agreedPrice`, and the next `negotiation_context` says so through `agreed` |
| gate refused the *call* (session expired / unknown / no longer negotiable) | nothing — hand back | closed |
| no gate call at all | the model's own words | open — a turn with no price in it |
| `#HANDBACK#`, or the agent errored / no playbook | nothing — hand back | closed on `#HANDBACK#` only |

### ⭐ A DEAL NOW HAS TWO CLOSERS — the model, and the customer's own button (2026-09-20)

Every offer the agent makes is drawn with a **Lock it in · 18 000 XAF** button under it, and a
press closes the deal: the backend mints the same price lock the gate mints, and the item goes
into the basket at that price. The owner's rule changed from *"only the model closes a deal"* to
**"the model, or an explicit priced button — never inferred from free text"**. A customer typing
"ok" is still not acceptance; a press on a button that names the price is.

Three consequences for this flow, and the first two are the ones that bite:

- **`negotiation_context` now returns `agreed`** — `{ unitPrice, expiresAt, closedBy }`, non-null
  whenever a live, unspent lock exists for that (customer, variant, quantity). ⚠ It also **resumes**
  that agreed session instead of opening a fresh one, which is what closed the real hazard: the
  press is not a message, so the agent has no memory of it, and it would cheerfully re-open a
  haggle over something already bought. The playbook's step 1a and its new gate-verdict case tell
  it what to do; ⛔ those live in **Mongo**, so `npm run seed:negotiation-playbook` must be re-run
  at deploy or the agent never reads them.
- **`negotiation_record` can lose a race, and it is answered rather than crashed.** Both writers
  compare-and-set on `(status open, round)`. If the press lands while the agent is composing, the
  agent's write is refused, re-read and judged again, and comes back `revise` with
  `code: NEGOTIATION_SESSION_CLOSED` whose `details` now carry **`agreedPrice`** and **`closedBy`**
  — the instruction names the price and tells the model to stop selling and move to delivery. The
  older, useless *"this negotiation is closed"* sentence survives only for a closed session with no
  lock. In the other order the press is the loser and answers the customer *"that offer has changed
  — here is the latest"*, carrying the new offer's own button. Neither side is ever silently
  overwritten and neither gets silence.
- **The lock records `closed_by: 'model' | 'button'`**, so the ledger says which door closed a
  deal. Absent on locks minted before the button existed, which were all the model's.

⚠ **The tap answers on `/catalog/action`, NOT through this flow**, so n8n learns about it from the
response: `data.outcome === "deal_locked"` with `data.negotiation.closed === true`. On that signal
the bargaining flag and the held lock reference must both be cleared — the deploy-day change set
carries it. The server no longer *depends* on that happening (a resumed `agreed` session and a
refusing gate cover it), but a stale flag sends the next typed line to an agent with nothing to do.

⚠ **The echo key is conversation-scoped and stamped with the `messageId`**, and the flow
deletes it after reading. That is not tidiness: **the n8n Redis node's `set` exposes no TTL**
(measured — it is the same limitation that put wi-mall-product-search's query cache in
Postgres). A turn-scoped key would be one key per bargaining message that never expires; a
conversation-scoped key read-and-deleted is at most one per conversation, and the stamp is
what stops a leftover key being read as this turn's verdict.

---

## 5 · Handing back

⚠ **A hand-back is also exactly what a BROKEN hand-off looks like from the outside, and that cost a day of live bargaining — § 11.**

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

All four are **published and live** — 2026-09-07, and re-published 2026-09-08 for § 11 and § 12. Every failure path on the new branch falls back
to the ordinary agent (§ 5), so a rollback is a convenience rather than the safety net — but the
version history holds each step:

| Workflow | Versions, in order |
|---|---|
| `wi-mall-bargain-tools` | *Skeleton* → *Seven tools behind one door + gate echo* → *Redis echo fails soft* |
| `wi-mall-bargain` | *Skeleton* → *Open + turn branches…* → *Error routing…* → *The seven tools* → *Design notes on canvas* → *An agent error is not a handback* → *Hand the agreed price back for the basket* → *open chains into a full turn instead of stopping* (§ 12) |
| `wi-mall-core` | *Hand price haggling to wi-mall-bargain* → *Bargaining hand-off: error routing + agent brief* → *The assistant can spend the agreed price* → *Fix hand-off to bargainer + no-human bridging line* → *Main agent: never imply a human is consulted on price* (§ 11) → *Harden the last bare typed mapping* → *Suppress the main agent when the bargainer has spoken* → *#ANSWERED# handling + alreadyAnswered prompt bullets* (§ 12) |
| `wi-mall-mcp` | *cart_add_item carries the agreed price* |

---

## 10 · Measured on the live flow, 2026-09-07

Everything above was designed; this section is what running it actually showed. Harness:
**`wi-mall-bargain-smoke`** (`3XOEqsGzV51uNOjK`) — type the customer's line into its chat and a
whole turn runs for real, with no WhatsApp conversation needed. The interesting data is always in
the **sub-execution**, not in the harness. ⚠ **It calls `wi-mall-bargain` directly**, so nothing measured below exercised the route from wi-mall-core — which is why § 11 went unseen.

### ✅ The `$fromAI`-in-one-field pattern builds a real schema

The doubt worth resolving before anything else: each tool node packs several `$fromAI()` calls
into one `args` expression rather than one per field, and if n8n only saw one opaque string
parameter the tools would be bad in a way no amount of description could fix.

It does not. n8n collects **every** `$fromAI(` occurrence in a parameter and builds a typed
per-argument schema from all of them. Measured with a throwaway probe:

```
input: { "query": "bluetooth speaker", "maxPrice": 40000, "limit": 3 }
```

Three named parameters, and `maxPrice` arrived as a **number**. So the model's view of these tools
is exactly what an MCP server would give it, and the case for moving them onto one is
architectural (a single source of truth in `tools/catalog.json`) rather than behavioural — see
§ 7's closing note for the three things that would have to move with them.

### ⛔ Nothing on the platform was negotiable, and that is now seeded

Measured immediately after go-live: **thirty active products, twenty-nine vectorisation-enabled,
and zero variants carrying a `bargain` window.** The window is vendor configuration and predates
this effort; nobody had ever set one. So `open_negotiation` would have answered
`negotiable: false` for every product, every customer, every time — a five-stream feature that
looks broken while behaving exactly as designed.

`npm run seed:bargain-windows` fixes it, and places the window the non-obvious way round: the
current price becomes the **ask** (so no shelf price moves) and `variant.price` drops to become
the **floor**. Twelve variants configured at 20% room; the `minPrice === price` invariant holds on
all of them, because every window is built by `resolveBargainWrite` rather than assembled by hand.

### The turn works end to end, and the gate holds

Two turns against *Premium Sofa Set* (floor 48 000, ask 60 000):

| | Customer | Tool loop | Sent |
|---|---|---|---|
| 1 | *"60 000 c'est trop cher. Tu peux faire 50 000 ? Je prends aujourd'hui."* | `negotiation_context` → `negotiation_record` (55 000, `lock: false`, traits) → **approved** | *"50 000 c'est trop bas pour moi, mais vu que tu prends aujourd'hui, je peux faire un geste : 55 000."* |
| 2 | *"Mon budget maximum c'est 30 000. Sinon je laisse tomber."* | `negotiation_context` → `negotiation_record` (48 000) → **approved** | *"Je comprends, mais 30 000 je ne peux vraiment pas… Mon dernier prix, si tu prends aujourd'hui, c'est 48 000."* |

`negotiation_context` was called first both times, unprompted, exactly as the playbook mandates;
the floor reached the model; the sentence the customer received was the one the gate echoed. The
concession in turn 1 was bought by *"je prends aujourd'hui"*, which is iron rule 2 working.

⚠ **The gate's `revise` path is still unexercised**, and not for want of trying. Offered 30 000
against a floor of 48 000, the model refused on its own rather than submitting a sub-floor price.
That is the playbook holding — but it means `decide send`'s revise branch has never run outside a
desk check.

### ⚠ The margin, and this is the finding that matters

Turn 1 gave 5 000. Turn 2 gave 7 000 more and landed **exactly on the floor**. Two rounds, and:

- the vendor is at their bare minimum,
- **the platform's D-5 cut is `30% × (P − floor)` = zero**, and
- there is nothing left to concede if the customer pushes again.

Nothing is broken. The gate did its job — 48 000 is a legal price — and D-5's arithmetic is
correct. What happened is that the model spent its whole room in two moves, against the playbook's
own rule 3 (*never give more than half your remaining room in one move, and make each step smaller
than the last*): 60 000 → 55 000 → 48 000 is 5 000 then 7 000, an **increasing** step straight to
the floor.

**This is a playbook question, not a workflow one**, which is why it is reported here rather than
fixed here: the model decides the price (the plan's first locked decision), the playbook is
Stream A's file in Mongo, and retuning negotiation strategy from the automation layer is exactly
the split this design exists to prevent. The lever is
`src/modules/negotiation/playbook/negotiation.core.md` § 2, re-seeded with
`npm run seed:negotiation-playbook`.

### Latency: ~15 s for a two-tool turn, ~25 s for a five-call one

Measured on turn 1 (15.4 s end to end):

| | |
|---|---|
| `fetch playbook` | 1.32 s |
| model call 1 (decide to open the context) | ~2.3 s |
| `negotiation_context` (sub-workflow + HTTP) | 1.27 s |
| model call 2 (decide the price, compose the reply) | ~5.6 s |
| `negotiation_record` (sub-workflow + HTTP + 2 Redis) | 1.97 s |
| model call 3 (final answer, **discarded** in favour of the gate's) | 1.41 s |
| Redis reads + `decide send` | 0.03 s |
| `send whatsapp` | 1.42 s |

**Roughly 60% is the model**, in three sequential calls — inherent to the tool loop the playbook
mandates, and not something the workflow can shorten. The sub-workflow hop is *not* the cost:
a tool call is ~1.3–2.0 s including the round trip to jovi-mall, which is about what a bare HTTP
node would cost, so switching the seven tools to `toolHttpRequest` for speed would buy nothing and
would cost the typed arguments above.

Two things were considered and **not** done:

- **Caching the playbook in n8n's Redis** (would save the 1.32 s). Rejected for now: the n8n Redis
  node's `set` has no TTL, so a bounded cache needs a parsed expiry and an inline `JSON.parse` in
  an IF condition — four nodes and a fragile expression on the critical path, for 9%, where the
  failure mode is "bargaining stops working". The backend already caches the document in-process
  for 60 s.
- **Shortening the discarded third model call.** Its output is thrown away by `decide send` — but
  it is also what n8n writes into the **shared chat memory**, so making the model answer with a
  token instead of the sentence would put `ok` in the transcript the main agent reads.

`fetch playbook` did get `retryOnFail` (2 tries, 1 s apart): it is on the critical path of every
turn and a transport failure there hands the whole turn back.

⚠ **The customer waits those 15–25 seconds with no acknowledgement.** That is the real
user-facing cost and it is bigger than any second saved above. A typing indicator before the agent
runs (`sendChatAction` on Telegram; the Cloud API's typing indicator on WhatsApp) would change how
it feels far more than the playbook cache would change how long it takes. Not built — it is a
channel feature rather than a bargaining one, and it belongs on `wi-mall-core`'s send path where
every slow turn would benefit, not just this one.

---

## 11 · ⛔ The turn path had never run once — and nothing said so

**Found and closed 2026-09-08, from a live Telegram conversation.** Everything in § 1–§ 10
describes the design correctly. It also describes a path that, between go-live and this fix,
**executed zero times in a real conversation.**

### What the customer saw

A customer asked whether the headphones were negotiable, got the bridging line, offered
10 000 XAF — and got the bridging line **again**, phrased as *"Got it — I've passed along your
offer of 10,000 XAF. Let's see what the seller says!"* Then nothing. Two separate defects, one
in the wiring and one in the prompt.

### Defect 1 — `hand to bargainer` could never start the sub-workflow

`wi-mall-core`'s hand-off node mapped its `customerOffer` input to the **empty-string literal**
`""`, while `wi-mall-bargain`'s `Inbound` declares that field `type: number` — with
`attemptToConvertTypes: false`. n8n validates a typed workflow input *before* the sub-workflow
starts, so every hand-off died at the door:

```
ExpressionError: Invalid input for 'customerOffer' [item 0]
'customerOffer' expects a number but we got ''
```

`read bargain flag` was innocent: it correctly produced `mode: 'turn'` and `bargaining: true`,
and `bargaining?` correctly routed. The call was rejected one node later.

**Why it stayed invisible for a day of live traffic, and this is the part worth keeping.** Three
mechanisms, each individually correct, compounded:

1. `hand to bargainer` is `continueErrorOutput` wired to the ordinary agent path — § 5's designed
   degradation. The customer was answered, at the asking price, exactly as intended for a
   *hand-back*. The error was indistinguishable from one.
2. Because the customer was served, **the n8n execution was recorded `success`** — the ADR-022
   trap, in the workflow ADR-022 was written about.
3. The main agent then saw a price push with no live flag, called `open_negotiation` again, and
   re-sent the bridging line. To a reader the bot looks like it is working and merely repeating
   itself.

⚠ **And the smoke harness could not have caught it.** `wi-mall-bargain-smoke`
(`3XOEqsGzV51uNOjK`) calls `wi-mall-bargain` **directly** with a real number in the envelope, so
it exercises everything downstream of the broken mapping and nothing at the mapping itself. Every
measurement in § 10 was taken through it. *"The turn works end to end"* there means the
sub-workflow works end to end — it was never evidence about the route from `wi-mall-core`.

**The fix**, `wi-mall-core` version *Fix hand-off to bargainer + no-human bridging line*:

| | |
|---|---|
| `hand to bargainer` · `customerOffer` | `""` → `={{ Number($json.customerOffer) || 0 }}` — total by construction: missing, empty, `null` and a string all coerce, and `NaN \|\| 0` is `0` |
| **new** `report bargain down` | on the node's **error** output, beside the fall-through to `is media?`. Same shape as `report agent down` / `report outage`: `kind: degraded_turn` to wi-admin's `/api/internal/automation/failures`, 3 s timeout, `neverError`, `continueRegularOutput`, highest `y` on the canvas so the customer's reply is composed and sent first |

Zero is the right value on the turn path rather than a real figure: the bargaining model reads the
customer's offer out of their own words and passes it to `negotiation_context` /
`negotiation_record` itself. The envelope's `customerOffer` is consumed **only in `open` mode**,
where it comes from the main agent's tool call.

`report bargain down` is the durable half. The mapping bug is closed; what stops the *next* one
being invisible for a day is that a failed hand-off now reaches the failure board within a turn.
It fires on a genuine node error only — a `handled: false` hand-back is the designed degradation
and is deliberately **not** reported, or the board would fill with healthy turns.

### Defect 2 — the prompt supplied the vocabulary it then forbade

The main agent's brief said *"the **seller** decides — not you"* and *"do not guess what the
**seller** will say"*, then two lines later *"never mention that another seller, agent or system
is involved"*. The model did what the nearer, more concrete words told it to and announced that
the offer had been passed to a seller who would answer — inventing a human where there is none,
and implying a wait that would never end.

The playbook was never the problem: `negotiation.core.md` opens with *"You are the seller"* and
its ⛔ list already forbids inventing *"a 'manager' you'll check with"*. The bargaining model
would never have said it. Only wi-mall-core's brief treated the far side as a third party.

Rewritten in version *Main agent: never imply a human is consulted on price*: the authority is
impersonal (*"settled elsewhere"*), the bridging line carries two first-person worked examples
(*"Let me see what I can do on the price." / "Je regarde ce que je peux faire sur le prix."*), and
an explicit block bans passing / forwarding / relaying wording and any promise that someone will
get back to the customer. One further line stops it repeating the bridging line or re-calling
`open_negotiation` after a hand-back — the visible symptom of defect 1, which should never recur
but costs nothing to guard.

Everything outside the `## HAGGLING OVER PRICE` section is byte-identical, per § 2.

### What was already right

`bargain handled?`'s **true** output has no connection at all — the turn ends there. Once the
sub-agent has sent, the main agent cannot answer the same message. That was correctly wired from
the start; it had simply never been reachable.

---

## 12 · ✅ The hand-off no longer costs a turn — and the main agent goes quiet

**Changed 2026-09-08, from the same live conversation that produced § 11.** With the wiring
fixed, the *designed* behaviour turned out to be the remaining defect.

### What was wrong with the design, not the code

The customer asked about the price, was told *"let me see what I can do on the price"*, and then
**waited** — because that sentence promises a follow-up. None was coming: the design answers the
*next* message, not that one. They had to prod with *"Okay"* before the bargainer said anything.

Two separate costs, and § 1's old paragraph only admitted the first:

1. a wasted conversational beat; and
2. **the customer's own price message was consumed by it.** They had already said 10K. The
   bridging line spent that turn asking, in effect, for something they had just given.

No wording fixes (2). A bridging line that *invites* (*"tell me what you had in mind"*) is honest
but redundant when the figure is already on the table.

### What it does now

`set bargain flag` feeds `fetch playbook` instead of `shape handover`, so an `open` run resolves
the variant, opens the session, sets the routing flag **and then runs a whole bargaining turn**,
all inside the `open_negotiation` tool call. The customer gets a real counter-offer in the turn
they asked. Only the **success** branch chains; `variant found? false` and `session opened? false`
still stop at `shape handover`, which is why `return to core` can assert `handedOver: true` when
it is reached in open mode.

### The part that took the design work: one message, not two

An agent node always produces a final answer. So chaining alone means the customer receives the
negotiated price **and** a bridging line about looking at the price. The turn needs exactly one
sender.

⛔ **The rejected alternative was to let the bargainer stay silent on the open turn and have the
main agent relay its sentence.** It is the simpler wiring — the tool's return value is a natural
channel and needs no Redis at all — and it was declined for two reasons. It puts a second LLM
between `negotiation_record` and the customer, which is the exact failure § 4's gate echo exists
to make impossible (*"told to is not cannot otherwise"*); the first priced sentence of every
negotiation is the one that anchors the haggle, and a paraphrase can round it, re-language it or
re-attach the "seller" the main agent was just taught not to mention. And it is the pattern the
owner has ruled against three times — *"the automation layer does not process, transform or
compose anything"* (`bot-relays-never-renders`); when the platform's wording is fixed, it is
composed end to end and relayed, never narrated.

So the bargainer keeps the pen and **wi-mall-core drops its own reply** instead, on two
independent signals:

| Signal | Where | Nature |
|---|---|---|
| `wi-mall:bargain:answered:{channel}:{externalId}` | `echo answered` writes it, `read bargain echo` → `clear bargain echo` → `drop duplicate reply` consume it | **authoritative.** Mechanical, same discipline as the gate echo: stamped with the `messageId`, carrying its own expiry (the Redis node's `set` has no TTL), deleted on read |
| `#ANSWERED#` | the prompt asks for it on `alreadyAnswered: true`; `compose agent reply` acts on it | belt-and-braces, and it puts a marker in the shared transcript instead of a sentence nobody saw. Mirrors `#HANDBACK#` |

⚠ **`echo answered` sits AFTER the send, not before.** Its presence has to mean the customer
really has the message. Before the send, a Telegram or Meta 4xx would buy silence — the
bargainer's reply lost *and* the main agent's suppressed — instead of a duplicate. With it after,
a failed send never writes the echo, the tool errors, and the main agent's own line goes out.

Everything else fails the same direction: both Redis nodes are `continueRegularOutput`, and
`drop duplicate reply` suppresses **only** on a live echo whose `messageId` matches this turn. A
malformed, stale or mismatched echo is not an answer. With Redis unreachable the customer keeps
the counter-offer and also gets a bridging line — an extra message, never silence.

### Deploy order, and why it was safe either way

**wi-mall-core first, then wi-mall-bargain.** Core's half is inert until something writes the
echo, and its prompt change alone lands in the *good* interim state: the bridging line stops
promising a follow-up and invites the figure instead. The reverse order would have shipped a
window where every negotiation opened with two messages.

### Known artifacts

- **The Bargain Agent writes to the shared memory before the main agent does**, because it runs
  inside the main agent's tool call. The transcript for that turn reads bargain-input,
  bargain-reply, customer-message, `#ANSWERED#`. Accepted, and the § 1 paragraph explains why
  the marker is the better half of the trade.
- **`agent fallback` does not consult the echo.** If the model errors *after* a successful
  `open_negotiation`, the customer gets the counter-offer plus the backend's
  `assistantUnavailable` sentence. Narrow, harmless, and it costs nothing about price.
- **A `#HANDBACK#` on an open-mode turn** clears the routing flag that the same execution just
  set. The main agent is told `handedOver: true, alreadyAnswered: false`, says the invitation
  line, and handles the next message itself. Consistent with what `#HANDBACK#` means.
- **Latency moved rather than grew.** The whole 15–25 s bargaining turn now happens inside the
  main agent's tool call, so the customer waits once instead of twice — but that single wait is
  long and unacknowledged, which is § 10's typing-indicator note becoming more pressing, not less.
