# Variant Management API

## Overview

Variants are the SKU-level entities that hold **price**, **stock**, **physical attributes**, and (for services) **booking configuration** for a product. Every product — physical, digital, or service — must have at least one variant before it can be activated.

**Key rules:**
- **Physical products**: Support full variant features — option-based matrix (Size × Color), dimensions, delivery agency assignment
- **Digital products**: Support **1–5 variants**, each representing a downloadable **format** (PDF, ZIP, EPUB, …) with its own asset, price, SKU, name, and download limits. No option values, no dimensions, no delivery agency. A digital variant is `active` only when it has an uploaded asset — see [Digital Products Guide](./digital-products.md).
- **Service products**: Have **exactly one** variant that carries the service's **price** and **`serviceConfig`** (slot duration, buffers, booking mode, and optional peak-hours surcharge). No option values, no dimensions, no delivery agency, no `digitalConfig`. `price` is the base price **per `serviceConfig.durationMinutes`** (e.g. `5000` for a 60-min unit); the booking price is prorated by the actual elapsed duration. Attempting to create a second variant returns `409 CATALOG_SERVICE_VARIANT_EXISTS`.

**Default Variant Auto-assignment:**
When the **first** variant is created for any product, the backend automatically sets `product.defaultVariantId` to that variant's ID and sets `product.hasVariants = true`. Use `PATCH /products/:id/default-variant` to manually reassign afterward.

**Default Variant on Archive:**
When the current `defaultVariantId` variant is archived, the backend automatically reassigns `defaultVariantId` to the next active variant (ordered by creation), or clears it if none remain.

---

## Authentication

All endpoints require:
```
Authorization: Bearer <vendor_jwt>
Content-Type: application/json
```

Vendors can only manage variants for their own products.

---

## Base Path

```
/api/vendor/products
```

---

## Variant Object Shape

This is the full shape of a variant object returned by all read endpoints:

```json
{
  "id": "507f1f77bcf86cd799439015",
  "productId": "507f1f77bcf86cd799439011",
  "sku": "TSHIRT-RED-M",
  "name": "Red / Medium",
  "status": "active",
  "optionSignature": "507f1f77bcf86cd799439030|507f1f77bcf86cd799439031",
  "price": 29.99,
  "compareAtPrice": 39.99,
  "stock": 100,
  "isInfiniteStock": false,
  "lowStockThreshold": 10,
  "allowOversell": false,
  "weight": 200,
  "length": 30,
  "width": 20,
  "height": 2,
  "optionValueIds": ["507f1f77bcf86cd799439030", "507f1f77bcf86cd799439031"],
  "files": [
    {
      "id": "507f1f77bcf86cd799439040",
      "key": "products/variant-img.jpg",
      "url": "https://storage.example.com/products/variant-img.jpg",
      "mimeType": "image/jpeg",
      "size": 123456,
      "originalName": "red-medium.jpg"
    }
  ],
  "deliveryAgencyId": "507f1f77bcf86cd799439050",
  "createdAt": "2026-01-29T10:00:00.000Z",
  "updatedAt": "2026-01-29T10:00:00.000Z",
  "deletedAt": null,
  "purgeAt": null
}
```

**Digital variant — additional fields:**

For variants of a `type: "digital"` product, read endpoints also return a `displayName` and a `digital` block:

```json
{
  "name": null,
  "displayName": "js-course.pdf - pdf - 12 MB",
  "status": "active",
  "digital": {
    "asset": {
      "id": "507f1f77bcf86cd799439030",
      "originalName": "js-course.pdf",
      "mimeType": "application/pdf",
      "size": 12582912
    },
    "maxDownloads": 5,
    "expiresAfterDays": 365
  }
}
```

**Service variant — additional fields:**

For the single variant of a `type: "service"` product, read endpoints also return a `serviceConfig` block. `price` is the base price per `serviceConfig.durationMinutes`.

```json
{
  "name": "Booking",
  "price": 5000,
  "optionSignature": "default",
  "serviceConfig": {
    "durationMinutes": 60,
    "bufferBeforeMinutes": 0,
    "bufferAfterMinutes": 0,
    "bookingMode": "calendar",
    "peakHours": {
      "daysOfWeek": [0, 6],
      "startTime": "18:00",
      "endTime": "21:00",
      "priceType": "percentage",
      "value": 20
    }
  }
}
```

`peakHours` is optional. When present, the surcharge applies **only to the minutes of a booking that overlap `[startTime, endTime)` on the listed `daysOfWeek`** (empty `daysOfWeek` = every day). `priceType: "percentage"` scales the peak-portion price by `value` percent; `priceType: "fixed"` adds a flat `value` when any peak overlap exists.

**Field reference:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Variant ObjectId |
| `productId` | string | Parent product ObjectId |
| `sku` | string | Globally unique SKU identifier |
| `name` | string \| null | Human-readable variant name (optional) |
| `displayName` | string | Computed label, always present. Fallback: `name` → `"<asset> - <format> - <size>"` → product title → sku |
| `status` | `"active"` \| `"archived"` | Archived variants are excluded from listings. For digital variants, `active` requires an uploaded asset |
| `digital` | object \| undefined | Digital variants only. `{ asset?, maxDownloads, expiresAfterDays }`. `asset` is `{ id, originalName, mimeType, size }` once uploaded; the raw download URL is never exposed here |
| `serviceConfig` | object \| undefined | Service variant only. `{ durationMinutes, bufferBeforeMinutes, bufferAfterMinutes, bookingMode, maxBookings?, peakHours? }`. `price` is the base price per `durationMinutes`. `maxBookings` is the seats-per-slot, present only for capacity mode |
| `optionSignature` | string | System-generated — pipe-joined sorted optionValueIds. Empty string `""` for variants with no options |
| `price` | number | Selling price |
| `compareAtPrice` | number \| undefined | Original/MSRP price — show as "was" price if > price |
| `stock` | number | Current inventory count |
| `isInfiniteStock` | boolean | If `true`, stock is unlimited; `stock` field is ignored |
| `lowStockThreshold` | number \| null | Alert threshold. `null` = no alerts |
| `allowOversell` | boolean | If `true`, orders allowed even when `stock <= 0` (backorder) |
| `weight` | number \| undefined | Weight in grams (physical products only) |
| `length` | number \| undefined | Length in cm (physical products only) |
| `width` | number \| undefined | Width in cm (physical products only) |
| `height` | number \| undefined | Height in cm (physical products only) |
| `optionValueIds` | string[] | Option value ObjectIds this variant represents (physical products only) |
| `files` | FileDetail[] | Variant-specific image/media files, fully populated. Each entry: `{ id, key, url, mimeType, size, originalName? }` |
| `deliveryAgencyId` | string \| undefined | Override delivery agency for this variant (physical products only) |

---

## Endpoints

### POST /api/vendor/products/:id/variants

Create a new variant for a product.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Product ObjectId |

**Request Body — Physical Product:**

```json
{
  "sku": "TSHIRT-RED-M",
  "name": "Red / Medium",
  "price": 29.99,
  "compareAtPrice": 39.99,
  "stock": 100,
  "isInfiniteStock": false,
  "weight": 200,
  "length": 30,
  "width": 20,
  "height": 2,
  "optionValueIds": ["507f1f77bcf86cd799439030", "507f1f77bcf86cd799439031"],
  "deliveryAgencyId": "507f1f77bcf86cd799439050",
  "fileIds": ["507f1f77bcf86cd799439040"]
}
```

**Request Body — Digital Product:**

```json
{
  "sku": "JS-COURSE-PDF",
  "name": "PDF Edition",
  "price": 29.99,
  "isInfiniteStock": true,
  "stock": 0,
  "digitalConfig": {
    "maxDownloads": 5,
    "expiresAfterDays": 365
  }
}
```

**Request Body — Service Product:**

```json
{
  "sku": "svc-haircut-001",
  "name": "Booking",
  "price": 5000,
  "serviceConfig": {
    "durationMinutes": 60,
    "bufferBeforeMinutes": 0,
    "bufferAfterMinutes": 0,
    "bookingMode": "calendar",
    "peakHours": {
      "daysOfWeek": [0, 6],
      "startTime": "18:00",
      "endTime": "21:00",
      "priceType": "percentage",
      "value": 20
    }
  }
}
```

> [!IMPORTANT]
> **Service products have exactly one variant**, which carries `serviceConfig` + `price`. Key rules:
> - `serviceConfig` is **required** for the service variant. `price` is the base price **per `durationMinutes`** — the booking price is prorated by the actual elapsed duration.
> - Creating a **second** variant returns `409 CATALOG_SERVICE_VARIANT_EXISTS`.
> - `optionValueIds`, `deliveryAgencyId`, dimensions (`weight`/`length`/`width`/`height`), and `digitalConfig` are **rejected** (`400 CATALOG_PRODUCT_INVALID_TYPE`).
> - `peakHours` is optional; the surcharge applies only to booking minutes overlapping the window on the listed `daysOfWeek`.
> - Update the scheduling/peak config later via `PATCH /products/:productId/variants/:variantId/service/config`, or the price via the variant `PATCH` endpoint.

> [!IMPORTANT]
> **Digital variants** represent downloadable formats (1–5 per product). Key rules:
> - The created variant comes back with `status: "archived"` — it flips to `"active"` only after you **upload its asset** via `POST /products/:productId/variants/:variantId/digital/asset` (see [Digital Products Guide](./digital-products.md)).
> - Creating a 6th variant returns `400 CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED`.
> - `digitalConfig` (optional) sets per-variant download limits: `{ maxDownloads?, expiresAfterDays? }`. `assetId` is **not** accepted here — it's set by the upload endpoint.
>
> The following fields are **rejected** (400 `CATALOG_PRODUCT_INVALID_TYPE`) for `type: "digital"`:
> - `optionValueIds` — digital variants cannot be option-based
> - `deliveryAgencyId` — delivery agencies only apply to physical products
> - `weight`, `length`, `width`, `height` — physical dimensions only

**Request Fields:**

| Field | Type | Required | Validation | Applicable To |
|-------|------|----------|------------|---------------|
| `sku` | string | ✅ | 1–100 chars; globally unique across all variants | All |
| `price` | number | ✅ | >= 0 | All |
| `name` | string | No | 1–100 chars | All |
| `compareAtPrice` | number | No | >= 0 | All |
| `stock` | number | No | Integer >= 0; default `0` | All |
| `isInfiniteStock` | boolean | No | Default `false` | All |
| `optionValueIds` | string[] | No | Array of valid ObjectIds; default `[]` | Physical only |
| `weight` | number | No | >= 0 (grams) | Physical only |
| `length` | number | No | >= 0 (cm) | Physical only |
| `width` | number | No | >= 0 (cm) | Physical only |
| `height` | number | No | >= 0 (cm) | Physical only |
| `deliveryAgencyId` | string | No | Valid 24-char ObjectId | Physical only |
| `fileIds` | string[] | No | Variant images. Array of valid 24-char ObjectIds; **must be unique**. Capped per parent product type (physical **3**, digital **1**) | All |
| `digitalConfig` | object | No | `{ maxDownloads?, expiresAfterDays? }` (each integer >= 1 or `null`) | Digital only |
| `serviceConfig` | object | ✅ (service) | `{ durationMinutes (int ≥ 1), bufferBeforeMinutes?, bufferAfterMinutes?, bookingMode ('calendar'\|'manual'\|'capacity'), maxBookings? (int ≥ 1, required when bookingMode='capacity'), peakHours? }` | Service only |
| `serviceConfig.peakHours` | object | No | `{ daysOfWeek (int[0–6]), startTime ('HH:mm'), endTime ('HH:mm' > startTime), priceType ('fixed'\|'percentage'), value (≥ 0) }` | Service only |

> [!IMPORTANT]
> **Variant images can be set at creation time** (and via PATCH). The flow mirrors product media: the referenced files must be owned by the vendor (or be system files) or the request is rejected `403`. Caps: a **physical** variant allows **3** images, a **digital** variant allows **1**. Exceeding the cap → `400 CATALOG_IMAGE_LIMIT_EXCEEDED`; duplicate IDs → `400 VALIDATION_ERROR`. The create response returns fully populated `files` (not bare `fileIds`), same as the GET/PATCH endpoints.

> [!NOTE]
> **Digital variants are created `archived`.** They have no asset yet, and a digital variant can only be `active` with an asset. After creation, upload the file to flip it to `active`. Physical/service variants are created `active`. (Variant `fileIds` are display images — distinct from the downloadable **asset**, which is managed via the `…/digital/asset` endpoints.)

**Success Response `201`:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439015",
    "productId": "507f1f77bcf86cd799439011",
    "sku": "TSHIRT-RED-M",
    "name": "Red / Medium",
    "status": "active",
    "optionSignature": "507f1f77bcf86cd799439030|507f1f77bcf86cd799439031",
    "price": 29.99,
    "compareAtPrice": 39.99,
    "stock": 100,
    "isInfiniteStock": false,
    "lowStockThreshold": null,
    "allowOversell": false,
    "weight": 200,
    "length": 30,
    "width": 20,
    "height": 2,
    "optionValueIds": ["507f1f77bcf86cd799439030", "507f1f77bcf86cd799439031"],
    "files": [],
    "deliveryAgencyId": "507f1f77bcf86cd799439050",
    "createdAt": "2026-01-29T10:00:00.000Z",
    "updatedAt": "2026-01-29T10:00:00.000Z",
    "deletedAt": null,
    "purgeAt": null
  },
  "message": "Variant created successfully"
}
```

> If this is the **first variant** for this product, the response creates a side effect: `product.hasVariants` becomes `true` and `product.defaultVariantId` is set to this variant's `id`. Subsequent `GET /products/:id` calls will reflect this.

**Error Responses:**

| Status | Code | Reason |
|--------|------|--------|
| 404 | `CATALOG_PRODUCT_NOT_FOUND` | Product not found or not owned by vendor |
| 400 | `CATALOG_PRODUCT_INVALID_TYPE` | Type restriction violated (e.g. service variant missing `serviceConfig`, or service/digital variant given physical-only fields) |
| 409 | `CATALOG_SERVICE_VARIANT_EXISTS` | Service product already has its single variant |
| 400 | `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | Digital product already has 5 variants (max) |
| 400 | `CATALOG_IMAGE_LIMIT_EXCEEDED` | More images than the per-type cap (physical 3, digital 1) |
| 403 | `CATALOG_PRODUCT_ACCESS_DENIED` | A `fileId` is not owned by this vendor |
| 404 | `CATALOG_FILE_NOT_FOUND` | A referenced `fileId` does not exist |
| 409 | `CATALOG_VARIANT_SKU_EXISTS` | SKU already in use by another variant globally |
| 400 | `VALIDATION_ERROR` | Request body fails schema validation (includes duplicate `fileIds`) |

---

### GET /api/vendor/products/:id/variants

List all variants for a product.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Product ObjectId |

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | — | Filter: `active`, `archived` |
| `page` | number | `1` | Page number (1-indexed) |
| `limit` | number | `20` | Max 100 |

**Success Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439015",
      "productId": "507f1f77bcf86cd799439011",
      "sku": "TSHIRT-RED-M",
      "name": "Red / Medium",
      "status": "active",
      "optionSignature": "507f1f77bcf86cd799439030|507f1f77bcf86cd799439031",
      "price": 29.99,
      "compareAtPrice": 39.99,
      "stock": 100,
      "isInfiniteStock": false,
      "lowStockThreshold": 10,
      "allowOversell": false,
      "weight": 200,
      "length": 30,
      "width": 20,
      "height": 2,
      "optionValueIds": ["507f1f77bcf86cd799439030", "507f1f77bcf86cd799439031"],
      "files": [],
      "deliveryAgencyId": "507f1f77bcf86cd799439050",
      "createdAt": "2026-01-29T10:00:00.000Z",
      "updatedAt": "2026-01-29T10:00:00.000Z"
    }
  ],
  "meta": {
    "total": 4,
    "page": 1,
    "limit": 20,
    "totalPages": 1
  }
}
```

**Error Responses:**
- `404 CATALOG_PRODUCT_NOT_FOUND` — Product not found

---

### GET /api/vendor/products/:productId/variants/:variantId

Get a single variant by ID.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `productId` | string | Product ObjectId |
| `variantId` | string | Variant ObjectId |

**Success Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439015",
    "productId": "507f1f77bcf86cd799439011",
    "sku": "TSHIRT-RED-M",
    "status": "active",
    "price": 29.99,
    "stock": 100,
    "isInfiniteStock": false,
    "lowStockThreshold": 10,
    "allowOversell": false,
    "weight": 200,
    "length": 30,
    "width": 20,
    "height": 2,
    "optionSignature": "...",
    "optionValueIds": ["..."],
    "files": [],
    "createdAt": "2026-01-29T10:00:00.000Z",
    "updatedAt": "2026-01-29T10:00:00.000Z"
  }
}
```

**Error Responses:**
- `404 CATALOG_VARIANT_NOT_FOUND` — Variant not found, or does not belong to the specified product

---

### PATCH /api/vendor/products/:productId/variants/:variantId

Update a variant. All fields are optional — only provided fields are changed.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `productId` | string | Product ObjectId |
| `variantId` | string | Variant ObjectId |

**Request Body:**

```json
{
  "sku": "TSHIRT-RED-M-V2",
  "name": "Red / Medium",
  "price": 34.99,
  "compareAtPrice": 39.99,
  "stock": 80,
  "isInfiniteStock": false,
  "lowStockThreshold": 10,
  "allowOversell": false,
  "weight": 210,
  "length": 30,
  "width": 20,
  "height": 2,
  "deliveryAgencyId": "507f1f77bcf86cd799439050",
  "fileIds": ["507f1f77bcf86cd799439040"]
}
```

**Fields:**

| Field | Type | Required | Validation | Applicable To |
|-------|------|----------|------------|---------------|
| `sku` | string | No | 1–100 chars; globally unique | All |
| `name` | string | No | 1–100 chars | All |
| `price` | number | No | >= 0 | All |
| `compareAtPrice` | number | No | >= 0 | All |
| `stock` | number | No | Integer >= 0 | All |
| `isInfiniteStock` | boolean | No | — | All |
| `lowStockThreshold` | number \| null | No | Integer >= 1, or `null` to disable alerts | All |
| `allowOversell` | boolean | No | — | All |
| `fileIds` | string[] | No | Array of valid 24-char ObjectIds; **full replacement**; must be unique; capped per type (physical **3**, digital **1**) | All |
| `weight` | number | No | >= 0 (grams) | Physical only |
| `length` | number | No | >= 0 (cm) | Physical only |
| `width` | number | No | >= 0 (cm) | Physical only |
| `height` | number | No | >= 0 (cm) | Physical only |
| `deliveryAgencyId` | string | No | Valid 24-char ObjectId | Physical only |
| `digitalConfig` | object | No | `{ maxDownloads?, expiresAfterDays? }` — partial; only sent fields change. `assetId` is not accepted | Digital only |

> [!WARNING]
> ## `stock` and `isInfiniteStock` are NOT written for an agency-warehoused product
>
> If this variant's product has `delivery.pickupLocation.source === "agency_storage"`,
> an agency physically holds the goods and the quantity needs its countersignature.
> Those two fields are **stripped from this write** and become a pending
> [stock request](./stock-requests.md) instead. **Every other field in the same PATCH
> applies normally** — edit a price and a quantity in one call and the price lands
> immediately while the quantity queues.
>
> The response is still **`200`** (not `202`), `data.stock` still shows the **old**
> quantity, and a new `meta.stockAdjustment` block says what is pending:
>
> ```json
> {
>   "success": true,
>   "data": { "…": "…", "stock": 120 },
>   "meta": {
>     "stockAdjustment": {
>       "status": "pending_agency_approval",
>       "request": { "id": "665a…", "requestedQuantity": 90, "availableActions": ["withdraw"] }
>     }
>   },
>   "message": "Variant updated. The stock change is awaiting the storage agency's approval."
> }
> ```
>
> One status code, deliberately — you have to read the body either way, so branching on
> 200-vs-202 would buy nothing. **If your UI optimistically renders what was typed, it
> will now be wrong**: render `data` as returned, and show a "120 → 90 pending" badge
> when `meta.stockAdjustment` is present.
>
> `isInfiniteStock: true` on such a product is **refused outright**
> (`422 CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK`) — a warehouse cannot hold an
> unbounded quantity, and it is an activation blocker on the product too.

> [!IMPORTANT]
> **`fileIds` is a full array replacement** — send the complete desired array. To add an image, fetch the current `fileIds`, append the new id, and send the merged array. IDs must be **unique**, and the total must not exceed the per-type cap (physical **3**, digital **1**) → otherwise `400 CATALOG_IMAGE_LIMIT_EXCEEDED`.
>
> **`digitalConfig` is a partial update** — sending `{ maxDownloads: 3 }` changes only `maxDownloads` and leaves `expiresAfterDays` and the asset untouched. There is also a dedicated convenience endpoint: `PATCH /products/:productId/variants/:variantId/digital/config`.
>
> **Digital product restrictions** — the following fields are **rejected** with a 400 error if sent for `type: "digital"` products:
> - `deliveryAgencyId`
> - `weight`, `length`, `width`, `height`
>
> Conversely, `digitalConfig` is rejected (400) on non-digital variants.

**Cannot be modified:** `productId`, `optionSignature`, `optionValueIds` (changing options requires re-creating the variant)

**Success Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439015",
    "productId": "507f1f77bcf86cd799439011",
    "sku": "TSHIRT-RED-M-V2",
    "status": "active",
    "price": 34.99,
    "stock": 80,
    "isInfiniteStock": false,
    "lowStockThreshold": 10,
    "allowOversell": false,
    "weight": 210,
    "length": 30,
    "width": 20,
    "height": 2,
    "files": [
      {
        "id": "507f1f77bcf86cd799439040",
        "key": "products/variant-img.jpg",
        "url": "https://storage.example.com/products/variant-img.jpg",
        "mimeType": "image/jpeg",
        "size": 123456,
        "originalName": "red-medium.jpg"
      }
    ],
    "updatedAt": "2026-01-29T11:00:00.000Z"
  },
  "message": "Variant updated successfully"
}

> **Note:** The PATCH response and all GET endpoints return fully populated `files` objects. The `fileIds` field is only used as **input** when sending a PATCH request to update file associations.
```

**Error Responses:**

| Status | Code | Reason |
|--------|------|--------|
| 404 | `CATALOG_VARIANT_NOT_FOUND` | Variant not found or does not belong to specified product |
| 400 | `CATALOG_PRODUCT_INVALID_TYPE` | Physical-only field sent for digital product |
| 400 | `CATALOG_IMAGE_LIMIT_EXCEEDED` | More images than the per-type cap (physical 3, digital 1) |
| 403 | `CATALOG_PRODUCT_ACCESS_DENIED` | A `fileId` is not owned by this vendor |
| 404 | `CATALOG_FILE_NOT_FOUND` | A referenced `fileId` does not exist |
| 409 | `CATALOG_VARIANT_SKU_EXISTS` | New SKU is already in use by another variant |
| 400 | `VALIDATION_ERROR` | Body schema invalid (includes duplicate `fileIds`) |

---

### PATCH /api/vendor/products/:productId/variants/:variantId/status

Toggle a variant between `"active"` and `"archived"`. Designed for the **frontend toggle switch** — vendors use this to temporarily disable a variant they're short on (or no longer need for the moment) without losing the SKU, pricing, options, or asset, and to re-enable it later.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `productId` | string | Product ObjectId |
| `variantId` | string | Variant ObjectId |

**Request Body:**

```json
{
  "status": "archived"
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `status` | string | ✅ | One of `"active"`, `"archived"` |

**Activation rules** (enforced when `status: "active"`):

- The variant's `price` must be `> 0`. A variant priced at `0` cannot be activated → `422 CATALOG_PRODUCT_VARIANT_ZERO_PRICE`.
- For a **digital** product, the variant must already have an uploaded asset (`digitalConfig.assetId`) → otherwise `422 CATALOG_VARIANT_NO_DIGITAL_ASSET`. Upload the asset via `POST /products/:productId/variants/:variantId/digital/asset` first.
- For a **service** product, the variant must have a `serviceConfig` with a `durationMinutes` → otherwise `422 CATALOG_PRODUCT_SERVICE_NO_DURATION`.

Sending the variant's **current** status is a no-op and returns `200` with `"Variant is already <status>"`.

**Side Effects:**

- **Archiving:** If the archived variant was `product.defaultVariantId`, the backend reassigns `defaultVariantId` to the next active variant (lowest `createdAt`) or clears it if none remain. `product.hasVariants` is updated accordingly.
- **Both transitions:** The parent product is re-validated against its activation gate. If the product was `active` and the change leaves it without a valid default variant (or otherwise breaks the activation invariant), the product is demoted to `draft`.

**Success Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439015",
    "productId": "507f1f77bcf86cd799439011",
    "sku": "TSHIRT-RED-M",
    "status": "archived",
    "price": 29.99,
    "stock": 0,
    "...": "...other variant fields"
  },
  "message": "Variant status changed to archived"
}
```

**Error Responses:**

| Status | Code | Reason |
|--------|------|--------|
| 404 | `CATALOG_PRODUCT_NOT_FOUND` | Product not found or not owned by vendor |
| 404 | `CATALOG_VARIANT_NOT_FOUND` | Variant not found, or does not belong to the specified product |
| 422 | `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | Cannot activate a variant whose price is `0` |
| 422 | `CATALOG_VARIANT_NO_DIGITAL_ASSET` | Cannot activate a digital variant without an uploaded asset |
| 422 | `CATALOG_PRODUCT_SERVICE_NO_DURATION` | Cannot activate a service variant without a `serviceConfig.durationMinutes` |
| 409 | `CATALOG_PRODUCT_VECTORISATION_PENDING` | Product is currently being vectorised; retry after it completes |
| 400 | `VALIDATION_ERROR` | Body missing `status` or value is not `"active"` / `"archived"` |

> [!NOTE]
> This endpoint is the one to wire to a single toggle/switch UI. Use `DELETE` only when you want the same archive behaviour without explicitly stating the new status.

---

### DELETE /api/vendor/products/:productId/variants/:variantId

Archive a variant (soft delete). Sets `status` to `"archived"`. Data is preserved.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `productId` | string | Product ObjectId |
| `variantId` | string | Variant ObjectId |

**Side Effects:**
- If the archived variant was `product.defaultVariantId`, the backend automatically reassigns `defaultVariantId` to the next active variant (lowest `createdAt`), or clears it if no other active variants remain
- `product.hasVariants` is set to `false` if no active variants remain after archiving

> [!NOTE]
> For digital variants, archiving does **not** delete the uploaded asset — it remains linked. To free the asset (and the file), use `DELETE /products/:productId/variants/:variantId/digital/asset` instead, which also archives the variant.

**Success Response `200`:**

```json
{
  "success": true,
  "message": "Variant archived successfully"
}
```

**Error Responses:**
- `404 CATALOG_VARIANT_NOT_FOUND` — Variant not found or does not belong to specified product

---

## Notes & Constraints

### Product Type Support Matrix

| Feature | Physical | Digital | Service |
|---------|----------|---------|---------|
| Variants supported | ✅ | ✅ (1–5) | ✅ (exactly 1) |
| `optionValueIds` | ✅ | ❌ | ❌ |
| Dimensions (`weight`, `length`, `width`, `height`) | ✅ | ❌ | ❌ |
| `deliveryAgencyId` | ✅ | ❌ | ❌ |
| `digitalConfig` (per-variant asset/limits) | ❌ | ✅ | ❌ |
| `serviceConfig` (duration/buffers/bookingMode/peakHours) | ❌ | ❌ | ✅ (required) |
| Max variants | unlimited | **5** | **1** |
| Max images per variant | **3** | **1** | **0** (use product media) |
| Images settable on create | ✅ | ✅ | ❌ |
| Created as | `active` | `archived` (until asset uploaded) | `active` |
| `isInfiniteStock` | ✅ | ✅ (typically `true`) | ✅ (typically `true`) |
| `stock` tracking | ✅ | No (ignored if `isInfiniteStock`) | No |

### Service `bookingMode`

`serviceConfig.bookingMode` controls what happens when a customer books a slot on this service product:

| Mode | Behavior |
|------|----------|
| `calendar` | **Default.** Single-occupancy. Booking is created `confirmed` and a Google Calendar event is created immediately. This is the standard slot-based flow. |
| `manual` | Single-occupancy. Booking is created `pending` with **no** calendar event. The vendor must accept it (`PATCH /api/vendor/bookings/:id/status` → `confirmed`), which then creates the calendar event. Use this when the vendor wants to approve each request before committing. |
| `capacity` | **Multi-occupancy.** Up to `maxBookings` customers can book the same slot (e.g. a class with N seats). Each booking is `confirmed` immediately. All seats for a slot share **one** Google Calendar event whose title shows the fill level, e.g. `[3/10] Yoga`. The slot stays bookable until full; the `(N+1)`th booking is rejected with `409 BOOKING_SLOT_FULL`. Requires `serviceConfig.maxBookings` (≥ 1). |

`maxBookings` (integer ≥ 1) is **required when `bookingMode` is `capacity`** and ignored otherwise. It is enforced at variant creation and again at product activation.

Slot discovery, pricing, and payment are identical across all modes. What differs: booking `status` on create (`manual` → `pending`), calendar-event timing/sharing, and whether a slot is single- or multi-occupancy.

### Digital Variants (Formats)

Digital variants model the downloadable **formats** of a digital product (PDF, ZIP, EPUB, MP4, …). Each owns its own asset, price, SKU, name, and download limits.

- **1–5 per product.** Creating a 6th returns `400 CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED`.
- **Status follows the asset:** created `archived` → upload asset → `active` → remove asset → `archived`. You cannot directly flip a digital variant to `active` without an asset.
- **Asset management is via dedicated endpoints**, not the variant create/update body:

| Action | Endpoint |
|--------|----------|
| Upload (→ active) | `POST /products/:productId/variants/:variantId/digital/asset` (`multipart/form-data`, field `file`) |
| Replace | `PUT /products/:productId/variants/:variantId/digital/asset` |
| Remove (→ archived) | `DELETE /products/:productId/variants/:variantId/digital/asset` |
| Update limits | `PATCH /products/:productId/variants/:variantId/digital/config` — `{ maxDownloads?, expiresAfterDays? }` |

Full details, request/response shapes, the state machine, activation rules, and UI guidance: **[Digital Products — Multi-Variant Guide](./digital-products.md)**.

### SKU Uniqueness

SKU values must be **globally unique across all variants in the system** — not just variants of the same product. A `409 CATALOG_VARIANT_SKU_EXISTS` error is returned if the SKU is already in use.

### `optionSignature` (Read-Only)

The `optionSignature` field is auto-generated by the backend. It is a pipe-joined (`|`) string of sorted `optionValueIds`. It is used to prevent duplicate option combinations for the same product. **Frontend must never send this field.** It exists solely for the backend to detect and reject duplicate variants within a product.

Examples:
- Variant with no options: `optionSignature = ""`
- Variant with options `["id-A", "id-B"]`: `optionSignature = "id-A|id-B"` (sorted alphabetically)

### Stock Management

| Scenario | Behavior |
|----------|----------|
| `isInfiniteStock: true` | Stock is unlimited; `stock` field is irrelevant |
| `isInfiniteStock: false`, `stock > 0` | Can purchase; stock is decremented on order |
| `isInfiniteStock: false`, `stock <= 0`, `allowOversell: false` | Cannot purchase |
| `isInfiniteStock: false`, `stock <= 0`, `allowOversell: true` | Can purchase (backorder); stock goes negative |
| `stock <= lowStockThreshold` | Vendor receives low-stock notification |

### `lowStockThreshold` and `allowOversell`

These fields are not available on variant creation. Set them via the `PATCH` update endpoint after the variant exists:

```json
PATCH /api/vendor/products/:productId/variants/:variantId
{
  "lowStockThreshold": 5,
  "allowOversell": false
}
```

### Delivery Agency Resolution (Physical Products)

When an order is placed for a physical variant, the fulfillment agency is resolved as:
1. `variant.deliveryAgencyId` → use this agency if set
2. `vendor.default_delivery_agency_id` → fallback to vendor default
3. Neither set → order cannot be fulfilled (blocking)

Frontend should warn the vendor if no agency is configured for a variant and the vendor has no default set.

### Pricing Display (Frontend Guidance)

```javascript
// Show discount badge when compareAtPrice is greater than price
if (variant.compareAtPrice && variant.compareAtPrice > variant.price) {
  const discountPct = Math.round(
    ((variant.compareAtPrice - variant.price) / variant.compareAtPrice) * 100
  );
  // Display: "$29.99  ~~$39.99~~  (25% off)"
} else {
  // Display: "$29.99"
}
```

### Error Response Format

All error responses:

```json
{
  "success": false,
  "error": {
    "code": "CATALOG_VARIANT_SKU_EXISTS",
    "message": "A variant with this SKU already exists",
    "details": { "sku": "TSHIRT-RED-M" }
  }
}
```

Validation errors include a `details` array:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "price", "message": "Price must be a positive number" }
    ]
  }
}
```

**Variant-specific error codes:**

| Code | HTTP | Description |
|------|------|-------------|
| `CATALOG_VARIANT_NOT_FOUND` | 404 | Variant not found, not active, or does not belong to specified product |
| `CATALOG_VARIANT_SKU_EXISTS` | 409 | SKU already in use globally |
| `CATALOG_PRODUCT_NOT_FOUND` | 404 | Parent product not found or not owned by vendor |
| `CATALOG_PRODUCT_INVALID_TYPE` | 400 | Type restriction violated — service variant missing `serviceConfig`; physical-only field sent for digital/service; `digitalConfig`/`serviceConfig` sent for the wrong type |
| `CATALOG_SERVICE_VARIANT_EXISTS` | 409 | Service product already has its single variant |
| `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | 400 | Digital product already has 5 variants (max) |
| `CATALOG_IMAGE_LIMIT_EXCEEDED` | 400 | Too many variant images — physical max 3, digital max 1, service 0 |
| `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | 422 | Status change rejected — cannot activate a variant with `price = 0` |
| `CATALOG_VARIANT_NO_DIGITAL_ASSET` | 422 | Status change rejected — digital variant has no uploaded asset |
| `CATALOG_PRODUCT_SERVICE_NO_DURATION` | 422 | Status change rejected — service variant has no `serviceConfig.durationMinutes` |
| `VALIDATION_ERROR` | 400 | Zod schema validation failed |
