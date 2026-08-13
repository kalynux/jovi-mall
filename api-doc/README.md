# jovi-mall API — Frontend Integration Guide

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

- `data` is **always present** on success (object, array, or `null`).
- `meta` appears **only** on paginated/list responses (and may carry extra summary fields).
- `message` is optional.

### Error

```json
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "AUTH_INVALID_CREDENTIALS",
    "message": "Invalid credentials",
    "statusCode": 401,
    "details": { "fields": [{ "path": "email", "message": "Required" }] }
  }
}
```

- Branch on `error.code` (stable string), not `error.message` (human copy, may change).
- `details.fields[]` is present for validation (`VALIDATION_ERROR`) failures — map each to its form field.
- `requestId` also appears as the `X-Request-Id` response header; quote it in bug reports.

> **⚠️ Breaking change (2026-07-17):** the whole API now uses this envelope uniformly. A handful of
> endpoints (notably **auth**, WhatsApp/Telegram link status, vendor inventory history/reservations)
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

**Cookie-first, Bearer-fallback JWT.** See [auth/README.md](./auth/README.md) for the full flow.

- **Browser clients**: log in via `POST /api/auth/login`; the server sets `access_token` (15 min) and
  `refresh_token` (30 d) **HttpOnly** cookies. Send `credentials: 'include'` on every request.
  Expired access tokens are **silently refreshed** by the server from the refresh cookie — no client action.
- **Mobile / service clients**: send `Authorization: Bearer <access_token>`. Bearer callers **cannot**
  silently refresh — on `401` with an expired token, re-login.
- **Roles**: every account holds one or more of `customer · vendor · agency · agent · admin`. A JWT is
  scoped to **one active role**; switch roles by logging in again with `role`, or add a role via
  `POST /api/auth/add-role`.
- **Current identity**: `GET /api/auth/me` (or `GET /api/auth/auth-me/:role` on app launch to restore + refresh).

### Common auth error codes

| `error.code` | Status | Meaning |
|---|---|---|
| `AUTH_MISSING_TOKEN` | 401 | No token and no refresh cookie |
| `AUTH_TOKEN_EXPIRED` / `AUTH_SESSION_EXPIRED` | 401 | Token expired, refresh unavailable/failed |
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
| Catalog browse / product booking availability | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Published price list (`/public/plans`, `/public/credit-packs`) | ✅⁵ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Published blog (`/public/articles`) | ✅⁵ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Blog editor (`/admin/articles`, `/admin/article-authors`) | — | — | — | — | — | ✅ |
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
| Notifications & preferences | — | — | ✅ (self) | ✅ (self) | ✅ (self) | — |
| Saved payment methods (`/me/payment-methods`) | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| Change password (`/me/password`) | — | ✅ | ✅ | ✅ | ✅ | ✅ |
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
⁵ The **only** unauthenticated route tree besides auth, catalog browse and the payment
initiate/verify pair. It reads the plan catalog, the credit packs and the published blog — the same
prices and prose the marketing site publishes — and nothing else. Read-only, no identity, no
owner-scoped data; see [public/README.md](./public/README.md) and
[public/articles.md](./public/articles.md).

---

## Uploads

`POST /api/files/upload` (multipart, field `files`, 1–10 files) and `POST /api/files/upload/video`
(field `videos`) are shared by **all authenticated roles**, with per-role size limits
(customer 100 MB · vendor 500 MB · agent 1 GB · admin 2 GB · video 70 MB). Manage with
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
- [Auth & sessions](./auth/README.md) · [Onboarding](./auth/onboarding.md)
- [Change password (`/me/password`, all roles)](./me/password.md)
- [**Public API (no auth)**](./public/README.md) — the published price list: plan catalog + credit packs, for the marketing site
- [**Public blog (no auth)**](./public/articles.md) — articles, typed blocks, hreflang & slug redirects. Editor: [admin/articles.md](./admin/articles.md)
- [**Billing, plans & credit — cross-dashboard guide**](./billing-plans-across-roles.md) (vendor · agency · agent · admin)
- [Error catalog](./errors/README.md)
- [Geospatial addresses & address search](./geo/README.md)
- [Gateway payments (role-neutral)](./payments/README.md) — initiate · verify · read a transaction
- **Payout methods** — where you get paid *to* (mobile money · bank · **card**), one schema documented per role: [vendor](./vendor/payout-methods.md) · [agency](./agency/payout-methods.md) · [agent](./agent/payout-methods.md). Distinct from *payment* methods, which are what you pay *with*
- [Uploads (role-neutral)](./uploads/README.md)
- [**Health probes & metrics**](./health.md) — `/api/health` (frozen — geo-tracker's readiness depends on it), `/api/health/{live,ready}`, `/metrics`
- [System uptime / status](./system-uptime-status.md) — ⚠ an **unserved** frontend spec; the operator surface is [admin/system.md](./admin/system.md)
- [WhatsApp](./whatsapp/README.md) · [WhatsApp notification templates](./notifications/whatsapp-templates.md)
- [Telegram linking & notifications](./telegram/README.md) · [Google Calendar (OAuth)](./integrations/google-calendar.md)

### Customer
- [Profile & addresses](./customer/profile.md) · [Cart](./customer/cart.md) · [Orders](./customer/orders.md)
- [Bookings](./customer/bookings.md) · [Payment methods](./customer/payment-methods.md) · [Digital products](./customer/digital-products.md) · [Tickets](./customer/tickets.md)

### Vendor
- [Store](./vendor/store.md) · [Profile](./vendor/profile.md) · [Onboarding](./vendor/onboarding.md)
- [Products](./vendor/products.md) · [Product update](./vendor/product-update.md) · [Upload flow](./vendor/product-upload-flow.md) · [Variants](./vendor/variants.md) · [Options & variants](./vendor/option-variant-management.md) · [Digital products](./vendor/digital-products.md)
- [Inventory](./vendor/inventory.md) · [Orders](./vendor/orders.md) · [Shipping](./vendor/shipping.md) · [Delivery agencies](./vendor/delivery-agencies.md) · [Agency connections](./vendor/agency-connections.md)
- [Bookings](./vendor/bookings.md) · [Booking guide](./booking-implementation-guide.md) · [Calendar](./vendor/calendar.md) · [Availability rules](./vendor/availability-rules.md)
- [Billing](./vendor/billing.md) · [Billing overview](./vendor/billing-overview.md) · [Earnings](./vendor/earnings.md) · [Transactions](./vendor/transactions.md) · [Stripe payments](./vendor/stripe-payments.md) · [Payment methods](./vendor/payment-methods.md) (pay *with*) · [**Payout methods**](./vendor/payout-methods.md) (get paid *to* — mobile money only right now; 🚧 bank + card switched off)
- [Analytics](./vendor/analytics.md) · [Customer management](./vendor/customer-management.md) · [Storage](./vendor/storage.md) · [File management](./vendor/file-management.md)
- [Notifications](./vendor/notifications.md) · [Notification channels](./vendor/notification-channels.md) · [Tickets](./vendor/tickets.md)

### Agency
- [Profile](./agency/profile.md) · [Profile schema](./agency/profile-schema.md) · [Onboarding](./agency/onboarding.md)
- [Agent roster & contracts](./agency/agent-roster.md) — **canonical for the agent↔agency contract**, including [terms negotiation](./agency/agent-roster.md#terms-negotiation) · [Shipments](./agency/shipments.md)
- [Live tracking](./agency/live-tracking.md) — the map: watchable agents, their active shipments, and each shipment's pickup → drop-off pins (movement itself comes from geo-tracker's socket)
- [Billing (plans & credit)](./agency/billing.md) · [COD cash management](./agency/cod-cash-management.md) · [Earnings](./agency/earnings.md) · [Payment methods](./agency/payment-methods.md) (pay *with*) · [**Payout methods**](./agency/payout-methods.md) (get paid *to* — mobile money only right now; 🚧 bank + card switched off)
- [Vendor connections](./agency/vendor-connections.md) · [Vendors](./agency/vendors.md) · [Products](./agency/products.md)
- [File management](./agency/file-management.md) · [Storage](./agency/storage.md)
- [Notifications](./agency/notifications.md) · [Tickets](./agency/tickets.md)

### Agent
- **▶ [Shipment discovery — frontend integration guide](./agent-shipment-discovery-integration.md)** — search, earnings, addresses and the pickup→drop-off route. **Start here if you are integrating the agent app**; it carries the two breaking changes and the migration checklist.
- [Profile, preferences & dispatch settings](./agent/profile.md) · [Onboarding](./agent/onboarding.md) · [Availability & device](./agent/availability-and-device.md) · [Agency membership](./agent/agency-membership.md) — applying, and [negotiating your terms](./agent/agency-membership.md#terms-negotiation)
- [Shipments](./agent/shipments.md) · [Offers](./agent/offers.md) · [Delivery proof](./agent/delivery-proof.md) · [COD cash](./agent/cod-cash.md) · [Earnings](./agent/earnings.md) · [Billing (plans & credit)](./agent/billing.md) · [Payment methods](./agent/payment-methods.md) (pay *with*) · [**Payout methods**](./agent/payout-methods.md) (get paid *to* — mobile money only right now; 🚧 bank + card switched off)
- [File management](./agent/file-management.md) · [Storage](./agent/storage.md)
- [Notifications](./agent/notifications.md) · [Push notifications (Flutter)](./agent/push-notifications.md) · [Tickets](./agent/tickets.md)

### Admin
- [Profile](./admin/profile.md) · [Orders (dispute hold)](./admin/orders.md) · [Agents](./admin/agents.md)
- [Delivery agencies](./admin/delivery-agencies.md) · [COD oversight](./admin/cod.md) · [Platform earnings](./admin/earnings.md) · [Payout requests](./admin/payout-requests.md)
- [Billing](./admin/billing.md) · [Billing overview](./admin/billing-overview.md) · [Catalogue vectorisation](./admin/catalogue-vectorisation.md)
- [Payment methods](./admin/payment-methods.md) · [Tickets](./admin/tickets.md)
- [**Blog editor**](./admin/articles.md) — articles + bylines; the write side of [public/articles.md](./public/articles.md)
- [**System operations**](./admin/system.md) — dependency health · integration status · queue depth · cache status · background jobs · operational metrics. **Read-only, every route a GET**
- [**Developer tools**](./admin/dev-tools.md) — the dangerous half: run a worker · replay the outbox · rebuild search vectors · **maintenance mode** · **cache flush**

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
