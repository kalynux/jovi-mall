# Vendor Orders

## Base Path

All endpoints in this document share this base path:

```
/api/vendor/orders
```

## Authentication

**Authorization**: Vendor access required.

All requests must include a valid Bearer token with vendor role:

```
Authorization: Bearer <access_token>
```

---

## Actions Overview

| Action | Method | Endpoint | Physical | Digital |
|--------|--------|----------|----------|---------|
| List orders | `GET` | `/api/vendor/orders` | ✅ | ✅ |
| Get order details | `GET` | `/api/vendor/orders/:id` | ✅ | ✅ |
| Update fulfillment status | `PATCH` | `/api/vendor/orders/:id/status` | ✅ | ✅ |
| Bulk update fulfillment status | `POST` | `/api/vendor/orders/bulk/status` | ✅ | ✅ |
| Bulk dispatch to agency | `POST` | `/api/vendor/orders/bulk/dispatch` | ✅ | ❌ |
| Add internal note | `POST` | `/api/vendor/orders/:id/notes` | ✅ | ✅ |
| Get internal notes | `GET` | `/api/vendor/orders/:id/notes` | ✅ | ✅ |
| Get single note | `GET` | `/api/vendor/orders/:id/notes/:noteId` | ✅ | ✅ |
| View timeline / audit trail | `GET` | `/api/vendor/orders/:id/timeline` | ✅ | ✅ |
| Assign delivery agency | `PATCH` | `/api/vendor/orders/:id/delivery-agency` | ✅ | ❌ |
| View digital entitlements | `GET` | `/api/vendor/orders/:id/entitlements` | ❌ | ✅ |
| Revoke digital entitlement | `POST` | `/api/vendor/entitlements/:id/revoke` | ❌ | ✅ |
| Restore digital entitlement | `POST` | `/api/vendor/entitlements/:id/restore` | ❌ | ✅ |

> Notes are also embedded inside `GET /orders/:id` response — the dedicated notes endpoint is useful when polling for note updates without re-fetching the full order.

---

## Endpoints

### GET /api/vendor/orders

**Description**: List vendor orders with filters, search, sorting, and pagination.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**: None

**Query Parameters**:
- `status` (string, optional) - Filter by order status. Enum: `pending`, `processing`, `partially_shipped`, `shipped`, `partially_delivered`, `delivered`, `fulfilled`, `cancelled`, `returned`
- `paymentStatus` (string, optional) - Filter by payment status. Enum: `pending`, `AWAITING_PAYMENT`, `partially_paid`, `paid`, `disputed`, `failed`, `refunded`
- `paymentMethod` (string, optional) - Filter by payment method. Enum: `online`, `cash_on_delivery`
- `orderType` (string, optional) - Filter by order type. Enum: `physical`, `digital`
- `dateFrom` (string, optional) - Filter orders from date (ISO 8601 format)
- `dateTo` (string, optional) - Filter orders to date (ISO 8601 format)
- `q` (string, optional, max 100 chars) - Search query (order number, customer name, etc.)
- `page` (integer, optional, default: 1) - Page number (1-indexed)
- `limit` (integer, optional, default: 20, max: 100) - Items per page
- `sortBy` (string, optional, default: `created_at`) - Sort field. Enum: `created_at`, `updated_at`, `total_amount`
- `sortOrder` (string, optional, default: `desc`) - Sort order. Enum: `asc`, `desc`

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "orderNumber": "string",
      "orderType": "physical",
      "fulfillmentStatus": "pending",
      "paymentMethod": "online",
      "paymentStatus": "paid",
      "customer": {
        "id": "string",
        "name": "Jane Doe",
        "email": "jane@example.com",
        "avatar": "https://..."
      },
      "subtotal": 100.00,
      "tax": 10.00,
      "shipping": 0,
      "total": 110.00,
      "currency": "XAF",
      "itemCount": 3,
      "createdAt": "2026-02-09T23:54:00.000Z"
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "limit": 20,
    "pages": 3
  }
}
```

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid query parameters (e.g., invalid date format, invalid enum value)

---

### GET /api/vendor/orders/:id

**Description**: Get detailed information for a single order.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Order ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "orderNumber": "string",
    "orderType": "physical",
    "fulfillmentStatus": "processing",
    "paymentMethod": "online",
    "paymentStatus": "paid",
    "paymentIntentId": "string",
    "customer": {
      "id": "string",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "phone": "+237600000000",
      "avatar": "https://...",
      "orderCount": 5,
      "totalSpent": 75000
    },
    "shippingAddress": {
      "street": "123 Main Street",
      "city": "Douala",
      "state": "Littoral",
      "country": "CM"
    },
    "items": [
      {
        "id": "string",
        "productId": "string",
        "variantId": "string",
        "title": "string",
        "variantTitle": "string",
        "sku": "string",
        "optionsSnapshot": "Color:Red;Size:M",
        "quantity": 2,
        "price": 50.00,
        "subtotal": 100.00,
        "currency": "XAF",
        "delivery": {
          "agencyId": "507f1f77bcf86cd799439099",
          "agencyName": "FastShip Logistics",
          "agencyPhone": "+237600000000",
          "deliveryStatus": "assigned",
          "shipmentId": "507f1f77bcf86cd799439100",
          "trackingNumber": "FS-1234567890",
          "freeDelivery": false,
          "agent": {
            "id": "507f1f77bcf86cd799439101",
            "name": "John Doe",
            "phone": "+237600000001",
            "avatarUrl": "https://..."
          }
        }
      }
    ],
    "priceBreakdown": {
      "base": 100.00,
      "tax": 10.00,
      "discount": 0.00,
      "shipping": 0,
      "total": 110.00
    },
    "totalAmount": 110.00,
    "currency": "XAF",
    "deliveries": [
      {
        "agencyId": "507f1f77bcf86cd799439099",
        "agencyName": "FastShip Logistics",
        "agencyPhone": "+237600000000",
        "deliveryStatus": "assigned",
        "shipmentId": "507f1f77bcf86cd799439100",
        "trackingNumber": "FS-1234567890",
        "freeDelivery": false,
        "agent": {
          "id": "507f1f77bcf86cd799439101",
          "name": "John Doe",
          "phone": "+237600000001",
          "avatarUrl": "https://..."
        }
      }
    ],
    "deliveryTimeline": [
      { "shipmentId": "507f1f77bcf86cd799439100", "agencyId": "507f1f77bcf86cd799439099", "agencyName": "FastShip Logistics", "status": "assigned", "changedAt": "2026-07-05T09:00:00.000Z", "changedByRole": "system" },
      { "shipmentId": "507f1f77bcf86cd799439100", "agencyId": "507f1f77bcf86cd799439099", "agencyName": "FastShip Logistics", "status": "picked_up", "changedAt": "2026-07-05T14:00:00.000Z", "changedByRole": "agency" }
    ],
    "notes": [
      {
        "id": "string",
        "message": "Customer requested gift wrapping",
        "authorId": "string",
        "createdAt": "2026-02-09T23:54:00.000Z"
      }
    ],
    "createdAt": "2026-02-09T23:54:00.000Z",
    "updatedAt": "2026-02-09T23:54:00.000Z"
  }
}
```

> **Notes:**
> - `customer.orderCount` and `customer.totalSpent` reflect only orders with **this vendor** (not lifetime totals across all vendors).
> - `customer.*` fields are `null` if the customer profile cannot be resolved.
> - `shippingAddress` is derived from the customer's default saved address. It is `null` if the customer has no address on file. Field mapping: `address_line1` → `street`.
> - `items[].delivery` is the authoritative per-item delivery info — an order can be split across several agencies (one per item). It is `null` for digital items, and `delivery.agent` is `null` until an agent is assigned to the item's shipment.
> - `deliveries` is an order-level overview with one entry per agency/shipment handling the order (de-duplicated by `shipmentId`). It is `null` for digital orders. Use `items[].delivery` when you need to know which agency carries a specific item.
> - `deliveryTimeline` merges every shipment's status history for this order, labeled by agency and sorted chronologically (see the example above). Each entry is `{ shipmentId, agencyId, agencyName, status, changedAt, changedByRole }` — the **same shape** as `orderTimeline` on [`GET /api/agency/shipments/:id`](../agency/shipments.md#detail). It is unrelated to the generic audit trail returned by `GET /api/vendor/orders/:id/timeline` below — that endpoint returns `eventType`/`oldValue`/`newValue` events, not shipment status history. Empty for digital orders.
> - `deliveryStatus` reflects the per-item delivery status: `pending`, `assigned`, `picked_up`, `in_transit`, `agent_delivered`, `delivered`, `failed`, `returned`, `rejected`, or `pending_agency_reassignment`.
> - `trackingNumber` is the carrier tracking number set by the delivery agency/agent for that item's shipment. It is `null` until the agency/agent records one (e.g. the order is not yet dispatched).
> - `freeDelivery` is a snapshot of the product's `delivery.freeDelivery` flag at checkout time — it does not change agency resolution, shipment routing, or fee calculation.
> - `priceBreakdown.shipping` is always `0` — shipping cost tracking is not yet implemented in the order schema.

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor

---

### PATCH /api/vendor/orders/:id/status

**Description**: Update the fulfillment status of an order. Enforces state machine transitions.

> **`shipped` / `partially_shipped` / `partially_delivered` / `delivered` are no longer
> vendor-settable.** They are computed automatically from the order's shipments (one per delivery
> agency) as agencies report pickup/transit/delivery and customers confirm each shipment — see
> "Fulfillment lifecycle" below. A vendor's own control is limited to `pending → processing →
> cancelled`.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Order ID

**Query Parameters**: None

**Request Body**:
```json
{
  "status": "string (required) - New status. Enum: pending, processing, cancelled"
}
```

**Success Response**:

Status: `200 OK`

Body:

The response is the full updated order details object (same shape as `GET /api/vendor/orders/:id`).

```json
{
  "success": true,
  "data": { "...same as GET /api/vendor/orders/:id data..." },
  "message": "Order status updated to 'processing'"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor
- `400` – `VALIDATION_ERROR` – Invalid status value
- `400` – `INVALID_STATE_TRANSITION` – State transition not allowed (e.g., cannot move from `delivered` to `processing`)
- `403` – `FORBIDDEN` – Cannot update status (e.g., payment not confirmed)
- `423` – `ORDER_DISPUTE_HOLD` – **The order is frozen by an open payment dispute and cannot be advanced until it settles.** `details` includes `{ disputeId, reason }`. See "Payment disputes" below.

---

<a name="bulk-status"></a>
### POST /api/vendor/orders/bulk/status

**Description**: Update the fulfillment status of **many orders in one call** (e.g. "cancel selected", "mark selected as processing" from a bulk-select UI). Each order is validated against its own current state **independently** — one ineligible order does not block the rest of the batch. This is the batched counterpart of `PATCH /api/vendor/orders/:id/status` above and enforces the exact same rules per order (state machine, payment coupling, dispute hold).

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**: None

**Request Body**:
```json
{
  "orderIds": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"],
  "status": "processing"
}
```
- `orderIds` (string[], required, 1–50 items) — order IDs to update. A repeated ID is processed once per occurrence, independently — if the first occurrence changes the order's state, the second occurrence will evaluate against that new state (typically ending up in `failed` with `ORDER_TERMINAL_STATE` or `ORDER_INVALID_TRANSITION`).
- `status` (string, required) — New status. Enum: `pending`, `processing`, `cancelled` (same vendor-settable subset as the single-order endpoint).

**Success Response**:

Status: `200 OK` — **always 200 for a well-formed request.** Per-order failures are reported in the response body, not as an HTTP error; only a malformed request (empty/oversized `orderIds`, invalid `status`) returns `400 VALIDATION_ERROR`.

Body:
```json
{
  "success": true,
  "data": {
    "total": 5,
    "succeeded": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012", "507f1f77bcf86cd799439013"],
    "failed": [
      { "orderId": "507f1f77bcf86cd799439014", "code": "ORDER_PAYMENT_REQUIRED", "reason": "order payment required" },
      { "orderId": "507f1f77bcf86cd799439015", "code": "ORDER_TERMINAL_STATE", "reason": "order terminal state" }
    ]
  },
  "message": "3 of 5 order(s) updated to 'processing', 2 failed"
}
```

- `succeeded` — order IDs whose status was actually changed.
- `failed` — one entry per order that was rejected, with `code` (a stable machine-readable error code — use this for logic/mapping) and `reason` (a human-readable string; may be generic for some codes, prefer `code` for display logic).

**Possible `failed[].code` values** (identical to the single-order endpoint's error responses):

| Code | Meaning |
|------|---------|
| `ORDER_NOT_FOUND` | Order doesn't exist or isn't owned by this vendor |
| `ORDER_TERMINAL_STATE` | Order is already `delivered`, `cancelled`, or otherwise terminal |
| `ORDER_INVALID_TRANSITION` | Requested status isn't reachable from the order's current status |
| `ORDER_PAYMENT_REQUIRED` | Order isn't `paid` yet (blocks moving to `processing`) |
| `ORDER_PAYMENT_FAILED_STATE` | Order's payment is `failed`/`refunded` |
| `ORDER_DISPUTE_HOLD` | Order is frozen by an open payment dispute |

**Error Responses** (request-level, before any order is touched):
- `400` – `VALIDATION_ERROR` – `orderIds` empty/exceeds 50 items, contains an invalid ID, or `status` isn't one of the allowed values

---

<a name="dispatch"></a>
### POST /api/vendor/orders/:id/dispatch

**Description**: The vendor's explicit review/approval step before an order reaches its delivery
agency. A physical order's `Shipment`(s) are created at checkout in status `pending` — they stay
invisible to the agency (`GET /agency/shipments` excludes `pending`) until either:
- the vendor calls **this endpoint** after reviewing the paid order, or
- the vendor has `auto_redirect_orders_to_agency` enabled (see `GET/PUT
  /api/vendor/profile/auto-redirect-orders` in [vendor/profile.md](../vendor/profile.md)), in
  which case dispatch happens automatically on payment success and this endpoint is unnecessary
  (calling it afterward is a harmless no-op).

Advances every `pending` shipment of the order to `assigned` and mirrors that onto the matching
order items. Requires the order to be `paid` and not on dispute hold — **except cash-on-delivery
orders** (`paymentMethod: "cash_on_delivery"`), which are dispatchable while still unpaid
(`AWAITING_PAYMENT`/`partially_paid`): COD fulfils before payment by design. For COD, auto-redirect
fires at **checkout** instead of payment success.

**Authorization**: Vendor access required.

**Path Parameters**:
- `id` (string, required) — Order ID

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "...same as GET /api/vendor/orders/:id data...",
    "dispatchedShipments": 2
  },
  "message": "Order dispatched to 2 shipment(s)' delivery agency"
}
```

`dispatchedShipments` is `0` if there was nothing pending (already dispatched, or auto-redirect
already handled it) — the response still succeeds, just with an informational message.

**Error Responses**:
- `404` – `ORDER_NOT_FOUND` – Order not found or does not belong to vendor.
- `400` – `ORDER_WRONG_TYPE` – Order is digital (nothing to dispatch to an agency).
- `422` – `ORDER_PAYMENT_REQUIRED` – Order is not yet paid (online orders only — COD orders dispatch unpaid).
- `423` – `ORDER_DISPUTE_HOLD` – Order is frozen by an open payment dispute.

---

<a name="bulk-dispatch"></a>
### POST /api/vendor/orders/bulk/dispatch

**Description**: Dispatch **many** reviewed, paid physical orders to their delivery agency/agencies in one call (e.g. "dispatch selected" from a bulk-select UI). Each order goes through the exact same checks as the single-order [`POST /api/vendor/orders/:id/dispatch`](#dispatch) above — orders that aren't dispatchable (unpaid, digital, disputed, not found) are reported as failures without blocking the rest of the batch.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Request Body**:
```json
{
  "orderIds": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
}
```
- `orderIds` (string[], required, 1–50 items) — order IDs to dispatch.

**Success Response**:

Status: `200 OK` — **always 200 for a well-formed request.** Per-order failures are reported in the response body, not as an HTTP error.

Body:
```json
{
  "success": true,
  "data": {
    "total": 4,
    "succeeded": [
      { "orderId": "507f1f77bcf86cd799439011", "dispatchedShipments": 1 },
      { "orderId": "507f1f77bcf86cd799439012", "dispatchedShipments": 0 }
    ],
    "failed": [
      { "orderId": "507f1f77bcf86cd799439013", "code": "ORDER_PAYMENT_REQUIRED", "reason": "order payment required" },
      { "orderId": "507f1f77bcf86cd799439014", "code": "ORDER_WRONG_TYPE", "reason": "order wrong type" }
    ]
  },
  "message": "2 of 4 order(s) dispatched, 2 failed"
}
```

- `succeeded` — one entry per order that was **not rejected**, with `dispatchedShipments` (the number of `pending` shipments moved to `assigned`). `dispatchedShipments: 0` is a legitimate no-op — the order was already dispatched or had nothing pending — and is still reported as a success, matching the single-order endpoint's behavior.
- `failed` — one entry per order that was rejected, with `code` (stable, prefer this for logic/mapping) and `reason` (human-readable, may be generic for some codes).

**Possible `failed[].code` values**:

| Code | Meaning |
|------|---------|
| `ORDER_NOT_FOUND` | Order doesn't exist or isn't owned by this vendor |
| `ORDER_WRONG_TYPE` | Order is digital — nothing to dispatch to an agency |
| `ORDER_PAYMENT_REQUIRED` | Order is not yet `paid` — **this is the "unpaid order can't be dispatched" case** |
| `ORDER_DISPUTE_HOLD` | Order is frozen by an open payment dispute |

**Error Responses** (request-level, before any order is touched):
- `400` – `VALIDATION_ERROR` – `orderIds` empty, exceeds 50 items, or contains an invalid ID

---

### GET /api/vendor/orders/:id/timeline

**Description**: Get the audit trail (timeline) for an order showing all status changes and events.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Order ID

**Query Parameters**:
- `page` (integer, optional, default: 1) - Page number (1-indexed)
- `limit` (integer, optional, default: 20, max: 100) - Items per page

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "_id": "string",
      "orderId": "string",
      "eventType": "fulfillment.updated",
      "oldValue": "pending",
      "newValue": "processing",
      "actor": {
        "type": "vendor",
        "id": "string",
        "name": "Vendor Business Name"
      },
      "created_at": "2026-02-09T23:54:00.000Z"
    }
  ],
  "meta": {
    "total": 15,
    "page": 1,
    "limit": 20,
    "pages": 1
  }
}
```

**`eventType` values**:

| Value | Produces `oldValue`/`newValue` | Description |
|-------|-------------------------------|-------------|
| `order.created` | — | Order was placed |
| `payment.updated` | — | Payment status changed |
| `fulfillment.updated` | ✅ Previous/new fulfillment status | Fulfillment status changed |
| `delivery.agency_updated` | — | Delivery agency assigned or changed |
| `note.added` | `noteId` populated | Vendor internal note added |
| `entitlement.revoked` | — | Digital entitlement revoked |
| `entitlement.restored` | — | Digital entitlement restored |
| `system.action` | — | Automated system event |

> `oldValue` and `newValue` are only populated for `fulfillment.updated` events. For all other event types they are `null`.
> `noteId` is only populated for `note.added` events — use it with `GET /orders/:id/notes/:noteId` to fetch the full note content.
> `actor.id` and `actor.name` are `null` for `system` events.

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor
- `400` – `VALIDATION_ERROR` – Invalid query parameters

---

### POST /api/vendor/orders/:id/notes

**Description**: Add a vendor-internal note to an order. Notes are visible only to the vendor.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Order ID

**Query Parameters**: None

**Request Body**:
```json
{
  "message": "string (required, min 1, max 2000 chars) - Note content"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "message": "Customer requested gift wrapping",
    "authorId": "string",
    "createdAt": "2026-02-09T23:54:00.000Z"
  },
  "message": "Note added successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor
- `400` – `VALIDATION_ERROR` – Invalid message (empty or exceeds 2000 characters)

---

### GET /api/vendor/orders/:id/notes

**Description**: Get all vendor-internal notes for an order.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Order ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "message": "Customer requested gift wrapping",
      "authorId": "string",
      "createdAt": "2026-02-09T23:54:00.000Z"
    }
  ]
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor

---

### GET /api/vendor/orders/:id/notes/:noteId

**Description**: Get a single vendor-internal note by its ID. Intended for use when the frontend reads a `note.added` timeline event and wants to display the full note content without re-fetching all notes.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Order ID
- `noteId` (string, required) - Note ID (found in `noteId` field of `note.added` timeline events)

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "orderId": "string",
    "message": "Customer requested gift wrapping",
    "authorId": "string",
    "createdAt": "2026-02-09T23:54:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Note not found or does not belong to this vendor

---

### PATCH /api/vendor/orders/:id/delivery-agency

**Description**: Reassign the delivery agency for a **single item** of a physical order.

A physical order can be split across several delivery agencies (one per item),
so reassignment is item-scoped — it moves only the specified item to the new
agency and leaves every other item untouched. Behind the scenes the item is
moved between agency shipments: it joins the destination agency's open shipment
for this order (or a new one is created), and is removed from its previous
shipment (which is deleted if it becomes empty).

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Order ID

**Request Body**:
```json
{
  "itemId": "507f1f77bcf86cd799439012",
  "deliveryAgencyId": "507f1f77bcf86cd799439099"
}
```

- `itemId` (string, required) — the order item (`items[].id`) to reassign.
- `deliveryAgencyId` (string, required) — the destination agency.

**Success Response**:

Status: `200 OK`

Body:

The response is the full updated order details object (same shape as `GET /api/vendor/orders/:id`). The reassigned item's `items[].delivery` now points at the new agency, and the order-level `deliveries[]` overview reflects the new shipment split.

```json
{
  "success": true,
  "data": { "...same as GET /api/vendor/orders/:id data..." },
  "message": "Delivery agency updated successfully"
}
```

> **Note:** Requesting the agency the item is already assigned to is a no-op and returns the order unchanged.

**Error Responses**:
- `404` – `ORDER_NOT_FOUND` – Order not found or does not belong to vendor
- `404` – `ORDER_ITEM_NOT_FOUND` – No item with that `itemId` exists on the order
- `404` – `ORDER_DELIVERY_AGENCY_NOT_FOUND` – Destination agency does not exist
- `400` – `ORDER_WRONG_TYPE` – Order is not a physical order
- `422` – `ORDER_TERMINAL_STATE` – Order is already delivered or cancelled
- `422` – `ORDER_ITEM_NOT_REASSIGNABLE` – Item has already been dispatched (picked up / in transit / delivered / returned)

---

### GET /api/vendor/orders/:id/entitlements

**Description**: View digital entitlements for an order. Returns download statistics and customer access information for digital products.

> [!NOTE]
> Only applicable for orders containing **digital products**. Returns an empty array for physical/service orders.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Order ID

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439050",
      "orderItemId": "string",
      "productId": "string",
      "productTitle": "E-book: Advanced TypeScript",
      "variantId": "string",
      "variantName": "PDF Edition",
      "assetId": "string",
      "assetName": "advanced-typescript.pdf",
      "customerId": "string",
      "downloadsUsed": 2,
      "maxDownloads": 5,
      "downloadsRemaining": 3,
      "grantedAt": "2026-02-09T23:54:00.000Z",
      "expiresAt": "2027-02-09T23:54:00.000Z",
      "revokedAt": null,
      "lastDownloadAt": "2026-03-01T10:00:00.000Z",
      "isActive": true,
      "isRevoked": false,
      "isExpired": false
    }
  ],
  "meta": {
    "count": 1,
    "activeCount": 1,
    "revokedCount": 0,
    "expiredCount": 0
  }
}
```

> `downloadsRemaining` is the string `"unlimited"` when `maxDownloads` is `null`.
> `variantId`/`variantName` identify which **format** of the digital product was purchased (e.g. "PDF Edition" vs "Source Code (ZIP)"). Each entitlement maps to exactly one variant's asset, with `maxDownloads`/`expiresAt` snapshotted from that variant at purchase time. See the [Digital Products Guide](./digital-products.md).

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor
- `400` – `INVALID_PRODUCT_TYPE` – Order is not a digital order

---

### POST /api/vendor/entitlements/:id/revoke

> [!NOTE]
> Note the base path: `/api/vendor/entitlements/:id/revoke` — the **entitlement ID**, not order ID.

**Description**: Revoke a customer's access to a digital entitlement. Requires a reason for audit purposes.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Entitlement ID

**Request Body**:
```json
{
  "reason": "Customer requested refund"
}
```

- `reason` (**required**, string) - Reason for revocation (logged in audit trail)

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439050",
    "revokedAt": "2026-02-09T23:54:00.000Z",
    "reason": "Customer requested refund",
    "message": "Entitlement revoked successfully"
  },
  "message": "Entitlement revoked successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Entitlement not found or does not belong to vendor's order
- `422` – `DIGITAL_ENTITLEMENT_ALREADY_REVOKED` – Entitlement is already revoked
- `400` – `VALIDATION_ERROR` – Missing or empty reason

---

### POST /api/vendor/entitlements/:id/restore

> [!NOTE]
> Note the base path: `/api/vendor/entitlements/:id/restore` — the **entitlement ID**, not order ID.

**Description**: Restore a previously revoked digital entitlement. Only works if the entitlement has not expired.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Entitlement ID

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Request Body**:
```json
{
  "reason": "Customer issue resolved"
}
```

- `reason` (**required**, string) - Reason for restoration (logged in audit trail)

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439050",
    "restoredAt": "2026-02-09T23:54:00.000Z",
    "reason": "Customer issue resolved",
    "message": "Entitlement restored successfully"
  },
  "message": "Entitlement restored successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Entitlement not found or does not belong to vendor's order
- `422` – `DIGITAL_ENTITLEMENT_NOT_REVOKED` – Entitlement is not currently revoked
- `422` – `DIGITAL_ENTITLEMENT_EXPIRED` – Entitlement has expired and cannot be restored
- `400` – `VALIDATION_ERROR` – Missing or empty reason

---

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error description"
  }
}
```

For validation errors:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "status",
        "message": "Invalid fulfillment status"
      }
    ]
  }
}
```

## Notes & Constraints

### Order Status Values

Valid status values and typical flow:

```
pending → processing → partially_shipped → shipped → partially_delivered → delivered
                              ↘ fulfilled
                              ↘ cancelled (vendor: only from pending/processing)
```

| Status | Description | Who sets it |
|--------|-------------|-------------|
| `pending` | Order received, awaiting vendor action | Vendor |
| `processing` | Vendor is preparing the order | Vendor (also set automatically on payment success) |
| `partially_shipped` | **Physical, multi-agency orders only.** At least one shipment has been picked up by its agency, but not all. | **System** — derived from shipment statuses, see [Fulfillment lifecycle](#fulfillment-lifecycle) |
| `shipped` | Every shipment of the order has been picked up by its agency. | **System** |
| `partially_delivered` | **Physical, multi-agency orders only.** At least one shipment has been customer-confirmed as delivered, but not all. | **System** |
| `delivered` | Every shipment of the order has been customer-confirmed as delivered. Triggers order `completion` (escrow release) automatically. | **System** |
| `fulfilled` | Service completed or digital product delivered | System |
| `cancelled` | Order cancelled by vendor or customer | Vendor/customer — only while `pending`/`processing` |
| `returned` | **Terminal.** Set automatically when a **paid dispute is lost** on an order that had already (partially) shipped/delivered (goods must come back). Vendors cannot set this. |

<a name="fulfillment-lifecycle"></a>
> **Fulfillment lifecycle (physical orders).** An order can be split across several delivery
> agencies — one `Shipment` per agency. `partially_shipped`/`shipped`/`partially_delivered`/
> `delivered` are computed by `OrderFulfillmentAggregationService` after every shipment status
> change and are **never** vendor-settable:
> - `shipped` = every shipment's status is `picked_up` or beyond (`in_transit`, `agent_delivered`,
>   `delivered`). `partially_shipped` = some but not all.
> - `delivered` = every shipment's status is `delivered`, i.e. **customer-confirmed** — an agency
>   marking a shipment `agent_delivered` is not enough on its own; see
>   [agency/shipments.md](../agency/shipments.md) and
>   [customer/orders.md](../customer/orders.md#confirm-shipment).
>   `partially_delivered` = some but not all shipments delivered.
> - See `deliveryTimeline` on `GET /api/vendor/orders/:id` for the merged, per-agency status
>   history behind these aggregates.

### Payment Status Values

| Status | Description |
|--------|-------------|
| `pending` | Payment not yet initiated |
| `AWAITING_PAYMENT` | Awaiting payment confirmation (for COD: awaiting cash handoffs) |
| `partially_paid` | **COD only.** Some of the order's shipments have had their cash collected, others are outstanding (or came back `returned`). |
| `paid` | Payment completed successfully (COD: every shipment's cash collected) |
| `disputed` | **A card payment is under dispute (chargeback). The order is frozen — see "Payment disputes" below.** |
| `failed` | Payment attempt failed (COD: every shipment returned with no cash ever collected) |
| `refunded` | Payment has been refunded (incl. a lost dispute) |

### Cash-on-delivery orders (`paymentMethod: "cash_on_delivery"`)

Every order now carries a `paymentMethod` (`"online"` — the default, prepaid via gateway — or
`"cash_on_delivery"`). COD orders **invert the payment/fulfilment sequence**: they are unpaid at
creation, fulfil first, and get paid per shipment when the delivery agent collects cash against
the customer's delivery code. What changes for the vendor dashboard:

- **Dispatch before payment.** COD orders can be moved to `processing` and dispatched while
  `AWAITING_PAYMENT`. Auto-redirect (if enabled) fires at checkout.
- **Payment progresses with delivery**: `AWAITING_PAYMENT` → `partially_paid` → `paid` as each
  shipment's cash is collected. `payment.received.partial` / `payment.received.full`
  notifications fire on each collection, like online payments.
- **No unpaid auto-cancel.** The daily unpaid-order sweep skips COD orders.
- **Earnings timing differs**: your net for each COD shipment is computed at its cash collection
  (minus platform commission, the agency's delivery fee AND its COD handling fee) and held in
  escrow. Release requires the usual hold window **plus** the physical cash reaching the platform
  through the agency's remittance — COD earnings can therefore stay `pending` longer than online
  ones. See [transactions.md](./transactions.md).
- **Refunds:** there is no gateway to refund against. Post-collection COD refunds are handled
  off-platform in this phase — the refund endpoints report COD orders as ineligible
  (`REFUND_PAYMENT_NOT_FOUND`: no gateway payment transaction exists for them).

### State Transition Rules

The system enforces valid state transitions:
- Cannot transition from terminal states (`delivered`, `fulfilled`, `cancelled`, `returned`) to non-terminal states
- Cannot mark order as `shipped`/`processing` if payment status is not `paid` — **except COD orders**, which fulfil before payment
- **An order on dispute hold cannot advance at all (see below) — returns `423`.**
- State machine validation is enforced in the service layer

### Payment disputes & order freeze (dashboard changes)

Card payments (Stripe) can be **disputed** by the customer (a chargeback). The
backend now reacts to disputes automatically, and the vendor dashboard must
reflect the frozen state.

**The order object carries a `dispute_hold` field:**
```jsonc
"dispute_hold": {
  "active": true,                 // order is frozen
  "disputed_at": "2026-06-24T10:00:00.000Z",
  "resolved_at": null,            // set when won/lost
  "gateway_dispute_id": "dp_123",
  "reason": "stripe_dispute"
}
```

**Lifecycle the dashboard should render:**
1. **Dispute opened** → `payment_status` becomes `disputed` and `dispute_hold.active = true`.
   The order is **frozen**: any call to `PATCH /api/vendor/orders/:id/status` returns
   **`423 ORDER_DISPUTE_HOLD`**. Disable the status-advance buttons and show a clear
   "Payment under dispute — frozen" banner.
2. **Dispute won** → `payment_status` returns to `paid`, `dispute_hold.active = false`.
   Re-enable the normal fulfilment controls.
3. **Dispute lost** (or full refund) → `payment_status` becomes `refunded`,
   `dispute_hold.active = false`, and `fulfillment_status` becomes `returned`
   (if it had shipped/delivered) or `cancelled` (if not). Vendor earnings for the
   order are reversed. The order is terminal — show it as closed/returned.

**What to change on the dashboard:**
- Handle the new `payment_status: "disputed"` and `fulfillment_status: "returned"` values
  (badges, filters, list columns).
- When `dispute_hold.active` is true, **disable all fulfilment actions** and don't even
  attempt the status PATCH; if you do, handle the `423` gracefully (show the banner, not a generic error).
- Surface the dispute on the order detail view (a "Payment disputed" notice with the date).
- Resolution is automatic from Stripe webhooks; the vendor cannot act on a frozen order.
  (Admins can manually resolve via the admin tools if a Stripe event is missed.)

### Date Filters

Date filters (`dateFrom`, `dateTo`) must use ISO 8601 format:
```
2026-02-09T00:00:00.000Z
```

### Search Query

The `q` parameter searches across:
- Order number
- Customer name
- Customer email

### Immutable Fields

The following fields cannot be modified via API:
- `orderNumber`
- `totalAmount`
- `customer` details
- `items` array
- `created_at`

### Vendor-Internal Notes

Notes added via `POST /orders/:id/notes`:
- Are visible only to the vendor (not customer)
- Cannot be edited or deleted after creation
- Are included in administrative order views but not customer views
