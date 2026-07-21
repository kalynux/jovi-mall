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
| Cart & checkout | — | ✅ | — | — | — | — |
| Customer orders / confirm delivery | — | ✅ (self) | — | — | — | — |
| Vendor store / products / inventory / analytics | — | — | ✅ (self) | — | — | — |
| Billing (plans/credits) | — | — | ✅ (self) | — | — | ✅ |
| Earnings & payout requests | — | — | ✅ (self) | ✅ (self) | via COD¹ | ✅ (platform) |
| Delivery agency management | — | — | — | ✅ (self) | — | ✅ |
| Agent roster / memberships | — | — | — | ✅ (its agents) | ✅ (self) | ✅ |
| Shipment status transitions | — | — | — | ✅ | —² | ✅ |
| COD cash chain | — | — | — | ✅ (collect/remit) | ✅ (collect/deposit) | ✅ (confirm/oversight) |
| Agency ⇄ vendor connections | — | — | ✅ | ✅ | — | — |
| Tickets (support) | — | ✅ | ✅ | ✅ | ✅ | ✅ (all) |
| Notifications & preferences | — | — | ✅ (self) | ✅ (self) | ✅ (self) | — |
| Saved payment methods (`/me/payment-methods`) | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| File upload / management (`/files`) | — | ✅ | ✅ | ✅ | ✅ | ✅ (+ hard-delete/orphans) |
| Admin order controls / COD oversight / agent admin | — | — | — | — | — | ✅ |
| Tracking authorization (`/tracking/visible-agents`) | — | ✅ (own orders) | — | ✅ (its agents) | ✅ (self) | ✅ (all) |

¹ Agents are paid via the ordinary payout pipeline; the platform is the payer. See the COD docs.
² Shipment transitions are **agency-driven**. An agent's only shipment writes are COD-collect and
setting a tracking number — there is **no** agent pickup/deliver/return/cancel endpoint by design.
See [agent/shipments.md](./agent/shipments.md).

---

## Uploads

`POST /api/files/upload` (multipart, field `files`, 1–10 files) and `POST /api/files/upload/video`
(field `videos`) are shared by **all authenticated roles**, with per-role size limits
(customer 100 MB · vendor 500 MB · agent 1 GB · admin 2 GB · video 70 MB). Manage with
`GET/PATCH/DELETE /api/files/:id`, `GET /api/files`, `GET /api/files/storage`. Uploaded files are
referenced elsewhere by their returned `id` (e.g. product images, branding, KYC). Full contract:
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
- [Error catalog](./errors/README.md)
- [Geospatial addresses & address search](./geo/README.md)
- [Uploads (role-neutral)](./uploads/README.md)
- [System uptime / status](./system-uptime-status.md)
- [WhatsApp](./whatsapp/README.md) · [WhatsApp notification templates](./notifications/whatsapp-templates.md)
- [Telegram linking & notifications](./telegram/README.md) · [Google Calendar (OAuth)](./integrations/google-calendar.md)

### Customer
- [Profile & addresses](./customer/profile.md) · [Cart](./customer/cart.md) · [Orders](./customer/orders.md)
- [Bookings](./customer/bookings.md) · [Payment methods](./customer/payment-methods.md) · [Digital products](./customer/digital-products.md) · [Tickets](./customer/tickets.md)

### Vendor
- [Store](./vendor/store.md) · [Profile](./vendor/profile.md) · [Onboarding](./vendor/onboarding.md)
- [Products](./vendor/products.md) · [Product update](./vendor/product-update.md) · [Upload flow](./vendor/product-upload-flow.md) · [Variants](./vendor/variants.md) · [Options & variants](./vendor/option-variant-management.md) · [Digital products](./vendor/digital-products.md)
- [Inventory](./vendor/inventory.md) · [Orders](./vendor/orders.md) · [Shipping](./vendor/shipping.md) · [Delivery agencies](./vendor/delivery-agencies.md) · [Agency connections](./vendor/agency-connections.md)
- [Bookings](./vendor/bookings.md) · [Booking guide](./vendor/booking-implementation-guide.md) · [Calendar](./vendor/calendar.md) · [Availability rules](./vendor/availability-rules.md)
- [Billing](./vendor/billing.md) · [Billing overview](./vendor/billing-overview.md) · [Earnings](./vendor/earnings.md) · [Transactions](./vendor/transactions.md) · [Stripe payments](./vendor/stripe-payments.md) · [Payment methods](./vendor/payment-methods.md)
- [Analytics](./vendor/analytics.md) · [Customer management](./vendor/customer-management.md) · [Storage](./vendor/storage.md) · [File management](./vendor/file-management.md)
- [Notifications](./vendor/notifications.md) · [Notification channels](./vendor/notification-channels.md) · [Tickets](./vendor/tickets.md)

### Agency
- [Profile](./agency/profile.md) · [Profile schema](./agency/profile-schema.md) · [Onboarding](./agency/onboarding.md)
- [Agents](./agency/agents.md) · [Agent roster](./agency/agent-roster.md) · [Shipments](./agency/shipments.md)
- [COD cash management](./agency/cod-cash-management.md) · [Earnings](./agency/earnings.md) · [Payment methods](./agency/payment-methods.md)
- [Vendor connections](./agency/vendor-connections.md) · [Vendors](./agency/vendors.md) · [Products](./agency/products.md)
- [Notifications](./agency/notifications.md) · [Tickets](./agency/tickets.md)

### Agent
- [Onboarding](./agent/onboarding.md) · [Availability & device](./agent/availability-and-device.md) · [Agency membership](./agent/agency-membership.md)
- [Shipments](./agent/shipments.md) · [COD cash](./agent/cod-cash.md) · [Payment methods](./agent/payment-methods.md)
- [Notifications](./agent/notifications.md) · [Tickets](./agent/tickets.md)

### Admin
- [Profile](./admin/profile.md) · [Orders (dispute hold)](./admin/orders.md) · [Agents](./admin/agents.md)
- [Delivery agencies](./admin/delivery-agencies.md) · [COD oversight](./admin/cod.md) · [Platform earnings](./admin/earnings.md) · [Payout requests](./admin/payout-requests.md)
- [Billing](./admin/billing.md) · [Billing overview](./admin/billing-overview.md) · [Catalogue vectorisation](./admin/catalogue-vectorisation.md)
- [Payment methods](./admin/payment-methods.md) · [Tickets](./admin/tickets.md)

### Tracking (authorization; streaming is in geo-tracker)
- [Live tracking](./tracking/live-tracking.md) · [Agent tracking policy](./tracking/agent-tracking-policy.md)

---

## Conventions

- **IDs** are MongoDB ObjectIds (24-hex strings).
- **Timestamps** are ISO-8601 UTC strings (`2026-07-17T10:20:30.000Z`).
- **Money** is stored in the smallest unit is **not** assumed — amounts are numbers in the account
  currency (default `XAF`); check each endpoint. COD amounts are whole-currency numbers.
- **Soft delete**: most resources are soft-deleted; list endpoints never return deleted records.
- **`Content-Type: application/json`** on every non-multipart POST/PATCH/PUT.
