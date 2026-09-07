# n8n customer agent — architecture

**Status:** design only, 2026-08-24. No application code was written and no n8n workflow was built.
**Scope:** the customer-facing WhatsApp and Telegram bot, its command system, and the backend tools behind it.
**Companions:** [COMMAND-SPECIFICATION.md](./COMMAND-SPECIFICATION.md) · [BACKEND-GAPS.md](./BACKEND-GAPS.md) · [RECOMMENDATIONS.md](./RECOMMENDATIONS.md) · [tools/](./tools/)

---

## 0 · What already exists, and what does not

Before any of the design below, the ground truth — verified against the route table and the source on 2026-08-24.

**Exists and works.** A bot bridge at `POST /api/webhooks/{whatsapp,telegram}`, guarded by `X-Webhook-Secret`, dispatching four CommandBus commands: `connect`, `login`, `login_contact`, `reset_password`. Each *returns* its reply in a `message` field which the automation layer relays to the chat — this service sends nothing itself. A full customer API under `/api/customer/*`, `/api/public/*`, `/api/payments/*`, `/api/geo/*` and `/api/digital/*`. An outbound WhatsApp messaging service that already supports text, interactive buttons, lists, CTA-URL buttons, flows, product cards, media carousels, location and contacts.

**Does not exist, and this is the load-bearing fact of the whole design.** There is no way for the automation layer to *act as a customer*. Every one of the four existing commands mints a credential for a **human to redeem in a browser** — and deliberately does not return it as a field, only inside `message`, because a webhook response body is logged in more places than a chat message. The internal service surface (`requireServiceToken`) covers agents, shipments and admin only. Nothing customer-scoped is reachable by a service caller.

So "n8n calls `GET /api/customer/orders`" has no mechanism behind it. Everything in section 3 follows from closing that gap, and the way it is closed is the single most consequential decision here.

---

## 1 · The pipeline

```
Customer
   │
   ▼
WhatsApp / Telegram          ─── platform ingress: two shapes, one normalizer
   │
   ▼
n8n · INGRESS                    normalize the webhook → Inbound Message
   │                             (channel, externalId, kind, text, payload, media, location)
   ▼
n8n · IDENTITY                   resolve the sender ONCE per conversation
   │                             identity_resolve_sender → {state, isCustomer, language}
   ▼
n8n · ROUTER                     five ways in, one way out
   │   ├── live flow expects this input?   → FLOW STEP
   │   ├── interactive payload?            → INTENT (carries its own args)
   │   ├── starts with "/"?                → COMMAND PARSER (deterministic)
   │   ├── opt-out keyword?                → INTENT (compliance path)
   │   └── otherwise                       → AI AGENT (tool-calling model)
   ▼
NORMALIZED INTENT                {intent, args, subject, confidence, origin}
   │
   ▼
n8n · GUARD                      authorization · validation · confirmation · idempotency
   │                             (deterministic — the model does not run here)
   ▼
MCP TOOL                         one tool = one backend call
   │
   ▼
jovi-mall                        public · payment_public · webhook_command · bot_internal
   │
   ▼
RESULT NORMALIZER                → Normalized Result {kind, title, body, items, actions, media, handoff, meta}
   │
   ▼
PLATFORM RENDERER                ⚠ MOVED SERVER-SIDE 2026-08-26 — see the note below
   │                             WhatsApp: interactive/list/text + caps    Telegram: inline keyboard + text
   ▼
Customer
```

⚠ **The PLATFORM RENDERER box no longer describes n8n, and this line used to call it *"the
ONLY place platform-specific code lives"*.** Since 2026-08-26 jovi-mall composes the outbound
request body itself and returns it as a top-level **`reply`** on every bot response; the
automation layer POSTs it unmodified. Contract:
[bot-surface.md § 14](./bot-surface.md#14---reply--the-request-body-you-post-to-the-channel-unmodified).

The reason is the same one that moved the *copy* server-side twice already (`customerMessage`
for failures, `next.prompt` for questions): **this layer relays, it does not render.** It has
no copy table, no translator, and no reason to know that WhatsApp truncates a reply-button
title at twenty characters. Each of those three moves was reported as a defect rather than
foreseen, which is the pattern worth noticing — *"the automation layer will handle the
presentation"* has now been wrong three times about three different parts of one message.

What the box still describes correctly is the **shape**: one place decides the platform
rendering, and it is downstream of a channel-neutral result. Only its address changed.
The scope is what the platform WORDS — a prompt, a refusal, a picker, a payment button.
An open-ended answer ("do you have red shoes?") is still the model's, and those responses
deliberately carry no `reply`.

Two properties of this shape matter more than the boxes.

**The model sits in the middle, not at the ends.** It reads normalized input and proposes a normalized intent. It does not see raw webhooks, does not construct HTTP requests, does not choose a platform rendering, and does not decide whether an action is permitted. Everything either side of it is deterministic and testable.

**The guard is between the intent and the tool, not inside the tool.** Authorization, confirmation and idempotency are applied to an intent the model produced, by code the model cannot influence. This is what makes "the model proposes, the deterministic layer disposes" true rather than aspirational.

---

## 2 · Four things that are not the same

The brief asks for these to be distinguished, and conflating them is the usual way a chat commerce system becomes unsafe.

| | **Command** | **Intent** | **Flow** | **Operation** |
|---|---|---|---|---|
| What it is | Text the customer typed, beginning with `/` | What the customer *wants*, however expressed | A multi-turn state machine | One backend call |
| Produced by | The deterministic parser | The parser **or** the model | The guard, on entering | A flow step or the model |
| Lives in | `tools/commands.json` | The Normalized Intent vocabulary | n8n + a conversation store | `tools/catalog.json` |
| Deterministic? | Yes, entirely | Only when it came from a command | Yes — the steps are fixed | Yes |
| Can the model invoke it? | No — it parses before the model runs | It *is* the model's output | It can only *enter* one | Only `core` and `extended` tools |
| Example | `/track:ORD-2026-000123` | `delivery.track {orderRef}` | `checkout` (7 steps) | `orders_list_shipments` |

**A command is a shortcut past the model, not a different system.** `/track ORD-…` and "where's my order?" produce the *same* Normalized Intent and take the same path from there. The command skips classification; it skips nothing else. This is why the command set can stay small: every command must earn its place by being faster or less ambiguous than saying it in words, and where it is not, the model handles the intent and no command exists.

**A flow is not a tool and must not be modelled as one.** Checkout is seven steps with state that outlives a single turn, a deadline, and a point of no return. Exposing it as one tool the model calls with all its arguments means the model reconstructs the arguments at the moment of execution — and a model that re-derives `{cartId, gateway, phoneNumber}` at the confirm step can execute a different payment than the one the customer read. Flows hold their own state; the model enters them and then stops driving.

**The `flow_only` tier is the mechanism.** Twenty-three of the sixty tools — every money movement, every destructive action, every credential disclosure — are **not registered with the model at all**. They are called by flow steps. The model's reach is bounded by which tools exist in its list, not by how well it was instructed.

---

## 3 · Identity — the decision everything else rests on

### 3.1 · The problem

The bot knows a WhatsApp phone id or a Telegram chat id. The customer API knows a JWT. Nothing bridges them.

Three ways to bridge it were considered.

| | How | Why not |
|---|---|---|
| **Bot-minted session** | A new endpoint returns a real customer bearer pair; n8n calls `/api/customer/*` as the storefront does | n8n becomes a credential store for the entire customer base. Worse, there is no revocation lever: `password_changed_at` is this service's only one, and a passwordless customer has never set it — a leaked customer session currently has **no** revocation path at all. This is a pre-existing gap the design must not amplify |
| **Read-only bot** | Public catalogue only; everything owner-scoped hands off to the web | The bot cannot answer "where is my order?", which is the single most-wanted thing a commerce bot does |
| **Curated internal surface** ✅ | A closed set of named operations at `/api/internal/bot/*`, service-token authenticated, carrying the messaging identity; the backend resolves the customer | **Chosen.** More backend work than the alternatives |

### 3.2 · What was chosen — D-1

**A curated internal bot surface. No customer bearer token is ever issued to the automation layer.**

```
n8n ──┬── Authorization: Bearer <INTERNAL_SERVICE_TOKEN>
      ├── X-Webhook-Secret: <BOT_WEBHOOK_SECRET>
      ├── Idempotency-Key: <uuid>
      └── body: { identity: { channel, externalId }, ...args }
                     │
                     ▼
        POST /api/internal/bot/cart/items
                     │
                     ├── resolve the customer from `identity`, by the SAME ladder /login uses
                     ├── refuse if unresolved, unbound, or holding no customer role
                     ├── execute ONE named operation
                     └── audit the row: channel · externalId · tool · outcome
```

Four properties are load-bearing.

**The identity is never a parameter.** No tool in the catalogue takes a `customerId`, a `userId` or a token. This is the same rule `/connect` already enforces and for the same reason: the deleted `link` command let a caller name somebody else's number, and on `/login` a caller-supplied identity is outright account takeover. Extending that surface to carts and orders without the rule would extend the mistake to them.

**Two credentials, not one.** The service token *and* the webhook secret. A leaked service token alone opens the agent and shipment surfaces — it does not open the customer surface. The two secrets are held by different parts of the deployment and rotate on different schedules.

**One route per operation.** Not a generic proxy. A proxy at `/api/internal/bot/*` forwarding arbitrary paths would be the bot-minted-session option wearing a different hat: whatever the customer API grows next would be reachable from a chat window with no decision taken. Every route in the catalogue was chosen.

**The resolution ladder is reused, not reimplemented.** `LoginIdentityResolver` already answers "which account is this chat?" with a documented ladder, an E.164 repair, and a refusal table. A second implementation would be a second opinion about the same fact, and the drift between them would be a login bug. The bot surface calls the existing resolver and adds one thing: a `register` intent (§3.4).

### 3.3 · The three sender states

Every conversation is in exactly one, and it decides what is reachable.

| State | Reached when | What works |
|---|---|---|
| **Anonymous** | Telegram, contact never shared; or a number with no account | `/help`, `/start`, public catalogue browsing, `/reset-password`, `/connect` |
| **Non-customer** | The account exists and holds vendor/agency/agent but no customer role | The above, plus nothing. **`/reset-password` is the point** — a password belongs to the account, so it is the only self-service recovery a vendor has from a chat |
| **Customer** | Resolved, active, holds the customer role | Everything |

⚠ **The non-customer state is a rule, not a gap.** A customer role is never auto-provisioned onto a business account. A vendor messaging the bot is told to sign in with their password — not quietly handed a shopping account. Every tool in the catalogue carries `requires_customer_role`, and the guard enforces it before the tool runs rather than relying on the model to notice.

### 3.4 · Registration on first contact

`auth/customer-auth.md` states that customers are created on their first interaction with the bot and that this is "bot-side backend work, landing with the n8n integration". **Nothing implements it.** An unknown number currently gets a refusal, and until this lands every command in this design is unreachable for a new customer.

Specified as **GAP-002**. The shape:

```
WhatsApp — the sender id IS the phone number
──────────────────────────────────────────────
unknown sender sends anything
   → identity_resolve_sender → state: anonymous, reason: no_account
   → "Would you like me to create an account for you?"       ← EXPLICIT consent
   → yes → identity_register_customer { consentToken }
   → User(roles:['customer']) + Customer profile + channel binding, in one transaction

Telegram — a chat_id maps to no phone number
──────────────────────────────────────────────
unknown sender sends anything
   → state: needs_contact
   → request_contact keyboard: "Share my phone number"
   → contact arrives → posted as command `login_contact` (unchanged mapping)
   → contact.user_id === sender?   ← the security of the entire flow
   → pending intent says `register` → consent → create
```

Four design points.

**It reuses the pending-intent store rather than adding one.** That store already exists and already selects between `login` and `reset` when a Telegram contact arrives carrying no information about which command asked for it. `register` is a third value in the same mechanism, not a new mechanism.

**Consent is explicit.** The documentation implies silent creation on first contact. Creating an account is a durable act with a data-protection footprint, and a person who messaged a shop to ask a price did not ask for one. The consent token is single-use, which is also what makes registration idempotent under retry.

**The `user_id` guard is not optional and not new.** A Telegram user can share somebody else's contact card and it arrives in the same shape. Without the check, forwarding a victim's contact is a one-message account takeover. With registration in the flow it becomes worse: it creates an account bound to a victim's number.

**The webhook secret becomes strictly load-bearing.** Today `BOT_WEBHOOK_SECRET` unset means refused in production and *open in development*. An open webhook already lets anyone mint a connection code against a stranger's number. Once registration is dispatchable, an open webhook lets anyone create accounts against strangers' numbers, at scale. See **GAP-011**.

---

## 4 · The four surfaces

A tool reaches the backend by exactly one of these, named in its `surface` field.

| Surface | Auth | Identity | Status | Used for |
|---|---|---|---|---|
| `public` | none | none | live | Catalogue, categories, stores, public reviews |
| `payment_public` | none | none | live | `initiate`, `verify`, `authorize` — unauthenticated **by design** |
| `webhook_command` | `X-Webhook-Secret` | messaging identity | live | The four existing credential-minting commands |
| `bot_internal` | service token **+** webhook secret | messaging identity | **GAP-001** | Everything customer-scoped |

⚠ **`payment_public` is not an oversight.** `POST /api/payments/initiate` and `/verify` take no credentials deliberately — a payment reference is shareable, so a mother can order and a son can pay. It was raised as an audit finding and withdrawn. It is also what makes in-chat mobile-money checkout possible without the bot holding a session: the flow authenticates to *create* the orders, and the payment itself needs only the `cartId` it just received.

### What is deliberately unreachable

**geo-tracker.** Live GPS is a WebSocket authorised per viewer with that viewer's own access token — the credential this design specifically avoids holding. The bot answers "where is my order?" from jovi-mall's shipment record instead: a five-word status, a de-duplicated history, the delivery company and their published contacts. That is a better chat answer than a coordinate, and it needs no second service.

**Every other role's API.** Vendor, agency, agent and admin surfaces are out of scope. The bot is a customer surface.

---

## 5 · The guard — what runs between intent and tool

Deterministic, in this order, before any tool call.

1. **Sender state** — the intent's tool declares `requires_customer_role`; the resolved state must satisfy it, or the intent is answered from §3.3 rather than executed.
2. **Tier** — a `flow_only` tool reached from anywhere but its own flow is a bug, and is refused and alerted rather than executed. This is the model-containment check.
3. **Schema** — the intent's arguments are validated against the tool's `parameters` JSON Schema. A model that hallucinates a field is caught here, not by the backend. Backend validation still runs; this one exists so the failure is legible and re-promptable.
4. **Context resolution** — any argument the model left to context is resolved under the tool's `context_resolution.policy` (§7). If the policy is `explicit_only` and the argument is absent, the guard asks; it does not resolve.
5. **Confirmation** — see below.
6. **Idempotency** — an `Idempotency-Key` is minted per logical action and reused across retries of that action.

### Confirmation, and the property that makes it worth having

Three levels, from each tool's `requires_confirmation`:

- **`false`** — execute. Cart edits, wishlist, language, search.
- **`true`** — two-phase, echoing the resolved subject.
- **`"out_of_band"`** — never executed in chat at all. Password reset is the only member: the bot emits a link and the customer sets the password on the web.

The two-phase form:

```
1. The guard builds the exact tool call:  {tool, args}
2. It stores it under a single-use token bound to (identity, tool, hash(args)), TTL 5 minutes
3. It renders a summary FROM THE STORED ARGS — not from the model's prose
4. The customer taps Yes; the payload carries the token
5. The guard executes the STORED call verbatim. The model does not run again.
```

⚠ **Step 5 is the point.** If the model re-derives the arguments at confirm time, "yes" can execute something other than what the customer read. Storing the call and replaying it makes the summary and the execution the same object. The token is single-use, which also means a double-tapped Yes cannot double-charge.

---

## 6 · Result normalization

Every tool result becomes one **Normalized Result** before any platform sees it:

```jsonc
{
  "ok": true,
  "kind": "product_card",        // from the tool's response.result_kind
  "title": "Ankara Wax Print Maxi Dress",
  "body":  "24,000 XAF · In stock · Maison Bella",
  "items": [ /* rows, for list kinds */ ],
  "actions": [
    { "id": "cart.add", "label": "Add to cart", "payload": { "productId": "…", "variantId": "…" } }
  ],
  "media":  [ { "type": "image", "url": "…" } ],
  "handoff": null,               // { url, reason } when the answer is "do this on the web"
  "meta":   { "page": 1, "pages": 6, "hasMore": true }
}
```

The vocabulary of `kind`: `identity` · `product_list` · `product_card` · `chip_list` · `review_list` · `cart_summary` · `receipt` · `payment_instruction` · `order_list` · `order_detail` · `shipment_status` · `sensitive_code` · `address_list` · `address_choice` · `contact_card` · `ticket_list` · `ticket_detail` · `booking_list` · `booking_detail` · `download_list` · `profile_summary` · `status` · `handoff` · `verbatim_relay` · `silent`.

**Two kinds are special and both are safety mechanisms.**

`verbatim_relay` — the result's `message` is relayed to the chat **unchanged** and is never summarised, never stored, and never shown to the model. It is what the four existing credential commands return, and their `message` carries a magic link and an 8-character code because it must. Everything else about them is designed so nothing else does.

`sensitive_code` — a cash-on-delivery delivery code. Rendered with its warning, on explicit request only, and stripped from the conversation transcript after the turn.

**Rendering is the only platform-specific code in the system.** One renderer per platform, driven by `kind` and `actions`, applying the caps in §11. Nothing upstream of it knows which platform it is on.

| `actions.length` | WhatsApp | Telegram |
|---|---|---|
| 0 | text | text |
| 1–3 | interactive reply buttons | inline keyboard, one row |
| 4–10 | interactive list | inline keyboard, two per row |
| > 10 | list of 9 + "Show more" | 10 + pagination row |

---

## 7 · Context

### The object

Held by n8n (Redis), keyed on `(channel, externalId)`:

```jsonc
{
  "identity": { "channel": "whatsapp", "externalId": "237…", "state": "customer", "language": "fr" },
  "focus":    { "type": "product", "id": "68a1…", "label": "Ankara Wax Print Maxi Dress", "at": "…" },
  "recent":   [ { "type": "order", "id": "…", "label": "ORD-2026-000123", "at": "…" } ],
  "flow":     { "name": "checkout", "step": 4, "data": { }, "expiresAt": "…" },
  "pendingConfirmation": { "token": "…", "tool": "…", "args": { }, "expiresAt": "…" },
  "lastResult": { "kind": "product_list", "itemIds": ["68a1…", "68a2…"] }
}
```

**TTLs, and why these numbers.** `focus` 30 minutes — matched to the checkout stock hold, so the conversation and the platform agree about how long a purchase intent lives. `recent` 24 hours — matched to WhatsApp's service window, beyond which the bot cannot start a free-form message anyway. `flow` 30 minutes, hard. `pendingConfirmation` 5 minutes.

### The resolution policies

Each tool declares one. They are ordered by how much damage a wrong resolution does.

| Policy | Rule | Used by |
|---|---|---|
| `explicit_only` | The identifier must be in the message or an interactive payload. The guard **asks** rather than resolving. | `orders_cancel`, `orders_get_cod_code`, `reviews_create`, `payment_initiate`, `addresses_add`, `bookings_cancel`, `tickets_close` |
| `single_unambiguous_focus` | Resolve only when exactly one candidate is in focus. Two or more → disambiguate. | `cart_add_item`, `catalog_get_product`, `wishlist_add`, `tickets_add_note` |
| `focus_or_most_recent` | Focus first, then the customer's most recent matching record. | `orders_get_order`, `orders_list_shipments`, `support_resolve_contacts` |
| `not_applicable` | The subject is the customer themselves. | `cart_get`, `profile_get_summary`, `addresses_list` |

**`must_echo` is the other half.** Any tool that resolved its subject from context must name it back: *"Added **Ankara Wax Print Maxi Dress — Size M** to your cart"*, not *"Added to cart"*. A wrong resolution that is stated is corrected in one turn. A wrong resolution that is silent is discovered at the door.

### The situations the brief asks about

| Situation | Answer |
|---|---|
| **Ambiguous product** — several in focus | Disambiguate with a list of the candidates. Never the first, never the newest. |
| **Multiple products in context** | `focus` holds one; `recent` holds the rest. Only `focus` resolves implicitly. |
| **Expired context** | Ask. Never fall through to `recent` for a mutating tool — the customer has moved on since. |
| **Missing context** | Ask. For a read, offering the list is usually better than a question. |
| **Invalid SKU** | `CATALOG_PRODUCT_NOT_FOUND`. Offer a search of the same string. Never say *why* it is missing (§10). |
| **Unavailable product** | The catalogue simply does not return it. A saved wishlist row degrades to `product: null` instead — render "no longer available" with a working remove button. |
| **Unsupported operation** | Say so and name what is possible. Services cannot be carted; bookings cannot be made in chat. |
| **Backend error** | `tools/errors.json`, keyed on `code` then `category`. Never invent a cause on a 5xx — `details` is omitted in every environment and `requestId` is the only handle. |
| **Auth failure** | The sender state decides: contact prompt for an unbound Telegram chat, registration offer for an unknown number, "use your password" for a business account. |
| **Confirmation required** | §5. Store the call, render from the stored args, execute the stored call. |

---

## 8 · Interactive flows

A flow owns state across turns, has a deadline, and calls `flow_only` tools. Eight exist.

### 8.1 · Checkout — the one with a deadline and a point of no return

```
/buy  or  /checkout
  │
  1  cart_get ─────────────── empty? → offer search, end
  │
  2  addresses_list ───────── a deliverable default? use it, NAMED
  │                           none deliverable? → address flow (8.2), return here
  │
  3  cart_quote(addressId) ── the cheap way to discover an unusable address,
  │                           BEFORE anything is created
  │
  4  payment method ───────── cash on delivery · mobile money · card
  │
  5  CONFIRM ──────────────── items · total · address · method, from the stored args
  │
  ═══ point of no return ═══
  6  checkout_create_orders ─ orders created · STOCK HELD 30 MINUTES · cart cleared
  │
  7a cash on delivery → done. The code arrives when the parcel is picked up.
  7b online → payment_initiate(cartId, gateway, {phoneNumber, phoneOperator})
        ├── instructions.ussdCode      → "dial *126# and approve"
        ├── instructions.requiresOtp   → ask for the SMS code → payment_authorize_otp
        └── instructions.clientSecret  → HANDOFF: cards are paid on the website
  │
  8  payment_verify, bounded backoff (5s · 15s · 30s · 60s · 120s), then stop and
     tell the customer the notification will arrive on its own
```

Six things this flow must get right, each of which is a real trap in the backend:

- **Step 3 is not optional.** `geo` is only populated by picking a result from address search, so an address the customer *explicitly selected* still fails checkout if they typed it by hand. Discovering that at the pay button, after the orders exist, is the worst possible moment.
- **Branch on `status`, not the HTTP code.** A gateway that *refuses* the charge answers HTTP 200 carrying `status: "FAILED"`. A client reading only the HTTP status says "waiting for your payment" forever.
- **`phoneOperator` is asked, never guessed.** MTN or Orange. The server derives it from the prefix when it can, and refuses with `PAYMENT_OPERATOR_UNDETERMINED` when it cannot — a Nexttel number, a Camtel number, a typo. A wrong operator reaches the customer as "payment declined".
- **`requiresOtp` and `ussdCode` are exclusive.** On the My-CoolPay Orange Money branch there is no USSD code, and nothing happens until the SMS code is relayed. Rendering "dial the code" there shows a prompt that will never arrive.
- **The 30-minute hold is the deadline.** After step 6 the customer holds stock other shoppers cannot buy. If the flow stalls, say the hold lapsed — do not let them discover it.
- **Express `/buy` uses the same cart.** There is no separate buy-now basket. When the cart already holds something, say so and offer both routes. Silently discarding a basket is not acceptable.

### 8.2 · Address capture

```
                    ┌── shared location ──→ geo_reverse_address ──┐
"where do you       │                                             ├─→ confirm the
 want it?"  ────────┤                                             │   formatted address
                    └── typed text ───────→ geo_search_address ───┘   ↓
                                            (5 candidates, they pick)  addresses_add
                                                                        (candidateRef)
```

⚠ **Never save typed text directly.** An address without a geocoded location is refused at checkout, so saving one produces an address that looks fine everywhere and cannot be used. This is why `addresses_add` takes an opaque `candidateRef` from the search step rather than raw coordinates: it is structurally impossible to save an ungeocoded address, and the backend never receives a null coordinate to write. That second part matters independently — a null `location` inside the indexed address array makes the whole customer document unwritable.

⚠ **A pin is not an address.** Always show the reverse-geocoded result and have the customer confirm. A pin dropped indoors resolves to a neighbouring building often enough to matter.

### 8.3 · The other six

| Flow | Steps | Deadline | Ends by |
|---|---|---|---|
| **registration** | resolve → (Telegram: contact) → consent → create → welcome | contact prompt 10 min | account created, or declined |
| **telegram_contact_share** | prompt → contact → `login_contact` → relay | 10 min pending intent | credential delivered |
| **support** | `support_resolve_contacts` → offer party → contacts, or ticket | none | contact given or ticket opened |
| **cod_code** | pick the parcel → warn → disclose → strip from transcript | none | code shown |
| **review** | eligibility → stars → optional words → say which publishes → submit | none | submitted or abandoned |
| **cancel** | fetch → check policy → summarise → confirm → execute | confirm 5 min | cancelled or refused |

### 8.4 · What hands off to the web, and why

| Handoff | Reason |
|---|---|
| **Card payment** | Stripe's `clientSecret` needs a browser to confirm. There is no hosted page for it — **GAP-008** |
| **Making a booking** | A slot must be locked against a live calendar and used within 15 minutes; abandonment in chat is common and each one holds a slot no one else can take |
| **Editing or deleting an address** | Past orders reference the address id, and editing in place has consequences a chat window explains badly |
| **Changing email or phone** | A verification flow. The identifier deliberately does not move until proved |
| **Closing an account** | Irreversible, and anonymise-and-retain rather than deletion. Not a chat decision |
| **Setting a password** | Already `out_of_band` by design, on all three services |

---

## 9 · Errors

Full table in [`tools/errors.json`](./tools/errors.json). The three rules that matter:

**Branch on `code`, fall back to `category`.** `category` is present on every error from all three backend services and is one of nine values. The registry has 623 codes; the category is what lets the bot behave sensibly about the ~600 it has no specific handling for.

**A `business_rule` refusal is not a fault.** It is the answer. `error.message` explains which rule and is written to be shown. Apologising for it implies it might be waived.

**Never invent a cause on a 5xx.** On `internal` and `external_service` the message is replaced with a generic sentence and `details` is omitted **in every environment**. `requestId` is the only handle, and quoting it turns an unactionable failure into a support conversation that resolves.

---

## 10 · Security

### The invariants

| # | Invariant | Why |
|---|---|---|
| 1 | **No customer identifier is ever a tool parameter** | A caller-supplied identity on this surface is account takeover. Same rule `/connect` enforces, same reason the `link` command was deleted |
| 2 | **No customer bearer token ever leaves the backend** | A compromised automation layer cannot mint or hold sessions. There is no revocation lever for a passwordless customer today, so this is not recoverable if breached |
| 3 | **`flow_only` tools are not registered with the model** | Model containment by construction, not by instruction. Every money movement and every destructive action is in that tier |
| 4 | **A confirmation executes the stored call, never a re-derived one** | The summary the customer read and the call that runs are the same object |
| 5 | **Credentials are relayed, never read, summarised or stored** | Magic links, reset links, delivery codes, OTPs, download URLs. `verbatim_relay` and `sensitive_code` enforce it |
| 6 | **Two secrets, not one, on the customer surface** | A leaked service token alone does not open it |

### Per-action requirements

| Action | Auth | Confirm | Idempotent | Audited | Extra |
|---|---|---|---|---|---|
| Password reset | webhook secret | out-of-band | — | ✅ | Never collected, verified or repeated in chat. Serves every role |
| Registration | webhook secret | ✅ explicit consent | consent token | ✅ | Rate-limited per identity **and** per address |
| Checkout | service + webhook | ✅ | **GAP-001** | ✅ | Holds stock; the flow's confirm token is the interim guard |
| Payment initiate | none (by design) | ✅ | by reference | ✅ | Phone confirmed in the turn that spends it, never from context |
| OTP authorize | none (by design) | — | no | ✅ | Never stored in the transcript |
| Order cancel | service + webhook | ✅ | by state | ✅ | `explicit_only` — never from context |
| Delivery code | service + webhook | — | read | ✅ | Explicit request only; stripped from transcript; never in a summary |
| Address write | service + webhook | ✅ | candidate ref | ✅ | Structurally cannot save ungeocoded |
| Review | service + webhook | ✅ | by state | ✅ | A bare rating publishes immediately — say so first |
| Notification prefs | service + webhook | ✅ | natural | ✅ | Money and cancellations are not silenceable; say so |

### Rate limiting

Three layers already exist and the bot sits under all of them: 1200/min per IP, 600/min per customer identity, and 20/min on the credential bucket. **The automation layer is a single IP for every customer**, so the per-IP layer is the one it will hit first — the bot surface must therefore be added to the internal-service exemption for Layers A and B (internal callers already are), while keeping a **new per-messaging-identity limit** at the bot surface. Without that, one looping conversation exhausts the shared bucket for everyone.

**The credential bucket is not exempt and must not be.** Nothing internal signs in; an exemption there would only be usable by something that had already stolen the token.

### Abuse

- Registration: 3/hour per identity, 10/hour per address, plus explicit consent.
- Delivery-code resend: already 1/60s server-side.
- Confirmation tokens: single-use, 5 minutes, bound to `hash(args)`.
- Geo candidate refs: single-use, flow-scoped.
- A conversation that trips a limiter is told to wait, not silently dropped.

### Audit

Every mutation on the bot surface writes: `channel · externalId(hashed) · resolvedUserId · tool · argsHash · outcome · requestId · timestamp`. The raw messaging identifier is hashed at rest — `identityHint` is the only form that leaves the backend today (`GET /api/me/connections` deliberately returns no phone number or chat id) and the audit trail should not be the first place it does.

---

## 11 · WhatsApp and Telegram

| | WhatsApp | Telegram |
|---|---|---|
| **Sender identity** | `wa_phone_id` **is** the phone number | `chat_id`, related to nothing |
| **First contact** | Resolves immediately | Anonymous until a contact is shared |
| **Bare digits trap** | `237600123456`, while `login_phone` is `+237600123456` — a naive lookup matches nothing, for every user | `contact.phone_number` is inconsistent about the `+`; same repair |
| **Commands** | Plain text; no registry | BotFather registry, `[a-z0-9_]{1,32}` only. **`/reset-password` is parsed as `/reset`** — parse raw text |
| **Buttons** | max **3**, title ≤ 20 chars | inline keyboard, effectively unlimited |
| **Lists** | ≤ 10 rows/section, ≤ 10 sections; row title ≤ 24, description ≤ 72 | keyboard or numbered text |
| **Body text** | interactive ≤ 1024; plain ≤ 4096; header/footer ≤ 60 | 4096 |
| **Proactive messages** | **24-hour service window.** Outside it, only approved templates | unrestricted |
| **Location** | ✅ | ✅, and can be *requested* with a keyboard button |
| **Rich forms** | WhatsApp Flows | Web App |
| **Link preview off** | `preview_url: false` | `disable_web_page_preview: true` |
| **Product cards** | native `product` / `product_list` — needs a Meta Commerce catalogue (**GAP-009**) | photo + caption + inline keyboard |

### The two asymmetries that shape design rather than rendering

**The 24-hour service window.** Outside it, WhatsApp permits only pre-approved templates. Every *proactive* bot message — "your payment succeeded", "your order shipped" — needs one. Payments settle in minutes and stay inside the window; a shipping update three days later does not. The `customer_*` templates already exist for the COD code and are the pattern for any new one. **Telegram has no equivalent, so this is not symmetrical and must not be designed as if it were.** Where a flow waits, the WhatsApp branch either finishes inside the window or ends with "we will message you" and a template.

**Telegram's command grammar.** Underscore-safe canonical names, hyphenated aliases, and parse from the raw message text. This is already live and already slightly broken: `/reset-password` cannot be registered with BotFather and Telegram's own entity parser stops at the hyphen. Nothing is broken *today* because n8n reads the text — but a future implementation that trusts the entity would break the existing command.

---

## 12 · Deliberately not built

| Not built | Why |
|---|---|
| **Live GPS in chat** | A per-viewer WebSocket token the bot must not hold. The shipment record is the better chat answer |
| **A generic API proxy at `/api/internal/bot/*`** | Whatever the customer API grows next would become reachable from a chat window with no decision taken |
| **A `/region` command** | No region concept exists on a customer anywhere in the backend — **GAP-010** |
| **Booking creation in chat** | A 15-minute calendar lock plus a high chat abandonment rate means holding slots nobody takes |
| **Address edit and delete** | Past orders reference the address id |
| **Bot-side product translation** | Product text is vendor-authored in one language, and the product says which. Translating it silently misrepresents the seller |
| **A separate "buy now" cart** | One cart, one checkout. Two would disagree |
| **Proactive marketing messages** | The `marketing` preference defaults to `false` and gates nothing yet — it exists so a future campaign cannot be bolted onto order updates. Respect that |

---

## 13 · Build order

Nothing below is implementation; it is the order in which the gaps unblock each other.

1. **GAP-001** — the bot surface, with `identity_resolve_sender` and the read tools only. Unblocks 44 of the 60 tools and is testable on its own.
2. **GAP-002** + **GAP-011** — registration and the webhook-secret decision, together. Neither is safe without the other.
3. Cart and order writes on the surface from step 1, with `Idempotency-Key`.
4. ✅ **GAP-004** — the support-context composite. **BUILT 2026-08-26**; the three-call fallback is retired.
5. Checkout and payment flows.
6. **GAP-003**, **GAP-005**…**GAP-010** — as their commands are wanted.

---

## Related

- [COMMAND-SPECIFICATION.md](./COMMAND-SPECIFICATION.md) — every command, with syntax, behaviour and per-platform rendering
- [BACKEND-GAPS.md](./BACKEND-GAPS.md) — the twelve gaps, specified
- [RECOMMENDATIONS.md](./RECOMMENDATIONS.md) — what changed from the original proposal, and the open risks
- [tools/catalog.json](./tools/catalog.json) · [tools/commands.json](./tools/commands.json) · [tools/errors.json](./tools/errors.json) · [tools/tool.schema.json](./tools/tool.schema.json)
- [../auth/N8N-HANDOFF.md](../auth/N8N-HANDOFF.md) — the live seven-item handoff this design extends
- [../auth/magic-login.md](../auth/magic-login.md) · [../auth/customer-auth.md](../auth/customer-auth.md) · [../whatsapp/README.md](../whatsapp/README.md) · [../telegram/README.md](../telegram/README.md)
