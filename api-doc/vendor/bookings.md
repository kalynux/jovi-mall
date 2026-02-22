# Vendor Booking Management API

Complete API reference for managing bookings in the multi-vendor ecommerce platform.

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
| `paymentStatus` | string | No | Filter by payment state: `unpaid`, `pending`, `paid`, `failed`, `refunded` |
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

---

## Get Booking

```http
GET /api/vendor/bookings/:id
```

Retrieve a single booking by ID.

**Error Responses:**

- `404 NOT_FOUND`: Booking not found or doesn't belong to vendor

---

## Calendar View

```http
GET /api/vendor/bookings/calendar
```

Returns bookings grouped by date for calendar display. Single query, no N+1.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `startDate` | ISO datetime | **Yes** | Start of range (inclusive) |
| `endDate` | ISO datetime | **Yes** | End of range (inclusive, max 90 days from startDate) |

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

- `400 INVALID_STATUS_TRANSITION`: Transition not allowed by state machine
- `404 NOT_FOUND`: Booking not found

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

- `400 VALIDATION_ERROR`: Booking doesn't require payment, or has a non-cash payment method
- `409 CONFLICT`: Booking is already marked as paid
- `404 NOT_FOUND`: Booking not found

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

- `400 VALIDATION_ERROR`: `newSlotId` missing or slot not locked
- `409 INVALID_STATE`: Booking status doesn't allow rescheduling
- `404 NOT_FOUND`: Booking not found

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

- `409 CONFLICT`: Booking is already cancelled, completed, or no-show
- `404 NOT_FOUND`: Booking not found

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
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `INVALID_STATUS_TRANSITION` | 400 | Status transition not allowed by state machine |
| `INVALID_STATE` | 409 | Booking is in a state that doesn't allow this operation |
| `CONFLICT` | 409 | Double-cancel or already-paid attempt |
| `NOT_FOUND` | 404 | Booking not found or doesn't belong to vendor |
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

## Implementation Notes

1. **Vendor Ownership**: All operations enforce ownership via `vendorId` from auth token
2. **Soft Delete**: Bookings respect `deletedAt` (soft delete pattern)
3. **Calendar Sync**: Non-blocking — failures are logged but never break API responses
4. **State Machine**: Enforced at service layer; invalid transitions return structured errors
5. **Cash Payments**: `paidAt` is persisted when a cash booking is manually marked as paid
6. **Calendar View**: Returns bookings grouped by `YYYY-MM-DD` (UTC), max 90-day range
7. **Reschedule**: Requires the vendor to hold a slot lock via the existing slot-locking mechanism
