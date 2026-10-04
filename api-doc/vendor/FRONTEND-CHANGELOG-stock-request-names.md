# Vendor app — stock requests now name what they change; inbox search

> **Date:** 2026-10-04 · **Audience:** the vendor dashboard (vendor-dash) · **Breaking:** no — every
> field and parameter below is **additive**; nothing was removed or renamed.
>
> Agency-side counterpart: [../agency/FRONTEND-CHANGELOG-agency-names-and-search.md](../agency/FRONTEND-CHANGELOG-agency-names-and-search.md)

Only `/api/vendor/stock-requests` changed for you. Storage statements, products and every other
vendor endpoint are untouched.

---

## New on every stock request

On **every** response — `GET /`, `GET /:id`, `POST /` (raise), `approve`, `reject`, `withdraw`.
`productId` / `variantId` / `vendorId` / `agencyId` are unchanged.

```ts
product: {
  title: string | null;          // the product's CURRENT title
  variantTitle: string | null;   // the variant's name
  sku: string | null;
  image: FileDetail | null;      // variant's first image, else the product's
}
vendor: { id: string; businessName: string | null; verified: boolean }   // yourself
location: { id: string; label: string | null; city: string | null; isPrimary: boolean } | null
stockLevelId: string | null
```

| Field | What to do with it |
|---|---|
| `product.*` | Show which SKU the request is about. Render `image.url` (it is `null` when `image.access` is not `"public"`) |
| `vendor` | It is **you**. You do not need to render it |
| `location` | The **agency's** depot holding this SKU — e.g. "held at Main depot, Douala". `null` when the agency has no inventory row for it, or deleted that depot |
| `stockLevelId` | The **agency's** inventory row id. **No vendor endpoint opens it — ignore it** |

- **Resolved live, not snapshotted.** Rename a product and every request — open or closed —
  shows the new title.
- A deleted product, variant or depot reads as `null`; the request itself still renders. Give
  every one of these fields a fallback.

## New list parameter: `search`

`GET /api/vendor/stock-requests?search=…` — string 1–100, trimmed. Case-insensitive **substring**
over the product title and the variant SKU, regex-escaped (`.*` matches those two characters). It
combines (AND) with `status`, `direction`, `productId` and `variantId`. Unknown parameters are still
`400 VALIDATION_ERROR`, as before.

## Example

`GET /api/vendor/stock-requests?direction=awaiting_me&search=tsh`

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
      "requestedByRole": "agency",
      "requestedAt": "2026-10-03T09:12:00.000Z",
      "quantityBefore": 60,
      "infiniteBefore": false,
      "requestedQuantity": 58,
      "requestedInfinite": false,
      "currentQuantity": 60,
      "currentInfinite": false,
      "status": "pending",
      "note": "Counted 58 on the shelf this morning",
      "awaitingMyDecision": true,
      "availableActions": ["approve", "reject"],
      "approval": null,
      "rejection": null,
      "withdrawal": null,
      "statusHistory": [
        { "status": "pending", "changedAt": "2026-10-03T09:12:00.000Z", "changedByRole": "agency", "note": "Counted 58 on the shelf this morning" }
      ],
      "createdAt": "2026-10-03T09:12:00.000Z",
      "updatedAt": "2026-10-03T09:12:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

Doc: [stock-requests.md](./stock-requests.md).
