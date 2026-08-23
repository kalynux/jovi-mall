# Wishlist & Recently Viewed API

A signed-in customer's own view of the catalogue: the products they **saved**, and the products
they **looked at**. Both are mounted under `/api/customer`, behind a customer session.

> [!IMPORTANT]
> `/shop/saved` in the storefront works from `localStorage` today and does not survive a device
> change or a cleared browser. These endpoints are the same list kept server-side. Nothing else
> changes — the product cards they return are **byte-identical in shape** to a
> `GET /api/public/products` row (see [public/catalog.md](../public/catalog.md)), because the same
> projection builds both.

---

## Authentication

```
Authorization: Bearer <access_token>
```

or the `access_token` cookie. **Customer role only** — a vendor or agent token is `403`.

The owner is resolved from the token. There is no path segment or body field naming a customer
anywhere in this document, so there is nothing to pass and nothing to get wrong.

---

## The entry shape, and the one thing to build for

Every list here returns entries, not bare products:

```json
{
  "productId": "68a1f0c2e4b0a1d2c3e4f5a6",
  "at": "2026-08-21T09:14:00.000Z",
  "product": { "id": "68a1…", "slug": "blue-shirt", "title": "Blue Shirt", "...": "…" }
}
```

| Field | Meaning |
|---|---|
| `productId` | Always present, **even when `product` is `null`**. The remove button needs it. |
| `at` | Wishlist: when it was **saved**. Recently viewed: when it was **last opened**. |
| `product` | The storefront card, **or `null`** |

### ⚠ `product` can be `null`, and you must render for it

A saved product can be archived, unpublished, suspended by an agency, taken down by an
administrator, or belong to a suspended vendor. **Nothing cascades into these lists** — that is
deliberate, so a product coming back off suspension finds its wishlists intact.

So an entry whose product is no longer on sale comes back with `product: null` rather than:

- **failing the request** — one archived product would break the whole saved list; or
- **being dropped** — the list would silently shrink, `meta.total` would stop matching what you
  render, and the customer would get no explanation.

Render it as *"This item is no longer available"* with a working remove button.

You cannot tell *why* it is unavailable, deliberately: distinguishing "deleted" from "suspended"
would leak a vendor's catalogue state to anyone who once saved a product.

---

# Wishlist

## GET /api/customer/wishlist

Saved products, **newest save first**. Paginated (`?page`, `?limit`, max 100).

```json
{
  "success": true,
  "data": [ { "productId": "…", "at": "…", "product": { } } ],
  "meta": { "total": 12, "page": 1, "limit": 20, "pages": 1 }
}
```

An empty wishlist is `data: []` with `meta.total: 0` — a successful answer, never a 404.

## POST /api/customer/wishlist

Save a product.

```json
{ "productId": "68a1f0c2e4b0a1d2c3e4f5a6" }
```

**Idempotent, and answers `200`.** Saving something already saved is not an error and not a new
resource — from the customer's side it was already true. Double-tapping a heart must not produce a
visible failure.

> **Re-saving does not move the entry.** A wishlist is ordered by when you *decided*; a second tap
> is not a new decision. (Recently-viewed is the opposite — see below.)

Returns the entry, with the card hydrated, so you need not re-fetch to render the row.

| Status | Code | When |
|---|---|---|
| 404 | `CATALOG_PRODUCT_NOT_FOUND` | The product is not on sale, or does not exist. A 404 either way — the endpoint is not an oracle for a competitor's unreleased catalogue |
| 400 | `VALIDATION_ERROR` | Malformed id, or an unknown key (the schema is `.strict()`) |

> **Saving does not require the product to stay on sale.** The check is only about what may
> *enter* the list. Once saved, a row survives the product going away — see the degrade rule
> above.

## DELETE /api/customer/wishlist/:productId

Remove a save.

| Status | Code | When |
|---|---|---|
| 404 | `WISHLIST_ITEM_NOT_FOUND` | Not on **your** list — including when it is on somebody else's |

Never a `403`. Every query is scoped to the caller, so another customer's row simply is not found;
a 403 would confirm it exists.

## POST /api/customer/wishlist/saved-among

Which of these products are saved? One call per rendered grid, rather than one per card.

```json
{ "productIds": ["68a1…", "68a2…"] }
```

```json
{ "success": true, "data": { "savedProductIds": ["68a1…"] } }
```

Max **100** ids per call. A `POST` because 100 ids is ~2.5 KB of query string; it reads nothing
and writes nothing.

---

# Recently viewed

## GET /api/customer/recently-viewed

Most recently **opened** first. Paginated identically.

`at` is when the product was **last** opened — not the first time.

## POST /api/customer/recently-viewed

Record that a product page was opened.

```json
{ "productId": "68a1f0c2e4b0a1d2c3e4f5a6" }
```

> [!IMPORTANT]
> **Two rules that differ from the wishlist, and both matter to the UI:**
>
> 1. **Re-viewing MOVES the entry to the head.** A product you return to is more recent than one
>    you have not opened since. There is never a duplicate.
> 2. **The list is CAPPED** (20 by default, `CUSTOMER_RECENTLY_VIEWED_CAP`). Recording a new
>    product evicts the oldest. This is a cap on the stored list, not a page size — `?limit` is
>    separate and pages within it.

**There is deliberately no `viewedAt` field**, and sending one is a `400`. The list is both ordered
and capped by that timestamp, so a client-chosen value is a client-chosen position in a bounded
list — a caller could pin an entry at the head forever, or evict everything real by claiming a
time in the future. The server clock is the only source.

Same `404 CATALOG_PRODUCT_NOT_FOUND` as the wishlist for a product that is not on sale.

## DELETE /api/customer/recently-viewed

Forget everything. Returns `{ "removed": 7 }`.

Worth surfacing in the UI: **nothing prunes this list by age**, so the cap is its entire retention
policy for what is, in effect, a record of what a person looked at. Clearing also resets
`recentProductCode` on the profile (below) — leaving it set would keep answering "the last thing
you looked at" after the person asked for exactly that to be forgotten.

---

## `recentProductCode` on the profile — kept, and now maintained

`GET /api/customer/profile` returns a `recentProductCode` string, writable through
`PATCH /api/customer/profile`. **It stays**, so nothing that reads it breaks.

What changed: `POST /api/customer/recently-viewed` now keeps it current, and **the value it writes
is the product's `id`**.

> ⚠ **This is a narrowing of an undefined field, not a break of a defined one.** Nothing in the
> backend has ever read it, this document only ever described it as "trimmed, clearable", and
> `BACKEND-SHOP-REQUIREMENTS.md` called it unused. A server-side writer has to choose *something*,
> and the only handle this platform guarantees for a product is its id — a slug is unique per
> vendor, not globally, which is why the canonical product URL nests products under their store.
>
> The `PATCH` route still accepts any string, so a client already storing its own value keeps
> working. If you want more than one entry, read `GET /api/customer/recently-viewed` instead —
> that is what it is for.

---

## Error codes, in one list

| Code | Status | Category |
|---|---|---|
| `WISHLIST_ITEM_NOT_FOUND` | 404 | `not_found` |
| `CATALOG_PRODUCT_NOT_FOUND` | 404 | `not_found` |
| `VALIDATION_ERROR` | 400 | `validation` |

Branch on `error.code`, never on `error.message`. See [errors/README.md](../errors/README.md).
