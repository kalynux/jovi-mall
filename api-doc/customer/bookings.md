# Customer Booking Flow API

**Verified against source on 2026-09-08** — the reschedule rules for single-occupancy and capacity services, `bookingNumber`, and the slot error codes, against `src/modules/booking/` (`booking.service.ts`, `group-booking.service.ts`, `slot-lock.service.ts`, `models/booking.model.ts`).

Complete API reference for the **customer-facing** booking flow on service products: discover slots → lock a slot → create a booking → pay.

> [!NOTE]
> New to this feature? Read the [step-by-step implementation guide](../booking-implementation-guide.md) first for the full build order.
>
> This document covers the **customer** side. Vendors manage incoming bookings via [vendor/bookings.md](../vendor/bookings.md), and configure their schedule via [vendor/availability-rules.md](../vendor/availability-rules.md). For how a vendor creates the bookable service product itself, see [vendor/products.md](../vendor/products.md#service-products).

---

## The Flow

```
1. GET  /api/products/:productId/availability      → list bookable slots   (public)
2. POST /api/products/:productId/slots/:slotId/lock → hold a slot 15 min    (auth)
3. POST /api/products/:productId/book               → create the booking    (auth)
4. POST /api/bookings/:id/pay                        → pay for the booking   (auth)
   GET  /api/bookings/:id/payment-status            → poll payment state    (auth)
```

A slot **must be locked by the same user** before it can be booked. Locks auto-expire after 15 minutes. Booking creation releases the lock automatically. If the customer abandons the flow, call the `unlock` endpoint (or just let the lock expire).

After booking, the customer manages the appointment through **[Managing your bookings](#managing-your-bookings)** below.

---

## Managing your bookings

Everything after the purchase lives under `/api/customer/bookings` (beside `/api/customer/orders`). All four require the **customer** role and are scoped to the caller — another customer's booking id returns `404`, never `403`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/customer/bookings` | List your bookings. Query: `status`, `paymentStatus`, `startDate`, `endDate`, `page`, `limit`. Returns `{ data, meta: { total, page, limit, totalPages } }`. |
| `GET` | `/api/customer/bookings/:id` | One booking, with product and vendor populated. |
| `POST` | `/api/customer/bookings/:id/cancel` | Cancel. Body: `{ reason? }`. Subject to the vendor's cancellation policy. |
| `PATCH` | `/api/customer/bookings/:id/reschedule` | Move to another slot. Body: `{ newSlotId }`. **Lock the new slot first** (step 2 above). `pending`/`confirmed` only. Works for capacity services — see below. |
| `GET` | `/api/customer/bookings/:id/balance` | What is still owed after completion (and what was overpaid). |
| `POST` | `/api/customer/bookings/:id/pay-balance` | Pay that balance. Body: `{ provider, channel }` — same shape as step 4. |

🆕 **2026-10-05 — every booking returned by the list, the single read and the cancel now carries a `refund` key**: the latest refund request for that booking in the customer vocabulary (`requested · sending · in_progress · completed · declined` — `waiting_for_cash` never applies to a booking), with `grossAmount`, `feeAmount`, `feePercent`, `netAmount`, `currency`, `channel`, `destinationMasked`, `waitingForCash`, `completedAt`; `null` when no refund was ever requested. The shape, the status table and the fee line are documented once, in [orders.md § The `refund` block](./orders.md#the-refund-block). The booking document is otherwise unchanged.

---

## Rescheduling a capacity service

Moving a seat in a group class works exactly like moving an ordinary booking — lock the target
slot, then `PATCH .../reschedule` — but two of the answers differ, because a class is not a
free/busy question:

- **A class with other people in it is still movable into.** The check is "are there fewer than
  `maxBookings` seats taken", not "is this interval free". Moving into a 3-of-8 class succeeds
  and makes it 4 of 8.
- **A full class answers `409 BOOKING_SLOT_FULL`**, not `BOOKING_SLOT_UNAVAILABLE`. Show the
  seat count and offer another slot rather than reporting a clash.

Everything else is the same, including that the hold must be taken through
`POST /api/products/:productId/slots/:slotId/lock` — for a capacity service that hold is
namespaced to you, which is what lets several customers hold the same class at once.

> ⚠ **Before 2026-09-06 this always failed with `409 BOOKING_SLOT_NOT_LOCKED`**, however
> correct the request was, because the reschedule looked for the hold under a different key
> from the one the lock endpoint writes. A client that special-cased capacity services out of
> its reschedule UI can stop doing so.

---

## Paying a balance

A service can run longer, or cost more, than the slot you booked. When the provider settles the appointment above what you have paid, the difference becomes a **balance** — and it is **never charged automatically**. You agreed to the quoted price, not to whatever is settled afterwards, so paying it is your action.

You will get a `booking.balance.due` notification explaining why more is owed. Then either:

- **Pay online** — `POST /api/customer/bookings/:id/pay-balance` with the same `{ provider, channel }` body as the original payment. Re-read `GET /api/payments/options` first: the providers on offer may have changed since the booking was paid. This creates a **second** payment against the booking.
- **Pay the provider directly** — they record it with `POST /api/vendor/bookings/:id/settle-balance` and the balance closes.

Check what is outstanding at any time:

```http
GET /api/customer/bookings/:id/balance
```

```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439011",
    "currency": "XAF",
    "quotedPrice": 5000,
    "finalPrice": 12500,
    "balanceDue": 7500,
    "balancePaid": 0,
    "outstanding": 7500,
    "balancePaymentMethod": null,
    "creditDue": 0,
    "settledAt": "2026-08-10T16:30:00.000Z"
  }
}
```

**Errors:** `409 BOOKING_NOT_COMPLETED` (the appointment has not been settled yet) · `400 BOOKING_NO_BALANCE_DUE` · `409 BOOKING_BALANCE_ALREADY_SETTLED`.

> **`creditDue` is recorded, not refunded.** If the provider settles *below* what you already paid, the difference appears here and is visible on the booking, but no automatic refund is issued — that is usually a goodwill discount the provider intends to hand back themselves. Contact them, or open a support ticket.

**Cancelling and your money.** If the booking was paid, cancelling refunds it:

- **A card payment** is refunded in full through the card, automatically.
- **A mobile-money payment** is sent back by transfer to the number that paid, automatically, **minus a 2% transfer fee** (5,000 → you receive 4,900). The `refund` block on the cancel response already says `sending` (or `completed`).
- **No paying number on record** — the refund waits for the team (`refund.status: "requested"`, `paymentStatus: refund_pending`) and is sent once an administrator confirms where to send it.
- The cancellation still succeeds either way; a refund problem never keeps the appointment on the books. Read the `refund` block for where the money is — see [orders.md § The `refund` block](./orders.md#the-refund-block). *(Rewritten 2026-10-05: this used to say My-CoolPay bookings could not be refunded automatically. Every mobile-money gateway now refunds by transfer.)*

**Cancellation can be refused.** The vendor sets the policy, and `422 CANCELLATION_NOT_ALLOWED` means their window has passed (its `details` carry `cancellable` and `deadline`). A `completed` or `no-show` booking returns `409 BOOKING_NOT_CANCELLABLE`.

**Unpaid bookings expire.** A `confirmed` booking left unpaid is auto-cancelled after a grace period (24h by default) and its slot released. `pending` bookings awaiting vendor approval are never swept — the wait is not the customer's fault.

**You will be told.** Bookings now drive customer notifications — placed, confirmed, moved, cancelled, completed, paid, refunded, plus a reminder ~24 hours before the appointment. See [notifications.md](./notifications.md) for the inbox, the channels, and what can be switched off (money and cancellations cannot).

---

## Authentication

| Endpoint | Auth |
|----------|------|
| `GET .../availability` | **Public** — no token required |
| `POST .../slots/:slotId/lock` | Bearer token (any authenticated user) |
| `POST .../slots/:slotId/unlock` | Bearer token (any authenticated user) |
| `POST .../book` | Bearer token (any authenticated user) |
| `POST /api/bookings/:id/pay` | Bearer token, **customer** role |
| `GET /api/bookings/:id/payment-status` | Bearer token, **customer** (owner) or **vendor** (owner) |
| `GET|POST|PATCH /api/customer/bookings/...` | Bearer token, **customer** role (owner) |

```
Authorization: Bearer <access_token>
```

All responses use the standard envelope: `{ "success": true, "data": ... }` on success, `{ "success": false, "error": { code, message } }` on failure.

---

## Get Available Slots

```http
GET /api/products/:productId/availability
```

Returns the bookable slots for a service product within a date range. Slots are derived from the product's active [availability rules](../vendor/availability-rules.md), the product's `serviceConfig.durationMinutes`, and the vendor's external (Google Calendar) busy times.

> [!NOTE]
> This endpoint works whether or not the vendor has connected a Google Calendar. If no calendar is connected, slots reflect the availability rules only (the vendor's external busy times are not subtracted). Note that **creating** a booking still requires the vendor to have a connected calendar — see [Google Calendar connection](../vendor/calendar.md).

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `productId` | string | The service product ID |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fromDate` | ISO datetime | **Yes** | Start of the range (ISO 8601) |
| `toDate` | ISO datetime | **Yes** | End of the range (ISO 8601) |

**Response:** `200 OK`

```json
{
  "success": true,
  "data": {
    "slots": [
      {
        "id": "slot_1739365200000_1739372400000_a1b2c3d4",
        "start": "2026-02-12T13:00:00.000Z",
        "end": "2026-02-12T15:00:00.000Z",
        "available": true
      }
    ]
  }
}
```

**Slot object:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Opaque slot identifier. Format: `slot_{startMs}_{endMs}_{hash}`. Pass it verbatim to the lock and book endpoints — do not construct or mutate it. |
| `start` | ISO datetime | Slot start (UTC) |
| `end` | ISO datetime | Slot end (UTC) |
| `available` | boolean | Bookable now. `true` for single-occupancy products; for capacity products, `true` while seats remain and `false` when full. |
| `maxBookings` | number | **Capacity products only.** Total seats per slot. Omitted for calendar/manual products. |
| `spotsRemaining` | number | **Capacity products only.** Seats still open (`0` when full). Use it to render "N spots left". |

> [!NOTE]
> **Capacity products** (`bookingMode: "capacity"`) allow multiple customers to book the
> same slot. Such slots include `maxBookings`/`spotsRemaining`, and full slots are returned
> with `available: false` so the UI can show "Full". For calendar/manual products every
> returned slot is single-occupancy and `available` is always `true`.

**Error Responses:**

- `400 VALIDATION_ERROR`: `fromDate`/`toDate` missing or not valid ISO 8601
- `404 CATALOG_BOOKING_PRODUCT_NOT_FOUND`: Product does not exist
- `422 CATALOG_BOOKING_INVALID_PRODUCT_TYPE`: Product is not a service product
- `422 CATALOG_BOOKING_MISSING_SERVICE_CONFIG`: Product has no `serviceConfig`

---

## Lock a Slot

```http
POST /api/products/:productId/slots/:slotId/lock
```

Place a short-lived hold on a slot so another customer cannot book it while this customer checks out. The lock is owned by the authenticated user and lasts **15 minutes**.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `productId` | string | The service product ID |
| `slotId` | string | The slot `id` from the availability response |

**Request Body:** *(none)*

**Response:** `200 OK`

```json
{
  "success": true,
  "data": {
    "locked": true,
    "slotId": "slot_1739365200000_1739372400000_a1b2c3d4",
    "expiresAt": "2026-02-12T12:15:00.000Z"
  }
}
```

**Error Responses:**

- `401 AUTH_MISSING_TOKEN`: Not authenticated
- `409 BOOKING_SLOT_LOCKED`: The slot is already locked by another user

---

## Unlock a Slot

```http
POST /api/products/:productId/slots/:slotId/unlock
```

Release a lock the caller owns (e.g. the customer cancelled checkout). Idempotent — releasing a lock you do not own, or one that already expired, returns `released: false` without error.

**Request Body:** *(none)*

**Response:** `200 OK`

```json
{
  "success": true,
  "data": {
    "released": true,
    "slotId": "slot_1739365200000_1739372400000_a1b2c3d4"
  }
}
```

**Error Responses:**

- `401 AUTH_MISSING_TOKEN`: Not authenticated

---

## Create a Booking

```http
POST /api/products/:productId/book
```

Create a booking for a slot the caller has locked. The slot lock is released on success. The resulting `status` depends on the service variant's `serviceConfig.bookingMode`:

- **`calendar`** (default): the booking is created `confirmed` and a calendar event is created on the vendor's connected calendar immediately.
- **`manual`**: the booking is created `pending` with **no** calendar event. The vendor must accept it (`PATCH /api/vendor/bookings/:id/status` → `confirmed`), which then creates the calendar event.
- **`capacity`**: the booking is created `confirmed`. The slot accepts up to `maxBookings`
  seats; all seats share one calendar event. If the slot filled up since you fetched
  availability, the request fails with `409 BOOKING_SLOT_FULL`.

In all cases `paymentStatus` starts as `unpaid`.

> [!IMPORTANT]
> The slot must be locked by **this same user** first (see Lock a Slot). The user ID is used as the lock owner.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `productId` | string | The service product ID |

**Request Body:**

```json
{
  "slotId": "slot_1739365200000_1739372400000_a1b2c3d4",
  "metadata": {
    "notes": "I have very long hair",
    "customerEmail": "customer@example.com"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slotId` | string | **Yes** | Slot `id` to book (must be locked by the caller) |
| `metadata` | object | No | Free-form notes carried onto the booking and the calendar event (e.g. `notes`, `customerEmail`) |

**Response:** `201 Created`

```json
{
  "success": true,
  "data": {
    "booking": {
      "id": "507f1f77bcf86cd799439011",
      "bookingNumber": "BKG-2026-000123",
      "productId": "507f1f77bcf86cd799439012",
      "userId": "507f1f77bcf86cd799439013",
      "vendorId": "507f1f77bcf86cd799439014",
      "startAt": "2026-02-12T13:00:00.000Z",
      "endAt": "2026-02-12T15:00:00.000Z",
      "status": "confirmed",
      "paymentStatus": "unpaid",
      "priceSnapshot": 5000,
      "currency": "XAF",
      "requiresPayment": true,
      "externalCalendarEventId": "abcd1234xyz",
      "metadata": { "notes": "I have very long hair" }
    },
    "price": {
      "amount": 5000,
      "currency": "XAF",
      "breakdown": { "basePrice": 5000, "peakHoursSurcharge": 0 }
    }
  }
}
```

`priceSnapshot` and `price.amount` are in the smallest currency unit (e.g. `5000` = 50.00 XAF). The booking is now awaiting payment — proceed to **Pay for a Booking**.

> [!NOTE]
> **`bookingNumber`** is the booking's human-readable handle — `BKG-2026-000123`, the same shape
> as an order's `ORD-2026-000123`. It is generated at creation, never editable, and it is the
> string to show the customer and to quote to the vendor or to support. It appears on every
> booking read here and on the vendor's side of the same booking.
>
> **It is `null` on bookings created before the field existed** — show a fallback rather than a
> bare `#`. And it is **not a count**: a booking that fails after the number is drawn burns it, so
> `BKG-2026-000042` does not mean "the 42nd booking of 2026". Requests still take `id`.

> **How the price is computed.** The service product's single variant holds a base `price` per `serviceConfig.durationMinutes`. The backend prorates it by the booked slot duration and adds a peak-hours surcharge for any minutes overlapping the vendor's peak window — `price.breakdown` shows `basePrice` and (when applicable) `peakHoursSurcharge`. The final amount may be recomputed by the vendor at completion if the appointment runs longer.

**Error Responses:**

- `400 VALIDATION_ERROR`: `slotId` missing
- `401 AUTH_MISSING_TOKEN`: Not authenticated
- `400 BOOKING_INVALID_SLOT_ID`: `slotId` is malformed
- `409 BOOKING_SLOT_NOT_LOCKED`: Slot is not locked, or the lock expired
- `403 BOOKING_UNAUTHORIZED`: Slot is locked by a different user
- `409 BOOKING_SLOT_FULL`: Capacity slot reached `maxBookings` (no seats left)
- `404 CATALOG_BOOKING_PRODUCT_NOT_FOUND`: Product does not exist
- `422 CATALOG_BOOKING_INVALID_PRODUCT_TYPE`: Product is not a service product
- `422 CATALOG_BOOKING_PRODUCT_NOT_ACTIVE`: Product is not `active`
- `422 CATALOG_BOOKING_MISSING_SERVICE_CONFIG`: Product's default variant has no `serviceConfig`
- `422 CATALOG_BOOKING_INVALID_PRICE`: Product has no usable default variant price for the booking

---

## Pay for a Booking

```http
POST /api/bookings/:id/pay
```

Initiate online payment for a booking the customer owns. The customer picks a **provider** from `GET /api/payments/options`; the server picks the aggregator. Same rules as the order checkout: [../payments/README.md](../payments/README.md#get-paymentsoptions--what-the-customer-can-pay-with).

**Authorization:** customer role; must own the booking.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | The booking ID |

**Request Body:**

```json
{
  "provider": "ORANGE",
  "channel": {
    "phoneNumber": "+237690000000",
    "customerEmail": "customer@example.com",
    "customerName": "Jane Doe"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | **Yes** (see note) | `MTN` \| `ORANGE` \| `MOOV` \| `CARD`: one of the providers `GET /api/payments/options` lists |
| `channel` | object | No (defaults `{}`) | The fields the provider's `/options` entry lists in `fields`. For mobile money that is `phoneNumber` (**E.164**, e.g. `+237690000000`), and it must be on the chosen network. An optional `customerEmail` must be a valid address. See [Contact formats](../README.md#contact-formats-phone--email). `phoneOperator` is legacy: do not send it |
| `gateway` | string | No | **Deprecated. Accepted and ignored**; the server picks the aggregator. Stop sending it |

`provider` is optional on the wire only so that builds released before 2026-09-30 keep working; the server then derives it (see [the derivation order](../payments/README.md#request-body)). A current client always sends it.

**Response:** `200 OK`

```json
{
  "success": true,
  "data": {
    "transactionId": "664txn...",
    "status": "PENDING",
    "provider": "ORANGE",
    "instructions": { "ussdCode": "#150*50#", "message": "Confirm the prompt on your phone" },
    "message": "Payment initiated"
  }
}
```

`data` is the same result `POST /api/payments/initiate` returns flat, here under `data`. `provider` is the resolved provider on a new attempt, or the stored one (possibly `null`) when a live attempt was reused. There is no `gateway`.

Branch on `data.instructions`, never on the aggregator: `requiresOtp: true` means collect the SMS code and send it to `POST /api/payments/:transactionId/authorize`; `clientSecret` means a card confirmed with Stripe.js; otherwise the customer approves the prompt on the handset. See [the instructions object](../payments/README.md#the-instructions-object--branch-on-it-do-not-assume). Poll **Get Payment Status** (or rely on payment webhooks) to learn when the booking becomes `paid`.

**Error Responses:**

- `400 VALIDATION_ERROR`: `channel` missing, or a field the provider requires (e.g. `channel.phoneNumber`) missing
- `400 PAYMENT_PROVIDER_REQUIRED`: no `provider`, and none could be derived from an old-style body
- `422 PAYMENT_PROVIDER_UNAVAILABLE`: the provider is switched off or cannot be routed right now. `details.offered` is the fresh list
- `422 PAYMENT_PROVIDER_PHONE_MISMATCH`: the number belongs to another network. `details.detected` names it; nothing was charged
- `404 BOOKING_NOT_FOUND`: Booking does not exist
- `403 BOOKING_UNAUTHORIZED`: You can only pay for your own bookings

---

## Get Payment Status

```http
GET /api/bookings/:id/payment-status
```

Read the current payment state of a booking. Accessible by the customer who owns the booking, or the vendor who owns it.

**Response:** `200 OK`

```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439011",
    "paymentStatus": "paid",
    "paymentMethod": "online",
    "priceSnapshot": 5000,
    "currency": "XAF",
    "requiresPayment": true,
    "transaction": {
      "id": "507f1f77bcf86cd799439099",
      "status": "succeeded",
      "provider": "MTN",
      "gateway": "NOTCHPAY",
      "gatewayRef": "notch_abc123"
    }
  }
}
```

`transaction` is `null` if no payment has been initiated yet. `transaction.provider` is what the customer paid with, or `null` on a payment opened before 2026-09-30. `transaction.gateway` is **informational only** (which aggregator carried the money): never branch on it, and accept values you do not know.

> **Use this, not `GET /api/payments/:transactionId`, for bookings.** This endpoint is already scoped
> to both parties — the customer who booked *and* the vendor who owns it — and returns the booking's
> `paymentStatus` alongside the transaction.
>
> The generic payments read is **owner-only**: since 2026-07-29 it requires authentication and
> returns a `404` for anyone but the payer (or an admin), so a **vendor cannot** use it to inspect a
> booking's payment even for their own booking. See [../payments/README.md](../payments/README.md).

**Error Responses:**

- `404 BOOKING_NOT_FOUND`: Booking does not exist
- `403 BOOKING_UNAUTHORIZED`: You do not have access to this booking

---

## Booking Lifecycle Reference

Bookings created through this flow start `unpaid`, and `confirmed` (calendar and capacity modes) or `pending` (manual mode — awaiting vendor acceptance). The full enums (shared with the vendor API):

**`status`:** `pending` · `confirmed` · `completed` · `no-show` · `cancelled`
**`paymentStatus`:** `unpaid` · `pending` · `paid` · `disputed` · `failed` · `refund_pending` · `refunded`

`refund_pending` means money is owed back and has not reached the customer yet — a refund request is waiting for the team. It is **not** `refunded`: the customer does not have their money yet. Read the booking's `refund` block for the detail (status, net amount, fee). 🆕 2026-10-05

See [vendor/bookings.md](../vendor/bookings.md#booking-status-state-machine) for the status state machine and the vendor-side transitions (confirm, complete, no-show, cancel, reschedule).

> **Cancellation policy.** A customer-initiated booking cancellation is gated by the
> vendor's `cancellation_policy` (the `cancellable` flag and `cancellation_deadline`,
> evaluated against the booking's `startAt`). When the policy disallows it, the cancel
> request returns `422 CANCELLATION_NOT_ALLOWED` with a `details` object describing the rule.
> Cancel via `POST /api/customer/bookings/:id/cancel`.

### Times and timezones

Availability is computed in the **vendor's** timezone (`Vendor.timezone`, e.g. `Africa/Douala`), or a per-rule override when the vendor set one. A rule reading "Monday 09:00–17:00" means those hours *where the vendor is*, not where the server runs. All timestamps on the wire are ISO-8601 UTC — convert for display.

### What blocks a slot

A slot is unavailable when **any** of these holds:

1. The product already has enough active (`pending` or `confirmed`) bookings covering it — one for a normal service, `maxBookings` for a capacity service. **A `manual` booking blocks its slot immediately**, before the vendor accepts it.
2. The vendor's external calendar shows them busy then (plus any configured before/after buffer).
3. No active availability rule covers it.

Point 1 is decided from the platform's own booking records, so availability stays correct even when the vendor has no calendar connected.

---

## Error Response Format

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "BOOKING_SLOT_NOT_LOCKED",
    "message": "Human-readable description",
    "statusCode": 409,
    "category": "conflict"
  }
}
```

| Code | HTTP | Where |
|------|------|-------|
| `VALIDATION_ERROR` | 400 | Missing/invalid query or body |
| `AUTH_MISSING_TOKEN` | 401 | Lock/unlock/book without auth |
| `BOOKING_INVALID_SLOT_ID` | 400 | Malformed `slotId` |
| `BOOKING_SLOT_LOCKED` | 409 | Lock — slot held by another user |
| `BOOKING_SLOT_NOT_LOCKED` | 409 | Book — slot not locked / lock expired |
| `BOOKING_SLOT_FULL` | 409 | Book **or reschedule** — capacity slot is full (`maxBookings` reached) |
| `BOOKING_SLOT_UNAVAILABLE` | 409 | Book/reschedule — someone took that interval first. **Single-occupancy services only** — a capacity service answers `BOOKING_SLOT_FULL` instead, because a class with other people already in it is not "taken" |
| `BOOKING_NOT_RESCHEDULABLE` | 409 | Reschedule — booking is not `pending`/`confirmed` |
| `BOOKING_NOT_CANCELLABLE` | 409 | Cancel — booking is `completed` or `no-show` |
| `BOOKING_ALREADY_CANCELLED` | 409 | Cancel — already cancelled |
| `CANCELLATION_NOT_ALLOWED` | 422 | Cancel — the vendor's policy window has passed |
| `BOOKING_UNAUTHORIZED` | 403 | Slot/booking owned by another user |
| `BOOKING_NOT_FOUND` | 404 | Booking missing, or not yours |
| `CATALOG_BOOKING_PRODUCT_NOT_FOUND` | 404 | Product missing |
| `CATALOG_BOOKING_INVALID_PRODUCT_TYPE` | 422 | Product is not a service |
| `CATALOG_BOOKING_PRODUCT_NOT_ACTIVE` | 422 | Product not `active` |
| `CATALOG_BOOKING_MISSING_SERVICE_CONFIG` | 422 | Product has no `serviceConfig` |
| `CATALOG_BOOKING_INVALID_PRICE` | 422 | No usable variant price |
