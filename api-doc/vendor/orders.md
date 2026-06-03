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
- `status` (string, optional) - Filter by order status. Enum: `pending`, `processing`, `shipped`, `delivered`, `fulfilled`, `cancelled`
- `paymentStatus` (string, optional) - Filter by payment status. Enum: `pending`, `AWAITING_PAYMENT`, `paid`, `failed`, `refunded`
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
        "currency": "XAF"
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
    "delivery": {
      "agencyId": "507f1f77bcf86cd799439099",
      "agencyName": "FastShip Logistics",
      "agencyPhone": "+237600000000",
      "deliveryStatus": "assigned",
      "shipmentId": "507f1f77bcf86cd799439100",
      "agent": {
        "id": "507f1f77bcf86cd799439101",
        "name": "John Doe",
        "phone": "+237600000001",
        "avatarUrl": "https://..."
      }
    },
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
> - `delivery` is `null` for digital orders. `delivery.agent` is `null` until an agent is assigned to the shipment.
> - `delivery.deliveryStatus` reflects the per-item delivery status: `pending`, `assigned`, `picked_up`, `in_transit`, `delivered`, `failed`, or `returned`.
> - `priceBreakdown.shipping` is always `0` — shipping cost tracking is not yet implemented in the order schema.

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor

---

### PATCH /api/vendor/orders/:id/status

**Description**: Update the fulfillment status of an order. Enforces state machine transitions.

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
  "status": "string (required) - New status. Enum: pending, processing, shipped, delivered, cancelled"
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
  "message": "Order status updated to 'shipped'"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor
- `400` – `VALIDATION_ERROR` – Invalid status value
- `400` – `INVALID_STATE_TRANSITION` – State transition not allowed (e.g., cannot move from `delivered` to `processing`)
- `403` – `FORBIDDEN` – Cannot update status (e.g., payment not confirmed)

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

**Description**: Assign or change the delivery agency for a physical order.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Order ID

**Request Body**:
```json
{
  "deliveryAgencyId": "507f1f77bcf86cd799439099"
}
```

**Success Response**:

Status: `200 OK`

Body:

The response is the full updated order details object (same shape as `GET /api/vendor/orders/:id`), with the `delivery.agencyId` and `delivery.agencyName` fields now reflecting the new agency.

```json
{
  "success": true,
  "data": { "...same as GET /api/vendor/orders/:id data..." },
  "message": "Delivery agency updated successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor
- `400` – `INVALID_PRODUCT_TYPE` – Order does not contain physical products requiring delivery

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
pending → processing → shipped → delivered
                              ↘ fulfilled
                              ↘ cancelled (from any state)
```

| Status | Description |
|--------|-------------|
| `pending` | Order received, awaiting vendor action |
| `processing` | Vendor is preparing the order |
| `shipped` | Order has been shipped to customer |
| `delivered` | Order delivered to customer (physical products) |
| `fulfilled` | Service completed or digital product delivered |
| `cancelled` | Order cancelled by vendor or customer |

### Payment Status Values

| Status | Description |
|--------|-------------|
| `pending` | Payment not yet initiated |
| `AWAITING_PAYMENT` | Awaiting payment confirmation |
| `paid` | Payment completed successfully |
| `failed` | Payment attempt failed |
| `refunded` | Payment has been refunded |

### State Transition Rules

The system enforces valid state transitions:
- Cannot transition from terminal states (`delivered`, `fulfilled`, `cancelled`) to non-terminal states
- Cannot mark order as `shipped` if payment status is not `paid`
- State machine validation is enforced in the service layer

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
