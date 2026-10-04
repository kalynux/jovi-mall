# Agency app — products, stock requests and statements now name things; product search

> **Date:** 2026-10-04 · **Audience:** the agency dashboard (agency-dash) · **Breaking:** no — every
> field and parameter below is **additive**, and nothing was removed or renamed. One behaviour
> tightened: `GET /api/agency/products` now **rejects unknown query parameters** with
> `400 VALIDATION_ERROR`, as every other agency list already did (see § 1).

Four asks, four answers:

| # | Endpoint | What you can drop on your side |
|---|---|---|
| 1 | `GET /api/agency/products` | the 10-page preload, the `/agency/vendors` + `/vendor-connections/browse` crawl, and "Vendor ab12" |
| 2 | `GET /api/agency/stock-requests[/:id]` | approving "60 → 90" without knowing which product |
| 3 | `GET /api/agency/storage-invoices[/:id]` | two statements for one month that look identical |
| 4 | `GET /api/agency/inventory/summary` | subtracting to get "not counted", and a second source for the badge |

---

## 1. `GET /api/agency/products` — vendor identity, search, filters

### New on every row: `vendor`

`vendorId` stays.

```ts
vendor: {
  id: string;                  // === vendorId
  businessName: string;        // store name; '' when the vendor has no store (same rule as GET /agency/vendors)
  displayName: string | null;
  logo: FileDetail | null;     // ⚠ see below
  verified: boolean;           // kyc legit_verified — the inventory rows' badge
}
```

⚠ **`logo`, not `logoUrl`.** The ask was for a `logoUrl` string. Every file on this platform —
avatars, store logos, product images — comes back as the same `FileDetail` object, and the
`logoUrl` fields that once existed were removed on purpose so there is one shape to handle.
Read **`vendor.logo?.url`**: it is the public CDN URL, never a raw storage key. (It is `null`
only when `logo.access` is not `"public"`, which a store logo never is in practice.)

Resolved in a fixed number of batched queries per page — no per-row lookups.

### New query parameters

| Param | Type | Notes |
|---|---|---|
| `search` | string 1–100, trimmed | Case-insensitive **substring** — *not* prefix-only — over product title, any variant SKU, vendor store name, vendor display name, and category name. Regex-escaped |
| `source` | `own_override` \| `vendor_default` | Same meaning as the row's `source`. A product its vendor overrode to **another** agency never appears, under either value |
| `status` | product status enum | `draft` · `active` · `archived` · `pending_review` · `suspended` |
| `categoryId` | ObjectId | Any of the product's 1–5 categories |
| `vendorId` | ObjectId | |
| `sortBy` | `createdAt` \| `title` | default `createdAt`; ties broken by id so pages never swap |
| `sortDir` | `asc` \| `desc` | default `desc` |

All combine with AND. `meta.total` counts the filtered set.

**Search scale.** No new index: an unanchored case-insensitive match cannot use one, so the
SKU arm runs against *your* deliverable products only (never the whole marketplace's
variants), and the title arm runs inside the same agency-scoped query. Fine at hundreds to
low thousands of products per agency.

### `meta.totalPages`

Added, same value as `meta.pages`. Read `totalPages` like every other agency list; `pages`
stays.

### ⚠ Unknown parameters are now a 400

Before today this endpoint ignored anything it did not recognise — the only agency list that
did. It is now `.strict()` like `/agency/inventory`: an unknown or misspelt parameter is
`400 VALIDATION_ERROR` with `details.fields[]` naming it. If the dashboard currently sends any
parameter other than `page`/`limit` here, remove it or rename it to one of the above.

### Example

`GET /api/agency/products?search=alpha&source=vendor_default&sortBy=title&sortDir=asc&limit=2`

```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439066",
      "vendorId": "507f1f77bcf86cd799439aaa",
      "vendor": {
        "id": "507f1f77bcf86cd799439aaa",
        "businessName": "Alpha Textiles",
        "displayName": "Jeanne M.",
        "logo": {
          "id": "66ff0c1e2a4b5c6d7e8f9b01",
          "key": "images/2026/09/alpha-logo.png",
          "url": "https://cdn.wi-mall.com/images/2026/09/alpha-logo.png",
          "access": "public",
          "mimeType": "image/png",
          "size": 18234,
          "originalName": "alpha-logo.png"
        },
        "verified": true
      },
      "title": "Sneakers",
      "status": "active",
      "categories": [{ "id": "66ff0c1e2a4b5c6d7e8f9a12", "name": "Footwear", "slug": "footwear" }],
      "category": "Footwear",
      "source": "vendor_default"
    }
  ],
  "meta": { "total": 3, "page": 1, "limit": 2, "pages": 2, "totalPages": 2 }
}
```

Doc: [products.md](./products.md).

---

## 2. Stock requests — name what is being changed

On **every** response — list, detail, raise, approve, reject, withdraw. `productId` /
`variantId` / `vendorId` are unchanged.

```ts
product: {
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  image: FileDetail | null;    // variant's first image, else the product's
}
vendor: { id: string; businessName: string | null; verified: boolean }
location: { id: string; label: string | null; city: string | null; isPrimary: boolean } | null
stockLevelId: string | null    // → GET /api/agency/inventory/:id
```

- **Live, not snapshotted** — a renamed product shows its new name on old requests too.
  Anything deleted reads as `null`; the request still renders.
- `stockLevelId` / `location`: a SKU moved between depots has one inventory row per depot;
  you get the row at a known depot, oldest first. `null` if you hold no row for it.
- The vendor's mirror carries the same fields (one shared shape).

New list parameter: **`search`** (1–100, trimmed) — case-insensitive substring over product
title and SKU, AND-ed with `status` / `direction` / the id filters.

### Example

`GET /api/agency/stock-requests?direction=awaiting_me&search=tsh`

```json
{
  "success": true,
  "data": [
    {
      "id": "665a1f77bcf86cd799439061",
      "productId": "664c1f77bcf86cd799439031",
      "variantId": "664d1f77bcf86cd799439041",
      "vendorId": "664b1f77bcf86cd799439021",
      "agencyId": "664a1f77bcf86cd799439051",
      "product": {
        "title": "Cotton T-Shirt",
        "variantTitle": "Red / M",
        "sku": "TSH-RED-M",
        "image": {
          "id": "664e1f77bcf86cd799439071",
          "key": "images/2026/08/tshirt-red.webp",
          "url": "https://cdn.wi-mall.com/images/2026/08/tshirt-red.webp",
          "access": "public",
          "mimeType": "image/webp",
          "size": 48213,
          "originalName": "tshirt-red.webp"
        }
      },
      "vendor": { "id": "664b1f77bcf86cd799439021", "businessName": "Alpha Textiles", "verified": true },
      "location": { "id": "664f1f77bcf86cd799439081", "label": "Main depot", "city": "Douala", "isPrimary": true },
      "stockLevelId": "66501f77bcf86cd799439091",
      "requestedByRole": "vendor",
      "requestedAt": "2026-10-03T09:12:00.000Z",
      "quantityBefore": 60,
      "infiniteBefore": false,
      "requestedQuantity": 90,
      "requestedInfinite": false,
      "currentQuantity": 60,
      "currentInfinite": false,
      "status": "pending",
      "note": "Restocked from the new shipment",
      "awaitingMyDecision": true,
      "availableActions": ["approve", "reject"],
      "approval": null,
      "rejection": null,
      "withdrawal": null,
      "statusHistory": [
        { "status": "pending", "changedAt": "2026-10-03T09:12:00.000Z", "changedByRole": "vendor", "note": "Restocked from the new shipment" }
      ],
      "createdAt": "2026-10-03T09:12:00.000Z",
      "updatedAt": "2026-10-03T09:12:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

Doc: [stock-requests.md](./stock-requests.md#what-the-request-is-about-added-2026-10-04).

---

## 3. Storage statements — name the vendor

On the agency list, detail, `settle` and `void` responses. `vendorId` stays.

```ts
vendor: { id: string; businessName: string | null; displayName: string | null; verified: boolean }
```

⚠ **Resolved live, NOT frozen at issue.** Everything else on a statement is fixed when it is
issued; the vendor's name is not. A vendor who renames their store shows the **new** name on
every past statement. The amounts, SKU labels and depot names do not change.

The vendor's own `/api/vendor/storage-invoices` is unchanged.

### Example

`GET /api/agency/storage-invoices?periodKey=2026-09`

```json
{
  "success": true,
  "data": [
    {
      "id": "6660a1f77bcf86cd79943901",
      "agencyId": "664a1f77bcf86cd799439051",
      "vendorId": "664b1f77bcf86cd799439021",
      "vendor": { "id": "664b1f77bcf86cd799439021", "businessName": "Alpha Textiles", "displayName": "Jeanne M.", "verified": true },
      "periodKey": "2026-09",
      "periodStart": "2026-09-01T00:00:00.000Z",
      "periodEnd": "2026-10-01T00:00:00.000Z",
      "skuCount": 14,
      "unitCount": 412,
      "monthlyRatePerSku": 500,
      "total": 206000,
      "status": "open",
      "issuedAt": "2026-10-01T02:00:04.117Z",
      "settledAt": null,
      "note": null
    }
  ],
  "meta": { "total": 2, "page": 1, "limit": 20, "totalPages": 1 }
}
```

Doc: [storage-invoices.md](./storage-invoices.md#vendor-added-2026-10-04).

---

## 4. Inventory summary — two counts, and what the estimate means

`GET /api/agency/inventory/summary` (same filters as the list):

| Field | Status | Meaning |
|---|---|---|
| `countedRows` | **already returned** since 2026-09-27, now documented | rows somebody has counted |
| `derivedRows` | already returned, now documented | rows never counted |
| `uncountedRows` | **new** | same number as `derivedRows` — for the "Not counted yet" tile, no subtraction |
| `awaitingMyDecisionCount` | **new** | pending stock requests the **vendor** raised on rows in the filtered set — drive the header and the sidebar badge from this one number |

Add the four to your `InventorySummary` type.

**What `totalMonthlyEstimate` and each row's `storageFee.monthlyEstimate` are:** your rate ×
the **counted** `quantityOnHand` (clamped at 0) — exactly the arithmetic the monthly
statement bills, and `0` for an uncounted row or when storage is not offered. You can drop
the "not billed / not tracked" wording. Keep one distinction: the estimate is **live**, the
statement freezes the shelf as it stood when issued (the 1st, 02:00 UTC). "Billed monthly on
this basis" is accurate; "due" is not — the statement is the record. No money moves on
either.

The [inventory § 1 example](./inventory.md#1-list-inventory) was also wrong and is fixed: it
showed an **uncounted** row quoting `quantity: 120` / `monthlyEstimate: 60000`. An uncounted
row quotes `0` with `quantityBasis: "uncounted"`. If the dashboard was built from that
example, check it reads `storageFee.quantityBasis`.

### Example

`GET /api/agency/inventory/summary`

```json
{
  "success": true,
  "countsAreDerived": false,
  "data": {
    "skuCount": 137,
    "unassignedCount": 1,
    "suspendedCount": 3,
    "totalMonthlyEstimate": 412000,
    "countedRows": 52,
    "derivedRows": 85,
    "uncountedRows": 85,
    "awaitingMyDecisionCount": 2
  }
}
```

Doc: [inventory.md § 2](./inventory.md#2-summary).
