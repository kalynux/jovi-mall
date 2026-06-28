# Customer Orders

Customer-facing order actions.

**Base path:** `/api/customer/orders`
**Auth:** `Authorization: Bearer <jwt_token>` — role `customer`. A customer may only act on their own orders.

---

## PATCH /api/customer/orders/:id/confirm-delivery

Confirm receipt/satisfaction. Confirmable once fulfilment is `delivered` (physical) or
`fulfilled` (digital) and the order has not already been completed. Completing the order
starts the 7-day escrow hold before vendor funds become withdrawable.

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "order_id": "507f1f77bcf86cd799439011",
    "completed_at": "2026-06-28T12:00:00.000Z"
  }
}
```

---

## POST /api/customer/orders/:id/cancel

Customer-initiated cancellation, gated by the vendor's **cancellation policy**.

**Constraints:**
- Only **pre-shipment** orders (`fulfillment_status` is `pending` or `processing`).
- Only **unpaid** orders (`payment_status` is `pending` or `AWAITING_PAYMENT`). For a **paid**
  order, this endpoint returns `422 ORDER_CANCEL_REQUIRES_REFUND` — use the vendor refund flow
  instead (this endpoint performs no refund).
- The vendor's `cancellation_policy` must permit it (`cancellable` flag + `cancellation_deadline`).
  Orders have no firm delivery date, so delivery-date-based deadlines fall back to
  creation-based handling.

On success the order is set to `fulfillment_status='cancelled'`, `payment_status='failed'`, a
timeline event is appended, and an `order.cancelled` event is emitted (drives vendor notifications).

### Request Body

```json
{ "reason": "Changed my mind" }
```

- `reason` *(string, optional, ≤ 500 chars)*.

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "order_id": "507f1f77bcf86cd799439011",
    "fulfillment_status": "cancelled"
  },
  "message": "Order cancelled"
}
```

### Errors

| HTTP | Code | When |
|---|---|---|
| 404 | `ORDER_NOT_FOUND` | Order not found / not this customer's. |
| 403 | `EARNINGS_FORBIDDEN` | Order belongs to another customer. |
| 409 | `ORDER_ALREADY_CANCELLED` | Order is already cancelled. |
| 422 | `ORDER_NOT_CANCELLABLE` | Past `pending`/`processing`, or payment state not unpaid. |
| 422 | `ORDER_CANCEL_REQUIRES_REFUND` | Order is paid — use the refund flow. |
| 422 | `CANCELLATION_NOT_ALLOWED` | Vendor cancellation policy disallows it (see `details`). |

> **Auto-cancellation.** Independently of this endpoint, a daily background sweep cancels
> orders left unpaid past the vendor's configured window
> (`auto_cancel_unpaid_days`, default 3). See
> [vendor/profile.md](../vendor/profile.md#put-apivendorprofileauto-cancel-unpaid-days).
