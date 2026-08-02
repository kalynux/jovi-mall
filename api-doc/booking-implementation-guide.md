# Service Booking — Frontend Implementation Guide

This is the **reading order** for implementing the full service-product booking feature. Each step names the doc to open and the endpoints to wire, in the order a frontend should build them. Two audiences are involved: the **vendor** app (set up + manage) and the **customer** app (discover + book + pay).

```
VENDOR SETUP            CUSTOMER BOOKING           VENDOR MANAGEMENT
─────────────          ────────────────           ─────────────────
1. Connect calendar     5. Get availability        8. List / calendar view
2. Create service        6. Lock → Book             9. Update status
3. Add availability      7. Pay → poll status      10. Reschedule / cancel
4. Activate product                                11. Mark cash paid
```

---

## Phase 1 — Vendor setup (vendor app)

Build these in order; each depends on the previous.

### Step 1 — Connect Google Calendar  → [vendor/calendar.md](./vendor/calendar.md)

- Render the connection panel from `GET /api/vendor/calendar/status`.
- If `connected: false`, show a "Connect Google Calendar" button that navigates the **browser** to `GET /api/integrations/google/connect` (redirect/OAuth — not a `fetch`).
- When the OAuth flow finishes, the backend redirects the browser back to your configured route (`GOOGLE_OAUTH_FRONTEND_REDIRECT_URL`, e.g. `/dashboard/services`) with `?calendar=connected` or `?calendar=error&reason=...`. Read those params on the landing route, then re-fetch `GET /api/vendor/calendar/status` and show `email` + `permissions` + `requiresReauth`.
- **Gate the rest of setup (and customer booking) on `connected: true`.** Booking creation requires a connected calendar; availability does not (it just won't subtract Google busy times).

### Step 2 — Create the service product  → [vendor/products.md](./vendor/products.md#service-products)

- `POST /api/vendor/products` with `type: "service"`. Do **not** send `serviceConfig` here.

### Step 3 — Create the service variant (price + `serviceConfig`)  → [vendor/variants.md](./vendor/variants.md)

- `POST /api/vendor/products/:id/variants` with `price` + `serviceConfig`. A service product has **exactly one** variant carrying its config + price.
- `serviceConfig` requires `durationMinutes` and `bookingMode`; optionally `bufferBeforeMinutes`, `bufferAfterMinutes`, and a `peakHours` surcharge. For `bookingMode: "capacity"` (multi-seat slots, e.g. a class), also send `maxBookings` (≥ 1) — see [serviceConfig.bookingMode](./vendor/variants.md#service-bookingmode).
- `price` is the **base price per `durationMinutes`** (e.g. `5000` for a 60-min unit). The booking price is prorated by the actual elapsed duration; peak surcharge applies only to the minutes overlapping the peak window.
- Update the scheduling/peak config later via `PATCH /api/vendor/products/:productId/variants/:variantId/service/config`.

### Step 4 — Define availability + activate  → [vendor/availability-rules.md](./vendor/availability-rules.md)

- Create rules (`POST /api/vendor/products/:id/availability-rules`) — they start as drafts (`isActive: false`). Send an **array** of rules to define the whole week in one request.
- Publish each via `PATCH .../availability-rules/:ruleId/toggle` with `{ "isActive": true }`.
- Activate the product — it needs one active default variant with `serviceConfig.durationMinutes` and `price > 0`. See [Change Product Status](./vendor/products.md#change-product-status).

---

## Phase 2 — Customer booking (customer app)  → [customer/bookings.md](./customer/bookings.md)

Build the checkout as a short-lived, ordered flow.

### Step 5 — Get available slots

- `GET /api/products/:productId/availability?fromDate&toDate` (public). Render the returned `slots`; keep each `slot.id` opaque.

### Step 6 — Lock, then book

- On slot select: `POST /api/products/:productId/slots/:slotId/lock` → start a 15-min countdown from `expiresAt`.
- On confirm: `POST /api/products/:productId/book` with `{ slotId, metadata }` → returns the `booking` and `price`. The booking's `status` is `confirmed` (`calendar`/`capacity`) or `pending` (`manual`, awaiting vendor acceptance) — see [serviceConfig.bookingMode](./vendor/variants.md#service-bookingmode); `paymentStatus` is `unpaid`.
- **Capacity mode**: a slot accepts multiple seats. Availability slots carry `maxBookings`/`spotsRemaining` (render "N spots left"); a full slot returns `available:false`, and booking a full slot returns `409 BOOKING_SLOT_FULL`.
- On abandon: `POST /api/products/:productId/slots/:slotId/unlock` (or let the lock expire).
- Handle `409 BOOKING_SLOT_LOCKED` (someone else holds it) and `409 BOOKING_SLOT_NOT_LOCKED` (lock expired → re-lock).

### Step 7 — Pay and confirm

- `POST /api/bookings/:id/pay` with `{ gateway, channel }`.
- Poll `GET /api/bookings/:id/payment-status` (or rely on payment webhooks) until `paymentStatus: paid`.

---

## Phase 3 — Vendor booking management (vendor app)  → [vendor/bookings.md](./vendor/bookings.md)

These are independent of each other; build as needed.

- **Step 8** — List + calendar: `GET /api/vendor/bookings`, `GET /api/vendor/bookings/calendar`, `GET /api/vendor/bookings/:id`.
- **Step 9** — Status transitions: `PATCH /api/vendor/bookings/:id/status` (enforces the [state machine](./vendor/bookings.md#booking-status-state-machine)).
- **Step 10** — Reschedule (lock the new slot first) / cancel: `PATCH .../reschedule`, `POST .../cancel`.
- **Step 11** — Mark a cash booking paid: `PATCH .../payment-status`.
- **Step 12** — Complete + settle final price: `POST /api/vendor/bookings/:id/complete` — recomputes the price from the actual elapsed duration (or a flat `fixedPrice`) and returns `finalPrice` + `additionalAmountDue`. **Note:** the additional-payment request to the customer is currently **stubbed** (the shortfall is recorded/returned but no charge is created). See [vendor/bookings.md](./vendor/bookings.md).

---

## Conventions that apply everywhere

- **Auth:** send the `access_token` cookie (browser) or `Authorization: Bearer <token>`. The calendar **connect** step must run as a browser navigation so it carries the cookie and can redirect.
- **Success envelope:** `{ "success": true, "data": ... }` (booking management adds `meta` for lists).
- **Error envelope:** `{ "success": false, "requestId": "...", "error": { "code", "message", "statusCode", "details?" } }`. Match on `error.code`. Validation failures use `VALIDATION_ERROR` with `details.fields: [{ path, message, code }]`.
- **Money:** `priceSnapshot` / `price.amount` are in the smallest currency unit (e.g. `5000` = 50.00 XAF).

---

## Quick map

| Need | Doc |
|------|-----|
| Connect/inspect Google Calendar | [vendor/calendar.md](./vendor/calendar.md) |
| Create service product | [vendor/products.md](./vendor/products.md#service-products) |
| Create the service variant (`serviceConfig` + price) | [vendor/variants.md](./vendor/variants.md) |
| Weekly availability rules | [vendor/availability-rules.md](./vendor/availability-rules.md) |
| Customer slot → lock → book → pay | [customer/bookings.md](./customer/bookings.md) |
| Vendor manages bookings | [vendor/bookings.md](./vendor/bookings.md) |
