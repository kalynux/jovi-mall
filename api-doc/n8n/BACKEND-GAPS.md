# BACKEND GAPS — what must be built before the n8n customer agent can work

**Status:** specification, 2026-08-24. **GAP-001 and GAP-005 are BUILT (2026-08-25)**; GAP-002,
GAP-011, GAP-004, **GAP-012 and GAP-008** followed on 2026-08-26 — the
contract page is [bot-surface.md](./bot-surface.md) and the code is
`src/modules/bot-surface/`. **Four remain open: GAP-006, GAP-007, GAP-003 and GAP-009**, and
only the first two are anywhere near the critical path.
**Verified against:** the jovi-mall route table, `src/api/index.ts`, and the `api-doc/` tree, on 2026-08-24.

Twelve gaps. **GAP-001 is 44 of the 60 tools in the catalogue** and everything else is small by comparison. Nothing here invents a capability the platform lacks — every gap is a *door* onto behaviour that already exists and is already tested, except GAP-002, GAP-003 and GAP-008, which are new behaviour.

| # | Gap | Blocks | Size | Order | Status |
|---|---|---|---|---|---|
| [001](#gap-001) | The curated bot surface `/api/internal/bot/*` | 44 tools | **large** | 1 | ✅ **BUILT** 2026-08-25 |
| [002](#gap-002) | Customer registration on first contact | every new customer | medium | 2 | ✅ **BUILT** 2026-08-26 — **with two decisions reversed** |
| [011](#gap-011) | `BOT_WEBHOOK_SECRET` mandatory once registration exists | GAP-002's safety | **tiny** | 2 (same change) | ✅ **BUILT** 2026-08-26 |
| [005](#gap-005) | Geo candidate handles | the address flow | small | 3 | ✅ **BUILT** 2026-08-25 |
| [006](#gap-006) | Bot-surface rate limiting | every tool, at scale | small | 3 | open |
| [007](#gap-007) | Bot-surface audit trail | accountability | small | 3 | open |
| [004](#gap-004) | Support-context composite | `/support` quality | medium | 4 | ✅ **BUILT** 2026-08-26 |
| [003](#gap-003) | SKU → product resolution | `/product:<SKU>` | small | 5 | open |
| [012](#gap-012) | Proactive WhatsApp templates | async flow completion | medium | 5 | ✅ **BUILT** 2026-08-26 |
| [008](#gap-008) | Hosted card checkout page | card payment in chat | medium | 6 | ✅ **BUILT** 2026-08-26 — the BACKEND half |
| [009](#gap-009) | Meta Commerce catalogue sync | native product cards | large | optional | open |
| [010](#gap-010) | Customer delivery-region preference | `/region` | small | **only if wanted** | removed |

> ### What building GAP-001 changed about this document
>
> **42 tools, not 44.** The catalogue tags 42 tools `gap_ref: GAP-001`; the route table in
> `domain/bot-route-table.ts` carries those and whatever later gaps mount here too, and
> `test:bot-surface` pins every row the catalogue knows to what it says. The other two the
> prose counted are `/support/context` (GAP-004, **built 2026-08-26**) and `identity/register`
> (GAP-002, **built 2026-08-26** — as `identity/sync` + `identity/onboarding`).
>
> **GAP-005 came with it, and had to.** `addresses_add` takes a required `geoCandidateRef`,
> so `POST /addresses` could not be built as catalogued without the handle store.
>
> **Two things below turned out to be wrong, and are corrected in place** — the `readonly`
> maintenance rule needed its own branch (this surface's reads are POSTs), and the delivery-code
> strip had to cover both order reads rather than the group alone. Both are marked ⚠ CORRECTION.
>
> **Four defects were found while building, none caused by this work:**
> `RECOMMENDATION_CACHE_DB = 16` was above Redis's default database ceiling and its cache had
> never once run (**fixed** — it is now a prefix on `CACHE_DB`); `ticket_number` does not exist
> on any model despite three api-doc pages and the catalogue naming it; `api-doc/admin/dev-tools.md`'s
> flushable-database table listed two RETIRED databases and omitted five live ones
> (**regenerated**); and `redis.factory.ts` claimed nothing uses DB 0 while the calendar-sync
> lock does (**corrected**). See [bot-surface.md](./bot-surface.md) §7 and §10.

---

<a name="gap-001"></a>
## GAP-001 — The curated bot surface

✅ **BUILT 2026-08-25.** Contract: [bot-surface.md](./bot-surface.md). Code:
`src/modules/bot-surface/`. Verified by `npm run test:bot-surface` (132, no DB) and
`npm run verify:bot-surface` (74, NEEDS Mongo + Redis). **What follows is the plan as
written**, kept because the reasoning is the record — the ⚠ CORRECTION notes mark where it
was wrong.

**Route prefix:** `/api/internal/bot/*` · **Blocks:** 44 tools · **Design record:** [ARCHITECTURE.md §3](./ARCHITECTURE.md#3--identity--the-decision-everything-else-rests-on)

### The problem, precisely

There is no way for the automation layer to act as a customer. `/api/customer/*` needs a customer JWT. The internal service surface (`requireServiceToken`) covers `/internal/agents`, `/internal/shipments` and `/internal/admin` only. The four existing bot commands mint credentials for a *human to redeem in a browser* and deliberately do not return them as fields.

### What to build

A new route tree, mounted beside the existing internal ones, guarded by **two** credentials.

```
router.use('/internal/bot', requireServiceToken, requireBotWebhookSecret, botRateLimiter, botRoutes)
```

**Headers, on every call**

| Header | Purpose |
|---|---|
| `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` | The same value geo-tracker presents. Already exists |
| `X-Webhook-Secret: <BOT_WEBHOOK_SECRET>` | The same value the bot webhook requires. Already exists |
| `X-Request-Id` | Correlation, already supported platform-wide |
| `Idempotency-Key` | **New.** Required on every mutating route (below) |

⚠ **Two credentials, not one, and this is deliberate.** A leaked `INTERNAL_SERVICE_TOKEN` opens the agent and shipment surfaces today. It must not also open every customer's cart, orders and addresses. The two secrets are held by different parts of the deployment and rotate on different schedules.

**Body, on every call**

```jsonc
{
  "identity": { "channel": "whatsapp" | "telegram", "externalId": "…", "displayName": "…", "handle": "…" },
  // …the operation's own arguments
}
```

⚠ **`identity` is the only identity. There is no `customerId`, `userId` or token parameter on any route, ever.** This is the same rule `/connect` already enforces — the deleted `link` command let a caller name somebody else's number, and on `/login` a caller-supplied identity is outright account takeover. Extending the surface to carts and orders without carrying the rule forward extends the mistake to them.

### Resolution — reuse, do not reimplement

Call the existing `LoginIdentityResolver`. It already holds the ladder, the E.164 repair and the refusal table, and a second implementation would be a second opinion about the same fact.

```
resolveForBot(identity) → LoginIdentityResolver.resolve('login', channel, externalId)
   'resolved'       → proceed, scoped to account.customerId
   'needs_contact'  → 409 BOT_IDENTITY_NEEDS_CONTACT
   'no_account'     → 404 BOT_IDENTITY_UNRESOLVED
   'not_customer'   → 403 BOT_IDENTITY_NOT_CUSTOMER
   'account_inactive' → 403 AUTH_ACCOUNT_SUSPENDED
   'identity_taken' → 403 BOT_IDENTITY_NOT_CUSTOMER
```

⚠ `messagingPhoneToE164` is not optional. `wa_phone_id` arrives from Meta as **bare digits** (`237600123456`) while `login_phone` is stored as strict E.164 (`+237600123456`), and the shared helpers do not bridge that gap. A naive `findByPhone(wa_phone_id)` matches **nothing, for every user**, while looking perfectly implemented.

### The routes

Each one delegates to the **existing** customer service with a resolved `customerId`. No business logic is duplicated; only the door is new.

| Route | Delegates to |
|---|---|
| `POST /identity/resolve` | the resolver, plus a small projection |
| `POST /cart/get` · `POST /cart/items` · `PATCH /cart/items/:variantId` · `DELETE /cart/items/:variantId` · `DELETE /cart` · `POST /cart/quote` | `CartService` |
| `POST /checkout` | `OrderService.checkout` |
| `POST /orders/list` · `POST /orders/:orderId` · `POST /orders/groups/:cartId` · `POST /orders/:orderId/shipments` | `OrderService` |
| `POST /orders/:orderId/cod-code` · `POST /orders/:o/shipments/:s/resend-delivery-code` · `POST /orders/:o/shipments/:s/confirm-delivery` · `POST /orders/:orderId/cancel` | `OrderService`, `CashCollectionService` |
| `POST /profile` · `PATCH /profile/language` · `POST /addresses/list` · `POST /addresses` · `PATCH /addresses/:id/default` | `CustomerProfileService` |
| `POST /geo/search` · `POST /geo/reverse` | `GeocodingService` (see GAP-005) |
| `POST /tickets/list` · `POST /tickets/:id` · `POST /tickets` · `POST /tickets/:id/notes` · `POST /tickets/:id/close` | `TicketService` |
| `POST /wishlist/list` · `POST /wishlist` · `DELETE /wishlist/:productId` · `POST /recently-viewed` | `CustomerCatalogService` |
| `POST /digital/my-products` · `POST /digital/download-links` | `DigitalDeliveryService` |
| `POST /bookings/list` · `POST /bookings/:id` · `POST /bookings/:id/cancel` | `BookingService` |
| `POST /reviews/eligibility` · `POST /reviews` | `ReviewService` |
| `POST /notifications/preferences` · `PATCH /notifications/preferences` | `CustomerNotificationService` |
| `POST /payments/:transactionId` | `PaymentService`, owner-scoped |
| `POST /support/context` | GAP-004 — `SupportContextService`, over the order, store, magazin, shipment and recently-viewed reads |

**Why `POST` on reads.** The identity envelope is a body, and putting a messaging identifier in a query string writes it into every access log on the path. `GET` is kept only where there is no identity to carry — and on this surface there is always one.

### Idempotency — required, not optional

`Idempotency-Key` on every mutating route, stored against `(key, route, identityHash)` with the response, TTL 24 hours. A repeat returns the stored response.

⚠ **`POST /checkout` is the one that must not ship without it.** It is not idempotent today — a retried call creates a **second set of orders and a second stock hold**. Chat transports retry: the automation layer retries, the network retries, and the customer taps twice. `POST /cart/items` has the same shape in miniature, silently doubling a line.

### Projections that differ from the customer API

Three, and each exists for a reason a chat window makes specific:

| Route | Difference | Why |
|---|---|---|
| `POST /profile` | `email` and `phone` are **masked**; `savedAddresses` becomes `savedAddressCount` | A chat window is shared, screenshotted and shoulder-surfed, and the customer already knows their own number |
| `POST /addresses/list` | adds `deliverable: boolean`; omits raw `coordinates` | `deliverable` is "has a geocoded location" — the single fact the checkout flow needs, computed once rather than inferred by the caller |
| `POST /orders/groups/:cartId` | `codCollections[].deliveryCode` is **stripped** | It is present on the customer API and must never reach the model incidentally. Disclosure happens only through `/orders/:id/cod-code` |

⚠ **CORRECTION (built 2026-08-25): the strip covers BOTH order reads, not the group alone.**
`POST /orders/:orderId` is built by the same `customerOrderViewService.toDtos`, so stripping
only the group would have left the field on every "where is my order?" and made the group's
strip pointless. The rule this table states — *it must never reach the model incidentally* —
is what decided it.

### New error codes

`BOT_IDENTITY_UNRESOLVED` (404) · `BOT_IDENTITY_NEEDS_CONTACT` (409) · `BOT_IDENTITY_NOT_CUSTOMER` (403) · `BOT_GEO_CANDIDATE_EXPIRED` (400) · `BOT_SUPPORT_NO_CONTEXT` (404) · `BOT_SUPPORT_SCOPE_UNAVAILABLE` (409) · `BOT_REGISTRATION_IDENTITY_TAKEN` (409) · `BOT_REGISTRATION_CONSENT_INVALID` (400) · `BOT_REGISTRATION_RATE_LIMITED` (429).

⚠ Run the `ERROR_CODES` census before adding these — a concurrent session may be editing the same registry, and a read-modify-write clobbers it silently.

✅ **Built:** the four this change needed (`BOT_IDENTITY_*` ×3, `BOT_GEO_CANDIDATE_EXPIRED`),
plus **four the list did not anticipate** — idempotency needs its own vocabulary:
`BOT_IDEMPOTENCY_KEY_REQUIRED` (400) · `BOT_IDEMPOTENCY_IN_PROGRESS` (409) ·
`BOT_IDEMPOTENCY_KEY_REUSED` (409) · `BOT_IDEMPOTENCY_STORE_UNAVAILABLE` (503).

⚠ **The census earned its keep on the last of those.** In-progress and store-unavailable were
one code at two statuses to begin with, which derives two different categories
(`conflict` / `external_service`) — `test:errors` refuses that, and it was right to: telling a
caller "another call is in flight" when Redis is simply down would have them retry on the wrong
cadence, waiting for a race that is not happening.

The four `BOT_SUPPORT_*` / `BOT_REGISTRATION_*` codes are **not** built — they belong to
GAP-004 and GAP-002. `account_inactive` reuses the platform-wide `AUTH_ACCOUNT_SUSPENDED`
rather than getting a `BOT_*` alias: a suspended account is a fact about the account, not about
this door.

### Maintenance mode

`/api/internal/bot/*` should be **blocked** in `down` and **read-only** in `readonly`, like the ordinary customer surface. It must **not** join the cross-service exemption list: `/api/internal/agents/*`, `/api/tracking/*` and `/api/internal/shipments/*` are exempt because geo-tracker's authorization depends on them and blocking them turns a jovi-mall maintenance window into a geo-tracker outage. A chat bot has no such property — a customer told "we are briefly down for maintenance" is correctly served.

⚠ **CORRECTION (built 2026-08-25): "read-only in `readonly`" needed its own branch.** The
existing rule allows `GET`/`HEAD`/`OPTIONS` in a read-only window — and **every read on this
surface is a POST**, because the identity envelope is a body. So the ordinary rule refuses all
of them, and a window meant to leave reads working would have answered 503 to "where is my
order?". `maintenance-mode.ts` now consults the bot route table's `mutating` column, so the
maintenance verdict and the route that would actually run cannot disagree. An unrecognised bot
path fails closed. The exemption-list half of this paragraph is unchanged and correct.

### What this is not

**Not a generic proxy.** A route that forwarded arbitrary paths would make whatever the customer API grows next reachable from a chat window with no decision taken. Every route above was chosen.

**Not a session mint.** No customer bearer token is ever issued to the automation layer.

---

<a name="gap-002"></a>
## GAP-002 — Customer registration on first contact

✅ **BUILT 2026-08-26 — but read the box below before trusting anything under it.** Contract:
[bot-surface.md § 11](./bot-surface.md). Code: `src/modules/bot-surface/services/bot-registration.service.ts`
+ `domain/bot-onboarding.ts`. Verified by `npm run verify:bot-registration` (62, NEEDS Mongo
+ Redis). **What follows is the plan as written**, kept because the reasoning is the record.

> ### ⛔ THREE THINGS BELOW ARE NO LONGER TRUE
>
> **The routes are different.** There is no `POST /identity/register` and no
> `consentToken`. What was built is `POST /identity/sync` — called on **every** inbound
> message, upserting the account — plus `POST /identity/onboarding`, which collects the
> profile one step at a time. The pending-intent store gained **no** `register` value: the
> contact share posts to the onboarding route directly, so the n8n mapping is a new call
> rather than a third meaning for `login_contact`.
>
> **D-2 is REVERSED — there is no consent step.** The product owner's decision (2026-08-26)
> is that the account is created silently on the first message. The argument in D-2 is
> unchanged and correct and was accepted as a **cost**, not settled.
>
> **D-3 is REVERSED — a business account IS upgraded.** Every inbound chat is treated as a
> customer conversation, so a vendor, agency or agent acquires a customer role and profile
> rather than keeping the `not_customer` refusal. ⚠ Consequence outside this feature: once
> that role exists, the bot `/login` command will mint them a **customer session** where it
> used to refuse.
>
> **D-1, D-4 and D-5 were implemented as written.** The identity ladder is reused (as a
> third `register` intent on `LoginIdentityResolver`, exactly as ARCHITECTURE §3.2
> specifies), the password is system-generated and disclosed to nobody, and the language is
> seeded honestly from `from.language_code`.
>
> **Two things this section does not mention were built with it**, because the automation
> layer cannot work without them: an **onboarding checklist stored on the Customer**, so a
> skipped field is never asked for twice, and **`error.customerMessage`** — a localised
> sentence on every bot-surface error, safe to relay verbatim, because n8n has no copy
> table and no translator. Both are documented in bot-surface.md § 11.
>
> **The abuse bounds below are NOT built.** 3/hour per identity and 10/hour per address
> were part of D-2's safety case, and the consent step they were paired with is gone. What
> stands in front of this surface today is the two credentials and GAP-011's
> boot-required webhook secret. GAP-006 is still open and is where this belongs.

**Routes:** ~~`POST /api/internal/bot/identity/register`~~ → `POST /api/internal/bot/identity/sync` + `POST /api/internal/bot/identity/onboarding`
**Blocks:** every new customer. Until this lands, the entire command system is unreachable for anyone without an account.

### Why this is urgent rather than tidy

`auth/customer-auth.md` states that a customer account is created on first interaction with the bot, and that this is "bot-side backend work, landing with the n8n integration". `magic-login.md` calls the current refusal copy "transitional". **Nothing implements it.** An unknown number is told to create an account on the website — where there is no registration form and none is coming, because the storefront was deliberately built without one.

So today a new customer has no route in at all, from either direction.

### The flow

**WhatsApp** — the sender id *is* the phone number:

```
unknown sender sends anything
  → identity_resolve_sender → { state: 'anonymous', reason: 'no_account' }
  → "Would you like me to create an account?"            ← EXPLICIT consent
  → yes → POST /identity/register { consentToken, displayName?, language? }
  → one transaction:
      User { roles: ['customer'], login_phone: <E.164>, password: <system-generated> }
      Customer profile
      channel_connections(whatsapp, wa_phone_id)
```

**Telegram** — a `chat_id` maps to no phone number:

```
unknown sender sends anything
  → { state: 'needs_contact' }
  → request_contact keyboard: "Share my phone number"
  → PENDING INTENT recorded: 'register'          ← the third value, same store
  → contact arrives → posted as command `login_contact`   (mapping UNCHANGED)
  → contact.user_id === sender?                  ← the security of the whole flow
  → intent says 'register' → consent → create
```

### Five design decisions

**1 · Reuse the pending-intent store.** It already exists and already selects between `login` and `reset` when a Telegram contact arrives carrying nothing about which command asked. `register` is a third value in the same mechanism. **The n8n mapping does not change** — keep posting `login_contact` for any inbound contact; the platform decides what it completes.

**2 · Consent is explicit.** The documentation implies silent creation on first contact. Creating an account is a durable act with a data-protection footprint, and a person who messaged a shop to ask a price did not ask for one. The consent token is single-use, which is also what makes registration idempotent under retry.

**3 · A business account is never upgraded.** Registration fires only when there is **no account at all**. An existing vendor, agency or agent keeps the `not_customer` refusal — a customer role is never auto-provisioned, and that rule is not this feature's to relax.

**4 · The password rule is unchanged.** `RegisterSchema` strips a supplied password for `role: 'customer'` and mints a random one hashed and disclosed to nobody. Registration here does the same thing by the same code path.

**5 · Seed the language honestly.** Telegram carries `from.language_code`; WhatsApp carries nothing. Map into `en · fr · pt · es · ar` when it matches, default to the platform bias otherwise, and let `/language` correct it.

### Abuse bounds

3 registrations/hour per messaging identity, 10/hour per source address, plus the consent step. Registration mints accounts from a webhook, so it needs both axes: accounts are free to create, so an identity-scoped limit alone bounds nothing.

### Copy that changes when this lands

`LOGIN_REFUSALS.no_account` — currently *"I don't recognise this number. Create an account on the website first…"* — becomes the registration offer. Nothing on the frontend depends on it: the reply is relayed verbatim and no `/auth/magic/*` response shape is involved.

### Depends on

**GAP-011, in the same change.** Neither is safe without the other.

---

<a name="gap-011"></a>
## GAP-011 — `BOT_WEBHOOK_SECRET` must become mandatory

✅ **BUILT 2026-08-26, with GAP-002 as specified. Resolution 1 was taken: it is REQUIRED IN
EVERY ENVIRONMENT**, the `NODE_ENV === 'production'` condition is gone, and
`assertBotWebhookSecretConfigured()` refuses the boot beside `assertSigningSecrets()`.

Resolution 2 — require it only when a registration-capable command is registered — was
declined for the reason it would have been chosen: it makes the guard's strength depend on a
route table somebody may extend without noticing, which is the exact class of mistake the
guard exists to prevent. It saves one line in `.env`.

⚠ **The middleware failing closed is what makes the door safe; the boot assertion is what
makes a misconfiguration findable.** Without it a misconfigured instance comes up healthy,
passes its readiness probe, and answers `401` to every inbound message with the only symptom
being a log line nobody is watching.

**Change:** one condition in `bot-webhook.middleware.ts` · **Size:** tiny · **Ships with:** GAP-002

Today an unset `BOT_WEBHOOK_SECRET` is **refused in production and open in development**. That was already load-bearing: an open webhook lets anybody mint a connection code against a stranger's number, read it from the response, and attach that number to their own account.

⚠ **Once registration is dispatchable, an open webhook lets anybody create accounts against strangers' numbers, at scale, from a laptop.** The development exemption stops being a convenience and becomes a way to poison the user table of any environment that shares a database with anything.

Two acceptable resolutions:

1. **Require it everywhere.** Simplest, and the development cost is one line in `.env`.
2. **Require it whenever a registration-capable command is registered.** Keeps the local convenience for the read-only case and refuses to boot a registration-capable service without a secret.

Either way the secret must be present before `identity/register` is reachable. Pin it with a boot assertion beside `assertSigningSecrets()`, which already does exactly this shape of check for the signing secrets.

---

<a name="gap-005"></a>
## GAP-005 — Geo candidate handles

✅ **BUILT 2026-08-25, with GAP-001 rather than after it.** `addresses_add` takes a *required*
`geoCandidateRef`, so `POST /addresses` could not be built as catalogued without this. Store:
`src/modules/bot-surface/services/geo-candidate.store.ts`; contract:
[bot-surface.md §5](./bot-surface.md). Everything below was implemented as written.

**Routes:** the `/geo/*` pair on the bot surface · **Blocks:** the address flow

`GET /api/geo/search` returns candidates; `POST /api/customer/addresses` takes a `geo` object. Between them the *caller* holds coordinates and sends them back. That is fine for a browser and wrong for a chat bot, for two reasons.

**One.** The bot is a machine relaying between a person and an API. If it can construct a `geo` object, it can construct a wrong one, and an address that looks right and points somewhere else is a delivery to the wrong street.

**Two, and this is the sharp one.** A `null` inside the 2dsphere-indexed address array makes the **whole customer document unwritable** — measured, and not fixed by a sparse or partial index; the key must be *omitted*. A caller assembling a `geo` object will eventually send a null, and the failure will present as "this customer cannot be edited at all".

### What to build

`POST /geo/search` and `POST /geo/reverse` return, alongside each candidate, a **`candidateRef`**: an opaque single-use handle stored server-side (Redis, TTL = the flow window, 30 minutes) against the full candidate. `POST /addresses` takes `candidateRef` and never coordinates.

```
geo_search_address → [ { candidateRef: "gc_a3f…", formattedAddress: "…", components: {…} } ]
addresses_add      → { label: "Home", candidateRef: "gc_a3f…", addressLine2: "blue gate…" }
```

Three properties fall out for free: it is structurally impossible to save an ungeocoded address; the backend never receives a null coordinate to write; and the single-use handle makes the save idempotent under retry.

`BOT_GEO_CANDIDATE_EXPIRED` (400) when the handle is unknown or stale → re-run the search, never re-send held coordinates.

---

<a name="gap-006"></a>
## GAP-006 — Bot-surface rate limiting

**Blocks:** every tool, once there is more than one conversation

⚠ **The automation layer is a single IP for every customer.** jovi-mall's Layer A is IP-scoped at 1200/min, so one busy hour puts every customer behind one counter — and one looping conversation exhausts the bucket for everyone.

Two changes, and they go together:

1. **Add the bot surface to the internal-caller exemption** for Layers A and B. Internal callers resolved from `INTERNAL_SERVICE_TOKEN` already are; this route tree simply joins them.
2. **Add a per-messaging-identity limiter at the bot surface**, keyed on `hash(channel + externalId)`, at roughly the customer identity ceiling (600/min) so a chat conversation is bounded exactly as a browser session is.

⚠ **The credential bucket stays unexempt**, and that is not negotiable: nothing internal signs in, so an exemption there would only be usable by something that had already stolen the token.

Registration and code-resend carry their own tighter bounds (GAP-002, and the existing 1-per-60s server-side).

⚠ **GAP-012 raised the stakes here, and this section predates it.** `messaging_notify_customer`
is the first route on the surface whose side effect **reaches a person and costs money** — a
paid template conversation, outside the service window. `Idempotency-Key` bounds a *retry* and
not a *loop*: a new key mints a new pay-link token and therefore a new notification key, so each
pass sends. GAP-002's unbuilt bounds are not the only ones owed here any more.

---

<a name="gap-007"></a>
## GAP-007 — Bot-surface audit trail

**Blocks:** accountability for every mutation

Every mutating call on the bot surface writes one row:

```
channel · hash(externalId) · resolvedUserId · tool · hash(args) · outcome · requestId · at
```

⚠ **The raw messaging identifier is hashed at rest.** `GET /api/me/connections` deliberately returns no phone number and no chat id — `identityHint` (`••••1234`, `@handle`) is the only form that leaves the backend. The audit trail should not become the first place a raw identifier is stored in the clear.

The reason this is its own gap rather than a line in GAP-001: actions taken *on a person's behalf by a machine reading their messages* are a category the platform has not had before. Every existing mutation is attributable to a session a human opened. These are attributable to a webhook, and the trail is the only thing that makes them reviewable.

Not a new subsystem — the existing audit machinery is the model. Retention should match whatever the surrounding audit rows carry.

---

<a name="gap-004"></a>
## GAP-004 — Support-context composite

✅ **BUILT 2026-08-26.** Contract: [bot-surface.md § 12](./bot-surface.md#12--support-routing-gap-004).
Code: `src/modules/bot-surface/services/support-context.service.ts`. Verified by
`npm run test:bot-surface` (§9, 20 assertions, no DB) and `npm run verify:bot-surface`
(§9, 10 assertions, NEEDS Mongo + Redis).

> **Three things below were decided while building, and the spec did not settle them.**
>
> ⚠ **The two refusals below and ladder rung 5 contradicted each other, and rung 5 won.**
> The error table promises `BOT_SUPPORT_NO_CONTEXT` when there is "nothing recent to route
> from"; the ladder's last rung says *nothing → platform only*. Both are now true, on
> different requests: `scope: "auto"` and `"platform"` take the rung (200, `resolvedFrom:
> "none"`), and only a **named party scope** can raise either refusal — which is the request
> that genuinely cannot be answered. A customer who says "I need help" having never ordered
> is offered a ticket, not told nothing was found.
>
> ⚠ **The delivery company is read from the order's SHIPMENTS**, not from
> `items[].delivery.agency_id`. Both were available; the item carries an agency from
> checkout onward, but `GET /api/customer/orders/:orderId/shipments` — the source this
> document names — is the only place the platform has ever disclosed which agency carries a
> parcel. Reading the item would have made this the first door to name one the customer has
> not been told about, and one reassignment can still change. It is also what makes the
> catalogue's own sentence literally true.
>
> ⚠ **A hint that does not resolve is refused, never fallen through** —
> `404 ORDER_NOT_FOUND` / `404 CATALOG_PRODUCT_NOT_FOUND`. Falling back to the recency
> ladder would answer confidently about a *different* purchase, which is exactly what
> `must_echo` exists to prevent.
>
> **`hintOrderId` accepts an order NUMBER as well as an id** (as `orders_get_order` does — a
> chat quotes "ORD-2026-000123"), and **wins over `hintProductId`** when both are sent.

**Route:** `POST /api/internal/bot/support/context` · **Blocks:** `/support` quality, not `/support` itself

`/support` must answer "who should you be talking to" from the customer's most recent interaction. Every input already exists:

| Party | Source, today |
|---|---|
| Seller | `store.supportEmail / supportPhone / supportWhatsapp` on `GET /api/public/stores/:slug` |
| Delivery company | `agency.supportPhone / supportEmail / supportWhatsapp` on `GET /api/customer/orders/:orderId/shipments` |
| Platform | `POST /api/customer/tickets` |
| Recency | `GET /api/customer/orders`, `GET /api/customer/recently-viewed`, `profile.recentProductCode` |

So this is composable client-side — in **three round-trips, with the ladder implemented in n8n**, which is three chances to route wrongly and a copy of a policy that belongs in the backend.

### What to build

One route walking the ladder server-side and returning all three parties with `resolvedFrom` and a human-readable `subject.label`:

```
1. hintProductId / hintOrderId from the conversation, when supplied
2. most recent order → its store, and its shipments' agency
3. most recent recently-viewed product → its store
4. profile.recentProductCode → product → store
5. nothing → platform only
```

⚠ **An agency attaches to a shipment, not to a product.** `scope: "agency"` against a product-only context has genuinely nothing to answer with — that is `BOT_SUPPORT_SCOPE_UNAVAILABLE` (409), a legitimate empty answer, not an error.

⚠ **`resolvedFrom` and `subject.label` are part of the contract**, not diagnostics. `/support` must name what it routed from — a support contact for the wrong purchase is worse than asking which one.

**Not a blocker.** The flow composes it from the three calls until this lands. It is on the list because the composed version puts a routing policy in n8n, and policy in the automation layer is the thing this whole architecture is trying to avoid.

---

<a name="gap-003"></a>
## GAP-003 — SKU → product resolution

✅ **BUILT 2026-08-26.** Contract: [../public/catalog.md](../public/catalog.md#get-apipublicvariantsby-skusku).
Code: `catalog/domain/services/sku-resolution.ts` (the pure rules) +
`PublicCatalogRepositoryMongo.findPublishableVariantsBySku`. Verified by
`npm run test:public-catalog` (§7, 13 assertions, no DB) and `npm run verify:storefront`
(§3b + 2 visibility assertions, NEEDS Mongo).

> **Two things the spec did not settle.**
>
> **Case is forgiven, but only two ways.** A SKU is a case-sensitive unique index and a
> customer is typing off a package into a keyboard that capitalises, so the as-typed,
> uppercase and lowercase spellings are tried together in **one indexed `$in`** — and the
> as-typed one wins if more than one exists (`abc` and `ABC` really can both be SKUs). ⚠ **A
> SKU stored in MIXED case still resolves only when typed exactly**, and that is the accepted
> cost: a genuinely case-insensitive match cannot use the unique index, so every mistyped
> code on an unauthenticated route would become a collection scan.
>
> **It answers a resolution, not a card.** A SKU names one variant, usually not the default
> one a product card quotes — so the response carries the *variant's* price and stock plus the
> ids to fetch the product with. Returning a card would quote the wrong price to exactly the
> customer who typed a precise code.

**Route:** `GET /api/public/variants/by-sku/:sku` · **Blocks:** `/product:<SKU>`, `/add-to-cart:<SKU>`, `/buy:<SKU>`

The original command proposal is built on SKU (`/product:<SKU>`, `/add-to-cart:<SKU>`). **There is no endpoint that resolves one.** `GET /api/public/products?q=` is a MongoDB `$text` search over title, tags and description — it does not index SKU and will not match one.

SKU is nevertheless the right handle: `catalog.md` states it is already globally unique, it is already published per variant, and it is already shown to the customer on cart and order lines. It is what is printed on a package or an advertisement.

### What to build

A public read returning the product and the specific variant:

```jsonc
GET /api/public/variants/by-sku/DRESS-WAX-M
{ "success": true, "data": {
    "productId": "…", "variantId": "…", "sku": "DRESS-WAX-M",
    "title": "Ankara Wax Print Maxi Dress", "variantName": "Size: M",
    "price": 24000, "currency": "XAF", "inStock": true,
    "store": { "slug": "maison-bella", "name": "Maison Bella" } } }
```

Same publishable predicate as the rest of `/api/public/*`, and the same **404-never-403** rule: a non-public product must not be confirmed to exist.

~~**Interim, until it lands.** A bare SKU falls back to a text search, and the reply says it was *searched for* rather than *looked up*.~~ **Retired** — the tool exists. Keep the text-search fallback for the case the route now answers honestly: a `404` means the code resolves to nothing public, and searching for it as words is a reasonable second move.

**Priority note.** In practice the bot rarely needs this: cards carry interactive buttons whose payloads hold ids, so the customer seldom types an identifier at all. It matters for codes that arrive from outside the conversation.

---

<a name="gap-012"></a>
## GAP-012 — Proactive WhatsApp templates for bot-initiated messages

✅ **BUILT 2026-08-26.** Contract: [bot-surface.md § 13](./bot-surface.md#13--proactive-messaging-and-the-card-page-gap-012--gap-008)
and [notifications/whatsapp-templates.md § 13](../notifications/whatsapp-templates.md).
Verified by `npm run test:bot-surface` (§10), `npm run test:customer-notifications` and
`npm run verify:bot-surface` (§11, NEEDS Mongo + Redis).

> ### ⛔ THE GAP WAS NOT WHERE THIS SECTION SAYS IT WAS
>
> Everything below is true and none of it was the blocker. The window/template split has
> been implemented correctly since the customer notification stack shipped —
> `customer-notification-event-handler.service.ts` branches on
> `WhatsappService.canSendFreeMessage` and sends the approved template outside the window,
> exactly as this section describes. **Three other things were actually wrong:**
>
> **1 · A bot-registered customer had NO channel enabled, so no proactive message reached
> them at all.** `emailEnabled`, `telegramEnabled` and `whatsappEnabled` all default to
> `false` on `customer_notification_preferences`, and GAP-002's registration seeded none of
> them. Every template named here was registered, addressed and structurally undeliverable
> for exactly the population GAP-002 exists to create. Registration now seeds the channel
> the sender arrived on (product owner: arriving on a channel *is* the choice), for **new**
> profiles only.
>
> **2 · "A ticket gets an answer next week" had no notification of any kind.** `ticket.*`
> events were published from the day the tickets module shipped and **nothing subscribed** —
> two of the 32 event names that collapse to `event_type="unhandled"`. Three situations now
> exist: `ticket.replied`, `ticket.awaiting_customer`, `ticket.resolved`, each with a
> template in five languages. Five of the eight ticket statuses stay silent.
>
> **3 · None of the eighteen `customer_*` templates were DOCUMENTED**, which is the same
> thing as not existing — this section's own warning says an unapproved template fails on
> send, and one nobody wrote down never gets approved. All twenty-two are now in
> `whatsapp-templates.md § 13`, rendered from the catalog, and
> `test:customer-notifications` fails if a situation is added without approval copy.
>
> ⚠ **That documentation pass surfaced a further defect, and it is NOT fixed.** Five
> templates' `bodyParams` do not cover their own copy — the missing placeholder sits
> mid-sentence, so the approved body cannot say what the in-window sentence says.
> `booking.reminder`, `booking.payment.received`, `booking.balance.due`, `order.created`,
> `order.payment.received`. `booking.balance.due` was the worst: stripped, it claims
> something untrue about the money. Each carries a hand-written body and a **⚠ Rewritten,
> not derived** note. The honest fix is to widen those five `bodyParams`, which is a
> Business Manager operation and was deliberately not done blind from here.
>
> **What n8n gained**, since the platform sends everything above on its own:
> `messaging_get_window` (may I still speak in my own words, and until when) and
> `messaging_notify_customer` (a closed set of situations to hand off). The set has **one**
> member — `order.payment_link`, GAP-008's hand-off — because everything else proactive is a
> consequence of something the platform did and the platform raises it itself.

**Blocks:** any flow that finishes after the customer stops writing

⚠ **WhatsApp permits a free-form message only inside a 24-hour service window** opened by the customer's own message. Outside it, only pre-approved templates send. **Telegram has no equivalent**, so this asymmetry is real and must not be designed around as if it were symmetrical.

Where it bites:

| Situation | Inside 24h? |
|---|---|
| Payment settles minutes after the prompt | ✅ yes — the common case |
| Customer approves a mobile-money prompt an hour later | ✅ yes |
| Order ships two days later | ❌ **template needed** |
| A parcel goes out for delivery | ❌ **template needed** |
| A ticket gets an answer next week | ❌ **template needed** |

The `customer_*` templates already registered for the COD delivery code are the pattern: registered in `template-registry.ts`, approved in Business Manager, five languages, `UTILITY` category, one dynamic URL button.

⚠ **A template registered in code but not approved in Business Manager still fails on send.** Approval is a Meta-side step, and until it happens the send is recorded on `deliveryErrors` and nothing reaches the customer.

**Design consequence for the flows.** Where a WhatsApp flow may finish outside the window, it either completes inside it or ends with "we will message you" plus a template. Do not build a flow that silently waits for a message it cannot send.

---

<a name="gap-008"></a>
## GAP-008 — Hosted card checkout page

✅ **THE BACKEND HALF IS BUILT, 2026-08-26. The page itself is frontend work and is not in
this repository** — which is what option 1 below correctly says, and is why this closes as
"the door is open" rather than "the flow works end to end". Contract:
[payments/README.md § The hosted card page](../payments/README.md#the-hosted-card-page-gap-008)
and [bot-surface.md § 13.4](./bot-surface.md). Code: `payments/domain/pay-link.ts` +
`payments/services/pay-link.service.ts`. Verified by `npm run test:payments` (§9, 22
assertions, no DB) and `npm run verify:bot-surface` (§10, NEEDS Mongo + Redis).

> ### What was built, and the three decisions the section below does not settle
>
> **Option 1 was taken — and since 2026-09-07 the page exists too.** This paragraph read
> *"minus the page"* until then, which was true when written and had become the kind of
> stale claim that costs somebody an afternoon: `payment_create_pay_link` was described as
> handing out a link to nothing. The storefront built `/pay/:token` (top level, no session,
> a real Stripe Payment Element); the cross-repository record is
> `api-doc/notifications/storefront-routes.md` § 3.
>
> `GET /api/payments/session/:token` serves what that page needs — amount, currency, the
> charged USD figure, `clientSecret`, `publishableKey`, a `state`, and (added at the
> storefront's request, same day) `paidFor`: what the money is actually for, in the only
> terms safe to hand a stranger. `POST /payments/:transactionId/pay-link` mints the handle;
> the bot reaches the same operation as `payment_create_pay_link`.
>
> **1 · It takes an opaque HANDLE, not the transaction id.** The obvious move — opening
> `GET /payments/:transactionId` up — was declined on that route's own written argument:
> transaction ids are the only thing between one customer and another's payment record, so an
> unauthenticated read on them is a record any caller can walk by incrementing. The handle is
> 256 bits, expires (`PAYMENT_LINK_TTL_MINUTES`, default 30, matched to the checkout stock
> hold), and is revoked by the next mint.
>
> **2 · It lives on the transaction, not in Redis** — unlike every other opaque handle in
> this service. A payment link sits in a chat window and has to survive a deploy, a Redis
> restart and an operator's **cache flush**; the Redis index budget (5–15) is full besides,
> and `merchantRef` is the same shape of thing on the same model. Revocation is not lost: the
> read re-derives its verdict from the transaction's live status every time, so a paid,
> failed or cancelled payment stops handing out a client secret whatever its link says.
>
> **3 · `STRIPE_PUBLISHABLE_KEY` did not exist anywhere in this repository**, and
> `.env.example` said in as many words that nothing read it and it belonged in the
> frontend's environment. It is read now, served to the page, and a value starting `sk_`
> or `rk_` is **refused and logged** rather than published — the one misconfiguration here
> whose blast radius is the whole merchant account.
>
> **Not built, and correctly so:** `initiate` does **not** auto-mint a link. Minting is one
> call, and a credential minted for every browser checkout that will never use it is surface
> for nothing. No response shape changed.

**Blocks:** card payment completing in chat

`POST /api/payments/initiate` with `gateway: "STRIPE"` returns `instructions.clientSecret`, which must be confirmed with Stripe.js in a browser. **There is no page that does it.** The storefront has a checkout; there is no standalone page reachable from a chat link.

Two options:

1. **A storefront route** — `{STOREFRONT_URL}/pay/{transactionId}` that reads the transaction, mounts the Payment Element, confirms and shows the result. Frontend work, not backend, and the frontend is user-owned.
2. **Accept the handoff to the ordinary checkout** — the bot sends a magic link to the site and the customer finishes there. **This is what the design does today**, and it is not obviously worse: a card is typed on a keyboard either way.

Only worth building if card volume justifies it. Mobile money completes fully in chat and is the dominant local method.

---

<a name="gap-009"></a>
## GAP-009 — Meta Commerce catalogue sync

**Blocks:** native WhatsApp `product` and `product_list` messages · **Optional**

The WhatsApp module already implements `product` and `product_list` message types. Both require a **Meta Commerce catalogue** with the products in it, referenced by a retailer id. Nothing syncs jovi-mall's catalogue to one.

This is a genuine piece of work — a feed, a sync job, an id mapping, and a decision about which products belong in it — for a rendering improvement. **Image plus caption plus buttons is a perfectly good product card**, and it is what the design specifies. Listed so nobody discovers the two handlers and assumes they work.

---

<a name="gap-010"></a>
## GAP-010 — Customer delivery-region preference

**Blocks:** `/region` · **Only if the command is wanted**

The original proposal includes `/region` and `/region:<region>`. **There is no region concept on a customer anywhere in the backend.** What exists: `country` per saved address (defaulting to `CM`), `state` as a free-text line on an address, `preferences.currency`, and `GEO_DEFAULT_COUNTRY_CODES` as a server-side search bias. A country is set-once on *vendor and agency* profiles; a customer has no equivalent.

So `/region` would be a setting that changes nothing. It is **removed** from the command set rather than shipped as a no-op.

If a delivery-region preference is genuinely wanted, it is a new field, a new decision about what it affects (search bias? address defaults? which agencies appear?), and a migration — and per the standing pre-production rule, that means fixing the seed rather than writing a backfill.

---

## Not gaps — pre-existing, and flagged rather than fixed

| Thing | Status |
|---|---|
| **No session revocation for passwordless customers** | `password_changed_at` is this service's only revocation lever, and a customer who never reset has never set it. A stolen customer session has no revocation path. **This design deliberately does not mint customer sessions**, so it neither depends on nor worsens it — but it is the reason the bot-minted-session option was rejected. See [RECOMMENDATIONS.md](./RECOMMENDATIONS.md) |
| **The outbox is not transactional** | jovi-mall emits after commit, fire-and-forget. Affects the geo-tracker seam, not this one |
| **`GET /api/payments/:id` is owner-scoped; initiate/verify are not** | Deliberate, withdrawn as an audit finding, and load-bearing for in-chat checkout |
| **`estimatedDelivery` is always null** | Nothing estimates a delivery date. The key is stable so the shape does not change the day estimates arrive |

---

## Related

- [ARCHITECTURE.md](./ARCHITECTURE.md) · [COMMAND-SPECIFICATION.md](./COMMAND-SPECIFICATION.md) · [RECOMMENDATIONS.md](./RECOMMENDATIONS.md)
- [tools/catalog.json](./tools/catalog.json) — every tool carries `status` and `gap_ref`
