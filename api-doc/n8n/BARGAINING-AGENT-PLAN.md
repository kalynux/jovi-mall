# The bargaining agent — build plan for parallel sessions

**Status:** ▶ IN FLIGHT. Started 2026-09-07.
**Read this whole file before writing a line.** It exists because four sessions are
building one feature at the same time, and the contracts below are what stop them
producing four incompatible halves.

> **If you are a session that was handed a stream letter, read § 1–4 in full, then
> your own stream in § 6, then § 7. Do not read only your own stream.**

---

## 1 · What this is

A customer haggling over a price in chat is handed to a **bargaining sub-agent** — a
separate n8n AI agent with its own playbook, its own tools, and its own output back to
the channel. It negotiates within a window the vendor configured, and the price it
agrees becomes the price the customer pays.

**The model decides the price. The backend is a ledger and a gate.** That is the owner's
decision (2026-09-07) and it is the single most important thing on this page. jovi-mall
does **not** compute a concession schedule, a reserve, a "strategic last price" or an
"emergency rescue price". It hands over two numbers and refuses anything outside them.

---

## 2 · What already exists (do not rebuild)

| | Where | Status |
|---|---|---|
| The vendor's price window `bargain: { minPrice, maxPrice }` | `catalog/domain/services/bargain-price.rule.ts` | ✅ shipped long before this effort |
| The window reaching the AI index | `VectorisationService` → `metadata.bargain_windows` | ✅ |
| The window being **stripped** from customer-facing search | `product_search()` in `product_vectors.sql`, plus n8n's `Shape Result` allowlist | ✅ — see § 4, this is deliberately reversed for the sub-agent only |
| The **playbook**, stored in Mongo and served over HTTP | `modules/negotiation/` — model, repository, service, `GET /api/internal/negotiation/playbook`, `npm run seed:negotiation-playbook` | ✅ built 2026-09-07, `test:negotiation-playbook` 26/0 |
| Main agent brain on `claude-sonnet-5` with prompt caching | n8n `wi-mall-core`, node `Anthropic Chat Model` (typeVersion **1.6**) | ✅ live |

---

## 3 · The locked decisions

Every one of these was taken by the product owner. **Do not relitigate them in code.**
If one looks wrong, say so — do not quietly build the other thing.

**D-1 · The displayed price becomes `bargain.maxPrice`.** Today the storefront quotes
`variant.price`. After this, a bargainable variant is shelved at its **ask** and
`variant.price` becomes the **floor** — the number the vendor will never go below. A
non-bargainable variant is unchanged.

**D-2 · The model is given the REAL floor and the REAL ask.** No derived
`system_minimum`, no reserve. The owner considered withholding the floor and declined:
the playbook plus the gate are the control. ⚠ This **reverses** the rule enforced in two
places today (the SQL strip and the n8n allowlist) — those stay in force for the *main*
agent and are lifted only for the bargaining sub-agent, through its own tool. Record it
as a decision, never as an oversight.

**D-3 · The gate validates exactly three things.** `floor ≤ P ≤ ask`; `P ≤ the previous
counter on this line`; the session is live. Nothing else. It does not know or check the
model's own ladder.

**D-4 · The gate runs BEFORE the reply reaches the customer**, not at cart time. A
rejected price is re-drafted; the customer never sees a price the cart cannot honour.
The `PriceResolverService` guard stays as a backstop and should never fire.

**D-5 · The platform keeps 30% of the uplift.** `U = (P − floor) × qty`,
`aiMargin = floor(0.30 × U)`, `vendorGross = (P × qty) − aiMargin`. It funds the model
spend. **Only on orders carrying a negotiation lock** — a storefront sale at the ask used
no AI and the whole uplift is the vendor's.

**D-6 · Bargaining is chat-only.** No "make an offer" control on the storefront.

**D-7 · Delivery is already free to the customer and no change is needed.**
`order.total_amount` is the item subtotal; the agency fee comes out of the vendor's net in
`splitOrder`. `cart-quote.service.ts` reports it as `absorbedByVendor` for information.
The agent may promise free delivery truthfully. ⚠ **Never surface `absorbedByVendor` to a
customer.**

**D-8 · The negotiated price is a per-session LOCK. It never touches the variant.**
Writing `variant.price` would move `bargain.minPrice` with it (`resolveBargainWrite`
auto-syncs), ratcheting the floor permanently for every customer.

**D-9 · The sub-agent returns a STRUCTURED response, and there is no sticky "final".**
Owner decision, 2026-09-07, closing what was open as O-1. A declared `final` does **not**
bind later turns: a haggle carries a different price in every exchange, so the only price
the gate has an opinion about is the one on the reply in front of it.

`negotiation_record` therefore takes a structured payload, never prose to be parsed:

```jsonc
{
  "sessionId": "...",
  "reply": "…the sentence the customer will read…",
  "agentProposedPrice": 41000,   // judged EVERY turn against floor/ask + non-increasing
  "lock": false,                 // the AGENT decides; true = this is the order price
  "profile": { /* the behavioural judgements, persisted and fed back */ }
}
```

Two properties follow:

- **`agentProposedPrice` is validated on every turn**, not only when locking. That is
  D-4 — the gate runs before the customer sees the sentence, so a price the cart could
  not honour is never spoken.
- **`lock` is the agent's call, not an inference.** The backend does not guess from the
  wording that a deal closed. When `lock: true` the gate mints the single-use price lock
  in the *same* call that validated the price, so there is no second unvalidated step.

⚠ Iron rule 1 of the playbook (non-increasing) is unaffected and still enforced — that is
about direction within a line, not about a promise that binds across turns.

**D-10 · The lock is RE-VALIDATED when it is consumed, and may be refused there.**
Owner decision, 2026-09-07. At checkout `PriceResolverService` re-reads `variant.price`
and `bargain.maxPrice` **as they stand then** and refuses a lock whose price now falls
outside the window — a vendor is never paid below their current floor, even for a price
their old floor allowed.

⚠ **This deliberately accepts the failure D-4 exists to prevent**, and the alternative
(honouring the lock) was considered and declined. A customer who was quoted 38 000 can be
refused at checkout because the vendor raised the floor to 40 000 in the meantime, having
done nothing wrong themselves. Two obligations follow, and neither is optional:

- **Keep `NEGOTIATION_LOCK_TTL_MINUTES` short.** The TTL is the entire window in which a
  vendor edit can strand a promised price. Minutes, not hours.
- **The refusal must be RECOVERABLE, never a generic error.** It gets its own code
  (`NEGOTIATION_LOCK_WINDOW_MOVED`, Stream C) so the chat can say "the seller just changed
  this price — let me re-check for you" and reopen the negotiation, rather than dead-ending
  a customer on `An unexpected error occurred`. A bare 422 here is the worst version of
  this decision.

**D-11 · The lock is read through a PORT. Stream C writes the interface, Stream A
implements it and does the checking.** Answering Session 3, 2026-09-07.

A direct import would close a **require cycle**: `negotiation` needs `catalog` to read the
window at gate time, and `catalog/PriceResolverService` would need `negotiation` to check
the lock. This service has been broken by exactly that before — see `modules/agents/index.ts`
on the barrel that crashed the boot with *"AuthService is not a constructor"*.

The house pattern for this seam already exists: `agents/ports/device-location.port.ts` plus
`agent.bootstrap.ts`. Copy it.

- **Stream C** defines `catalog/domain/ports/negotiated-price.port.ts` — the interface and a
  `setNegotiatedPriceResolver()` registrar — and calls it from `PriceResolverService`. C can
  build and test against a fake implementation immediately; it is **not blocked on A**.
- **Stream A** implements it in `modules/negotiation/` and registers it from a
  `negotiation.bootstrap.ts` called by `lifecycle.ts`.

Two operations, not one:

```ts
peek(lockRef, { customerId, variantId, quantity }): Promise<LockVerdict>
consume(lockRef, ctx, session: ClientSession): Promise<LockVerdict>
```

```ts
type LockVerdict =
  | { ok: true; unitPrice: number; floorSnapshot: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'consumed' | 'mismatch' | 'window_moved' };
```

**The verdict is A's; the error mapping is C's.** A decides — including D-10's window
re-read, which must NOT be duplicated in `catalog` — and C maps `reason` onto the
`NEGOTIATION_LOCK_*` codes allocated to it in § 5. Two modules interpreting one lock is the
drift this split exists to prevent.

⚠ **An unregistered port must REFUSE a presented lock, never ignore it.** Silently falling
back to the list price would charge a customer more than they agreed, which is the one
failure direction nobody would report as a bug.

**D-12 · The lock is consumed at ORDER CREATION, not at add-to-cart.** Answering Session 3,
2026-09-07. `peek` at add-to-cart writes the negotiated price and `floor_price_snapshot`
onto the line; `consume` runs inside the order-creation transaction. So a customer may
remove and re-add the item, or leave the basket overnight, without losing the price they
haggled for — and a failed order does not burn the lock.

⚠ **This is more work than it looks, and a comment in the codebase will mislead you.**
`cart.service.ts` states *"The price a cart quotes is re-resolved at checkout, which is the
moment that actually binds."* **It is not.** `order.service.ts` reads `cartItem.price` —
the snapshot — and never calls `PriceResolverService`; the only other call site is
`mergeCart`. So order creation has **no re-resolution step today** and Stream C must add
one. Scope it to lines carrying a lock: re-resolving every line would change ordinary
checkout behaviour, which is not in this plan's scope. Fix the comment while you are there.

---

## 4 · The invariants — assert these, do not assume them

1. **`vendorGross ≥ floor × qty`, always.** `vendorGross = 0.7·P + 0.3·floor` per unit, so
   the AI margin can never push a vendor below the number they set themselves. This is
   what guarantees D-5 cannot newly trip `EARNINGS_INVALID_SPLIT`.
2. **A counter never increases** within one (session, variant, quantity) line. A new
   quantity or variant is a new line and starts fresh.
3. **`floor === variant.price` and `ask === bargain.maxPrice`**, re-read at gate time.
   A vendor editing the price mid-negotiation must not be exploitable.
4. **The lock is single-use** and bound to (customer, variant, quantity, expiry).
5. **Reconciliation still balances:**
   `gross = aiMargin + commission + vendorNet + Σ(agency + agent + vendor-refund)`.
6. **The playbook is served byte-identically** across turns, or Anthropic prompt caching
   never hits. Nothing may interpolate a customer, a product or a price into it.

---

## 5 · The registry allocations — take ONLY yours

⚠ **This is the section that stops the four sessions clobbering each other.** These files
are shared and are read-modify-write: `core/error-codes.ts`, `core/errors.ts`,
`core/database/collections.ts`, `api/index.ts`, `package.json`, `.env.example`.

**Rules:** append only; use an **anchored** edit (match on a neighbouring line, never a
line number); re-read the file immediately before editing; never reformat.

### Error codes (`NEGOTIATION_*`)

| Code | Stream | Status |
|---|---|---|
| `NEGOTIATION_PLAYBOOK_NOT_PUBLISHED` | — | ✅ exists |
| `NEGOTIATION_SESSION_NOT_FOUND` · `NEGOTIATION_SESSION_EXPIRED` · `NEGOTIATION_SESSION_CLOSED` | **A** | to add |
| `NEGOTIATION_PRICE_BELOW_FLOOR` · `NEGOTIATION_PRICE_ABOVE_ASK` · `NEGOTIATION_PRICE_INCREASED` | **A** | to add |
| `NEGOTIATION_NOT_BARGAINABLE` | **A** | to add |
| `NEGOTIATION_LOCK_INVALID` · `NEGOTIATION_LOCK_CONSUMED` · `NEGOTIATION_LOCK_EXPIRED` · `NEGOTIATION_LOCK_VARIANT_MISMATCH` · `NEGOTIATION_LOCK_WINDOW_MOVED` | **C** | to add |
| `NEGOTIATION_TOOL_SUBJECT_REQUIRED` · `NEGOTIATION_PROMOTIONS_UNAVAILABLE` | **B** | to add |

Every code needs a `DEFAULT_ERROR_MESSAGES` entry in `core/errors.ts` — `test:errors` § 8
fails a code that would render "An unexpected error occurred". Categories are **derived**
from `(code, statusCode)`; never annotate one.

### Collections / models

| | Stream |
|---|---|
| `NEGOTIATION_PLAYBOOK` / `negotiation_playbooks` | ✅ exists |
| `NEGOTIATION_SESSION` / `negotiation_sessions` | **A** |
| `NEGOTIATION_PROFILE` / `negotiation_profiles` | **A** |

### npm scripts

`test:negotiation` (A) · `test:negotiation-tools` (B) · `test:negotiation-pricing` (C+E)
· extend the existing `test:public-catalog` (D). `test:negotiation-playbook` exists.

### Environment variables

`NEGOTIATION_PLAYBOOK_KEY`, `NEGOTIATION_PLAYBOOK_CACHE_TTL_SECONDS` ✅ exist.
`NEGOTIATION_SESSION_TTL_MINUTES`, `NEGOTIATION_LOCK_TTL_MINUTES` (**A**);
`NEGOTIATION_AI_MARGIN_PERCENT` (**C+E**).
⚠ `test:env` asserts `.env.example` in **both directions** — an undocumented variable
fails, and so does a documented one nothing reads.

---

## 6 · The streams

### Stream A — the module: session, profile, gate  ⟵ owner session

**Files:** `src/modules/negotiation/{models,repositories,services,controllers,routes,domain}/`
(the `playbook*` files there are done — do not edit them).

Build:

- **`NegotiationSession`** — one per (customer, variant, quantity). Rounds, every offer
  both ways, the current counter, state, `expiresAt`. (No `declaredFinalAt` — see D-9.)
- **`NegotiationProfile`** — durable, per customer, **outliving the chat memory**. Holds
  the behavioural judgements the sub-agent returns (`intent`, `tone`, `rhythm`,
  `negotiation_style`, `trust_level`, `price_sensitivity`, `walkaway_confidence`,
  `strategic_last_price`, `emergency_rescue_price`, …). A customer returning months later
  is recognised from this.
- **`negotiation_context`** (in) — floor, ask, currency, round count, every prior offer,
  the durable profile, purchase-history summary.
- **`negotiation_record`** (out) — **the gate**. Takes the D-9 structured payload,
  validates D-3, enforces invariant 2, persists the reply + state + returned profile,
  mints the lock when `lock: true`, and returns `approved | revise` with a reason.

**Owns:** the `PriceLock` and the `LockVerdict` decision — issue the lock, and implement
Stream C's port (D-11). Register it from `negotiation.bootstrap.ts` in `lifecycle.ts`.

**Tests (`test:negotiation`, no DB):** the gate's whole decision table; the
non-increasing clamp against **stored** state, not a recomputation; a source scan that no
handler returns `floor`/`ask` to anything but the sub-agent's own tool.

---

### Stream B — the five read tools

**Files:** new controllers/routes under `src/modules/negotiation/`; may add a projection
to `catalog/`. **Must not touch** `PriceResolverService`, `earnings-split.service.ts`,
`public-catalog.repository.mongo.ts`, or any session/gate file.

| Tool | Notes |
|---|---|
| `get_product_details` | Variants, per-variant window, real stock, images. The agent's truth source — every factual claim must come from here. Add it even though the main agent hands a payload over: the hand-off is composed by a model, the customer can switch product mid-negotiation, and a returning customer has no hand-off at all. |
| `find_alternative_product` | **Price-bounded** substitute search. `product_search()` already takes `p_price_max`, `p_in_stock_only`, `p_country`, `p_product_type`, `p_category` — this is a parameterisation, not new search work. Return each hit's bargainable flag **and window**, so the agent can pivot into a fresh negotiation. |
| `find_complementary_products` | Bundle candidates. Same kernel. **Named "complementary", not "compatibility"** — the database cannot answer a technical fit question and a model will treat the name as a capability. |
| `quote_delivery` | ⚠ **Re-scoped by D-7.** There is no fee to quote and no waiver to grant — delivery is already free to the customer. This reports the delivery **promise**: deliverable, by which agency, and when if the agency policy model supports it. Confirm what it actually supports; do not invent an ETA. Never surface `absorbedByVendor`. |
| `check_promotion` | **Stub, returns `{ available: false }`.** There is no coupon model — `cart-quote.service.ts:75` pins `price_breakdown.discount` to zero. The playbook forbids mentioning promotions; the tool exists so the model asks rather than invents. |

**Tests (`test:negotiation-tools`):** the price bound is really applied; a stub that
cannot accidentally report a promotion; a leak assertion that no response carries
`absorbedByVendor`.

---

### Stream C+E — the price lock and the money split

**One session, because E needs the field names C defines.**

**Files:** `catalog/domain/services/pricing-inventory/PriceResolverService.ts`,
`cart/models/cart.model.ts`, `cart/services/cart.service.ts`,
`orders/order.model.ts`, `orders/order.service.ts`,
`earnings/services/earnings-split.service.ts`.
**Must not touch** anything under `modules/negotiation/`.

**C — the lock seam.** `PriceResolverService` is the one place a unit price is decided.
It accepts an optional lock and honours it **only** when: the session is live, it matches
customer + variant + quantity, it is unconsumed and unexpired, and `floor ≤ P ≤ ask`
re-checked against the **currently stored** window. The cart line snapshots
`negotiated_unit_price` **and `floor_price_snapshot`** — E needs the floor, and re-reading
it at split time would read a number the vendor may since have changed.

**E — the split.** Add a third allocation, `beneficiary_type: 'platform_ai'`, in **both**
`splitOrder` (prepaid) and `splitCodCollection` (COD). Per line:
`U = (P − floor) × qty`, `aiMargin = floor(0.30 × U)`,
`vendorGross = (P × qty) − aiMargin`, then commission and delivery come off `vendorGross`
exactly as today. Amend the reconciliation invariant in **both** docstrings.

⚠ Compute `vendorGross = P − aiMargin` rather than `floor + 0.7·U` — the two differ by a
franc after flooring and only the first reconciles exactly.
⚠ An order can mix negotiated and un-negotiated lines. The order-level margin is the sum
of the per-line margins.

**Tests (`test:negotiation-pricing`, no DB):** the arithmetic incl. rounding; invariant 1
(`vendorGross ≥ floor × qty`) over the whole window; reconciliation on a mixed cart; a
source scan that both split paths carry the third allocation.

---

### Stream D — the storefront flip

**Files:** `catalog/repositories/mongo/public-catalog.repository.mongo.ts`,
the public DTOs, `catalog/read-models/`. **Must not touch** anything else on this page.

A bargainable variant is displayed at `bargain.maxPrice`; everything else is unchanged.

⚠ **The trap:** `price`, `priceMin`, `priceMax`, the `price_asc`/`price_desc` sorts and
the `minPrice`/`maxPrice` filters all derive from `_defaultVariant.price`. If display flips
and they do not, a customer filtering "under 40 000" is shown a product displaying 45 000.
**All of it moves together or the feature ships broken.**

`bargainable` is already on the variant read model (`isBargainEffective`). ⚠ Never expose
`bargain.minPrice` on a public route — it is the floor.

**Tests:** extend `test:public-catalog` — the displayed price, the sort, the filter band,
and a leak assertion that no public DTO carries `minPrice`. Then `verify:storefront`.

---

### Stream F — the n8n bargaining sub-agent  ⟵ LAST, after B publishes its contracts

**Not parallel with the rest.** It can start on the skeleton — hand-off from
`wi-mall-core`, the playbook fetch (`GET /api/internal/negotiation/playbook`, header
`X-Service-Token`), the `lmChatAnthropic` **typeVersion 1.6** node with
`promptCaching: '5m'`, shared Redis chat memory keyed on the same `externalId` as the main
agent, and the channel output. The seven tool nodes wait for B and A.

⚠ **The playbook goes in the SYSTEM position, byte-identical every turn.** Per-customer
context goes in the user turn. Interpolating the profile into the system prompt breaks
prompt caching and multiplies the bill roughly tenfold for identical behaviour.
⚠ `wi-mall-core` is **active and serving real customers.** Use `update_workflow`
operations, never a wholesale replace, and give every change a `versionName`.

---

## 7 · Rules every stream follows

1. **Read `jovi-mall/CLAUDE.md` first.** `createAppError` only, `next(error)` only, no
   `throw new Error()`, no `res.status().json({ error })`, no bare `new RegExp()`.
2. **Tests are hand-rolled `assert()` scripts under `scripts/test/`** run through ts-node.
   There is no Jest. Follow the neighbouring suites.
3. **Run `npm run typecheck` AND `npm run typecheck:scripts`.** The first covers only
   `src/**`; a broken test compiles-and-exits-0 without the second.
4. **`test:env`, `test:errors` and `test:system` are shared guards.** Run all three before
   you finish, whatever you touched.
5. **Another session is editing this tree right now.** Re-read a shared registry
   immediately before editing it, and use anchored edits.
6. **Do not edit another stream's files.** If you need a change there, write it in § 8.
7. **Pre-production: no data migrations** (D-5, 2026-08-21). Index migrations only; fix
   the seed instead of backfilling.
8. **Update § 8 when you finish**, with what you built, what you deviated from and why,
   and anything you found that another stream needs.

---

### PUBLISHED — the lock shape (Stream A → Stream C)

Fixed 2026-09-07, per D-11's instruction to publish it here as soon as it was.

```ts
// Embedded on the negotiation session; issued only when the model sends lock: true.
interface INegotiationLock {
  ref: string;                 // "nlk_" + 16 random bytes hex. THIS is what the cart presents.
  unit_price: number;          // per unit, agreed, whole XAF
  floor_snapshot: number;      // variant.price at the moment of agreement — E's uplift basis
  issued_at: Date;
  expires_at: Date;            // NEGOTIATION_LOCK_TTL_MINUTES, default 20
  consumed_at?: Date | null;   // null = still spendable
  consumed_by_order_id?: ObjectId | null;
}
```

Three things Stream C should build against:

- **`ref` is NOT the session id.** A session id is guessable from a listing and appears
  in logs; a lock is a bearer credential for a price. Pass `ref`, never the session id.
- **`floor_snapshot` is taken at agreement time and is E's uplift basis.** Do not
  re-read `variant.price` at split time — the vendor may have changed it, and the 30%
  would then be computed against a number nobody agreed to.
- **A returns the `LockVerdict`, C maps it to codes.** Give me the port interface
  (`peek` / `consume`) and I will implement it against these fields; `window_moved` is
  the D-10 refusal and it is mine to decide, not yours to re-derive.

---

## 8 · Close-out register

| Stream | Status | Notes |
|---|---|---|
| Playbook store | ✅ done 2026-09-07 | `test:negotiation-playbook` 26/0; v1 published, 16 087 chars |
| Brain → Sonnet 5 | ✅ done 2026-09-07 | `wi-mall-core`, prompt caching 5m |
| A | ✅ core done 2026-09-07 | Session + durable profile + the gate, `test:negotiation` **35/0**. `POST /internal/negotiation/{context,record}`. ⏳ REMAINING: implement Stream C's port once C publishes the interface (D-11). |
| B | ✅ done 2026-09-07 | All five read tools at `POST /internal/negotiation/tools/*`, `test:negotiation-tools` **50/0**. Contract published: [negotiation-tools.md](./negotiation-tools.md) — **Stream F is unblocked on B**. ⚠ Read the notes: the search kernel is **Mongo, not `product_search()`**, and two tools stayed re-scoped. |
| C+E | ✅ done 2026-09-07 | The lock seam + the third allocation, `test:negotiation-pricing` **63/0**. Port published below — **Stream A is unblocked**. ⚠ Read the notes: D's handed-over gap is **closed**, and `test:bargain-price`'s scope guarantee was **narrowed, not deleted**. |
| D | ✅ done 2026-09-07 | The flip, with all five derivations moved together. `test:public-catalog` **148/0** (was 100), `verify:storefront` **47/0** (was 36). ⚠ Read the notes — **one gap belongs to C+E and it is load-bearing for D-5**. |
| F | ✅ done 2026-09-07 | Two new n8n workflows (`wi-mall-bargain`, `wi-mall-bargain-tools`) plus a surgical edit to `wi-mall-core` — **all three published and LIVE**. Record: [bargaining-agent.md](./bargaining-agent.md). ⚠ Read the notes: **the lock cannot reach the cart yet** — `cart_add_item` in `tools/catalog.json` has no `negotiationLockRef`, and that belongs to nobody on this plan. |

---

### Stream B — close-out notes

**Built.** Eight new files under `src/modules/negotiation/` — three pure `domain/` rules
(`negotiation-tool-view.ts`, `delivery-promise.ts`, `negotiation-tool-subject.ts`), one
repository, one service, one controller, one validator, one router — plus
`scripts/test/test-negotiation-tools.ts`. Registry edits: the two allocated error codes + their
`DEFAULT_ERROR_MESSAGES` entries, and the `test:negotiation-tools` script. **No environment
variable** (§ 5 allocates none to B, and nothing here reads one). No migration, no model.

`typecheck` · `typecheck:scripts` · `lint` · `test:negotiation-tools` 50/0 · `test:env` 38/0 ·
`test:errors` 74/0 · `test:system` 231/0.

| Tool | Route |
|---|---|
| `get_product_details` | `POST /internal/negotiation/tools/product-details` |
| `find_alternative_product` | `POST …/alternatives` |
| `find_complementary_products` | `POST …/complements` |
| `quote_delivery` | `POST …/delivery-promise` |
| `check_promotion` | `POST …/promotion` |

**Mounted as a sub-router of A's `internal-negotiation.routes.ts`**, so it inherits that
mount's `requireServiceToken` — one door, one credential, no second place to forget the guard.
A source scan asserts the guard is declared *above* the mount. ⚠ I amended that file's "no
personal data, **no prices** and no vendor identifiers" claim, which is true of `/playbook` and
false of `/tools`: these routes return prices, stock and the vendor's floor.

---

#### ⚠ The search kernel is MONGO, not `product_search()` — the plan's wording is not buildable here

§ 6 says the substitute search "is a parameterisation, not new search work" of
`product_search()`. **It could not be**, for two independent reasons, and both were verified
rather than assumed:

1. **jovi-mall has no Postgres client at all.** `package.json` has no `pg`, no `postgres`, no
   ORM — `product_search()` lives in the Postgres behind n8n's credential, and this service has
   no route to it. Adding one to serve five tools would be a new infrastructure dependency and
   a second catalogue read path.
2. **`product_search()` structurally cannot return what the tool must return.** Its `fused` CTE
   does `pv.metadata - 'bargain_windows'` — the strip is *inside the function*, by design, and
   its own header says a server-side caller needing the window "reads the row directly and does
   not come through this function". The plan requires each hit to carry "the bargainable flag
   **and window**". Those two sentences cannot both hold through that function.

So `NegotiationCatalogRepositoryMongo` does the price-bounded search over Mongo, through the
**same `$text` index the storefront's own search uses** and the **same
`publishableProductFilter()` / `VENDOR_PUBLISHABLE_MATCH`** predicate, imported rather than
re-expressed — so a product the sub-agent offers and the storefront has taken down is not a
state this can produce. `public-catalog.repository.mongo.ts` was **not** touched (Stream D's
file); the shared thing is the predicate, not the class.

**The consequence for Stream F, and it is the one to know:** the sub-agent's substitute search
and the main agent's `product_search` are **two different retrieval engines**. Mongo `$text` is
whole-word and lexical — no semantic arm, no trigram arm, so it does not tolerate a typo the
way the hybrid index does. It is the right trade here (a bargaining agent already knows the
product and is filtering by budget, where the main agent is searching from a phrase), but do
not expect identical result sets from identical phrases.

---

#### The two re-scoped tools stayed re-scoped

**`quote_delivery` reports no date, and that is now a CHECKED claim.** The plan said to confirm
what the agency policy model supports and not to invent an ETA. **It supports none** —
`IAgencyPolicies` is `pricing · returns · damage · cod · documents`, and there is no lead time,
SLA, schedule or per-region window on the agency or on its Magazin. `eta` is a hardcoded `null`
beside an `etaBasis` sentence, rather than an omitted key: an absent field invites a model to
fill the gap from what delivery "usually" takes. `test:negotiation-tools` § 6 **fails if a
lead-time field is ever added to `IAgencyPolicies`**, so the `null` gets revisited instead of
quietly going stale.

`coversRegion` is three-valued — `null` when no region was named *or* when the agency published
no coverage list. Collapsing that to `false` would have the agent tell a customer their town is
not served on the strength of an empty array nobody filled in.

**`check_promotion` still cannot report a promotion**, and a source scan refuses any
`available: true`, `discount:` or `coupon:` on the surface.

⚠ **One judgement call inside the stub, and it is where `NEGOTIATION_PROMOTIONS_UNAVAILABLE`
went.** The tool accepts an optional `code`, because a customer saying *"I have code JOVI10"* is
the case it exists for. With no code it answers `200 { available: false }` as specified. **With
a code it raises 422**, rather than answering `false` — because `{ available: false }` to a
*named* code reads as **"that code is not valid"**, which is a verdict on a code nobody checked
and precisely the invented fact the tool exists to prevent. The registry message states the
platform-level fact instead, and the test asserts it contains none of
*invalid/expired/not valid/incorrect/wrong* so it cannot be relayed as a verdict. The code is
**not** echoed into `details`.

**`find_complementary_products` is built on real co-purchase history**
(`RelatedProductsRepositoryMongo.coOccurring` — paid orders, sampled), and each hit publishes
its `coPurchasedOrders` count. ⚠ **Deliberately no fallback**: `RelatedProductsService` falls
back to `sameCategoryRecent`, which is right for a storefront strip and wrong here — a
same-category product is a **substitute**, and offering one as a bundle tells a customer to buy
two of the same kind of thing while calling it generosity. No history ⇒ `hits: []`. The
response also carries a `note` forbidding any "compatible with / fits / works with" phrasing,
which is § 6's naming concern made enforceable at runtime rather than only at the tool name.

---

#### Contract decisions Stream F needs

- **`floor` / `ask`, not `minPrice` / `maxPrice`.** Renamed once, on the way out. `minPrice`
  reads as "the least the customer pays" and is the exact opposite — it is the vendor's floor.
- ⚠ **A budget bounds the FLOOR, never the ask.** A variant shelved at 45 000 with a floor of
  38 000 **is** returned for `maxPrice: 40000`. Bounding on the ask would hide exactly the
  products the agent exists to negotiate down. Asserted from both sides — the pure predicate
  and the `$match` on `_reachableFloor` — because "fixing" one alone is the plausible mistake.
- ⚠ **`stock.sellable` can be `true` while `stock.onHand` is `0`** (overselling / infinite
  stock), and `onHand` is `null` — never `0` — when infinite. A scarcity claim (*"only 2
  left"*) may be built **only** from a numeric `onHand`. This is the playbook's own rule made
  representable.
- **A search hit is a card, not a product.** It carries the *entry* (cheapest sellable) variant's
  window plus `variantCount`; the model calls `get_product_details` for anything more. That
  keeps the playbook's "`get_product_details` is your truth source" true rather than aspirational.
- **POST on all five**, unlike `/playbook`'s GET: `query` is the customer's own words, and a
  search phrase in a query string lands in every access log on the path.

---

#### Notes for the other streams

**For D** — we independently reached the same `compareAtPrice` conclusion, and we agree:
a bargainable variant publishes `compareAtPrice` only while strictly above the quoted price. I
scoped mine to bargainable variants too, for your reason. I did **not** import
`read-models/public-display-price.ts` — it was in flight while I built, and coupling to a
moving file across a stream boundary is the collision § 5 is about. Both files import
`isBargainEffective` from `bargain-price.rule.ts`, so the shared thing is the settled rule.
Your `_id`-tiebreak finding does not reach this surface: my sorts run **before** the projection,
so `_id` is still present when they execute.

**For C+E** — nothing here reads a lock, a cart or an order, and nothing imports
`PriceResolverService` or `earnings-split.service.ts` (asserted by source scan). Your
`floor_price_snapshot` and my `window.floor` are the same number and the same field
(`variant.price`); if either ever stops being `bargain.minPrice`, both break and § 4 invariant 3
is where to start.

**For A** — `/tools` is mounted inside your router, below your `requireServiceToken`; my scan
pins that ordering, so moving the guard will fail my suite rather than silently opening the
door. I edited nothing else in that file beyond the mount, its import and the one-paragraph
amendment to its header's "no prices" claim.

✅ **The `preserve-caught-error` lint error D reported on
`scripts/test/test-negotiation-tools.ts` is FIXED** — the assertion helper now captures and
re-examines outside the `catch`, which is the pattern `test:negotiation-playbook` already uses
and for the same reason (`new Error(msg, { cause })` needs an ES2022 lib this tsconfig does not
target). `npm run lint` is clean on all nine of my files.

---

### Stream D — close-out notes

**Built.** `catalog/read-models/public-display-price.ts` (new), and the flip applied in
`public-catalog.repository.mongo.ts` + `dto/public-product.dto.ts`. Contract updated in
`api-doc/public/catalog.md`. Nothing outside those four files was edited.

**The five derivations, and where each now reads from.** The trap was right and it was the
whole job:

| Derivation | Was | Is |
|---|---|---|
| browse row `price` | `$_defaultVariant.price` | `$_defaultVariant.displayPrice` |
| `priceMin` / `priceMax` | `$min/$max sellableVariants.price` | over `sellableVariants.displayPrice` |
| `minPrice`/`maxPrice` filter | `$match _defaultVariant.price` | `$match _defaultVariant.displayPrice` |
| `price_asc` / `price_desc` | sorts the projected `price` | **unchanged, and correct because of it** |
| detail variant `price` | `variant.price` | `publicDisplayPrice(parent, variant)` |

The sort needed no edit: its `$sort` is pushed **after** `listProjectionStage`, so it orders on
the projected `price`, which is now the displayed one. That is load-bearing and invisible, so
it is pinned by a source scan asserting the stage order — move the `$sort` above the
`$project` and the grid silently orders by the vendors' floors while showing their asks.

**One rule, two dialects, one file.** Three of the five live in an aggregation pipeline and two
in a pure mapper, so the rule is written once in `public-display-price.ts` as *both* a TS
function and a `$`-expression builder, adjacent. `test:public-catalog` § 2b evaluates the
pipeline expression against the pure one over an 8-case fixture table; `verify:storefront`
§ 3c runs the real pipeline against real Mongo, including a `maxPrice=40000` query asserted to
**exclude** the product displaying 48 000 — the plan's own example, executed.

**A sixth derivation the plan did not name, and I moved it too: `compareAtPrice`.** A vendor may
legitimately hold `price 30 001 · compareAtPrice 35 000 · maxPrice 48 000` — the "was" price is
unrelated to the window. Published unchanged after the flip it renders a strikethrough *beneath*
the live price. **A bargainable variant now publishes `compareAtPrice` only while it is strictly
above the ask.** Scoped to bargainable variants deliberately: `PriceResolverService:55` already
applies exactly this rule to decide whether a line carries a `discount`, so applying it
universally would arguably be a *fix* — but it would change what the storefront publishes for
products this feature never touches, which is outside "everything else is unchanged". Say the
word and it is a one-line widening.

**The floor cannot enter the pipeline at all.** The variant `$lookup` projects
`'bargain.maxPrice': 1`, never `bargain: 1` — so there is no `minPrice` in `sellableVariants`
for a later `$project` to pick up however the projection changes. Same argument
`vendorJoinStages` already makes about the vendor document, applied to a number.
⚠ Note `minPrice` means **two** things in that file: the vendor's floor, and
`PublicProductQuery.minPrice`, the *shopper's* filter bound, which is published in the query
string. The leak assertions test the two separately for that reason.

**Decision NOT taken: there is no public `bargainable` flag.** D-6 makes bargaining chat-only,
so the storefront has nothing to do with it today, and adding a field to
`public-product.dto.ts` — the security boundary — is a deliberate publication decision rather
than mine to make in passing. Recorded as still-open in `api-doc/public/catalog.md`'s
"Not built (deliberately)". The cost: a shopper cannot tell a negotiable price from a fixed one.

---

#### ⛔ For Stream C+E — a storefront sale is NOT currently at the ask

**D-5 says "a storefront sale at the ask used no AI and the whole uplift is the vendor's".
After this change that sentence is not true of the code, and closing it is C's.**

`PriceResolverService.execute` sets `const unitPrice = variant.price` (line 48), and
`cart.service.ts` is its only caller. So today a shopper who adds a bargainable variant to the
cart **without negotiating** is shown 48 000 and charged 30 001 — the floor. It fails
customer-favourably, so nothing breaks loudly and no test anywhere goes red.

The lock seam is where this lands: alongside "honour the lock when valid", C needs **"with no
lock, a bargainable variant resolves at `bargain.maxPrice`"**, re-read at resolve time. Two
consequences to carry with it:

- **`floor_price_snapshot` on the cart line stays `variant.price`** — E's margin arithmetic is
  `U = (P − floor) × qty` and the floor is the vendor's number, not the displayed one. An
  un-negotiated sale then has `P === ask`, `U > 0` and **no lock**, so D-5's "only on orders
  carrying a negotiation lock" is what keeps `aiMargin` at zero there. That condition is now
  doing real work rather than describing an edge case — please make it explicit in the split.
- `PriceResolverService`'s existing `discount` derivation (`compareAtPrice > unitPrice`) will
  start reporting differently once `unitPrice` becomes the ask. That is correct and it agrees
  with what the storefront now publishes.

I have not touched `PriceResolverService` — it is C's file and § 7 rule 6 says to write it here.

---

#### ⚠ For Stream A — `test:env` is red, and one variable is off-plan

`npm run test:env` fails **1/38** on four variables read by `src/` and absent from
`.env.example`. None are mine (my diff reads no environment variable at all):

`NEGOTIATION_SESSION_TTL_MINUTES` · `NEGOTIATION_LOCK_TTL_MINUTES` ·
`NEGOTIATION_DEFAULT_CURRENCY` ← `modules/negotiation/config/negotiation.config.ts` (**A**)
`NEGOTIATION_AI_MARGIN_PERCENT` ← `modules/earnings/config/earnings.config.ts` (**C+E**)

⚠ **`NEGOTIATION_DEFAULT_CURRENCY` is not in § 5's allocation table** — it is a fifth variable
added beyond the plan. Worth adding to § 5 so the next session does not claim the name.

I deliberately did not append these to `.env.example`: § 5 allocates them to A and C+E, and a
read-modify-write on a shared registry from a session that does not own the rows is exactly
what that section exists to prevent. Note also that `npm run lint` is red on
`scripts/test/test-negotiation-tools.ts` (**B**, `preserve-caught-error`) — my five files lint
clean, verified in isolation.

---

#### 📌 A pre-existing defect the flip makes MORE reachable — not fixed, measured

**The `_id` tiebreak on every public sort is a no-op, and has been since the storefront
shipped.** `sortStage` returns `{ price: 1, _id: 1 }`, and its docstring says the tiebreak is
"not decoration" because without a total ordering two products sharing a price "can land on
either side of a page boundary between requests, so paging shows one twice and skips another".
But the `$sort` runs **after** `listProjectionStage`, which projects `_id: 0` — so there is no
`_id` left to break the tie. All four sorts are affected.

Measured against real Mongo rather than inferred (five equal-priced documents, scrambled ids):

```
after `_id: 0` projection : 5555 3333 1111 4444 2222   ← insertion order, unsorted
with `_id` kept           : 1111 2222 3333 4444 5555   ← the intended total ordering
```

**Why Stream D is the one reporting it:** the flip materially raises the tie rate on
`price_asc`/`price_desc`. Vendors pick *round* ceilings — 45 000, 50 000 — far more often than
they pick round prices, so a grid sorted by ask has many more equal keys than one sorted by
price, and a latent paging bug becomes a reachable one.

Not fixed, because it is pre-existing, unrelated to bargaining, and changes storefront paging
for every client. The fix is one line — sort on the projected `id` instead (`{ price: 1, id: 1 }`;
lexicographic order on equal-length lowercase hex is byte order on the ObjectId, so the ordering
is identical) — and it wants an owner's decision plus its own `verify:storefront` assertion.

---

### Stream C+E — close-out notes

**Built.** Two new files — `catalog/domain/ports/negotiated-price.port.ts` (the seam) and
`earnings/services/negotiation-margin.service.ts` (the pure arithmetic) — plus
`scripts/test/test-negotiation-pricing.ts` (**63/0, no DB**). Edited: the six § 6 files, the
five allocated error codes + their `DEFAULT_ERROR_MESSAGES` entries,
`NEGOTIATION_AI_MARGIN_PERCENT` in `.env.example`, and the `test:negotiation-pricing` script.

Guards run: `test:env` 38/0 · `test:errors` 74/0 · `test:system` 231/0 · `typecheck` ·
`typecheck:scripts` · `lint` (clean on every file I touched). Neighbours re-run green:
`test:bargain-price` 148/0 · `test:public-catalog` 148/0 · `test:earnings-quote` 29/0 ·
`test:storefront-checkout` 51/0 · `test:bot-surface` 257/0 · `test:negotiation` 35/0 ·
`test:negotiation-tools` 50/0.

---

#### ▶ For Stream A — the PriceLock port, published (D-11)

**`src/modules/catalog/domain/ports/negotiated-price.port.ts`. Implement
`INegotiatedPriceResolver` in `modules/negotiation/` and call
`setNegotiatedPriceResolver()` from `negotiation.bootstrap.ts`, wired into `lifecycle.ts` —
the `agent.bootstrap.ts` shape.** The interface is exactly what D-11 specified; nothing was
invented.

```ts
peek(lockRef: string, ctx: NegotiatedPriceContext): Promise<LockVerdict>
consume(lockRef: string, ctx: NegotiatedPriceContext, session: ClientSession): Promise<LockVerdict>

interface NegotiatedPriceContext { customerId: string; variantId: string; quantity: number }

type LockVerdict =
  | { ok: true; unitPrice: number; floorSnapshot: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'consumed' | 'mismatch' | 'window_moved' };
```

Five things the implementation has to honour:

- **`floorSnapshot` is `variant.price` as of THIS verdict** — the vendor's floor, never the
  displayed ask. It is written straight onto the order item and is the input to the AI margin,
  so a wrong number here silently mis-pays a vendor rather than failing.
- **D-10's window re-read is yours and only yours.** `catalog` does not re-derive it; a source
  scan in `test:negotiation-pricing` § 7 asserts `PriceResolverService` mentions no `minPrice`
  or `maxPrice`. Two modules interpreting one lock is the drift the port exists to prevent.
- **`consume` must be transactional in the passed session.** It runs inside the order's
  transaction, so a checkout that rolls back leaves the lock spendable. `peek` writes nothing.
- **A refusal is a returned verdict, never a throw.** `catalog` maps `reason` onto the five
  `NEGOTIATION_LOCK_*` codes; throwing bypasses that and the chat gets a 500 it cannot explain.
- **The reason set is closed.** An unrecognised value is treated as a refusal (asserted), but
  it renders as `NEGOTIATION_LOCK_INVALID` — if you need a sixth, say so and both sides move.

Until you register one, the default resolver **REFUSES** any presented lock with a 500 and a
loud log rather than falling through to the list price (D-11's rule, and the failure direction
nobody reports as a bug). So the two halves deploy in either order.

**The cart line also carries `negotiation_lock_ref`** — an addition to the plan's named
fields, and unavoidable given D-12: `consume` happens at order creation, so the line has to
remember which lock it is spending. It is `peek`ed at add-to-cart and never spent there.

---

#### ✅ Stream D's handover is CLOSED — an un-negotiated sale is now at the ask

D's ⛔ note was right, and it **reversed a call I had already made**. I had found the same gap
while reading and decided *not* to build it, on the grounds that D was "not started": flipping
the cart to the ask while the storefront still showed `variant.price` would charge customers
*more* than displayed. D shipped first, which inverts that — the live defect was display
48 000 / charge 30 001 — so it is built.

`PriceResolverService` now resolves an un-locked line through **`publicDisplayPrice`, D's own
function**, rather than a second copy of the rule. That is the load-bearing part: D wrote the
predicate once in two dialects precisely because five derivations depend on it, and a
hand-rolled `variant.bargain.maxPrice` here would have been the sixth copy — the one deciding
what a customer is actually *charged*, where a divergence is a revenue defect rather than a
display bug. A domain service importing from `read-models/` is unusual and is the lesser evil;
the reasoning is written at the import.

**D's follow-on requirement is done and is the part worth reading.** Since a bargainable
variant is now *sold* at its ask, an ordinary un-haggled sale of one also has `P > floor` and
therefore a non-zero uplift. Keying the margin on the uplift alone would take 30% of it on a
sale no model touched — quietly reducing the payout of every vendor who configured a window.
So D-5's *"only on orders carrying a negotiation lock"* is now an **explicit gate in one
place**: `negotiatedLineOf`, which both split paths run every order item through, and which
returns a `null` floor unless `negotiated_unit_price` is set. It gates on
`negotiated_unit_price` rather than on `floor_price_snapshot` deliberately — they are written
in the same breath today, but they are two columns and a future writer could set one alone.

`compareAtPrice` was left alone, so D's one-line widening offer stands unaccepted; the
`discount` derivation self-corrects because it reads `unitPrice`, which is now the ask
(asserted).

---

#### ⚠ `test:bargain-price`'s scope guarantee was NARROWED — read this before widening it back

That suite asserted that `cart`, `orders`, `earnings`, `cod` and `shipments` **never mention
`bargain`**, on the stated grounds that bargainable pricing was *"configuration only … there is
no path by which a bargained price reaches a cart or an order."* This stream is that path, so
three of its five assertions went red the moment C+E landed.

**Deleting them would have been wrong**, because the load-bearing half survives and matters
more now than it did: none of those modules may **read the window**. The floor they work from
is a snapshot taken when the lock was honoured, and a live re-read would compute a share of an
uplift nobody agreed to — and could pay a vendor below the floor they actually sold at. So:

- `cod` / `shipments` — **unchanged**, not one mention, comments included. Still 0.
- `cart` / `orders` / `earnings` — no `bargain` / `minPrice` / `maxPrice` **in code**, comments
  stripped before the scan. Still 0: every hit today is prose explaining which number is being
  used and why it is not the live one.

`jovi-mall/CLAUDE.md` § "Bargainable pricing" still ends *"This phase is configuration only —
there is no offer/counter-offer flow and no path by which a bargained price reaches a cart or
an order."* **That sentence is now false** and I have deliberately not edited it: whoever
closes this effort should rewrite that section as a whole rather than have four sessions patch
one paragraph. Flagging it rather than fixing it.

---

#### Beyond the § 6 file list — four additions, each with its reason

1. **`catalog/domain/ports/negotiated-price.port.ts`** and
   **`earnings/services/negotiation-margin.service.ts`** — new files. D-11 mandates the first.
   The second exists so `test:negotiation-pricing` is genuinely DB-free: `EarningsSplitService`
   reaches Mongo, the transaction manager and the event bus, so arithmetic inside it cannot be
   tested without a connection. Same argument that produced `EarningsQuoteService`.
2. **`NEGOTIATION_AI_MARGIN_PERCENT` lives in `earnings.config.ts`, not `negotiation.config.ts`**
   — the § 6 rule forbids C+E touching `modules/negotiation/`, and it is a term of the money
   split anyway. Clamped to `[0, 100]`; the invariant holds for every value in that range
   (asserted), so a misconfiguration cannot invert it.
3. **`earnings-account.model.ts` · `earnings-allocation.model.ts` · `earnings-ledger.model.ts` ·
   `earnings-account.repository.ts` · `earnings-release.worker.ts`** — `platform_ai` is a new
   `EarningsOwnerType`, so its enum had to reach three schemas. ⚠ The repository edit is the
   one that mattered: `toOwnerId` returned `null` only for the literal `'platform'`, so an AI
   allocation would have thrown `INTERNAL_SERVER_ERROR` on the money path for want of an
   `owner_id` that by design does not exist. It reads `isPlatformOwnerType()` now, and so does
   the ledger repository (where `new Types.ObjectId(null!)` was the latent form of the same
   bug) and the payout sweep.
4. **`cart.controller.ts` · `cart.validator.ts` · `bot-cart.controller.ts` · `bot.validators.ts`**
   — an optional `negotiationLockRef` on both add-to-cart doors. Without it nothing can present
   a lock and the whole seam is unreachable; bargaining is chat-only (D-6), so the **bot** door
   is the one that matters. Optional and trailing, so both existing callers are unchanged.

**`platform_ai` is deliberately a second singleton rather than more money on `platform`.** The
two answer different questions — "what does the marketplace earn" and "what did the AI cost
us" — and the second is the number this whole feature gets judged on. It is excluded from
payouts by `PAYOUT_OWNER_TYPES`, which never included `platform` either.

---

#### Three decisions inside C+E worth knowing

- **A LOCKED add-to-cart SETS the line; it does not increment.** The lock binds a quantity, so
  incrementing an existing line produces a quantity nobody agreed a price for — and silently,
  because the `peek` validated the *requested* quantity, not the resulting one. Discarding the
  customer's existing quantity is the lesser cost against a basket whose stated price nothing
  will honour.
- **Changing a line's quantity DROPS its negotiation** (`setItemQuantity`, and the `sum` branch
  of `mergeCart`). Same binding argument. The lock is *not* consumed, so re-adding at the agreed
  quantity gets the price back. Only an actual change drops it — a client re-sending the same
  number keeps it.
- **`floor_price_snapshot` is NOT on `CartResponse`.** That DTO is returned verbatim by
  `GET /customer/cart` and by every bot cart route, so a field added there is published to the
  customer — and the floor is the same secret `bargain.minPrice` is on the public catalogue.
  Order creation does not need the cart's copy either: `consume` returns the authoritative one.
  Two leak assertions pin it.

---

#### Open, and not mine to close

- **Nothing surfaces the `platform_ai` balance.** `admin-earnings.controller.ts` hardcodes
  `getBalances('platform', null)`, so the AI account accrues where no screen reads it. One line
  here plus a wi-admin projection; that is Phase-14 / wi-admin territory, not this plan's.
- **No index migration was added.** `platform_ai` rides the existing `(owner_type, owner_id)`
  unique index and the existing allocation indexes; nothing new is queried. Pre-production D-5
  means no backfill: existing orders carry `null` on both new columns and compute a zero
  margin, which is correct for them.
- **`test:negotiation-pricing` is DB-free by construction and proves no wiring.** It drives the
  port against fakes. That a real `consume` actually rolls back with the order's transaction is
  a claim only a live suite can make — worth a `verify:*` once Stream A's implementation exists.

---

### Stream F — close-out notes

**Built.** Two new n8n workflows and one surgical edit to the live one. The full record,
including the flow diagram and every failure path, is
[bargaining-agent.md](./bargaining-agent.md); this section is the part the other streams need.

| Workflow | id | Published |
|---|---|---|
| `wi-mall-bargain` — the sub-agent | `lJdli0uwOtWBGx5R` | ✅ |
| `wi-mall-bargain-tools` — one door for the seven tools | `tdCmCgwaGwp7epEV` | ✅ |
| `wi-mall-core` — flag check + `open_negotiation` tool | `vvbouV2136P5weCs` | ✅ |

`wi-mall-core` was edited with `update_workflow` operations under the `versionName`
*"Hand price haggling to wi-mall-bargain"*. The diff against the live version is seven added
nodes, one removed connection, nine added connections and **one modified node** — the AI
Agent's `systemMessage`, previous text preserved byte-for-byte with one section inserted.
Nothing else on any existing path changed. It was held as a draft until the owner said to go —
publishing is the moment real customers see it — and was **published 2026-09-07**.

---

#### The plan's § 6 sketch and the PLAYBOOK disagree about where the seven tools go. The playbook wins

§ 6 reads naturally as *the flow fetches the context, runs the model, and submits the result to
the gate* — a flow-level gate, with five tool nodes hanging off the agent. **The playbook Stream
A shipped specifies the opposite**, and it is the more load-bearing document because it *is* the
system prompt:

- its frontmatter declares `compatibility: Requires tools negotiation_context,
  negotiation_record, get_product_details, …` — **seven tools, all of them the model's**;
- § 1 is a mandatory turn loop, `negotiation_context` first and `negotiation_record` last;
- § 8 is a page of instructions on how to react to a `revise` verdict and re-submit.

A flow-level gate would make §§ 1 and 8 unreachable — the model would never see a verdict to
obey. So all seven are agent tools, the revise loop happens inside the agent, and **the flow's
job is not to call the gate but to enforce it.** See the next note.

---

#### ⚠ D-4 is enforced by an ECHO, not by the model's good behaviour

The playbook says *"The message the customer receives is the message the gate approved — never a
different one."* Instructed, not guaranteed. The model most likely to break that rule is exactly
the one that has just been refused.

So `negotiation_record` is a `toolWorkflow` that writes the gate's whole response to Redis
before returning it, and after the agent finishes the flow **sends the `reply` it reads back**
rather than the agent's final output. A refused price therefore cannot be spoken even by a model
that says it anyway, and a turn whose last verdict was `revise` sends **nothing** and hands back.
Only a turn with no gate call at all — a product question, a greeting, which the playbook routes
around the gate — sends the model's own words.

⚠ The echo key is conversation-scoped and stamped with the `messageId`, then deleted after
reading, because **the n8n Redis node's `set` exposes no TTL**. That is measured, not assumed: it
is the same limitation that put `wi-mall-product-search`'s query cache in Postgres. The same fact
governs the routing flag — its `expiresAt` is the authority and `wi-mall-core` treats a lapsed
flag as absent, because a key that cannot expire would otherwise hold a customer in bargaining
mode for good if a close were ever missed.

---

#### ⚠ The floor's exits, and the one that "shared chat memory" would have opened

§ 6 asks for *shared Redis chat memory keyed on the same `externalId` as the main agent*. Built
exactly that — same node type, same credential, same key — so the two agents read one transcript
and neither loses the thread.

That is only safe because **the negotiation context arrives as a TOOL RESULT and not in the
prompt.** n8n's chat memory persists the agent's input and its output, and never its tool
results. Had the window been interpolated into the user turn — the obvious reading of
*"per-customer context goes in the user turn"* — the vendor's **floor** would have been written
into the transcript the **main agent** reads on every subsequent message, which is exactly what
`negotiation-tools.md` forbids. The two constraints turn out to agree: the tool route is also the
one that keeps the user turn small, which is the caching win.

Three other exits were closed the same way, all as allowlists rather than redactions:
`shape handover` returns three flags and no numbers to the main agent; `shape tool result`
**strips the lock's `ref`** before the model sees it (a bearer credential for a price the model
has no use for); `set bargain flag` stores the subject and an expiry and no price at all.

---

#### The hand-off costs one conversational turn, on purpose

`open_negotiation` opens the session and sets the flag but **sends nothing**; the main agent says
a bridging line and the sub-agent takes the next message. Running the sub-agent inside the main
agent's turn was the alternative, and it makes both agents write to the one shared memory in the
same turn — duplicating the customer's message in the transcript both of them read. A "let me see
what I can do" beat is natural in a market conversation; the duplicate is not.

It also buys something real: `open_negotiation` calls `/context`, so the main agent learns at
hand-off **whether this variant is negotiable at all**, and answers `negotiable: false` plainly
instead of promising a haggle that cannot happen. `negotiable: null` is deliberately not `false`
— a backend that could not be asked has said nothing about the vendor's price.

---

#### ✅ The lock reaches the cart — `tools/catalog.json` and `wi-mall-mcp` were changed

This section was written as a ⛔ and closed the same day, on the owner's instruction.

C+E plumbed `negotiationLockRef` all the way through — `cart.validator.ts`, `cart.service.ts`,
`cart.model.ts`, `bot.validators.ts:155` — and **the MCP tool did not carry it**: `cart_add_item`
was `additionalProperties: false` over `productId`/`variantId`/`quantity`, so the tool the main
agent fills the basket with had no way to spend a lock and every lock this feature minted expired
unspent, silently, in the customer-favourable direction that nobody reports.

`cart_add_item` now takes `negotiationLockRef`, plus the five `NEGOTIATION_LOCK_*` failure rows —
each worded to tell the model to **add the item again without it**. `npm run gen:mcp-workflow`
re-rendered the node and **one** `updateNodeParameters` was applied to the live `wi-mall-mcp`;
nothing else on that server was touched. `test:bot-surface` **257/0**.

⚠ **The ref travels through Redis, not through the model's memory.** `wi-mall-bargain` writes
`wi-mall:bargain:lock:{channel}:{externalId}` on a minted lock; wi-mall-core reads it and puts it
in the main agent's system prompt beside `botToken`. The **bargaining** model still never sees it
(`shape tool result` strips it), which is not a contradiction: the lock is bound server-side to
(customer, variant, quantity), single-use and re-validated at D-10, so a leaked ref buys its own
owner their own agreed price and nobody else anything — strictly weaker than the `botToken` that
prompt already carries. It is withheld from the bargaining model because it is **useless** there,
and a credential a model cannot spend is one it may say out loud.

Two known edges, both failing safely and both written up in
[bargaining-agent.md](./bargaining-agent.md) § 7: the variant/quantity hint comes from the routing
flag rather than the gate (a mid-haggle pivot makes it wrong → `NEGOTIATION_LOCK_VARIANT_MISMATCH`
→ retry without), and a spent ref survives in Redis until its `expiresAt` (→
`NEGOTIATION_LOCK_CONSUMED` → retry without). **The better shape is for the backend to resolve the
lock itself** when the bot cart route is called with none — no credential in any model context and
no stale-ref refusal. That is new code in `modules/negotiation` and `modules/bot-surface`, so it is
recorded rather than built.

---

#### Two artifacts worth knowing before extending this

- **A hand-back writes `#HANDBACK#` into the shared transcript**, and the main agent then writes
  the same customer message again — the one turn where two agents write to one memory key. A
  model reads past it; a human reading an execution will not enjoy it.
- **The routing flag's `quantity` does not follow a line change.** A model that moves to a new
  quantity mid-negotiation (a new line, invariant 2) leaves the flag naming the old one, so the
  next turn's `negotiation_context` default is stale until the model passes `quantity` itself.
  The context tool is authoritative, so nothing is mispriced; the default is simply wrong.

**No jovi-mall `src/` was touched.** No route, model, error code, environment variable, npm
script or `.env.example` row — nothing in § 5's shared registries. The repository changes are
this section, the F row above, `bargaining-agent.md`, its index row in `api-doc/n8n/README.md`,
and — from the close-out above — `api-doc/n8n/tools/catalog.json` plus the two regenerated files
under `api-doc/n8n/generated/`.

Guards after the catalogue change: `test:bot-surface` **257/0** · `test:env` **38/0** ·
`test:errors` **74/0** · `test:system` **231/0**.
