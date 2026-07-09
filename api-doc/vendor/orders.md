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
- `paymentStatus` (string, optional) - Filter by payment status. Enum: `pending`, `AWAITING_PAYMENT`, `paid`, `disputed`, `failed`, `refunded`
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
order items. Requires the order to be `paid` and not on dispute hold.

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
- `422` – `ORDER_PAYMENT_REQUIRED` – Order is not yet paid.
- `423` – `ORDER_DISPUTE_HOLD` – Order is frozen by an open payment dispute.

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
| `AWAITING_PAYMENT` | Awaiting payment confirmation |
| `paid` | Payment completed successfully |
| `disputed` | **A card payment is under dispute (chargeback). The order is frozen — see "Payment disputes" below.** |
| `failed` | Payment attempt failed |
| `refunded` | Payment has been refunded (incl. a lost dispute) |

### State Transition Rules

The system enforces valid state transitions:
- Cannot transition from terminal states (`delivered`, `fulfilled`, `cancelled`, `returned`) to non-terminal states
- Cannot mark order as `shipped`/`processing` if payment status is not `paid`
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
