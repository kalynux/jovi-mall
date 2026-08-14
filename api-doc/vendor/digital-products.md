# Digital Products API — Multi-Variant Guide

> **Audience:** Frontend developers building the vendor "manage digital product" UI.
> **Status:** Current as of the multi-variant digital upgrade (2026-05). This supersedes the old single-asset-per-product model.

---

## 1. What changed (read this first)

Digital products used to allow **exactly one downloadable file per product**, stored at `product.digitalConfig.assetId`. That is gone.

Now a digital product is a container for **1 to 5 variants**, and **each variant owns its own asset**:

| Concept | Old model | New model |
|---------|-----------|-----------|
| Where the file lives | `product.digitalConfig.assetId` | `variant.digital.asset` (per variant) |
| Download limits | `product.digitalConfig.maxDownloads` / `expiresAfterDays` | `variant.digital.maxDownloads` / `expiresAfterDays` (per variant) |
| Variants per digital product | effectively 1 | **1–5** |
| Asset upload endpoint | `POST /products/:id/digital/asset` | `POST /products/:productId/variants/:variantId/digital/asset` |
| Product-level toggle endpoint | `PATCH /products/:id/digital/toggle` | **removed** — use `PATCH /products/:id` with `digitalConfig.isActive` |

**Why:** a vendor selling, say, a "JavaScript Course Bundle" can now offer the same product as a `.pdf`, a `.zip` (with source), an `.epub`, and an `.mp4` — each its own variant with its own price, SKU, file, and download rules.

> [!WARNING]
> **Breaking change — no migration.** Existing digital products that relied on the old product-level asset will fail activation until each variant has a file uploaded through the new per-variant endpoints. The old `/products/:id/digital/*` routes and the `/digital/toggle` route have been **removed** and now return 404.

---

## 2. Mental model

```
Digital Product  (type: "digital")
├── digitalConfig: { isActive }          ← product-wide download kill switch
└── Variants (1–5, each is a "format")
    ├── Variant "PDF"   → price, sku, name?, digital: { asset, maxDownloads, expiresAfterDays }
    ├── Variant "ZIP"   → price, sku, name?, digital: { asset, maxDownloads, expiresAfterDays }
    └── Variant "EPUB"  → price, sku, name?, digital: { asset, maxDownloads, expiresAfterDays }
```

**Three rules to internalize:**

1. **A digital variant is `status: "active"` if and only if it has an asset.** The backend enforces this automatically:
   - Create a digital variant → it starts `"archived"` (no file yet).
   - Upload its asset → it becomes `"active"`.
   - Remove its asset → it returns to `"archived"`.
2. **A digital product can have at most 5 variants.** Creating a 6th returns `400 CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED`.
3. **Activation requires every active variant to have an asset** (it always will, due to rule 1) and at least one active variant to exist. A product with only asset-less (archived) variants cannot be activated.

---

## 3. Data shapes

### 3.1 Product (`type: "digital"`)

`GET /api/vendor/products/:id` returns the product with a slimmed `digitalConfig`:

```json
{
  "id": "507f1f77bcf86cd799439011",
  "type": "digital",
  "status": "draft",
  "title": "JavaScript Course Bundle",
  "description": "Complete JS course in multiple formats",
  "hasVariants": true,
  "defaultVariantId": "507f1f77bcf86cd799439020",
  "digitalConfig": {
    "isActive": true
  },
  "files": [],
  "createdAt": "2026-05-27T10:00:00.000Z",
  "updatedAt": "2026-05-27T10:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `digitalConfig.isActive` | boolean | **Product-wide** download kill switch. When `false`, no entitlements are granted for any variant on purchase, regardless of variant state. Defaults to `true`. This is the only field left on the product-level `digitalConfig`. |

> `digitalConfig` no longer carries `assetId`, `maxDownloads`, or `expiresAfterDays`. Those moved to the variant. Sending any of them to `POST`/`PATCH /products` returns `400 VALIDATION_ERROR` (the schema is strict).

### 3.2 Variant (digital)

`GET /products/:id/variants` and `GET /products/:productId/variants/:variantId` return digital variants with a `digital` block and a computed `displayName`:

```json
{
  "id": "507f1f77bcf86cd799439020",
  "productId": "507f1f77bcf86cd799439011",
  "sku": "JS-COURSE-PDF",
  "name": null,
  "displayName": "js-course.pdf - pdf - 12 MB",
  "status": "active",
  "optionSignature": "",
  "price": 29.99,
  "compareAtPrice": null,
  "stock": 0,
  "isInfiniteStock": true,
  "lowStockThreshold": null,
  "allowOversell": false,
  "optionValueIds": [],
  "files": [],
  "digital": {
    "asset": {
      "id": "507f1f77bcf86cd799439030",
      "originalName": "js-course.pdf",
      "mimeType": "application/pdf",
      "size": 12582912
    },
    "maxDownloads": 5,
    "expiresAfterDays": 365
  },
  "createdAt": "2026-05-27T10:05:00.000Z",
  "updatedAt": "2026-05-27T10:06:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string \| null | Optional vendor-set variant name. |
| `displayName` | string | **Always present, never empty.** Use this as the label in the UI. Fallback chain below. |
| `digital` | object \| undefined | Present only on digital variants. `undefined` for physical/service. |
| `digital.asset` | object \| undefined | `undefined` until a file is uploaded. Once set: `{ id, originalName, mimeType, size }`. The raw download URL is **never** exposed here — customer downloads go through the entitlement/download-link flow. |
| `digital.maxDownloads` | number \| null | Per-variant download cap. `null` = unlimited. |
| `digital.expiresAfterDays` | number \| null | Per-variant expiry (days after purchase). `null` = never. |

**`displayName` fallback chain (computed by the backend):**

1. `variant.name` if the vendor set one (e.g. `"Commercial License"`).
2. Else, if an asset exists: `"<originalName> - <format> - <human size>"` (e.g. `"js-course.pdf - pdf - 12 MB"`).
3. Else: the product title.
4. Else: the SKU.

> Physical/service variants do **not** include the `digital` block and their `displayName` falls back to product title / sku when `name` is unset.

---

## 4. End-to-end workflow

```
1.  POST   /products                                  → create draft (type: "digital")
2.  PATCH  /products/:id                              → set description, tags, SEO (required for activation)
3.  POST   /products/:id/variants            (×1–5)  → create each format variant (starts "archived")
4.  POST   /products/:id/variants/:vId/digital/asset (×each) → upload the file → variant becomes "active"
5.  PATCH  /products/:id/variants/:vId/digital/config (optional) → set per-variant maxDownloads / expiresAfterDays
6.  PATCH  /products/:id/status { status: "active" }  → publish
```

> Steps 3 and 4 are the heart of the new flow: **create variant, then upload its asset.** A variant without an asset stays archived and will block nothing (it's just invisible to buyers) — but you need at least one active (asset-backed) variant to publish.

You can also set `maxDownloads`/`expiresAfterDays` at creation time by passing a `digitalConfig` block in the create-variant body (step 3), avoiding the separate step 5.

---

## 5. Endpoints

All endpoints require:

```
Authorization: Bearer <vendor_jwt>
```

Vendors can only manage their own products/variants. Base path: `/api/vendor/products`.

### 5.1 Create a digital variant

```http
POST /api/vendor/products/:id/variants
Content-Type: application/json
```

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

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `sku` | string | ✅ | 1–100 chars, globally unique. |
| `price` | number | ✅ | `>= 0` (must be `> 0` to activate). |
| `name` | string | No | 1–100 chars. If omitted, `displayName` is derived from the asset. |
| `compareAtPrice` | number | No | `>= 0`. |
| `bargain` | object | No | `{ minPrice?, maxPrice }` — bargainable pricing is **supported on digital variants**, identically to physical. `minPrice` defaults to `price`; `maxPrice` must be `>= price`. `null` clears it on PATCH. See [Bargainable pricing](./variants.md#bargainable-pricing). |
| `isInfiniteStock` | boolean | No | Digital variants are typically `true`. |
| `stock` | number | No | Ignored when `isInfiniteStock` is `true`. |
| `digitalConfig.maxDownloads` | number \| null | No | Per-variant download cap. `null`/omitted = unlimited. |
| `digitalConfig.expiresAfterDays` | number \| null | No | Per-variant expiry. `null`/omitted = never. |

> [!IMPORTANT]
> - **Rejected for digital variants (400 `CATALOG_PRODUCT_INVALID_TYPE`):** `optionValueIds`, `deliveryAgencyId`, `weight`, `length`, `width`, `height`.
> - **`digitalConfig.assetId` is NOT accepted in JSON.** The asset is attached only via the upload endpoint (5.2). Sending it is ignored/invalid.
> - The created variant comes back with `status: "archived"` — this is expected. It flips to `"active"` after you upload its asset.

**Success `201`:** the variant object (status `"archived"`, `digital.asset` absent).

**Errors:**

| Status | Code | Reason |
|--------|------|--------|
| 400 | `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | Product already has 5 variants. |
| 400 | `CATALOG_PRODUCT_INVALID_TYPE` | Physical-only field sent on a digital variant. |
| 409 | `CATALOG_VARIANT_SKU_EXISTS` | SKU already used by another variant. |
| 404 | `CATALOG_PRODUCT_NOT_FOUND` | Product not found / not owned. |

### 5.2 Upload a variant's digital asset

```http
POST /api/vendor/products/:productId/variants/:variantId/digital/asset
Content-Type: multipart/form-data
```

| Form field | Type | Notes |
|------------|------|-------|
| `file` | File | The downloadable file. One file per request. |

**File constraints:**

| Constraint | Value |
|------------|-------|
| Max size | 500 MB (configurable via `MAX_DIGITAL_ASSET_SIZE`) |
| Accepted formats | PDF, EPUB, ZIP, RAR, 7-Zip, MP3, WAV, MP4, MOV (QuickTime), JPEG, PNG, WebP, GIF |

> **How file types are checked (two gates).** The request first passes a
> lightweight check on the **client-declared** `Content-Type`, then the upload
> pipeline detects the **real** type from the file's magic bytes and validates
> *that* against the allowlist above. The detected type is authoritative and is
> what gets stored.
>
> - The declared `Content-Type` does **not** need to be canonical. Common
>   client/OS synonyms are accepted — e.g. Windows' `application/x-zip-compressed`
>   for a `.zip`, `application/vnd.rar`/`application/x-compressed` for a `.rar`,
>   or the generic `application/octet-stream`. The pipeline maps these to the
>   real sniffed type and does **not** reject them as a mismatch.
> - Both gates are derived from one source (the digital-asset upload policy), so
>   they cannot drift. Office documents (`.doc`, `.xls`, `.docx`, `.xlsx`) are
>   **not** an accepted format — wrap them in a `.zip` to distribute them. Any
>   file whose real (sniffed) type isn't in the accepted list is rejected even
>   if its declared `Content-Type` looked allowed.

**Example:**

```javascript
const fd = new FormData();
fd.append('file', fileBlob, 'js-course.pdf');

await fetch(
  `/api/vendor/products/${productId}/variants/${variantId}/digital/asset`,
  { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: fd }
);
```

**Side effect:** the variant transitions to `status: "active"`.

**Success `201`:**

```json
{
  "success": true,
  "data": {
    "variantId": "507f1f77bcf86cd799439020",
    "assetId": "507f1f77bcf86cd799439030",
    "filename": "js-course.pdf",
    "size": 12582912,
    "mimeType": "application/pdf"
  },
  "message": "Digital asset uploaded successfully"
}
```

**Errors:**

| Status | Code | Reason |
|--------|------|--------|
| 409 | `CATALOG_DIGITAL_ASSET_ALREADY_EXISTS` | Variant already has an asset — use `PUT` to replace. |
| 400 | `CATALOG_DIGITAL_ASSET_MISSING_FILE` | No `file` field in request. |
| 400 | `CATALOG_FILE_TOO_LARGE` | Exceeds 500 MB. |
| 400 | `CATALOG_FILE_TYPE_INVALID` | Declared `Content-Type` is not in the accepted set (first gate). |
| 400 | `UPLOAD_POLICY_VIOLATION` | The file's **detected** (magic-byte) type is not an accepted format (second gate). `details.violations` lists the reason. |
| 400 | `CATALOG_PRODUCT_INVALID_TYPE` | Product is not `type: "digital"`. |
| 404 | `CATALOG_PRODUCT_NOT_FOUND` / `CATALOG_VARIANT_NOT_FOUND` | Product or variant not found / mismatched. |

### 5.3 Replace a variant's digital asset

```http
PUT /api/vendor/products/:productId/variants/:variantId/digital/asset
Content-Type: multipart/form-data
```

Same `file` field and constraints as upload. Atomically swaps the file; the old asset is deleted after the new one is stored (deletion failure is logged, not fatal). The variant **stays `active`**. Existing customer entitlements and download counts are preserved; future downloads get the new file.

**Success `200`:** same shape as upload.

**Errors:**

| Status | Code | Reason |
|--------|------|--------|
| 404 | `CATALOG_DIGITAL_ASSET_MISSING` | Variant has no asset to replace — use `POST`. |
| 400 | `CATALOG_FILE_TOO_LARGE` / `CATALOG_FILE_TYPE_INVALID` | File validation failed. |

### 5.4 Remove a variant's digital asset

```http
DELETE /api/vendor/products/:productId/variants/:variantId/digital/asset
```

Unlinks the asset and soft-deletes the file. **Side effect: the variant becomes `status: "archived"`** (a digital variant cannot be active without an asset). Existing customer entitlements are not revoked.

**Success `200`:**

```json
{ "success": true, "message": "Digital asset removed successfully" }
```

**Errors:**

| Status | Code | Reason |
|--------|------|--------|
| 404 | `CATALOG_DIGITAL_ASSET_MISSING` | Variant has no asset to remove. |
| 400 | `CATALOG_PRODUCT_INVALID_TYPE` | Product is not `type: "digital"`. |

### 5.5 Update a variant's download limits

```http
PATCH /api/vendor/products/:productId/variants/:variantId/digital/config
Content-Type: application/json
```

```json
{
  "maxDownloads": 3,
  "expiresAfterDays": 90
}
```

| Field | Type | Notes |
|-------|------|-------|
| `maxDownloads` | number \| null | `>= 1`, or `null` for unlimited. |
| `expiresAfterDays` | number \| null | `>= 1`, or `null` for never. |

At least one field must be present. Does **not** touch the asset or the variant's status. Limits apply to **future** purchases — already-granted entitlements keep the values snapshotted at purchase time.

**Success `200`:**

```json
{ "success": true, "message": "Variant digital config updated" }
```

**Errors:**

| Status | Code | Reason |
|--------|------|--------|
| 400 | `VALIDATION_ERROR` | Empty body or invalid values. |
| 400 | `CATALOG_PRODUCT_INVALID_TYPE` | Product is not `type: "digital"`. |
| 404 | `CATALOG_VARIANT_NOT_FOUND` | Variant not found / mismatched. |

> You can also update these via the normal variant `PATCH /products/:productId/variants/:variantId` by sending a `digitalConfig: { maxDownloads, expiresAfterDays }` block. The dedicated `/digital/config` endpoint exists for convenience.

### 5.6 Product-wide download toggle

There is **no** dedicated toggle endpoint anymore. To pause/resume downloads across the whole product, update the product:

```http
PATCH /api/vendor/products/:id
Content-Type: application/json
```

```json
{ "digitalConfig": { "isActive": false } }
```

When `isActive` is `false`, purchases of any variant will **not** grant a download entitlement (the fulfillment step logs and skips). Set it back to `true` to resume.

---

## 6. Variant status state machine (digital)

```
                    upload asset (5.2)
   ┌─────────────┐ ──────────────────────▶ ┌──────────┐
   │  archived   │                          │  active  │
   │ (no asset)  │ ◀────────────────────── │(has asset)│
   └─────────────┘   remove asset (5.4)     └──────────┘
        ▲                                         │
        │            archive variant (DELETE variant)
        └─────────────────────────────────────────┘
```

- **Create** → `archived` (no asset).
- **Upload asset** → `active`.
- **Remove asset** → `archived`.
- **Replace asset** → stays `active`.
- **Archive the variant** (`DELETE /products/:productId/variants/:variantId`) → `archived` (manual soft-delete; default-variant reassignment rules from [variants.md](./variants.md) still apply).

> The frontend should treat "archived" digital variants as "incomplete / not yet for sale" and prompt the vendor to upload a file.

---

## 7. Activation rules (digital)

`PATCH /api/vendor/products/:id/status { "status": "active" }` enforces, in order:

| Check | Error code |
|-------|-----------|
| `description` is non-empty | `CATALOG_PRODUCT_NO_DESCRIPTION` |
| At least one active variant exists | `CATALOG_PRODUCT_NO_VARIANTS` |
| Every active variant has `price > 0` | `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` |
| `defaultVariantId` points to an active variant | `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` |
| No more than 5 active variants | `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` |
| Every active variant has an asset | `CATALOG_VARIANT_NO_DIGITAL_ASSET` (details: `{ variant: "<name or sku>" }`) |

> Because asset-less digital variants are forced to `archived`, the "every active variant has an asset" check will normally pass by construction. It's a defensive guard.

---

## 8. Limits & constraints

| Constraint | Value |
|------------|-------|
| Min variants to activate | 1 (must be active / asset-backed) |
| Max variants per digital product | 5 |
| Asset per variant | exactly 1 |
| Max asset file size | 500 MB |
| Option-based variants | ❌ not allowed for digital |
| Dimensions / delivery agency | ❌ not allowed for digital |

---

## 9. Error code reference (digital)

| Code | HTTP | Meaning |
|------|------|---------|
| `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | 400 / 422 | Attempt to exceed 5 variants (400 on create, 422 on activation). |
| `CATALOG_VARIANT_NO_DIGITAL_ASSET` | 422 | An active variant has no asset (blocks activation; also thrown at reservation). |
| `CATALOG_DIGITAL_ASSET_ALREADY_EXISTS` | 409 | Variant already has an asset — use `PUT`. |
| `CATALOG_DIGITAL_ASSET_MISSING` | 404 | Variant has no asset to replace/remove. |
| `CATALOG_DIGITAL_ASSET_MISSING_FILE` | 400 | No `file` field on a multipart upload. |
| `CATALOG_DIGITAL_ASSET_NOT_FOUND` | 404 | Asset id invalid / not found. |
| `CATALOG_DIGITAL_ASSET_ACCESS_DENIED` | 403 | Asset belongs to another vendor. |
| `CATALOG_FILE_TOO_LARGE` | 400 | File exceeds the size limit. |
| `CATALOG_FILE_TYPE_INVALID` | 400 | MIME type not allowed. |
| `CATALOG_PRODUCT_INVALID_TYPE` | 400 | Endpoint used on a non-digital product, or physical-only field on a digital variant. |
| `CATALOG_VARIANT_NOT_FOUND` | 404 | Variant not found or not under the given product. |

> `CATALOG_PRODUCT_DIGITAL_NO_ASSET` (the old product-level check) is no longer emitted. The per-variant `CATALOG_VARIANT_NO_DIGITAL_ASSET` replaces it.

---

## 10. Frontend UI guidance

A complete "Manage digital product" screen should provide:

**Product header**
- Title, description, SEO, cover images (standard product fields).
- A product-wide **"Downloads enabled"** switch bound to `digitalConfig.isActive` (PATCH the product). Show it prominently — when off, communicate "all formats are paused; purchases won't deliver files."

**Formats / variants list (the core)**
- Render the 1–5 variants. Use `displayName` for the row label.
- Per row show: `displayName`, price (+ `compareAtPrice` strikethrough if higher), status pill, and the asset summary (`digital.asset.originalName`, human size from `digital.asset.size`, format from `digital.asset.mimeType`).
- **Status pill:** `active` = "Live", `archived` (digital, no asset) = "Needs file". Use the presence of `digital.asset` to decide which CTA to show:
  - No asset → **"Upload file"** (calls 5.2).
  - Has asset → **"Replace file"** (5.3) and **"Remove file"** (5.4).
- Per row, an **edit limits** control for `maxDownloads` (number or "Unlimited") and `expiresAfterDays` (number or "Never") → calls 5.5.
- **"Add format" button:** disabled once 5 variants exist; tooltip "Maximum 5 formats". On click, open a form for sku/name/price (+ optional limits) → calls 5.1, then immediately prompt for the file upload.

**Validation / guardrails to mirror client-side**
- Block the "Add format" action at 5 variants (matches `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED`).
- File picker: enforce 500 MB and the allowed MIME list before upload to fail fast.
- Disable the **Publish** button (and show a checklist) until: description set, ≥1 variant has an uploaded file, every priced variant `> 0`, a default variant is set.

**Default variant**
- Show which variant is the default (`product.defaultVariantId`) and let the vendor reassign via `PATCH /products/:id/default-variant`. The default is the variant offered first / pre-selected on the storefront.

**Helpful UX copy**
- When a variant is `archived` because it has no file: "Upload a file to make this format available for sale."
- After removing a file (variant auto-archives): "This format is now hidden from buyers until you upload a new file."

**Suggested human-size helper (matches backend `displayName`):**

```javascript
function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const r = v >= 10 || u === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${r} ${units[u]}`;
}
```

---

## 11. Post-purchase (context for the storefront / library UI)

When a customer buys a digital variant and payment succeeds:

1. The backend grants a **per-variant entitlement** (`CustomerDigitalEntitlement`) carrying `productId`, `variantId`, `assetId`, and the variant's `maxDownloads`/`expiresAfterDays` **snapshotted at purchase time**.
2. The customer library should group by product and list the purchased format(s); each entitlement maps to one variant's file.
3. Download links are issued through the entitlement/download-link flow (not exposed in vendor product reads). Download counts and expiry are tracked per entitlement, so later changing a variant's limits or replacing its asset does not retroactively alter existing purchases.

> Entitlement summaries returned to customers now include `variantId` and `variantName` so the library can show e.g. "JavaScript Course Bundle — PDF Edition".

---

## See also

- [Variants API](./variants.md) — full variant object, create/update/archive, default-variant rules.
- [Products API](./products.md) — product CRUD, status changes, duplication.
- [Product Upload Flow](./product-upload-flow.md) — end-to-end create-to-publish for all product types.
