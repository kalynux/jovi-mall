# Customer Booking Flow API

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
| `PATCH` | `/api/customer/bookings/:id/reschedule` | Move to another slot. Body: `{ newSlotId }`. **Lock the new slot first** (step 2 above). `pending`/`confirmed` only. |
| `GET` | `/api/customer/bookings/:id/balance` | What is still owed after completion (and what was overpaid). |
| `POST` | `/api/customer/bookings/:id/pay-balance` | Pay that balance. Body: `{ gateway, channel }` — same shape as step 4. |

---

## Paying a balance

A service can run longer, or cost more, than the slot you booked. When the provider settles the appointment above what you have paid, the difference becomes a **balance** — and it is **never charged automatically**. You agreed to the quoted price, not to whatever is settled afterwards, so paying it is your action.

You will get a `booking.balance.due` notification explaining why more is owed. Then either:

- **Pay online** — `POST /api/customer/bookings/:id/pay-balance` with the same `{ gateway, channel }` body as the original payment. This creates a **second** payment against the booking.
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

- Where the payment gateway supports refunds, the money is returned automatically and `paymentStatus` becomes `refunded`.
- Otherwise — **cash bookings, and My-CoolPay, whose API has no refund endpoint** — `paymentStatus` becomes `refund_pending` and a support ticket is raised for manual payout. The cancellation still succeeds either way; a refund problem never keeps the appointment on the books.

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
      "_id": "507f1f77bcf86cd799439011",
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

Initiate online payment for a booking the customer owns. Delegates to the payment orchestrator for the selected gateway.

**Authorization:** customer role; must own the booking.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | The booking ID |

**Request Body:**

```json
{
  "gateway": "NOTCHPAY",
  "channel": {
    "phoneNumber": "+237650000000",
    "phoneOperator": "MTN",
    "customerEmail": "customer@example.com",
    "customerName": "Jane Doe"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `gateway` | string | **Yes** | One of `NOTCHPAY`, `MYCOOLPAY`, `STRIPE` |
| `channel` | object | **Yes** | Gateway-specific payer details. For mobile-money gateways supply `phoneNumber` (**E.164**, e.g. `+237650000000`) / `phoneOperator`; fields vary per gateway. An optional `customerEmail` must be a valid address. See [Contact formats](../README.md#contact-formats-phone--email). |

**Response:** `200 OK`

```json
{
  "success": true,
  "data": { "...": "gateway-specific payment initiation result (transaction reference, status, redirect/USSD info)" }
}
```

The exact `data` shape depends on the gateway. Poll **Get Payment Status** (or rely on payment webhooks) to learn when the booking becomes `paid`.

**Error Responses:**

- `400 VALIDATION_ERROR`: `gateway` or `channel` missing, or `gateway` not one of the supported values
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
      "gateway": "NOTCHPAY",
      "gatewayRef": "notch_abc123"
    }
  }
}
```

`transaction` is `null` if no payment has been initiated yet.

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

`refund_pending` means money is owed back but the gateway could not return it automatically — a human completes the payout from a support ticket. It is **not** `refunded`: the customer does not have their money yet.

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
  "error": {
    "code": "BOOKING_SLOT_NOT_LOCKED",
    "message": "Human-readable description"
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
| `BOOKING_SLOT_FULL` | 409 | Book — capacity slot is full (`maxBookings` reached) |
| `BOOKING_SLOT_UNAVAILABLE` | 409 | Book/reschedule — someone took that interval first |
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
