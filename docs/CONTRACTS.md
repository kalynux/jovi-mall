# jovi-mall — contracts

Read from source 2026-09-06: `src/api/middlewares/`, `src/api/rate-limit/`, `src/core/errors.ts`,
`src/core/error-category.ts`, `src/core/events/event-bus.ts`, and every `*.routes.ts`.

---

## 1 · Four doors, and only one of them authenticates a PERSON

This is the fact most often got wrong about this service. "Auth" here does not mean one thing.

| Door | Guard | Who | Credential | Does a DB lookup? |
|---|---|---|---|---|
| **session / bearer** | `requireAuth` | a person, in one of five roles | HS256 access token, cookie **or** `Authorization: Bearer` | **yes** — user + role entity |
| **wi-admin** | `requireAdminCaller` | the wi-admin *service* | `INTERNAL_ADMIN_SERVICE_TOKEN` | **no** — the actor is synthesised from headers |
| **geo-tracker** | `requireServiceToken` | the geo-tracker *service* | `INTERNAL_SERVICE_TOKEN` | no |
| **n8n bot** | the bot-webhook guard | the customer agent | bot credentials + `X-Webhook-Secret` | no |

**A service holds no `users` row**, which is why the second and third doors exist at all rather
than being a role. Collapsing them into `requireAuth` was rejected for wi-admin and geo-tracker
independently, for the same reason each time.

### 1a · The person door

`requireAuth` populates `req.auth = { user, role, role_entity, auth_time }` and then, at its
**tail**, attaches the identity-scoped rate limiter — one edit, and every authenticated route
inherits the per-role ceiling, including a router written next year whose author never heard of it.

Four properties are load-bearing:

- **The bearer is preferred over the cookie.** This was reversed deliberately. No browser client
  sets `Authorization`, so preferring the bearer is provably a no-op for every cookie client — while
  it closes a genuinely undiagnosable bug for native ones, where a WebView inherits the OS cookie
  jar and a stale cookie beats a freshly-refreshed bearer, producing 401s that look impossible from
  the client side.
- **An empty `Authorization: Bearer ` reports NO token, not an empty one.** The difference is the
  difference between `AUTH_TOKEN_MISSING` and `AUTH_TOKEN_INVALID`, and the second is a lie.
- **A token predating a password change is refused** (`core/auth/password-epoch.ts`, dated against
  `User.password_changed_at`).
- **`auth_time` dates the SIGN-IN, not the token** — copied unchanged through every re-issue, which
  is what makes the 90-day absolute cap of [ADR-A03](./ADR-A03-SESSION-CAP.md) mean anything. It is
  optional because tokens minted before that ADR carry none; those are dated from their own `iat`.

**Three auth namespaces, not one.** `/api/auth/*` is the original; `/api/auth/browser/*` sets
cookies; `/api/auth/mobile/*` returns the pair as `data.tokens` and sets no cookie. Same session
model, same `AuthService`, same lifetimes. The namespace split was chosen over an
`X-Client-Type: mobile` header **because geo-tracker's CORS allows a closed header list** — a new
request header would have forced an edit in a second repository. A route separation also makes
"browser behaviour is unchanged" true by construction. `/api/auth/magic/*` and
`/api/auth/mobile/magic/*` are the passwordless messaging-login pair.

### 1b · The wi-admin door, and the synthetic actor

`requireAdminCaller` **fabricates** `req.auth` from headers with **no database query**:
`X-Actor-Id` → `user.id` *and* `role_entity._id`; the role is the constant `'admin'`.

⚠ **A `*_by_user_id` written through this door holds an id that resolves to nothing in this
database.** That is ADR-004 D-1, a decision and not an oversight: no `.populate()` anywhere in this
repo dereferences an actor (`*_by*`) field — 13 populate sites, verified, none of them. **Adding one
would silently return null.** What makes the dangling id legible rather than mysterious is the pair
of companion fields from `core/types/actor-source.types.ts`: `*_source: 'platform' | 'admin'` names
the identity space, and `*_name` snapshots who it was, because a cross-database join cannot exist.
Use `actorStampFields()` in the schema and `actorStamp()` on the write — writing the three together
is what stops a source disagreeing with the id beside it.

⚠ **This token is a FULL-PRIVILEGE credential and its secrecy is the whole control.** Authorization
is resolved in wi-admin, single-sided, before the call is made. `X-Actor-Tier` reaches this service
and **must stay advisory** — enforcing on a header set by the holder of an all-powerful token is
theatre.

### 1c · Role authorization

`requireRole(['vendor'])` and the ownership scoping inside each service. There is no permission
system here — **the 116 granular permissions live in wi-admin**, which grades the administrator
before calling. Do not build a second one on this side.

---

## 2 · Rate limiting — two layers, and the store fails OPEN

`src/api/rate-limit/`. Redis DB 11.

| Layer | Scope | Mounted | Why there |
|---|---|---|---|
| **A** `globalRateLimiter` | **IP** | `app.ts`, **before auth** | so it protects the login endpoint, which by definition has no identity yet |
| **B** `identityRateLimiter` | **identity** | the tail of `requireAuth` | so every authenticated route inherits it without its author knowing |
| **C** per-endpoint | — | **deliberately unbuilt** | a table of one entry is a second thing to keep in step |

⚠ **Never classify a caller from an unverified JWT.** Selecting a *more generous* bucket from an
attacker-chosen claim hands a forger the biggest one. That is the entire reason for the two-layer
split rather than one clever limiter.

Ceilings are **backstops, not budgets**: agent/admin 1200 · vendor/agency 900 · customer 600 ·
anonymous 600/IP. **Credential endpoints are 20/IP** — the one strict number and the one actual
security control.

**`/api/auth` is two buckets, chosen by `authBucketDispatcher`.** The 20 is aimed at password
spraying and was being spent by traffic that presents no password (`/auth/me` on every dashboard
poll, `/auth/browser/refresh` on every renewal). Behind a NAT the failure mode was the bad one: a
refused refresh signs a user out, and their retry at the login form is refused too — by their
neighbours. Session maintenance moved to `auth_session` (300/IP). Three properties: the list in
`rate-limit/auth-paths.ts` is an **allowlist**, so a route added later inherits the *strict* bucket;
it is a **dispatcher**, not two mounts, so a request is counted once and its `RateLimit` headers
describe the counter that actually bound it; and it classifies on **`req.baseUrl + req.path`**,
because inside a `use`-mounted layer Express has already stripped the prefix and a bare `req.path`
would match nothing — silently, in the safe direction.

⚠ **`FailOpenStore` is not garnish.** `rate-limit-redis` *rejects* when Redis is down and
express-rate-limit turns that rejection into a **500 on every request** — so the naive integration
puts a single point of failure in front of every route.

**Six exempt prefixes, each with a written reason** (`rate-limit/exempt-paths.ts`), matched by
anchored prefix so `/api/healthcheck-bypass` cannot inherit `/api/health`'s exemption:
`/api/health` · `/metrics` · `/api/webhooks` · `/api/internal/agents` · `/api/internal/shipments` ·
`/api/tracking/agent-state`. Four of the six are exempt because a 429 there breaks a *different*
service — see § 7.

---

## 3 · Domain events — in-process, and LOSSY BY CONSTRUCTION

`src/core/events/event-bus.ts`. Measured 2026-09-06: **83 subscribe call sites over 53 distinct
event types**, and **47 literal `eventBus.publish` sites over 45 distinct types** — more publishers
than that reach the bus through per-module wrapper methods (`this.emit(…)`,
`this.notifyVendor(…)`), so the publish figure is a floor, not a census.

A handler that throws is counted, logged and skipped; the event is **not retried and not
persisted**.

Whether that is survivable depends entirely on the audience, and the asymmetry *is* the shape of
the risk:

| | On the bus? | Recovery |
|---|---|---|
| **Money splits** | **no** — post-commit calls made directly by their write path | `EarningsReleaseWorker` sweeps for the ones that never landed, idempotent on a per-source unique index |
| **The tracking outbox** | **no** — left the bus in Phase 3 | writes inside the caller's Mongo session |
| **Everything else** | yes | **none.** No sweep behind any of it. |

"Everything else" is the four notification stacks (vendor · agency · agent · customer), assignment
offers, agent plan capacity and agency onboarding. A handler that throws there means a notification
nobody sends, and **nothing anywhere will notice a second time**.

> ⚠ So the reassurance "the money is fine" is true **and does not transfer**. Before putting a new
> consumer on this bus, decide which of the two lists it joins — and if the answer is the second one
> and the work matters, it wants a sweep of its own rather than a subscription.

The metric label is bounded by **subscription**, not by an allowlist: the set of event types
something actually subscribes to is finite and fixed at boot. A published event nobody handles
collapses to `unhandled`, which is itself a useful signal — somebody is emitting into the void.

⚠ **That signal is currently firing for 21 event types, and this is the first document to say so.**
Counted from source 2026-09-06: of the 45 types published with a literal, **21 have no subscriber
anywhere in `src/`** — including `earnings.split`, `earnings.matured`, four `cod.*` events, six
`ticket.*` events, `user.account.closed` and `user.password.changed`. Every one of them collapses to
`event_type="unhandled"` on `eventBusPublishedTotal`.

This is **not** by itself a defect, and it is important not to read it as one: the money paths were
moved *off* this bus deliberately (see the table above), so `earnings.split` publishing into the
void is the expected consequence of that move rather than lost money. What it does mean is that
`unhandled` is a **noisy** signal here — it cannot be alerted on as-is, because its steady state is
21 types wide. Filed as DOC-PROGRAM **P-10**: either the orphaned publishes go, or the metric needs
a known-orphan allowlist, and until one of those happens the "somebody is emitting into the void"
signal cannot do the job its own docstring describes.

---

## 4 · Webhooks — five inbound, one outbound

### Inbound

| Route | From | Authenticated by |
|---|---|---|
| `POST /api/webhooks/stripe` | Stripe | signature |
| `POST /api/webhooks/mycoolpay` | My-CoolPay — **live money** | signature |
| `POST /api/webhooks/notchpay` | NotchPay | signature |
| `POST /api/webhooks/whatsapp/` | Meta | verify token / signature |
| `POST /api/webhooks/telegram/webhook` | Telegram | secret path token |

Payment webhooks dedup on a unique index in `payment_webhook_events`. ⚠ **That index is built by a
migration** (`migrate:payment-indexes`) whose registry note reads *"WEBHOOK DEDUP STOPS WORKING
ENTIRELY — every gateway redelivery is reprocessed"*. Running the service against a database that
never had the migration applied is not a degraded state; it is a double-crediting one.

All five are **exempt from rate limiting**: a 429 to Stripe or Meta does not inconvenience a caller,
it loses a payment notification or a delivery receipt.

### Outbound

One: the **tracking outbox → geo-tracker**, HMAC-SHA256 over the body, dispatched by
`TrackingDispatchWorker`, deduplicated on `eventId` at the far end. See
[ARCHITECTURE.md § 4.3](./ARCHITECTURE.md#43--the-tracking-outbox).

⚠ **The integration is inert when `GEO_TRACKER_BASE_URL` is unset** — the outbox still accumulates
rows and nothing dispatches. That is the intended local default, **not a bug**.

---

## 5 · Errors — 623 codes, nine categories, one boundary

Measured 2026-09-06: **623 codes** in `src/core/error-codes.ts`, **1 517** `createAppError(` call
sites, **2 060** `ERROR_CODES.*` references, **zero** ad-hoc strings. Re-measure rather than
trusting this line:

```bash
grep -cE "^\s+[A-Z0-9_]+:\s*'" src/core/error-codes.ts     # codes
grep -rhoE "createAppError\(" src/ | wc -l                  # call sites
grep -rhoE "ERROR_CODES\.[A-Z0-9_]+" src/ | wc -l           # ERROR_CODES.* references
```

⚠ These numbers were quoted as **541 / 1 362** until 2026-09-06 and had been carried onward into
geo-tracker's `apperror/codes.go` header and into a frontend doc that generated its client-side
registry from the stale figure. **A count nobody re-measures is a claim that decays silently.**

⚠ **And they decayed again inside that same day** — 621 → 623 codes and 1 514 → 1 517 call sites,
between the morning correction and the evening re-measure, from ordinary feature work in another
module. That is the point of the block above: **these three figures are a snapshot, not a
constant.** Run the commands; do not quote this paragraph.

### The nine categories are a cross-service contract

`authentication · authorization · validation · not_found · conflict · business_rule · rate_limit ·
external_service · internal`.

There is **no shared package**. Each of the three services asserts the nine sorted names against a
**hardcoded literal in its own test** — those three assertions *are* the contract copy, and changing
the list means changing it in three repositories.

The category is **derived** from `(code, statusCode)` in the `AppError` constructor — never
annotated, because the same code is raised at different statuses at different sites. It is derived
in the constructor rather than the factory because four subclasses and six `ticket.service.ts` sites
call `super()` directly.

⚠ **`400` is a schema failure and `422` is a business rule.** That split already exists at 136 and
139 call sites and the derivation depends on it.

### The exposure rule

**Filtering happens at the BOUNDARY, keyed on category — never at the throw site.** For `internal`
and `external_service` the handler substitutes the code's registry default message and **drops
`details` entirely, in every environment**. That is what closed the leaks without editing the
call sites that could produce them, and it is why a service may still put diagnostic context in
`details` on a 5xx — it is journaled, not sent.

### The envelope

```json
{ "success": false, "requestId": "…",
  "error": { "code": "…", "message": "…", "statusCode": 422, "category": "business_rule",
             "details": { } } }
```

`details` is omitted entirely when absent. Success responses are
`{ success: true, data, meta?, message? }` and must go through `src/core/responses.ts` — never a
hand-rolled `res.json`.

⚠ **One field is not in the shared cross-service envelope: `customerMessage`.** It is added *only*
when `req.bot` is set — the n8n surface — and carries a localised, customer-facing wording of the
same failure. `botResponseLanguageOf` returns null off that surface, so the key is simply absent
everywhere else and no other consumer sees a change. The language is stamped on `req.bot` **while
the request is still healthy**, precisely so a failure whose cause is an unreachable database can
still be worded correctly.

⚠ ESLint **bans** `throw new Error()` and `res.status().json({ error })` — and the `res.json`
selector matches `error` **anywhere** in the object literal, not only as its first property, which
is exactly how eight hand-rolled error responses had accumulated.

⚠ `core/logging/log-record.ts` assigns every persisted field **by name**. A new field must be added
there, **in the sink, AND in `log-query.service.ts`'s `toRecord`** — miss one and the data is
written and silently dropped on read. That is why the whole error record nests under a single
`httpError` key.

---

## 6 · Validation

**Zod, at the edge.** 56 `*.validator.ts` files; a schema `.parse()`s the request in the controller
and a `ZodError` bubbling to the handler becomes `400 VALIDATION_ERROR` with a `details.fields[]`
array of `{ path, message, code }`. Body-parser rejections are classified *before* that branch —
malformed JSON, too-large body and wrong `Content-Type` are three different things a caller must do
three different things about, and all three used to answer `500 — Something went wrong`.

Three conventions that are easy to get wrong:

- **Clearable PATCH fields use `clearable()`** from `core/validation/zod.helpers.ts` (`''`/`null` →
  clear). A bare `.nullable().optional()` cannot distinguish "clear this" from "leave it alone".
- **Contacts are strict** — E.164 phones and RFC emails, via `core/validation/{phone,email}.ts`.
- **Never `new RegExp()` on user input.** Use `buildSearchRegex()` / `escapeRegex()` from
  `core/utils/regex.util`. Every search path here is `$regex`-based, so an unescaped term is
  injection **and** ReDoS. ESLint bans the bare constructor.

Configuration is validated separately and at boot — see
[OPERATIONS.md § 2](./OPERATIONS.md#2--configuration--300-variables).

---

## 7 · Service-to-service

The full table, including which side owns which half and which variable names differ, is
[`../../CLAUDE.md`](../../CLAUDE.md) § The cross-service contract. It is not restated here.

What belongs on *this* page is the shape of jovi-mall's obligations:

| Direction | Surface | Rule |
|---|---|---|
| geo-tracker → here | `GET /api/tracking/visible-agents` | asked **as the viewer**; this is where the visibility *policy* lives, and it must never be reimplemented in Go |
| geo-tracker → here | `GET /api/internal/agents/:id/{eligibility,tracking-policy}` · `POST /api/internal/agents/tracking-policies` | service token |
| geo-tracker → here | `GET /api/internal/shipments/:id/destination` | the drop-off pull, **once per tracking session**, never on the broadcast path |
| geo-tracker → here | `POST /api/tracking/agent-state` + `POST /api/internal/agents/:id/tracking-state` | best-effort; a non-2xx is logged and dropped |
| here → geo-tracker | the outbox webhook | HMAC, deduped on `eventId` |
| wi-admin → here | `/api/internal/admin/*` (120 routes) | full-privilege token; wi-admin grades the actor |

Three cross-service rules with consequences bigger than they look:

1. **`GET /api/health` is a FROZEN contract** — exact path, exact body, unconditional 200. See
   [CONSTRAINTS.md § 2](./CONSTRAINTS.md#2--the-frozen-contract).
2. **Three maintenance exemptions exist for geo-tracker's sake**: `/api/internal/agents/*`,
   `/api/tracking/*`, `/api/internal/shipments/*`. Blocking the first two means geo-tracker cannot
   answer *"may this viewer track this agent"*, so every live subscription fails authorization and
   every watcher is dropped — a jovi-mall maintenance window becomes a geo-tracker outage. The third
   has a **smaller** blast radius, which is exactly why it would be forgotten: it drops nobody and
   silently removes the ETA from every session that *opens* during the window.
3. **Event-shape changes must be made in both repos in the same change.** Visibility-*rule* changes
   are jovi-mall-only. The distinction is the whole seam: geo-tracker consumes *verdicts*, never
   statuses.
