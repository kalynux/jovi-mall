# Vendor Inventory Management API

## Base Path

All endpoints in this document share this base path:

```
/api/vendor/inventory
```

## Authentication

**Authorization**: Vendor access required.

All requests must include a valid Bearer token with vendor role:

```
Authorization: Bearer <access_token>
```

---

## Endpoints

### GET /api/vendor/inventory/alerts

**Description**: Get low-stock and out-of-stock alerts for the vendor's physical product variants. Use this to proactively identify variants that need restocking.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

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
      "variantId": "507f1f77bcf86cd799439060",
      "productId": "507f1f77bcf86cd799439011",
      "productTitle": "Blue T-Shirt",
      "sku": "SHIRT-BLK-M",
      "stock": 2,
      "alertLevel": "low_stock",
      "threshold": 5
    },
    {
      "variantId": "507f1f77bcf86cd799439061",
      "productId": "507f1f77bcf86cd799439012",
      "productTitle": "Leather Jacket",
      "sku": "JACKET-BR-L",
      "stock": 0,
      "alertLevel": "out_of_stock",
      "threshold": 5
    }
  ]
}
```

**Alert Levels**:

| Level | Description |
|-------|-------------|
| `low_stock` | Stock is below the configured threshold |
| `out_of_stock` | Stock is 0 |

**Error Responses**:
- `401` – `UNAUTHORIZED` – Missing or invalid token
- `403` – `FORBIDDEN` – Insufficient role

---

### PATCH /api/vendor/inventory/bulk-update

**Description**: Bulk update stock levels for multiple variants at once. Supports both JSON body and CSV file upload.

**Authorization**: Vendor access required.

> [!TIP]
> Use the CSV format for large updates (e.g., reconciling physical stock counts). Export your products to CSV, update the `stock` column, and re-upload.

#### Option A: JSON Body

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Request Body**:
```json
{
  "updates": [
    {
      "variantId": "507f1f77bcf86cd799439060",
      "stock": 50
    },
    {
      "variantId": "507f1f77bcf86cd799439061",
      "stock": 0,
      "isInfiniteStock": true
    }
  ]
}
```

**Fields per update item**:
- `variantId` (**required**, string) – Variant to update
- `stock` (optional, integer, >= 0) – New absolute stock count
- `isInfiniteStock` (optional, boolean) – Toggle infinite stock mode

#### Option B: CSV Upload

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: multipart/form-data`

**Request Body**: `multipart/form-data`
- `file` (file, required) – CSV file (max 5MB)

**Expected CSV columns**:
```csv
variantId,stock,isInfiniteStock
507f1f77bcf86cd799439060,50,false
507f1f77bcf86cd799439061,0,true
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "updated": 2,
    "failed": 0,
    "total": 2,
    "errors": []
  },
  "message": "Inventory updated for 2 of 2 variants"
}
```

**Partial Failure Response** (some variants failed):
```json
{
  "success": true,
  "data": {
    "updated": 1,
    "failed": 1,
    "total": 2,
    "errors": [
      {
        "variantId": "507f1f77bcf86cd799439061",
        "reason": "Variant not found or does not belong to vendor"
      }
    ]
  },
  "message": "Inventory updated for 1 of 2 variants"
}
```

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Invalid body or CSV format
- `400` – `NO_FILE` – No file provided (CSV mode)
- `400` – `INVALID_FILE_TYPE` – Only CSV files are allowed (max 5MB)

---

### GET /api/vendor/inventory/history

**Description**: View the history of inventory adjustments for the vendor's variants. Useful for auditing stock changes over time.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

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
      "_id": "507f1f77bcf86cd799439070",
      "variantId": "507f1f77bcf86cd799439060",
      "sku": "SHIRT-BLK-M",
      "adjustment": -1,
      "reason": "order_fulfilled",
      "stockBefore": 51,
      "stockAfter": 50,
      "createdAt": "2026-02-09T23:54:00.000Z"
    },
    {
      "_id": "507f1f77bcf86cd799439071",
      "variantId": "507f1f77bcf86cd799439060",
      "sku": "SHIRT-BLK-M",
      "adjustment": 50,
      "reason": "manual_update",
      "stockBefore": 1,
      "stockAfter": 51,
      "createdAt": "2026-02-08T12:00:00.000Z"
    }
  ]
}
```

**Adjustment Reasons**:

| Reason | Description |
|--------|-------------|
| `order_fulfilled` | Stock decremented due to an order being fulfilled |
| `order_cancelled` | Stock restored due to an order cancellation |
| `manual_update` | Vendor made a manual stock adjustment |
| `bulk_update` | Updated via the bulk-update endpoint |
| `reservation_expired` | Reserved stock returned to available pool |

**Error Responses**:
- `401` – `UNAUTHORIZED` – Missing or invalid token

---

### GET /api/vendor/inventory/reservations

**Description**: View active inventory reservations — stock that has been temporarily held for pending orders but not yet fulfilled (i.e., in-flight orders that lock stock to prevent overselling).

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

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
      "_id": "507f1f77bcf86cd799439080",
      "variantId": "507f1f77bcf86cd799439060",
      "sku": "SHIRT-BLK-M",
      "orderId": "507f1f77bcf86cd799439001",
      "quantity": 2,
      "expiresAt": "2026-02-10T00:54:00.000Z",
      "createdAt": "2026-02-09T23:54:00.000Z"
    }
  ]
}
```

> [!NOTE]
> Reservations expire automatically if an order is not completed within the configured window. When a reservation expires, the `reservation_expired` adjustment appears in `/history`.

**Error Responses**:
- `401` – `UNAUTHORIZED` – Missing or invalid token

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

For validation errors, a `details` array is included:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "stock",
        "message": "Stock must be a non-negative integer"
      }
    ]
  }
}
```

## Notes & Constraints

### Physical Products Only

Inventory management applies exclusively to **physical product variants**. Digital and service products do not use stock tracking.

### Infinite Stock

When `isInfiniteStock: true`, the `stock` field is ignored for order fulfillment. The variant can always be ordered regardless of the `stock` count. Use for digital content sold on physical products or print-on-demand items.

### CSV File Constraints

- Maximum file size: **5MB**
- Accepted MIME type: `text/csv`
- File extension must be `.csv`
- Required columns: `variantId`, `stock`
- Optional columns: `isInfiniteStock`

### Bulk Update Semantics

- All updates set **absolute** stock values, not deltas
- To add 10 units to a variant with 40 in stock, send `"stock": 50`
- Vendor ownership is verified for every `variantId` in the batch
- Failed items do not block successful items — partial success is possible
