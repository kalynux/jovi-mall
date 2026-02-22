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
      "_id": "string",
      "orderNumber": "string",
      "status": "pending",
      "paymentStatus": "paid",
      "totalAmount": 150.00,
      "customer": {
        "name": "string",
        "email": "string"
      },
      "itemCount": 3,
      "created_at": "2026-02-09T23:54:00.000Z",
      "updated_at": "2026-02-09T23:54:00.000Z"
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "limit": 20,
    "totalPages": 3
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
    "_id": "string",
    "orderNumber": "string",
    "status": "processing",
    "paymentStatus": "paid",
    "totalAmount": 150.00,
    "customer": {
      "_id": "string",
      "name": "string",
      "email": "string",
      "phone": "string"
    },
    "items": [
      {
        "productId": "string",
        "productName": "string",
        "variantId": "string",
        "quantity": 2,
        "price": 50.00,
        "subtotal": 100.00
      }
    ],
    "shippingAddress": {
      "street": "string",
      "city": "string",
      "state": "string",
      "zipCode": "string",
      "country": "string"
    },
    "created_at": "2026-02-09T23:54:00.000Z",
    "updated_at": "2026-02-09T23:54:00.000Z"
  }
}
```

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
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "orderNumber": "string",
    "status": "shipped",
    "paymentStatus": "paid",
    "totalAmount": 150.00,
    "updated_at": "2026-02-09T23:54:00.000Z"
  },
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
      "eventType": "status_changed",
      "oldValue": "pending",
      "newValue": "processing",
      "actor": {
        "type": "vendor",
        "id": "string",
        "name": "string"
      },
      "created_at": "2026-02-09T23:54:00.000Z"
    }
  ],
  "meta": {
    "total": 15,
    "page": 1,
    "limit": 20,
    "totalPages": 1
  }
}
```

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
    "_id": "string",
    "orderId": "string",
    "message": "Customer requested gift wrapping",
    "authorId": "string",
    "authorName": "string",
    "created_at": "2026-02-09T23:54:00.000Z"
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
      "_id": "string",
      "orderId": "string",
      "message": "Customer requested gift wrapping",
      "authorId": "string",
      "authorName": "string",
      "created_at": "2026-02-09T23:54:00.000Z"
    }
  ]
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor

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
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "deliveryAgencyId": "507f1f77bcf86cd799439099",
    "updated_at": "2026-02-09T23:54:00.000Z"
  },
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
      "_id": "507f1f77bcf86cd799439050",
      "orderId": "string",
      "productId": "string",
      "customerId": "string",
      "status": "active",
      "downloadCount": 2,
      "maxDownloads": 5,
      "expiresAt": "2027-02-09T23:54:00.000Z",
      "revokedAt": null,
      "revokeReason": null,
      "createdAt": "2026-02-09T23:54:00.000Z"
    }
  ]
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Order not found or does not belong to vendor

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
    "_id": "507f1f77bcf86cd799439050",
    "status": "revoked",
    "revokedAt": "2026-02-09T23:54:00.000Z",
    "revokeReason": "Customer requested refund"
  },
  "message": "Entitlement revoked successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Entitlement not found or does not belong to vendor's order
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

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439050",
    "status": "active",
    "revokedAt": null,
    "revokeReason": null
  },
  "message": "Entitlement restored successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Entitlement not found or does not belong to vendor's order
- `400` – `ENTITLEMENT_EXPIRED` – Entitlement has expired and cannot be restored
- `400` – `ENTITLEMENT_NOT_REVOKED` – Entitlement is not currently revoked

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
