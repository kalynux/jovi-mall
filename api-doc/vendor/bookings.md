# Vendor Booking Management API

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
| `paymentStatus` | string | No | Filter by payment state: `unpaid`, `pending`, `paid`, `disputed`, `failed`, `refunded` |
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
      "_id": "507f1f77bcf86cd799439011",
      "productId": { "_id": "507f1f77bcf86cd799439012", "title": "1-Hour Consultation", "type": "service" },
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
> A booking is included when its **`startAt`** falls within `[startDate, endDate]`, regardless of when it ends. Results are grouped under the `YYYY-MM-DD` (UTC) of each booking's `startAt`.

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
  ]
}
```

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
    "breakdown": { "basePrice": 12500, "peakHoursSurcharge": 0 }
  },
  "message": "Booking completed"
}
```

- `priceSnapshot` — the originally booked estimate.
- `finalPrice` — the recomputed (or flat) price; also recorded under `booking.metadata.completion`.
- `additionalAmountDue` — `max(0, finalPrice − priceSnapshot)`.

> [!WARNING]
> **The additional-payment request is currently STUBBED.** When `additionalAmountDue > 0`, the shortfall is recorded on the booking and returned, but **no payment charge or customer notification is created yet**. Treat `additionalAmountDue` as informational until this is implemented.

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
{ "newSlotId": "slot-2026-02-10T14:00:00Z-60" }
```

**Error Responses:**

- `400 VALIDATION_ERROR`: `newSlotId` missing
- `404 BOOKING_NOT_FOUND`: Booking not found
- `409 BOOKING_NOT_RESCHEDULABLE`: Booking status doesn't allow rescheduling (must be `pending` or `confirmed`)
- `409 BOOKING_SLOT_NOT_LOCKED`: New slot is not locked, or the lock has expired
- `403 BOOKING_UNAUTHORIZED`: New slot is locked by a different owner
- `409 BOOKING_ALREADY_CANCELLED`: Booking is already cancelled
- `500 BOOKING_CALENDAR_SYNC_FAILED`: Calendar event update failed

---

## Cancel Booking

```http
POST /api/vendor/bookings/:id/cancel
```

Cancel a booking with an optional reason. Deletes the calendar event and emits a cancellation event.

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
    "_id": "507f1f77bcf86cd799439011",
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
| `BOOKING_CALENDAR_SYNC_FAILED` | 500 | Calendar event update failed (reschedule) |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

**Error Response Format:**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
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
6. **Calendar View**: Returns bookings grouped by `YYYY-MM-DD` (UTC), max 90-day range
7. **Reschedule**: Requires the vendor to hold a slot lock via the existing slot-locking mechanism
8. **Capacity bookings**: For service products with `serviceConfig.bookingMode: "capacity"`, multiple customers book the same slot (up to `maxBookings`). All seats for a slot share **one** Google Calendar event titled `[x/N] <Product>`, updated as seats fill. Each seat is a separate booking row, visible here and in the calendar view; cancelling one frees a seat. Per-seat payment/status is tracked per booking as usual.
