# Customer Orders

Customer-facing order actions.

**Base path:** `/api/customer/orders`
**Auth:** `Authorization: Bearer <jwt_token>` — role `customer`. A customer may only act on their own orders.

> **Multi-vendor checkout model.** A single cart may hold items from **several vendors** (all of
> the same product type). At checkout the cart is split into **one order per vendor** — each order
> belongs to exactly one vendor and runs its own delivery/fulfilment/earnings cycle. All orders
> from the same checkout share a **`cartId`** (the checkout-group id), so the customer sees them as
> **one logical order** while each vendor sees only their own. The customer **pays once** for the
> whole group via [`POST /api/payments/initiate`](#payment) with that `cartId`.

> **Fulfillment status values.** `pending → processing → partially_shipped → shipped →
> partially_delivered → delivered` (plus terminal `fulfilled` for digital orders, `cancelled`,
> `returned`). Everything from `partially_shipped` onward is **system-derived** from the order's
> underlying shipments (one per delivery agency) — it is never set directly by the vendor.
> `partially_shipped`/`partially_delivered` only ever appear on orders split across more than one
> delivery agency.

---

## POST /api/customer/orders/checkout

Turn the customer's current cart into orders — **one order per vendor**. Re-validates cart rules
(non-empty, single product type, no service products, single currency). All created orders share a
`cartId` and start in `payment_status='AWAITING_PAYMENT'`. The cart is cleared on success. Order
creation is **atomic**: if any order fails to create, none are persisted and the cart is left intact.

### Response

**Success (201 Created)**
```json
{
  "success": true,
  "data": {
    "cartId": "664a1f77bcf86cd799439900",
    "orders": [
      {
        "id": "507f1f77bcf86cd799439011",
        "orderNumber": "ORD-2026-000123",
        "vendorId": "507f1f77bcf86cd799439aaa",
        "orderType": "physical",
        "total": 15000,
        "currency": "XAF",
        "paymentStatus": "AWAITING_PAYMENT",
        "fulfillmentStatus": "pending",
        "itemCount": 2
      },
      {
        "id": "507f1f77bcf86cd799439012",
        "orderNumber": "ORD-2026-000124",
        "vendorId": "507f1f77bcf86cd799439bbb",
        "orderType": "physical",
        "total": 5000,
        "currency": "XAF",
        "paymentStatus": "AWAITING_PAYMENT",
        "fulfillmentStatus": "pending",
        "itemCount": 1
      }
    ]
  },
  "message": "Orders created. Complete payment for the cart to proceed."
}
```

Next step: call `POST /api/payments/initiate` with `{ "cartId": "<cartId>", "gateway": "...", "channel": {...} }` to pay for the whole group in one transaction.

### Errors

| HTTP | Code | When |
|---|---|---|
| 400 | `ORDER_CART_EMPTY` | Cart is empty. |
| 400 | `ORDER_CART_INVALID` | Missing product type / cart id, service product present, missing variant/SKU, or mixed currency. |
| 404 | `ORDER_PRODUCT_NOT_FOUND` | A cart item's product no longer exists. |
| 404 | `ORDER_VENDOR_NOT_FOUND` | A vendor referenced by the cart no longer exists. |
| 422 | `ORDER_NO_DELIVERY_AGENCY` | A physical product has no resolvable delivery agency. |

---

## GET /api/customer/orders

The customer's order history, **grouped by checkout group (`cartId`)**. Each group is one logical
order that may contain several per-vendor orders. Paginated by group.

### Query params

- `page` *(int, default 1)*
- `limit` *(int, default 20, max 100)*

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": [
    {
      "cartId": "664a1f77bcf86cd799439900",
      "createdAt": "2026-07-02T10:00:00.000Z",
      "currency": "XAF",
      "totalAmount": 20000,
      "orderCount": 2,
      "paymentStatus": "awaiting_payment",
      "orders": [
        {
          "id": "507f1f77bcf86cd799439011",
          "orderNumber": "ORD-2026-000123",
          "vendorId": "507f1f77bcf86cd799439aaa",
          "orderType": "physical",
          "total": 15000,
          "currency": "XAF",
          "paymentStatus": "AWAITING_PAYMENT",
          "fulfillmentStatus": "pending",
          "itemCount": 2,
          "createdAt": "2026-07-02T10:00:00.000Z"
        }
      ]
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

The group-level `paymentStatus` is an aggregate of its orders: `paid` (all paid), `awaiting_payment`
(none paid), `partially_paid` (some paid), or `mixed`.

---

## GET /api/customer/orders/groups/:cartId

One checkout group in detail — all its per-vendor orders with line items. Scoped to the
authenticated customer.

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "cartId": "664a1f77bcf86cd799439900",
    "createdAt": "2026-07-02T10:00:00.000Z",
    "currency": "XAF",
    "totalAmount": 20000,
    "orderCount": 2,
    "paymentStatus": "awaiting_payment",
    "orders": [
      {
        "id": "507f1f77bcf86cd799439011",
        "orderNumber": "ORD-2026-000123",
        "vendorId": "507f1f77bcf86cd799439aaa",
        "orderType": "physical",
        "total": 15000,
        "currency": "XAF",
        "paymentStatus": "AWAITING_PAYMENT",
        "fulfillmentStatus": "pending",
        "items": [
          {
            "id": "507f1f77bcf86cd799439055",
            "productId": "507f1f77bcf86cd799439066",
            "variantId": "507f1f77bcf86cd799439077",
            "sku": "TSHIRT-RED-L",
            "title": "T-Shirt",
            "variantTitle": "Size: Large, Color: Red",
            "quantity": 2,
            "price": 7500,
            "currency": "XAF",
            "freeDelivery": false
          }
        ]
      }
    ]
  }
}
```

> `items[].freeDelivery` is a snapshot of the product's free-delivery flag taken at checkout time; it does not reflect later changes to the product.

### Errors

| HTTP | Code | When |
|---|---|---|
| 404 | `ORDER_NOT_FOUND` | No orders for this `cartId` under the authenticated customer. |

---

<a name="payment"></a>
## Paying for a checkout group

`POST /api/payments/initiate` accepts **either** `cartId` (pay the whole checkout group in one
transaction — preferred for cart checkout) **or** `orderId` (single-order payment).

```json
{
  "cartId": "664a1f77bcf86cd799439900",
  "gateway": "NOTCHPAY",
  "channel": { "phoneNumber": "+237670000000", "phoneOperator": "MTN", "customerEmail": "a@b.com" }
}
```

The customer is charged the **sum** of the group's order totals once. On payment success the
settlement **fans out** to every order in the group: each independently becomes `paid`, splits its
earnings against its own vendor's commission, and proceeds with fulfilment.

**Group-payment errors:** `404 PAYMENT_CART_NOT_FOUND` (no orders for the cartId), `409
PAYMENT_ORDER_ALREADY_PAID` (all orders already paid), `409 PAYMENT_CART_NO_PAYABLE_ORDERS` (nothing
left to pay), `400 PAYMENT_CART_MIXED_CURRENCY`, `400 PAYMENT_REFERENCE_REQUIRED` (neither cartId nor
orderId supplied).

---

## PATCH /api/customer/orders/:id/confirm-delivery

Confirm receipt/satisfaction. Confirmable once fulfilment is `delivered` (physical) or
`fulfilled` (digital) and the order has not already been completed. Completing the order
starts the 7-day escrow hold before vendor funds become withdrawable.

> **Physical orders:** `fulfillment_status` only reaches `delivered` once every shipment of the
> order has been individually confirmed via
> [`POST /api/customer/orders/:orderId/shipments/:shipmentId/confirm-delivery`](#confirm-shipment)
> below — at that point completion has already fired automatically. This endpoint is the primary
> path for **digital** orders (`fulfilled`); for physical orders it mainly exists as an idempotent
> fallback (returns `409 EARNINGS_ALREADY_COMPLETED` if the last shipment confirmation already
> completed the order).

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

<a name="confirm-shipment"></a>
## POST /api/customer/orders/:orderId/shipments/:shipmentId/confirm-delivery

Confirm **one shipment's** delivery. A physical order can be split across several delivery
agencies (one shipment per agency) — each shipment needs its own customer confirmation once the
agency/agent reports it delivered (`shipment.status = 'agent_delivered'`), since packages from
different agencies can arrive on different days.

Once every shipment on the order has been confirmed this way, the order's own
`fulfillment_status` becomes `delivered` **and its `completion` (escrow-release gate) fires
automatically** — no separate call to `PATCH /:id/confirm-delivery` is needed.

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "id": "664a1f77bcf86cd799439aaa",
    "orderId": "507f1f77bcf86cd799439011",
    "agencyId": "507f1f77bcf86cd799439bbb",
    "agentId": "507f1f77bcf86cd799439ccc",
    "status": "delivered",
    "trackingNumber": "TRK123456",
    "orderFulfillmentStatus": "partially_delivered"
  }
}
```

`orderFulfillmentStatus` reflects the order-wide state right after this confirmation —
`partially_delivered` while other shipments are still outstanding, `delivered` once this was the
last one.

### Errors

| HTTP | Code | When |
|---|---|---|
| 404 | `ORDER_NOT_FOUND` | Order not found. |
| 403 | `SHIPMENT_ACCESS_DENIED` | Order belongs to another customer. |
| 404 | `SHIPMENT_NOT_FOUND` | Shipment not found, or doesn't belong to this order. |
| 409 | `SHIPMENT_ALREADY_CONFIRMED` | Shipment already confirmed as delivered. |
| 422 | `SHIPMENT_CONFIRMATION_NOT_ALLOWED` | Shipment hasn't reached `agent_delivered` yet. |

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
