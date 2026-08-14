# Public catalog (no auth)

**No authentication.** These endpoints are readable by a logged-out visitor, and they exist
for the storefront: it browses, searches and opens products, so it needs to *read* the
catalogue rather than render a mock.

Everything here is a product a vendor has deliberately put on sale, or a store that sells
one. Nothing owner-scoped is reachable; see [the rule for this prefix](./README.md).

## Base path

```
/api/public
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public/products` | Browse, search, filter, sort — and the sitemap's product feed |
| GET | `/api/public/stores/:storeSlug/products/:productSlug` | **The canonical product page** |
| GET | `/api/public/products/:productId` | The same product, by id — for deep links |
| GET | `/api/public/categories` | Category chips, with counts |
| GET | `/api/public/stores` | Store directory + the sitemap's store feed |
| GET | `/api/public/stores/:slug` | One store |
| GET | `/api/public/stores/:slug/products` | One store's grid |

All use the standard [response envelope](../README.md#the-response-envelope-read-this-first)
and send `Cache-Control: public, max-age=300`.

> **Why the 5-minute cache.** It is the window in which a newly published product, a price
> change, or a vendor going on holiday is invisible to the storefront. Your own revalidation
> adds to it — so this is *not* instant and must not be described to a vendor as instant. It
> is the trade for not putting an unauthenticated endpoint straight onto Mongo on every page
> view.

---

## The four model decisions, as built

Read these before the endpoints; each one answers a question the shapes below will raise.

### 1. Products are nested under their store, and that is the canonical URL

`Product.slug` is unique **per vendor** (`{ vendorId: 1, slug: 1 }`), not globally — two
vendors may both own `blue-shirt`. So there is no such thing as `/products/:slug`, and the
addressable form is:

```
/api/public/stores/maison-bella/products/blue-shirt
```

Emit that from every internal link, the sitemap and the JSON-LD `url`.
`GET /api/public/products/:productId` (an ObjectId) exists so a link held in an order, an
email or a share sheet resolves without the client having to know the store slug — it is a
fallback, not an alternative.

*(This is BACKEND-SHOP-REQUIREMENTS §2.6 Option B. No slug migration was run, and product
slugs remain per-vendor unique.)*

### 2. What is visible is one predicate, and `active` already guarantees a great deal

A product is public when it is `status: "active"`, not soft-deleted, not suspended, **and**
its vendor is not suspended. Nothing else appears — anywhere, on any of these endpoints.

`active` carries more weight than it looks: a product cannot reach it without a non-empty
description, at least one variant, `price > 0` on every active variant, a resolvable active
default variant, a vendor in good standing, and — for physical products — a live delivery
agency, an approved vendor↔agency connection and a valid pickup location. So a row you
receive here is one the platform believes is genuinely sellable.

> **A store's vendor is checked as "not suspended", not "is active".** A vendor who never
> verified their email sits at `pending_verification`, and their products are legitimately
> `active`. Gating on `active` would have hidden their store while their products stayed in
> the grid.

### 3. `inStock` is a boolean, and there is no count

Availability is `stock − units held by in-flight checkouts`. That number is real, but it is
**not published**: a precise count on a 5-minute-cached page is a promise that is wrong the
moment it is read. Ask for `?inStock=true` to narrow; render "in stock" / "out of stock",
never "3 left".

### 4. A closed store still sells — the flag is yours to render

`store.isOpen: false` is a vendor's vacation mode. It does **not** suspend their products,
and they are still listed and still resolve, because hiding them would break every live link
and sitemap entry for the duration of a holiday. Render the flag (and disable add-to-cart if
you like) — the backend does not block the cart on it.

---

## GET /api/public/products

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string ≤ 200 | — | Full-text over title, tags and description. See the note below. |
| `category` | string | — | Exact match on the free-text `category` field |
| `type` | `physical` \| `digital` \| `service` | — | Repeatable (`?type=a&type=b`) **or** comma-separated |
| `storeSlug` | string | — | Narrow to one store |
| `minPrice` / `maxPrice` | integer | — | Whole units. `minPrice > maxPrice` is a `400`, not an empty page |
| `inStock` | `"true"` | — | Only `true` narrows; `false` means "don't filter" |
| `sort` | enum | `newest` | `newest` \| `price_asc` \| `price_desc` \| `relevance` |
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer 1–100 | `20` | |

> **`q` is a MongoDB `$text` search, not a substring match.** It matches whole words:
> searching `dres` will **not** find "dress". This is the first text index in the platform,
> and it exists because the alternative — an unanchored `$regex` — cannot use an index (a
> collection scan on an unauthenticated endpoint) and carries no relevance score, which
> would leave `sort=relevance` with nothing to rank by. Stemming is disabled, because one
> stemmer would be wrong for four of the five locales vendors write in.

> **There is no `sort=popularity`.** Nothing tracks sales — `Product.lastOrderedAt` exists
> and is read by nobody — so the option would be a lie or a silent alias. It is refused with
> a `400` rather than accepted and ignored.

### Success — `200 OK`

```jsonc
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439066",
      "slug": "ankara-wax-print-maxi-dress",
      "title": "Ankara Wax Print Maxi Dress",
      "type": "physical",
      "category": "Fashion",
      "tags": ["wax", "handmade"],

      "price": 24000,               // resolved from the default variant
      "compareAtPrice": 30000,      // null when not discounted
      "currency": "XAF",
      "priceRange": { "min": 24000, "max": 38000 },  // OMITTED when every variant costs the same
      "inStock": true,

      "image": {                    // thumbnail only; full gallery on the detail
        "id": "507f1f77bcf86cd799439030",
        "key": "images/abc123.jpg",
        "url": "https://…/products/abc123.jpg",
        "mimeType": "image/jpeg",
        "size": 84213,
        "originalName": "cover.jpg"
      },

      "store": { "slug": "maison-bella", "name": "Maison Bella", "isOpen": true },

      "freeDelivery": false,
      "updatedAt": "2026-07-30T09:20:00.000Z"
    }
  ],
  "meta": { "total": 120, "page": 1, "limit": 20, "pages": 6 }
}
```

- `image` is `null` when the product has no usable image — the key is always present.
- `priceRange` is **omitted** when there is one price, rather than sent as `{min: x, max: x}`.
- An empty result is `data: []` with `meta.total: 0`. Never a 404.
- Build the product URL as `/shop/stores/{store.slug}/products/{slug}` — see decision 1.

---

## GET /api/public/stores/:storeSlug/products/:productSlug

The product page. `GET /api/public/products/:productId` returns the identical body.

```jsonc
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439066",
    "slug": "ankara-wax-print-maxi-dress",
    "title": "Ankara Wax Print Maxi Dress",
    "description": "Comfortable cotton…",
    "type": "physical",
    "category": "Fashion",
    "tags": ["wax", "handmade"],
    "seo": { "title": "…", "description": "…" },   // omitted when unset
    "contentLanguage": "fr",

    "images": [ /* full gallery, FileDetail objects, thumbnail first */ ],

    "options": [
      {
        "id": "507f…opt1",
        "name": "Size",
        "position": 1,
        "values": [ { "id": "507f…val1", "value": "S" }, { "id": "507f…val2", "value": "M" } ]
      }
    ],

    "variants": [
      {
        "id": "507f1f77bcf86cd799439077",
        "sku": "DRESS-WAX-M",
        "name": "Size: M",
        "price": 24000,
        "compareAtPrice": 30000,
        "currency": "XAF",
        "inStock": true,

        "optionValueIds": ["507f…val2"],
        "options": [
          { "optionId": "507f…opt1", "optionName": "Size", "valueId": "507f…val2", "value": "M" }
        ],

        "images": [ /* omitted entirely when the variant has none */ ],

        "digital": { "maxDownloads": 3, "expiresAfterDays": 30 },   // digital variants only
        "service": {                                               // service variants only
          "durationMinutes": 60,
          "bookingMode": "calendar",
          "bufferBeforeMinutes": 0,
          "bufferAfterMinutes": 15,
          "priceUnit": "per 1 h",
          "priceFrom": 24000
        }
      }
    ],
    "defaultVariantId": "507f1f77bcf86cd799439077",

    "store": {
      "slug": "maison-bella",
      "name": "Maison Bella",
      "logo": { /* FileDetail | null */ },
      "isOpen": true,
      "verified": true,
      "city": "Douala",
      "country": "CM",
      "supportWhatsapp": "+237670000000",
      "policies": {
        "returnPolicy": {
          "eligible": true,
          "windowDays": 14,
          "refundType": "full",
          "refundPercentage": null,
          "returnShippingPayer": "vendor",
          "refundProcessingDays": 5,
          "conditionNotes": "Unworn, tags attached"
        },
        "cancellationPolicy": {
          "cancellable": true,
          "deadline": "before_vendor_confirmation",
          "deadlineDays": null,
          "feeType": null,
          "feeValue": null,
          "lateRefundType": null,
          "lateRefundValue": null
        }
      }
    },

    "freeDelivery": false,
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

### ⚠️ Select variants on `optionValueIds`, never on a rebuilt signature

`ProductVariant.optionSignature` (`"size:large|color:red"`) is **not published**, and you
must not reconstruct it. Renaming an option value is a documented *safe* operation that
deliberately does not rewrite the stored signature — so after a rename the signature still
says `color:red` while every screen says `crimson`, and a client matching on displayed text
fails to find a variant that exists.

Match on `optionValueIds` (a set), or read the pre-joined `options[]` on each variant, which
is there so you never have to join anything yourself.

### ⚠️ A service variant's `price` is a UNIT RATE

It is the price per `durationMinutes`, prorated by the actual elapsed duration and then
surcharged by peak hours — printing it as "the price" misquotes the customer. Render
`priceFrom` with `priceUnit` ("from 24,000 XAF · per 1 h"), or format your own label from
`durationMinutes`, which is the authoritative number. `priceUnit` is an English convenience
string and is not localized.

### Simple-mode products

`options: []` and exactly one variant. Skip the picker entirely.

### Policies are structured, not prose

BACKEND-SHOP-REQUIREMENTS §2.2 sketched `returnPolicy` as a string. There is no prose field
anywhere to render from — `IVendorReturnPolicy` is structured — so a string would have had
to be generated on the server, in one language, for a five-locale storefront. You get the
facts and phrase them. Either block is `null` when the vendor has not configured one; no
defaults are invented.

### Errors

| `error.code` | Status | Cause |
|---|---|---|
| `CATALOG_PRODUCT_NOT_FOUND` | 404 | Absent, soft-deleted, draft, archived, suspended, or its vendor is suspended |
| `VALIDATION_ERROR` | 400 | Malformed slug or id |

> A non-public product returns **404, never 403** — a 403 would confirm the id is real,
> which is exactly what a competitor enumerating a vendor's unreleased catalogue wants.

---

## GET /api/public/categories

`Product.category` is a plain indexed string; there is no Category collection, model or
taxonomy anywhere. The chip list is therefore derived, over exactly the browse filter — so a
category whose every product is a draft does not appear.

```jsonc
{
  "success": true,
  "data": [
    { "name": "Fashion", "productCount": 48 },
    { "name": "Home",    "productCount": 31 }
  ]
}
```

A bare array, sorted by count descending then name. No `meta` — it is a small complete set,
not a page.

---

## GET /api/public/stores

The directory, and the sitemap's source of store URLs.

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string ≤ 200 | — | Substring over the store name (escaped) |
| `city` | string | — | Case-insensitive exact match on the vendor's city |
| `page` / `limit` | integer | `1` / `20` | `limit` capped at 100 |

> **Stores with no publishable products are excluded here.** An empty storefront is a
> soft-404 to a crawler, and emitting its URL in a sitemap asks Google to index a dead page.
> `GET /stores/:slug` does **not** apply that rule — a shopper following a link from an order
> should read "nothing for sale right now", not hit a dead page.

## GET /api/public/stores/:slug

```jsonc
{
  "success": true,
  "data": {
    "slug": "maison-bella",
    "name": "Maison Bella",
    "description": "Contemporary African fashion, handmade in Douala.",
    "logo":   { /* FileDetail | null */ },
    "banner": { /* FileDetail | null */ },
    "isOpen": true,
    "supportEmail": "…", "supportPhone": "…", "supportWhatsapp": "…",
    "country": "CM",
    "city": "Douala",
    "verified": true,
    "productCount": 48,
    "memberSince": "2026-02-01T00:00:00.000Z"
  }
}
```

`404 STORE_NOT_FOUND` when the slug is unknown or the vendor is suspended.

> **`city` is the only address component published, deliberately.** A vendor's
> `business_addresses[]` are the places they ship from — a home or a warehouse, with a street
> line and exact coordinates. A shopper needs the city; the rest is a private address.

## GET /api/public/stores/:slug/products

The same query contract as `GET /api/public/products` minus `storeSlug`, and the same row
shape. `404 STORE_NOT_FOUND` if the store is not public — rather than an empty grid, which
would say "this seller has nothing" about a suspended vendor.

---

## SEO

- `sku` **is** published per variant. It is already globally unique and already shown to the
  customer on cart and order lines, so `Offer.sku` is safe to emit.
- `aggregateRating` stays **omitted**: there is no review system. Publishing invented review
  counts is a Google spam-policy violation that earns a manual action.
- `updatedAt` on every product row is a real `lastModified` for the sitemap.

## Rate limiting

`/api/public/*` has its own IP-scoped bucket (`RATE_LIMIT_PUBLIC_PER_MIN`, default 3000/min)
**in addition to** the global 1200/min backstop — so the effective ceiling is the lower of
the two. The separate bucket exists so anonymous browse traffic cannot exhaust the global
counter on behalf of the signed-in shoppers sharing an office NAT or a mobile carrier.
See [rate-limits.md](../rate-limits.md).

---

## Not built (deliberately)

- **Related products / "customers also bought"** — Tier 3. `Product.lastOrderedAt` exists
  and nothing reads it.
- **Reviews and ratings** — Tier 3, and the reason `aggregateRating` is omitted.
- **A stock count** — see decision 3. `inStock` is the honest answer.
- **`bargain`** — `ProductVariant` gained a negotiable price range while this surface was
  being built. It is **not published**, pending a decision about whether the range is
  buyer-facing or a vendor-side floor. Adding it is an edit to `public-product.dto.ts`.
- **Product-text translation** — `title`/`description`/`category`/`tags`/`seo.*` are plain
  strings with no `Accept-Language` handling. The platform's position is that product text is
  **vendor-authored in one language**, and `contentLanguage` says which so you can label it
  honestly. A translation system is a separate piece of work.
