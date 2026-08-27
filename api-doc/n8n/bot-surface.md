# The curated bot surface — `/api/internal/bot/*`

**Status:** BUILT, 2026-08-25. GAP-001, and GAP-005 with it.
**GAP-002 and GAP-011 landed 2026-08-26** — registration on first contact, the onboarding
checklist, and `error.customerMessage`. See §11.
**GAP-004 landed 2026-08-26** — the support-routing composite. See §12.
**GAP-012 and GAP-008 landed 2026-08-26** — the service-window read, the proactive hand-off,
and the hosted card page's link. See §13.
**Source of truth:** `src/modules/bot-surface/`. The route table is
`domain/bot-route-table.ts` and it is pinned to [`tools/catalog.json`](./tools/catalog.json)
by `npm run test:bot-surface`.
**`reply` landed 2026-08-26 and the button rule 2026-08-27** — the backend now composes the
channel-ready request body. See §14.
**Verified:** `npm run test:bot-surface` (153, no DB) · `npm run verify:bot-surface`
(74, NEEDS Mongo + Redis) · `npm run verify:bot-registration` (73, NEEDS Mongo + Redis).

The door the automation layer acts through. Forty-eight named operations, service-token
authenticated, carrying a **messaging identity** the backend resolves to a customer. No
customer bearer token is ever issued to the automation layer.

> ### Start here if you are wiring n8n
>
> **Call `POST /identity/sync` on every inbound message, before anything else.** It creates
> the customer account if there is none, tells you whether this is their first message, and
> tells you what is still missing from their profile. §11 is the whole flow.
>
> **Every response carries a sentence you can send as-is.** On success it is
> `data.onboarding.next.prompt`; on failure it is `error.customerMessage`. Both are in the
> customer's language. Never relay `error.message`, and never a code.
>
> ⭐ **Better: every response carries the whole REQUEST, ready to POST — `reply`.** Text,
> keyboard, button labels and all, for Telegram or WhatsApp. You send it unmodified. See
> [§ 14](#14--reply--the-request-body-you-post-to-the-channel-unmodified), and
> [§ 14.6](#146--a-determined-answer-is-a-button-never-a-typed-word) for the rule that a
> closed answer set is always a button and never a typed word.

---

## 1 · Authentication — two credentials, and both are required

| Header | Value | Notes |
|---|---|---|
| `Authorization: Bearer <token>` | `INTERNAL_SERVICE_TOKEN` | The same value geo-tracker presents on `/api/internal/agents`. `X-Service-Token` is accepted as an alternative header |
| `X-Webhook-Secret` | `BOT_WEBHOOK_SECRET` | The same value the bot webhooks require |
| `X-Request-Id` | any correlation id | Optional. Stamped onto every log line for the request |
| `Idempotency-Key` | a per-attempt unique string, ≤ 200 chars | **Required on every mutating route.** See §4 |

⚠ **A leaked `INTERNAL_SERVICE_TOKEN` alone does not open this surface.** That is the whole
reason for the second credential: the service token already opens the agent and shipment
surfaces, and it must not also open every customer's cart, orders and addresses. The two
secrets are held by different parts of the deployment and rotate on different schedules.

Failure modes:

| Situation | Answer |
|---|---|
| No service token, or a wrong one | `401 AGENT_SERVICE_TOKEN_INVALID` |
| `INTERNAL_SERVICE_TOKEN` unset on the server | `503 AGENT_SERVICE_TOKEN_NOT_CONFIGURED` — the surface is closed |
| No webhook secret, or a wrong one | `401 WEBHOOK_SECRET_INVALID` |

⛔ **`BOT_WEBHOOK_SECRET` is REQUIRED IN EVERY ENVIRONMENT since 2026-08-26 (GAP-011), and
the service refuses to BOOT without it.** It used to be refused in production and open in
development, on the argument that an open dev webhook could at worst mint a connection code.
GAP-002 removed that bound: registration is dispatchable now, with no consent step, so an
open webhook creates platform accounts against strangers' phone numbers at scale. Set the
same value here and on the automation layer.

---

## 2 · The identity envelope — on every call

```jsonc
{
  "identity": {
    "channel": "whatsapp" | "telegram",
    "externalId": "237600123456",   // wa_phone_id (BARE DIGITS) or a Telegram chat_id
    "displayName": "Ada",           // optional, cosmetic
    "handle": "@ada"                // optional, Telegram only
  },
  // …the operation's own arguments, beside `identity` rather than nested
}
```

⚠ **`identity` is the only identity. There is no `customerId`, `userId` or token parameter
on any route, ever.** The envelope schema is `.strict()`, so a caller-supplied `customerId`
is a **400** rather than a silently stripped field. On a surface that reaches carts, orders
and saved addresses, a caller-supplied identity is not a leak but account takeover — the
same rule `/connect` already enforces.

⚠ **`externalId` must be exactly what the webhook delivered.** Meta sends `wa_phone_id` as
bare digits (`237600123456`) while the platform stores `login_phone` as strict E.164
(`+237600123456`); the backend bridges that. Do not "helpfully" add a `+`.

### Resolution and its refusals

Resolved server-side by the same ladder `/login` uses
(`messaging-login/services/identity-resolver.service.ts`): a `channel_connections` lookup,
then — WhatsApp only — the sender id as a phone number, then — Telegram only — a demand for
a verified contact.

| Outcome | Status | Code | `details.state` | What the flow should do |
|---|---|---|---|---|
| resolved | — | — | — | proceed |
| Telegram, first contact | 409 | `BOT_IDENTITY_NEEDS_CONTACT` | `anonymous` | render the `request_contact` keyboard |
| no account | 404 | `BOT_IDENTITY_UNRESOLVED` | `anonymous` | offer registration (GAP-002, unbuilt) |
| a vendor / agency / agent | 403 | `BOT_IDENTITY_NOT_CUSTOMER` | *(absent — see below)* | tell them to sign in with their password |
| this identity belongs to another account | 403 | `BOT_IDENTITY_NOT_CUSTOMER` | *(absent)* | same answer, deliberately |
| account suspended | 403 | `AUTH_ACCOUNT_SUSPENDED` | `non_customer` | stop |

⚠ **`details` is ABSENT on `BOT_IDENTITY_NOT_CUSTOMER`, and that is the error system rather
than an omission.** Phase 16 filters `details` at the boundary by category, and
`authorization` admits only `required` / `requiredAny` / `resource` / `hint` — an
authorization failure that echoes facts about the caller is the leak that allowlist exists
to close. Nothing is lost: the code says everything a client may know, and the two 403 rows
above deliberately share one code so a caller cannot learn that *some other account* owns
the number they are writing from.

`AUTH_ACCOUNT_SUSPENDED` keeps its `details` because it carries a category override to
`authentication` — "the account cannot authenticate at all, not a per-resource denial".

**Resolution has one side effect, on success only.** A WhatsApp identity that resolved by
phone number is bound into `channel_connections`, exactly as `/login` binds it, so every
later call takes the fast path. A refusal binds nothing.

---

## 3 · Every route

All forty-eight. `POST`, `PATCH` and `DELETE` only — **no `GET`**, because the identity
envelope is a body and a messaging identifier in a query string is a real person's phone
number written into every access log on the path.

⚠ **Three routes are `DELETE` WITH A BODY.** Express parses one without complaint, but some
HTTP clients and intermediaries drop it. A caller finding `identity` missing on exactly
those three has hit that, not a backend bug.

| Tool | Method | Path | Mutating |
|---|---|---|---|
| `identity_resolve_sender` | POST | `/identity/resolve` | |
| `identity_sync_sender` | POST | `/identity/sync` | ✔ |
| `identity_submit_onboarding` | POST | `/identity/onboarding` | ✔ |
| `cart_get` | POST | `/cart/get` | |
| `cart_quote` | POST | `/cart/quote` | |
| `cart_add_item` | POST | `/cart/items` | ✔ |
| `cart_set_item_quantity` | PATCH | `/cart/items/:variantId` | ✔ |
| `cart_remove_item` | DELETE | `/cart/items/:variantId` | ✔ |
| `cart_clear` | DELETE | `/cart` | ✔ |
| `checkout_create_orders` | POST | `/checkout` | ✔ |
| `payment_get_transaction` | POST | `/payments/:transactionId` | |
| `payment_create_pay_link` | POST | `/payments/:transactionId/pay-link` | ✔ |
| `orders_list_groups` | POST | `/orders/list` | |
| `orders_get_group` | POST | `/orders/groups/:cartId` | |
| `orders_get_order` | POST | `/orders/:orderId` | |
| `orders_list_shipments` | POST | `/orders/:orderId/shipments` | |
| `orders_get_cod_code` | POST | `/orders/:orderId/cod-code` | |
| `orders_cancel` | POST | `/orders/:orderId/cancel` | ✔ |
| `orders_resend_cod_code` | POST | `/orders/:orderId/shipments/:shipmentId/resend-delivery-code` | ✔ |
| `orders_confirm_shipment_delivery` | POST | `/orders/:orderId/shipments/:shipmentId/confirm-delivery` | ✔ |
| `profile_get_summary` | POST | `/profile` | |
| `profile_set_language` | PATCH | `/profile/language` | ✔ |
| `addresses_list` | POST | `/addresses/list` | |
| `addresses_add` | POST | `/addresses` | ✔ |
| `addresses_set_default` | PATCH | `/addresses/:addressId/default` | ✔ |
| `geo_search_address` | POST | `/geo/search` | |
| `geo_reverse_address` | POST | `/geo/reverse` | |
| `tickets_list` | POST | `/tickets/list` | |
| `tickets_create` | POST | `/tickets` | ✔ |
| `tickets_get` | POST | `/tickets/:ticketId` | |
| `tickets_add_note` | POST | `/tickets/:ticketId/notes` | ✔ |
| `tickets_close` | POST | `/tickets/:ticketId/close` | ✔ |
| `support_resolve_contacts` | POST | `/support/context` | |
| `wishlist_list` | POST | `/wishlist/list` | |
| `wishlist_add` | POST | `/wishlist` | ✔ |
| `wishlist_remove` | DELETE | `/wishlist/:productId` | ✔ |
| `recently_viewed_record` | POST | `/recently-viewed` | ✔ |
| `digital_list_entitlements` | POST | `/digital/my-products` | |
| `digital_create_download_link` | POST | `/digital/download-links` | ✔ |
| `bookings_list` | POST | `/bookings/list` | |
| `bookings_get` | POST | `/bookings/:bookingId` | |
| `bookings_cancel` | POST | `/bookings/:bookingId/cancel` | ✔ |
| `reviews_check_eligibility` | POST | `/reviews/eligibility` | |
| `reviews_create` | POST | `/reviews` | ✔ |
| `notifications_get_preferences` | POST | `/notifications/preferences` | |
| `notifications_update_preferences` | PATCH | `/notifications/preferences` | ✔ |
| `messaging_get_window` | POST | `/messaging/window` | |
| `messaging_notify_customer` | POST | `/messaging/notify` | ✔ |

Argument shapes are in [`tools/catalog.json`](./tools/catalog.json), which is the contract
the automation layer is generated from. The route table asserts itself against it.

**Everything delegates.** Each handler calls the same service the customer API calls, with
a customer id the backend resolved. No business rule lives on this surface — the stock
semantics, the COD gates, the cancellation policy, the review eligibility matrix and the
delivery-address requirement are all enforced where the storefront already exercises them,
so the two doors cannot disagree.

---

## 4 · Idempotency

`Idempotency-Key` is **required** on every mutating route. The record is scoped to
`(resolved identity, key, request fingerprint)`, lives 24 hours, and a repeat returns the
stored response with `Idempotency-Replayed: true`.

⚠ **`POST /checkout` is the reason.** It is not idempotent underneath: a retried call
creates a second set of orders and a second thirty-minute stock hold, and chat transports
retry constantly. `POST /cart/items` is the same shape in miniature, silently doubling a
line.

| Situation | Answer |
|---|---|
| No key on a mutating route | `400 BOT_IDEMPOTENCY_KEY_REQUIRED` |
| The first call has not answered yet | `409 BOT_IDEMPOTENCY_IN_PROGRESS` — retry shortly |
| The key was spent by a **different** request | `409 BOT_IDEMPOTENCY_KEY_REUSED` — a caller bug |
| The record store is unreachable | `503 BOT_IDEMPOTENCY_STORE_UNAVAILABLE` — nothing ran |

Three properties worth knowing:

- **A failure releases the key.** Only a 2xx is stored, so a 422 from the stock gate or a
  502 from a gateway leaves the key retryable once the cause is gone. Storing a failure and
  replaying it forever would turn a transient outage into a permanently poisoned key.
- **A crash costs a minute, not a day.** The unanswered claim carries a 60-second TTL; only
  a completed response is extended to 24 hours.
- ⚠ **The guard FAILS CLOSED**, unlike the rate limiter and the worker lock, which fail
  open. What an absent record costs here is a second set of orders on a money path, at
  exactly the moment retries are most likely; what failing closed costs is that a chat
  cannot check out until Redis returns, while reads and the whole storefront carry on.

---

## 5 · The address flow (GAP-005)

**Coordinates never leave the backend, and `POST /addresses` cannot be sent any.**

```
geo_search_address  { q: "njo njo" }
   → [ { candidateRef: "gc_a3f…", formattedAddress: "…", components: {…} } ]

addresses_add       { label: "Home", geoCandidateRef: "gc_a3f…", addressLine2: "blue gate" }
   → { id, label, formattedAddress, isDefault, deliverable }
```

The handle is opaque, single-use, scoped to the resolved account, and lives 30 minutes.
`400 BOT_GEO_CANDIDATE_EXPIRED` when it is unknown, spent or stale — **re-run the search,
never re-send held coordinates.**

Two reasons, and the second has already cost this platform something:

1. A machine that can construct a `geo` object can construct a wrong one, and an address
   that looks right and points somewhere else is a delivery to the wrong street.
2. ⚠ **A `null` inside the 2dsphere-indexed saved-address array makes the WHOLE customer
   document unwritable** — measured, not fixed by a sparse or partial index, and it presents
   days later as "this customer cannot be edited at all". A caller assembling `geo` objects
   sends a null eventually.

`geo_reverse_address` takes a coordinate the customer's own device produced (a WhatsApp or
Telegram location pin) and mints a handle from it. Coordinates may come **in**; they never
go back out. A `null` answer is legitimate — a pin in the middle of a field has no address.

`addresses_list` reports `deliverable` (has a geocoded location — the single fact checkout
needs) and omits raw coordinates for the same reason.

---

## 6 · Where the output differs from the customer API

Four places, and each exists because a chat window makes something specific true.

| Route | Difference | Why |
|---|---|---|
| `POST /profile` | `email` and `phone` **masked**; `savedAddresses` → `savedAddressCount`; avatar, bio, date of birth and payment methods dropped | A chat window is shared, screenshotted and shoulder-surfed, and passes through a model's context. The customer already knows their own number |
| `POST /addresses/list` | adds `deliverable`; omits `coordinates` | See §5 |
| `POST /geo/*` | a `candidateRef` instead of a pin | See §5 |
| `POST /orders/groups/:cartId` **and** `POST /orders/:orderId` | `codCollections[].deliveryCode` **stripped** | It is a payment credential. Disclosure happens only through `/orders/:orderId/cod-code` |

⚠ **The delivery-code strip applies to BOTH order reads, and GAP-001 named only the group.**
Both are built by the same projection, so leaving one open would make closing the other
pointless. Deliberate deviation from the plan, recorded here.

Two response-shape exceptions inherited from the surfaces underneath, both matching the
catalogue:

- `payment_get_transaction` answers `{ success, transaction }`, not `{ success, data }` — it
  mirrors `GET /api/payments/:transactionId` byte for byte.
- The three ticket tools answer `{ success, data, pagination }`, not `meta` — that is the
  ticket module's existing shape on every role's mount.

---

## 7 · Deviations from the catalogue, and one documentation defect

Every one of these is a place where the catalogue and the platform disagreed, and the
platform won.

| Catalogue says | Reality | Why |
|---|---|---|
| `tickets_create.description` maxLength 5000 | **700** | `TicketSchema.description` carries `maxlength: 700`. Accepting 5000 would parse cleanly and fail on the model as a 500 for what is plainly the caller's input problem |
| `tickets_*` return `ticket_number` | **No such field exists** | See below |
| `reviews_create` takes `body` | ✔ and **no `title`** | The customer API accepts both; a chat produces one block of prose, and splitting it is the paraphrase the catalogue tells the model not to perform |
| `notifications_update_preferences.channel` | ✔ one value, not three booleans | The customer API takes three independent flags because a settings screen renders three switches. One value says the only thing that is true — at most one secondary channel |
| `checkout.deliveryAddressId` | ✔ **required**, unlike the customer API | A chat's confirmation is a sentence a turn earlier; a default-address fallback lets the sentence and the order disagree with nobody able to see it |

⚠ **`ticket_number` DOES NOT EXIST.** The catalogue names it in `important_fields` for three
tools and `api-doc/customer/tickets.md` + `api-doc/agent/tickets.md` show it in their
example bodies — but `TicketSchema` has no such path and nothing in `src/` writes one,
verified by source scan on 2026-08-25. **It is a pre-existing documentation defect in those
two api-doc pages, inherited by the catalogue**, not a field this surface declined to
project. Tickets are addressed by `_id`, and `tickets_get` accepts an id only.

---

## 8 · Maintenance mode

`/api/internal/bot/*` is **blocked in `down`** and **read-only in `readonly`**, like the
ordinary customer surface.

⚠ **It is deliberately NOT on the cross-service exemption list.** `/api/internal/agents/*`,
`/api/tracking/*` and `/api/internal/shipments/*` are exempt because blocking them turns a
jovi-mall maintenance window into a **geo-tracker** outage. A chat bot has no such property:
a customer told "we are briefly down for maintenance" has been correctly served.

The rule needs its own branch only because this surface's **reads are POSTs**, so the
ordinary safe-method test would refuse all of them. `modules/system/domain/maintenance-mode.ts`
consults the route table, so the maintenance verdict and the route that would actually run
cannot disagree. An unrecognised bot path fails closed.

---

## 9 · What this is NOT

**Not a generic proxy.** A route forwarding arbitrary paths would make whatever the customer
API grows next reachable from a chat window with no decision taken. Every route in §3 was
chosen.

**Not a session mint.** No customer bearer token is ever issued to the automation layer, and
there is no endpoint here that could produce one. That is load-bearing rather than
fastidious: a passwordless customer has **no session-revocation path at all** —
`password_changed_at` is this service's only lever and a customer who has never reset has
never set it — so a compromised automation layer must not be able to hold customer sessions.
`test:bot-surface` scans the module for `issueTokenPair`, `setAuthCookies` and the
login-session store.

**Not rate-limited on its own axis, yet.** GAP-006 is open: the automation layer is a single
IP for every customer, and jovi-mall's Layer A is IP-scoped at 1200/min — so one busy hour
puts every conversation behind one counter. This surface is **not** on the internal-caller
exemption list and has no per-identity limiter.

**Not audited on its own axis, yet.** GAP-007 is open. Mutations are journaled the way every
request is, and there is no per-tool audit row.

⚠ **This section used to say registration and the support composite were unbuilt. Both
landed on 2026-08-26** — GAP-002 as `POST /identity/sync` (§11, and note it is *not* the
`POST /identity/register` the old text named, nor does it branch on `requiresCustomerRole`,
which could not serve as that seam), and GAP-004 as `POST /support/context` (§12). What
remains open on this surface is GAP-006 and GAP-007 above.

---

## 10 · Operational notes

**One Redis database, `BOT_SURFACE_DB` (10)**, holding both of this surface's stores behind
key prefixes: `bot:idem:*` (idempotency records, 24 h) and `bot:geo:*` (address-candidate
handles, 30 min). It is **prefix-only** in the cache-flush policy — a whole-database flush
would take the duplicate-checkout guard along with the harmless half — and the policy row
states both radii separately.

⚠ **The index is 10 because this service may only assign 5–15**, and that is two constraints
stacked:

- **Redis's `databases` defaults to 16**, so 0–15 are the only valid indices. Measured:
  `SELECT 16` → `ERR invalid DB index`, and `CONFIG SET databases 32` → `ERR Unsupported
  CONFIG parameter` (it is startup-only). True of the compose stack too, whose
  `redis:7-alpine` services carry no `command:` override.
- ⚠ **wi-admin owns 1, 2 and 3** (`ADMIN_SESSION_DB`, `ADMIN_RATE_LIMIT_DB`,
  `PERMISSION_CACHE_DB`) whenever the two services share one Redis — which compose avoids by
  giving each its own instance and a developer machine does not. DB 0 additionally holds the
  calendar-sync lock.

10 was `TELEGRAM_WINDOW_DB`, reserved for a 24-hour service window **the Telegram Bot API
does not have** — so nothing ever wrote it (no reader, no writer, verified by source scan;
the live database was empty). Reclaiming it is not the same as reusing retired 4 or 9, which
did hold keys and stay unassigned.

**Two pre-existing defects surfaced here**, neither caused by this work and both now recorded
in `redis.factory.ts`:

- **`RECOMMENDATION_CACHE_DB = 16` was above the ceiling and its cache had never once run**
  since 2026-08-21 — silently, because `related-products.cache.ts` correctly fails open. It
  is now the `related:*` prefix on `CACHE_DB` (15, formerly `GEO_CACHE_DB`), which is the
  first time that cache has worked.
- **`EMAIL_VERIFY_DB = 3` collides with wi-admin's `PERMISSION_CACHE_DB`.** Left alone: both
  are exact gets, so nothing reads the other's keys, and the separate-instance deployment has
  no cost at all.

`test:system` now refuses any database above the ceiling **or** newly below 5, with `3`
baselined and its reasoning attached.

**No new environment variables.** The surface reuses `INTERNAL_SERVICE_TOKEN` and
`BOT_WEBHOOK_SECRET`; both TTLs are constants.

**Nine new error codes**, all `BOT_*` except the reused `AUTH_ACCOUNT_SUSPENDED`:
`BOT_IDENTITY_UNRESOLVED` · `BOT_IDENTITY_NEEDS_CONTACT` · `BOT_IDENTITY_NOT_CUSTOMER` ·
`BOT_IDEMPOTENCY_KEY_REQUIRED` · `BOT_IDEMPOTENCY_IN_PROGRESS` ·
`BOT_IDEMPOTENCY_KEY_REUSED` · `BOT_IDEMPOTENCY_STORE_UNAVAILABLE` ·
`BOT_GEO_CANDIDATE_EXPIRED`.

---

## 11 · Registration on first contact, and the onboarding checklist (GAP-002)

**Built 2026-08-26.** Code: `services/bot-registration.service.ts` +
`domain/bot-onboarding.ts`. Verified by `npm run verify:bot-registration` (62, NEEDS Mongo
+ Redis).

### 11.1 · Two decisions that reverse what BACKEND-GAPS.md specifies

The written spec (§ GAP-002) is the plan; **two of its five design decisions were reversed
by the product owner on 2026-08-26** and the code follows the reversals.

| | Specified | Built |
|---|---|---|
| **D-2 · consent** | The bot asks "shall I create an account?", mints a single-use `consentToken`, creates nothing until it comes back | ⛔ **No consent step, no `consentToken`, no route that mints one.** The account is created silently on the sender's first message |
| **D-3 · business accounts** | A vendor, agency or agent is never upgraded — they keep the `not_customer` refusal | ⛔ **They ARE upgraded.** Every inbound chat is a customer conversation, so a business account acquires a customer role and profile like anybody else |

D-1 (reuse the identity ladder), D-4 (the system-generated password) and D-5 (seed the
language honestly) are implemented as written.

⚠ **The argument against silent creation is unchanged and was accepted as a cost, not
settled.** Creating an account is a durable act with a data-protection footprint, and a
person who messaged a shop to ask a price did not ask for one. What softens it: nothing is
collected that the channel did not already hand over, and every field beyond that is asked
for one turn at a time with a real refusal available.

⚠ **One consequence of D-3 reaches outside this surface.** Once a vendor holds a customer
role, `resolveForLogin` starts succeeding for them — so the bot `/login` command will mint
them a **customer session** where it used to refuse. Nothing else about their vendor account
changes, and `/reset-password` still resolves against the roles they actually hold.

### 11.2 · The flow

```
EVERY inbound message
  → POST /identity/sync
      ├── registered:true,  isNew:true   → account just created. Greet them.
      ├── registered:true,  isNew:false  → known customer. Carry on.
      └── registered:false               → Telegram, unbound. Ask for the number.

  → if onboarding.complete is false, ask onboarding.next
      → POST /identity/onboarding { step, action, <the step's field> }
      → repeat until onboarding.complete is true

  → onboarding.complete flipped to true?
      → NOW answer the message they sent before you interrupted them.
```

⚠ **The automation layer holds that first message, not the backend.** There is deliberately
no `message` field on `/identity/sync`. Storing it here would mean either a durable column of
raw customer message text in the profile collection with no retention policy, or a Redis
stash whose expiry is a second thing to reason about — and the n8n execution that asked the
question is already the natural place for it. Product owner's decision, 2026-08-26.

### 11.3 · The checklist

Four steps, in this order. **The order is the ask order** and `next` walks it.

| Step | Required | Satisfied by | Notes |
|---|---|---|---|
| `phone` | ✔ | WhatsApp: automatically at creation. Telegram: a verified contact | The account's identifier. First, because on Telegram nothing else can be recorded until it exists |
| `name` | ✔ | `name` (2–100 chars) | Pre-filled from the messaging profile, so the ask is a confirmation. **Cannot be skipped** — it is what a delivery agent reads |
| `email` | | `email`, or `action: "skip"` | Written to the profile only. Never becomes a login identifier |
| `address` | | an `address` object, or `action: "skip"` | Same shape as `addresses_add`. The first address saved is always the default |

**Language is never a step.** It is seeded at creation from `identity.language` (Telegram's
`from.language_code`; WhatsApp sends nothing) when it matches one of `en · fr · pt · es · ar`,
and corrected afterwards by `profile_set_language`. A later hint never overwrites a stored
preference.

⚠ **Forward `identity.language` on Telegram.** Before an account exists it is the only thing
deciding whether that first prompt is French or English — there is no profile to read yet.
After it exists, the customer's own `preferences.language` wins and the hint is ignored.

**Every step carries its own `prompt`**, so no step needs wording in your workflow:

| Step | The prompt does |
|---|---|
| `phone` | asks for the number; on Telegram it says "tap the button" and sets `requestContact` |
| `name` | asks what to put on their deliveries |
| `email` | asks the question; the **Skip button** in `reply` carries the option |
| `address` | asks the question; the **Skip button** in `reply` carries the option |

⚠ **UPDATED 2026-08-27 — a skippable step's prompt no longer mentions skipping.** This used
to read: *"A skippable step's prompt says so out loud. The customer cannot see
`skippable: true`, and a question they do not know they may decline is not optional in any
sense that reaches them."*

The observation stands and the remedy changed. The old copy told the customer to **type** a
word — *"just say \"skip\""* — which is a word that differs per language, so something on the
path back had to know five of them. The option is now a **button** carrying the untranslated
token `skip:<step>`, and the prompt went back to being a plain question
(*"Would you like to add an email address?"*). See
[§ 14.6](#146--a-determined-answer-is-a-button-never-a-typed-word) — that section states the
general rule, which applies to every future turn with a closed answer set.

⚠ **`skipped` is why this is stored rather than derived.** A null email cannot tell "not
asked yet" from "asked, and they said no", so a derived checklist would ask for an email on
every message for the rest of the account's life.

⚠ **Skipping is not a one-way door.** A customer who declined their email in January may
provide it in March; `provide` is accepted on any step in any state. Only `skip` on a
required step is refused.

### 11.4 · `POST /identity/sync`

Takes **no arguments** — the identity envelope is the whole input.

```jsonc
// → request
{
  "identity": {
    "channel": "whatsapp",
    "externalId": "237600123456",
    "displayName": "Ada Nkeng",
    "language": "fr"              // optional; Telegram from.language_code
  }
}

// ← 201 on the call that created the account, 200 otherwise
{
  "success": true,
  "data": {
    "registered": true,
    "isNew": true,                // ⚠ true EXACTLY ONCE per account
    "upgraded": false,            // true when a business account gained a customer profile
    "state": "customer",
    "customer": {
      "state": "customer", "isCustomer": true,
      "displayName": "Ada Nkeng", "language": "fr",
      "connectedChannels": ["whatsapp"],
      "hasOpenOrders": false,
      "identityHint": "••••3456"
    },
    "onboarding": {
      "complete": false,
      "steps": [
        { "step": "phone",   "required": true,  "state": "provided", "at": "2026-08-26T…" },
        { "step": "name",    "required": true,  "state": "pending",  "at": null },
        { "step": "email",   "required": false, "state": "pending",  "at": null },
        { "step": "address", "required": false, "state": "pending",  "at": null }
      ],
      "next": {
        "step": "name", "required": true, "skippable": false,
        "field": "name", "kind": "text",
        "prompt": "Quel nom dois-je utiliser pour vous ?…"   // ⭐ RELAY THIS VERBATIM
      },
      "outstandingRequired": ["name"],
      "remaining": 3
    }
  }
}
```

⭐ **`onboarding.next.prompt` is the sentence to send.** It is localised, written for a chat
window, and always present when `next` is non-null. The other fields on `next` tell your
flow *what to do with the answer*; `prompt` is what the customer reads. Never compose your
own — see §11.6, which is the same rule `error.customerMessage` follows.

⭐ **`onboarding.next.requestContact: true` means attach a Telegram `request_contact`
keyboard.** It appears on the Telegram phone step and nowhere else — **absent, not `false`**,
so branch on presence. **This is the marker n8n already handles** for `/login` and
`/reset-password` (`api-doc/auth/magic-login.md`), so the Telegram registration turn needs no
new branch in the workflow:

```jsonc
// Telegram, first contact — the complete reply, ready to send
{
  "registered": false, "isNew": false, "state": "anonymous", "customer": null,
  "onboarding": {
    "complete": false,
    "next": {
      "step": "phone", "required": true, "skippable": false,
      "field": "contact", "kind": "phone_contact",
      "prompt": "D'abord, j'ai besoin de votre numéro de téléphone pour créer votre compte. Appuyez sur le bouton ci-dessous pour le partager.",
      "requestContact": true          // ⭐ attach the request_contact keyboard
    },
    "outstandingRequired": ["phone", "name"], "remaining": 4
  }
}
```

⚠ **Branch on `isNew`, not on `!onboarding.complete`.** `isNew` is true exactly once per
account and is the first-message signal. A caller that greets on an incomplete checklist
greets on every message until onboarding finishes.

**Telegram, first contact** answers **200 with `registered: false`** — not a refusal. A
`chat_id` maps to no phone number, so there is genuinely no account yet, but "we need your
number" is an ordinary first turn rather than an error. `customer` is `null` and
`onboarding.next.step` is `phone`, so the same field drives the `request_contact` keyboard
that drives every other prompt.

⚠ **`/identity/sync` is `mutating`, so a `readonly` maintenance window refuses it.** That is
correct — no account can be created while the platform is read-only. Fall back to
`identity/resolve`, which is a read and keeps working for everybody who already has one.

### 11.5 · `POST /identity/onboarding`

```jsonc
// name
{ "identity": {…}, "step": "name",  "name": "Ada N." }
// email, or a refusal of it
{ "identity": {…}, "step": "email", "email": "ada@example.com" }
{ "identity": {…}, "step": "email", "action": "skip" }
// address — a candidateRef from geo_search_address, NEVER coordinates
{ "identity": {…}, "step": "address",
  "address": { "label": "Home", "geoCandidateRef": "gc_a3f…", "addressLine2": "blue gate" } }
// phone — Telegram's contact share. THIS is what creates the account there.
{ "identity": {…}, "step": "phone",
  "contact": { "phoneNumber": "237600123456", "userId": "<the sender's chat_id>",
               "firstName": "Ada" } }
```

`action` defaults to `"provide"`. The response is **the same body `/identity/sync` returns**,
so a caller parses one shape throughout.

⚠ **THE GUARD THE TELEGRAM FLOW RESTS ON: `contact.userId` must be the sender's own.** A
Telegram user can share somebody else's contact card and it arrives in exactly this shape.
`userId` is therefore **required** here (it is optional on the older `login_contact` command,
which refuses a missing one a line later) and is compared against the envelope's
`externalId`, never against anything else in the payload. A mismatch is
`400 MAGIC_CONTACT_UNVERIFIED` and creates nothing.

### 11.6 · ⭐ Every response carries a sentence — relay it, never the code

**One rule across this whole surface, success and failure alike:**

| Outcome | Field to relay |
|---|---|
| success, and something is still needed | `data.onboarding.next.prompt` |
| failure, any code | `error.customerMessage` |

Both are localised (`en · fr · pt · es · ar`), written for a chat window, and never name an
error code, a field name or an internal concept. **You never have to compose a sentence, and
you never have to translate one.**

> ⭐ **Since 2026-08-26 you do not have to compose the REQUEST either — see [§ 14](#14--reply--the-request-body-you-post-to-the-channel-unmodified).**
> Both fields below are still present and still mean what this section says; but the response
> now also carries a top-level `reply` holding the complete, channel-ready body to POST,
> keyboard and all. Prefer it. These two are what you read when your model needs to know what
> was said; `reply` is what you send.

⚠ **The success half was missing in the first cut of GAP-002 and was reported straight
away.** `next` carried descriptors only, on the stated reasoning that the wording belonged to
the automation layer — which is the same premise the error copy below exists to correct. A
Telegram sender got `next.step: "phone"` and there was nothing that could be said to them.
Both halves now follow one rule.

#### `error.customerMessage`

**Every failure on this surface now carries a sentence written for the person in the chat,
in their language.** Added 2026-08-26 at the product owner's request, because the automation
layer has no copy table and no translator: relaying `error.message` would put *"No platform
account is bound to this messaging identity"* in front of a customer.

```jsonc
{
  "success": false,
  "requestId": "req_…",
  "error": {
    "code": "BOT_ONBOARDING_STEP_NOT_SKIPPABLE",
    "message": "That onboarding step is required and cannot be skipped",   // for YOU
    "customerMessage": "Ce n'est pas possible pour le moment.",            // for THEM
    "statusCode": 422,
    "category": "business_rule",
    "details": { "step": "name" }
  }
}
```

| Field | Audience | Use it for |
|---|---|---|
| `code` | your flow | branching |
| `category` | your flow | generic branching — one of nine, always present |
| `message` | you, and the operator | logs, incident reports. **Never relay this** |
| `customerMessage` | the customer | **relay verbatim.** Always present on this surface |
| `details` | your flow | which step, which field |

Four properties:

- **Always present, on every code**, including ones nobody anticipated. Specific copy exists
  where being specific changes what the customer does; everything else falls back to a
  sentence keyed on the **category**, which is derived and always present. **There is no path
  by which a raw code reaches a chat window.**
- **Languages: `en · fr · pt · es · ar`**, resolved on the primary subtag, so `pt-BR` lands on
  `pt`. It comes from the customer's own `preferences.language` once they have an account,
  and from `identity.language` before that. Unknown → English.
- **Never names an internal concept.** No code, no field name, no "customer profile", no
  "identity", no "token".
- **Absent off `/api/internal/bot/*`.** The four dashboards ship their own localised copy and
  branch on `code`; a second, server-chosen sentence would be a second source of truth for
  wording they already own.

Copy lives in `domain/bot-error-copy.ts`. A half-translated entry **refuses the boot** —
the same completeness assert the four notification stacks run.

### 11.7 · New error codes

`BOT_REGISTRATION_IDENTITY_TAKEN` (409) · `BOT_ONBOARDING_NOT_REGISTERED` (409) ·
`BOT_ONBOARDING_STEP_NOT_SKIPPABLE` (422) · `BOT_ONBOARDING_VALUE_REQUIRED` (400).

Reused: `MAGIC_CONTACT_UNVERIFIED` (400), `AUTH_ACCOUNT_SUSPENDED` (403),
`BOT_GEO_CANDIDATE_EXPIRED` (400).

⚠ **A suspended account is REFUSED, never routed around.** Without that branch the "no
account" fallthrough would create a *second* account the moment the first was suspended — an
administrator's decision undone by the suspended person sending one message.

### 11.8 · Still not built

**GAP-006** (per-identity rate limiting — the automation layer is a single IP for every
customer and Layer A is IP-scoped at 1200/min) and **GAP-007** (a per-tool audit trail).
Registration's own abuse bounds from GAP-002 — 3/hour per identity, 10/hour per address —
are **not implemented**; the two credentials and the boot-required webhook secret are what
stands in front of this surface today.

---

## 12 · Support routing (GAP-004)

`POST /support/context` — **who the customer should be talking to.** One call, walked
server-side, replacing the three (`GET /api/public/stores/:slug`, `GET /api/customer/orders`,
`GET /api/customer/orders/:orderId/shipments`) the flow used to compose with the ladder
implemented in n8n. Every input already existed; the *routing policy* did not exist anywhere,
which is the whole reason this gap was on the list.

Code: `services/support-context.service.ts` + `controllers/bot-support.controller.ts`.

### 12.1 · The ladder

First rung that answers, wins:

| # | Rung | `resolvedFrom` | Yields |
|---|---|---|---|
| 1 | `hintOrderId` | `hint_order` | seller **and** delivery company |
| 2 | `hintProductId` | `hint_product` | seller |
| 3 | the most recent order | `recent_order` | seller **and** delivery company |
| 4 | the most recently viewed product | `recently_viewed` | seller |
| 5 | `profile.recentProductCode` | `recent_product_code` | seller |
| 6 | nothing | `none` | the platform alone |

⚠ **The rungs are not filtered by `scope`.** The subject is resolved first and the scope
narrows the answer afterwards, so `scope: "agency"` on a product-only context is a legitimate
`409` rather than a reason to keep climbing for *some* order. Skipping rungs would answer
about a different purchase than the one the customer is looking at.

⚠ **An order hint wins over a product hint** when both are sent, and **a hint that does not
resolve is refused, never fallen through** — `404 ORDER_NOT_FOUND` or
`404 CATALOG_PRODUCT_NOT_FOUND`, the same codes the order and catalogue tools raise. Falling
through would produce a confident sentence about the wrong thing.

⚠ **Rung 5 is read defensively.** `recentProductCode` is client-writable through
`PATCH /api/customer/profile` and has no guaranteed vocabulary; anything that is not an id
resolving to a publishable product silently drops to rung 6 rather than erroring.

### 12.2 · Request

```jsonc
POST /api/internal/bot/support/context
{
  "identity": { "channel": "whatsapp", "externalId": "237600123456" },
  "scope": "auto",                    // auto | vendor | agency | platform — default "auto"
  "hintOrderId": "ORD-2026-000123",   // optional — an id OR the order number
  "hintProductId": "68a1…"            // optional — a product id (24 hex)
}
```

No `Idempotency-Key`: this is a read (`mutating: false`), so it also survives a `readonly`
maintenance window — deliberately, since it is the first step of the flow a customer reaches
*because* something is wrong.

### 12.3 · Response

**Captured from a dev server**, not composed — one customer, one order, one parcel:

```jsonc
{
  "success": true,
  "data": {
    "resolvedFrom": "recent_order",
    "subject": {
      "type": "order",                              // order | product | none
      "id": "60700000000000000000e004",
      "label": "ORD-CAPTURE-000001 — Maison Bella"
    },
    "vendor": {
      "storeSlug": "capture-doc-store",
      "name": "Maison Bella",
      "supportWhatsapp": "+237600000001",
      "supportPhone": null,
      "supportEmail": "hello@maisonbella.cm"
    },
    "agency": {
      "id": "60700000000000000000e003",
      "name": "Douala Express",
      "supportWhatsapp": null,
      "supportPhone": "+237600000002",
      "supportEmail": null
    },
    "platform": { "canOpenTicket": true }
  }
}
```

The same call with `"scope": "platform"` returns that body with `vendor` and `agency` both
`null` and **everything else unchanged** — the subject survives every scope, because the
reply still has to say what it is about.

**`resolvedFrom` and `subject.label` are contract, not diagnostics.** The reply must name what
it routed from — *"about your order ORD-2026-000123 from Maison Bella"*. A support contact for
the wrong purchase is worse than asking which one.

**Any contact field may be `null`, on either party.** All three are optional on a store and on
an agency's magazin, and plenty of both have published none. Offer what exists and fall through
to a ticket.

**`platform` is present in every scope** and `canOpenTicket` is constantly `true` — the caller
is a resolved customer and `tickets_create` is mounted for them. It is in the contract because
the platform is the one party whose availability does not depend on context: it is the
fall-through when a seller published nothing and nothing has shipped.

**`vendor.storeSlug`, never a vendor id.** The storefront addresses a seller by slug precisely
so an internal id never becomes a public identifier, and a chat window is as public as it gets.

### 12.4 · The delivery company comes from the SHIPMENTS

Not from `items[].delivery.agency_id`, which is set at checkout. `GET /api/customer/orders/:orderId/shipments`
is the only place this platform discloses which agency carries a parcel, and it has nothing to
disclose until a shipment row exists — so reading the item instead would make this the first
door to name a delivery company the customer has never been told about, and one that
reassignment can still change. It is also what makes the catalogue's own sentence true: the
agency *"only exists once an order has shipped"*.

A multi-parcel order can span two agencies; this returns the one on the **most recent**
shipment. The rest stay reachable through `orders_list_shipments`, which lists every parcel
with its own agency block.

### 12.5 · The two refusals are different questions

| Code | Status | When |
|---|---|---|
| `BOT_SUPPORT_NO_CONTEXT` | 404 | Nothing to route from at all — no hint, no orders, nothing viewed |
| `BOT_SUPPORT_SCOPE_UNAVAILABLE` | 409 | There **is** a subject and the named party does not exist for it |

⚠ **Neither is reachable with `scope: "auto"` or `"platform"`.** GAP-004's ladder ends
*"nothing → platform only"*, and that is the better answer as well as the specified one: a
customer who says "I need help" having never ordered should be offered a ticket, not told
nothing was found. Both refusals require a **named party scope**, which is the request that
genuinely cannot be answered.

Both carry `error.customerMessage` like every other failure on this surface (§11.6).

---

## 13 · Proactive messaging, and the card page (GAP-012 + GAP-008)

**Built 2026-08-26.** Three tools: `messaging_get_window`, `messaging_notify_customer`,
`payment_create_pay_link`.

### 13.1 · The asymmetry this exists for

⚠ **WhatsApp permits a free-form message only inside a 24-hour service window opened by the
customer's own message.** Outside it, only pre-approved templates send. **Telegram has no
equivalent**, so this is not symmetrical and must not be designed as if it were.

| Situation | Inside the window? |
|---|---|
| Payment settles minutes after the prompt | ✅ the common case |
| Customer approves a mobile-money prompt an hour later | ✅ |
| Order ships two days later | ❌ template |
| A parcel goes out for delivery | ❌ template |
| A support request is answered next week | ❌ template |

**The platform handles all three of those.** The customer notification stack has branched
free-form-vs-template correctly since it shipped, and GAP-012 added the templates the last
row needed. What n8n needs is the two things the platform cannot do for it: *see* the
window, and hand off a message it cannot send.

> #### ⚠ What actually made this a gap, and it was not the templates
>
> All three secondary-channel flags on `customer_notification_preferences` default to
> **`false`**, and GAP-002's registration seeded none of them. So a bot-registered customer
> received in-app records and a push to a device token they do not have — and **nothing on
> the channel they were talking to us on**. Every proactive template was written, approved,
> addressed and never sent, for exactly the population GAP-002 exists to create.
>
> Registration now seeds the channel the sender arrived on (product owner, 2026-08-26:
> arriving on a channel *is* the choice). It applies to **new** profiles only — an account
> that already existed has a preference somebody chose. A customer changes it in one message
> with `notifications_update_preferences`, `channel: "none"` included.

### 13.2 · `POST /messaging/window`

No arguments. Consult it before starting a flow that may finish after the customer stops
writing.

```jsonc
// 200 — WhatsApp, window open
{ "success": true, "data": {
    "channel": "whatsapp",
    "applicable": true,          // this channel HAS a window
    "open": true,
    "expiresAt": "2026-08-27T19:57:00.000Z",
    "mustUseTemplate": false } }

// 200 — Telegram
{ "success": true, "data": {
    "channel": "telegram", "applicable": false,
    "open": true, "expiresAt": null, "mustUseTemplate": false } }
```

⚠ **`applicable` and `open` are two fields because they are two facts.** "The window is
open" and "there is no window" are different, and a flow that collapses them ends up built
around a Telegram deadline that does not exist.

⚠ **`expiresAt` is the PLATFORM's window, not Meta's, and it is deliberately earlier** — 23
hours against Meta's 24, so free-form sends stop a safe margin before the real boundary
rather than racing it. Read it as *"after this we switch to a template"*.

### 13.3 · `POST /messaging/notify`

```jsonc
{ "situation": "order.payment_link", "transactionId": "68af…" }
```

⚠ **It takes a SITUATION from a closed set, never a message.** Three consequences, and each
is the reason:

- **The copy stays in the platform's catalog**, in five languages, beside everything else it
  says to a customer. n8n has no copy table and no translator.
- **A template exists for it** — a free-text route could send nothing at all outside the
  window, which is the only situation it would ever be reached in.
- **It cannot become a marketing channel.** [ARCHITECTURE.md § 12](./ARCHITECTURE.md) lists
  proactive marketing as deliberately not built. A route relaying arbitrary text would make
  that unenforceable by anything except good intentions.

**One member today, and that is honest rather than thin.** Every other proactive message is
the consequence of something the *platform* did, so the platform raises it from its own
event. `order.payment_link` is the one thing the conversation knows and the platform cannot:
that somebody chose to pay by card in a chat and then stopped writing.

⚠ **A `200` means ACCEPTED FOR DELIVERY, not delivered.** The notification stack never
throws — a notification failure must not fail the business action that caused it — so do not
tell the customer a message was sent. The refusals below are the things decidable
synchronously, and they are all about whether there is anything legitimate to send.

⚠ **It mints a FRESH pay link**, deliberately: sending the existing one could deliver a
handle minted twenty-nine minutes ago, so the message arrives with a link that dies in sixty
seconds. That also means it **revokes** any earlier link for the same transaction.

> ### ⚠⚠ Nothing bounds how often this may be called, and GAP-006 is where that belongs
>
> This is the first route on the surface whose side effect **reaches a person and costs
> money** — outside the service window the message is a paid template conversation. Every
> other route reads or writes the customer's own records.
>
> `Idempotency-Key` makes a **retry** free: the stored response is replayed and nothing is
> sent twice. It does **not** bound a **loop** — a workflow minting a new key each pass sends
> a new message each pass, because each mint produces a new token and therefore a new
> notification key. Bound it on your side until [GAP-006](./BACKEND-GAPS.md#gap-006) lands.

### 13.4 · `POST /payments/:transactionId/pay-link`

The same link, when the window is open and n8n is sending the message itself.

```jsonc
// 200
{ "success": true, "data": {
    "token": "pl_9f3c…",
    "url": "https://shop.example.com/pay/pl_9f3c…",
    "expiresAt": "2026-08-26T21:42:00.000Z" } }
```

Send `url`. **Never relay `token`** — the URL already contains it, and a bare handle in a
chat is a credential with no context.

| Code | Status | When |
|---|---|---|
| `PAYMENT_TRANSACTION_NOT_FOUND` | 404 | Unknown, malformed, or not this customer's — indistinguishable on purpose |
| `PAYMENT_LINK_NOT_APPLICABLE` | 422 | A mobile-money payment, or a deployment with no payment page |
| `PAYMENT_LINK_NOT_PAYABLE` | 422 | Already settled, failed or cancelled |

⚠ **`url: null` is a real deployment state, not an error.** It means `STOREFRONT_URL` is
unset, so this deployment has no payment page. Offer mobile money — do not send a message
with a missing link in it.

⚠ **Mobile money never needs any of this.** It completes on the customer's handset, in the
chat, and asking for a link on one is a 422 rather than a fallback. The full page contract
is [payments/README.md § The hosted card page](../payments/README.md#the-hosted-card-page-gap-008).

### 13.5 · What the platform now tells a customer about a support request

Three situations the platform raises on its own, with templates, in five languages. They are
listed here because n8n does **not** trigger them and should not try:

| Situation | Raised when |
|---|---|
| `ticket.replied` | A **public** note by somebody other than the customer |
| `ticket.awaiting_customer` | The request reached `waiting_on_customer` |
| `ticket.resolved` | The request reached `resolved` or `closed` |

Before this, `ticket.*` events were published and **nothing subscribed** — a customer who
asked a question was never told it had been answered, on any channel. Five of the eight
statuses stay silent (`in_progress` and the four other `waiting_on_*`): they mean "somebody
else has it", and forwarding them trains people to ignore the channel that carries the
answer.

None of the three can be muted by a preference. They are the answer to a question the
customer asked, and `awaiting_customer` is the platform saying it is blocked on them.

---

## 14 · ⭐ `reply` — the request body you POST to the channel, unmodified

**Status:** built 2026-08-26, at the product owner's request. Every capture below is from a
live `npm run dev` boot.

### 14.1 · The rule

**This service composes the outbound message. You POST it and change nothing.**

`§ 11.6` told you to relay a *sentence*. That was half a step: a sentence is not a Telegram
request, and turning one into a request means knowing that the phone step needs a
`request_contact` keyboard, that the turn after it must send `remove_keyboard`, that the
button's own label is a fifth string in five languages, and that WhatsApp truncates a
reply-button title at twenty characters. None of that is knowledge an automation layer has,
and all of it is knowledge this service has.

So every bot response now carries a **top-level `reply`**:

```jsonc
"reply": {
  "channel": "telegram",        // which platform this body is for
  "method":  "sendMessage",     // the path segment to append to your base URL
  "body":    { … }              // the request body. Send it VERBATIM
}
```

**One expression covers every response on this surface** — success, failure, prompt, picker,
payment button:

```
POST  {{ $json.reply.channel === 'telegram' ? TELEGRAM_BASE : WHATSAPP_BASE }}/{{ $json.reply.method }}
body  {{ $json.reply.body }}
```

where

| channel | your base URL |
|---|---|
| `telegram` | `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>` |
| `whatsapp` | `https://graph.facebook.com/v18.0/<WHATSAPP_PHONE_NUMBER_ID>` |

⚠ **`method` is a PATH SEGMENT, not an HTTP verb.** It is always a POST with a JSON body. It
is a segment rather than a whole URL because the base URL is where your bot token, your
phone-number id and your API version live, and **a credential must not travel through a
webhook response**. It also means a future turn needing `sendPhoto` or `answerCallbackQuery`
is a new value in this field rather than a new branch in your workflow.

### 14.2 · Four properties

- **Top-level, always in the same place.** A sibling of `data` and of `error`, never nested
  inside either. That is what makes the one expression above work on a 200, a 409 and a 500
  alike.
- **Absent means there is nothing for the platform to say.** Branch on presence, the same
  convention `requestContact` already uses. The common case is a finished onboarding
  checklist: the platform has no question left and the turn belongs to your model, which is
  answering whatever the customer actually came to ask. **A response with no `reply` is not
  an error and is not a response to swallow.**
- **`prompt` and `customerMessage` are KEPT.** Nothing was replaced, so § 11.6 still holds and
  nothing already wired breaks. Read them when your model needs to know what was just said;
  read `reply` when you are sending it.
- **The recipient is not a parameter.** It comes from the `identity.externalId` on the request
  — Telegram's `chat_id`, WhatsApp's bare-digit number — so a reply is addressed to the
  conversation it answers and cannot be aimed anywhere else.

### 14.3 · Which turns carry one

| Turn | Renders as |
|---|---|
| an onboarding prompt (`data.onboarding.next`) | text, plus the contact keyboard on the Telegram phone step |
| a **skippable** onboarding prompt (`next.skippable`) | text **plus a Skip button** carrying `skip:<step>` — see § 14.6 |
| **any failure** | text, built from `error.customerMessage` |
| `BOT_IDENTITY_NEEDS_CONTACT` · `MAGIC_CONTACT_UNVERIFIED` | text **plus the contact keyboard** — their copy says "tap the button", so a button is rendered |
| `/geo/search` · `/geo/reverse` | a picker: a Telegram inline keyboard, a WhatsApp interactive list |
| `/payments/:id/pay-link` | a URL button: Telegram inline `url`, WhatsApp `cta_url` |

Everything else — a cart, an order list, a product, a support context — is **data for your
model to narrate**, and deliberately carries no `reply`. This service words the turns whose
wording is fixed; it does not answer *"do you have red shoes?"*.

### 14.4 · Real captures

**Telegram, first contact** (`POST /identity/sync`, `identity.language: "en"`) — abridged to
the new field; `data` is exactly as § 11.4 shows it:

```jsonc
{
  "success": true,
  "data": { "registered": false, "state": "anonymous",
            "onboarding": { "next": { "step": "phone", "prompt": "First, I need your phone number…",
                                      "requestContact": true }, … } },
  "reply": {
    "channel": "telegram",
    "method": "sendMessage",
    "body": {
      "chat_id": "1804835114",
      "text": "First, I need your phone number so I can set up your account. Tap the button below to share it.",
      "reply_markup": {
        "keyboard": [[{ "text": "📱 Share my number", "request_contact": true }]],
        "one_time_keyboard": true,
        "resize_keyboard": true
      }
    }
  }
}
```

**A refusal, in French** (`POST /cart/get` from an unbound chat) — note that the keyboard is
rendered because this code's copy tells the customer to tap one:

```jsonc
{
  "success": false,
  "requestId": "66c63c8c-4d29-4207-a03f-28a6c7a907fd",
  "error": {
    "code": "BOT_IDENTITY_NEEDS_CONTACT",
    "message": "This chat is anonymous — a verified contact must be shared…",
    "customerMessage": "J'ai d'abord besoin de votre numéro de téléphone. Appuyez sur le bouton ci-dessous pour le partager.",
    "statusCode": 409, "category": "conflict",
    "details": { "state": "anonymous", "reason": "needs_contact" }
  },
  "reply": {
    "channel": "telegram",
    "method": "sendMessage",
    "body": {
      "chat_id": "1804835116",
      "text": "J'ai d'abord besoin de votre numéro de téléphone. Appuyez sur le bouton ci-dessous pour le partager.",
      "reply_markup": {
        "keyboard": [[{ "text": "📱 Partager mon numéro", "request_contact": true }]],
        "one_time_keyboard": true,
        "resize_keyboard": true
      }
    }
  }
}
```

### 14.5 · Things that used to be your job and are not any more

- **The contact button's label.** The walkthrough told you to key it off `identity.language`
  from a four-entry table in the workflow. Delete that table.
- **Removing the keyboard afterwards.** Every Telegram reply that carries no keyboard of its
  own now carries `reply_markup: { remove_keyboard: true }`. It is a no-op against a chat with
  no keyboard, so it needs no branch and no memory of the previous turn.
- **Keeping candidate refs in the execution's state.** A picker's `callback_data` **is** the
  `candidateRef` — measured at 46 bytes against Telegram's 64-byte cap. Post
  `callback_query.data` straight back as `geoCandidateRef`; there is nothing to remember
  between the two turns.
- **Choosing a WhatsApp control.** Buttons versus a list, the 20/24/72-character caps, the
  ten-row ceiling and the 4096-character message limit are all applied before you see the
  body.
- **Understanding the word "skip" in five languages.** It is a button now, and the token it
  carries is the same string whatever the customer reads — § 14.6.

### 14.6 · ⭐ A determined answer is a BUTTON, never a typed word

**Rule, and it applies to every turn built from here on: if the set of valid answers is known
in advance — skip, yes, no, which of these, which payment method — render buttons and let the
customer press one. Free text is only for what nobody but the customer can supply: a name, an
email, an address.**

The reason is not ergonomics, it is parsing. A typed answer is *language-dependent* and
whatever reads it is not:

> The email prompt used to end *"It is optional — just say \"skip\" if you would rather not."*
> A French customer typed *« passer »*, a Portuguese one `saltar`, an Arabic one `تخطٍّ` — so
> something on the path back had to know that five spellings are one intent. That table would
> have lived in the automation layer, which is the one layer with **no copy table**. It also
> forced the prompt to teach an interface instead of asking a question, and made `Skip`,
> `skip.`, `Passer !` and `pass` four strings for one meaning.

A button removes all of it: **the label is translated for the human, the id is not translated
at all.** You receive the exact token this service chose, whatever language the customer reads.

The prompt for a skippable step is now simply the question — *"Would you like to add an email
address?"* — and the option lives in the control beside it.

#### The token vocabulary

An action id is `<verb>:<argument>`, self-describing because a tap arrives with no memory of
the turn that produced it. **Each verb has exactly one mapping, and it is this table:**

| token | you POST | with body |
|---|---|---|
| `skip:<step>` | `/identity/onboarding` | `{ "step": "<step>", "action": "skip" }` |

⚠ **A picker row from `/geo/search` carries no verb** — its id is the bare `candidateRef`
(recognisable: it begins `gc_`). That is deliberate, and it is the same rule taken one step
further: the ref **is** the value you post back, so you forward what you received and
transform nothing. A verb would buy self-description you do not need (you know why you started
an address flow) at the cost of a strip step.

New verbs will be added here, in the same change that ships them. A token you do not
recognise means this table is out of date — log it and fall back to treating the turn as free
text; do not guess.

#### Captures

**Telegram, the email step** (`en`) — the whole `reply`, live:

```jsonc
{
  "channel": "telegram",
  "method": "sendMessage",
  "body": {
    "chat_id": "900000881",
    "text": "Would you like to add an email address?",
    "reply_markup": {
      "inline_keyboard": [[{ "text": "Skip", "callback_data": "skip:email" }]]
    }
  }
}
```

**WhatsApp, the same step** on a French account — same token, translated label:

```jsonc
{
  "channel": "whatsapp",
  "method": "messages",
  "body": {
    "messaging_product": "whatsapp", "recipient_type": "individual",
    "to": "237600000771", "type": "interactive",
    "interactive": {
      "type": "button",
      "body": { "text": "Souhaitez-vous ajouter une adresse e-mail ?" },
      "action": { "buttons": [{ "type": "reply", "reply": { "id": "skip:email", "title": "Passer" } }] }
    }
  }
}
```

**After the tap**, you `POST /identity/onboarding { identity, step: "email", action: "skip" }`
and the next turn comes back the same shape, one step further on:

```jsonc
"reply": { "channel": "telegram", "method": "sendMessage", "body": {
  "chat_id": "900000881",
  "text": "Last one: where should I deliver to?",
  "reply_markup": { "inline_keyboard": [[{ "text": "Skip", "callback_data": "skip:address" }]] }
}}
```

⚠ **An action button never replaces typing.** The customer can still send their email address
as ordinary text on that turn — the button is the *other* answer, not the only one. On
WhatsApp actions are always reply **buttons**, never a list, because a list hides its rows
behind a "Choose" tap and would make the option invisible at the moment the customer is
deciding.

### 14.7 · One thing that is still your job

**Reading the tap.** `reply` is outbound only. When the customer presses something you still
receive `callback_query.data` (Telegram) or `interactive.button_reply.id` /
`interactive.list_reply.id` (WhatsApp), and map it through the table above. The ids are chosen
so that the value you receive is either the value you send verbatim (a `gc_` ref) or a token
with exactly one documented mapping — never a phrase to interpret.

---

## Related

- [BACKEND-GAPS.md](./BACKEND-GAPS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) ·
  [COMMAND-SPECIFICATION.md](./COMMAND-SPECIFICATION.md)
- [tools/catalog.json](./tools/catalog.json) — the generated contract, pinned to the route table
