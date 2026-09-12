# Vendor Booking Management API

**Source changed 2026-09-09 (DOC-PROGRAM close-out § 6, item 2)** — the calendar view's day key
now groups in the **vendor's timezone** rather than the server's, and the response carries
`meta.timezone`. The two ⚠ boxes this page kept about that defect are gone; the fix is described in
[Calendar View](#calendar-view). Nothing else on this page changed.

**Verified against source on 2026-09-08** — R7 re-checked the nine routes (`modules/booking/routes/vendor-booking.routes.ts:23-86`), the payment enum (`models/booking.model.ts:159`), the transition map (`services/booking.service.ts:684-689`) and the refunding vs non-refunding cancel paths (`:377-386` vs `:709-746`). **One defect fixed:** the § summary at the end still described the calendar-view key as `YYYY-MM-DD` **(UTC)** — the exact claim the ⚠ box earlier on this page corrects. It is the server local day (`format(booking.startAt, ...)`, `:1017`).

**Verified against source on 2026-09-06** — every claim on this page was checked against
`jovi-mall/src/`, including the whole inherited defect list that `vendor-dash` carried for it
(DOC-PROGRAM § 24–26). Corrections are marked inline with ⚠ and a source citation.

Complete API reference for managing bookings in the multi-vendor ecommerce platform.

> **Booking system docs:** [Implementation guide](../booking-implementation-guide.md) · [Service product setup](./products.md#service-products) · [Availability rules](./availability-rules.md) · [Google Calendar](./calendar.md) · [Customer booking flow](../customer/bookings.md) · **Vendor booking management** (this doc)

> [!IMPORTANT]
> **Authentication Required**
> All endpoints require:
> - Bearer token in `Authorization` header
> - Vendor role
> - Vendor can only access their own bookings

---

## Table of Contents

- [List Bookings](#list-bookings)
- [Get Booking](#get-booking)
- [Calendar View](#calendar-view)
- [Update Booking Status](#update-booking-status)
- [Complete Booking (settle final price)](#complete-booking-settle-final-price)
- [Mark Cash Booking as Paid](#mark-cash-booking-as-paid)
- [Reschedule Booking](#reschedule-booking)
- [Cancel Booking](#cancel-booking)
- [Booking Status State Machine](#booking-status-state-machine)
- [Error Codes](#error-codes)

---

## List Bookings

```http
GET /api/vendor/bookings
```

List all bookings for the authenticated vendor with filtering and pagination.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by booking status: `pending`, `confirmed`, `completed`, `no-show`, `cancelled` |
| `paymentStatus` | string | No | Filter by payment state: `unpaid`, `pending`, `paid`, `disputed`, `failed`, `refund_pending`, `refunded` |
| `productId` | string | No | Filter by product (service) ID |
| `startDate` | ISO datetime | No | Bookings starting at or after this date |
| `endDate` | ISO datetime | No | Bookings starting at or before this date |
| `page` | number | No | Page number (default: `1`) |
| `limit` | number | No | Items per page (default: `20`, max: `100`) |

> [!NOTE]
> All filters use AND logic. `startDate`/`endDate` filter on the booking's `startAt` field.

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439011",
      "bookingNumber": "BKG-2026-000123",
      "productId": { "id": "507f1f77bcf86cd799439012", "title": "1-Hour Consultation", "type": "service" },
      "userId": { "_id": "507f1f77bcf86cd799439013", "login_email": "customer@example.com" },
      "vendorId": "507f1f77bcf86cd799439014",
      "startAt": "2026-02-05T10:00:00.000Z",
      "endAt": "2026-02-05T11:00:00.000Z",
      "status": "confirmed",
      "paymentStatus": "paid",
      "paymentMethod": "cash",
      "paidAt": "2026-02-05T09:30:00.000Z",
      "priceSnapshot": 50000,
      "currency": "XAF",
      "requiresPayment": true,
      "externalCalendarEventId": "abcd1234xyz"
    }
  ],
  "meta": { "total": 45, "page": 1, "limit": 20, "totalPages": 3 }
}
```

> [!WARNING]
> **The three identifiers in that block genuinely differ, and this is not a typo to tidy up.**
> The booking and the populated product answer to **`id`**; the populated user answers to
> **`_id`**. jovi-mall has no global mongoose `toJSON` plugin, so the key is decided per model by
> whether it is built on `BaseSchemaOptions` (`src/core/base.schema.ts`), which deletes `_id` and
> exposes the `id` virtual. `Booking` and `Product` are; `User` is not. Populating does not change
> this — each child is serialised by its own schema.

> [!NOTE]
> **`bookingNumber`** is the booking's human-readable handle — `BKG-2026-000123`, deliberately
> the same shape as an order's `ORD-2026-000123`, since a vendor reads both on one screen. It is
> generated at creation, is never editable, and there is no endpoint that sets it. It is what the
> vendor's "new booking" notification names, what the calendar event's description carries, and
> what a customer will quote on the phone — so show it wherever a booking is identified.
>
> **It is `null` on bookings created before the field existed**, and those are deliberately not
> backfilled (there is no production data; see `PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md`
> D-5). Render a fallback rather than an empty `#`.
>
> ⚠ **It is not a count.** The sequence is drawn before the booking row is written, so a booking
> that then fails burns its number — `BKG-2026-000042` does **not** mean "the 42nd booking of
> 2026". Do not derive a total from it. Use `id`, never `bookingNumber`, in a request path.

> [!NOTE]
> **`priceSnapshot`** is captured when the booking is created, computed by the backend from the service product's single default variant: `variant.price` is the base price per `serviceConfig.durationMinutes`, prorated by the booked slot duration, plus any peak-hours surcharge. On completion it can be recomputed from the actual elapsed duration — see [Complete Booking](#complete-booking-settle-final-price).

---

## Get Booking

```http
GET /api/vendor/bookings/:id
```

Retrieve a single booking by ID.

**Error Responses:**

- `404 BOOKING_NOT_FOUND`: Booking not found or doesn't belong to vendor

---

## Calendar View

```http
GET /api/vendor/bookings/calendar
```

Returns bookings grouped by date for calendar display. Single query, no N+1.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `startDate` | ISO datetime | **Yes** | Start of range (inclusive). Filters on the booking's `startAt`. |
| `endDate` | ISO datetime | **Yes** | End of range (inclusive, max 90 days from startDate). Filters on the booking's `startAt`. |

> [!NOTE]
> A booking is included when its **`startAt`** falls within `[startDate, endDate]`, regardless of when it ends. Results are grouped under the `YYYY-MM-DD` of each booking's `startAt`.
>
> **The day key is the vendor's own wall-clock day**, and the zone it was computed in comes back
> as **`meta.timezone`**. So `meta.timezone` is the one thing you need to re-derive a key from
> `startAt` and agree with the server: format the instant in that zone, not in UTC and not in the
> browser's zone.
>
> The zone is `Vendor.timezone` — the same one availability rules are authored in — falling back to
> `BOOKING_CONFIG.defaultTimezone` (`Africa/Douala`) only if the vendor lookup fails.
>
> ✅ **Fixed at source 2026-09-09, and `meta.timezone` is new with the fix.** Until then the key
> was `format(booking.startAt, 'yyyy-MM-dd')` — date-fns' `format`, which renders in the **process**
> timezone — under a source comment that said UTC. It was neither. A booking at `23:30Z` landed
> under the next day on a server running UTC+1, the grouping moved if the host's zone changed, and
> a client re-deriving the day in UTC disagreed with the key it had been given. This page carried
> that warning in two places from 2026-09-06; both are now this note.

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "date": "2026-02-05",
      "bookings": [
        {
          "bookingId": "507f1f77bcf86cd799439011",
          "startAt": "2026-02-05T10:00:00.000Z",
          "endAt": "2026-02-05T11:00:00.000Z",
          "status": "confirmed",
          "paymentStatus": "paid",
          "productId": "507f1f77bcf86cd799439012",
          "productTitle": "1-Hour Consultation",
          "customerEmail": "customer@example.com",
          "externalCalendarEventId": "abcd1234xyz"
        }
      ]
    }
  ],
  "meta": { "timezone": "Africa/Douala" }
}
```

> `data` keeps its array shape — `meta` was added beside it rather than wrapping the array, so
> existing clients that read `data` are unaffected.

**Error Responses:**

- `400 VALIDATION_ERROR`: `startDate` or `endDate` missing/invalid, or range exceeds 90 days

---

## Update Booking Status

```http
PATCH /api/vendor/bookings/:id/status
```

Update booking status with automatic calendar synchronization.

**Request Body:**

```json
{ "status": "confirmed" }
```

**Valid Status Values:** `pending`, `confirmed`, `completed`, `no-show`, `cancelled`

> [!NOTE]
> **Automatic Calendar Sync**
>
> - **`pending` → `confirmed`**: Creates a Google Calendar event
> - **`confirmed` → `cancelled`**: Deletes the calendar event
> - **`confirmed` → `no-show`**: No calendar action (terminal state)
>
> Calendar sync errors are logged but never block the status update.

**Error Responses:**

- `400 VALIDATION_ERROR`: Invalid `status` value
- `400 BOOKING_INVALID_STATUS_TRANSITION`: Transition not allowed by state machine
- `404 BOOKING_NOT_FOUND`: Booking not found

---

## Complete Booking (settle final price)

```http
POST /api/vendor/bookings/:id/complete
```

Mark a service appointment **completed** and settle its final price. The price is recomputed from the **actual elapsed duration** (the service variant's base price per `serviceConfig.durationMinutes`, prorated, plus any peak-hours surcharge), or taken as a flat `fixedPrice`. Transitions the booking `confirmed → completed` (the state machine still applies).

**Request Body** *(all optional; at most one pricing mode):*

| Field | Type | Notes |
|-------|------|-------|
| `actualEndAt` | string (ISO) | The time the service actually ended. Price is recomputed for `[startAt, actualEndAt]`. |
| `additionalMinutes` | number | Extra minutes beyond the booked end. Price is recomputed for the extended interval. |
| `fixedPrice` | number | A flat final price, regardless of duration. Cannot be combined with `actualEndAt`/`additionalMinutes`. |

Omitting all three settles at the originally booked duration.

**Response:**

```json
{
  "success": true,
  "data": {
    "booking": { "...": "...", "status": "completed" },
    "priceSnapshot": 5000,
    "finalPrice": 12500,
    "additionalAmountDue": 7500,
    "additionalAmountCharged": false,
    "additionalAmountNote": "Recorded only — not charged. Collect this from the customer directly.",
    "breakdown": { "basePrice": 12500, "peakHoursSurcharge": 0 }
  },
  "message": "Booking completed"
}
```

- `priceSnapshot` — the originally booked estimate.
- `finalPrice` — the recomputed (or flat) price; also recorded under `booking.metadata.completion`.
- `additionalAmountDue` — `max(0, finalPrice − amountPaid)`, where `amountPaid` is
  `priceSnapshot` when the booking is `paid` and **`0` otherwise**
  (`CompletionPricingService.ts:111-112`). **Compared against what was PAID, not what was
  quoted** — an unpaid booking owes the whole final price, not just the overrun.
- `additionalAmountCharged` — always `false`: the balance is requested, never charged automatically.
- `additionalAmountNote` — the sentence to show when a balance is outstanding, `null` otherwise.
- `breakdown` — present only when the price was recalculated.

> ⚠ **This list carried `additionalAmountDue` TWICE, with two different formulas, two lines
> apart** — `max(0, finalPrice − priceSnapshot)` and `max(0, finalPrice − amountPaid)` — until
> 2026-09-06. The second is right; the first is the pre-correction version that was left behind
> when the entry beneath it was fixed. Comparing against `priceSnapshot` **bills an unpaid
> customer only the overrun**, which is the bug `CompletionPricingService.ts:106-108` exists to
> explain: *"Comparing against `priceSnapshot` (as this used to) bills an unpaid customer…"*.
>
> ⚠ **`amountPaid` and `creditDue` were also listed here and are NOT on this response.** The
> controller returns exactly `booking`, `priceSnapshot`, `finalPrice`, `additionalAmountDue`,
> `additionalAmountCharged`, `additionalAmountNote` and `breakdown`
> (`vendor-booking.controller.ts:246-262`). Both values are computed internally and **persisted
> on `booking.settlement`** — read them from there (see the paragraph below), not from this
> payload.

The settled figures are persisted on `booking.settlement` (`finalPrice`, `balanceDue`, `balancePaid`, `creditDue`, `pricingMode`, `settledAt`), so an outstanding balance is queryable rather than buried in `metadata`.

**What happens next.** When `additionalAmountDue > 0` the customer receives a `booking.balance.due` notification explaining why more is owed, with a link to pay it. The platform does **not** charge them automatically — they agreed to the quoted price, not to whatever is settled afterwards. Settle it one of two ways:

- The customer pays online: `POST /api/customer/bookings/:id/pay-balance`.
- You take it in cash and record it: `POST /api/vendor/bookings/:id/settle-balance` (below).

> `creditDue` (settling *below* what the customer paid) is surfaced but **not refunded automatically** — that is usually a goodwill discount you intend to hand back yourself. Use the refund flow if you want the platform to return it.

---

## Settle Balance in Cash

```http
POST /api/vendor/bookings/:id/settle-balance
```

Record that the outstanding completion balance was collected in cash, on the day. A service business usually takes an overrun at the counter rather than chasing an online payment; without this the balance sits open forever on a booking you consider finished.

**Request Body** (optional):

```json
{ "amount": 3000 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `amount` | number | No | Partial settlement. Omit to settle the whole outstanding balance. Over-declaring is clamped to what is owed. |

**Response:**

```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439011",
    "balanceDue": 7500,
    "balancePaid": 7500,
    "outstanding": 0,
    "balancePaymentMethod": "cash"
  },
  "message": "Balance settled in cash"
}
```

The extra is split into platform commission + your net exactly as the original payment is, and matures immediately (the appointment is already complete).

**Error Responses:**

- `404 BOOKING_NOT_FOUND`
- `409 BOOKING_NOT_COMPLETED`: the booking has not been settled yet
- `400 BOOKING_NO_BALANCE_DUE`
- `409 BOOKING_BALANCE_ALREADY_SETTLED`

> Distinct from `PATCH /:id/payment-status`, which settles the **original** price of an unpaid cash booking. This one settles the **completion balance** on a booking that was already paid.

**Error Responses:**

- `400 VALIDATION_ERROR`: Invalid body, or `actualEndAt` not after the booking start
- `400 BOOKING_INVALID_STATUS_TRANSITION`: Booking is not `confirmed` (only confirmed bookings complete)
- `404 BOOKING_NOT_FOUND`: Booking not found

---

## Mark Cash Booking as Paid

```http
PATCH /api/vendor/bookings/:id/payment-status
```

Manually mark a cash booking as paid. Updates calendar color automatically.

**Rules:**
- Booking `paymentMethod` must be `cash` or unset
- `paymentStatus` must not already be `paid`
- `requiresPayment` must be `true`

**Request Body:** *(none required)*

**Response:**

```json
{
  "success": true,
  "data": {
    "bookingId": "507f1f77bcf86cd799439011",
    "paymentStatus": "paid",
    "paymentMethod": "cash",
    "paidAt": "2026-02-05T09:30:00.000Z"
  },
  "message": "Booking marked as paid"
}
```

**Error Responses:**

- `400 BOOKING_PAYMENT_NOT_REQUIRED`: Booking's `requiresPayment` is `false`
- `400 BOOKING_INVALID_PAYMENT_METHOD`: Booking has a non-cash payment method
- `409 BOOKING_ALREADY_PAID`: Booking is already marked as paid
- `404 BOOKING_NOT_FOUND`: Booking not found

---

## Reschedule Booking

```http
PATCH /api/vendor/bookings/:id/reschedule
```

Reschedule a booking to a new time slot. Updates the Google Calendar event.

> [!IMPORTANT]
> **Slot Lock Required**
>
> The vendor must lock the new slot via the slot-locking mechanism before calling this endpoint. The `vendorId` is used as the `lockOwnerId`.

**Eligibility:** Only `pending` or `confirmed` bookings can be rescheduled.

**Request Body:**

```json
{ "newSlotId": "slot_1739365200000_1739372400000_a1b2c3d4" }
```

> ⚠ **The example here read `slot-2026-02-10T14:00:00Z-60` until 2026-09-06 — that shape does
> not exist.** A slot id is `slot_{startMs}_{endMs}_{hash}`, built at
> `slot-generator.service.ts:48` as `` `slot_${start.getTime()}_${end.getTime()}_${hash}` ``.
> It is **opaque**: pass back exactly what `GET /availability` returned and never construct or
> mutate one. [customer/bookings.md](../customer/bookings.md#get-available-slots) had this right the
> whole time, so where the two pages disagreed, that one was correct.
>
> ⚠ Note the *source's own docstring* one line above the code says `slot_{startISO}_{endISO}`,
> which is also wrong — `getTime()` yields epoch milliseconds, not ISO. Do not take the
> comment as the contract; the template literal is.

**Error Responses:**

- `400 VALIDATION_ERROR`: `newSlotId` missing
- `404 BOOKING_NOT_FOUND`: Booking not found
- `409 BOOKING_NOT_RESCHEDULABLE`: Booking status doesn't allow rescheduling (must be `pending` or `confirmed`)
- `409 BOOKING_SLOT_NOT_LOCKED`: New slot is not locked, or the lock has expired
- `403 BOOKING_UNAUTHORIZED`: New slot is locked by a different owner
- `409 BOOKING_ALREADY_CANCELLED`: Booking is already cancelled
- ~~`500 BOOKING_CALENDAR_SYNC_FAILED`: Calendar event update failed~~ — **never sent.** Calendar mirroring is best-effort on every path; the throw was removed when it became so (`booking.service.ts:515`), and no site anywhere raises this code. A reschedule whose Google event fails to update returns `200` and logs.

---

## Cancel Booking

```http
POST /api/vendor/bookings/:id/cancel
```

Cancel a booking with an optional reason. Deletes the calendar event and emits a cancellation event.

> **Cancelling a PAID booking refunds the customer.** Where the gateway supports it the money is returned automatically and `paymentStatus` becomes `refunded`. Otherwise — cash, and My-CoolPay, whose API has no refund endpoint — `paymentStatus` becomes `refund_pending` and a HIGH-importance support ticket is raised for manual payout. Your escrowed earnings for the booking are reversed in **both** cases: you are not paid for a service that was cancelled.
>
> A refund problem never blocks the cancellation — the appointment is released regardless.

**Request Body:**

```json
{ "reason": "Vendor unavailable due to illness" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | string (max 500) | No | Cancellation reason for audit trail |

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "status": "cancelled",
    "cancelledAt": "2026-02-05T09:00:00.000Z",
    "cancelledReason": "Vendor unavailable due to illness"
  },
  "message": "Booking cancelled"
}
```

**Error Responses:**

- `404 BOOKING_NOT_FOUND`: Booking not found
- `409 BOOKING_ALREADY_CANCELLED`: Booking is already cancelled
- `409 BOOKING_TERMINAL_STATE`: Booking is `completed` or `no-show` and cannot be cancelled

---

## Booking Status State Machine

```mermaid
stateDiagram-v2
    [*] --> pending: New Booking
    pending --> confirmed: Vendor Accepts
    pending --> cancelled: Vendor Cancels
    confirmed --> completed: Service Delivered
    confirmed --> no-show: Customer No-Show
    confirmed --> cancelled: Vendor Cancels
    completed --> [*]: Terminal State
    no-show --> [*]: Terminal State
    cancelled --> [*]: Terminal State
```

**Allowed Transitions:**

| From State | To States |
|------------|-----------|
| `pending` | `confirmed`, `cancelled` |
| `confirmed` | `completed`, `cancelled`, `no-show` |
| `completed` | *(none — terminal)* |
| `no-show` | *(none — terminal)* |
| `cancelled` | *(none — terminal)* |

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request body/query validation failed (`details.fields` lists offending fields) |
| `BOOKING_NOT_FOUND` | 404 | Booking not found or doesn't belong to vendor |
| `BOOKING_INVALID_STATUS_TRANSITION` | 400 | Status transition not allowed by the state machine |
| `BOOKING_NOT_RESCHEDULABLE` | 409 | Booking is not `pending`/`confirmed`, so it cannot be rescheduled |
| `BOOKING_SLOT_FULL` | 409 | Capacity-mode slot is full (`maxBookings` reached) — surfaced on the customer book endpoint |
| `BOOKING_PAYMENT_NOT_REQUIRED` | 400 | `requiresPayment` is `false`, so it cannot be marked paid |
| `BOOKING_INVALID_PAYMENT_METHOD` | 400 | Booking has a non-cash payment method |
| `BOOKING_ALREADY_PAID` | 409 | Booking is already marked as paid |
| `BOOKING_ALREADY_CANCELLED` | 409 | Booking is already cancelled |
| `BOOKING_TERMINAL_STATE` | 409 | Booking is `completed`/`no-show` and cannot be cancelled |
| `BOOKING_SLOT_NOT_LOCKED` | 409 | New slot is not locked, or the lock expired (reschedule) |
| `BOOKING_UNAUTHORIZED` | 403 | New slot is locked by a different owner (reschedule) |
| ~~`BOOKING_CALENDAR_SYNC_FAILED`~~ | ~~500~~ | **UNREACHABLE** — registered, given a default message, and raised by nothing. Calendar sync never fails a request |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected server error |

**Error Response Format:**

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "statusCode": 500,
    "category": "internal",
    "details": [...]
  }
}
```

---

## Payment disputes (card bookings)

Online card bookings (Stripe) can be disputed by the customer. The backend reacts
automatically; the dashboard just needs to render the new `paymentStatus`:

- **Dispute opened** → `paymentStatus` becomes **`disputed`** (payment is undecided).
  Show it distinctly (the calendar event is also recoloured to orange `[DISPUTED]`).
- **Dispute won** → `paymentStatus` returns to `paid`.
- **Dispute lost** (or full refund) → `paymentStatus` becomes `refunded`, the booking
  `status` becomes `cancelled` (with `cancelledReason`), and vendor earnings are reversed.

No vendor action is required or possible on a disputed booking — resolution is driven by
Stripe. Just add `disputed` to your payment-status badges/filters and treat a
`disputed → refunded`/`cancelled` booking as closed.

---

## Implementation Notes

1. **Vendor Ownership**: All operations enforce ownership via `vendorId` from auth token
2. **Soft Delete**: Bookings respect `deletedAt` (soft delete pattern)
3. **Calendar Sync**: Non-blocking — failures are logged but never break API responses
4. **State Machine**: Enforced at service layer; invalid transitions return structured errors
5. **Cash Payments**: `paidAt` is persisted when a cash booking is manually marked as paid
6. **Calendar View**: Returns bookings grouped by `YYYY-MM-DD` in **the vendor's own timezone**, max 90-day range. The zone comes back as `meta.timezone` — use it if you re-derive a day from `startAt`, or just group by the `date` key you were given. ⚠ **This line said "(UTC)" until 2026-09-08 and "server's local day" until 2026-09-09**; it was the server's local day, and that is now fixed at source rather than documented
7. **Reschedule**: Requires the vendor to hold a slot lock via the existing slot-locking mechanism
8. **Capacity bookings**: For service products with `serviceConfig.bookingMode: "capacity"`, multiple customers book the same slot (up to `maxBookings`). All seats for a slot share **one** Google Calendar event titled `[x/N] <Product>`, updated as seats fill. Each seat is a separate booking row, visible here and in the calendar view; cancelling one frees a seat. Per-seat payment/status is tracked per booking as usual.

   **The shared event is maintained rather than moved or deleted, and both halves of that were wrong until 2026-09-06.**

   - **Rescheduling one seat** re-renders TWO events — the class it left, one seat lighter, and
     the class it joined. It does not move the shared event, which would have dragged every
     other attendee to the mover's new time. (Before this date a capacity booking could not be
     rescheduled at all: it always failed with `409 BOOKING_SLOT_NOT_LOCKED` — KI-1.)
   - **Cancelling one seat** re-renders the event at the new count and deletes it only when the
     LAST seat goes. It previously called `deleteEvent` outright, so one attendee dropping out
     removed the whole class from your calendar. All three cancellation paths (customer cancel,
     your cancel, and a `confirmed → cancelled` status change) are fixed.
   - A move into a **full** class is refused with `409 BOOKING_SLOT_FULL`; a class with seats
     free accepts it, even with other attendees already in it.

   Calendar sync stays best-effort throughout — a Google outage never rejects or loses a move.
