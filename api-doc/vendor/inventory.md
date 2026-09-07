# Vendor Inventory Management API

**Verified against source on 2026-09-06** — every claim on this page was checked against
`jovi-mall/src/`, including the whole inherited defect list that `vendor-dash` carried for it
(DOC-PROGRAM § 24–26). Corrections are marked inline with ⚠ and a source citation.

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
  "success": true,
  "data": {
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
}
```

> ⚠ **This endpoint does NOT use the platform's paginated envelope, and its two siblings do.**
> `/alerts` calls `sendSuccess(res, result)` with the service's own object, so the list lives at
> `data.alerts`, the count at `data.total`, and the page info at `data.pagination.totalPages`
> (`InventoryAlertService.ts:103-111`). `/history` and `/reservations` call `sendPaginated`, so
> their list is `data[]` and their page info is `meta`, with the key spelled **`pages`** rather
> than `totalPages`. Three sibling endpoints, two shapes — write two readers.

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
- ⚠ **A variant with `isInfiniteStock: true` CAN appear.** The flag is not consulted anywhere on this path: `InventoryAvailabilityCalculator.calculate` reads `stock`, `activeReservations` and `allowOversell` only (`InventoryAvailabilityCalculator.ts:29-39`), so an infinite-stock variant whose stored `stock` number happens to sit at or under its threshold produces an alert about a quantity that means nothing. Filter these out client-side
- `availableStock` accounts for active reservations — a variant with 5 stock and 5 active reservations shows `availableStock: 0`

---

### PATCH /api/vendor/inventory/bulk-update

Set absolute stock levels for multiple physical product variants in a single atomic operation.

> [!IMPORTANT]
> **All-or-nothing semantics** — for the rows this endpoint actually writes. The batch runs inside a database transaction. If any row fails validation, **no rows are updated** and a `{ "success": false, "errors": [...] }` response is returned. There is no partial success.

> [!WARNING]
> **Rows on an agency-warehoused product are not written.** A SKU whose product has
> `delivery.pickupLocation.source === "agency_storage"` is one an agency physically
> holds, and its quantity now needs that agency's countersignature — see
> [Stock requests](./stock-requests.md). Such rows are partitioned out before the
> transaction opens and come back under **`requested`** as pending approvals, never
> under `variants`.
>
> They sit outside the transaction on purpose: a proposal is not a stock write, and one
> SKU already having an open request must not roll back rows that legitimately applied.

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
  ],
  "requested": [
    {
      "variantId": "507f1f77bcf86cd799439062",
      "sku": "NIKE-AIR-MAX-90-BLK-42",
      "requestId": "665a1f77bcf86cd799439061",
      "requestedQuantity": 200
    }
  ],
  "notRequested": []
}
```

| Field | Description |
|-------|-------------|
| `batchId` | UUID identifying this batch in the audit log |
| `updated` | Number of variants **written**. Counts `variants` only, never `requested` |
| `variants` | Rows that applied — previous and new stock |
| `requested` | Agency-warehoused rows. **Nothing was written for these**; each became a pending [stock request](./stock-requests.md) |
| `notRequested` | Rows that could neither apply nor be queued — `{ variantId, sku, error, message }` |

> **Report the three groups separately.** A row under `requested` has *not* changed
> yet; presenting it as updated is the one way to make this response lie.
>
> `notRequested` is almost always `STOCK_REQUEST_ALREADY_PENDING` — a request is already
> open on that SKU, and somebody has to resolve it first. It is reported rather than
> thrown because the `variants` rows have already committed; failing the whole call
> here would claim a rollback that did not happen.

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
| `AUTH_FORBIDDEN` | Variant does not belong to this vendor (`vendor-inventory.controller.ts:165`). ⚠ **Not `FORBIDDEN`** — that string is in no registry; `AUTH_FORBIDDEN` is the real code |
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
  "success": true,
  "data": [
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
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 2,
    "pages": 1
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
| `adjustment` | ⚠ **The agency stock-request approval path**, not a system correction. It is written when an agency approves (or the vendor withdraws) a proposed quantity change on a warehoused SKU — see [stock-requests.md](./stock-requests.md). `metadata.requestId` carries the request, and it is the only signal on this row that an agency was involved |

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
| `status` | string | `active` | Filter: `active` \| `expired` only — `released` and `committed` are **not** filterable (`inventory.validator.ts:33`). ⚠ **`expired` is not a status filter.** It is translated to `expiresAt < now` with **the status condition dropped entirely** (`stock-reservation.repository.mongo.ts:139-145`), so it returns `committed` and `released` rows too — and a genuinely expired `active` row is usually already gone, deleted by the TTL index on the same field |
| `page` | number | `1` | Page number |
| `limit` | number | `50` | Max 100 |

**Success Response `200`:**

```json
{
  "success": true,
  "data": [
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
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 1,
    "pages": 1,
    "totalReserved": 2
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
| `active` | Locked — order is in-flight. The only status that subtracts from availability |
| `released` | Order cancelled, or the hold was given up. `variant.stock` is **untouched** — the units free up because the row stops being `active`, not because anything was added back |
| `committed` | Converted to a fulfilled order. **The only stage that decrements `variant.stock`**, and it happens exactly once |
| `expired` | ⚠ **You will never see this on a row.** It is in the type and is accepted as a *filter*, but nothing ever assigns it — an elapsed hold is **TTL-deleted**, not restatused (see the note below). As a filter it means `expiresAt < now` with the status condition dropped, so it returns `committed` and `released` rows too |

> ⚠ **The `expired` row above said "stock returned" until 2026-09-06, contradicting the note
> directly beneath it.** Nothing is returned at any stage except `commit`'s single decrement —
> the stage table in `StockReservationService.ts:57-62` is the authority, and it reads
> *untouched · decremented ONCE · untouched · untouched*. This is worth stating twice because
> the intuitive model (take stock at reserve, give it back on release) is the design that was
> **rejected**: with a TTL deleting the row, a release could never run on an abandoned cart and
> every one would have destroyed its units permanently.

**`totalReserved`**: Sum of `quantity` across all reservations in the result page. Useful for showing "X units currently locked" in the UI.

> [!NOTE]
> Reservations expire automatically via a MongoDB TTL index on `expiresAt` — the row is **deleted**.
>
> ⚠ **No `release` audit log is written and no stock is "returned", because none was ever taken.**
> `reserve` does not touch `variant.stock` at all; only `commit` decrements it, once. Availability
> is `stock − Σ active reservations`, so a lapsed hold frees its units simply by ceasing to exist —
> there is nothing to compensate and nothing to log. This paragraph described the *original*
> design, which decrement-at-reserve made unimplementable: the TTL deletes the row, so a release
> could never run on it and every abandoned checkout would have destroyed its units permanently.
> `countActiveByVariant` additionally excludes already-expired rows, so the units come back
> immediately rather than waiting for Mongo's ~60-second sweep. The `/alerts` figure is consistent
> with this endpoint for the same reason.

---

## Error Response Format

All endpoints use this format for errors. `category` is one of the nine values listed in
[`errors/README.md`](../errors/README.md) and is **always present**; `details` is omitted
entirely when absent.

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "CATALOG_VARIANT_NOT_FOUND",
    "message": "Human-readable description",
    "statusCode": 404,
    "category": "not_found"
  }
}
```

Validation errors from the Zod schema carry `details.fields[]`, where `path` is the dot-joined
location and `code` is the Zod issue kind:

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "statusCode": 400,
    "category": "validation",
    "details": {
      "fields": [
        { "path": "quantity", "message": "Quantity must be an integer", "code": "invalid_type" }
      ]
    }
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
