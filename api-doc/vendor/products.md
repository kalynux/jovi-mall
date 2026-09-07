# Vendor Product Management API

**Verified against source on 2026-09-06** — every claim on this page was checked against
**Re-verified in part on 2026-09-08** — the plan-quota material added below (`modules/plan-quota/`, `controllers/vendor-product.controller.ts:129-135, 183-185, 322-324, 369-371`, `domain/services/ProductBulkOperationsService.ts:33-72`, `services/entitlement.service.ts:76-113`, `repositories/mongo/product.repository.mongo.ts:82-93`, `models/product.model.ts:60-101`), and the Duplicate-Product section, which was **wrong** about simple-mode variants (`domain/services/ProductDuplicateService.ts:88-155`).
`jovi-mall/src/`, including the whole inherited defect list that `vendor-dash` carried for it
(DOC-PROGRAM § 24–28). Corrections are marked inline with ⚠ and a source citation. Re-opened on
the same date to take `product-upload-flow.md`'s five inherited rows, which name endpoints this
page owns — the retry error list and the `pending` write lock.

Complete API reference for managing products in the Jovi Mall multi-vendor platform.

> [!IMPORTANT]
> **Authentication Required**
> All endpoints require:
> - `Authorization: Bearer <access_token>` header
> - Vendor role
> - Vendors can only access and modify their own products — ownership is enforced at the repository level using the vendor identity from the JWT

---

> [!TIP]
> **Simple mode.** Physical products with a single price and no options can be
> created and edited in one call via `POST /api/vendor/products/simple` — see
> **[simple-products.md](./simple-products.md)**. Those products carry
> `mode: "simple"` and **reject** the variant/option endpoints documented here
> until `POST /:id/convert-to-advanced` is called. Everything below applies to
> `mode: "advanced"` products, which is what every product created through the
> endpoints on this page (and every pre-existing product) reports.

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
- [Plan quota enforcement](#plan-quota-enforcement)
- [Error Codes](#error-codes)

### Product routes documented on their own page

`/api/vendor/products/*` is served by one router and documented across seven pages. These are
the ones **not** below, so that a reader on this page can find them:

| Routes | Page |
|---|---|
| `POST` · `GET` · `DELETE /:id/shipping` | [shipping.md](./shipping.md) — parcel weight and dimensions |
| `POST /:id/share` | [product-share.md](./product-share.md) — send a product to **your own** WhatsApp or Telegram |
| `POST /simple` · `PATCH /:id/simple` · `POST /:id/convert-to-advanced` | [simple-products.md](./simple-products.md) |
| `POST` · `GET /:id/variants`, `GET` · `PATCH` · `DELETE /:productId/variants/:variantId`, `PATCH …/status`, `…/service/config` | [variants.md](./variants.md) |
| `POST` · `GET /:id/availability-rules`, `PATCH` · `DELETE /availability-rules/:ruleId`, `PATCH …/toggle` | [availability-rules.md](./availability-rules.md) |
| `GET /:id/service/calendar-status` | [calendar.md](./calendar.md) |
| `POST` · `PUT` · `DELETE /:productId/variants/:variantId/digital/asset`, `PATCH …/digital/config` | [digital-products.md](./digital-products.md) |

> ⚠ **Added 2026-09-06** (DOC-PROGRAM F-17 class 6). Five of the seven pages were already
> linked from somewhere in the prose below; **`shipping.md` and `product-share.md` were not**,
> and there is no `vendor/README.md` index to fall back on. `product-share.md` had **no inbound
> link anywhere in `api-doc/`** — a fully specified page for a live endpoint, reachable only by
> listing the directory.

---

## Product Object Shape

This is the full shape of a product object returned by all read endpoints.

```json
{
  "id": "507f1f77bcf86cd799439011",
  "vendorId": "507f1f77bcf86cd799439012",
  "type": "physical",
  "mode": "advanced",
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
      "access": "public",
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

> **Note:** The `GET /api/vendor/products/:id` endpoint returns fully populated `files` objects (id, key, url, access, mimeType, size, originalName) instead of bare `fileIds`. The list endpoint (`GET /api/vendor/products`) also returns populated file objects, but under the field name `fileIds` and with a **trimmed payload shape tailored to the products grid/list UI** — see [List Products](#list-products) for the exact response.

**Vectorisation fields:**

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `vectorisationEnabled` | boolean | `true` / `false` | Opt-in flag. Vendor must set this to `true` for vectorisation to run. Defaults to `false`. |
| `vectorisationStatus` | string | `not_started` / `pending` / `completed` / `failed` / `skipped_no_credits` | Current pipeline state. Read-only from the frontend — managed by the backend. |
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

**Physical product — additional fields:**
```json
{
  "delivery": {
    "agencyId": null,
    "freeDelivery": false,
    "pickupLocation": {
      "source": "agency_storage",
      "vendorAddressId": null,
      "agencyAddressId": "6641abc123def458"
    }
  },
  "pickup": {
    "source": "agency_storage",
    "vendorAddressId": null,
    "agencyAddressId": "6641abc123def458",
    "address": {
      "label": "Bonabéri branch",
      "formattedAddress": "Bonabéri, Douala, Cameroon",
      "addressLine1": "Bonabéri, Rue des Palmiers",
      "addressLine2": null,
      "city": "Douala",
      "state": "Littoral",
      "country": "Cameroon",
      "coordinates": { "lat": 4.0731, "lng": 9.6812 }
    },
    "isPrimaryFallback": false
  }
}
```

> [!IMPORTANT]
> **Physical products require a `delivery.pickupLocation` to activate** — it tells the resolved delivery agency where to collect the item from. `source: "vendor_address"` points at one of your [`business_addresses`](./profile.md) (`vendorAddressId` required); `source: "agency_storage"` means the agency already warehouses your stock for this product (`vendorAddressId` is always `null`; `agencyAddressId` optionally names *which* depot). Which sources are actually usable depends on the **resolved agency's** own policy — see the note under [Update Product](#update-product) and [Delivery Agencies](./delivery-agencies.md#pickup_based--storage_based-and-pickup-locations).

**`pickup` (read-only, on product detail responses)** — the same pickup location with its address
resolved, so you can label the current choice without a second request. `null` for products with no
pickup location (digital, service, or an unconfigured physical product). `delivery.pickupLocation`
keeps the raw ids, so a client can round-trip that object back on a `PATCH`.

| Field | Type | Notes |
|-------|------|-------|
| `source` | `"vendor_address"` \| `"agency_storage"` | Mirrors `delivery.pickupLocation.source`. |
| `vendorAddressId` | string \| null | Mirrors the request field. |
| `agencyAddressId` | string \| null | Mirrors the request field. `null` = the agency's primary depot. |
| `address` | object \| null | Standard address shape (`label`, `formattedAddress`, `addressLine1/2`, `city`, `state`, `country`, `coordinates: { lat, lng }`). `null` when the referenced address no longer exists — for `vendor_address`, an address you deleted; the activation gate will report it. |
| `isPrimaryFallback` | boolean | `true` when `address` is the agency's **primary** depot standing in — either because `agencyAddressId` is null (no choice made) or because it names a depot the agency has since deleted. Worth surfacing: it means the address shown is a default, not something the vendor picked. Always `false` for `vendor_address`. |

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
> Only the fields the grid/list view and row actions consume are included. To get the full product object — `vendorId`, `slug`, `description`, `tags`, `seo`, `defaultVariantId`, `digitalConfig`, `delivery` (`{ agencyId, freeDelivery }`), `vectorisedDataId`, `createdAt`, `updatedAt`, etc. — call `GET /api/vendor/products/:id`. (Service config + price live on the variant.)
>
> File performance: `fileIds` is populated with full `FileDetail` objects (id, key, url, access, mimeType, size, originalName), resolved in a **single batched query** across the whole page — no N+1 lookups.

**Response item shape:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Product ObjectId. Used as React key, for selection, delete actions, and the edit route. |
| `title` | string | Product display name. |
| `type` | `"physical" \| "digital" \| "service"` | Drives placeholder icon choice and type label. |
| `status` | `"draft" \| "active" \| "archived" \| "pending_review" \| "suspended"` | Passed to `StatusBadge`; used for client-side filtering. |
| `mode` | `"simple" \| "advanced"` | ⚠ **Present on every row and missing from this table until 2026-09-06** (`ProductListService.ts:87`). It decides which edit route the row action opens: a `simple` product **rejects** the variant and option endpoints, so sending a row into the advanced editor is a dead end. |
| `category` | string | Category label/badge text. |
| `fileIds` | `FileDetail[]` | Populated product images. Empty array when none. Each entry: `{ id, key, url, mimeType, size, originalName? }`. The frontend's `ProductThumbnail` shows the first entry. |
| `hasVariants` | boolean | Drives the "Has variants" / "Variants" badge. |
| `vectorisationEnabled` | boolean | Vendor opt-in flag. Passed to `VectorisationBadge`. |
| `vectorisationStatus` | `"not_started" \| "pending" \| "completed" \| "failed" \| "skipped_no_credits"` | Indexing state. Passed to `VectorisationBadge`; row edit menu is locked while `pending`. |

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
      "mode": "advanced",
      "category": "Apparel",
      "fileIds": [
        {
          "id": "507f1f77bcf86cd799439030",
          "key": "products/abc123.jpg",
          "url": "https://storage.example.com/products/abc123.jpg",
          "access": "public",
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
| `description` | string | ✅ | Non-empty string. Plain text — no markup. |
| `descriptionRich` | object \| null | No | Structured description powering WhatsApp / Telegram formatting. `description` must be its plain-text projection — see [product-description-rich.md](./product-description-rich.md). |
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
- `403 CATALOG_PRODUCT_ACCESS_DENIED` — the vendor does not own this product
- `403 BILLING_LIMIT_EXCEEDED` — **the plan's active-product cap is reached.** `details` carries
  `{ limit, current, requested, available }` and the message names the plan: *"Your 'starter' plan
  allows up to N active products. Upgrade to add more."* On a batch the message instead reads
  *"…allows up to N products, and you have room for A more. Upgrade, or archive some first."*
  (`entitlement.service.ts:100-113`).
- `400 VALIDATION_ERROR` — Request body failed schema validation (includes duplicate `fileIds`)
- `400 CATALOG_IMAGE_LIMIT_EXCEEDED` — More images than the per-type cap (physical/service 7, digital 1)

> ⚠ **`BILLING_LIMIT_EXCEEDED` was absent from this list until 2026-09-06, and it is the refusal
> a vendor is most likely to hit.** The two `400`s are malformed-request cases a working client
> never produces; this `403` is a *correct* request refused by the plan, and it is checked
> **before** the product is created — `assertCanAddProduct` runs against
> `countActiveByVendor` at `vendor-product.controller.ts:158-159` (and identically for simple
> products at `vendor-simple-product.controller.ts:129`). Show the upgrade path, not a generic
> error. The cap itself is `max_active_products` on the plan; `null` means unlimited and skips
> the check entirely (`entitlement.service.ts:80-91`).

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
  "delivery": {
    "agencyId": "683abc1234567890abcdef01",
    "freeDelivery": false,
    "pickupLocation": {
      "source": "vendor_address",
      "vendorAddressId": "683abc1234567890abcdef02"
    }
  },
  "vectorisationEnabled": true
}
```

**Fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | 3–200 characters |
| `description` | string | No | Plain text — no markup. |
| `descriptionRich` | object \| null | No | Structured description powering WhatsApp / Telegram formatting. `description` must be its plain-text projection — see [product-description-rich.md](./product-description-rich.md). |
| `category` | string | No | Non-empty string |
| `tags` | string[] | No | **Full replacement** of tags array |
| `seoTitle` | string | No | Max 60 characters |
| `seoDescription` | string | No | Max 160 characters |
| `fileIds` | string[] | No | **Full replacement** — send complete desired array of file ObjectIds. Must be unique; capped per type (physical/service **7**, digital **1**). |
| `digitalConfig` | object | No | Digital products only — product-wide toggle. Only `{ isActive }` is accepted (strict). Per-variant asset/limits live on the variant. |
| `delivery` | object | No | **Physical products only** (`400 CATALOG_PRODUCT_INVALID_TYPE` otherwise). Sets the product's own delivery-agency override — see sub-fields and the important note below. |
| `vectorisationEnabled` | boolean | No | Toggle vectorisation opt-in. When provided, the backend runs the enable or disable flow after the content update — see [Vectorisation](#vectorisation). For quick toggles only, use `PATCH /:id/vectorisation`. |

**`delivery` sub-fields:**

| Field | Type | Notes |
|-------|------|-------|
| `agencyId` | string \| null | The delivery agency ObjectId this product should use instead of the vendor's default, or `null` to clear the override and fall back to the vendor's default. Either sub-field may be sent independently (merged against the existing value) — at least one of `agencyId`/`freeDelivery`/`pickupLocation` must be present. |
| `freeDelivery` | boolean | Marketing/order flag, independent of agency resolution. |
| `pickupLocation` | object \| null | Where the resolved delivery agency should collect this product from. `null` clears it. See sub-fields below. |

**`delivery.pickupLocation` sub-fields:**

| Field | Type | Notes |
|-------|------|-------|
| `source` | `"vendor_address"` \| `"agency_storage"` | Required. `vendor_address` — collect from one of your business addresses. `agency_storage` — the agency already warehouses your stock; nothing to collect. |
| `vendorAddressId` | string \| null | Required (and must match an entry in your [`business_addresses`](./profile.md)) when `source` is `vendor_address`; ignored/omit when `source` is `agency_storage`. |
| `agencyAddressId` | string \| null | **Optional.** Which of the agency's depots warehouses this product, when `source` is `agency_storage`; ignored/omit for `vendor_address`. List the options with [GET /delivery-agencies/:agencyId/locations](./delivery-agencies.md#list-an-agencys-pickup-locations) and send one of their `id`s. |

> [!NOTE]
> **`agencyAddressId` is optional, and omitting it is meaningful: it means the agency's *primary*
> depot.** It keeps meaning that — if the agency later reorders its locations, the product follows
> the new primary. Storing the primary's id explicitly pins that depot instead. Those are two
> different intents, so don't pre-fill the picker with the primary's id when the vendor hasn't
> chosen; leave it null and mark the `isPrimary` option as the default.
>
> This is also why every product created before depots were selectable keeps working: they all
> carry `agencyAddressId: null` and collect from the primary, exactly as before. A depot the agency
> later **deletes** falls back to the primary too, rather than stranding the delivery.

> [!IMPORTANT]
> **Changing `delivery.agencyId` can restore the product and reassign in-flight orders.** If this product was suspended because its previous override agency went inactive, setting it to a **new active** agency (or clearing it back to `null`, falling back to the vendor's active default) automatically restores the product if it's now eligible again, and reassigns any of its still `pending`/`assigned`/held order items from the old agency over to the new one. The response `message` reports how many order items were moved. See [Admin: Delivery Agencies](../admin/delivery-agencies.md) for the full cascade.
>
> **Setting a non-null `agencyId` now requires an active, approved connection** between your vendor account and that agency (`422 CONNECTION_NOT_ACTIVE`) — see [Agency Connections](./agency-connections.md). Clearing the override to `null` is always allowed. An agency id that already has an active connection but is itself inactive/unresolvable is still accepted on write; the product simply fails activation (`CATALOG_PRODUCT_NO_DELIVERY_AGENCY`) until the agency comes back.
>
> **`pickupLocation` is validated against whichever agency actually ends up handling delivery** — this product's own `agencyId` override if set (including one set in the same request), otherwise your vendor default. `source: "vendor_address"` requires that agency's policy to offer address pickup; `source: "agency_storage"` requires it to offer storage-based fulfillment — an agency offering only one of the two rejects the other (`422 CATALOG_PRODUCT_INVALID_PICKUP_LOCATION`). If neither `agencyId` (override or vendor default) is resolvable yet, you'll get `422 CATALOG_PRODUCT_NO_DELIVERY_AGENCY` — set an agency first. See [Delivery Agencies](./delivery-agencies.md#pickup_based--storage_based-and-pickup-locations) for how to tell which pickup types an agency supports before presenting the picker to the vendor.

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
  "message": "Product updated successfully. 2 pending order item(s) reassigned to the new agency."
}
```
The trailing sentence about reassigned order items is only present when `delivery.agencyId`
changed and at least one order item was moved (see the important note above) — otherwise
`message` is just `"Product updated successfully"`.

> **Vectorisation on update:**
> - If the body **omits** `vectorisationEnabled`, the product is saved and the response returns immediately; the backend automatically re-vectorises in the background if the product is `active` and `vectorisationEnabled` is currently `true`. `vectorisationStatus` may briefly be `pending` before returning to `completed`.
> - If the body **includes** `vectorisationEnabled: true`, the backend runs the enable flow after the content update (eligibility check + vectorise), exactly as if `PATCH /:id/vectorisation` had been called.
> - If the body **includes** `vectorisationEnabled: false`, the backend runs the disable flow after the content update (clear flag + upstream delete).
> - The HTTP response always returns immediately; the vectorisation side-effect runs in the background.

**Error Responses:**
- `404 CATALOG_PRODUCT_NOT_FOUND` — Product not found
- `422 CATALOG_PRODUCT_INVALID_STATE` — Product is `archived` or `pending_review`; update not allowed. **`suspended` products ARE editable** — editing is often the way out of suspension (e.g. repointing `delivery.agencyId` at a working agency, which auto-restores the product if it's eligible again).
- `422 CONNECTION_NOT_ACTIVE` — `delivery.agencyId` was set to an agency you don't have an active, approved connection with. See [Agency Connections](./agency-connections.md).
- `422 CATALOG_PRODUCT_NO_DELIVERY_AGENCY` — `delivery.pickupLocation` was set but no delivery agency (override or vendor default) is resolvable yet.
- `422 CATALOG_PRODUCT_INVALID_PICKUP_LOCATION` — `delivery.pickupLocation` doesn't match the resolved agency's policy, `vendorAddressId` doesn't match one of your business addresses, or `agencyAddressId` isn't one of the resolved agency's locations.
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
| `suspended` | **System lock — vendors can neither set nor leave it.** Any attempt to change a suspended product's status here returns `422 CATALOG_PRODUCT_INVALID_STATE`. **Read `suspension.reason` before writing any copy** — the reasons are disjoint and they clear by different means (`product.model.ts:85-93`). The delivery-agency cascade (agency deactivated, connection paused/terminated, default removed) applies to **`active` products only** — drafts stay drafts (and stay editable) while an agency problem lasts — and it clears **automatically** when the cause is fixed: new active default agency set, connection (re)approved, agency reactivated, or the product's own `delivery.agencyId` repointed at a working agency via [Update Product](#update-product), each re-validating the activation gate before restoring. **`plan_quota_exceeded` is different on both counts**: it *does* suspend drafts, and no restore endpoint anywhere lifts it — see [Plan quota enforcement](#plan-quota-enforcement). |

> [!IMPORTANT]
> **Allowed transitions (vendor-triggered).** The current status constrains what you may request:
>
> | From | Allowed targets |
> |------|-----------------|
> | `draft` | `active` (runs the activation gate below), `archived` |
> | `active` | `draft`, `archived` |
> | `archived` | `draft` (unarchive first — activation happens from `draft` only) |
> | `suspended` | — none (system lock, see table above) |
> | `pending_review` | — none (admin moderation) |
>
> Re-requesting the current status is accepted as a no-op. Anything else returns
> `422 CATALOG_PRODUCT_INVALID_STATE` with `details: { status, requested }`. The same rules apply
> to [Bulk Status Change](#bulk-status-change) (ineligible products are reported/skipped, not
> errored as a whole) and to archiving (single + bulk: only `draft`/`active` products can be archived).

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
> - **Physical**: the vendor's default delivery agency (`vendor.default_delivery_agency_id`) must exist, currently be `active`, **and** have an active, approved [connection](./agency-connections.md) with your vendor account — this is **always** required, regardless of whether the product has its own override. If the product **also** has its own `delivery.agencyId` override set, that override must **independently** satisfy the same three conditions (active agency + active connection) too — both are checked, not either/or. On top of that, the product must have a `delivery.pickupLocation` set that's still valid against whichever agency actually ends up handling delivery (the override if set, else the vendor default) — see [Update Product](#update-product) for the sub-fields and policy-matching rules. If any agency/connection/pickup-location condition regresses later (agency deactivated, connection paused, referenced business address removed), the product is auto-suspended or demoted (and, if it has pending orders, those are put on hold) until a working replacement is configured — see [Admin: Delivery Agencies](../admin/delivery-agencies.md).
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

> [!WARNING]
> **`archived → draft` is plan-quota gated.** Un-archiving is the one vendor transition on this
> route that takes a catalogue slot *back*, so it can be refused with **`403
> BILLING_LIMIT_EXCEEDED`** (`details: { limit, current, requested, available }`) even though the
> vendor owns the product and the transition is legal
> (`vendor-product.controller.ts:322-324`). Without this gate the remedy for the cap would also
> be the way around it: archive one, create one, un-archive the first, repeat. Every other
> transition here moves between two statuses that both occupy a slot, so none of them can raise
> it. See [Plan quota enforcement](#plan-quota-enforcement).

**Error Responses `422`:**

| Code | Meaning |
|------|---------|
| `CATALOG_PRODUCT_INVALID_STATE` | The requested transition isn't vendor-triggerable (see the allowed-transitions table above — e.g. any change from `suspended`, or `archived → active` without unarchiving to `draft` first). `details: { status, requested }` |
| `CATALOG_PRODUCT_NO_DESCRIPTION` | `description` is missing or blank |
| `CATALOG_PRODUCT_NO_VARIANTS` | No variants exist |
| `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | An active variant has price = 0 |
| `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` | `defaultVariantId` missing or points to archived/nonexistent variant |
| `CATALOG_PRODUCT_NO_DELIVERY_AGENCY` | Physical product: vendor has no active default delivery agency, or (if set) the product's own override agency isn't active, or its connection needs (re)approval |
| `CATALOG_PRODUCT_NO_PICKUP_LOCATION` | Physical product: `delivery.pickupLocation` is not set |
| `CATALOG_PRODUCT_INVALID_PICKUP_LOCATION` | Physical product: `delivery.pickupLocation` no longer matches the resolved agency's policy, or its referenced business address no longer exists |
| `CATALOG_VARIANT_NO_DIGITAL_ASSET` | A digital product's active variant has no uploaded asset (details include the variant name/sku) |
| `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | Digital product has more than 5 active variants |
| `CATALOG_PRODUCT_SERVICE_NO_DURATION` | Service product has no `durationMinutes` |
| `CATALOG_PRODUCT_SERVICE_NO_CAPACITY` | Service product in `capacity` mode has no `maxBookings` (≥ 1) |
| `CATALOG_PRODUCT_SERVICE_NO_AVAILABILITY` | Service product has no availability rule. **Pairs with the one above** — setting a duration is not enough |
| `CATALOG_PRODUCT_VENDOR_SUSPENDED` | The owning **vendor** is suspended. Universal, every product type, and nothing the vendor can do — an administrator must reinstate the account |
| `CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK` | The product is fulfilled from agency storage and a variant still allows unlimited stock |

> ⚠ **The last three were missing from this table until 2026-09-06.** The activation gate is one
> function — `ProductStatusValidationService.collectActivationBlockers`, which `validate()`
> delegates to — and it raises **thirteen** distinct codes; this table listed ten of them.
> **[Activation Requirements](#activation-requirements) below was corrected to all thirteen
> earlier the same day and this table was not**, so the page carried the complete list in its
> summary section and an incomplete one at the endpoint that actually returns them.
>
> `CATALOG_PRODUCT_VENDOR_SUSPENDED` is the costly omission: it is **universal**, it is not
> something the vendor can clear, and a client pre-validating against this table would show a
> suspended vendor a checklist of things to fix that would never let the product activate.
>
> ⚠ Note `CATALOG_PRODUCT_INVALID_STATE` and `CATALOG_PRODUCT_INVALID_PICKUP_LOCATION` are in
> this table but are **not** activation blockers — they are transition and write-time
> validations. This table is the endpoint's whole `422` surface, which is a superset of the
> thirteen.

---

### Duplicate Product

```http
POST /api/vendor/products/:id/duplicate
```

Creates an independent copy of the product in `draft` status.

> [!WARNING]
> **Plan-quota gated.** The copy lands as a `draft` and a draft occupies a catalogue slot, so a
> vendor at their cap gets **`403 BILLING_LIMIT_EXCEEDED`** with
> `details: { limit, current, requested, available }` and no product is created
> (`vendor-product.controller.ts:369-371`). This was the one create path that never asked, so a
> vendor at 15/15 could duplicate to 16, 17, 18 indefinitely. See
> [Plan quota enforcement](#plan-quota-enforcement).

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
| `mode` | Copied — a `simple` product duplicates to a `simple` one |
| `hasVariants` | **`advanced`: always `false`** — variants are NOT copied. **`simple`: `true`** — see the row below |
| `defaultVariantId` | **`advanced`: `null`** — must create new variants for the clone. **`simple`: the id of the cloned variant** |
| **`simple` mode: the lone variant** | ⚠ **IS cloned** (`ProductDuplicateService.ts:105-155`), because a simple product's contract is "exactly one variant" and a variant-less copy would be born violating it. `price`, `compareAtPrice`, the `bargain` window, stock fields and dimensions are copied verbatim; the **SKU is regenerated** (it is globally unique and doubles as the option-less `optionSignature`) and the variant's **images are NOT carried over**. The response's `hasVariants`/`defaultVariantId` therefore differ from the `advanced` example above |
| Digital: `digitalConfig.isActive` | Always `false` |
| Digital: variants & per-variant assets/limits | **NOT copied** — variants aren't cloned, so the vendor must re-create each format variant and re-upload its asset |
| Service: variant (`serviceConfig` + price) | **NOT copied** — variants aren't cloned, so the vendor must re-create the service variant with its config + price |
| `vectorisationEnabled` | Always `false` — must be explicitly re-enabled on the clone |
| `vectorisationStatus` | Always `not_started` |
| `vectorisedDataId` | Always `null` |

> After duplication, an **advanced** product's clone has no variants — the vendor must create at
> least one, and upload a new digital asset (for digital products), before it can be activated. A
> **simple** product's clone already has its variant and can be activated once the rest of the
> gate passes. Tell the vendor which of the two just happened; "duplicated" means two different
> things.

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
- `409 CATALOG_PRODUCT_SIMPLE_MODE_LOCKED` — **the product uses the simple editor**, which has exactly one variant, so there is no default to choose. ⚠ **Absent from this list until 2026-09-06** — `assertNotSimpleMode(product, 'choosing a default variant')` runs first (`vendor-product.controller.ts:302`). `details` carries `{ mode: "simple", convertEndpoint: "POST /api/vendor/products/{id}/convert-to-advanced" }`, so offer the conversion rather than a generic 409.

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

> [!NOTE]
> Only `draft` and `active` products are archived — same rule as the single-product archive
> route. Products in any other status (`suspended`, `archived`, `pending_review`) are silently
> skipped and reflected in the `failed` count.

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
> When changing status to `active`, the backend validates each product individually using the same rules as the single-product status endpoint — **including the allowed-transitions table** (activation from `draft` only; `suspended`/`pending_review` products can never be moved by a vendor). Products failing either check are not updated and are reported in the `errors` array. This is a partial-success operation.
>
> For `draft`/`archived` targets, products whose current status doesn't permit the transition (e.g. `suspended`) are silently skipped and show up in the `failed` count without a per-product error entry.

> [!WARNING]
> **A `draft` target is plan-quota gated, and it refuses the WHOLE batch.** `archived → draft` is
> the one vendor transition that takes a catalogue slot back, so the batch is counted as
> arithmetic — "is there room for all *N* of the archived ones", not "is there room for one" —
> and a batch that would not fit returns **`403 BILLING_LIMIT_EXCEEDED`** with
> `details: { limit, current, requested, available }` and applies **nothing**
> (`ProductBulkOperationsService.ts:56-72`). It is a whole-request `403`, not rows in `errors[]`,
> so the partial-success shape above does not describe it. `available` is the number of free
> slots to show the vendor.
>
> No other target can raise it — `draft` is the only one whose allowed sources include
> `archived` — and [Bulk Archive](#bulk-archive) never can, because archiving frees slots.
> See [Plan quota enforcement](#plan-quota-enforcement).

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
  - `bargain` — the [bargainable-pricing](./variants.md#bargainable-pricing) window, `{ minPrice, maxPrice }`, or `null` when the vendor configured none. `minPrice` always equals the variant's `price`; `maxPrice` is the ceiling the negotiating agent may go up to.

So a service variant is indexed with its full booking config, a digital variant with its asset details and limits, and a physical variant with its options/dimensions/agency — each on the variant it belongs to.

Only **active** variants are indexed, so an archived variant's bargain window never reaches the negotiator.

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

> [!IMPORTANT]
> ## `vectorisationEnabled` is also the bargainable-pricing gate
>
> A variant's [bargain window](./variants.md#bargainable-pricing) only applies while its
> parent product has `vectorisationEnabled: true` — the agent that negotiates reads its
> catalogue from the AI index. Variant read models report this as `bargainable`.
>
> Four consequences:
>
> - **A window can be configured at any time**, whether or not the flag is on. It is fully
>   price-validated either way, and simply inert until the flag flips. So a brand-new
>   product may carry a window and report `bargainable: false`; that is expected.
> - **Turning vectorisation off never deletes a window.** `bargainable` goes `false`, the
>   configuration stays visible and editable, and re-enabling brings it straight back.
> - **The flag can turn itself off.** A product that stops being *eligible* — demoted out of
>   `active`, or its `title` / `description` / `category` emptied — has `vectorisationEnabled`
>   reset to `false` by the pipeline (see the `ineligible` outcome below). `bargainable` will
>   therefore flip with no pricing edit having taken place. Re-read it rather than caching it.
> - **Route 1 responds before the toggle is applied.** `PATCH /api/vendor/products/:id`
>   sends its response and *then* applies `vectorisationEnabled`, so the `data` it returns —
>   and any variant read racing it — still reflects the old flag. Route 2
>   (`PATCH /:id/vectorisation`) awaits the toggle, so use it when you need the flag and its
>   effect in one round trip.
>
> Also note that while `vectorisationStatus` is `pending`, **every** variant and product write
> returns `409 CATALOG_PRODUCT_VECTORISATION_PENDING`. A UI that reveals a bargain editor the
> moment vectorisation is enabled reveals it inside exactly that window — handle the 409.

### Status Lifecycle

| `vectorisationStatus` | Meaning |
|-----------------------|---------|
| `not_started` | Vectorisation has never run (new product, or `vectorisationEnabled` was `false`) |
| `pending` | The backend has accepted the job and is calling the vectoriser |
| `completed` | Successfully vectorised. `vectorisedDataId` is populated. |
| `failed` | All retry attempts failed. An admin can trigger re-vectorisation via the reconciliation script or the admin bulk endpoint. |
| `skipped_no_credits` | The vendor's credit balance was too low, so the product **saved normally** and was never sent to the vectoriser. Not an error — the write returned `200`/`201`. Surface a *"top up to enable AI search"* hint and retry after a top-up. |

> [!WARNING]
> **`skipped_no_credits` is TERMINAL and this page listed only four states until 2026-09-06.**
> `VectorisationStatus` (`product.model.ts:26`) has **five**. The omission mattered in two
> directions: `billing.md` and `billing-overview.md` both already told clients to detect this exact
> value, so the two pages contradicted each other; and the polling helper below treats only
> `completed` and `failed` as terminal, so a `skipped_no_credits` product polls for a full 60
> seconds and then throws **"Vectorisation timed out"** — a credit problem reported as an outage.

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
    // Terminal too — the product saved fine, it was simply never indexed. Do NOT keep polling.
    if (data.vectorisationStatus === 'skipped_no_credits') throw new Error('Insufficient credits');
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

### ⚠ `pending` LOCKS THE WHOLE PRODUCT — `409 CATALOG_PRODUCT_VECTORISATION_PENDING`

While `vectorisationStatus === 'pending'`, **every write on that product is refused with a
`409`**, not just the vectorisation toggle. The guard is one middleware,
`requireProductEditable` (`require-product-editable.middleware.ts:49-53`), attached to **more
than twenty routes** on the vendor product router — the product `PATCH`, `PATCH /:id/simple`,
`POST /:id/convert-to-advanced`, `PATCH /:id/status`, `PATCH /:id/default-variant`,
`POST /:id/duplicate`, `DELETE /:id`, both vectorisation routes, and **every variant, option and
option-value write**.

> ⚠ **This was documented in only two places until 2026-09-06** — the bargain editor note and
> the vectorisation-toggle error list — and was absent from the error table of every route
> above. A dashboard that surfaces the 409 on the toggle and lets a vendor edit a variant during
> the same window shows an unexplained failure on a screen that never mentions vectorisation.
>
> **It is short-lived and it is not an error condition** — treat it as *busy*, not *broken*.
> Poll `GET /:id/vectorisation/status` and re-enable the form, rather than surfacing a hard
> failure.
>
> ⚠ **Two routes are deliberately NOT behind it**: `GET`s (reads never lock) and
> `POST /:id/share`, because sharing reads a product rather than editing one
> (`vendor-products.routes.ts:161`).

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
  "message": "Retry scheduled. The vectoriser is being called in the background."
}
```

**Error Responses:**

| Status | `error.code` | When |
|---|---|---|
| `404` | `CATALOG_PRODUCT_NOT_FOUND` | No such product, or it is not this vendor's (`vendor-product.controller.ts:519-520`) |
| `422` | `CATALOG_PRODUCT_VECTORISATION_NOT_ELIGIBLE` | The product failed the eligibility check — see the ⚠ below, because this one **changes state** |

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "CATALOG_PRODUCT_VECTORISATION_NOT_ELIGIBLE",
    "message": "Product is not eligible for vectorisation. Vectorisation has been disabled — ensure the product is active and has a title, description, and category, then re-enable vectorisation.",
    "statusCode": 422,
    "category": "business_rule",
    "details": {
      "state": {
        "vectorisationEnabled": false,
        "vectorisationStatus": "not_started",
        "vectorisedDataId": null
      }
    }
  }
}
```

> ⚠ **THIS 422 IS NOT A NO-OP — it has already switched `vectorisationEnabled` OFF**, and this
> section documented it as a plain refusal until 2026-09-06. `prepareForVectorisation` flips the
> flag and resets the status when it finds the product ineligible, *before* the controller
> raises (`vendor-product.controller.ts:522-534`). So a client that shows this error and leaves
> its toggle rendered as "on" is now out of sync with the server: **re-read the product, or read
> `error.details.state`**, which is the post-flip row and is carried for exactly this reason.
>
> Two smaller corrections in the same pass: the `404` row above was missing entirely, and the
> success message said *"will be called"* where the server sends *"**is being** called"*
> (`:539`) — the retry is dispatched after the response, so the present tense is the accurate one.
>
> ⚠ **The `409`-while-`pending` rule in "Business Rules" above is real but is enforced on
> `PATCH /:id/vectorisation`, not here** — this handler has no pending check.

---

## Activation Requirements

Summary of what the backend validates when changing status to `active`. Frontend should pre-validate these before calling the status endpoint.

> [!WARNING]
> **This section listed 11 requirements and the gate enforces 13 — four were missing until
> 2026-09-06** (DOC-PROGRAM F-17 class 8). The authority is one function,
> `ProductStatusValidationService.collectActivationBlockers`, and it is the *only* place the rule
> list lives — `validate()` delegates to it. The four that were absent:
> `CATALOG_PRODUCT_NO_DESCRIPTION` and `CATALOG_PRODUCT_VENDOR_SUSPENDED` (both universal), and
> `CATALOG_PRODUCT_SERVICE_NO_CAPACITY` + `CATALOG_PRODUCT_SERVICE_NO_AVAILABILITY`.
>
> **The service pair is the one that cost something**: this page named a single service
> requirement, so a vendor pre-validating against it would set a duration, call the status
> endpoint, and be refused for an availability rule the documentation never mentioned.
>
> ⚠ **Every failing rule is reported at once**, not just the first — the response carries the whole
> checklist in `meta.activation.blockers[]` (or `details.blockers[]` on an unsuspend). Pre-validate
> against all thirteen, and render the list you get back rather than the first entry.

**Universal (all product types):**

| Requirement | Error Code | Description |
|-------------|------------|-------------|
| `description` is non-empty after trimming | `CATALOG_PRODUCT_NO_DESCRIPTION` | Set `description`. ⚠ The plain-text field is what the gate reads — clearing it while keeping `descriptionRich` still blocks activation |
| At least one variant | `CATALOG_PRODUCT_NO_VARIANTS` | Create at least one variant first |
| All active variants have `price > 0` | `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | Update variant price |
| `defaultVariantId` points to an active variant | `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` | First variant is auto-set; use `/default-variant` to reassign |
| The owning **vendor** is not suspended | `CATALOG_PRODUCT_VENDOR_SUSPENDED` | Nothing the vendor can do — an administrator must reinstate the account. Applies to **every** product type, and it is what stops the delivery-agency and agency-storage restore paths walking a suspended vendor's catalogue back onto the storefront |

**Physical products only:**

| Requirement | Error Code | Description |
|-------------|------------|-------------|
| Vendor has an active default delivery agency, with an active connection | `CATALOG_PRODUCT_NO_DELIVERY_AGENCY` | Set one via `PUT /profile/default-delivery-agency` — see [profile.md](./profile.md) |
| If set, the product's own `delivery.agencyId` override is independently active, with an active connection | `CATALOG_PRODUCT_NO_DELIVERY_AGENCY` | Clear the override or point it at a working agency via `PATCH /:id` |
| `delivery.pickupLocation` is set | `CATALOG_PRODUCT_NO_PICKUP_LOCATION` | Set it via `PATCH /:id` — see [Update Product](#update-product) |
| `delivery.pickupLocation` matches the resolved agency's policy (`pickup_based`/`storage_based`) and, for `vendor_address`, still references an existing business address | `CATALOG_PRODUCT_INVALID_PICKUP_LOCATION` | Re-pick a valid pickup location for the resolved agency |
| **For `agency_storage` pickup only:** no active variant has `isInfiniteStock: true` | `CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK` | Turn off unlimited stock and record a real quantity, or move pickup back to a vendor address. `details.variant` names the offender |

> [!IMPORTANT]
> **A warehouse cannot hold an unbounded quantity.** An agency that stores your goods
> bills per SKU against a quantity and reconciles a shelf against a number, so
> `agency_storage` and `isInfiniteStock` are mutually exclusive.
>
> The same rule is enforced as a **refusal**, not a blocker, on the two write paths that
> could otherwise put a *live* product into that state:
> - `PATCH /api/vendor/products/:id` moving pickup to `agency_storage` while a variant is
>   unlimited → `422`, with `details.variants` listing every offender. The save is
>   rejected rather than accepted-and-silently-unpublished.
> - a [stock request](./stock-requests.md) asking to go unlimited on a warehoused SKU →
>   `422` at creation, so no approvable request can leave a product failing its own gate.
>
> Note this is **not** a `stock > 0` rule. A warehoused product may legitimately be at
> zero, and requiring a positive quantity would silently demote it to `draft` the moment
> it sold out.

**Digital products only:**

| Requirement | Error Code | Description |
|-------------|------------|-------------|
| Every active variant has an uploaded asset | `CATALOG_VARIANT_NO_DIGITAL_ASSET` | Upload a file for each format variant (auto-archives variants without one) |
| No more than 5 active variants | `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | Remove/archive extra variants (max 5) |

**Service products only:**

| Requirement | Error Code | Description |
|-------------|------------|-------------|
| The default variant has `serviceConfig.durationMinutes` | `CATALOG_PRODUCT_SERVICE_NO_DURATION` | Create the service variant (with `serviceConfig`) via `POST /products/:id/variants` |
| **`bookingMode: 'capacity'` only:** `serviceConfig.maxBookings >= 1` | `CATALOG_PRODUCT_SERVICE_NO_CAPACITY` | A capacity service sells seats, so it needs a seat count. Not checked for `calendar` or `manual` |
| At least one **active** availability rule | `CATALOG_PRODUCT_SERVICE_NO_AVAILABILITY` | Create one via `POST /products/:id/availability-rules` — see [availability-rules.md](./availability-rules.md). Without one, availability is empty and nothing is bookable. ⚠ `isActive` defaults to **`false`** on create, so a rule that exists is not yet a rule that counts |

> [!NOTE]
> **The first two are skipped when there is no default variant**, because `serviceConfig` lives on
> it — the universal `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` blocker already names the fix, and
> restating it as three would be noise. The availability check runs regardless.

---

## Plan quota enforcement

**New since 2026-08-24** (`src/modules/plan-quota/`). The plan's `max_active_products` and
`max_storage_bytes` used to bind only at creation time, on two endpoints. They now also bind
**retroactively**: every time a vendor's active plan changes, the backend recounts and brings the
catalogue and the media library back inside the new allowance.

### Nothing is deleted

The allowance is filled **from the oldest end**, and whatever no longer fits is held back:

| Axis | What happens to what does not fit |
|---|---|
| Products (`max_active_products`) | `status` → `"suspended"`, with `suspension.reason: "plan_quota_exceeded"` and `suspension.previousStatus` recording what to return it to |
| Files (`max_storage_bytes`) | the file stops being served — its `FileDetail` comes back with `access: "quota_blocked"` and **`url: null`** |

Both are **reversible and lossless**. An upgrade re-runs the identical computation against the
larger number, so restoration is oldest-first for free. Do not present either to a vendor as
deletion.

### What counts against the product cap

Every product that is not deleted, not `archived`, and not already quota-suspended
(`product.repository.mongo.ts:86-93`). **Drafts count.** `null` on the plan means unlimited and
skips the check entirely.

### `plan_quota_exceeded` is a suspension reason unlike the other six

- **No restore path lifts it.** Not the vendor's, not the agency's, not an administrator's — none
  of them buys a bigger plan. Only `PlanQuotaEnforcementService` writes or clears it. The two
  things that work are **upgrading the plan** and **archiving something older**: archiving
  publishes a capacity-freed signal and the next-oldest suspended product returns on its own
  (`vendor-product.controller.ts:129-135`).
- **It is the only reason that can attach to a product that is not `active`.** A draft occupies a
  slot, so the sweep suspends drafts too.
- **Suspensions belonging to somebody else are pinned.** A product suspended by an administrator,
  by an agency or by the vendor cascade keeps its slot and is never touched by this sweep — room
  reappearing in a plan says nothing about why somebody else took a listing down.
- **A restored product that no longer passes the activation gate is returned to `draft`, not left
  suspended.** The vendor bought the room; holding it under a *quota* suspension would be a lie
  about why it is off sale and would keep consuming the slot the next product is waiting for.

### Files: two exemptions worth knowing

- **Digital-product asset files are outside the media cap and are never blocked.** They are
  metered under their own per-asset cap, and they are goods a customer has already paid for.
- **`quota_blocked` outranks `authorized`.** A blocked file inside a private tree reports
  `quota_blocked`, not `authorized`, so a client is told it is a billing problem rather than sent
  to an authorized byte route to discover a permissions-shaped error about a billing fault.

### Where the refusals show up

| Endpoint | Raises `403 BILLING_LIMIT_EXCEEDED` |
|---|---|
| `POST /api/vendor/products` | at the cap |
| `POST /api/vendor/products/simple` | at the cap |
| `POST /api/vendor/products/:id/duplicate` | at the cap — **new** |
| `PATCH /api/vendor/products/:id/status`, `archived → draft` only | at the cap — **new** |
| `POST /api/vendor/products/bulk/status`, `draft` target only | if the whole batch would not fit — **new**, all-or-nothing |

`details` carries `{ limit, current, requested, available }` on every one of them.

### Timing

Enforcement is driven by a `plan.activated` event and normally lands within a second of the plan
change; a nightly sweep (`PLAN_QUOTA_RECONCILE_CRON`, default `45 3 * * *`) is the durable
backstop. Neither runs on a request path — a plan purchase returns before the recount finishes, so
a client should **re-fetch after an upgrade** rather than assume the purchase response reflects
it.

---

## Error Codes

All errors use this response shape:

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "CATALOG_PRODUCT_NOT_FOUND",
    "message": "Human-readable description",
    "statusCode": 404,
    "category": "not_found",
    "details": { "...additional context..." }
  }
}
```

Validation errors carry `details.fields[]`, where `path` is the dot-joined location and `code` is
the Zod issue kind:

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
        { "path": "title", "message": "Title must be at least 3 characters", "code": "too_small" }
      ]
    }
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
| `CATALOG_PRODUCT_NO_DELIVERY_AGENCY` | 422 | Activation blocked (or `delivery.pickupLocation` update rejected) — physical product has no resolvable active delivery agency/connection |
| `CATALOG_PRODUCT_NO_PICKUP_LOCATION` | 422 | Activation blocked — physical product has no `delivery.pickupLocation` set |
| `CATALOG_PRODUCT_INVALID_PICKUP_LOCATION` | 422 | `delivery.pickupLocation` doesn't match the resolved agency's policy, or its business address no longer exists |
| `CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK` | 422 | Activation blocked, **or** a `PATCH /:id` moving pickup to `agency_storage` rejected — an active variant has `isInfiniteStock: true` |
| `CATALOG_VARIANT_NO_DIGITAL_ASSET` | 422 | Activation blocked — a digital variant has no uploaded asset |
| `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | 400/422 | Digital product exceeds 5 variants (400 on create, 422 on activation) |
| `CATALOG_PRODUCT_SERVICE_NO_DURATION` | 422 | Activation blocked — service product has no duration |
| `CATALOG_DIGITAL_ASSET_ALREADY_EXISTS` | 409 | Attempted `POST` upload when the variant already has an asset; use `PUT` |
| `CATALOG_DIGITAL_ASSET_MISSING` | 404 | Attempted `PUT`/`DELETE` when the variant has no asset |
| `CATALOG_DIGITAL_ASSET_MISSING_FILE` | 400 | No file included in the upload request |
| `CATALOG_FILE_TOO_LARGE` | **413** | Upload exceeds the route’s multer ceiling. Raised by the multer branch of the error handler, never at 400. |
| `CATALOG_FILE_TYPE_INVALID` | 400 | MIME type is not in the allowed list |
| `VALIDATION_ERROR` | 400 | Zod schema validation failed |
