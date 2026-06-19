# Vendor Product Management API

Complete API reference for managing products in the Jovi Mall multi-vendor platform.

> [!IMPORTANT]
> **Authentication Required**
> All endpoints require:
> - `Authorization: Bearer <access_token>` header
> - Vendor role
> - Vendors can only access and modify their own products — ownership is enforced at the repository level using the vendor identity from the JWT

---

## Table of Contents

- [Product Object Shape](#product-object-shape)
- [Product CRUD](#product-crud)
- [Default Variant Management](#default-variant-management)
- [Bulk Operations](#bulk-operations)
- [Digital Product Asset Management](#digital-product-asset-management)
- [Product Options](#product-options)
- [Vectorisation](#vectorisation)
- [Activation Requirements](#activation-requirements)
- [Error Codes](#error-codes)

---

## Product Object Shape

This is the full shape of a product object returned by all read endpoints.

```json
{
  "id": "507f1f77bcf86cd799439011",
  "vendorId": "507f1f77bcf86cd799439012",
  "type": "physical",
  "status": "draft",
  "title": "Blue T-Shirt",
  "description": "Comfortable cotton t-shirt",
  "slug": "blue-t-shirt",
  "category": "Apparel",
  "tags": ["cotton", "summer", "casual"],
  "seo": {
    "title": "Buy Blue T-Shirt Online",
    "description": "High quality cotton t-shirt in blue"
  },
  "files": [
    {
      "id": "507f1f77bcf86cd799439030",
      "key": "products/abc123.jpg",
      "url": "https://storage.example.com/products/abc123.jpg",
      "mimeType": "image/jpeg",
      "size": 245678,
      "originalName": "cover.jpg"
    }
  ],
  "hasVariants": true,
  "defaultVariantId": "507f1f77bcf86cd799439015",
  "vectorisationEnabled": false,
  "vectorisationStatus": "not_started",
  "vectorisedDataId": null,
  "createdAt": "2026-01-29T10:00:00.000Z",
  "updatedAt": "2026-01-29T10:00:00.000Z"
}
```

> **Note:** The `GET /api/vendor/products/:id` endpoint returns fully populated `files` objects (id, key, url, mimeType, size, originalName) instead of bare `fileIds`. The list endpoint (`GET /api/vendor/products`) also returns populated file objects, but under the field name `fileIds` and with a **trimmed payload shape tailored to the products grid/list UI** — see [List Products](#list-products) for the exact response.

**Vectorisation fields:**

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `vectorisationEnabled` | boolean | `true` / `false` | Opt-in flag. Vendor must set this to `true` for vectorisation to run. Defaults to `false`. |
| `vectorisationStatus` | string | `not_started` / `pending` / `completed` / `failed` | Current pipeline state. Read-only from the frontend — managed by the backend. |
| `vectorisedDataId` | string \| null | — | External ID returned by the vectoriser service once `vectorisationStatus` is `completed`. `null` until then. |

> **Note on async behaviour:** Vectorisation never blocks the API response. After a create or update call, the product is saved first and the response is returned immediately. The vectorisation pipeline runs in the background. Poll `GET /api/vendor/products/:id` to check `vectorisationStatus` if you need to know when it completes.

**Digital product — additional fields:**
```json
{
  "digitalConfig": {
    "isActive": true
  }
}
```

> [!IMPORTANT]
> **Digital products are now multi-variant.** Each variant owns its own asset, price, SKU, name, and download limits (`maxDownloads`, `expiresAfterDays`). The product-level `digitalConfig` only carries `isActive` — a product-wide download kill switch. The asset/limit fields are **no longer** on the product.
>
> See the dedicated **[Digital Products — Multi-Variant Guide](./digital-products.md)** for the full model, per-variant asset upload endpoints, the variant `status ⇔ asset` invariant, the 1–5 variant cap, and frontend UI guidance. The per-variant asset shape is documented on the variant object (`variant.digital.asset`) in [variants.md](./variants.md).

> [!IMPORTANT]
> **Service config + pricing live on the variant, not the product.** A service product has **exactly one** variant that carries its `price` and `serviceConfig` (slot duration, buffers, booking mode, optional peak-hours surcharge). The product itself has no `serviceConfig`. Create the variant via `POST /products/:id/variants` — see [variants.md](./variants.md).

<a id="service-products"></a>
> [!NOTE]
> **Service products & bookings.** A service product is the bookable unit. The end-to-end lifecycle is:
> 1. **Connect Google Calendar** — see [Google Calendar connection](./calendar.md). Required before customers can book (booking writes a calendar event); also lets the system block the vendor's existing busy times.
> 2. **Create** the product with `type: "service"` (`POST /api/vendor/products`).
> 3. **Create the service variant** via `POST /api/vendor/products/:id/variants` with `price` + `serviceConfig` (`durationMinutes` required). `price` is the base price per `durationMinutes`. See [variants.md](./variants.md).
> 4. **Define availability** with one or more [availability rules](./availability-rules.md) and activate them.
> 5. **Activate** the product (it needs one active default variant with `serviceConfig.durationMinutes` and `price > 0` — see [Change Product Status](#change-product-status)).
> 6. Customers then discover slots and book via the [Customer Booking Flow](../customer/bookings.md); vendors manage incoming bookings via [Booking Management](./bookings.md).

---

## Product CRUD

### List Products

```http
GET /api/vendor/products
```

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | — | Filter: `physical`, `digital`, `service` |
| `status` | string | No | — | Filter: `draft`, `active`, `archived` |
| `q` | string | No | — | Full-text search on title and description |
| `sortBy` | string | No | `createdAt` | `createdAt`, `updatedAt`, `title` |
| `sortOrder` | string | No | `desc` | `asc`, `desc` |
| `page` | number | No | `1` | Page number (1-indexed) |
| `limit` | number | No | `20` | Items per page (max: 100) |

> [!IMPORTANT]
> **The list endpoint returns a trimmed payload tailored to the products grid/list UI.**
> Only the fields the grid/list view and row actions consume are included. To get the full product object — `vendorId`, `slug`, `description`, `tags`, `seo`, `defaultVariantId`, `digitalConfig`, `delivery`, `vectorisedDataId`, `createdAt`, `updatedAt`, etc. — call `GET /api/vendor/products/:id`. (Service config + price live on the variant.)
>
> File performance: `fileIds` is populated with full `FileDetail` objects (id, key, url, mimeType, size, originalName), resolved in a **single batched query** across the whole page — no N+1 lookups.

**Response item shape:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Product ObjectId. Used as React key, for selection, delete actions, and the edit route. |
| `title` | string | Product display name. |
| `type` | `"physical" \| "digital" \| "service"` | Drives placeholder icon choice and type label. |
| `status` | `"draft" \| "active" \| "archived" \| "pending_review" \| "suspended"` | Passed to `StatusBadge`; used for client-side filtering. |
| `category` | string | Category label/badge text. |
| `fileIds` | `FileDetail[]` | Populated product images. Empty array when none. Each entry: `{ id, key, url, mimeType, size, originalName? }`. The frontend's `ProductThumbnail` shows the first entry. |
| `hasVariants` | boolean | Drives the "Has variants" / "Variants" badge. |
| `vectorisationEnabled` | boolean | Vendor opt-in flag. Passed to `VectorisationBadge`. |
| `vectorisationStatus` | `"not_started" \| "pending" \| "completed" \| "failed"` | Indexing state. Passed to `VectorisationBadge`; row edit menu is locked while `pending`. |

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439011",
      "title": "Blue T-Shirt",
      "type": "physical",
      "status": "active",
      "category": "Apparel",
      "fileIds": [
        {
          "id": "507f1f77bcf86cd799439030",
          "key": "products/abc123.jpg",
          "url": "https://storage.example.com/products/abc123.jpg",
          "mimeType": "image/jpeg",
          "size": 245678,
          "originalName": "cover.jpg"
        }
      ],
      "hasVariants": true,
      "vectorisationEnabled": true,
      "vectorisationStatus": "completed"
    }
  ],
  "meta": {
    "total": 120,
    "page": 1,
    "limit": 20,
    "pages": 6
  }
}
```

> **`meta.pages`** is the total number of pages (renamed from `totalPages` in earlier docs to match the actual response field).

---

### Get Product

```http
GET /api/vendor/products/:id
```

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Product ObjectId (24-char hex) |

**Response `200`:** Full product object (see [Product Object Shape](#product-object-shape)).

**Error Responses:**
- `404 CATALOG_PRODUCT_NOT_FOUND` — Product does not exist or does not belong to this vendor

---

### Create Product

```http
POST /api/vendor/products
```

All products start in `draft` status. The `type` cannot be changed after creation.

**Request Body:**

```json
{
  "type": "physical",
  "title": "Blue T-Shirt",
  "category": "Apparel",
  "description": "Comfortable cotton t-shirt",
  "tags": ["cotton", "summer", "casual"],
  "seoTitle": "Buy Blue T-Shirt Online",
  "seoDescription": "High quality cotton t-shirt",
  "fileIds": ["507f1f77bcf86cd799439030"]
}
```

**Fields:**

| Field | Type | Required | Validation |
|-------|------|----------|-----------|
| `type` | string | ✅ | `physical`, `digital`, or `service` |
| `title` | string | ✅ | 3–200 characters |
| `category` | string | ✅ | Non-empty string |
| `description` | string | ✅ | Non-empty string |
| `tags` | string[] | No | Array of unique, non-empty strings |
| `seoTitle` | string | No | Max 60 characters |
| `seoDescription` | string | No | Max 160 characters |
| `fileIds` | string[] | No | Product images. Array of file ObjectIds; **must be unique** (duplicates rejected). Subject to the per-type image cap below. |

> **Do not** pass `digitalConfig` or `serviceConfig` here. `digitalConfig` is set via `PATCH /products/:id`; service config + price live on the service variant (`POST /products/:id/variants`).

> [!IMPORTANT]
> **Image limit (per product, by type):** physical **7**, service **7**, digital **1**. Exceeding the cap returns `400 CATALOG_IMAGE_LIMIT_EXCEEDED`. Duplicate file IDs in the same array are rejected with `400 VALIDATION_ERROR`.

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "vendorId": "507f1f77bcf86cd799439012",
    "type": "physical",
    "status": "draft",
    "title": "Blue T-Shirt",
    "slug": "blue-t-shirt",
    "category": "Apparel",
    "tags": [],
    "seo": {},
    "fileIds": [],
    "hasVariants": false,
    "defaultVariantId": null,
    "vectorisationEnabled": false,
    "vectorisationStatus": "not_started",
    "vectorisedDataId": null,
    "createdAt": "2026-01-29T10:00:00.000Z",
    "updatedAt": "2026-01-29T10:00:00.000Z"
  },
  "message": "Product created successfully"
}
```

> **Vectorisation on create:** The product is saved first and the `201` response is returned immediately. Vectorisation then runs asynchronously in the background — no action required from the frontend. `vectorisationStatus` will be `not_started` on fresh drafts (vectorisation only triggers once the product is active and `vectorisationEnabled` is `true`).

**Error Responses:**
- `400 VALIDATION_ERROR` — Request body failed schema validation (includes duplicate `fileIds`)
- `400 CATALOG_IMAGE_LIMIT_EXCEEDED` — More images than the per-type cap (physical/service 7, digital 1)

---

### Update Product

```http
PATCH /api/vendor/products/:id
```

Partial update — only provided fields are changed. Allowed on `draft` and `active` products.

**Request Body:**

```json
{
  "title": "Updated Title",
  "description": "Updated description",
  "category": "New Category",
  "tags": ["new-tag", "another-tag"],
  "seoTitle": "New SEO Title",
  "seoDescription": "New SEO description",
  "fileIds": ["507f1f77bcf86cd799439030", "507f1f77bcf86cd799439031"],
  "digitalConfig": {
    "isActive": true
  },
  "vectorisationEnabled": true
}
```

**Fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | 3–200 characters |
| `description` | string | No | — |
| `category` | string | No | Non-empty string |
| `tags` | string[] | No | **Full replacement** of tags array |
| `seoTitle` | string | No | Max 60 characters |
| `seoDescription` | string | No | Max 160 characters |
| `fileIds` | string[] | No | **Full replacement** — send complete desired array of file ObjectIds. Must be unique; capped per type (physical/service **7**, digital **1**). |
| `digitalConfig` | object | No | Digital products only — product-wide toggle. Only `{ isActive }` is accepted (strict). Per-variant asset/limits live on the variant. |
| `vectorisationEnabled` | boolean | No | Toggle vectorisation opt-in. When provided, the backend runs the enable or disable flow after the content update — see [Vectorisation](#vectorisation). For quick toggles only, use `PATCH /:id/vectorisation`. |

> [!NOTE]
> `serviceConfig` is **no longer accepted on the product** (neither create nor update). Service config + price live on the service variant — set them via `POST /products/:id/variants` or `PATCH /products/:productId/variants/:variantId/service/config`. See [variants.md](./variants.md).

> [!WARNING]
> **`fileIds` is a full array replacement, not an append operation.**
> If the product currently has `fileIds: ["A", "B"]` and you send `fileIds: ["C"]`, the result is `["C"]`. Always send the complete desired array. To add a file: fetch current fileIds, append the new id, send the merged array.
>
> File IDs must be **unique** within the array, and the total must not exceed the per-type cap (physical/service **7**, digital **1**) — otherwise `400 CATALOG_IMAGE_LIMIT_EXCEEDED`.

**`digitalConfig` sub-fields:**

| Field | Type | Notes |
|-------|------|-------|
| `isActive` | boolean | Product-wide download kill switch. When `false`, purchases of any variant do not grant a download entitlement. |

> [!IMPORTANT]
> `digitalConfig` on the product accepts **only** `isActive` (the schema is strict). `maxDownloads`, `expiresAfterDays`, and `assetId` are **per-variant** now — set them via the variant endpoints. Sending them here returns `400 VALIDATION_ERROR`. See [Digital Products Guide](./digital-products.md).

**Cannot be updated:** `type`, `slug` (auto-generated from title), `vendorId`

**Response `200`:**

```json
{
  "success": true,
  "data": { "...full product object..." },
  "message": "Product updated successfully"
}
```

> **Vectorisation on update:**
> - If the body **omits** `vectorisationEnabled`, the product is saved and the response returns immediately; the backend automatically re-vectorises in the background if the product is `active` and `vectorisationEnabled` is currently `true`. `vectorisationStatus` may briefly be `pending` before returning to `completed`.
> - If the body **includes** `vectorisationEnabled: true`, the backend runs the enable flow after the content update (eligibility check + vectorise), exactly as if `PATCH /:id/vectorisation` had been called.
> - If the body **includes** `vectorisationEnabled: false`, the backend runs the disable flow after the content update (clear flag + upstream delete).
> - The HTTP response always returns immediately; the vectorisation side-effect runs in the background.

**Error Responses:**
- `404 CATALOG_PRODUCT_NOT_FOUND` — Product not found
- `422 CATALOG_PRODUCT_INVALID_STATE` — Product is `archived` or `suspended`; update not allowed
- `400 VALIDATION_ERROR` — Body schema invalid

---

### Change Product Status

```http
PATCH /api/vendor/products/:id/status
```

**Request Body:**

```json
{ "status": "active" }
```

**Valid Status Values:**

| Status | Description |
|--------|-------------|
| `draft` | Work in progress, not visible to customers |
| `active` | Live and purchasable |
| `archived` | Hidden, data preserved |
| `pending_review` | Awaiting admin moderation |
| `suspended` | Admin-only — vendors cannot set this |

> [!WARNING]
> **Activation Requirements (status → `active`)**
>
> The backend enforces ALL of the following before allowing activation for **every product type** (checked in this order):
>
> 1. **`description` must be non-empty** — enforced as a schema-level requirement at creation and update, and double-checked by the activation gate
> 2. **At least one variant must exist** — all product types require at least one variant for pricing
> 3. **Every active variant must have `price > 0`** — zero-priced variants block activation
> 4. **`defaultVariantId` must point to an active variant** — the referenced variant must exist and be active; a dangling or archived reference fails validation
>
> Additionally, per product type:
> - **Physical**: a delivery agency must be resolvable — either set directly on the product (`delivery.agencyId`) or configured as the vendor's default (`vendor.default_delivery_agency_id`). Without one of these, the backend will reject activation.
> - **Digital**: **every active variant must have an uploaded asset**, and there must be **no more than 5** active variants. (Digital variants without an asset are auto-archived, so this normally passes by construction.) See [Digital Products Guide](./digital-products.md).
> - **Service**: the single default variant must have a `serviceConfig.durationMinutes` (min: 1) and `price > 0` — the config + price live on the variant. If its `bookingMode` is `capacity`, it must also have `serviceConfig.maxBookings` (≥ 1).

**Response `200`:**

```json
{
  "success": true,
  "data": { "...updated product..." },
  "message": "Product status changed to active"
}
```

> **Vectorisation on status change:** The status is saved first and the response returned immediately. A lightweight status-only notification is then sent asynchronously to the vectoriser. This does **not** re-vectorise the product's data — it only updates the searchability metadata on the vectoriser side. If the product was never vectorised (e.g., `vectorisationEnabled` was `false` when it was first activated), no notification is sent.

**Error Responses `422`:**

| Code | Meaning |
|------|---------|
| `CATALOG_PRODUCT_NO_DESCRIPTION` | `description` is missing or blank |
| `CATALOG_PRODUCT_NO_VARIANTS` | No variants exist |
| `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | An active variant has price = 0 |
| `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` | `defaultVariantId` missing or points to archived/nonexistent variant |
| `CATALOG_PRODUCT_NO_DELIVERY_AGENCY` | Physical product has no delivery agency on the product or vendor profile |
| `CATALOG_VARIANT_NO_DIGITAL_ASSET` | A digital product's active variant has no uploaded asset (details include the variant name/sku) |
| `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | Digital product has more than 5 active variants |
| `CATALOG_PRODUCT_SERVICE_NO_DURATION` | Service product has no `durationMinutes` |
| `CATALOG_PRODUCT_SERVICE_NO_CAPACITY` | Service product in `capacity` mode has no `maxBookings` (≥ 1) |

---

### Duplicate Product

```http
POST /api/vendor/products/:id/duplicate
```

Creates an independent copy of the product in `draft` status.

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439014",
    "status": "draft",
    "title": "Blue T-Shirt (copy)",
    "slug": "blue-t-shirt-copy",
    "hasVariants": false,
    "defaultVariantId": null
  },
  "message": "Product duplicated successfully"
}
```

**Duplication Behavior:**

| Field | Behavior |
|-------|----------|
| `status` | Always `draft` |
| `title` | `{original} (copy)` |
| `slug` | `{original-slug}-copy`, then `-copy-2`, `-copy-3` on collision |
| `fileIds` | Copied — same file references (usage count incremented per file) |
| `tags`, `seo`, `category` | Copied as-is |
| `hasVariants` | Always `false` — variants are NOT copied |
| `defaultVariantId` | Always `null` — must create new variants for the clone |
| Digital: `digitalConfig.isActive` | Always `false` |
| Digital: variants & per-variant assets/limits | **NOT copied** — variants aren't cloned, so the vendor must re-create each format variant and re-upload its asset |
| Service: variant (`serviceConfig` + price) | **NOT copied** — variants aren't cloned, so the vendor must re-create the service variant with its config + price |
| `vectorisationEnabled` | Always `false` — must be explicitly re-enabled on the clone |
| `vectorisationStatus` | Always `not_started` |
| `vectorisedDataId` | Always `null` |

> After duplication, the vendor must create at least one variant and upload a new digital asset (for digital products) before the clone can be activated.

---

### Archive Product

```http
DELETE /api/vendor/products/:id
```

Soft delete — sets status to `archived`. Data is preserved. Product is hidden from customers immediately.

**Response `200`:**

```json
{
  "success": true,
  "message": "Product archived successfully"
}
```

---

## Default Variant Management

### Set Default Variant

```http
PATCH /api/vendor/products/:id/default-variant
```

Sets which variant is used for display, pricing preview, and as the starting selection on a product page. This endpoint is for **manual reassignment** after the first variant has been auto-assigned.

> **Auto-assignment**: The first variant created for any product is automatically set as `defaultVariantId`. This endpoint lets the vendor change it afterward.

**Request Body:**

```json
{ "variantId": "507f1f77bcf86cd799439015" }
```

**Fields:**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `variantId` | string | ✅ | Valid 24-char hex ObjectId |

**Business Rules:**
- The target variant must exist, belong to this product, and have `status: "active"`
- Archived variants cannot be set as default
- If an active variant is later archived and it was the default, the backend automatically reassigns `defaultVariantId` to the next available active variant (or clears it if none remain)

**Response `200`:**

```json
{
  "success": true,
  "message": "Default variant updated successfully"
}
```

**Error Responses:**
- `404 CATALOG_PRODUCT_NOT_FOUND` — Product not found
- `404 CATALOG_VARIANT_NOT_FOUND` — Variant not found, is archived, or belongs to a different product

---

## Bulk Operations

### Bulk Archive

```http
POST /api/vendor/products/bulk/archive
```

**Request Body:**

```json
{
  "productIds": [
    "507f1f77bcf86cd799439011",
    "507f1f77bcf86cd799439012",
    "507f1f77bcf86cd799439013"
  ]
}
```

**Limits:** Max 50 product IDs per request.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "success": 3,
    "failed": 0,
    "total": 3
  },
  "message": "Archived 3 of 3 products"
}
```

---

### Bulk Status Change

```http
POST /api/vendor/products/bulk/status
```

**Request Body:**

```json
{
  "productIds": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"],
  "status": "active"
}
```

**Limits:** Max 50 product IDs per request.

> [!IMPORTANT]
> When changing status to `active`, the backend validates each product individually using the same rules as the single-product status endpoint. Products failing validation are not activated and are reported in the `errors` array. This is a partial-success operation.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "success": 1,
    "failed": 1,
    "total": 2,
    "errors": [
      {
        "productId": "507f1f77bcf86cd799439012",
        "reason": "Product has no active variants"
      }
    ]
  },
  "message": "Updated 1 of 2 products"
}
```

---

## Digital Product Asset Management

> [!IMPORTANT]
> **Digital assets are now managed per variant**, not per product. A digital product holds **1–5 variants**, each owning its own file, price, SKU, name, and download limits. The old product-scoped routes (`POST/PUT/DELETE /products/:id/digital/asset` and `PATCH /products/:id/digital/toggle`) have been **removed** and return 404.
>
> Full reference — request/response shapes, the variant `status ⇔ asset` invariant, the 1–5 cap, the activation rules, the post-purchase entitlement model, and UI guidance — is in the **[Digital Products — Multi-Variant Guide](./digital-products.md)**. Endpoint summary below.

| Action | Method & Path |
|--------|---------------|
| Upload a variant's asset | `POST /api/vendor/products/:productId/variants/:variantId/digital/asset` (`multipart/form-data`, field `file`) — variant becomes `active` |
| Replace a variant's asset | `PUT /api/vendor/products/:productId/variants/:variantId/digital/asset` (`multipart/form-data`, field `file`) |
| Remove a variant's asset | `DELETE /api/vendor/products/:productId/variants/:variantId/digital/asset` — variant becomes `archived` |
| Update a variant's download limits | `PATCH /api/vendor/products/:productId/variants/:variantId/digital/config` — body `{ maxDownloads?, expiresAfterDays? }` |
| Product-wide pause/resume | `PATCH /api/vendor/products/:id` — body `{ "digitalConfig": { "isActive": false } }` (replaces the old toggle endpoint) |

**File constraints (all uploads):** max 500 MB (configurable via `MAX_DIGITAL_ASSET_SIZE`); allowed MIME types: `application/pdf`, `application/zip`, `application/x-zip-compressed`, `application/x-rar-compressed`, `application/octet-stream`, `video/mp4`, `video/quicktime`, `audio/mpeg`, `audio/wav`, `audio/mp3`, `image/jpeg`, `image/png`, `image/gif`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/epub+zip`.

See [Digital Products Guide §5](./digital-products.md#5-endpoints) for full request/response/error details on each endpoint.

---

## Product Options

Options define the dimensions along which variants differ (e.g., Size, Color, Material). **Only physical products support options.**

> **Flow:** Create Option → Add Values to Option → Create Variants referencing those value IDs. Options must be created before variants that reference them.

### Create Option

```http
POST /api/vendor/products/:productId/options
```

**Request Body:**

```json
{ "name": "Color", "position": 1 }
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | string | ✅ | 1–50 chars; alphanumeric, spaces, and hyphens only; must be unique per product |
| `position` | number | No | Display order; auto-assigned if omitted |

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439020",
    "productId": "507f1f77bcf86cd799439011",
    "name": "Color",
    "position": 1,
    "createdAt": "2026-01-29T10:00:00.000Z",
    "updatedAt": "2026-01-29T10:00:00.000Z"
  },
  "message": "Option created successfully"
}
```

---

### List Options

```http
GET /api/vendor/products/:productId/options
```

Returns all options with their values nested.

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439020",
      "productId": "507f1f77bcf86cd799439011",
      "name": "Color",
      "position": 1,
      "values": [
        { "id": "507f1f77bcf86cd799439030", "value": "Black" },
        { "id": "507f1f77bcf86cd799439031", "value": "White" }
      ]
    }
  ]
}
```

---

### Update Option

```http
PATCH /api/vendor/products/:productId/options/:optionId
```

**Request Body:** `{ "name": "Shade", "position": 2 }` — all fields optional.

---

### Reorder Options

```http
PUT /api/vendor/products/:productId/options/reorder
```

**Request Body:**

```json
{
  "optionIds": ["507f1f77bcf86cd799439021", "507f1f77bcf86cd799439020"]
}
```

The order of IDs in the array defines the new display order.

---

### Delete Option

```http
DELETE /api/vendor/products/:productId/options/:optionId
```

> [!WARNING]
> **Cascade delete.** Deleting an option also deletes all of its values. Variants that referenced those values will have orphaned `optionValueIds` and an invalid `optionSignature`. This does not automatically archive those variants — the vendor must manage them manually.

**Response `200`:** `{ "success": true, "message": "Option deleted successfully" }`

---

### Create Option Value

```http
POST /api/vendor/products/:productId/options/:optionId/values
```

**Request Body:** `{ "value": "Black" }`

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `value` | string | ✅ | 1–100 characters |

> Values are **unique per option** (case-insensitive, enforced by database index). Attempting to create a duplicate returns `409`.

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439030",
    "optionId": "507f1f77bcf86cd799439020",
    "value": "Black"
  },
  "message": "Option value created successfully"
}
```

---

### Bulk Create Option Values

```http
POST /api/vendor/products/:productId/options/:optionId/values/bulk
```

**Request Body:**

```json
{ "values": ["Black", "White", "Navy"] }
```

- Max 50 values per request
- Duplicate values within the same option are silently skipped

**Response `201`:**

```json
{
  "success": true,
  "data": [
    { "id": "507f...", "value": "Black" },
    { "id": "507f...", "value": "White" },
    { "id": "507f...", "value": "Navy" }
  ],
  "message": "Option values created successfully"
}
```

---

### List Option Values

```http
GET /api/vendor/products/:productId/options/:optionId/values
```

---

### Rename Option Value

```http
PATCH /api/vendor/products/:productId/options/:optionId/values/:valueId
```

**Request Body:** `{ "value": "Black" }`

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `value` | string | ✅ | 1–100 characters |

> This is a **safe operation** — the value's `id` is unchanged, so existing variant `optionValueIds` and `optionSignature` remain valid. No variant re-creation needed.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439030",
    "optionId": "507f1f77bcf86cd799439020",
    "value": "Black"
  },
  "message": "Option value updated successfully"
}
```

---

### Delete Option Value

```http
DELETE /api/vendor/products/:productId/options/:optionId/values/:valueId
```

> [!WARNING]
> Deleting a value invalidates any variant whose `optionValueIds` array includes this value. Those variants will have an inconsistent `optionSignature` and should be archived or updated.

---

---

## Vectorisation

Vectorisation is the process of sending a fully-populated product payload to the external AI search service so it can be indexed for hybrid (semantic + keyword) search on the customer-facing storefront.

> [!NOTE]
> **Vectorisation is always asynchronous.** The API never blocks on it. The product is saved first, the HTTP response is returned to the frontend, and then vectorisation runs in the background.

### Eligibility

A product is automatically vectorised (or re-vectorised) when **all three** conditions are met:

| Condition | How to satisfy |
|-----------|----------------|
| `status === "active"` | Activate the product via `PATCH /:id/status` |
| `vectorisationEnabled === true` | Set via `PATCH /:id` — update the `vectorisationEnabled` field |
| Product is complete | `title`, `description`, and `category` must all be present |

> [!NOTE]
> **Vectorisation applies to all product types — `physical`, `digital`, and `service` alike.** The `vectorisationEnabled` opt-in flag and the entire enable/disable/retry flow below behave identically regardless of type; eligibility never checks `product.type`.

#### What gets indexed

The payload sent to the vectoriser is **fully populated** — no raw ObjectIds, because the AI indexer cannot interpret IDs. Everything is resolved into human-readable data:

- **Product** — `title`, `description`, `category`, `tags`, `seo`, the resolved `vendor`, the product `images` (gallery files with public URLs), and the resolved `delivery` agency. Digital products also carry the product-wide `digitalConfig` (`isActive` kill switch).
- **Each variant** carries its **own** resolved data and config — config lives on the variant that owns it, not hoisted to the product:
  - `options` — resolved `{ option, value }` pairs (e.g. `{ "option": "Size", "value": "M" }`), not option-value IDs.
  - `files` — the variant's images with public URLs, not file IDs.
  - `deliveryAgency` — the resolved agency when the variant overrides the default.
  - `digitalConfig` (digital variants) — `maxDownloads`, `expiresAfterDays`, and the resolved `asset` (`originalName`, `mimeType`, `size`), not the asset ID.
  - `serviceConfig` (service variants) — `durationMinutes`, buffers, `bookingMode`, `maxBookings`, and the optional peak-hours surcharge.

So a service variant is indexed with its full booking config, a digital variant with its asset details and limits, and a physical variant with its options/dimensions/agency — each on the variant it belongs to.

### Enabling / Disabling Vectorisation

Vectorisation is **opt-in** — it defaults to `false` on all new and duplicated products. There are two ways to toggle it:

**1. As part of a product update** — pass `vectorisationEnabled` in the body of `PATCH /api/vendor/products/:id`:

```http
PATCH /api/vendor/products/:id
```

```json
{
  "title": "New title",
  "vectorisationEnabled": true
}
```

Use this when you're already editing other fields and want to flip the opt-in flag in the same request.

**2. Dedicated quick-toggle endpoint** — `PATCH /api/vendor/products/:id/vectorisation` with `{ "enabled": true | false }`:

```http
PATCH /api/vendor/products/:id/vectorisation
```

```json
{ "enabled": true }
```

Use this when you only need to flip the flag and aren't changing anything else. See [Vectorisation Endpoints](#vectorisation-endpoints) below for the full contract.

Both routes share the same backend logic — they run the same eligibility check, mark `pending`, call the vectoriser, and write the result. The dedicated endpoint just lets you skip the rest of the update payload.

### Status Lifecycle

| `vectorisationStatus` | Meaning |
|-----------------------|---------|
| `not_started` | Vectorisation has never run (new product, or `vectorisationEnabled` was `false`) |
| `pending` | The backend has accepted the job and is calling the vectoriser |
| `completed` | Successfully vectorised. `vectorisedDataId` is populated. |
| `failed` | All retry attempts failed. An admin can trigger re-vectorisation via the reconciliation script or the admin bulk endpoint. |

### Polling for Completion

If the frontend needs to show vectorisation state, poll `GET /api/vendor/products/:id` and read `vectorisationStatus`:

```js
// Example: poll every 5 seconds until completed or failed
async function waitForVectorisation(productId) {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`/api/vendor/products/${productId}`, { headers });
    const { data } = await res.json();
    if (data.vectorisationStatus === 'completed') return data.vectorisedDataId;
    if (data.vectorisationStatus === 'failed') throw new Error('Vectorisation failed');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Vectorisation timed out');
}
```

> In most flows the frontend does **not** need to wait — vectorisation is a background concern. Only surfaces like a "Search Indexing" status indicator need to poll.

### Re-vectorisation

The backend automatically re-vectorises on:
- Product `PATCH` (data update) without `vectorisationEnabled` in the body — re-vectorises if product is currently active and `vectorisationEnabled` is `true`
- `vectorisationEnabled` flipped from `false` to `true` (via either `PATCH /:id` or `PATCH /:id/vectorisation`) — runs the enable flow immediately

It does **not** automatically retry a `failed` product. Vendors can manually trigger a retry via the dedicated retry endpoint (`POST /:id/vectorisation/retry`), or admins can use the bulk-vectorise endpoint.

### Vectorisation Endpoints

In addition to managing vectorisation via the standard product `PATCH` endpoint, vendors can use these dedicated endpoints:

#### GET /api/vendor/products/:id/vectorisation/status

Read the current vectorisation tracking details for a specific product.

**Response `200 OK`:**
```json
{
  "success": true,
  "data": {
    "productId": "507f1f77bcf86cd799439011",
    "vectorisationEnabled": true,
    "vectorisationStatus": "completed",
    "vectorisedDataId": "ext-vec-98765"
  }
}
```

#### PATCH /api/vendor/products/:id/vectorisation

Set the vectorisation opt-in state for a product. **This is the consolidated toggle endpoint that replaces the previous `POST .../enable` and `POST .../disable` routes — both have been removed.**

**Request Body:**

```json
{ "enabled": true }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `enabled` | boolean | Yes | Desired vectorisation opt-in state. `true` runs the enable flow, `false` runs the disable flow. |

**Behaviour**

The endpoint is idempotent — sending the current state returns a `200` no-op. Otherwise it routes to the appropriate flow and returns `202` while the upstream call runs in the background.

| Request | Current state | Response | What happens |
|---------|---------------|----------|--------------|
| `{ "enabled": true }` | Already `enabled` + status `pending`/`completed` | `200 OK` | No-op. Returns current state with message `Vectorisation is already enabled.` |
| `{ "enabled": true }` | Disabled, product eligible (active + title + description + category) | `202 Accepted` | Flag set to `true`, status set to `pending`, vectoriser called in the background. |
| `{ "enabled": true }` | Disabled, product **ineligible** (draft, missing description, etc.) | `200 OK` | Flag stays `false`. The backend explains why in the message — caller should fix the product and retry. |
| `{ "enabled": false }` | Already disabled | `200 OK` | No-op. Returns current state with message `Vectorisation is already disabled.` |
| `{ "enabled": false }` | Enabled | `202 Accepted` | Flag set to `false`, upstream `/delete` called and local `vectorisedDataId` cleared in the background. |

**Response `202 Accepted` (enable):**
```json
{
  "success": true,
  "data": {
    "productId": "507f1f77bcf86cd799439011",
    "vectorisationEnabled": true,
    "vectorisationStatus": "pending",
    "vectorisedDataId": null
  },
  "message": "Vectorisation enabled. The vectoriser is being called in the background."
}
```

**Response `202 Accepted` (disable):**
```json
{
  "success": true,
  "data": {
    "productId": "507f1f77bcf86cd799439011",
    "vectorisationEnabled": false,
    "vectorisationStatus": "completed",
    "vectorisedDataId": "ext-vec-98765"
  },
  "message": "Vectorisation disabled. External cleanup is running in the background."
}
```

**Response `200 OK` (ineligible enable):**
```json
{
  "success": true,
  "data": {
    "productId": "507f1f77bcf86cd799439011",
    "vectorisationEnabled": false,
    "vectorisationStatus": "not_started",
    "vectorisedDataId": null
  },
  "message": "Product is not eligible for vectorisation. Vectorisation has been disabled — make the product active and ensure it has a title, description, and category, then re-enable."
}
```

**Error Responses:**
- `404 CATALOG_PRODUCT_NOT_FOUND` — Product not found or not owned by this vendor
- `409 CATALOG_PRODUCT_VECTORISATION_PENDING` — A vectorisation job is currently in flight; wait for it to finish (or fail) before toggling
- `400 VALIDATION_ERROR` — Body missing `enabled` or not a boolean

> [!IMPORTANT]
> **Migration from the old endpoints**
> - `POST /api/vendor/products/:id/vectorisation/enable` → `PATCH /api/vendor/products/:id/vectorisation` body `{ "enabled": true }`
> - `POST /api/vendor/products/:id/vectorisation/disable` → `PATCH /api/vendor/products/:id/vectorisation` body `{ "enabled": false }`
>
> The old routes are removed and now return `404`. Update any clients before deploy.

#### POST /api/vendor/products/:id/vectorisation/retry

Manually resubmit the product payload to the vectoriser. This is useful when the status has become `failed`.

**Business Rules:**
- The product must be `active`.
- `vectorisationEnabled` must be `true`.
- The product must be complete (having `title`, `description`, and `category` set).
- Cannot retry while a job is currently `pending` (returns a `409` conflict error).

**Response `202 Accepted`:**
```json
{
  "success": true,
  "data": {
    "productId": "507f1f77bcf86cd799439011",
    "vectorisationEnabled": true,
    "vectorisationStatus": "pending",
    "vectorisedDataId": null
  },
  "message": "Retry scheduled. The vectoriser will be called in the background."
}
```

**Error Responses `422` (`CATALOG_PRODUCT_VECTORISATION_NOT_ELIGIBLE`):**
```json
{
  "success": false,
  "error": {
    "code": "CATALOG_PRODUCT_VECTORISATION_NOT_ELIGIBLE",
    "message": "Product is not eligible for vectorisation. Ensure it is active, vectorisation is enabled, and the title/description/category are set."
  }
}
```

---

## Activation Requirements

Summary of what the backend validates when changing status to `active`. Frontend should pre-validate these before calling the status endpoint.

**Universal (all product types):**

| Requirement | Error Code | Description |
|-------------|------------|-------------|
| At least one variant | `CATALOG_PRODUCT_NO_VARIANTS` | Create at least one variant first |
| All active variants have `price > 0` | `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | Update variant price |
| `defaultVariantId` points to an active variant | `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` | First variant is auto-set; use `/default-variant` to reassign |

**Digital products only:**

| Requirement | Error Code | Description |
|-------------|------------|-------------|
| Every active variant has an uploaded asset | `CATALOG_VARIANT_NO_DIGITAL_ASSET` | Upload a file for each format variant (auto-archives variants without one) |
| No more than 5 active variants | `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | Remove/archive extra variants (max 5) |

**Service products only:**

| Requirement | Error Code | Description |
|-------------|------------|-------------|
| The default variant has `serviceConfig.durationMinutes` | `CATALOG_PRODUCT_SERVICE_NO_DURATION` | Create the service variant (with `serviceConfig`) via `POST /products/:id/variants` |

---

## Error Codes

All errors use this response shape:

```json
{
  "success": false,
  "error": {
    "code": "CATALOG_PRODUCT_NOT_FOUND",
    "message": "Human-readable description",
    "details": { "...additional context..." }
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
      { "field": "title", "message": "Title must be at least 3 characters" }
    ]
  }
}
```

**Catalog Product Error Codes:**

| Code | HTTP | Description |
|------|------|-------------|
| `CATALOG_PRODUCT_NOT_FOUND` | 404 | Product does not exist or is not owned by this vendor |
| `CATALOG_PRODUCT_ACCESS_DENIED` | 403 | Vendor does not own this product |
| `CATALOG_PRODUCT_INVALID_TYPE` | 400 | Operation not permitted for this product type |
| `CATALOG_PRODUCT_INVALID_STATE` | 422 | Product is in a state that does not allow this operation (e.g., updating an archived product) |
| `CATALOG_PRODUCT_NO_VARIANTS` | 422 | Activation blocked — no variants exist |
| `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | 422 | Activation blocked — an active variant has `price = 0` |
| `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` | 422 | Activation blocked — `defaultVariantId` not set or points to archived variant |
| `CATALOG_VARIANT_NO_DIGITAL_ASSET` | 422 | Activation blocked — a digital variant has no uploaded asset |
| `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | 400/422 | Digital product exceeds 5 variants (400 on create, 422 on activation) |
| `CATALOG_PRODUCT_SERVICE_NO_DURATION` | 422 | Activation blocked — service product has no duration |
| `CATALOG_DIGITAL_ASSET_ALREADY_EXISTS` | 409 | Attempted `POST` upload when the variant already has an asset; use `PUT` |
| `CATALOG_DIGITAL_ASSET_MISSING` | 404 | Attempted `PUT`/`DELETE` when the variant has no asset |
| `CATALOG_DIGITAL_ASSET_MISSING_FILE` | 400 | No file included in the upload request |
| `CATALOG_FILE_TOO_LARGE` | 400 | Upload exceeds size limit |
| `CATALOG_FILE_TYPE_INVALID` | 400 | MIME type is not in the allowed list |
| `VALIDATION_ERROR` | 400 | Zod schema validation failed |
