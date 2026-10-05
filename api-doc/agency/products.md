# Agency Products

**Verified against source on 2026-09-08** — `GET /api/agency/products` and the error catalogue, against `jovi-mall/src/modules/delivery/agency.routes.ts` and `src/core/error-codes.ts`.
**Updated 2026-10-04** — each row carries a `vendor` block; `search`, `source`, `status`, `categoryId`, `vendorId`, `sortBy`, `sortDir`; `meta.totalPages`. Additive; see [FRONTEND-CHANGELOG-agency-names-and-search.md](./FRONTEND-CHANGELOG-agency-names-and-search.md).
**Updated 2026-10-05** — each row carries `images`, `imageCount`, `pickup` and `agencyStock`. Additive; see [the field tables below](#images-imagecount-added-2026-10-05).

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

---

### GET /api/agency/products

**Description**: Physical products this agency is set up to deliver once ordered. Combined view —
a product appears here if **either**:
1. its own `delivery.agencyId` override points at this agency (`source: "own_override"`), **or**
2. it has no override and belongs to a vendor whose `default_delivery_agency_id` is this agency
   (`source: "vendor_default"`).

Read-only — an agency cannot change either relationship; both are configured on the vendor side
(product edit form / `PUT /api/vendor/profile/default-delivery-agency`).

**Request Headers**:
```http
Authorization: Bearer <token>
```

**Query Parameters** (all optional):

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer 1–100 | `20` | |
| `search` | string, 1–100, trimmed | — | Case-insensitive **substring** (not prefix-only) match over the product **title**, any variant **SKU**, the vendor's **store name** or **display name**, and any **category name**. Regex-escaped — `.*` matches those two characters literally. *Added 2026-10-04* |
| `source` | `own_override` \| `vendor_default` | both | `own_override` = the product's own `delivery.agencyId` is you. `vendor_default` = the vendor defaults to you **and** the product has no override — a product its vendor pointed at another agency never appears, under either value. *Added 2026-10-04* |
| `status` | `draft` \| `active` \| `archived` \| `pending_review` \| `suspended` | — | *Added 2026-10-04* |
| `categoryId` | ObjectId | — | Matches a product holding this category among any of its 1–5. *Added 2026-10-04* |
| `vendorId` | ObjectId | — | *Added 2026-10-04* |
| `sortBy` | `createdAt` \| `title` | `createdAt` | Ties broken by id, so paging is stable. *Added 2026-10-04* |
| `sortDir` | `asc` \| `desc` | `desc` | *Added 2026-10-04* |

All filters combine with AND. **Unknown query parameters are rejected** with
`400 VALIDATION_ERROR` (*since 2026-10-04* — they used to be silently ignored, the one
agency list that did).

`meta.total` counts the **filtered** set.

**Success Response** (`200 OK`):
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
      "title": "T-Shirt",
      "status": "active",
      "categories": [{ "id": "66ff0c1e2a4b5c6d7e8f9a11", "name": "Apparel", "slug": "apparel" }],
      "category": "Apparel",            // ⚠ deprecated — categories[0].name (2026-10-04)
      "source": "own_override",
      "images": [
        { "id": "66ff0c1e2a4b5c6d7e8f9c01", "key": "images/2026/09/tshirt-front.jpg", "url": "https://cdn.wi-mall.com/images/2026/09/tshirt-front.jpg", "access": "public", "mimeType": "image/jpeg", "size": 84211, "originalName": "tshirt-front.jpg" }
      ],
      "imageCount": 6,
      "pickup": {
        "source": "agency_storage",
        "label": "Akwa depot",
        "city": "Douala",
        "state": "Littoral",
        "depotId": "66ff0c1e2a4b5c6d7e8f9d01"
      },
      "agencyStock": {
        "depots": [
          { "id": "66ff0c1e2a4b5c6d7e8f9d01", "label": "Akwa depot", "city": "Douala", "quantityOnHand": 12, "counted": true },
          { "id": "66ff0c1e2a4b5c6d7e8f9d02", "label": "Bonaberi", "city": "Douala", "quantityOnHand": 0, "counted": false }
        ],
        "totalOnHand": 12,
        "counted": true
      }
    },
    {
      "id": "507f1f77bcf86cd799439067",
      "vendorId": "507f1f77bcf86cd799439aaa",
      "vendor": { "id": "507f1f77bcf86cd799439aaa", "businessName": "Alpha Textiles", "displayName": "Jeanne M.", "logo": { "…": "same FileDetail" }, "verified": true },
      "title": "Sneakers",
      "status": "active",
      "categories": [{ "id": "66ff0c1e2a4b5c6d7e8f9a12", "name": "Footwear", "slug": "footwear" }],
      "category": "Footwear",
      "source": "vendor_default",
      "images": [],
      "imageCount": 0,
      "pickup": { "source": "vendor_address", "label": "Main shop", "city": "Yaoundé", "state": "Centre", "depotId": null },
      "agencyStock": null
    }
  ],
  "meta": { "total": 2, "page": 1, "limit": 20, "pages": 1, "totalPages": 1 }
}
```

**`vendor`** (*added 2026-10-04*; `vendorId` stays):

| Field | Type | Notes |
|---|---|---|
| `id` | string | Always equals `vendorId` |
| `businessName` | string | The vendor's **store** name; `''` when they have no store yet — the same rule as [`GET /agency/vendors`](vendors.md) |
| `displayName` | string \| null | The vendor's personal display name |
| `logo` | `FileDetail` \| null | The store logo, as the platform's standard file object. Render `logo.url` — a public CDN URL, never a raw storage key. ⚠ Not a `logoUrl` string: every file on the platform comes back as a `FileDetail` |
| `verified` | boolean | `kyc_details.legit_verified` — the same badge the inventory rows show |

#### `images`, `imageCount` (*added 2026-10-05*)

| Field | Type | Notes |
|---|---|---|
| `images` | `FileDetail[]` | The **product-level** gallery in the vendor's order, at most **4**. Renderable images only — videos, documents and quota-blocked files are skipped (the same `isRenderableImage` rule as every gallery). `[0]` is the thumbnail. Variant-only media is not included |
| `imageCount` | number | How many renderable images the product has in total — `images` may be shorter. A list shows a stack and a `+N` chip from the difference |

#### `pickup` (*added 2026-10-05*)

`null` when the product has no pickup location configured yet.

| Field | Type | Notes |
|---|---|---|
| `source` | `vendor_address` \| `agency_storage` | Picked up at one of the vendor's business addresses, or at one of **your** depots (every product on this list is delivered by you, so the depot is always yours) |
| `label` | string \| null | Address / depot label |
| `city` | string \| null | |
| `state` | string \| null | Region for a depot |
| `depotId` | string \| null | `agency_storage` only — the depot actually resolved. A product naming no depot, or a depot you have since deleted, resolves to your **primary** depot (`headquarters_addresses[0]`). Always `null` for `vendor_address` |

A `vendor_address` whose id no longer exists falls back only when the vendor has exactly **one**
address; with several there is no primary to guess, and `label`/`city`/`state` come back `null`.

#### `agencyStock` (*added 2026-10-05*)

Your own stock of the product, from `agency_stock_levels` (the rows behind
[`GET /agency/inventory`](inventory.md)), rolled up from variant to **product × depot**.
`null` when you hold no row for it.

| Field | Type | Notes |
|---|---|---|
| `depots[]` | array | One entry per depot holding a row, in your depot order (primary first), unassigned last |
| `depots[].id` | string \| null | `null` = the row's depot was deleted — "unassigned", as on the inventory list |
| `depots[].label` / `.city` | string \| null | |
| `depots[].quantityOnHand` | number | Sum of **counted** on-hand over the product's variants at that depot. Always `0` when `counted` is `false` |
| `depots[].counted` | boolean | ⚠ `false` = every row here is `source: "derived"`: the product is **configured** to be stored here and nobody has counted it. That is **not** "we hold none" — render it as "not counted yet", never as `0` |
| `totalOnHand` | number | Sum of counted on-hand over all depots |
| `counted` | boolean | `true` when at least one depot carries a counted figure |

**Cost**: all four fields are batch-resolved for the page — a fixed number of extra queries
(files, your depots, the vendors' addresses, your stock rows), not one per row.

**`meta.totalPages`** (*added 2026-10-04*) is the same value as `meta.pages`. Every other
agency list says `totalPages`; read that one. `pages` is kept so nothing breaks.

> See [agency/vendors.md](vendors.md) for the vendor-level "who set me as default" view.

**Error Responses**:

| Status | Code | Reason |
|---|---|---|
| `400` | `VALIDATION_ERROR` | An unknown query parameter, or a known one out of range. `details.fields[]` names it |
| `401` | `AUTH_MISSING_TOKEN` · `AUTH_TOKEN_EXPIRED` · `AUTH_TOKEN_INVALID` | No token, an expired one, or a malformed one. ⚠ **There is no bare `UNAUTHORIZED` code** |
| `403` | `AUTH_ROLE_NOT_FOUND` | Authenticated user is not an agency. ⚠ **There is no bare `FORBIDDEN` code** |
| `500` | `INTERNAL_SERVER_ERROR` | Unexpected server error. ⚠ **Not `INTERNAL_ERROR`** |
