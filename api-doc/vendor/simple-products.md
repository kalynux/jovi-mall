# Simple Products — Vendor API Reference

> **Document Purpose**: Frontend-consumable reference for the one-shot product editor.
>
> **Intended Audience**: Frontend engineers building the "quick add" product flow.
>
> **See also**: [product-upload-flow.md](./product-upload-flow.md) for the full multi-step (advanced) flow.

---

## Why this exists

Listing one pair of shoes through the standard flow takes **six calls**: create draft → patch details → upload files → link files → create variant → publish. That sequence earns its keep for a vendor building a Size × Color matrix. For a shop with one product at one price it is pure overhead, and it forces the UI to ask for options, variants, SKUs and pickup policy before anything can be saved.

Simple mode collapses that into **one call**, and marks the result `mode: "simple"` so both the UI and the backend know what shape it is.

It adds no capability the advanced endpoints lack. It removes choices.

---

## The `mode` field

Every product now carries `mode`:

| value | meaning |
|---|---|
| `"simple"` | Physical · exactly **one** variant · **zero** options. Created by `POST /products/simple`. |
| `"advanced"` | Everything else — the default, and what every pre-existing product reports. |

`mode` appears on the product detail response and on every row of `GET /api/vendor/products`, so the list view can route each row's Edit button to the right editor without a second fetch.

**The invariant is enforced, not advisory.** While a product is `simple`, these return **409 `CATALOG_PRODUCT_SIMPLE_MODE_LOCKED`**:

- `POST /products/:id/variants` — adding a second variant
- `POST /products/:productId/options` — adding options
- `DELETE /products/:productId/variants/:variantId` — archiving its only variant
- `PATCH /products/:productId/variants/:variantId/status` with `"archived"` — same
- `PATCH /products/:id/default-variant` — meaningless with one variant

Every one of those 409s carries the escape hatch in `details`:

```json
{
  "success": false,
  "error": {
    "code": "CATALOG_PRODUCT_SIMPLE_MODE_LOCKED",
    "statusCode": 409,
    "message": "This product uses the simple editor, so adding another variant is not available. Convert it to the advanced editor first.",
    "details": {
      "mode": "simple",
      "convertEndpoint": "POST /api/vendor/products/507f.../convert-to-advanced"
    }
  }
}
```

Render `details.convertEndpoint` as a one-click "Switch to the advanced editor" button.

Still allowed on a simple product: `PATCH /products/:id` (the standard product update), `PATCH /products/:productId/variants/:variantId` (the granular variant editor, used by the inventory module), `PATCH /products/:id/status`, and the bulk endpoints. None of those can break the invariant.

---

## `POST /api/vendor/products/simple`

Creates the product, its single variant and its delivery config in **one transaction**, then attempts to publish.

**Auth**: vendor JWT (cookie or `Authorization: Bearer`).

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | ✅ | 3–200 chars |
| `description` | string | ✅ | Non-empty. Required here (unlike the draft endpoint) because an empty description blocks publishing. |
| `category` | string | ✅ | Non-empty |
| `price` | number | ✅ | **> 0**. Zero is rejected outright — a zero-priced product can never be activated. |
| `stock` | integer | | ≥ 0, default `0` |
| `isInfiniteStock` | boolean | | default `false` |
| `compareAtPrice` | number | | "was" price; show struck through when > `price` |
| `sku` | string | | 1–100 chars. **Auto-generated when omitted** — see below. |
| `tags` | string[] | | unique, non-empty |
| `fileIds` | string[] | | Max 7. Upload first via `POST /api/files/upload`, send the returned ids. |
| `seoTitle` / `seoDescription` | string | | Max 60 / 160 |
| `weight` | number | | grams |
| `length` / `width` / `height` | number | | cm |
| `freeDelivery` | boolean | | default `false` |
| `pickupLocation` | object | | `{ source, vendorAddressId? }`. **Omit to auto-derive** — see below. |
| `publish` | boolean | | default `true`. `false` saves a draft outright. |

**Not accepted** (400 if sent): `type` (simple is physical-only), `mode`, `status`, `deliveryAgencyId`, `optionValueIds`, `digitalConfig`, `serviceConfig`. Each belongs to a capability this editor does not expose; accepting them silently would make `mode: "simple"` a lie.

### Example

```json
POST /api/vendor/products/simple
Content-Type: application/json

{
  "title": "Nike Air Max 90",
  "description": "Classic runner, everyday comfort.",
  "category": "footwear",
  "price": 45000,
  "stock": 12,
  "fileIds": ["6f1a2b3c4d5e6f7a8b9c0d1e"]
}
```

### Response — `201 Created`

**Always 201, even when it could not publish.** The product *was* created; publishing is a separate outcome reported in `meta.activation`.

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "mode": "simple",
    "type": "physical",
    "status": "active",
    "title": "Nike Air Max 90",
    "slug": "nike-air-max-90",
    "hasVariants": true,
    "defaultVariantId": "507f1f77bcf86cd799439020",
    "files": [{ "id": "6f1a...", "url": "https://...", "mimeType": "image/jpeg", "size": 245678 }],
    "delivery": {
      "agencyId": null,
      "freeDelivery": false,
      "pickupLocation": { "source": "vendor_address", "vendorAddressId": "68b2..." }
    },
    "defaultVariant": {
      "id": "507f1f77bcf86cd799439020",
      "sku": "NIKE-AIR-MAX-90-507F1F77BCF86CD799439011",
      "price": 45000,
      "stock": 12,
      "status": "active",
      "displayName": "Nike Air Max 90"
    }
  },
  "meta": {
    "activation": {
      "attempted": true,
      "published": true,
      "blockers": [],
      "pickupReason": "derived_single_address"
    }
  },
  "message": "Product created and published"
}
```

The single variant is nested at `data.defaultVariant` — no second fetch needed.

### When it cannot publish

A first-time vendor usually has no delivery agency configured. That does **not** fail the call:

```json
{
  "success": true,
  "data": { "id": "...", "mode": "simple", "status": "draft", "...": "..." },
  "meta": {
    "activation": {
      "attempted": true,
      "published": false,
      "blockers": [
        {
          "code": "CATALOG_PRODUCT_NO_DELIVERY_AGENCY",
          "message": "Set an active default delivery agency on your vendor profile to publish physical products"
        },
        {
          "code": "CATALOG_PRODUCT_NO_PICKUP_LOCATION",
          "message": "Choose where the delivery agency should collect this product from"
        }
      ],
      "pickupReason": "no_agency"
    }
  },
  "message": "Product saved as a draft. Resolve 2 issue(s) to publish."
}
```

**`blockers` is the complete checklist, not the first failure.** Render it as a to-do list. Each `message` is written for a vendor to read — display it directly.

Once the vendor fixes their setup, publish with either `PATCH /products/:id/status {"status":"active"}` or `PATCH /products/:id/simple {"publish": true}`.

---

## Auto-derived pickup location

Omit `pickupLocation` and the backend works it out from the vendor's profile and their delivery agency's policy. `meta.activation.pickupReason` says what happened:

| `pickupReason` | Outcome | What the UI should do |
|---|---|---|
| `derived_single_address` | Vendor's one business address | nothing |
| `derived_agency_storage` | Agency warehouses the stock | nothing |
| `explicit` | Caller supplied it | nothing |
| **`multiple_addresses`** | **Nothing persisted — draft** | **Show an address picker.** The vendor has several business addresses and none is flagged default; guessing could send a courier to the wrong city, so the backend declines. Re-send with an explicit `pickupLocation`. |
| `no_agency` | Nothing persisted — draft | Send them to delivery settings |
| `agency_inactive` | Nothing persisted — draft | Their agency is not active |
| `no_business_address` | Nothing persisted — draft | Agency does pickup only; add a business address |
| `agency_offers_neither` | Nothing persisted — draft | Agency supports neither model |
| `resolution_failed` | Nothing persisted — draft | Transient; retry the publish |

**A `pickupLocation` you send explicitly is validated and can 422** (`CATALOG_PRODUCT_INVALID_PICKUP_LOCATION`) — you asked for something specific and got it wrong. Auto-derivation never fails the call; it just declines.

---

## Auto-generated SKU

Omit `sku` and you get `<TITLE-PREFIX>-<PRODUCT-ID>`, e.g. `NIKE-AIR-MAX-90-507F1F77BCF86CD799439011`.

SKUs are unique **across every vendor on the platform**, so embedding the product's own id is what makes generation collision-free without a retry. A vendor-supplied SKU that is already taken returns **409 `CATALOG_VARIANT_SKU_EXISTS`**.

Do not regenerate an SKU — orders and the storefront reference it.

---

## `PATCH /api/vendor/products/:id/simple`

One flat body edits both the product and its variant. Every field optional; at least one required.

**409 `CATALOG_PRODUCT_NOT_SIMPLE_MODE`** on an advanced product — use `PATCH /products/:id` plus the variant endpoints for those.

| → Product | → its single variant |
|---|---|
| `title`, `description`, `category`, `tags`, `fileIds`, `seoTitle`, `seoDescription`, `freeDelivery`, `pickupLocation` | `price`, `compareAtPrice`, `stock`, `isInfiniteStock`, `lowStockThreshold`, `allowOversell`, `sku`, `weight`, `length`, `width`, `height` |

```json
PATCH /api/vendor/products/507f1f77bcf86cd799439011/simple
{ "price": 39000, "stock": 8 }
```

Response shape is identical to create (`data` + `meta.activation`), status `200`.

### `publish` semantics on edit

| `publish` | Behaviour |
|---|---|
| **omitted** | Status untouched. If the edit broke the active-state invariant the product is demoted to `draft` **and `blockers` explains why**. |
| `true` | If `draft`, attempt to publish; if already `active`, no-op. |
| `false` | Never publishes. To unpublish, use `PATCH /products/:id/status {"status":"draft"}`. |

Omitting it is deliberate: a vendor who unpublished on purpose should not be silently republished by a price correction.

> `fileIds` is a **full replacement**, same as `PATCH /products/:id`. Read the current `files[]`, map to ids, append, send the whole array.

---

## `POST /api/vendor/products/:id/convert-to-advanced`

Unlocks the full variant/option API.

```json
POST /api/vendor/products/507f1f77bcf86cd799439011/convert-to-advanced
→ 200 { "success": true, "data": { "mode": "advanced", ... } }
```

- **Flips `mode` and nothing else.** No data migration, no repair. The existing variant is already a valid advanced variant.
- **Idempotent** — already-advanced returns `200` with `"Product already uses the advanced editor"`.
- **One-way.** There is no `convert-to-simple`: a product with twelve variants cannot collapse into one, and choosing which survives is not the backend's call.

After converting, `PATCH /:id/simple` returns `409 CATALOG_PRODUCT_NOT_SIMPLE_MODE`.

---

## Duplicating

`POST /products/:id/duplicate` on a simple product produces another **simple** product, variant included, with a freshly generated SKU. (Advanced products still duplicate without variants — the vendor recreates them.)

---

## Error reference

| Status | Code | Cause |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod failure — see `details.fields[]` |
| 400 | `CATALOG_IMAGE_LIMIT_EXCEEDED` | More than 7 `fileIds` |
| 403 | `CATALOG_PRODUCT_ACCESS_DENIED` | A `fileId` belongs to another vendor. **Nothing is created** — the whole transaction rolls back. |
| 403 | `BILLING_LIMIT_EXCEEDED` | Plan's active-product cap reached |
| 404 | `CATALOG_PRODUCT_NOT_FOUND` | Not yours, or does not exist |
| 409 | `CATALOG_VARIANT_SKU_EXISTS` | Supplied SKU already taken (globally) |
| 409 | `CATALOG_PRODUCT_SIMPLE_MODE_LOCKED` | Advanced operation on a simple product |
| 409 | `CATALOG_PRODUCT_NOT_SIMPLE_MODE` | Simple endpoint on an advanced product |
| 409 | `CATALOG_PRODUCT_VECTORISATION_PENDING` | Product is mid-vectorisation |
| 422 | `CATALOG_PRODUCT_INVALID_PICKUP_LOCATION` | Explicit pickup location incompatible with the agency |
| 422 | `CATALOG_PRODUCT_NO_DEFAULT_VARIANT` | Simple product lost its variant (should be unreachable — the guards prevent it) |

---

## Recommended UI

```
┌─ Quick add ───────────────────────────────┐
│ Photos        [ drag & drop, max 7 ]      │
│ Name          [___________________]        │
│ Description   [___________________]        │
│ Category      [ dropdown ▾ ]               │
│ Price         [_______]  Stock [____]      │
│                                            │
│              [ Save draft ]  [ Publish ]   │
└────────────────────────────────────────────┘
```

`Publish` → `publish: true`; `Save draft` → `publish: false`. On a `201` with `published: false`, show the `blockers` list inline with a link to delivery settings, and keep the product visible in the list as a draft — it exists and is not lost.

---

*Last updated: 2026-07-28*
