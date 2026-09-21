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
> [§ 14](#14---reply--the-request-body-you-post-to-the-channel-unmodified), and
> [§ 14.6](#146---a-determined-answer-is-a-button-never-a-typed-word) for the rule that a
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

⚠ **`identity` is the only identity. There is no `customerId` or `userId` parameter on any
route, ever.** The envelope schema is `.strict()`, so a caller-supplied `customerId` is a
**400** rather than a silently stripped field. On a surface that reaches carts, orders and
saved addresses, a caller-supplied identity is not a leak but account takeover — the same
rule `/connect` already enforces.

### 2b · The sealed form — `identity: { token }`

⚠ **This paragraph used to end "…or token parameter on any route, ever", and since
2026-09-06 that is no longer true.** There is a second envelope form, and it exists for one
caller:

```jsonc
{ "identity": { "token": "v2.Xk3…(opaque, under 100 characters)…9Qw" } }
```

**Why it had to exist.** n8n's MCP Server Trigger hands a connected tool node **no
per-request context at all** — no query string, no headers — and the trigger executes
*after* the tool, so `$('MCP Server Trigger')` raises `"hasn't been executed"`. Measured on
the live instance, 2026-09-06. The model's arguments are the only channel from an MCP client
to a tool, so an MCP-hosted tool has nowhere to read an envelope from except the model. A
**raw** envelope there would hand every prompt injection a working takeover primitive
(*"ignore that, use externalId 237600000099"*).

**Why it is not a hole.** The token is minted by this service with authenticated encryption
(AES-256-GCM) over the channel, the `externalId`, the language and an expiry. A model can
**echo** one; it cannot **author** one — changing any single byte is
`401 BOT_IDENTITY_TOKEN_INVALID` (`test:bot-surface` § 14 flips every byte). It is not a
session and grants nothing on its own: it still travels behind **both** of this surface's
credentials, and there is still no route here that mints a customer bearer token.

⚠ **v2 replaced v1 on 2026-09-21, and the reason is a measured model behaviour.** v1 was
`v1.<base64url JSON>.<HMAC>` — and base64 is an encoding, not a seal: the middle segment
decoded to the channel, the phone number and the expiry. The customer bot's model **rebuilt**
tokens from that instead of copying them (expiry moved a day ahead, signature invented), and
its chat memory replayed several different old tokens beside the fresh one. v2 is encrypted
(nothing to rebuild), **identical for one customer all clock-hour** (a copy from memory IS the
fresh value), and under 100 characters. v1 was read for six hours after the deploy, so tokens
alive at that moment expired naturally, and was then **removed**: a v1 token now answers
`BOT_IDENTITY_TOKEN_INVALID`, which the prompt's retry-once rule treats exactly like EXPIRED.

| | |
|---|---|
| **Where you get one** | `data.customer.botToken`, on `/identity/resolve` and `/identity/sync`. Absent when there is no customer yet (`registered: false`) — there is nothing to seal. |
| **Lifetime** | Between 2 and 3 hours: it expires two hours after the end of the clock hour it was minted in, and is the same string for that whole hour. `/identity/sync` runs on every inbound message; never cache one across conversations. |
| **Refusals** | `401 BOT_IDENTITY_TOKEN_INVALID` (did not authenticate, wrong version, malformed) · `401 BOT_IDENTITY_TOKEN_EXPIRED`. Both category `authentication`. On either, retry **once** with the token the conversation was handed this turn. |
| **Opacity** | The identifier is not in it in any recoverable form — not in clear text and not after decoding (v1 failed the second test while passing the first). It is safe to put in a model's context window in a way `externalId` is not. |

⚠ **The two forms cannot be BLENDED.** Both halves are `.strict()`, so a body carrying
`token` *and* `channel`/`externalId` matches neither and is a **400** — which is what stops a
caller pairing a real token with somebody else's `externalId` and hoping the raw fields are
read first. `test:bot-surface` § 8 pins it.

⚠ **Nothing downstream can tell the two forms apart.** `requireBotIdentity` unseals the
token and every route, guard and idempotency scope past that point sees one shape. The MCP
door and the n8n door must not be two code paths with two chances to disagree about who is
calling.

**Callers that are not an MCP server should keep sending the raw envelope.** wi-mall-core's
own onboarding steps do, and must: they run for senders who have no account yet, and an
anonymous sender has no token.

⚠ **These two refusals carry no `error.customerMessage`**, unlike every other failure here.
That is deliberate: a bad token is a fault in the automation layer, not something a shopper
did, and there is no sentence a customer could act on.

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

All seventy-nine. `POST`, `PATCH` and `DELETE` only — **no `GET`**, because the identity
envelope is a body and a messaging identifier in a query string is a real person's phone
number written into every access log on the path.

⚠ **NINE routes are `DELETE` WITH A BODY** — `/cart`, `/cart/items/:variantId`,
`/wishlist/:productId`, `/addresses/:addressId`, `/recently-viewed`,
`/payment-methods/:methodId`, `/contact/email/pending`, `/contact/phone/pending` and
`/connections/:channel`.
Express parses one without complaint, but some HTTP clients and intermediaries drop it. A
caller finding `identity` missing on exactly those nine has hit that, not a backend bug.

⚠ That count said **three**, then **six**, and both were prose nothing asserts. Count the
`DELETE` rows in the table below rather than trusting this sentence — it has now been wrong
twice, each time because a step added one and nobody re-counted.

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
| `profile_update` | PATCH | `/profile` | ✔ |
| `profile_set_language` | PATCH | `/profile/language` | ✔ |
| `addresses_list` | POST | `/addresses/list` | |
| `addresses_add` | POST | `/addresses` | ✔ |
| `addresses_set_default` | PATCH | `/addresses/:addressId/default` | ✔ |
| `addresses_update` | PATCH | `/addresses/:addressId` | ✔ |
| `addresses_remove` | DELETE | `/addresses/:addressId` | ✔ |
| `geo_search_address` | POST | `/geo/search` | |
| `geo_reverse_address` | POST | `/geo/reverse` | |
| `tickets_list` | POST | `/tickets/list` | |
| `tickets_create` | POST | `/tickets` | ✔ |
| `tickets_get` | POST | `/tickets/:ticketId` | |
| `tickets_add_note` | POST | `/tickets/:ticketId/notes` | ✔ |
| `tickets_close` | POST | `/tickets/:ticketId/close` | ✔ |
| `tickets_add_attachment` | POST | `/tickets/:ticketId/attachments` | ✔ |
| `files_receive_inbound` | POST | `/files/inbound` | ✔ |
| `support_resolve_contacts` | POST | `/support/context` | |
| `wishlist_list` | POST | `/wishlist/list` | |
| `wishlist_add` | POST | `/wishlist` | ✔ |
| `wishlist_remove` | DELETE | `/wishlist/:productId` | ✔ |
| `recently_viewed_record` | POST | `/recently-viewed` | ✔ |
| `recently_viewed_list` | POST | `/recently-viewed/list` | |
| `recently_viewed_clear` | DELETE | `/recently-viewed` | ✔ |
| `digital_list_entitlements` | POST | `/digital/my-products` | |
| `digital_create_download_link` | POST | `/digital/download-links` | ✔ |
| `bookings_list` | POST | `/bookings/list` | |
| `bookings_get_availability` | POST | `/bookings/availability` | |
| `bookings_create` | POST | `/bookings` | ✔ |
| `bookings_get` | POST | `/bookings/:bookingId` | |
| `bookings_get_balance` | POST | `/bookings/:bookingId/balance` | |
| `bookings_payment_status` | POST | `/bookings/:bookingId/payment-status` | |
| `bookings_pay` | POST | `/bookings/:bookingId/pay` | ✔ |
| `bookings_pay_balance` | POST | `/bookings/:bookingId/pay-balance` | ✔ |
| `bookings_cancel` | POST | `/bookings/:bookingId/cancel` | ✔ |
| `bookings_reschedule` | PATCH | `/bookings/:bookingId/reschedule` | ✔ |
| `payment_methods_list` | POST | `/payment-methods/list` | |
| `payment_methods_add` | POST | `/payment-methods` | ✔ |
| `payment_methods_set_default` | PATCH | `/payment-methods/:methodId/default` | ✔ |
| `payment_methods_remove` | DELETE | `/payment-methods/:methodId` | ✔ |
| `reviews_check_eligibility` | POST | `/reviews/eligibility` | |
| `reviews_list_mine` | POST | `/reviews/list` | |
| `reviews_create` | POST | `/reviews` | ✔ |
| `notifications_get_preferences` | POST | `/notifications/preferences` | |
| `notifications_update_preferences` | PATCH | `/notifications/preferences` | ✔ |
| `notifications_list` | POST | `/notifications/list` | |
| `notifications_unread_count` | POST | `/notifications/unread-count` | |
| `notifications_mark_all_read` | PATCH | `/notifications/read-all` | ✔ |
| `notifications_mark_read` | PATCH | `/notifications/:notificationId/read` | ✔ |
| `messaging_get_window` | POST | `/messaging/window` | |
| `messaging_notify_customer` | POST | `/messaging/notify` | ✔ |
| `contact_get_state` | POST | `/contact` | |
| `contact_change_email` | PATCH | `/contact/email` | ✔ |
| `contact_cancel_email_change` | DELETE | `/contact/email/pending` | ✔ |
| `contact_change_phone` | PATCH | `/contact/phone` | ✔ |
| `contact_confirm_phone` | POST | `/contact/phone/confirm` | ✔ |
| `contact_cancel_phone_change` | DELETE | `/contact/phone/pending` | ✔ |
| `connections_list` | POST | `/connections/list` | |
| `connections_disconnect` | DELETE | `/connections/:channel` | ✔ |
| `account_close_preview` | POST | `/account/close/preview` | |
| `account_close` | POST | `/account/close` | ✔ |

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

Ten places, and each exists because a chat window makes something specific true. ⚠ This
sentence has said 'four' while the table held five, and 'eight' while it held ten — count the
rows rather than trusting it.

| Route | Difference | Why |
|---|---|---|
| `POST /profile` | `email` and `phone` **masked**; `savedAddresses` → `savedAddressCount`; avatar, bio, date of birth and payment methods dropped | A chat window is shared, screenshotted and shoulder-surfed, and passes through a model's context. The customer already knows their own number |
| `POST /addresses/list` | adds `deliverable`; omits `coordinates` | See §5 |
| `POST /geo/*` | a `candidateRef` instead of a pin | See §5 |
| `POST /orders/groups/:cartId` **and** `POST /orders/:orderId` | `codCollections[].deliveryCode` **stripped** | It is a payment credential. Disclosure happens only through `/orders/:orderId/cod-code` |
| `POST /notifications/list` | `idempotencyKey`, `deliveryErrors[]`, `customerId` and `deliveredVia` **dropped**; `action` flattened to `actionLabel` + an absolute `actionUrl` | `deliveryErrors[]` carries raw provider strings (SMTP responses, Meta rejection codes) — operator diagnostics, and the surface's own rule is that an `internal`/`external_service` message never reaches a customer |
| **Every booking read and write** | the whole Mongoose document → an explicit projection; `metadata`, `externalCalendarEventId`, `userId` and both transaction ids **dropped**; adds **`awaitingVendorApproval`**, `outstandingBalance` and `bookingNumber` (`BKG-2026-000123`, or `null` on a booking predating the field) | `metadata` is `Mixed` and writable by a web caller, and `externalCalendarEventId` is a handle into the VENDOR's Google Calendar. `awaitingVendorApproval` exists because a booking has two unrelated `pending`s — see 6d |
| `POST /reviews/list` | `moderation` and `authorUserId` **dropped**; adds **`publiclyVisible`** and `subjectLabel` | A rejection reason is a moderator's private note for the next moderator and is never shown to the author. `publiclyVisible` exists because `status` is misleading in a chat — see below |
| `POST /payment-methods/list` | snake_case → camelCase; `holder_name` **dropped**; adds **`expired`** and a formatted `expires` | An expired card stays in the list and still looks usable. The customer API reports the month and year as two numbers, and a model comparing them against today is a model doing date arithmetic |
| `POST /contact` | current `email`/`phone` **masked**; a PENDING target **verbatim**; `requestedAt` dropped; adds **`phoneChangeProved`** | The asymmetry is the point — the customer already knows their own number, and masking the pending target would defeat the read, which exists to say which address to check. `phoneChangeProved` reports whether the change can be finished at all, instead of letting the customer find out from a 422. See § 15.1 |
| `POST /connections/list` | `howToConnect` **dropped**; adds **`isCurrentChannel`**; no `meta` window | A `wa.me` deep link relayed into a WhatsApp chat invites the customer to tap through to the conversation they are already in. `isCurrentChannel` marks the binding `connections_disconnect` refuses to cut. See § 16.1 |

⚠ **The delivery-code strip applies to BOTH order reads, and GAP-001 named only the group.**
Both are built by the same projection, so leaving one open would make closing the other
pointless. Deliberate deviation from the plan, recorded here.

Two response-shape exceptions inherited from the surfaces underneath, both matching the
catalogue:

- `payment_get_transaction` answers `{ success, transaction }`, not `{ success, data }` — it
  mirrors `GET /api/payments/:transactionId` byte for byte.
- The three ticket tools answer `{ success, data, pagination }`, not `meta` — that is the
  ticket module's existing shape on every role's mount.

  ⚠ **Since 2026-09-06 those three also carry `meta`, added beside `pagination` rather
  than replacing it.** The deviation above still holds and `pagination` is untouched; the
  list window below simply lives under the same key on every list, so a client never has to
  know which tool puts it where.

### 6b · ⭐ Every list is capped at FIVE, and says where the rest are

**A chat answer carries at most 5 rows. This is enforced here, not by the prompt.**

`limit` has defaulted to 5 since GAP-001, but its **maximum was 100** — and a default is not
a cap. A model that decides it needs "all" of something asks for a hundred and gets them,
and on the MCP transport the only thing telling it otherwise is a sentence in the server's
`instructions`, which is a rule the model breaks under exactly the pressure that makes it
matter. `BOT_CHAT_LIST_MAX` is the ceiling now.

⚠ **Asking for more than 5 is a `400`, not a silent clamp.** A caller that believes it
requested fifty rows and was handed five would report the five as the whole answer — the
truncation failure this exists to prevent, reintroduced one layer down.

Every list answer carries a window in `meta`:

```jsonc
{
  "success": true,
  "data": [ /* at most 5 rows */ ],
  "meta": {
    "shown": 5,
    "total": 23,
    "hasMore": true,
    "moreUrl": "https://wi-mall.example/fr/shop/account/orders"
  }
}
```

| Field | |
|---|---|
| `shown` | rows in `data`. Never above 5 |
| `total` | rows matching the query, across every page |
| `hasMore` | is anything left **after this window** |
| `moreUrl` | where to see the rest. **Null when `hasMore` is false**, and null when the deployment has no `STOREFRONT_URL` |

**Relay `moreUrl` when it is present; never invent one.** It is a deep link into the
storefront, and it is composed here for the same reason `reply` and `error.customerMessage`
are: the automation layer has no URL table and no translator.

⚠ **`hasMore` is derived from the real total and your offset, never from the page being
full.** Two plausible-looking versions are wrong: `shown === 5` claims more whenever a list
is exactly five long, and `total > shown` advertises more on the last page of twenty.

⚠ **`moreUrl` carries the customer's LOCALE, and this is the part that fails silently.**
The storefront routes with `localePrefix: "as-needed"` — English owns the bare paths and the
other four languages are prefixed (`/fr/shop/...`). A bare path does **not** 404 for a French
customer; middleware serves them the English tree. That is worse than a 404: the bot answers
in French and hands over an English page, and nothing anywhere reports a fault.

**Two lists are not paginated at all** — `addresses_list` and `digital_list_entitlements`
return their whole set from the services underneath, so for them the cap is the only limit
there is. `addresses_list` additionally **sorts the default address first**, because
capping a stored-order list at five could otherwise drop the one address a chat answer is
most likely to be about.

⚠ **`addresses_set_default` is deliberately NOT capped.** It returns the whole list because
setting a default clears the flag on every sibling, and a caller left holding five of seven
rows would believe a stale list. It is `flow_only` — no model narrates it — so the wall-of-
text argument does not apply.

⚠ **THREE list tools carry no `meta` window at all, each with its own reason.** An exemption
written down is a decision; an exemption merely absent from the table is drift, and
`test:bot-surface` § 13 derives the check from the route table so a new `*_list*` tool must be
one or the other.

| Tool | Why no window |
|---|---|
| `orders_list_shipments` | Truncating one order's parcels is a **wrong** answer, not a short one — "where is my order?" answered with three of seven parcels reads as *"you have three parcels"*. And there is no page to link to: the storefront's order route takes a **cartId**, this tool is addressed by **orderId** |
| `geo_search_address` | Capped by its own schema, because the rows are tappable controls and WhatsApp caps a list message's rows. There is no "see the rest of the candidates" page anywhere |
| `connections_list` | A **closed set of two** channels, always both returned — nothing to truncate and nowhere to send anybody |

⚠ **The three `public` catalogue tools are capped in the CATALOGUE, not on the endpoint.**
`/api/public/products` still accepts `limit=100`, because the storefront legitimately pages
twenty at a time. What is capped is the tool the model is handed.

✅ **`notifications_list.actionUrl` was BROKEN PLATFORM-WIDE and is now mostly fixed**
(2026-09-07). It is relayed faithfully here and always was; the defect was upstream, in the
addresses themselves, and the same URL goes into every notification email, WhatsApp button
and Telegram button — so this was never a bot-surface defect to paper over.

`customer-notification-catalog.ts` built its six suffixes as bare nouns — `orders/{{orderId}}`,
`support/{{ticketId}}`, `bookings/{{bookingId}}` — and **`frontend/landing` served none of
them**: there is no root-level `/orders`, `/support` or `/bookings` segment and no rewrite, so
all 22 buttons 404'd, in every language, on every channel, for as long as they had existed.
The pages were there the whole time, one level down under `/shop/account/…`.

**What changed.** All six now point at pages that exist, and every URL gained the
locale prefix it never carried (a French customer's button opened the English page — no 404,
no log line). The full table and the rules for adding another are
`api-doc/notifications/storefront-routes.md`.

✅ **Every address resolves as of 2026-09-07.** `payment_create_pay_link` returns
`{STOREFRONT_URL}/pay/{token}`, and `/pay/:token` — which was the one address on this
surface handing a live customer a dead link — is now a real page with a Stripe Payment
Element behind it. The single-order and tracking pages shipped in the same pass. The
addresses were pinned first and the pages built to them, which is why nothing on this
surface had to change.

One thing did change on the backend as a result, and it matters to this tool. The page
had nothing to display but a number — *"Amount due — 24 000 FCFA"* — and the payer is by
design **not** the buyer, so `GET /payments/session/:token` gained **`paidFor`**: the order
reference, how many orders the payment settles, an item count, and the shop names. It is
**structured fields, not a rendered sentence**, and the reason is one this surface argues
in the opposite direction everywhere else: `error.customerMessage`, `next.prompt` and the
whole `reply` body exist because the automation layer has no copy table, so the backend
composes. Here the backend is the one that cannot — the holder of a pay link has no
account and therefore no `preferred_language` — so the page composes instead. Shape and
privacy rules: `api-doc/payments/README.md`.

⚠ **The order button was not a rename, and that is why it took an owner decision.** The
storefront's order page is `/shop/account/orders/[cartId]` and takes a **cartId** — one
checkout group, which a multi-vendor basket splits into several orders — while the
notification carries the **orderId** of the one parcel it is about. The owner chose a new
single-order route (`/shop/account/orders/detail/:orderId`) over sending the group id, so
that a message about one parcel lands on that parcel.

⚠ **The other three stacks WERE examined (2026-09-07), and the customer fix does NOT
generalise — the situation there is a different one.** `vendor`, `agency` and `agent` build
the same shape against `VENDOR_APP_URL` / `AGENCY_APP_URL` / `AGENT_APP_URL`, but each of
those three apps had already made its own decision about whose job the address is, and two of
them decided it is not the backend's:

| App | What it does with `action.path` | In-app |
|---|---|---|
| **vendor-dash** | **Ignores it.** Routes from `aggregateType` + `aggregateId`; its own comment says the backend's URL scheme does not match its routes | ✅ works |
| **agency-dash** | **Uses it**, prefixing `/dashboard/`, with purpose-built alias routes (`plans`, `settings/storage`, `stock-requests/:id`) | 4 of 8 resolve |
| **agent_app** (Flutter) | **Translates it** through `resolveDeepLink`, with a documented table | ✅ all 5 |

So every in-app inbox works. What is broken is the **external** channels: the email / WhatsApp /
Telegram button is `APP_URL + '/' + suffix`, which is missing `/dashboard` — and both SPAs answer
an unmatched path with `Navigate to="/dashboard"`, so it lands silently on the dashboard home
rather than 404ing. The agent app cannot receive one at all: it is a Flutter mobile app with **no
App Links and no custom scheme** in its manifest, and its own api-doc already says `url` is
*"Web-oriented; ignore it on mobile"*.

**Nobody is being hit by this today.** All three stacks default email, Telegram and WhatsApp to
`false` and nothing seeds them — unlike customers, where GAP-012 seeds the arrival channel, which
is why the customer half really was live and broken. Fixing it is an owner decision (make the
backend own 21 addresses, adopt the agent app's translate-on-arrival model, or drop the button on
external channels for these three roles) and is not yet taken.


### 6c · ⚠ `reviews_list_mine.status` does not mean "anyone can see it"

**Read `publiclyVisible`. Never branch on `status` to tell a customer whether their review
is up.**

A **delivery** review is an internal quality signal about the carrier — it moves the agent's
aggregate and feeds their trust score, and it publishes to no page anywhere. But a bare-star
review carries no prose for a moderator to read, so `initialStatusOf` writes it straight to
`status: "published"`. Relay that word and the bot tells a customer their review is live,
about something they will never find.

| | `status` | `publiclyVisible` |
|---|---|---|
| product, bare star | `published` | **true** — it is on the product page and it moved the average |
| product, with prose | `pending` → `published` | false → **true** when a moderator clears it |
| product, refused | `rejected` | false. Its star counts for nothing either |
| **delivery, any** | `published` or `pending` | **always false** |

The storefront's own page makes the same determination — a delivery row shows "Delivery
feedback" instead of a status badge — so the choice was never whether to make it, only
whether to make it twice and let the two disagree.

Two more fields on this list, and both can be `null`:

- **`subjectLabel`** — the product's name, resolved here so a chat can say *"your 4-star
  review of the blue kettle"* without five `catalog_get_product` calls. `null` on a delivery
  review (a shipment has no name a customer would recognise, and they are never told which
  agent carried their parcel) and `null` on a product that is no longer publishable —
  the bot must not name a product a shopper cannot open.
- **`orderId`** — the order behind the review. It is the handle for the rows `subjectLabel`
  cannot name: pass it to `orders_get_order`. Read an id aloud to nobody.


### 6d · ⚠ Bookings — two `pending`s, and no slot-lock tools

**Read `awaitingVendorApproval`. `status: "pending"` and `payment.status: "pending"` are on
the same object and mean unrelated things.**

| | means |
|---|---|
| `status: "pending"` | the **vendor** has not accepted the appointment. A `manual`-mode service is held until they do. Nothing is wrong, nobody owes anything |
| `payment.status: "pending"` | **money is in flight** — a mobile-money prompt is on the customer's handset right now |

A model handed both words merges them, and the two mistakes available are the two worst
ones: telling somebody they are booked when the vendor has not looked, or telling them to
pay again while a charge is live. So the vendor one is named explicitly and the raw `status`
is relayed beside it.

**There is no `bookings_lock_slot` and no `bookings_unlock_slot`, deliberately.**

The customer API books in three calls — hold the slot, commit, release if the user walks
away — because a browser wants to hold a time while somebody fills in a form. A chat turn
can take minutes and can simply never come back, so a hold taken on the model's initiative
takes a real appointment off sale for **fifteen minutes** for somebody who already left.

`bookings_create` and `bookings_reschedule` therefore take the hold **themselves**,
immediately before committing, and release it in a `finally` when the commit fails. There is
no bot-reachable path on which a hold outlives the request that took it. This is also
stricter than the customer API, which releases only on the success path — a
`BOOKING_SLOT_UNAVAILABLE` there leaves the hold to expire on its own TTL.

✅ **A capacity-mode service CAN be rescheduled — fixed 2026-09-06 (KI-1).** This paragraph
used to say the opposite, and the reason it is kept rather than deleted is that the
not-worked-around decision is what made the fix a one-line diagnosis: `rescheduleBooking`
asserted the hold on the unscoped key (`slot:lock:{slotId}`) while `lockSlot` writes the
owner-scoped one (`slot:lock:{slotId}:{userId}`) for capacity products, so the assert always
missed and the move was refused with `409 BOOKING_SLOT_NOT_LOCKED` however correct the
request was — on this surface and on the storefront alike. Both calls now pass the scope
flag, resolved once by `GroupBookingService.resolveCapacity`.

Two behaviours this surface inherits from the fix, and neither is bot-specific:

- A move into a **full** class is refused with `409 BOOKING_SLOT_FULL` — an honest capacity
  answer, where the old refusal blamed the hold whatever the real reason was.
- Seats are counted on the **exact** window, so a move into a class that already has other
  attendees succeeds. The single-occupancy overlap check would have refused it.

**Availability is a list, and it is capped like every other one.** `bookings_get_availability`
returns at most five slots and its `moreUrl` is the **product's own page** — the first list
on this surface whose "rest" lives on an entity page rather than one of the fixed account
pages, which is what `BotListDestination`'s `{ path }` form exists for. Prefer narrowing
`from`/`to` to the day the customer actually named over paging.

⚠ **`from`/`to` are OPTIONAL here and REQUIRED on the customer API.** That endpoint 400s
without both, because a calendar widget always knows which fortnight it is drawing. A model
does not, and making it compute two ISO-8601 instants is making it do date arithmetic —
which fails quietly, as "no availability" for a product with plenty. Omitted, the window is
now → +21 days, the same span the storefront's booking panel opens with.

**`slotId` is opaque** — `slot_<startMs>_<endMs>`, minted by the availability read. Echo it;
never build one.

**Booking payments rejoin the ordinary money tools.** `bookings_pay` and
`bookings_pay_balance` answer a `transactionId`, which is what `payment_get_transaction`,
`payment_authorize_otp` and `payment_create_pay_link` all take. There is no separate booking
payment machinery, and no tool anywhere takes a card number or a PIN.


### 6e · ⚠ Saved payment methods — wallets only, and the number never comes back

**A card cannot be saved from a chat, and that is structural rather than a policy.**
`POST /api/me/payment-methods` needs `gateway_customer_id` and `gateway_instrument_id`. For a
card those are minted by the payment gateway's own SDK, running in a browser, after the shopper
types a number the platform never sees. A chat has no browser and no SDK, so there is no honest
way for a chat caller to hold one — a model asked for those fields would supply something
invented.

For a **wallet** they are not tokens at all: the customer's phone number is sent as *both*
values, because for mobile money the customer and the instrument are the same thing. So
`payment_methods_add` takes `provider` + `phoneNumber` and composes the rest here — including
`display_label` and `last4`, which a model must not write: the label is what the customer will
be shown at checkout, and one naming the wrong network is worse than none.

⚠ **The number is never returned, on any endpoint, and that limits what the tool is worth.** The
customer API withholds `gateway_customer_id` / `gateway_instrument_id` everywhere and this
inherits it whole. So a saved wallet lets a chat say *"your MTN wallet ending 4417"* and lets
the customer set it as the default — it does **not** let a payment be filled in, and
`bookings_pay` still asks for the number. That is not an oversight here: the storefront hits the
same wall and works around it by keeping a copy of the number in the browser's own storage,
which a chat has no equivalent of.

**`expired` is computed, and it is the field to read.** A card whose expiry has passed stays in
the list and still looks like a way to pay — nothing removes it, and the customer API reports
the month and the year as two plain numbers for the reader to compare against today. A model
doing that comparison is a model doing date arithmetic, which fails quietly, and the failure
lands as *"use your Visa ending 4242"* followed by a decline. It is always `false` for a wallet:
a phone number does not expire.

⚠ A card is good through the **last day** of its expiry month, so the comparison is against the
first of the month *after* it. Comparing against the first of the expiry month calls a perfectly
good card dead for up to 31 days.

**The default sorts first**, for the reason `addresses_list` does the same: the cap is five and
the platform allows ten, so a stored-order list could drop the one method a chat answer is most
likely to be about. `payment_methods_set_default` answers the **whole list** rather than the one
row, because setting a default clears the flag on every sibling.

**Removing the default does not elect a replacement.** That is the customer API's behaviour and
it stays: the response reports `hasDefault` so a chat can say so, rather than the customer
finding out at checkout.

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
tools — but `TicketSchema` has no such path and nothing in `src/` writes one, verified by
source scan on 2026-08-25 and **re-verified 2026-09-06**. It was never a field this surface
declined to project. ✅ **The two api-doc pages that showed it are FIXED** (2026-09-06,
DOC-PROGRAM F-17 class 4): `api-doc/customer/tickets.md` and `api-doc/agent/tickets.md` echo
`subject` in their create examples now. The catalogue still names it and is the remaining half.

⚠ **A ticket is addressed by `id`, not `_id`** — this line used to say the opposite, and the
opposite is wrong for `tickets_close`. `Ticket` is on `BaseSchemaOptions`, whose `toJSON`
deletes `_id` and exposes the `id` virtual. The four enriched responses (`tickets_list`,
`tickets_get`, `tickets_create`, `tickets_add_note`) carry **both**, because
`TicketEnrichmentService` builds them with `toObject({ virtuals: true })`, which applies no
transform; `tickets_close` returns the raw document and carries **`id` alone**. `id` is the
only identifier present on all five, so it is the one to key on.

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
[§ 14.6](#146---a-determined-answer-is-a-button-never-a-typed-word) — that section states the
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
    },
    "fallback": {
      "assistantUnavailable": "Désolé, je n'ai pas pu répondre à l'instant. Veuillez réessayer dans un moment."
    }
  }
}
```

⭐ **`data.fallback.assistantUnavailable` is what to send when YOUR model fails** — it errored,
timed out, or came back empty. Every other sentence on this surface is attached to a request:
`error.customerMessage` to a refusal, `onboarding.next.prompt` to a question, `reply` to a turn.
A failure *inside the automation layer* has no request here to answer, so there is nowhere to
hang a sentence — and a customer is still sitting in a chat window. It is therefore handed to
you in advance, on the call you already make on every message, in the customer's language.

⚠ **It is NOT the "onboarding finished" turn.** A response whose `onboarding.complete` is true
carries no `reply` on purpose (§14.2): the platform has no question left and the turn belongs to
your model. Hand that turn to the model; use this string only when the model itself could not
produce one.

⭐ **`onboarding.next.prompt` is the sentence to send.** It is localised, written for a chat
window, and always present when `next` is non-null. The other fields on `next` tell your
flow *what to do with the answer*; `prompt` is what the customer reads. Never compose your
own — see §11.6, which is the same rule `error.customerMessage` follows.

⭐ **`onboarding.next.requestLocation: true` means the customer may send a map pin.** It appears
on the **address** step, on **both** channels — absent, not `false`, everywhere else. You do not
render the control: `reply` already carries it (Telegram a `request_location` keyboard button,
WhatsApp a `location_request_message`). What the flag tells you is that **an inbound location
message is expected on this turn**, so normalize it and `POST /geo/reverse { identity, lat, lng }`.
That answers with the same one-row picker a search does, and the tap comes back as a `gc_` ref you
post to `/identity/onboarding` exactly as before — **no new submit path.**

⚠ **Typing still works and is not a fallback.** The pin is a shortcut; a typed address goes to
`/geo/search` as it always did. Handle an inbound location on *every* turn, not only when this
flag is set — the customer can send one from the attachment menu whenever they like.

⭐ **`onboarding.next.skipLabel` is the exact text a Telegram Skip press will send back.**
Present only when the step is skippable **and** the control is a reply keyboard — today, the
Telegram address step. Compare the inbound text to it for equality and `POST
/identity/onboarding { step, action: "skip" }`.

⚠ **This is not a return to magic words.** §14.6 abolished asking *you* to know that `skip`,
`passer`, `saltar`, `omitir` and `تخطٍّ` are one intent — a translation table in the layer with no
copy table. Here you are handed the one string, per turn, already in the customer's language, and
you check equality. You never learn what it means. It exists because Telegram's `reply_markup` is
a **union**: a message asking for a location cannot also carry an inline keyboard, so the Skip has
to be a keyboard button, and a keyboard button's press arrives as an ordinary text message.

⚠ **WhatsApp has no Skip on that turn.** `location_request_message` permits one action and no
buttons, so `skipLabel` is absent there and the address step is not skippable by tapping on
WhatsApp. Deliberate: the alternative was dropping the native location button on that channel.

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

> ⭐ **Since 2026-08-26 you do not have to compose the REQUEST either — see [§ 14](#14---reply--the-request-body-you-post-to-the-channel-unmodified).**
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
| `whatsapp` | `https://graph.facebook.com/v26.0/<WHATSAPP_PHONE_NUMBER_ID>` |

⚠ **This table said `v18.0` until 2026-09-08 and had been wrong for months.** v18.0 expired
2026-01-26; Meta reroutes an expired version silently, so nothing failed and nothing said
anything. The live `send whatsapp` node reads `$env.WHATSAPP_API_URL` with `v26.0` as its
literal fallback, which is what was actually in use. Pin the version in that variable, not
in a node and not here.

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
| every **contact-change** write (§ 15) | text — what moved, what has not yet, and what the customer must do next |
| `/connections/:channel` (disconnect) | text — that the app is no longer connected |
| `/account/close` | text — the anonymise-and-retain promise, in the past tense. The last thing the platform says to that customer as themselves |
| ⭐ `/catalog/display` | **product cards** — a Mini App button, a carousel, or one image message per product. The one turn that renders to SEVERAL messages: see § 14.8 |
| ⭐ `/catalog/action` — **every tap** | whatever that button calls for: product cards for `next:` / `more:`, an order card, a parcel card, a yes/no question, a screen button, or **nothing** where the model should speak. One row per token in § 14.9 |

Everything else — a cart, an order list, **one** product, a support context — is **data for
your model to narrate**, and deliberately carries no `reply`. This service words the turns
whose wording is fixed; it does not answer *"do you have red shoes?"*.

⚠ **That sentence used to say "a product" flat, and it was right about ONE and wrong about a
LIST.** Narrating a list is what shipped: five products as a numbered markdown list, no
pictures, no prices anybody could tap, no way to buy. The model was doing exactly what it
was asked and there was nothing else it could do. A **set the customer is meant to choose
from** is a rendering, and renderings live on this side of the wire — § 14.8.

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
the turn that produced it. **There are exactly two mappings, and this is the whole table:**

| token | you POST | with body |
|---|---|---|
| `skip:<step>` | `/identity/onboarding` | `{ "step": "<step>", "action": "skip" }` |
| **every other token** | `/catalog/action` | `{ "token": "<the token verbatim>" }` |

Which tokens exist, which are live, and what each one answers is **§ 14.9**, one row per
token. It is written for a reader debugging a turn. Your flow does not need it: a flow that
follows the two rows above handles a verb added next month without a change.

⚠ **Every verb EXCEPT `skip:` posts to `/catalog/action`, and you never parse any of them.**
The rule below about the three product verbs now covers the rest: one route is the surface's
single tap handler, so a verb added next month needs no change in the automation layer at all.
The route's name is historical — it is not a catalogue-only door.

⚠ **`skip:` goes to `/identity/onboarding` ALWAYS, including a stale one tapped after
onboarding finished.** `/catalog/action` has no handler for it and answers with the
unknown-button sentence. Do not decide in the flow whether a skip is stale. That would need
the flow to remember onboarding state between turns, and it keeps none.
⚠ **The onboarding route does not yet treat a stale skip safely, and that is being fixed on
this side.** Today a Skip tapped on a step the customer has since *answered* re-records that
step as skipped (the value they gave is kept; the checklist row changes). The fix makes a
skip of an already-answered step change nothing. It lands before your change does, so the
rule above does not move.

⚠ **THE VOCABULARY IS DECLARED AHEAD OF ITS HANDLERS.** A token shape is frozen before any
button carrying it is drawn, because a button stays in a chat history for good. A token that
is declared but not yet routed answers `BOT_ACTION_TOKEN_UNKNOWN` (422) with
`error.customerMessage`, so a tap produces a sentence rather than silence. § 14.9 lists which
are which. **No button carrying an unrouted token is drawn.** If one ever is, relay the
customer message and do not guess at the token.

⚠ **`next:` and `more:` are DIFFERENT and both ride on one message.** `next:` sends the next
five cards *into the chat*; `more:` opens the in-app listing screen. They share a `<setId>`
because they are two ways of reading one held result. Forward whichever the customer pressed —
you never have to know which is which.

⚠ **`open:ol` and `open:sl` carry no reference**, and that is not a truncation. Those two
screens are scoped by the caller's own identity, so naming an id would be inventing a
parameter that could only ever be wrong. The bare surface name **is** the argument.

⚠ **Never print a `yes:`/`no:` context, an `open:` reference or any handle in a sentence.**
The reference in an `open:pl:` token names a screen session that authorises a browser to read
a customer's data — on the checkout screen, to spend money. It is a credential.

⚠ **The three product verbs all post to ONE route and you never parse them.** Forward the
token exactly as the platform returned it; `/catalog/action` owns the vocabulary. Splitting
it in the flow would put the verb table in the layer this whole section exists to keep it
out of, and it would go stale the first time a verb is added.

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

### 14.8 · ⭐ Product cards — the one turn that is SEVERAL messages

Everything above renders to exactly one outbound body. A product list does not, and that is
what `replies` exists for.

#### The two tools

| tool | who calls it | what it does |
|---|---|---|
| `catalog_show_products` | **the model**, with `productIds` | draws a page of cards and answers `{ shown, total, hasMore }` |
| `catalog_display_action` | **your flow**, with a tapped `token` | adds to the basket, or pages to the next five |

`catalog_show_products` is `flow_only` and is the **one row where that tier does not mean the
model never calls it.** It is kept off the MCP server because its result is a *rendering* your
flow must relay, not data the model reads — an MCP tool's output lands in the model's context,
where a Telegram `sendPhoto` body can do nothing at all. Wire it as a tool sub-workflow
instead, and have that sub-workflow hand the bodies to your send step.

#### `reply` and `replies`

A response that renders to more than one message carries **both**:

```jsonc
{
  "success": true,
  "data": { "shown": 5, "total": 8, "hasMore": true },
  "reply":   { "channel": "telegram", "method": "sendPhoto", "body": { } },
  "replies": [ { }, { }, { }, { }, { } ]
}
```

- **`reply` is still a single object, always.** Nothing you have already wired breaks: a flow
  that only knows about `reply` sends the first message and the customer sees a product.
- **`replies` is present only when there is more than one**, and it **includes** the body that
  is in `reply`. Send `replies` when it is there, `reply` otherwise. Never both.
- ⚠ **Order is the rendering.** Intro, then cards, then "See more". Send them in order, one
  after another — n8n's HTTP node already iterates its input items in order, so relaying the
  array verbatim is correct. Do not parallelise it.

#### What it renders to, and why you are not told

The shape is decided by the backend from the channel, the deployment's configuration and
whether the pictures are fetchable. **The response deliberately does not say which shape came
back**, because all three inputs change without the model being told, and a sentence naming
the interface ("tap the carousel below") is wrong on the other channel.

| channel | condition | renders as |
|---|---|---|
| Telegram | `BOT_MINIAPP_BASE_URL` is an HTTPS origin | **one** `sendMessage` with a `web_app` button — the Mini App |
| Telegram | otherwise | one `sendPhoto` per product, each with its own inline keyboard |
| WhatsApp | `WHATSAPP_PRODUCT_CAROUSEL_TEMPLATE` is set **and** there are exactly five cards, all with pictures | **one** `template` message — a five-card carousel — plus a "See more" message if there is more |
| WhatsApp | otherwise | one `interactive` image message per product |

⚠ **Five is a hard number on WhatsApp, not a maximum.** A carousel there is a
marketing-category **template**, pre-approved in Business Manager, and Meta will only send a
template with the exact number of cards it was approved with. A four-product answer is not a
shorter carousel — it is a rejected send — so it takes the card path even on a deployment that
has the template. Each card also takes at most **two** buttons, which is why "See more" arrives
as its own message afterwards rather than as a third button on a card.

#### Telegram, with the Mini App — the whole `reply`

```jsonc
{
  "channel": "telegram",
  "method": "sendMessage",
  "body": {
    "chat_id": "900000881",
    "text": "Tap below to see them with pictures and prices.",
    "reply_markup": {
      "inline_keyboard": [[{
        "text": "Browse the products",
        "web_app": { "url": "https://api.wi-mall.com/api/bot/miniapp/p/ma_9f3" }
      }]]
    }
  }
}
```

The page is served by jovi-mall. It shows the cards in a horizontal rail, lets the customer
pick several, adds them to the basket and closes itself. **It sends nothing to the chat** —
that would need the bot token, which your adapter holds and the backend deliberately does not.
The customer's next message sees the updated basket.

#### Telegram, without one — one message per product

```jsonc
{
  "channel": "telegram",
  "method": "sendPhoto",
  "body": {
    "chat_id": "900000881",
    "photo": "https://api.wi-mall.com/api/files/images/2026/09/cover.jpg",
    "caption": "<b>Wireless Noise-Cancelling Headphones</b>\n20 000 XAF · TechHub Electronic",
    "parse_mode": "HTML",
    "reply_markup": { "inline_keyboard": [
      [{ "text": "Buy now", "callback_data": "buy:68b0aa:68c0bb" },
       { "text": "Add to cart", "callback_data": "add:68b0aa:68c0bb" }],
      [{ "text": "Details", "url": "https://shop.wi-mall.com/fr/shop/stores/techhub/products/anc" }]
    ]}
  }
}
```

#### WhatsApp, the card path

```jsonc
{
  "messaging_product": "whatsapp", "recipient_type": "individual",
  "to": "237600000771", "type": "interactive",
  "interactive": {
    "type": "button",
    "header": { "type": "image", "image": { "link": "https://api.wi-mall.com/api/files/images/a.jpg" } },
    "body": { "text": "*Wireless Noise-Cancelling Headphones*\n20 000 XAF\nTechHub Electronic" },
    "action": { "buttons": [
      { "type": "reply", "reply": { "id": "buy:68b0aa:68c0bb", "title": "Buy now" } },
      { "type": "reply", "reply": { "id": "add:68b0aa:68c0bb", "title": "Add to cart" } }
    ]}
  }
}
```

#### The carousel template you have to get approved

Set `WHATSAPP_PRODUCT_CAROUSEL_TEMPLATE` only once Meta has approved a template of exactly
this shape. Until then leave it unset and the card path above is used.

- **Category:** marketing. **Cards:** exactly 5.
- **Message body:** one variable, `{{1}}` — the intro sentence.
- **Each card:** an **image** header; a body with three variables (`{{1}}` title, `{{2}}`
  price, `{{3}}` store); and two buttons, in this order —
  1. a **quick reply**, whose payload is filled at send time with the `add:` token;
  2. a **URL** button whose href is `https://<your storefront>/shop/p/{{1}}`.
- ⚠ **That URL button's variable is the product ID ALONE.** A template URL button takes a
  *suffix* Meta appends to the prefix you declared, not a whole URL. Sending an absolute URL
  there produces `https://.../shop/p/https://...`, which Meta accepts and which opens nothing.
- ⚠ All five cards must declare the **same** components — Meta requires it.

#### Reading a tap

Exactly as § 14.6 says: forward the token verbatim to `POST /catalog/action`. `add:` and
`buy:` both put one of that variant in the basket; they differ in what the customer is then
told, because **"Buy now" does not place an order** — checkout needs a delivery address and a
payment method, and a bot-registered customer routinely has neither, so its reply names
checkout and hands the turn back to your model. `more:` returns the next five as another
`replies` array.

⚠ **`add:` and `buy:` keep working forever; `more:` does not.** The first two carry ids and
need no stored state, so a card scrolled back to an hour later still adds. `more:` names a set
that lives thirty minutes, and a lapsed one answers `404 BOT_PRODUCT_LIST_EXPIRED` with a
`customerMessage` inviting a fresh search — relay it and let the model search again.

#### Two configuration facts that decide whether any of this is visible

- ⚠ **Product images are fetched SERVER-SIDE by Telegram and by Meta.** A URL on a private,
  loopback or carrier-NAT host — which is what `STORAGE_LOCAL_URL` points at on a development
  box — is not a slow image: on Telegram the whole `sendPhoto` fails and the caption and the
  keyboard go with it. The backend checks first and degrades to text cards, so nothing breaks,
  but the pictures appear only once `BOT_MEDIA_PUBLIC_BASE_URL` names an origin the internet
  can actually reach.
- ⚠ **`BOT_MINIAPP_BASE_URL` must be `https://`.** Telegram refuses a `web_app` button on any
  other scheme and refuses the entire message with it. The backend checks the scheme and falls
  back to photo cards rather than sending a message Telegram will drop.

### 14.9 · ⭐ Every tap, and what it answers

Every button this service draws comes back through `POST /catalog/action`. That route parses
the token once, sends it to the one handler registered for it, and refuses anything nobody
handles with `BOT_ACTION_TOKEN_UNKNOWN` (422). The refusal carries `error.customerMessage`, so
the customer gets a sentence.

**How a token finds its handler.** Most verbs have one owner and route by the verb alone
(`ord:…`, `pay:…`). Three verbs are shared by several features and route by the verb **plus
its first argument**: `open:<screen>`, `yes:<context>`, `no:<context>`. So `yes:cd:…` and
`yes:close:…` reach different handlers. You never need to know this; it explains why an
unfamiliar `yes:` context is refused rather than guessed at.

⚠ **Every tap is a mutating call.** It needs an `Idempotency-Key` like any other write (§ 4),
because several taps write: `add:` and `buy:` add a basket line, `yes:cnc:` cancels an order,
`yes:close:` closes an account. The key should be the same on a redelivery of one tap and
different for two taps. The platform's own id for that tap has exactly that property:
Telegram's `callback_query.id`, WhatsApp's inbound message `id`. A human pressing twice is two
taps and gets two answers. A webhook redelivered by the platform is one tap and gets its first
answer again.

**Reading the tables.** *Reply* is what the platform sends; "**none**" means there is no
`reply` and the turn is the model's (§ 14.2). *data* is `body.data`. The rule for what reaches
the model is at the end of this section.

#### Account

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `yes:close:<ref>` | **Confirm**, under the close-account question (`account_close_preview`) | **Closes the account. It cannot be undone.** `<ref>` is a signed reference bound to this account and this channel for ten minutes. A stale or foreign one closes nothing: it asks the question again with fresh buttons | the account-closed sentence, which is the last thing the platform says to this customer as themselves | `{ closed: true, closedAt }`. On a stale ref: `{ closed: false, confirmation, …preview }` and the question again |
| `no:close` | **Keep my account**, beside it | changes nothing, however old the button | **none** | `{ closed: false, kept: true }` |

⚠ **The question draws no buttons at all when the account cannot be closed** (another role on
the account, or orders still moving). The sentence says why, in the same words the close
itself would refuse with.

#### Your account

Every row of the account list, and everything it opens. One verb, `acct:<section>`, with the
section deciding what is read or written.

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `acct:menu` | **My account**, and once the setup questions are finished | the account list — eight rows | the eight-row choice | `{ section: "menu" }` |
| `acct:prof` | a row of that list | reads the profile | the summary, masked as `profile_get_summary` already masks it | the profile |
| `acct:addr` | a row of that list | reads the saved addresses | the list, each row offering Make default · Remove | the addresses |
| `acct:addr:<id>:def` · `acct:addr:<id>:rm` | an address row | makes it the default · removes it | one sentence | `{ addressId, outcome }` |
| `acct:addr:new:<gc_…>` | a candidate picked after onboarding | saves that candidate as an address | one sentence | `{ addressId }` |
| `acct:pay` · `acct:pay:<id>:def` · `acct:pay:<id>:rm` | the payment rows | the same three things for saved payment methods | one sentence | `{ paymentMethodId, outcome }` |
| `acct:inbox` · `acct:inbox:read` | a row of that list | the five most recent notifications · marks them all read | the list · one sentence | `{ unread }` |
| `acct:conn` | a row of that list | which apps can reach the account | the disconnect question, or the sentence saying this is the only one | the connections |
| `yes:unl:<whatsapp\|telegram>:<ref>` · `no:unl:<whatsapp\|telegram>` | that question | disconnects that app · keeps it | one sentence | `{ channel, disconnected }` |
| `acct:lang` · `lang:<code>` | a row of that list · a language option | asks which language · sets it | the five-way choice · one sentence **in the newly chosen language** | `{ language }` |
| `acct:contact:em\|ph:resend\|cancel` | a pending contact change | sends the code again · abandons the change | one sentence | `{ field, outcome }` |
| `acct:close` | the last row of that list | draws the closure consequences and the two buttons | the consequence sentence + **Keep my account · Close my account** | `{ closing: true }` |

⚠ **The scope on an unlink is the CHANNEL NAME, not an id.** This platform has no connection
id: the set is closed at `whatsapp` and `telegram`, and the route is
`DELETE /connections/:channel`.

⚠ **A customer has at most ONE disconnectable app**, because the app they are talking to you on
can never be disconnected — that binding is what resolved the request, and cutting it would
leave them unable to undo it from where they did it. So `acct:conn` asks the question directly
rather than drawing a one-row list.

⚠ **A stale `yes:unl` reference re-asks rather than refusing**, exactly as `yes:close` does, and
`no:` carries no reference at all: declining writes nothing, so there is nothing to bind, and
refusing a stale decline would refuse the one answer that is always safe.

#### Buying and the basket

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `add:<productId>:<variantId>` | **Add to cart**, on a product card | puts one of that variant in the basket | "Added" with **View cart · Checkout · Browse more** | `{ outcome, verb, productId, variantId }` |
| `buy:<productId>:<variantId>` | **Buy now**, on a product card | puts one in the basket and points at checkout. **It places no order**: checkout needs an address and a payment method (§ 14.8) | the same three buttons. A digital item on a deployment with screens gets one **Checkout** screen button instead | the same, plus `url` when `outcome` is `checkout` — ⛔ never relay it |
| `bargain:<productId>:<variantId>` | **Bargain**, on a card whose variant is negotiable | **writes nothing.** It asks the customer for their offer. The customer's answer, as an ordinary message, is what starts the haggle; nothing on this side can start it | the product name and the question, no buttons | as `add:` |
| `book:<productId>` | **Book**, on a service's card | **writes nothing.** It asks for a day and a time | the product name and the question, no buttons | as `add:`, `variantId` may be null |
| `more:<setId>` | **See more**, under a page of cards | opens the list the cards came from as a screen. Without screens (production today) it sends the next five cards instead | a screen button, or the next cards (`replies`) | `{ opened: "listing" }`, or `{ shown, total, hasMore }` |
| `next:<setId>` | *nothing draws it yet* | the next five cards, in the chat | the cards (`replies`) | `{ shown, total, hasMore }` |
| `cart:view` | **View cart**, after an add | reads the basket | **none**: the model narrates the basket, as it does for `cart_get` | the basket, the same shape as `cart_get` |
| `open:co` | **Checkout**, after an add | starts a checkout **for whoever tapped**. The token carries no handle: the screen session is created on the tap, lives ten minutes, and is spent by placing the order | a screen button; without screens a storefront link to the basket; with neither, **none** | `{ opened: "checkout" }` |
| `open:pl` | **Browse more**, after an add | the whole shelf as a screen | a screen button; else a storefront link to the shop; else **none** | `{ opened: "listing" }` |

⚠ **The server decides what a purchase button does, not the button.** A card drawn last month
says "Add to cart". If the seller has since opened a price negotiation on that variant, the
tap starts a haggle. If the variant has sold out, the tap is refused with
`CATALOG_VARIANT_INSUFFICIENT_STOCK`. `data.verb` is what actually happened; narrate that,
not the label the customer pressed.

⚠ **`add:` and `buy:` never expire. `more:` and `next:` expire after thirty minutes**, with
`404 BOT_PRODUCT_LIST_EXPIRED` and a sentence inviting a fresh search. The first two name
products; the second two name a held list.

#### Orders and delivery

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `ord:<orderId>` | **an order row**, in the list of orders | the order card | the card — order number · store, then state · payment, then the total — with up to three buttons: **Shipments**, **Cancel**, **Get help** | the customer's order. ⛔ **delivery codes are stripped from it**; the only way one leaves is `code:` below |
| `ord:<orderId>:cancel` | **Cancel**, on that card | **cancels nothing and checks nothing.** It asks the are-you-sure | the question, as a two-way choice: Yes → `yes:cnc:<orderId>`, No → `no:cnc:<orderId>` | `{ orderId, orderNumber, awaitingConfirmation: true }` |
| `yes:cnc:<orderId>` | **Yes**, on that question | **cancels the order**, against the full eligibility rule rather than the card's own guess. A card sitting in a chat history may be stale, so an order that has moved on since is refused here, in the customer's language | the request for a **typed** reason. The tap is the decision; the words come next (owner's decision — a reason is never picked from a list) | `{ order_id, fulfillment_status }` |
| `no:cnc:<orderId>` | **No**, beside it | changes nothing. Draws the order card again, so the customer lands where they came from | the card, as `ord:<orderId>` | the order |
| `shp:<orderId>` | **Shipments**, on the order card | every parcel on that order | **one parcel** → that parcel's card · **several** → a choice of parcels, numbered, each row carrying its state, its carrier and its tracking code · **none** → **none**, and the model says where the order has got to | the parcels |
| `shp:<orderId>:<shipmentId>` | **a parcel row**, in that choice | one parcel's card, with whatever that parcel can actually offer | the parcel card. Its buttons depend on where the parcel is — a cash-on-delivery parcel carries **Get code**, a failed delivery carries support buttons | that parcel |
| `code:<orderId>:<shipmentId>` | **Get code**, on a cash-on-delivery parcel card | shows the delivery code for that parcel | the code. ⛔ **No Resend, deliberately** — a replacement is issued by the agent from their own app, so there is one issuing path; a second here would let a chat invalidate the code the agent is holding at the door. An **already-collected** parcel carries no code, and then the reply is **none** | the collection block |
| `track:<orderId>` | **Track**, beside Get code on a cash-on-delivery parcel card — and **only there**. Every other parcel card carries the tracking LINK directly, because one WhatsApp interactive message cannot hold a reply button and a URL button at once | where the order is, plus the storefront's tracking page | the order number and its state, with a **link** button. With no storefront configured the button is not offered at all, and this token is not drawn — a Track that can only answer with a sentence looks broken | `{ orderId, orderNumber, trackingUrl }` |
| `yes:cd:<orderId>:<shipmentId>` | **Yes**, under "did it arrive?" — offered on a parcel the agent has handed over and **never on a cash-on-delivery one**, where giving the agent the code IS the confirmation | confirms that parcel as delivered | the confirmed sentence | the confirmation |
| `no:cd:<orderId>:<shipmentId>` | **No**, beside it | **writes nothing**, and exists so that a two-way question has two answers rather than a control that can only agree | the not-received sentence | `{ confirmed: false, orderId, shipmentId }` |
| `tkt:new:<topic>:<orderId>` | **Get help** on an order card, and the support buttons on a failed delivery. `<topic>` is `rd`, `ad` or `hp` | **opens no ticket.** It names the topic and hands the turn to you | **none** — the model asks what happened and opens the ticket, so it is asked for what a ticket needs | `{ supportRequest: true, topic, orderId, orderNumber }`. `topic` comes back in full — `redelivery_requested`, `delivery_address_wrong`, `delivery_problem` — the abbreviation exists only to keep the token inside 64 bytes |
| `open:ol` | the **last row of the order list** — the way out of the five-row cap. It is a row and not a link because a choice row cannot be one: both channels render an option as a token, so the escape hatch is a tap that *produces* a link | the order history as a screen | a screen button; without screens the storefront's orders page — **that second case is production today**, since `BOT_MINIAPP_BASE_URL` is unset; with neither, **none** | `{ handle, opened: "orders" }`. ⛔ `handle` is a credential — § 19.5 |

⚠ **Two of those three support topics exist because the FEATURE does not.** There is no
delivery-reschedule endpoint anywhere in this platform, and the delivery address is snapshotted
onto the order at checkout, so neither can be changed from a chat. The customer is handed a
person instead of a button that lies.

#### Support requests

The rest of the `tkt:` verb. Every row is handled by the same stream as the orders above, and
each key is registered in the change that first draws its button.

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `tkt:list` | **My requests** | the customer's support requests | a choice of requests | the requests |
| `tkt:<ticketId>` | a request row | that request: where it stands, the latest replies, and up to three buttons | the request card — **Reply · Attach photo · Close** | the request |
| `tkt:<ticketId>:rp` | **Reply**, on that card, and **Reply here** on a request waiting for the customer | **writes nothing.** It says the next message will be filed against this request | **none** — the model asks, then files the customer's next message with `tickets_add_note` | `{ ticketId, subject, status, awaitingReply: true }` |
| `tkt:<ticketId>:ph` | **Attach photo** | asks for the picture | the ask | `{ ticketId, awaitingFile: true }` |
| `tkt:<ticketId>:<att_…>` | the which-request picker, after a photo arrives with no request named | attaches the picture just sent to that request | one sentence | `{ ticketId, attached: true }` |
| `tkt:<ticketId>:cl` | **Close** | asks the are-you-sure | the question: **Yes** → `yes:tcl:<ticketId>:<ref>`, **No** → `no:tcl:<ticketId>` | `{ ticketId, awaitingConfirmation: true }` |
| `yes:tcl:<ticketId>:<ref>` · `no:tcl:<ticketId>` | that question | closes the request · keeps it open | one sentence | `{ ticketId, closed }` |
| `tkt:new` | **Get help**, with no order in hand | opens the support form | a screen button, or the sentence asking what happened | `{ handle, opened: "ticket_form" }` |
| `tkt:new:<att_…>` | a photo sent with nothing else | opens the form carrying that picture | as above | as above |
| `tkt:new:rd\|ad\|hp:<orderId>` | the order and failed-delivery buttons | opens the form **pre-filled** with that order and topic where a screen can be served; unchanged otherwise | a screen button, or **none** | `{ supportRequest: true, topic, orderId, orderNumber }` |

⚠ **The close carries a signed reference and the decline does not** — the same pair as
`yes:close` and `yes:cnc`, ten minutes, bound to this customer, this conversation and **that one
request**, so a Close button from another thread cannot close this one. A stale reference asks
the question again rather than refusing.

⚠ **Closing is milder than it looks and the reference is still right.** Support can reopen a
request; the customer cannot. So the ten minutes cost a re-ask, never a conversation.

⚠ **A reply is not a direct write, and this is the pattern to recognise.** The tap returns data
and sets **no** `reply`, because a chat carries no state between turns: the customer's words are
in their NEXT message, and the model files them. The same shape is used after `yes:cnc`, where
the cancellation reason is typed rather than picked.

⚠ **`cat:<digest>`, `rate:<orderId>:<stars>` and `lang:<code>` are in the token vocabulary and
are NOT routed today.** They have builders and no handler, so a tap on one answers
`BOT_ACTION_TOKEN_UNKNOWN`. Nothing draws them, and nothing should until this section gains a
row for them.

#### Browsing and bargaining

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `cat:<digest>` | a category choice | opens that category as a grid. ⚠ The argument is a DIGEST of the category name, not an id — this platform has no category ids, and a long French or Arabic name would blow the 64-byte token | a screen button, or the cards | `{ opened: "listing", category }` |
| `sim:<productId>` | an out-of-stock card, where the buy buttons are gone | products like that one | the similar cards, or the sentence saying there are none | `{ shown, total }` |
| `save:<productId>` | an out-of-stock card | keeps it in the customer's saved items | one sentence. ⛔ **It promises no restock message** — nothing on this platform can send one, which is why the button says Save for later and not Notify me | `{ saved: true }` |
| `open:pd:<productId>` | the reviews summary | opens the product screen at its reviews | a screen button; else the storefront product page | `{ handle, opened: "product" }` |
| `deal:<sessionId>:<round>` | a bargained counter-offer | accepts **that round's** price and puts the item in the basket at it | the agreed sentence + the same three buttons an ordinary add gets | `{ locked, price }` |

⚠ **A category that has emptied since the button was drawn opens EVERYTHING and says so**, rather
than refusing: the customer asked to browse, and an empty answer to "show me shoes" is worse than
a wider one that explains itself.

⛔ **`deal:` carries a REFERENCE and a ROUND, never a price.** The price is read from the
negotiation record for that round and re-judged on the press; a price in the token would let
anyone lock any figure. The round is what makes "the exact price you were shown" true — a press
on an offer the agent has since replaced is answered as superseded, with the latest offer's
button, and never silently locked at a price the customer never saw.

⚠ **Every refusal on that token answers with a sentence and the right next button** — superseded,
expired, window moved, already ordered. ⛔ An expired deal must never read as though it never
happened.

#### Bookings

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `open:bl` | **My bookings**, under a booking receipt | the customer's own appointments as a screen | a screen button; without screens the storefront's bookings page — **that second case is production today** | `{ handle, opened: "bookings" }`. ⛔ `handle` is a credential — § 19.5 |

⚠ **`bl` is the only bookings screen a BUTTON can name**, and the other two are absent from this
table on purpose. A picker handle (`bk`) holds a slot on a shop's calendar and a payment handle
(`bp`) moves money, so both are minted **server-side on the tap that opens them** and never sit
in a chat history waiting to be pressed. The same rule keeps a checkout handle out of `open:co`.

#### Reviews

Three arities of one verb, told apart by how many parts the argument has — the same way
`shp:<orderId>` and `shp:<orderId>:<shipmentId>` differ.

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `rate:<orderId>` | the delivered notification, and the order card once the order is confirmed | the invitation — asks for the stars | the question, with **five star options** | `{ orderId, awaitingStars: true }` |
| `rate:<orderId>:<stars>` | a star option | with ONE product on the order, writes the review; with several, asks which | the thank-you, or the which-product question | `{ reviewId }`, or the products to choose from |
| `rate:<orderId>:<stars>:<productId>` | that question's rows | writes the review for that product at those stars | the thank-you | `{ reviewId }` |

⚠ **Stars first, product second, and the order is the point.** The stars are the impulse at the
moment a delivery lands; a follow-up question costs the rating. A single-product order — the
common case — is one tap after the invitation and no question at all.

⚠ **The star options carry no copy in any language.** Their labels are the stars themselves
(★★★★★ … ★): language-neutral, five characters, inside WhatsApp's row-title cap.

⚠ **`reviews_create` stays `flow_only`** — the tap calls the service directly rather than going
through the model, the same posture as the download tap. A model does not get to write a review.

#### Digital downloads

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `dl:<entitlementId>` | a row of the purchased-library choice | mints a **single-use, 15-minute** download link and answers with a LINK BUTTON | the sentence stating the expiry, with the button. Where no HTTPS origin is configured it says so and mints nothing | `{ entitlementId, delivered }`. ⛔ the URL is never in the data for you to relay |

⛔ **The link NEVER appears in message text, and this is mechanical rather than stylistic.**
Telegram and WhatsApp PRE-FETCH a URL that appears in text to build a preview, and the token IS
the authorisation and is spent by the first GET — whoever makes it. A pasted link is therefore
burned by the preview crawler before the customer taps it: they get a dead link and the log
records a successful download. **Never offer a download link yourself; you cannot mint one.**

⚠ **The token names the ENTITLEMENT, never the link.** A chat message lives for ever and a link
lives fifteen minutes, so a URL baked into a button would be dead for almost everyone who ever
pressed it. The server mints on the press — the rule `open:co` follows for checkout and `deal:`
for a price.

#### Payments

| token | drawn on | what it does | reply | data |
|---|---|---|---|---|
| `pay:st:<transactionId>` | **Check status**, under a payment result. *Nothing draws it yet*: the payment-result messages being built this round will | asks the gateway where that payment is, unless it has already finished | **none** | `{ transactionId, state, amountText, orderCount }`. `state` is `settled`, `failed` or `waiting` |
| `pay:rt:<transactionId>` | **Try again**, under a failed payment. *Nothing draws it yet*, as above | a fresh mobile-money charge **for the orders that payment covered**, to the number on the account. **It never places an order again**. If those orders have been paid meanwhile, it answers `settled` instead of charging | **none** | `{ transactionId, state, instructions }`. `instructions` is the operator's own text (the USSD code, "approve on your phone"); it is the one thing the customer must act on, so relay it |

⚠ **These tokens carry the transaction id; the matching tools do not.** A button outlives the
payment it was drawn for. A Try again tapped under last week's failure must charge for last
week's orders, not whatever basket is newest. A tool is called by the model, which would
invent an id, so the tools use "the latest".

⚠ **`pay:rt` with no number on the account** answers `422 PAYMENT_REFERENCE_REQUIRED`. The
model should ask which number to charge and call `checkout_retry_payment` with `phone`. A
button cannot carry a number.

---

## 15 · Contact changes — moving what the account signs in with (parity step 6)

Six tools. **One read and five writes, and every write is `flow_only`.** Contract for the
endpoints they delegate to: `api-doc/me/contact-change.md`.

The boundary is not caution. Each of the five moves or abandons the identifier
`POST /auth/login` resolves the account by, and the two failure directions look the same from
the customer's side — *"I cannot get in and I do not know why"*. A model that starts a change
off a half-understood sentence and a model that cancels one off *"I did not get the email"*
both produce it, so neither verb reaches a model. That is the same line all seven address and
payment-method writes already sit behind.

| Tool | Route | Tier |
|---|---|---|
| `contact_get_state` | `POST /contact` | extended |
| `contact_change_email` | `PATCH /contact/email` | flow_only |
| `contact_cancel_email_change` | `DELETE /contact/email/pending` | flow_only |
| `contact_change_phone` | `PATCH /contact/phone` | flow_only |
| `contact_confirm_phone` | `POST /contact/phone/confirm` | flow_only |
| `contact_cancel_phone_change` | `DELETE /contact/phone/pending` | flow_only |

### 15.1 · `POST /contact` — the read, and its one computed field

```jsonc
// 200
{ "success": true, "data": {
    "emailMasked": "j••••t@example.com",
    "phoneMasked": "+2376••••4417",
    "pendingEmail": { "target": "nouveau@example.com",
                      "expiresAt": "2026-09-07T10:00:00.000Z" },
    "pendingPhone": null,
    "phoneChangeProved": null } }
```

⚠ **The masking is ASYMMETRIC and both halves are deliberate.** The CURRENT identifiers are
masked, by the rule `profile_get_summary` already set — a chat window is shared,
screenshotted and read over a shoulder, and the customer already knows their own number. A
PENDING target comes back **in full**, because the whole question this read answers is
*"which address should I be checking?"* and `j••••t@example.com` does not answer it. The
customer typed that value seconds ago, in this conversation.

⚠ **`phoneChangeProved` is three-valued: `null` · `false` · `true`.** `null` means nothing is
pending — it is not "cannot be proved", which is a different and untrue statement. `false`
means there IS a pending change and the customer cannot finish it from where they are
standing, which is the state § 15.3 explains.

`requestedAt` is deliberately absent. `expiresAt` is the one a chat can act on; a second
timestamp is a second thing for a model to narrate wrongly.

### 15.2 · Email — the identifier does not move here

`PATCH /contact/email` writes a pending block and sends a confirmation link to the NEW
address. **`login_email` moves when that link is opened**, on a storefront page this surface
has no part in — so the tool's `reply` says so, and relaying it is not optional: a customer
who believes the change is already done reads the old address still working as a fault.

⚠ **A second request supersedes the first.** The pending block is replaced, which invalidates
the previous link. That is the right behaviour for the mistyped address a chat produces most
often, and it means *"just tell me the address again"* is a complete recovery with **no
cancel in between**.

⚠ **There is no `contact_confirm_email`, and there cannot be one.** The confirm is
`POST /api/auth/email-change/confirm`, unauthenticated, because the token arrives in a mail
client that is routinely not the device the change was started on. A chat cannot present it.

### 15.3 · ⭐ Phone — the change usually cannot be FINISHED where it was started

**This is the trap in step 6, and it is not the one the plan predicted.** The plan expected
that changing the login phone could orphan the conversation, because WhatsApp identity
resolution falls back to `login_phone`. For an already-bound sender **it cannot** —
`channel_connections` is step 1 of the identity ladder and wins outright, so the binding
survives the identifier moving underneath it.

What is true, and is the sharper constraint:

**The only proof the platform accepts is a WhatsApp connection whose identity IS the new
number.** There is no SMS provider in this service, and a WhatsApp template to a number that
has never written to us must be billed to a credit wallet a customer does not have — so this
is not a gap to be filled later, it is the design (`ContactChangeService`'s header).

**An account holds at most one WhatsApp connection.** So:

| The customer is on… | To finish the change they must… |
|---|---|
| WhatsApp, bound to the OLD number | disconnect that connection and reconnect from the NEW number |
| Telegram | connect WhatsApp, from the new number, for the first time |
| WhatsApp, already bound to the new number | nothing — `contact_confirm_phone` succeeds now |

⚠ **The door does not refuse on that ground**, deliberately. Opening a pending change is
harmless and reversible, and the customer may be about to go and connect the number; a door
that refused would make the flow unreachable for exactly the person it is for. What it does
instead is **say the path**, in the `reply`, and report it afterwards as
`contact_get_state.phoneChangeProved`.

`contact_confirm_phone` takes no arguments — the pending block names the number, the account
carries the proof — and answers the new number **masked**, because once it is the account's
own identifier it is no longer a value the customer just typed to be checked.

⚠ A `422 CONTACT_CHANGE_PHONE_UNPROVEN` is **not a retry**. Its `customerMessage` names the
remedy; asking again changes nothing.

### 15.4 · Three refusals have their own customer copy, and three deliberately do not

`CONTACT_CHANGE_PHONE_UNPROVEN`, `CONTACT_CHANGE_NOT_PENDING` and `CONTACT_CHANGE_EXPIRED`
each earn an entry in `bot-error-copy.ts`, by the test that table applies: **the category
fallback would send the customer to do the wrong thing.** *"That is not something I can do
right now"* invites waiting where the remedy is an action; *"that has already changed — let
me check and try again"* invites a retry that can never succeed.

`CONTACT_CHANGE_SAME_IDENTIFIER` and `CONTACT_CHANGE_IDENTIFIER_TAKEN` do not: their category
sentences already say the only true thing. `CONTACT_CHANGE_TOKEN_INVALID` is raised on a path
a chat never touches.

---

## 16 · Messaging connections and account closure (parity step 7)

| Tool | Route | Tier |
|---|---|---|
| `connections_list` | `POST /connections/list` | extended |
| `connections_disconnect` | `DELETE /connections/:channel` | **flow_only** |
| `account_close_preview` | `POST /account/close/preview` | extended |
| `account_close` | `POST /account/close` | **flow_only** |

### 16.1 · `connections_list` — and the one field it computes

```jsonc
// 200 — always exactly two rows
{ "success": true, "data": [
    { "channel": "whatsapp", "connected": true, "displayName": "Jean",
      "identityHint": "••••4417", "connectedAt": "2026-08-20T09:12:00.000Z",
      "isCurrentChannel": true },
    { "channel": "telegram", "connected": false, "displayName": null,
      "identityHint": null, "connectedAt": null, "isCurrentChannel": false } ] }
```

⚠ **It carries NO `meta` window, and it is the third route on this surface with a written
exemption from the five-row cap** (beside `orders_list_shipments` and `geo_search_address`).
`CONNECTION_CHANNELS` has exactly two members and the response always carries both, so the
set is closed at two, can never reach the cap, and has nothing a "see the rest" link could
point at. A window here would report `hasMore: false, moreUrl: null` on every call for ever.

⚠ **`howToConnect` is dropped**, unlike `GET /api/me/connections`. That field carries a
`wa.me` deep link for a settings screen to render as a button; relaying one into a WhatsApp
chat invites the customer to tap through to the conversation they are already in. The
instruction — *send `/connect` to the bot, then redeem the code while signed in* — is a
conversation, not a link.

⚠ **`identityHint` is the only form of a messaging identity that ever leaves the backend**,
here as everywhere. There is no expanded variant and asking for one will not produce it.

**`isCurrentChannel` is computed by the backend and must not be re-derived.** A caller working
it out means a caller comparing `channel` against something it believes about itself, and the
failure lands as a chat offering a disconnect button that answers 409.

### 16.2 · ⛔ `connections_disconnect` REFUSES the channel it arrived on

```jsonc
// 409
{ "success": false, "error": {
    "code": "BOT_CONNECTION_ACTIVE_CHANNEL", "statusCode": 409,
    "category": "conflict", "details": { "channel": "whatsapp" },
    "customerMessage": "I cannot disconnect the app we are talking in — I would not be able to reach you. You can do it from your account page on the website." } }
```

This is the one rule this surface adds over the customer API's own verb. A
`channel_connections` row is step 1 of the identity ladder, so cutting the current one leaves
this surface unable to resolve the sender it is mid-conversation with — and **the customer
cannot undo it from where they did it**: reconnecting needs a session, which they reach from
the storefront. That asymmetry is what makes it worth refusing rather than warning about.

**Disconnecting the OTHER channel stays permitted.** A customer on WhatsApp removing their
Telegram connection breaks nothing they are using.

⚠ **Do not offer this as a way to stop notifications.** `notifications_update_preferences`
does that without breaking sign-in.

### 16.3 · ⭐ Closure is two tools, and the first is the reason the second is safe

`account_close_preview` is a **read** — it changes nothing, it is reachable by the model, and
it answers three things a flow needs before it can honestly ask for a confirmation:

```jsonc
// 200
{ "success": true, "data": {
    "canClose": false,
    "blockingRoles": [],
    "activeOrderCount": 2,
    "consequence": "Closing your account removes your name, phone number, email address and saved addresses. Your past orders are kept as business records, without your details. This cannot be undone.",
    "confirmWith": "CLOSE MY ACCOUNT" } }
```

**Relay `consequence` verbatim.** It is written here, in five languages, because this is the
single most consequential sentence in the product and the automation layer has no copy table
and no translator — the same argument that already put `error.customerMessage`,
`onboarding.next.prompt` and the whole `reply` body on this side of the wire, arriving for
the fifth time on the one turn that cannot be taken back.

⚠ **Say CLOSED and say the orders are kept. Never say deleted or erased.** ADR-A02 D-2 is
explicit that this anonymises and retains, that no erasure obligation has been established in
this market, and that nothing may be described to a customer as satisfying one. A customer
who believes their orders vanish and later meets a delivery record has been misled by
omission.

**`canClose: false` names which of the two refusals applies**, before the irreversible call
rather than as a `422` after the customer has already confirmed:

| | means | what to say |
|---|---|---|
| `blockingRoles` non-empty | the account also sells or delivers | support has to handle it |
| `activeOrderCount > 0` | orders are still on the way | it can be closed once they arrive |

⚠ **The preview had to be its own route rather than a no-argument branch of `account_close`.**
That row is `mutating`, so `botIdempotency` demands an `Idempotency-Key` on it — and a preview
and a close sharing one key collide on the request fingerprint and answer
`BOT_IDEMPOTENCY_KEY_REUSED`. A caller working around that by minting two keys is a caller one
mistake away from spending the close's key on the preview. **This is a deliberate deviation
from the parity plan's "3 tools" for step 7**, of the same kind as step 4's refusal of the
lock/unlock pair.

### 16.4 · `account_close` — the second step

```jsonc
{ "confirm": "CLOSE MY ACCOUNT" }
```

⚠ **`confirm` is a TOKEN, not a sentence the customer types**, and it is deliberately
untranslated — the same rule § 14.6 states for every determined answer. The flow shows
`consequence`, the customer taps a button, and the flow sends `confirmWith` back verbatim. A
customer who typed *"fermer mon compte"* is refused, and correctly: the phrase's only job is
to make the request impossible to send by accident.

⚠ **This deletes the messaging connection this conversation runs on**, so the customer's NEXT
message arrives as a stranger. The `reply` is therefore the last thing the platform says to
them as themselves.

⚠ **There is no un-close.** `AdminUserService.restore` compare-and-sets from `suspended`, so
it misses a closed row and answers 409. Support cannot reverse this either.

**A repeat answers `409 USER_STATUS_CONFLICT`**, from the compare-and-set on `active` — not a
second cascade. That is the correct outcome and not one a caller should reach by accident,
which is why the row is `mutating` and carries an `Idempotency-Key` like every other write.

---

---

## 17 · Files the customer sends (parity step 7b)

Two routes, and they are deliberately at opposite ends of the tier scale:

| Tool | Route | Tier | Called by |
|---|---|---|---|
| `files_receive_inbound` | `POST /files/inbound` | **flow_only** | your deterministic media step, before the model runs |
| `tickets_add_attachment` | `POST /tickets/:ticketId/attachments` | extended | the model |

### 17.1 · ⭐ The split, and why it is the only shape that works

A photo arrives on WhatsApp or Telegram as **an id pointing at a file on Meta's or Telegram's
servers**. Three parties could in principle turn that into bytes, and two of them must not:

- **The model cannot.** It has no bytes and no channel credentials. A tool taking a `fileId`
  would be a tool it fills in by invention.
- **The backend must not.** Fetching a URL a caller supplied is an outbound request to
  wherever the caller pointed it, and it would mean this service holding your channel tokens.
- **You can, and only you.** You already hold the bot token and the Meta access token.

So the bytes come to `POST /files/inbound`, which runs the platform's ordinary upload pipeline
(magic-byte sniffing, virus scan, quota, storage) and hands back **an opaque reference**. The
model never sees a file id, never sees a URL, and names the file only by that reference.

### 17.2 · `POST /files/inbound` — you call this, the model never does

```jsonc
{
  "identity": { "channel": "whatsapp", "externalId": "237600124417" },
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "contentBase64": "/9j/4AAQSkZJRgABAQ..."
}
```

```jsonc
{
  "success": true,
  "data": {
    "ref": "att_9Kf3xQ2mN8pL...",
    "fileName": "photo.jpg",
    "mimeType": "image/jpeg",
    "size": 184203,
    "kind": "image"
  }
}
```

⭐ **`kind` is `image` or `document`, decided here.** A model handed `application/pdf` and asked
whether that is a photo will mostly get it right and will occasionally tell a customer their
receipt is an image. Same class of field as `expired` on a payment method and
`publiclyVisible` on a review: two words the backend can decide once.

⚠ **Call it AFTER `/identity/sync`, never before.** The row requires a resolved customer, so a
brand-new sender whose very first message is a photo would be refused with
`BOT_IDENTITY_UNRESOLVED` if you upload first. Sync registers them; then upload.

⚠ **It stores the file and attaches it to NOTHING.** Where a file belongs is a decision, and a
customer photographs a damaged item before there is a ticket to put it on at least as often as
after. A reference nobody spends costs a stored file and nothing else — no `file_references`
row is written, so orphan garbage collection reclaims it on its own schedule. That is the
designed outcome for the photos a conversation never uses, not a leak.

#### What it accepts

| | |
|---|---|
| **Types** | `image/jpeg` · `image/png` · `image/webp` · `image/gif` · `application/pdf` |
| **Size** | 8 MB **decoded**. Base64 inflates by a third, so that is ~10.7 MB on the wire |

⚠ **The allowlist is NARROWER than the platform's own upload allowlist**, which also permits
zip and two audio types. Filter on the same five before you spend a channel download: a voice
note is `audio/ogg` on both channels and is refused here, so fetching one buys a guaranteed
failure. Videos and stickers likewise.

⚠ **`mimeType` is what you CLAIM.** The pipeline re-derives the real type from the bytes and
refuses a mismatch, so lying to get past the allowlist fails one step later. Strip any
parameters Meta appends (`image/jpeg; codecs=...`) — the match is exact.

Refusals are `UPLOAD_POLICY_VIOLATION` (400 for an empty body or a type a chat may not send,
413 for oversize) and carry `details.violations[]`. As everywhere on this surface,
`error.customerMessage` is the sentence to relay.

### 17.3 · `tickets_add_attachment` — the model spends the reference

```jsonc
{ "ticketId": "664tkt...", "ref": "att_9Kf3xQ2mN8pL..." }
```

```jsonc
{
  "success": true,
  "data": {
    "id": "664att...",
    "fileName": "photo.jpg",
    "mimeType": "image/jpeg",
    "size": 184203,
    "kind": "image",
    "createdAt": "2026-09-07T09:12:44.101Z",
    "attachmentCount": 3,
    "attachmentLimit": 5
  }
}
```

⭐ **`attachmentCount` / `attachmentLimit` are on the SUCCESS response, and that is the point.**
Five is a hard per-ticket limit and the sixth attach is a 422. The moment a customer has just
succeeded is the last one at which telling them *"that is the fifth and last"* costs nothing;
finding out on the next photo costs them the photo.

#### The reference's three properties

| | |
|---|---|
| **Owned** | minted for one account; another account's reference is refused, not resolved |
| **Single-use** | one successful attach spends it |
| **Expiring** | 30 minutes |

A reference that is unknown, spent, stale **or somebody else's** answers the same
`404 BOT_INBOUND_FILE_EXPIRED` — deliberately one bucket, because distinguishing them would
tell a caller that a reference it does not own is real, and all four have the same remedy: the
customer sends the file again.

⚠ **A FAILED attach puts the reference back.** The attach fails for reasons that are the
customer's to fix and not the file's — the five-file limit above all — and burning the
reference there would turn *"that request already has five files"* into *"…and now send the
photo again"*, for a file sitting in storage, correct and unused. So a 422 or a 403 leaves the
reference live and a retry against a different ticket works.

### 17.4 · What your flow does, end to end

1. **Inbound media arrives.** Filter to the five types above; anything else keeps your existing
   *"the customer sent something I cannot read"* text.
2. **Fetch the bytes.** Telegram: `getFile`, then download. WhatsApp: `GET /v18.0/{media-id}`
   for a short-lived URL, then `GET` that URL — **with the same bearer token**, it is not
   public. Either way, base64 it.
3. **`POST /identity/sync`** as you already do on every message.
4. **`POST /files/inbound`** with the bytes.
5. **Tell the model** — the file's name, its `kind`, its `ref`, and that it **cannot see the
   contents**. The caption, if there was one, is the customer's own words and goes in as
   ordinary text.
6. The model decides. If the file is evidence for a support request it calls
   `tickets_create` (if needed) then `tickets_add_attachment` with that reference.

⚠ **Step 5's wording matters more than it looks.** Without an explicit "you cannot see this",
a model handed a filename will describe what it assumes is in the picture, and a customer is
then told their broken item looks fine. Say it in the turn and in the system prompt.

⚠ **On a refusal, relay `error.customerMessage`** rather than composing your own — § 11.4's
rule, and the reason `/files/inbound` returns a localised sentence at all.


## 18 · Account access — the one route whose result the caller may not read

`POST /api/internal/bot/auth/login-link` · tool `auth_send_login_link` · no arguments.

Sends the customer a magic link and an 8-character code — the same pair `/login` produces,
composed by the same `buildLoginReply`, spent the same way, dead in the same ten minutes.

**Every other route on this surface returns what it did. This one returns whether it did it.**

```jsonc
// 200
{ "success": true,
  "data": { "sent": true, "expiresInSeconds": 600, "expiresAt": "2026-09-08T02:45:00.000Z" },
  "message": "The sign-in link and code have been sent to this chat." }
```

There is no `token`, no `code`, no `link` and no `reply`. That is not an omission to work
around — it is the contract, and `test:bot-surface` § 19 fails if a credential field ever
appears here.

### When the send fails

`502 MESSAGING_DELIVERY_FAILED`, category `external_service`, with the usual
`error.customerMessage`. **`sent: true` is only ever returned for a message the channel
accepted.** The model must tell the customer it did not go through. It must not say it was
sent.

⚠ **Until 2026-09-21 that sentence was false on WhatsApp**, in both directions at once. The
recipient was the bare-digits `wa_phone_id`, which the messaging service refuses as
not-E.164, so **every** WhatsApp send failed before Meta was called. The refusal comes back
as `success: false` rather than a throw, and the WhatsApp branch never read it. So the route
answered `sent: true`, and the bot told customers a link was on its way that never existed.
`test:messaging-login` now drives both halves.

### Why it sends instead of returning

Every other credential entrance hands its `message` back and lets the automation layer relay
it. This one cannot, because **its caller is a language model**:

- The catalogue marks the row `never_relay: ["message"]` — the credential is never
  summarised, never stored and **never shown to the model**. A tool response is both: it
  lands in the model's context *and* in the `Chat Memory` Redis store.
- A model rewrites for tone. An eight-character code that has been "helpfully" reformatted is
  a code that arrives wrong, and the customer cannot tell why.

So jovi-mall puts the message in the chat itself, over the same Telegram/WhatsApp senders the
notification stack uses, and the tool answers only whether it went. Same division as
`open_negotiation`: the tool acts, the model acknowledges.

### What the model must be told

It has not been given a code and must never invent, guess or reformat one. `wi-mall-core`'s
system prompt carries this under **SIGNING IN ON THE WEBSITE**, including the sentence that
matters most — *this platform has no SMS one-time password and no "enter the code we sent
you" screen*. Without it the model cheerfully describes one; that is exactly what it did on
2026-09-08 before this landed.

### Where the slash command goes instead

`/login` typed as a command never reaches this route or the model. `wi-mall-core`'s
`detect command` branch posts it to `POST /api/webhooks/telegram/webhook` (or
`/api/webhooks/whatsapp` — ⚠ **the two paths differ**) and relays the `reply` those commands
now return. Two entrances, one `MessagingLoginService.mint`.

⚠ **`/reset-password` has NO tool here, deliberately.** A reset token stamps
`password_changed_at`, evicting every live session on the account, and it serves every role
rather than customers alone. It stays a slash command; `test:bot-surface` § 19 pins that.

### Rate limit

Five per messaging identity per hour (`USER_CREDENTIAL_LINK_THROTTLED`, 429). Lower than the
administrator path's three-per-party is *not* a contradiction — that caller is an operator
watching a dialog, this one is a model that can be talked into repeating itself. Remember
that **minting revokes the previous pair**, so an unbounded caller does not merely spam: it
invalidates the code the customer is halfway through typing.

The `Idempotency-Key` the generator emits is `{{ $execution.id }}-auth_send_login_link`, i.e.
one per turn — asking twice in a single turn sends one message; asking again in a later
message mints a fresh pair.


## 19 · ⭐ The in-app screens — when a chat bubble is the wrong shape

Three tools open a real screen instead of answering in the chat:
**`inapp_open_listing`**, **`inapp_open_product`**, **`inapp_open_stores`**.

### 19.1 · The rule that decides which to use

**Chat carries decisions; a screen carries display.** Five choices or fewer, a confirmation, a
yes/no — chat. Many items, many fields, or anything the customer needs to *compare* — a screen.

That is why `catalog_show_products` (five cards, in the chat) and `inapp_open_listing` (a
grid) both exist and are not alternatives: the first **answers a question**, the second
**opens a shelf**. A customer who asked "do you have red shoes in 42?" wants the first. One who
said "what else do you sell?" wants the second.

⚠ **`inapp_open_product` is the ONLY place a variant can be chosen.** A chat card carries the
product's *default* variant and nothing else — so a product with sizes or colours is
unbuyable from chat alone, and every card that offers one needs this door beside it.

### 19.2 · You send the `reply` and say nothing else

All three answer with a ready-made `reply` (§ 14). Send it unmodified and **do not also
describe the button in your own words** — the customer would get the sentence twice.

### 19.3 · What it renders to, per channel

| | |
|---|---|
| **Telegram** | a `web_app` button. The screen opens **inside** Telegram, and closing it returns the customer to this thread. |
| **WhatsApp** | a `cta_url` button to the storefront, until a Flow is published for that screen. |

⚠ **The WhatsApp half is genuinely different today, and this is deliberate sequencing rather
than an oversight.** A Mini App is a web page; a WhatsApp Flow is a *form* built from a fixed
set of components in Meta's Flow Builder, and a Flow that loads live data needs an encrypted
endpoint this platform has not built. So the screens are being proven on Telegram first and
ported after. Until then WhatsApp customers get the storefront — the same sentence, the same
label, a browser instead of an in-chat page.

⚠ **A Flow can never be opened outside the 24-hour service window**, so this will remain the
WhatsApp behaviour on any proactive turn even once Flows land.

### 19.4 · ⚠ It degrades to the storefront, and that is the path running today

`BOT_MINIAPP_BASE_URL` is **unset in production**, so there is no in-app origin and *every*
one of these calls currently answers with a storefront `link` instead of an in-app button. The
turn still works and the customer still reaches the right page.

Three states, and you branch on none of them — the `reply` is already correct:

1. a screen is configured → an in-app button;
2. no screen, but a storefront → a link button to the equivalent page;
3. neither → **no `reply` at all**, and the turn is yours to word. A button with an empty
   target is worse than no button, which is the rule `/payments/:id/pay-link` already follows.

### 19.5 · ⛔ The handle in the response is a CREDENTIAL

Each call returns a `handle`. **Never print it, never put it in a sentence, and never reuse one
from an earlier turn** — mint a new screen instead.

It is the *only* credential the screen has: a browser cannot hold `INTERNAL_SERVICE_TOKEN` or
`BOT_WEBHOOK_SECRET` without handing every viewer the whole bot surface. So the handle is
opaque, short-lived, and bound to one conversation — and it is checked by **kind** as well as
by owner, which means a listing handle cannot be replayed against a checkout screen.

⚠ The checkout screen's handle is shorter-lived than the rest and is **spent** by the write
that places the order, because that one can move money.

### 19.6 · Two screens answer with a link for now

The **order listing** and **store directory** screens are a later milestone. `inapp_open_stores`
already works — it answers with the storefront directory link — and will start returning an
in-app button when the screen lands, with **no contract change**. Nothing in your flow changes
on that day.

### 19.7 · One configuration fact that decides whether any of this is visible

⚠ **`BOT_MINIAPP_BASE_URL` must be `https://` and publicly reachable.** Telegram refuses a
`web_app` button on any other scheme and refuses **the whole message** with it — so the backend
checks the scheme and the host, and falls back to the storefront rather than sending a message
Telegram will drop. A Tailscale or loopback origin opens for nobody but the developer who set
it, and nothing on the backend's side reports that.

---

## Related

- [BACKEND-GAPS.md](./BACKEND-GAPS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) ·
  [COMMAND-SPECIFICATION.md](./COMMAND-SPECIFICATION.md)
- [tools/catalog.json](./tools/catalog.json) — the generated contract, pinned to the route table
