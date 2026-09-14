# jovi-mall API — Frontend Integration Guide

**Verified against source on 2026-09-08** — the uploads section in full (field names `files` /
`videos`, 1–10 files, and the per-role ceilings customer 100 MB · agency 200 MB · vendor 500 MB ·
agent 1 GB · admin 2 GB · video 70 MB, against
`src/api/controllers/file-upload.controller.ts:47-56,112-122` and
`src/api/routes/file-upload.routes.ts:48-101`), and the internal-admin door.
**One count had drifted** and is corrected in that section.

> **Start here.** This is the index and the shared contract for every jovi-mall HTTP endpoint.
> Read this page once, then jump to the per-feature docs linked below. Live GPS tracking lives in a
> **separate service** (geo-tracker) — see [Live Tracking](#live-tracking-geo-tracker).

---

## Services at a glance

| Service | Stack | Base URL (dev) | Realtime | Docs |
|---|---|---|---|---|
| **jovi-mall** (this repo) | Express + TypeScript + MongoDB | `http://localhost:8022/api` | ❌ HTTP only | this folder |
| **geo-tracker** | Go + Redis + Postgres | `http://localhost:8080` | ✅ WebSocket | `../../geo-tracker/api-doc/` |

jovi-mall owns all users, orders, shipments, money, and the **tracking authorization policy**.
geo-tracker owns live positions, the tracking WebSocket, and routing. A frontend that shows a live
map talks to **both**: jovi-mall for data, geo-tracker for the live stream.

---

## The response envelope (read this first)

Every jovi-mall endpoint returns one of exactly two shapes.

### Success

```json
{
  "success": true,
  "data": { "...": "the payload — object, array, or null" },
  "meta": { "total": 120, "page": 1, "limit": 20, "pages": 6 },
  "message": "Optional human-readable note"
}
```

- `data` is present on success (object, array, or `null`) — **with four documented exceptions, all
  on `/api/payments/*`.** See the ⚠ below.
- `meta` appears **only** on paginated/list responses (and may carry extra summary fields).
- `message` is optional.

> ⚠ **Four payment routes predate this envelope and return FLAT bodies with no `data` key.**
> This line read *"`data` is **always present** on success"* until 2026-09-06 (DOC-PROGRAM F-34),
> and a client helper written from it — `return body.data` — reads `undefined` for every one of
> them, **on the checkout path**.
>
> | Route | Shape | Source |
> |---|---|---|
> | `POST /api/payments/initiate` | `{ success, ...result }` — `transactionId`, `status`, `instructions` are **top-level** | `payment.routes.ts:59` |
> | `POST /api/payments/verify` | `{ success, ...result }` | `payment.routes.ts:87` |
> | `POST /api/payments/authorize` | `{ success, ...result }` | `payment.routes.ts:123` |
> | `GET /api/payments/:transactionId` | `{ success, transaction }` — payload under **`transaction`**, not `data` | `payment.routes.ts:206` |
>
> Note `success` on the first two is **derived from the payment status**, not from "the request
> worked": `initiate` sends `success: result.status !== 'FAILED'` and `verify` sends
> `success: result.status === 'SUCCEEDED'`. A 200 with `success: false` is a normal, expected
> answer there and is **not** an error envelope — it carries no `error` object.
>
> The two newest routes on that prefix — `GET /api/payments/session/:token` and
> `POST /api/payments/:transactionId/pay-link` (`:155`, `:178`) — **do** use `data` normally.
> The exception is historical, not a property of the prefix.
>
> **Unwrap defensively:** `success === true && 'data' in body ? body.data : body`.

> **Three list endpoints call the pagination block `pagination`, not `meta`** — `GET
> /api/{role}/tickets` and the two `…/tickets/reference/{orders,products}` lookups. The block's
> own fields (`total`, `page`, `limit`, `pages`) are identical; only the key differs. Read both
> keys on those three, or key off the endpoint. See [vendor/tickets.md](./vendor/tickets.md).

### Error

```json
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "AUTH_INVALID_CREDENTIALS",
    "message": "Invalid credentials",
    "statusCode": 401,
    "category": "authentication",
    "details": { "fields": [{ "path": "email", "message": "Required" }] }
  }
}
```

- Branch on `error.code` (stable string), not `error.message` (human copy, may change).
- `error.category` is **always present** — one of nine values (`authentication · authorization ·
  validation · not_found · conflict · business_rule · rate_limit · external_service · internal`),
  and the same nine in all three backend services. Use it as your default branch when you have no
  specific handling for a code. It is *derived* from `(code, statusCode)`, so one code can carry
  different categories at different statuses.
- `details.fields[]` is present for validation (`VALIDATION_ERROR`) failures — map each to its form field.
- On `internal` and `external_service` the `message` is replaced with a generic sentence and
  `details` is **omitted entirely**, in every environment — `requestId` is the only handle.
- `requestId` also appears as the `X-Request-Id` response header; quote it in bug reports.

> **⚠️ Breaking change (2026-07-17):** the whole API now uses this envelope uniformly. A handful of
> endpoints (notably **auth**, messaging link status, vendor inventory history/reservations)
> previously returned bare payloads or a `pagination` object; they now return `{ success, data, meta }`.
> See [FRONTEND-READINESS.md](../FRONTEND-READINESS.md) for the exact list. Provider **webhooks**
> (`/webhooks/*`) are the deliberate exception — they answer Stripe/Meta/Telegram, not your frontend,
> and keep their provider-specific bodies.

Full error catalog: [errors/README.md](./errors/README.md).

---

## Pagination

List endpoints accept these query parameters and return a `meta` block:

| Query param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | 1-indexed |
| `limit` | integer 1–100 | `10` | page size |
| `sort` | string | `-createdAt` | field name; prefix `-` for descending (per-endpoint support varies — see each doc) |

Response `meta`:

```json
{ "total": 120, "page": 1, "limit": 20, "pages": 6 }
```

- `total` = total matching records; `pages` = `ceil(total / limit)`.
- The list itself is in `data` (an array). Some list endpoints add summary fields to `meta`
  (e.g. inventory reservations add `totalReserved`).

---

## Authentication

**One JWT session model, two delivery modes, chosen by the route namespace — never by a
header.** See [auth/README.md](./auth/README.md) for the full flow.

- **Browser clients**: log in via `POST /api/auth/login`; the server sets `access_token` (15 min) and
  `refresh_token` (30 d) **HttpOnly** cookies. Send `credentials: 'include'` on every request.
  Expired access tokens are **silently refreshed** by the server from the refresh cookie — no client action.
- **Native / WebView clients**: log in via `POST /api/auth/mobile/login`, which returns
  `data.tokens` (`accessToken`, `refreshToken`, `accessExpiresIn`, `refreshExpiresIn`) and sets
  **no cookie**. Send `Authorization: Bearer <accessToken>`; renew with
  `POST /api/auth/mobile/refresh`, which returns a **fresh pair** and slides the 30-day window.
  A bearer with an expired token is answered `401 AUTH_TOKEN_EXPIRED` and is **never** silently
  refreshed from an ambient cookie.
- **Service clients** (geo-tracker, wi-admin): a shared service token, not a user session — see
  the internal route docs.
- **When both are present**, the bearer wins. `Authorization` is read before the cookie, so a
  stale cookie in a native HTTP layer's OS jar can never beat a freshly-refreshed bearer.
- **Customers**: a different flow entirely — **no registration form and no password field.** The
  account is created on their first interaction with the WhatsApp / Telegram bot, and they sign in
  with a bot-issued magic link or 8-character code redeemed at `POST /api/auth/magic/{link,code}`.
  A storefront deep-links them to the bot and calls no registration endpoint. Full contract:
  [auth/customer-auth.md](./auth/customer-auth.md).
- **Roles**: every account holds one or more of `customer · vendor · agency · agent`. A JWT is
  scoped to **one active role**; switch with `GET /api/auth/auth-me/:role` (no password), or log in
  again with `role`; add a role via `POST /api/auth/add-role` (`/api/auth/mobile/add-role` for
  bearer clients). **`admin` is not a role you can authenticate as here** — administrators live in
  the separate wi-admin database and reach this service over the internal service surface, which is
  what the Admin column below means.
- **Current identity**: `GET /api/auth/me` (or `GET /api/auth/auth-me/:role`, `…/mobile/auth-me/:role`,
  on app launch to restore + refresh).

### Common auth error codes

| `error.code` | Status | Meaning |
|---|---|---|
| `AUTH_MISSING_TOKEN` | 401 | No token and no refresh cookie |
| `AUTH_TOKEN_EXPIRED` / `AUTH_SESSION_EXPIRED` | 401 | Token expired, refresh unavailable/failed |
| `AUTH_PASSWORD_CHANGED` | 401 | The token predates a password change. **Terminal — do not refresh**, the refresh cookie is refused too |
| `AUTH_TOKEN_INVALID` | 401 | Tampered/invalid signature |
| `AUTH_ROLE_NOT_FOUND` | 403 | Authenticated but wrong role for this endpoint |

---

## Permission matrix

Every route tree is guarded by role. `✅` = full access to that area's endpoints for that role;
`—` = no access (403 / not mounted). "Self" means scoped to the caller's own records.

| Area | Anonymous | Customer | Vendor | Agency | Agent | Admin |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Auth (register/login/refresh/logout) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Current user / role switch | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| Product booking availability (`/products/:id/availability`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Public catalog (`/public/products`, `/public/stores`, `/public/categories`) | ✅⁵ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Published price list (`/public/plans`, `/public/credit-packs`) | ✅⁵ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Published blog (`/public/articles`) | ✅⁵ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cart & checkout | — | ✅ | — | — | — | — |
| Customer orders / confirm delivery | — | ✅ (self) | — | — | — | — |
| Gateway payments (`/payments`) | initiate/verify only³ | ✅ (self) | —⁴ | — | — | ✅ (all) |
| Vendor store / products / inventory / analytics | — | — | ✅ (self) | — | — | — |
| Billing (plans/credits) | — | — | ✅ (self) | ✅ (self) | ✅ (self) | ✅ |
| Earnings & payout requests | — | — | ✅ (self) | ✅ (self) | via COD¹ | ✅ (platform) |
| Delivery agency management | — | — | — | ✅ (self) | — | ✅ |
| Agent roster / memberships | — | — | — | ✅ (its agents) | ✅ (self) | ✅ |
| Shipment status transitions | — | — | — | ✅ | ✅ (own)² | ✅ |
| COD cash chain | — | — | — | ✅ (collect/remit) | ✅ (collect/deposit) | ✅ (confirm/oversight) |
| Agency ⇄ vendor connections | — | — | ✅ | ✅ | — | — |
| Agency ⇄ agent contracts | — | — | — | ✅ | ✅ | ✅ (transfer) |
| Tickets (support) | — | ✅ | ✅ | ✅ | ✅ | ✅ (all) |
| Notifications & preferences | — | ✅ (self)⁶ | ✅ (self) | ✅ (self) | ✅ (self) | — |
| Saved payment methods (`/me/payment-methods`) | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| Change password (`/me/password`) | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| Close account (`/me/close`) | — | ✅ (customer-only accounts) | — | — | — | — |
| File upload / management (`/files`) | — | ✅ | ✅ | ✅ | ✅ | ✅ (+ hard-delete/orphans) |
| Admin order controls / COD oversight / agent admin | — | — | — | — | — | ✅ |
| Tracking authorization (`/tracking/visible-agents`) | — | ✅ (own orders) | — | ✅ (its agents) | ✅ (self) | ✅ (all) |

¹ Agents are paid via the ordinary payout pipeline; the platform is the payer. See the COD docs.
² Both the agency and the assigned agent drive the same state machine by the **same transition
table**, through two endpoints (`PATCH /api/agency/shipments/:id/status`,
`POST /api/agent/shipments/:id/status`) — including `handing_over`, so a replacement agent records
their own pickup after a reassignment. What differs is ownership scoping, the optional failure
reason only the agent may attach, and the recorded `changedByRole`. Concurrent writes are resolved
by a from-status compare-and-set: the loser gets `409 SHIPMENT_STATUS_CONFLICT`. `delivered` is
reachable from neither endpoint (COD: the delivery code; prepaid: the customer's confirmation or the
7-day sweep). See [agent/shipments.md](./agent/shipments.md) and
[agency/shipments.md](./agency/shipments.md).
³ `POST /payments/initiate` and `POST /payments/verify` take no credentials; **`GET
/payments/:transactionId` requires auth and returns only the caller's own transaction** (breaking
change, 2026-07-29 — it used to be open). See [payments/README.md](./payments/README.md).
⁴ Vendors read a *booking's* payment state via `GET /api/bookings/:id/payment-status` for bookings
they own. Vendor/agency/agent **plan and credit purchases are a different surface** and create no
`PaymentTransaction` — see [billing-plans-across-roles.md](./billing-plans-across-roles.md).
⁵ `/api/public/*` is the **only** unauthenticated route tree besides auth, the single
booking-availability route above and the payment initiate/verify pair. It reads the plan catalog,
the credit packs, the published blog and the published product catalog — read-only, no identity, no
owner-scoped data. See [public/README.md](./public/README.md),
[public/catalog.md](./public/catalog.md) and [public/articles.md](./public/articles.md).

> **Correction (2026-08-14).** This row used to read "Catalog browse / product booking
> availability ✅" for Anonymous, and this footnote used to say "catalog browse" was already
> unauthenticated. Both were wrong: the *only* unauthenticated catalog route was
> `GET /api/products/:productId/availability` (service booking), and no public product read
> existed at all. It does now — the two are listed separately above because they are two
> different surfaces.
⁶ Customers have their own notification stack at `/api/customer/notifications` — inbox,
`unread-count`, mark-one-read, mark-all-read and channel preferences. It is the fourth of the four
stacks; see [customer/notifications.md](./customer/notifications.md).

---

## Uploads

`POST /api/files/upload` (multipart, field `files`, 1–10 files) and `POST /api/files/upload/video`
(field `videos`) are shared by **all authenticated roles**, with per-role size limits
(customer 100 MB · agency 200 MB · vendor 500 MB · agent 1 GB · admin 2 GB · video 70 MB). Manage with
`GET/PATCH/DELETE /api/files/:id`, `GET /api/files`, `GET /api/files/storage`. Uploaded files are
referenced elsewhere by their returned `id` (e.g. product images, branding, KYC) — what a file is
*for* is decided at that point, not at upload, so each upload is stored by its own detected media
type (`images/`, `documents/`, `audio/`, `archives/`, `videos/`, `other/`). Full contract:
[uploads/README.md](./uploads/README.md) (role-neutral) and [vendor/file-management.md](./vendor/file-management.md).

---

## Live tracking (geo-tracker)

The live map/GPS stream is a **separate service**. jovi-mall only answers *"which agents may this
viewer track?"* via `GET /api/tracking/visible-agents`; geo-tracker does the streaming.

- Authorization policy & the visible-agents contract: [tracking/live-tracking.md](./tracking/live-tracking.md),
  [tracking/agent-tracking-policy.md](./tracking/agent-tracking-policy.md).
- WebSocket connection, subscribe/heartbeat frames, payloads, reconnect: **geo-tracker**
  `../../geo-tracker/api-doc/tracking-websocket.md`.
- Session reads, routing, ETA, locations: `../../geo-tracker/api-doc/`.

Same JWT signs both services — forward the viewer's access token to geo-tracker.

---

## Documentation index

### Cross-cutting
- [Auth & sessions](./auth/README.md) · [**Customer auth (bot registration + passwordless sign-in)**](./auth/customer-auth.md) · [Bot `/login` & `/reset-password`](./auth/magic-login.md) · [Onboarding](./auth/onboarding.md)
- [Change password (`/me/password`, all roles)](./me/password.md) · [**Change email or phone (`/me/{email,phone}`, all roles)**](./me/contact-change.md) — pending until proved; the identifier never moves early · [**Close account (`/me/close`, customers)**](./me/account-closure.md) — anonymise-and-retain, *not* a deletion (ADR-A02)
- [**Public API (no auth)**](./public/README.md) — the published price list: plan catalog + credit packs, for the marketing site
- [**Public catalog (no auth)**](./public/catalog.md) — the storefront's read side: products, categories, stores. **Product URLs are nested under their store**
- [**Public blog (no auth)**](./public/articles.md) — articles, typed blocks, hreflang & slug redirects. The editor is **wi-admin's** (`admin/api-doc/api/content.md`), not this service's
- [**Reviews & ratings — cross-role**](./reviews.md) — one module, **two subjects**: a product review (public, verified purchase) and a **delivery** review (internal, written by the customer *and* the vendor *and* the agency, each feeding a different factor of the agent's trust score). Also the rule for `aggregateRating`: emit it **iff** `rating` is non-null
- [**Billing, plans & credit — cross-dashboard guide**](./billing-plans-across-roles.md) (vendor · agency · agent · admin)
- [Error catalog](./errors/README.md)
- [Geospatial addresses & address search](./geo/README.md)
- [Gateway payments (role-neutral)](./payments/README.md) — initiate · verify · read a transaction
- [**Phase D · 0 · 1 — what the readiness phases changed**](./phase-d-0-1/README.md) — one document per audience ([admin](./phase-d-0-1/admin-dashboard.md) · [vendor & agency dashboards](./phase-d-0-1/vendor-agency-dashboard.md) · [customer app](./phase-d-0-1/customer-app.md) · [agency & agent app](./phase-d-0-1/agency-agent-app.md)). Real mobile money, the one-time-code step, callback settlement, refund verdicts, and the ten decisions with their build status
- [**Phase 2 · 3 — deployability and the cross-service seam**](./FRONTEND-CHANGELOG-phase-2-3.md) — the cross-role page, plus one per role folder ([vendor](./vendor/FRONTEND-CHANGELOG-phase-2-3.md) · [agency](./agency/FRONTEND-CHANGELOG-phase-2-3.md) · [agent](./agent/FRONTEND-CHANGELOG-phase-2-3.md) · [customer](./customer/FRONTEND-CHANGELOG-phase-2-3.md) · [landing & shop](./public/FRONTEND-CHANGELOG-phase-2-3.md) · [admin dashboard](../../admin/api-doc/FRONTEND-CHANGELOG-phase-2-3.md) · [tracking clients](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md)). 🔴 **A dropped tracking subscription used to always say `shipment_completed`** — read your role's page before shipping anything that reads that frame
- [**Phase 4 · 5 — hardening and the admin cutover**](./FRONTEND-CHANGELOG-phase-4-5.md) — the cross-role page, plus one per role folder ([vendor](./vendor/FRONTEND-CHANGELOG-phase-4-5.md) · [agency](./agency/FRONTEND-CHANGELOG-phase-4-5.md) · [agent](./agent/FRONTEND-CHANGELOG-phase-4-5.md) · [customer](./customer/FRONTEND-CHANGELOG-phase-4-5.md) · [landing & shop](./public/FRONTEND-CHANGELOG-phase-4-5.md) · [admin dashboard](../../admin/api-doc/FRONTEND-CHANGELOG-phase-4-5.md) · [tracking clients](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md)). 🔴 **Two deliberate breaks**: `FileDetail.url` is now `string | null` with a new `access` field, and a session is capped at **90 days absolutely** (`AUTH_SESSION_CAP_REACHED` — route to login, never retry). Plus: every upload is really scanned now, and **there is no public `/api/admin/*` any more**
- [**Order detail — the customer app's four asks, answered**](./customer/FRONTEND-CHANGELOG-order-detail.md) (customer app only, 2026-08-23). A shipment now carries the delivery **`agency`** (logo + published support contacts) and — new policy, [ADR-A06](../docs/ADR-A06-AGENT-IDENTITY-DISCLOSURE.md) — the carrying **`agent`**'s partial name and photo, revoked once the parcel settles. ⚠ Its `visibleFrom` is `"shipped"`, **not** `"out_for_delivery"`, and the two are not the same thing here. Also: a refused payment initiation no longer marks an order `AWAITING_PAYMENT`, and a null address `location` no longer blocks every write to a customer
- [**Email verification — one page for all four apps**](./FRONTEND-CHANGELOG-email-verification.md) (cross-role, 2026-08-24). 🔴 **The registration-verification email used to link at the API**, so clicking it rendered raw JSON and the token was routinely spent by a mail-client prefetch before anyone tapped it. It now points at `{STOREFRONT_URL}/verify-email?token=…&app={role}`, which POSTs to a **new `POST /api/auth/verify-email`** (the `GET` stays for links already in inboxes). Both emailed-token pages gained **`app=`** — a role KEY, never a URL. Nothing breaks
- **Payout methods** — where you get paid *to* (mobile money · bank · **card**), one schema documented per role: [vendor](./vendor/payout-methods.md) · [agency](./agency/payout-methods.md) · [agent](./agent/payout-methods.md). Distinct from *payment* methods, which are what you pay *with*
- [Uploads (role-neutral)](./uploads/README.md)
- [**Health probes & metrics**](./health.md) — `/api/health` (frozen — geo-tracker's readiness depends on it), `/api/health/{live,ready}`, `/metrics`
- [System uptime / status](./system-uptime-status.md) — ⚠ an **unserved** frontend spec; the operator surface is [admin/system.md](./admin/system.md)
- [**Messaging connections**](./connections/README.md) — connecting a WhatsApp or Telegram account, **any role**. One mechanism, one code box; replaces the two separate linking flows
- [WhatsApp bot webhook](./whatsapp/README.md) · [WhatsApp notification templates](./notifications/whatsapp-templates.md)
- [Telegram bot webhook & admin send](./telegram/README.md) · [Google Calendar (OAuth)](./integrations/google-calendar.md)
- [**n8n customer agent — design**](./n8n/README.md) (2026-08-24, **design only**) — the WhatsApp/Telegram customer bot: a [60-tool catalogue](./n8n/tools/catalog.json), a [34-command specification](./n8n/COMMAND-SPECIFICATION.md), the [architecture](./n8n/ARCHITECTURE.md) and [twelve backend gaps](./n8n/BACKEND-GAPS.md). ⚠ Its premise: **there is no way for the automation layer to act as a customer today** — `/api/internal/*` covers agents, shipments and admin only, and the four live bot commands mint credentials for a *human to redeem in a browser*. GAP-001 is the curated surface that closes it, and no customer bearer token ever leaves the backend

### Customer
- **▶ [Auth — registration & sign-in](./auth/customer-auth.md)** — **start here if you are building the storefront.** Customers register in the bot and sign in without a password; there is no registration endpoint and no password field
- **▶ [Order detail — the four asks, answered](./customer/FRONTEND-CHANGELOG-order-detail.md)** (2026-08-23) — the delivery agency's logo and support contacts, the carrying agent's partial identity ([ADR-A06](../docs/ADR-A06-AGENT-IDENTITY-DISCLOSURE.md)), and two bug fixes
- [Profile & addresses](./customer/profile.md) · [Cart](./customer/cart.md) · [Orders](./customer/orders.md) · [**Wishlist & recently viewed**](./customer/saved-and-viewed.md) — server-side, replacing the storefront's `localStorage`; entries degrade rather than vanish when a product goes off sale
- [Bookings](./customer/bookings.md) · [Payment methods](./customer/payment-methods.md) · [Digital products](./customer/digital-products.md) · [Tickets](./customer/tickets.md)
- [**Reviews**](./reviews.md) — `/api/customer/reviews`. A customer reviews a **product** they bought *and* a **delivery** they received; the two have different eligibility rules and only the first is ever published
- [**The bot as a shopping surface**](./n8n/README.md) (**design only**) — what a customer can do from WhatsApp or Telegram, and which of these customer endpoints sits behind each command. Read [COMMAND-SPECIFICATION.md](./n8n/COMMAND-SPECIFICATION.md) before writing bot-facing copy: it carries the rules a chat window makes specific — the delivery code is never sent unasked, `estimatedDelivery` is always null, an agent's phone number is never published, and a product's unavailability is never explained

### Vendor
- [Store](./vendor/store.md) · [Profile](./vendor/profile.md) · [Onboarding](./vendor/onboarding.md) · [**Identity verification**](./vendor/identity-verification.md) — the ID scans, the selfie and the location sketches an administrator reviews. ⚠ Nothing is required and nothing is graded here: the checklist is the reviewers' and it is documented in that file
- [Products](./vendor/products.md) · [Simple products](./vendor/simple-products.md) · [Product update](./vendor/product-update.md) · [Upload flow](./vendor/product-upload-flow.md) · [Variants](./vendor/variants.md) · [Options & variants](./vendor/option-variant-management.md) · [Digital products](./vendor/digital-products.md) · [Rich descriptions](./vendor/product-description-rich.md) · [Share to a chat app](./vendor/product-share.md)
- [Inventory](./vendor/inventory.md) · [Orders](./vendor/orders.md) · [Shipping](./vendor/shipping.md) · [Delivery agencies](./vendor/delivery-agencies.md) · [Agency connections](./vendor/agency-connections.md)
- [Bookings](./vendor/bookings.md) · [Booking guide](./booking-implementation-guide.md) · [Calendar](./vendor/calendar.md) · [Availability rules](./vendor/availability-rules.md)
- [Billing](./vendor/billing.md) · [Billing overview](./vendor/billing-overview.md) · [Earnings](./vendor/earnings.md) · [Transactions](./vendor/transactions.md) · [Stripe payments](./vendor/stripe-payments.md) · [Payment methods](./vendor/payment-methods.md) (pay *with*) · [**Payout methods**](./vendor/payout-methods.md) (get paid *to* — mobile money only right now; 🚧 bank + card switched off)
- [Analytics](./vendor/analytics.md) · [Customer management](./vendor/customer-management.md) · [Storage](./vendor/storage.md) · [File management](./vendor/file-management.md) · [Storage statements](./vendor/storage-invoices.md) — what each agency says you owe it for warehousing
- [**Reviews**](./reviews.md) — `/api/vendor/reviews`. **Deliveries only**: rate how your consignment was collected and carried. A product review is the buyer's
- [Notifications](./vendor/notifications.md) · [Notification channels](./vendor/notification-channels.md) · [Tickets](./vendor/tickets.md) — the shared payload reference for every role's ticket surface; the `TicketType` list is [ticket_types.txt](./ticket_types.txt), and the picker gaps still open are in [tickets-reference-frontend-requirements.md](./vendor/tickets-reference-frontend-requirements.md)

### Agency
- [Profile](./agency/profile.md) · [Profile schema](./agency/profile-schema.md) · [Onboarding](./agency/onboarding.md) · [**Identity verification**](./agency/identity-verification.md) — the ID scans, the selfie and the depot sketches an administrator reviews. ⚠ The ID number here is the **person's**, not the company registration; nothing is required and nothing is graded
- [Agent roster & contracts](./agency/agent-roster.md) — **canonical for the agent↔agency contract**, including [terms negotiation](./agency/agent-roster.md#terms-negotiation) · [Shipments](./agency/shipments.md)
- [Live tracking](./agency/live-tracking.md) — the map: watchable agents, their active shipments, and each shipment's pickup → drop-off pins (movement itself comes from geo-tracker's socket)
- [Billing (plans & credit)](./agency/billing.md) · [COD cash management](./agency/cod-cash-management.md) · [Earnings](./agency/earnings.md) · [Payment methods](./agency/payment-methods.md) (pay *with*) · [**Payout methods**](./agency/payout-methods.md) (get paid *to* — mobile money only right now; 🚧 bank + card switched off)
- [Vendor connections](./agency/vendor-connections.md) · [Vendors](./agency/vendors.md) · [Products](./agency/products.md)
- [**Inventory**](./agency/inventory.md) — what you warehouse, per depot, and since Step 14 **what is physically on the shelf**: receipts, counts, transfers and a movement ledger · [Stock requests](./agency/stock-requests.md) (changing the vendor's agreed quantity) · [**Storage statements**](./agency/storage-invoices.md) — the monthly record of rent owed. A RECORD: the platform moves none of this money · [Magazin](./agency/magazin.md) (the depots themselves)
- [File management](./agency/file-management.md) · [Storage](./agency/storage.md)
- [**Reviews**](./reviews.md) — `/api/agency/reviews`. **Deliveries only**, and your review moves *the agent's* rating, never your own: your directory score comes from your customers
- [Notifications](./agency/notifications.md) · [Tickets](./agency/tickets.md)

### Agent
- **▶ [Shipment discovery — frontend integration guide](./agent-shipment-discovery-integration.md)** — search, earnings, addresses and the pickup→drop-off route. **Start here if you are integrating the agent app**; it carries the two breaking changes and the migration checklist.
- [Profile, preferences & dispatch settings](./agent/profile.md) · [Vehicle colour & photo](./agent/vehicle-profile.md) · [Onboarding](./agent/onboarding.md) · [Availability & device](./agent/availability-and-device.md) · [Agency membership](./agent/agency-membership.md) — applying, and [negotiating your terms](./agent/agency-membership.md#terms-negotiation)
- [Shipments](./agent/shipments.md) · [Offers](./agent/offers.md) · [Delivery proof](./agent/delivery-proof.md) · [COD cash](./agent/cod-cash.md) · [Earnings](./agent/earnings.md) · [Billing (plans & credit)](./agent/billing.md) · [Payment methods](./agent/payment-methods.md) (pay *with*) · [**Payout methods**](./agent/payout-methods.md) (get paid *to* — mobile money only right now; 🚧 bank + card switched off)
- [**Identity verification**](./agent/identity-verification.md) — the ID scans, the selfie, the vehicle-with-rider photo and the home sketch. ⚠ **This is the verdict that lets an agent work at all** — dispatch eligibility passes only on `verified`
- [File management](./agent/file-management.md) · [Storage](./agent/storage.md)
- [Notifications](./agent/notifications.md) · [Push notifications (Flutter)](./agent/push-notifications.md) — includes offer quick actions, whose rationale record is [offer-quick-actions.md](./agent/offer-quick-actions.md) · [Tickets](./agent/tickets.md)

### Admin — ⚠️ **not a frontend surface any more**

**There is no public `/api/admin/*` in this service.** Every mount was deleted at the Phase 5
cutover, together with the second authorization model it carried — `requireRole(['admin'])` on a
platform `users` row that holds no tier, no permission set and no audit identity. **If you are
building an admin dashboard, you want the wi-admin backend** (`/api/v1/*`, documented in
`admin/api-doc/api/`), which resolves the administrator's permissions, writes the audit row, and
calls the surface below on their behalf.

The pages here document `/api/internal/admin/*` — **120 routes in sixteen groups**, behind
`requireAdminCaller` (re-counted 2026-09-08 against the live route table and the sixteen
`router.use` mounts in `src/api/routes/internal-admin.routes.ts`; this line read *111 routes in
fifteen groups*, which was the count before `reviews` and `messaging` were added). They are kept because one factory always served both mounts, so they remain
exact for request and response shapes; each was **rewritten to the internal prefix**, not deleted.

- [**The internal admin API**](./admin/internal-service-api.md) — start here: the door, its
  headers, the route inventory, and the delegate-a-verdict/read-a-record rule that decides what
  is on it
- [Orders (disputes, cancel, dispatch, refund)](./admin/orders.md) · [Agents](./admin/agents.md) · [Delivery agencies](./admin/delivery-agencies.md)
- [COD oversight](./admin/cod.md) · [Platform earnings](./admin/earnings.md) · [Payout requests](./admin/payout-requests.md) · [Billing](./admin/billing.md)
- [Tickets](./admin/tickets.md) · [Vendors](./admin/vendors.md) · [Shipments](./admin/shipments.md) — the last two never had a public mount
- [**Review moderation**](./admin/reviews.md) — net-new, and the second group here with no public twin. The queue holds **prose only**: a bare star rating publishes on submission, because a number cannot be abusive and the verified-purchase gate has already run
- [**System operations**](./admin/system.md) — dependency health · integration status · queue depth · cache status · background jobs · operational metrics · the error journal. **Read-only, every route a GET**
- [**Developer tools**](./admin/dev-tools.md) — the dangerous half: run a worker · replay/prune the outbox · rebuild search vectors (the old `POST /admin/products/bulk-vectorise`) · **maintenance mode** · **cache flush**
- Not admin surfaces, filed here for historical reasons: [Billing overview](./admin/billing-overview.md) (a cross-role explainer) · [Payment methods](./admin/payment-methods.md) (`/api/me/payment-methods`, every role)

Two pages were **deleted** rather than repointed, because nothing replaced them here:
`profile.md` (`/api/admin/profile` — wi-admin has served `GET`/`PATCH /administrators/me` since
Phase 2) and `catalogue-vectorisation.md` (`POST /api/admin/products/bulk-vectorise` — the same
controller now runs at `/api/internal/admin/dev-tools/catalogue/vectorise`, documented in
[dev-tools.md](./admin/dev-tools.md)).

### Tracking (authorization; streaming is in geo-tracker)
- [Live tracking](./tracking/live-tracking.md) · [Agent tracking policy](./tracking/agent-tracking-policy.md)

---

## Conventions

- **IDs** are MongoDB ObjectIds (24-hex strings).
- **Timestamps** are ISO-8601 UTC strings (`2026-07-17T10:20:30.000Z`).
- **Phone numbers** are **E.164, everywhere** — see [Contact formats](#contact-formats-phone--email).
- **Email addresses** are validated and lowercased — see [Contact formats](#contact-formats-phone--email).
- **Clearing optional fields** (added 2026-07-22): optional string fields in PATCH/POST bodies are
  *clearable* unless a doc says otherwise. Three states: **omit** the key → stored value unchanged;
  send **`null` or `""`** (whitespace-only counts as `""`) → field **cleared**, stored and returned
  as `null`; send a value → it must satisfy the field's constraint (URL, email, length…), and invalid
  non-empty values are rejected with `VALIDATION_ERROR`. Required fields (e.g. store `name`) and
  verified identity fields (vendor `email`/`phone`) are **not** clearable. Numeric/boolean/date
  fields accept `null` where documented but never `""`.
- **Money** is stored in the smallest unit is **not** assumed — amounts are numbers in the account
  currency (default `XAF`); check each endpoint. COD amounts are whole-currency numbers.
- **Soft delete**: most resources are soft-deleted; list endpoints never return deleted records.
- **`Content-Type: application/json`** on every non-multipart POST/PATCH/PUT.

---

## Contact formats (phone & email)

**One rule, every endpoint.** Wherever the API accepts a phone number or an email address — auth,
profiles, store/magazin support contacts, payout destinations, payment channels, agent emergency
contacts, vendor support channels — the same validation applies. There is no endpoint with a looser
rule, and no field where "it's optional" means "it's unchecked".

### Phone numbers — E.164 only

```
+237670000000        ✅
+237 670 00 00 00    ✅  formatting is stripped for you; stored as +237670000000
+1 (555) 010-9999    ✅
670000000            ❌  no country code — VALIDATION_ERROR
00237670000000       ❌  00-prefixed dialling is not E.164 — send the +
+0237670000          ❌  a country code cannot start with 0
+237                 ❌  incomplete
```

- A leading **`+` and country calling code are required**. The server will not guess a country: the
  platform serves several, so a national number has no single correct expansion.
- 7–15 digits total (the E.164 ceiling is 15).
- **Spaces, dashes, dots and parentheses are accepted and stripped.** What is stored and echoed back
  is the canonical form, so send the number however your input mask produces it.
- This validates *format*, not reachability — a well-formed number may still be unassigned.

### Email addresses

```
name@example.com          ✅
  Name@Example.COM        ✅  trimmed and lowercased; stored as name@example.com
o'brien+tag@my-shop.io    ✅
name@example              ❌  no TLD
root@localhost            ❌  bare host
"john doe"@example.com     ❌  legal in the RFC, undeliverable in practice
na..me@example.com        ❌
```

- RFC 5322 dot-atom local part, a real dotted domain with an alphabetic TLD, and the RFC 5321 length
  limits (64 for the local part, 254 for the whole address).
- **Addresses are trimmed and lowercased** before storage and comparison, so `Ada@Example.com` and
  `ada@example.com` are the same account. Log in with either.

### Optional stays optional

Optionality did not change anywhere. A field that was optional is still optional, and a *clearable*
field can still be cleared with `null`/`""` (see **Clearing optional fields** above). The rule is
only ever applied to a value that is actually supplied.

### Errors

Failures use the standard envelope with `error.code = "VALIDATION_ERROR"` (HTTP 400) and name the
offending field in `error.details.fields[]`:

```json
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "category": "validation",
    "statusCode": 400,
    "details": {
      "fields": [
        {
          "path": "phone",
          "message": "Phone number must be in international E.164 format, including the country code (e.g. +237670000000)",
          "code": "custom"
        }
      ]
    }
  }
}
```

> **⚠️ Breaking change:** endpoints that previously accepted a national number (they only checked
> length — `min(6)`/`min(8)`) now require the country code. `POST /api/auth/login` validates its
> `identifier` the same way, so **an account whose stored `login_phone` predates this rule must have
> that number migrated to E.164 before its owner can log in by phone.** Logging in by email is
> unaffected.
