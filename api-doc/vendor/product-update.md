# Vendor Product Workflow Guide

Step-by-step API instruction sequences for creating Physical and Digital products. Intended for frontend developers implementing the Add/Edit Product UI.

> [!IMPORTANT]
> **The Universal Rule: Every product needs a variant**
>
> Regardless of type, **all products must have at least one variant** before they can be activated. The variant is where `price`, `stock`, and `SKU` live. You cannot activate a product without creating at least one variant with `price > 0`.
>
> **The backend automatically:**
> - Sets `product.defaultVariantId` when the first variant is created
> - Clears or reassigns `defaultVariantId` when the default variant is archived

---

## 1. Physical Product Workflow

**Use Case**: T-shirts, electronics, furniture — anything with inventory and shipping.

### Step 1: Create Draft Shell

```http
POST /api/vendor/products
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "type": "physical",
  "title": "Vintage Leather Jacket",
  "category": "Apparel",
  "description": "High quality full-grain leather jacket."
}
```

**Response:** `{ "id": "prod_abc123", "status": "draft", "hasVariants": false, ... }`

Save the `id` — all subsequent calls use it.

---

### Step 2: Update Product Details (Optional but Recommended)

Add description, SEO fields, and tags. Any subset of fields can be sent.

```http
PATCH /api/vendor/products/prod_abc123
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "description": "<p>Full-grain leather...</p>",
  "tags": ["leather", "jacket", "premium"],
  "seoTitle": "Buy Vintage Leather Jacket | Jovi Mall",
  "seoDescription": "Shop our premium vintage leather jacket."
}
```

---

### Step 3: Upload Product Images (Optional)

Upload files first via the global file endpoint, then link their IDs to the product.

**3a. Upload files:**

```http
POST /api/files/upload
Authorization: Bearer <vendor_jwt>
Content-Type: multipart/form-data

files: [image1.jpg, image2.jpg]
```

Response gives you an array of file objects. Save the `id` from each.

**3b. Link files to product:**

```http
PATCH /api/vendor/products/prod_abc123
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "fileIds": ["file_id_1", "file_id_2"]
}
```

> `fileIds` is a **full replacement**. Always send the complete array. To add an image, fetch the current `fileIds` first, append the new id, then send.

---

### Step 4: Create Product Options (for size/color variants)

Options define which attributes can vary (Size, Color, etc.). Skip this step for simple products with a single variant.

**4a. Create option:**

```http
POST /api/vendor/products/prod_abc123/options
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "name": "Size",
  "position": 1
}
```

Response: `{ "id": "opt_size_id", "name": "Size", ... }`

**4b. Add values to the option:**

```http
POST /api/vendor/products/prod_abc123/options/opt_size_id/values/bulk
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "values": ["Small", "Medium", "Large", "XL"]
}
```

Response: array of `{ "id": "val_s_id", "value": "Small" }` — save these IDs.

Repeat for each option dimension (e.g., Color → ["Black", "White", "Navy"]).

---

### Step 5: Create Variants

Create one variant per SKU combination. Send `optionValueIds` referencing the IDs from Step 4b.

**Single variant (no options):**

```http
POST /api/vendor/products/prod_abc123/variants
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "sku": "JACKET-LEATHER-ONE-SIZE",
  "price": 199.99,
  "compareAtPrice": 249.99,
  "stock": 25,
  "isInfiniteStock": false,
  "weight": 1500,
  "length": 60,
  "width": 40,
  "height": 5,
  "deliveryAgencyId": "507f1f77bcf86cd799439050"
}
```

**Variant with option values (one per combination):**

```http
POST /api/vendor/products/prod_abc123/variants
{
  "sku": "JACKET-BLK-M",
  "price": 199.99,
  "stock": 10,
  "isInfiniteStock": false,
  "weight": 1500,
  "length": 60,
  "width": 40,
  "height": 5,
  "optionValueIds": ["val_black_id", "val_medium_id"],
  "deliveryAgencyId": "507f1f77bcf86cd799439050"
}
```

> **After the first variant is created**, `product.defaultVariantId` is auto-set to its `id` and `product.hasVariants` becomes `true`. No action needed from the frontend.

**Repeat for each combination.** For 4 sizes × 3 colors = 12 variants, make 12 POST calls.

---

### Step 6: Configure Stock Alerts (Optional)

These fields cannot be set on creation — update via PATCH after the variant exists.

```http
PATCH /api/vendor/products/prod_abc123/variants/var_id
{
  "lowStockThreshold": 5,
  "allowOversell": false
}
```

- `lowStockThreshold`: Vendor alert when stock falls to this level. `null` = no alerts.
- `allowOversell`: If `true`, orders are accepted even when stock reaches 0 (backorder behavior).

---

### Step 7: Publish

```http
PATCH /api/vendor/products/prod_abc123/status
{
  "status": "active"
}
```

**Backend validates (all must be true):**
1. At least one active variant exists
2. Every active variant has `price > 0`
3. `defaultVariantId` points to an active variant

| Failure Code | Fix |
|---|---|
| `CATALOG_PRODUCT_NO_VARIANTS` | Create at least one variant first |
| `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | Update variant `price` to > 0 |
| `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` | Use `PATCH /products/:id/default-variant` to assign one |

---

## 2. Digital Product Workflow

**Use Case**: eBooks, software, music, design assets, videos, licenses.

> [!IMPORTANT]
> **Digital products are multi-variant.** A product holds **1–5 variants**, each a downloadable **format** (PDF, ZIP, EPUB, MP4, …) with its own asset, price, SKU, name, and download limits. The flow is: create each format variant, then upload its file (which makes that variant `active`). Full reference: **[Digital Products — Multi-Variant Guide](./digital-products.md)**.

### Step 1: Create Draft Shell

```http
POST /api/vendor/products
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "type": "digital",
  "title": "Ultimate Node.js Guide",
  "category": "Programming Books",
  "description": "Master Node.js in 30 days."
}
```

**Response:** `{ "id": "prod_xyz789", "status": "draft", "digitalConfig": undefined }`

---

### Step 2: Update Product Details (Optional)

```http
PATCH /api/vendor/products/prod_xyz789
{
  "description": "<p>Everything you need to master Node.js...</p>",
  "tags": ["nodejs", "javascript", "backend", "programming"],
  "seoTitle": "Ultimate Node.js Guide - eBook",
  "seoDescription": "Master Node.js in 30 days with this comprehensive guide."
}
```

> The product-level `digitalConfig` only accepts `{ isActive }` (a product-wide download toggle). Download **limits** are per variant — see Step 5.

---

### Step 3: Create Format Variant(s) (1–5)

Each variant is a downloadable format/tier. No dimensions, delivery agency, or `optionValueIds`. Optionally include `digitalConfig` for per-variant download limits.

```http
POST /api/vendor/products/prod_xyz789/variants
Authorization: Bearer <vendor_jwt>
Content-Type: application/json

{
  "sku": "NODEJS-GUIDE-PDF",
  "name": "PDF Edition",
  "price": 29.99,
  "isInfiniteStock": true,
  "stock": 0,
  "digitalConfig": { "maxDownloads": 5, "expiresAfterDays": 365 }
}
```

```http
POST /api/vendor/products/prod_xyz789/variants
{
  "sku": "NODEJS-GUIDE-ZIP",
  "name": "Source Code (ZIP)",
  "price": 49.99,
  "isInfiniteStock": true,
  "stock": 0
}
```

> - Each variant returns `status: "archived"` until its asset is uploaded (Step 4) — this is expected.
> - The first variant created auto-sets `product.defaultVariantId`. Reassign via `PATCH /products/prod_xyz789/default-variant { "variantId": "..." }`.
> - A 6th variant returns `400 CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED`.

---

### Step 4: Upload an Asset per Variant

The downloadable file for each format. **Uploading flips the variant to `status: "active"`.** The backend sets `variant.digital.asset` automatically.

```http
POST /api/vendor/products/prod_xyz789/variants/var_pdf_id/digital/asset
Authorization: Bearer <vendor_jwt>
Content-Type: multipart/form-data

file: [nodejs-guide.pdf]
```

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "variantId": "var_pdf_id",
    "assetId": "507f1f77bcf86cd799439013",
    "filename": "nodejs-guide.pdf",
    "size": 5242880,
    "mimeType": "application/pdf"
  },
  "message": "Digital asset uploaded successfully"
}
```

Repeat for each variant. **Accepted formats:** PDF, EPUB, ZIP, RAR, 7-Zip, MP4, MOV, MP3, WAV, JPEG, PNG, WebP, GIF. The real file type is detected from its content (not the filename/`Content-Type`); Office documents are not accepted — wrap them in a `.zip`. **Max size:** 500MB.

---

### Step 5: Configure Per-Variant Download Access (Optional)

Limits are **per variant** and apply to future purchases.

```http
PATCH /api/vendor/products/prod_xyz789/variants/var_pdf_id/digital/config
{
  "maxDownloads": 5,
  "expiresAfterDays": 365
}
```

| Field | Value | Behavior |
|-------|-------|----------|
| `maxDownloads` | `5` | Customer can download up to 5 times |
| `maxDownloads` | `null` | Unlimited downloads |
| `expiresAfterDays` | `365` | Access expires 365 days after purchase |
| `expiresAfterDays` | `null` | Access never expires |

---

### Step 6: Publish

```http
PATCH /api/vendor/products/prod_xyz789/status
{
  "status": "active"
}
```

**Backend validates (all must be true):**
1. At least one active variant exists with `price > 0`
2. `defaultVariantId` points to an active variant
3. Every active variant has an uploaded asset
4. No more than 5 active variants

| Failure Code | Fix |
|---|---|
| `CATALOG_PRODUCT_NO_VARIANTS` | Create at least one variant |
| `CATALOG_PRODUCT_VARIANT_ZERO_PRICE` | Update variant `price` to > 0 |
| `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` | Variant auto-set if you followed Step 3; or use `/default-variant` |
| `CATALOG_VARIANT_NO_DIGITAL_ASSET` | Upload a file for each format variant (Step 4) |
| `CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED` | Archive/remove variants beyond 5 |

---

## 3. Updates & Ongoing Management

### Updating Product Details

```http
PATCH /api/vendor/products/:id
{
  "title": "New Title",
  "description": "Updated description"
}
```

Allowed while `draft` or `active`. Not allowed on `archived` products.

### Updating a Variant

```http
PATCH /api/vendor/products/:productId/variants/:variantId
{
  "price": 34.99,
  "stock": 50,
  "lowStockThreshold": 10
}
```

### Reassigning the Default Variant

```http
PATCH /api/vendor/products/:id/default-variant
{
  "variantId": "507f1f77bcf86cd799439015"
}
```

The target variant must be active and belong to this product.

### Adding/Removing Product Images

Always send the **complete** `fileIds` array:

```http
PATCH /api/vendor/products/:id
{
  "fileIds": ["file_id_1", "file_id_2", "file_id_3"]
}
```

To remove image `file_id_2`: fetch current `fileIds`, exclude `file_id_2`, send the remaining array.

### Assigning Variant-Specific Images

```http
PATCH /api/vendor/products/:productId/variants/:variantId
{
  "fileIds": ["file_id_4"]
}
```

### Archiving a Product

```http
DELETE /api/vendor/products/:id
```

Soft delete — status becomes `archived`. Data is preserved. Can be restored by changing status back to `draft` or `active`.

### Replacing a Variant's Digital Asset

To release a v2.0 of one format:

```http
PUT /api/vendor/products/:productId/variants/:variantId/digital/asset
Content-Type: multipart/form-data

file: [nodejs-guide-v2.pdf]
```

Old file is deleted after the new one is stored. The variant stays `active`. All future customer downloads receive the new file; existing entitlements are preserved.

### Removing a Variant's Digital Asset

```http
DELETE /api/vendor/products/:productId/variants/:variantId/digital/asset
```

Clears the asset and **archives the variant** (digital variants cannot be active without a file).

### Temporarily Disabling Digital Downloads (Product-Wide)

There is no per-product toggle endpoint. Pause/resume all downloads via the product:

```http
PATCH /api/vendor/products/:id
{ "digitalConfig": { "isActive": false } }
```

While `isActive: false`, purchases of any variant do not grant download entitlements even if the product is `active`. Set back to `true` to resume.

---

## 4. Common Mistakes to Avoid

**❌ Sending `optionSignature` in the request body**
The `optionSignature` field is system-generated. Never send it — it is computed from `optionValueIds` automatically.

**❌ Sending physical-only fields for digital variants**
```json
// WRONG for type: "digital"
{ "sku": "...", "price": 29.99, "weight": 0, "length": 0 }
```
```json
// CORRECT
{ "sku": "...", "price": 29.99, "isInfiniteStock": true, "stock": 0 }
```

**❌ Treating `fileIds` as an append operation**
```javascript
// WRONG — loses previous files
updateProduct({ fileIds: [newFileId] });

// CORRECT — merge then send
const current = await getProduct(productId);
updateProduct({ fileIds: [...current.fileIds, newFileId] });
```

**❌ Setting a digital asset or limits on the product**
The product's `digitalConfig` only accepts `{ isActive }`. Assets and limits are **per variant** — upload via `POST /products/:productId/variants/:variantId/digital/asset` and set limits via `.../digital/config`. Sending `assetId`/`maxDownloads`/`expiresAfterDays` on the product returns `400 VALIDATION_ERROR`.

**❌ Publishing without pre-validation**
```javascript
// CORRECT — check before calling
const checks = [];
if (!product.hasVariants) checks.push('Create at least one variant');
if (product.type === 'digital') {
  const variants = await getVariants(productId);
  const activeWithAsset = variants.filter(v => v.status === 'active' && v.digital?.asset);
  if (activeWithAsset.length === 0) checks.push('Upload a file for at least one format variant');
}
if (checks.length > 0) { showErrors(checks); return; }
await changeStatus('active');
```
