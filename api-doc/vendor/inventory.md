# Vendor Inventory Management API

## Base Path

```
/api/vendor/inventory
```

## Authentication

All endpoints require vendor authentication:

```
Authorization: Bearer <access_token>
```

---

## Overview

The inventory API covers three concerns:

| Concern | Endpoint |
|---------|----------|
| Proactive stock monitoring | `GET /alerts` |
| Bulk stock level updates | `PATCH /bulk-update` |
| Audit trail of all stock changes | `GET /history` |
| Active order reservations | `GET /reservations` |

> [!NOTE]
> **Physical products only.** Stock tracking (`stock`, `isInfiniteStock`, `lowStockThreshold`, `allowOversell`) applies exclusively to physical product variants. The bulk-update endpoint explicitly rejects digital and service product variants.

---

## Endpoints

### GET /api/vendor/inventory/alerts

Returns a paginated list of variants that are at or below their configured `lowStockThreshold`. Only variants where `lowStockThreshold` is not null are evaluated.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | `1` | Page number (1-indexed) |
| `limit` | number | `50` | Max 100 |

**Success Response `200`:**

```json
{
  "alerts": [
    {
      "variantId": "507f1f77bcf86cd799439060",
      "productId": "507f1f77bcf86cd799439011",
      "productTitle": "Blue T-Shirt",
      "sku": "SHIRT-BLK-M",
      "currentStock": 3,
      "activeReservations": 1,
      "availableStock": 2,
      "threshold": 5,
      "stockPercentage": 40
    },
    {
      "variantId": "507f1f77bcf86cd799439061",
      "productId": "507f1f77bcf86cd799439012",
      "productTitle": "Leather Jacket",
      "sku": "JACKET-BR-L",
      "currentStock": 0,
      "activeReservations": 0,
      "availableStock": 0,
      "threshold": 5,
      "stockPercentage": 0
    }
  ],
  "total": 2,
  "pagination": {
    "page": 1,
    "limit": 50,
    "totalPages": 1
  }
}
```

**Alert Object Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `variantId` | string | Variant ObjectId |
| `productId` | string | Parent product ObjectId |
| `productTitle` | string | Product title for display |
| `sku` | string | Variant SKU |
| `currentStock` | number | Raw stock count stored on the variant |
| `activeReservations` | number | Units currently locked by in-flight orders |
| `availableStock` | number | `currentStock - activeReservations` (what customers can actually buy) |
| `threshold` | number | The `lowStockThreshold` value configured on the variant |
| `stockPercentage` | number \| null | `availableStock / threshold * 100`; null if not calculable |

> **How alerts are triggered**: A variant appears here when `availableStock <= threshold`. There is no separate alert level field — `stockPercentage` and `availableStock === 0` give you the severity. `stockPercentage: 0` means out of stock.

**Business Rules:**
- Only variants with `lowStockThreshold` set (non-null) are evaluated
- A variant with `isInfiniteStock: true` will never appear (infinite stock cannot be low)
- `availableStock` accounts for active reservations — a variant with 5 stock and 5 active reservations shows `availableStock: 0`

---

### PATCH /api/vendor/inventory/bulk-update

Set absolute stock levels for multiple physical product variants in a single atomic operation.

> [!IMPORTANT]
> **All-or-nothing semantics.** The entire batch runs inside a database transaction. If any row fails validation, **no rows are updated** and a `{ "success": false, "errors": [...] }` response is returned. There is no partial success for this endpoint.

**Max rows per request**: 1,000

Supports two input formats: JSON body or CSV file upload.

---

#### Option A: JSON Body

```http
PATCH /api/vendor/inventory/bulk-update
Authorization: Bearer <token>
Content-Type: application/json

{
  "updates": [
    { "variantId": "507f1f77bcf86cd799439060", "quantity": 50 },
    { "variantId": "507f1f77bcf86cd799439061", "quantity": 0 }
  ]
}
```

**`updates` array item fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `variantId` | string | ✅ | Variant ObjectId |
| `quantity` | number | ✅ | **Absolute** stock level to set (integer). Negative values allowed only if `variant.allowOversell` is true |

> **Absolute values only.** To add 10 units to a variant at 40, send `"quantity": 50`. There is no delta/increment mode.

---

#### Option B: CSV File

```http
PATCH /api/vendor/inventory/bulk-update
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: [stock-update.csv]
```

**Required CSV columns** (exact names, order doesn't matter):

```csv
variantId,quantity
507f1f77bcf86cd799439060,50
507f1f77bcf86cd799439061,0
507f1f77bcf86cd799439062,200
```

**CSV Constraints:**
- Max file size: 5MB
- Accepted MIME type: `text/csv`
- File extension must be `.csv`
- Required columns: `variantId`, `quantity`
- No extra columns allowed — unknown columns return a 400 error
- Max 1,000 rows

---

#### Success Response `200`

Returned when **all rows** pass validation and are updated:

```json
{
  "success": true,
  "batchId": "a3f5c9d2-1b4e-4f8a-9c2d-7e6b8a1f3d5c",
  "updated": 3,
  "variants": [
    {
      "variantId": "507f1f77bcf86cd799439060",
      "sku": "SHIRT-BLK-M",
      "previousStock": 40,
      "newStock": 50
    },
    {
      "variantId": "507f1f77bcf86cd799439061",
      "sku": "JACKET-BR-L",
      "previousStock": 8,
      "newStock": 0
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `batchId` | UUID identifying this batch in the audit log |
| `updated` | Number of variants updated |
| `variants` | Per-variant result showing previous and new stock |

---

#### Validation Failure Response `400`

Returned when **any row** fails validation. No rows are updated.

```json
{
  "success": false,
  "errors": [
    {
      "row": 2,
      "variantId": "507f1f77bcf86cd799439061",
      "error": "VARIANT_ARCHIVED",
      "message": "Cannot update stock for archived variant"
    },
    {
      "row": 3,
      "variantId": "507f1f77bcf86cd799439062",
      "error": "FORBIDDEN",
      "message": "Variant does not belong to vendor"
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `row` | 1-indexed row number of the failing item |
| `variantId` | The variant that failed |
| `error` | Machine-readable error code |
| `message` | Human-readable reason |

**Validation Error Codes:**

| Code | Reason |
|------|--------|
| `INVALID_QUANTITY` | `quantity` is not an integer |
| `INVALID_VARIANT` | Variant not found |
| `VARIANT_ARCHIVED` | Variant has `status: "archived"` |
| `FORBIDDEN` | Variant does not belong to this vendor |
| `INVALID_PRODUCT_TYPE` | Variant belongs to a digital or service product |
| `OVERSALE_NOT_ALLOWED` | Negative quantity sent but `allowOversell` is false on the variant |

**Other Error Responses:**

| Status | Code | Reason |
|--------|------|--------|
| 400 | `CATALOG_INVALID_CSV` | CSV parsing failed or required columns missing |
| 422 | `CATALOG_BULK_LIMIT_EXCEEDED` | More than 1,000 rows in the batch |
| 413 | `CATALOG_BULK_TRANSACTION_LIMIT` | Batch too large for a single DB transaction — reduce batch size |

---

### GET /api/vendor/inventory/history

Audit log of all stock changes for the vendor's variants. Records are append-only and immutable. Useful for reconciliation and debugging stock discrepancies.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `variantId` | string | — | Filter to a specific variant |
| `startDate` | string | — | ISO 8601 datetime — lower bound on `timestamp` |
| `endDate` | string | — | ISO 8601 datetime — upper bound on `timestamp` |
| `page` | number | `1` | Page number |
| `limit` | number | `50` | Max 100 |

**Success Response `200`:**

```json
{
  "logs": [
    {
      "id": "507f1f77bcf86cd799439070",
      "variantId": "507f1f77bcf86cd799439060",
      "sku": "SHIRT-BLK-M",
      "previousQuantity": 51,
      "newQuantity": 50,
      "delta": -1,
      "operation": "order",
      "timestamp": "2026-02-09T23:54:00.000Z",
      "metadata": {
        "orderId": "507f1f77bcf86cd799439001"
      }
    },
    {
      "id": "507f1f77bcf86cd799439071",
      "variantId": "507f1f77bcf86cd799439060",
      "sku": "SHIRT-BLK-M",
      "previousQuantity": 1,
      "newQuantity": 51,
      "delta": 50,
      "operation": "bulk",
      "timestamp": "2026-02-08T12:00:00.000Z",
      "metadata": {
        "batchId": "a3f5c9d2-1b4e-4f8a-9c2d-7e6b8a1f3d5c"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 2,
    "totalPages": 1
  }
}
```

**Log Object Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Log entry ObjectId |
| `variantId` | string | Variant this log belongs to |
| `sku` | string | Variant SKU (enriched for display) |
| `previousQuantity` | number | Stock before the change |
| `newQuantity` | number | Stock after the change |
| `delta` | number | `newQuantity - previousQuantity` (negative = stock decreased) |
| `operation` | string | What caused the change — see operation table below |
| `timestamp` | string | ISO 8601 datetime when the change occurred |
| `metadata` | object | Context-specific extras — see below |

**`operation` Values:**

| Value | Description |
|-------|-------------|
| `order` | Stock decremented when an order was fulfilled |
| `reservation` | Stock locked when a reservation was created |
| `release` | Stock returned when a reservation was released or order cancelled |
| `bulk` | Changed via `PATCH /bulk-update` |
| `manual` | Changed via a direct vendor manual adjustment |
| `adjustment` | System-level correction |

**`metadata` Fields (context-dependent):**

| Field | Present When | Description |
|-------|-------------|-------------|
| `orderId` | `operation: "order"` | The order that triggered the change |
| `reservationId` | `operation: "reservation"` or `"release"` | The reservation involved |
| `batchId` | `operation: "bulk"` | The batch UUID from the bulk-update response |
| `reason` | Various | Free-text reason if provided |

---

### GET /api/vendor/inventory/reservations

Active stock reservations — units temporarily locked by in-flight orders that have not yet been fulfilled or cancelled.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `variantId` | string | — | Filter to a specific variant |
| `status` | string | `active` | Filter: `active`, `expired` |
| `page` | number | `1` | Page number |
| `limit` | number | `50` | Max 100 |

**Success Response `200`:**

```json
{
  "reservations": [
    {
      "reservationId": "res-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "variantId": "507f1f77bcf86cd799439060",
      "sku": "SHIRT-BLK-M",
      "productTitle": "Blue T-Shirt",
      "quantity": 2,
      "type": "physical",
      "status": "active",
      "expiresAt": "2026-02-10T00:54:00.000Z",
      "createdAt": "2026-02-09T23:54:00.000Z"
    }
  ],
  "totalReserved": 2,
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1,
    "totalPages": 1
  }
}
```

**Reservation Object Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `reservationId` | string | Unique idempotency key for this reservation |
| `variantId` | string | Reserved variant |
| `sku` | string | Variant SKU (enriched) |
| `productTitle` | string | Product title (enriched) |
| `quantity` | number | Units locked |
| `type` | string | `physical`, `digital`, or `service` |
| `status` | string | `active`, `released`, `committed`, or `expired` |
| `expiresAt` | string | ISO 8601 — when the reservation will auto-expire if not fulfilled |
| `createdAt` | string | ISO 8601 — when the reservation was created |

**`status` Values:**

| Value | Description |
|-------|-------------|
| `active` | Locked — order is in-flight |
| `released` | Returned to available pool (order cancelled or timed out) |
| `committed` | Converted to a fulfilled order |
| `expired` | TTL elapsed — reservation auto-expired; stock returned |

**`totalReserved`**: Sum of `quantity` across all reservations in the result page. Useful for showing "X units currently locked" in the UI.

> [!NOTE]
> Reservations expire automatically via a MongoDB TTL index on `expiresAt`. When a reservation expires, a `release` audit log entry is created and `reservation_expired` stock is returned. The `/alerts` endpoint's `availableStock` already deducts `activeReservations` so the two endpoints are consistent.

---

## Error Response Format

All endpoints use this format for errors:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

Validation errors from the Zod schema include a `details` array:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "quantity", "message": "Quantity must be an integer" }
    ]
  }
}
```

---

## Notes & Constraints

### Stock Semantics

- All stock values are **absolute** — the system does not support delta/increment updates. Always send the target quantity, not a change amount.
- `currentStock` and `availableStock` differ when there are active reservations. Frontend should display `availableStock` as the purchasable quantity and `currentStock` as the physical inventory count.

### Negative Stock (Backorder)

If `variant.allowOversell` is `true`, the bulk-update endpoint accepts negative `quantity` values. This represents a backorder state — the vendor owes stock that doesn't yet exist. The `/alerts` endpoint will show `availableStock < 0` for such variants.

### CSV File Constraints Summary

| Constraint | Limit |
|-----------|-------|
| Max file size | 5MB |
| Accepted MIME type | `text/csv` |
| Required extension | `.csv` |
| Required columns | `variantId`, `quantity` |
| Extra columns | Not allowed (400 error) |
| Max rows | 1,000 |

### Audit Log Immutability

Stock audit logs are **append-only**. The `IStockAuditLog` Mongoose schema blocks `findOneAndUpdate` and `findOneAndDelete` at the pre-hook level. No log entry can ever be modified or deleted. This ensures a trustworthy audit trail.
