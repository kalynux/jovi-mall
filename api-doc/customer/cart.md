# Customer Cart

**Verified against source on 2026-09-08** — every claim on this page was checked against
`jovi-mall/src/`: all 8 routes against the live census, all 11 error codes against the registry,
the 5 merge drop-reasons and the 100-line cap against `cart.validator.ts` and `cart.service.ts`.
**The negotiated-price contract is new on this page** and was previously documented nowhere —
see [Negotiated prices](#negotiated-prices).

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
| POST | `/api/customer/cart/items` | Add a variant, or **increment** it — but **set** it when a negotiation lock is presented |
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

A line whose price was **haggled in chat** carries two extra keys. They are **omitted entirely**
when absent — never `null` — so `"negotiatedUnitPrice" in item` is the test, not a truthiness
check (`cart.service.ts:693-696`):

```json
{
  "variantId": "507f1f77bcf86cd799439077",
  "quantity": 1,
  "price": 30001,
  "currency": "XAF",
  "negotiatedUnitPrice": 30001,
  "negotiationLockRef": "lk_9f2c…"
}
```

| Field | Type | Meaning |
|---|---|---|
| `negotiatedUnitPrice` | integer | **The same number as `price`.** It exists so you can label the line *"your agreed price"* rather than *"price"*. Never compute a total from it — `price` is the total's input. |
| `negotiationLockRef` | string | The lock this line will spend at checkout. The customer's own handle. |

⚠ **The vendor's floor is never on this response.** `floor_price_snapshot` is stored on the cart
document and deliberately excluded from the DTO (`cart.service.ts:56-73`) — it is the same secret
as `bargain.minPrice` on the [public catalogue](../public/catalog.md). If you find it on a cart
payload, that is a leak, not a feature.

---

## POST /api/customer/cart/items

Add a variant to the cart. If the variant is already present, its quantity is incremented (physical);
digital items stay at quantity `1`.

⚠ **One exception, and it is the only one:** presenting a `negotiationLockRef` **sets** the quantity
instead of incrementing it, because the lock is bound to a quantity. See
[Negotiated prices](#negotiated-prices).

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
| `negotiationLockRef` | string 1–200 | no | A price agreed in chat. **Opaque** — do not parse it. See [Negotiated prices](#negotiated-prices) for what presenting one changes. |

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
| 404/409/422 | `NEGOTIATION_LOCK_*` | Only when `negotiationLockRef` was presented. Five codes — see [The five refusals](#the-five-refusals). |

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

⚠ **A negotiated line LOSES its agreed price here.** The lock is bound to a quantity, so changing
it reverts the line to the ordinary shelf price and drops all three negotiation fields — silently,
in a 200. **Re-read the response and re-render.** See [Negotiated prices](#negotiated-prices).

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

---

## Negotiated prices

A customer can haggle **in chat** (WhatsApp or Telegram) and reach an agreed price. There is no
"make an offer" control on the storefront and none is planned — bargaining is chat-only. When a
haggle closes, the bargaining agent mints a **lock**: an opaque, single-use handle bound to
*this customer, this variant, this quantity*.

A client's whole involvement is: pass the lock through, render what comes back, and handle the
five refusals.

### Presenting a lock

`POST /api/customer/cart/items` with `negotiationLockRef`. The lock is validated but **not spent**
— it is only *peeked* (`negotiated-price.port.ts:33-37`), so a shopper may remove and re-add the
item, or leave the basket overnight, without burning the price they haggled for.

⚠ **Presenting a lock SETS the quantity; it does not increment it.** An ordinary add of a line
already in the cart adds to it. A locked add replaces the quantity outright, because the lock is
bound to a quantity and incrementing would silently sell a different deal from the one agreed
(`cart.service.ts:232-251`).

### Two things that silently drop a negotiated price

Both are deliberate. In each case the line survives, reverts to the ordinary shelf price, and
loses all three negotiation fields (`cart.service.ts:384-387`):

| What the customer does | Why it drops |
|---|---|
| **Changes the quantity** — `PATCH /items/:variantId` | The lock is bound to a quantity. A different quantity is a different deal. (`cart.service.ts:357-361`) |
| **Signs in with an anonymous cart** — `POST /merge` | The merge re-resolves every line from the shelf; an anonymous cart cannot carry a lock. (`cart.service.ts:566-575`) |

**Re-read the cart after either call and re-render the price.** Nothing warns you: the response
is a valid cart whose `price` has changed and whose `negotiatedUnitPrice` is simply gone. A UI
that caches the agreed price and shows it beside a refreshed total will show two different
numbers for one line.

### The five refusals

Raised at **add-to-cart** (peek) and again at **checkout** (consume). All five are client-safe —
the message survives the error boundary — so you may show them to the shopper as-is
(`PriceResolverService.ts:233-258`):

| HTTP | Code | What happened | What the shopper should be told |
|---|---|---|---|
| 404 | `NEGOTIATION_LOCK_INVALID` | No such lock | *"That agreed price could not be found"* |
| 422 | `NEGOTIATION_LOCK_EXPIRED` | The lock aged out | *"That agreed price has expired"* |
| 409 | `NEGOTIATION_LOCK_CONSUMED` | Already spent on an order | *"That agreed price has already been used on an order"* |
| 422 | `NEGOTIATION_LOCK_VARIANT_MISMATCH` | Presented for a different variant or quantity | *"That agreed price was for a different item or quantity"* |
| 409 | `NEGOTIATION_LOCK_WINDOW_MOVED` | The vendor changed the price since the deal | *"The seller has changed this price since it was agreed"* |

⚠ **Treat an unrecognised `NEGOTIATION_LOCK_*` code as `NEGOTIATION_LOCK_INVALID`.** The resolver
lives in another module and may grow a reason before the mapping table does; the fall-through is
always a refusal, never permission.

**Recovery is always the same:** drop the lock and add the line at its ordinary price, or send the
shopper back to chat to negotiate again. Never retry the same lock.

### Where the lock is actually spent

**At order creation, not at add-to-cart.** `POST /api/customer/orders` consumes it inside the
checkout transaction, so a checkout that rolls back leaves the lock spendable. That means a lock
that passed when the item went into the basket **can still be refused at checkout** — the window
is re-read as it stands at that moment. Handle the five codes on both calls.

See [Customer → Orders](orders.md) for the checkout side.
