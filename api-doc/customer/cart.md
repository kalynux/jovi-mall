# Customer Cart

Shopping-cart management. The cart is **variant-first** (the variant is the sellable unit) and is
keyed to the authenticated customer — the same identity used at checkout, so a cart built here is
exactly what [`POST /api/customer/orders/checkout`](orders.md#post-apicustomerorderscheckout) reads.

**Base path:** `/api/customer/cart`
**Auth:** `Authorization: Bearer <jwt_token>` — role `customer`.

> **Business rules (enforced by the server):**
> - A cart may hold items from **multiple vendors** — at checkout it splits into one order per vendor.
> - A cart may hold only **one product type**: physical **or** digital, never mixed. Adding a
>   different type returns `409 CART_MIXED_PRODUCT_TYPES`.
> - **Service** products cannot be added (use the booking flow) → `400 CART_SERVICE_PRODUCT_NOT_ALLOWED`.
> - **Digital**: quantity must be `1`, and only one digital product per cart.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/customer/cart` | Current cart |
| POST | `/api/customer/cart/items` | Add a variant, or **increment** it |
| PATCH | `/api/customer/cart/items/:variantId` | Set an **absolute** quantity |
| DELETE | `/api/customer/cart/items/variant/:variantId` | Remove **one line** |
| DELETE | `/api/customer/cart/items/:productId` | Remove **every variant** of a product |
| POST | `/api/customer/cart/merge` | Hand an anonymous cart over at sign-in |
| POST | `/api/customer/cart/quote` | Price the cart before checkout |
| DELETE | `/api/customer/cart` | Empty the cart |

---

## GET /api/customer/cart

Returns the current cart. If the customer has no cart yet, returns an empty cart (not a 404).

### Response

**Success (200 OK)**
```json
{
  "success": true,
  "data": {
    "cartId": "664a1f77bcf86cd799439900",
    "userId": "507f1f77bcf86cd799439cus",
    "productType": "physical",
    "items": [
      {
        "variantId": "507f1f77bcf86cd799439077",
        "sku": "TSHIRT-RED-L",
        "variantTitle": "Size: Large, Color: Red",
        "optionsSnapshot": "size:large|color:red",
        "productId": "507f1f77bcf86cd799439066",
        "title": "T-Shirt",
        "vendorId": "507f1f77bcf86cd799439aaa",
        "productType": "physical",
        "quantity": 2,
        "price": 7500,
        "currency": "XAF"
      }
    ],
    "totalItems": 2
  }
}
```

An empty cart returns `{ "userId": "...", "items": [], "totalItems": 0 }` (no `cartId`/`productType`).

---

## POST /api/customer/cart/items

Add a variant to the cart. If the variant is already present, its quantity is incremented (physical);
digital items stay at quantity `1`.

### Request Body

```json
{
  "productId": "507f1f77bcf86cd799439066",
  "variantId": "507f1f77bcf86cd799439077",
  "quantity": 2,
  "currency": "XAF"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `productId` | string | yes | Parent product id. |
| `variantId` | string | yes | The variant (sellable unit). Must belong to `productId`. |
| `quantity` | integer ≥ 1 | no | Defaults to `1`. Must be `1` for digital products. |
| `currency` | string | no | Defaults to `XAF`. |

### Response

**Success (200 OK)** — the updated cart (same shape as `GET /api/customer/cart`).

### Errors

| HTTP | Code | When |
|---|---|---|
| 400 | `CART_VARIANT_REQUIRED` | `variantId` missing. |
| 404 | `CART_PRODUCT_NOT_FOUND` | Product does not exist. |
| 404 | `CART_VARIANT_NOT_FOUND` | Variant does not exist. |
| 400 | `CART_VARIANT_PRODUCT_MISMATCH` | Variant does not belong to the product. |
| 400 | `CART_SERVICE_PRODUCT_NOT_ALLOWED` | Product is a service (use booking). |
| 400 | `CART_DIGITAL_QUANTITY_MUST_BE_ONE` | Digital product with quantity ≠ 1. |
| 409 | `CART_MIXED_PRODUCT_TYPES` | Cart already holds a different product type. |
| 409 | `CART_DIGITAL_LIMIT_REACHED` | A digital product is already in the cart. |

---

## PATCH /api/customer/cart/items/:variantId

Set a line's quantity to an **absolute** value — the quantity stepper's endpoint.

`POST /items` only ever *increments*, so before this there was no way to decrease a line.
Both exist and mean different things: `POST` is "add to cart" from a product page, `PATCH` is
"I want exactly this many".

### Request Body

```json
{ "quantity": 2 }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `quantity` | integer 1–999 | yes | **Absolute**, not a delta. `0` is refused — use DELETE. |

Two behaviours inherited from the increment path on purpose:

- **The snapshot price is not refreshed.** `POST /items` only resolves a price when it
  *inserts* a line; re-pricing here would mean the same button behaves differently on two
  paths. The price is re-resolved at checkout, which is the moment that binds.
- **Digital lines stay at 1.**

### Response

**Success (200 OK)** — the updated cart.

### Errors

| HTTP | Code | When |
|---|---|---|
| 404 | `CART_NOT_FOUND` | The customer has no cart. |
| 404 | `CART_ITEM_NOT_FOUND` | That variant is not in the cart (stale tab, or another device removed it). |
| 400 | `CART_DIGITAL_QUANTITY_MUST_BE_ONE` | Digital line with quantity ≠ 1. |
| 400 | `VALIDATION_ERROR` | `quantity` < 1, > 999, fractional, or a malformed `variantId`. |

---

## DELETE /api/customer/cart/items/variant/:variantId

Remove **one line**.

> **Two deletes, two different keys, two different paths.** This one removes a single
> variant; `/items/:productId` below removes *every* variant of a product. They are on
> different paths rather than sharing `/items/:id` because a single path taking either kind
> of id cannot tell them apart — a client sending the wrong one would silently wipe every
> size of a T-shirt instead of getting an error.
>
> **A cart row should call this one.**

### Response

**Success (200 OK)** — the updated cart.

### Errors

| HTTP | Code | When |
|---|---|---|
| 404 | `CART_NOT_FOUND` | The customer has no cart. |
| 404 | `CART_ITEM_NOT_FOUND` | That variant is not in the cart. |

---

## POST /api/customer/cart/merge

Hand an anonymous (localStorage) cart over at sign-in, once.

Checkout requires an account but browsing does not, so a visitor fills a cart, signs in, and
must not lose it. This is the handover.

### Request Body

```json
{
  "items": [
    { "productId": "507f1f77bcf86cd799439066", "variantId": "507f1f77bcf86cd799439077", "quantity": 2 }
  ],
  "strategy": "sum"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | array ≤ 100 | yes | `productId`/`variantId` must be real ObjectIds; `quantity` 1–999 |
| `strategy` | `sum` \| `replace` \| `keep_server` | no | Defaults to `sum` |

> **No `price` is accepted.** Every line is re-priced from the catalogue during the merge —
> the body is client-controlled data, and trusting a price in it would let a caller name
> their own.

| Strategy | Meaning |
|---|---|
| `sum` | Quantities are added to any existing line. Both carts are the shopper's own — two of a thing in each is four. |
| `replace` | The incoming set replaces the server cart entirely. |
| `keep_server` | A non-empty server cart wins outright; every incoming line is reported as dropped. |

### Unusable lines are **reported, not thrown**

Every other cart write is one deliberate action, so a 4xx is the right answer. A merge is a
batch the shopper never itemised — throwing `CART_MIXED_PRODUCT_TYPES` at sign-in would lose
the whole basket to explain one bad line. So bad lines are dropped and named:

```jsonc
{
  "success": true,
  "data": { /* the merged cart, same shape as GET /api/customer/cart */ },
  "meta": {
    "dropped": [
      { "variantId": "507f…077", "reason": "PRODUCT_UNAVAILABLE" }
    ]
  }
}
```

| `reason` | Meaning |
|---|---|
| `PRODUCT_UNAVAILABLE` | No longer on sale (unpublished, archived, suspended, deleted), or the variant is gone |
| `PRODUCT_TYPE_CONFLICT` | Conflicts with the server cart's product type — **the server cart wins** |
| `DIGITAL_LIMIT_REACHED` | A second digital product (one per cart, v1 scope) |
| `SERVICE_NOT_ALLOWED` | Services are booked, not carted |
| `SERVER_CART_KEPT` | `strategy: "keep_server"` against a non-empty cart |

Show the dropped lines — silently losing one is exactly what this endpoint exists to prevent.

---

## POST /api/customer/cart/quote

What this cart will cost, before checking out.

```json
{ "deliveryAddressId": "664addr..." }
```

`deliveryAddressId` is optional (the cart opens before one is chosen). When supplied it is
**validated against the same rule checkout applies**, which is the main reason to send it: an
address typed by hand rather than picked from `GET /api/geo/search` has no geocoded location
and checkout will refuse it. Far better to learn that here than at the pay button.

### Success — `200 OK`

```jsonc
{
  "success": true,
  "data": {
    "currency": "XAF",
    "subtotal": 24000,
    "delivery": 0,              // what the CUSTOMER is charged for delivery
    "absorbedByVendor": 1500,   // what the VENDOR pays the agency — informational
    "tax": 0,
    "discount": 0,
    "total": 24000,
    "perVendor": [
      { "vendorId": "507f…aaa", "subtotal": 24000, "delivery": 0, "absorbedByVendor": 1500 }
    ]
  }
}
```

> **`delivery` is 0 and `total` is the subtotal, and that is the truth rather than a stub.**
> The agency's delivery fee is real and *is* charged — but to the **vendor**: `splitOrder`
> computes `vendorNet = gross − commission − deliveryTotal` off the items subtotal. Adding it
> to the customer's total as well would collect it twice.
>
> `absorbedByVendor` is reported so the UI can say "delivery included" and mean it. It is an
> **estimate** — an agency editing its pricing, or a vendor re-pointing a product's delivery
> agency, moves it. The customer-facing total is unaffected by both. `null` means it could not
> be estimated (a digital cart, or an agency with no pricing policy configured), which is
> deliberately distinct from `0`.

`tax` and `discount` are pinned zeros: there is no tax engine and no coupon model. They are
present rather than absent so the receipt shape does not change the day either arrives, and
they are the same figures written into the order's `price_breakdown` at checkout.

### Errors

| HTTP | Code | When |
|---|---|---|
| 400 | `CART_EMPTY_CHECKOUT` | The cart is empty. |
| 404 | `CUSTOMER_ADDRESS_NOT_FOUND` | `deliveryAddressId` is not one of the customer's. |
| 422 | `ORDER_DELIVERY_ADDRESS_REQUIRED` | The chosen address has no geocoded location. `details.reason: "selected_address_not_geocoded"`. |

---

## DELETE /api/customer/cart/items/:productId

Remove a product from the cart. Removes **all** items for that `productId` (all its variants). When
the cart becomes empty its `productType` is reset.

> Kept for back-compat. For a per-line remove button use
> [`DELETE /items/variant/:variantId`](#delete-apicustomercartitemsvariantvariantid) —
> otherwise removing one size of a T-shirt removes every size.

### Response

**Success (200 OK)** — the updated cart.

### Errors

| HTTP | Code | When |
|---|---|---|
| 404 | `CART_NOT_FOUND` | The customer has no cart. |

---

## DELETE /api/customer/cart

Empty the cart entirely.

### Response

**Success (200 OK)**
```json
{ "success": true, "message": "Cart cleared" }
```

---

## Stock is now held at checkout

Adding to a cart still reserves nothing — a cart is not a claim on inventory. But
**checkout** now holds every line for 30 minutes, and a line that cannot be satisfied fails
the whole checkout with `422 CATALOG_INSUFFICIENT_STOCK` and
`details: { variantId, sku, requested, available }`.

`available` is `stock − units held by other in-flight checkouts`, so it is what the shopper
can actually buy, not the raw counter. An abandoned checkout's hold lapses on its own and the
units return without any action.
