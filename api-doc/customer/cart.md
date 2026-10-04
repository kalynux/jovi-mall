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
{ "deliveryAddressId": "664addr...", "paymentMethod": "online" }
```

Both fields are optional. `paymentMethod` (`online` | `cash_on_delivery`, default `online`)
selects how the [delivery minimum](#the-delivery-minimum) is evaluated — send the method the
customer has picked, because cash on delivery is checked more strictly.

`deliveryAddressId` is optional (the cart opens before one is chosen). When supplied it is
**validated against the same rule checkout applies**, which is the main reason to send it: an
address typed by hand rather than picked from `GET /api/geo/search` has no geocoded location
and checkout will refuse it. Far better to learn that here than at the pay button.

### Success — `200 OK`

**Changed 2026-10-04 — [ADR-A11](../../docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md) (customer-paid
delivery).** Free delivery is now each **shop's** setting (`always` · `never` · `above` a basket
amount). Where the customer pays, `delivery` is the real fee and **`total` already includes it**.
Two shops, one free and one customer-paid:

```jsonc
{
  "success": true,
  "data": {
    "currency": "XAF",
    "subtotal": 30000,
    "delivery": 1500,           // what the CUSTOMER is charged for delivery (Σ customer-paid shops)
    "absorbedByVendor": 1800,   // what the free-delivery SHOPS pay their agencies — never show it
    "tax": 0,
    "discount": 0,
    "total": 31500,             // subtotal + delivery — exactly what checkout will charge
    "paymentMethod": "online",
    "regionKnown": true,        // false → priced without a drop-off region (in-region); see below
    "meetsDeliveryMinimum": true,   // false → checkout will refuse; see below
    "cashOnDelivery": {             // would a COD checkout be accepted? — see below
      "available": true,
      "reason": null,               // when false: vendor_not_accepted | agency_not_supported |
                                    //   order_amount_exceeds_limit | digital_items | null
      "vendorIds": []               // the shops that refuse (ids as in perVendor[].vendorId)
    },
    "perVendor": [
      {
        "vendorId": "507f…aaa",
        "subtotal": 24000,
        "delivery": 0,              // the shop pays — show "Free delivery"
        "total": 24000,
        "deliveryPayer": "vendor",
        "deliveryPayerReason": "shop_always",
        "absorbedByVendor": 1800,
        "freeDelivery": { "mode": "always", "freeAboveAmount": null, "shortfall": null },
        "shipments": [
          { "agencyId": "66ag…01", "weightGrams": 2400, "outOfRegion": false, "fee": 1800,
            "components": { "pickup_base": 1000, "weight_extra": 800, "region_surcharge": 0,
                            "storage": 0, "cap_applied": false, "kg": 3, "weight_grams": 2400,
                            "out_of_region": false, "flat_fallback": false } }
        ],
        "deliveryMinimum": {
          "met": true, "checkedPer": "order", "maxDeliveryPercent": 30, "shortfall": 0,
          "units": [ { "agencyId": null, "subtotal": 24000, "met": true, "reason": null,
                       "minimumSubtotal": 6000, "shortfall": 0 } ]
        }
      },
      {
        "vendorId": "507f…bbb",
        "subtotal": 6000,
        "delivery": 1500,           // the customer pays this shop's fee
        "total": 7500,
        "deliveryPayer": "customer",
        "deliveryPayerReason": "threshold_not_met",
        "absorbedByVendor": 0,
        "freeDelivery": { "mode": "above", "freeAboveAmount": 10000, "shortfall": 4000 },
        "shipments": [
          { "agencyId": "66ag…02", "weightGrams": 800, "outOfRegion": false, "fee": 1500, "components": { "…": "…" } }
        ],
        "deliveryMinimum": { "met": true, "checkedPer": "order", "maxDeliveryPercent": 30, "shortfall": 0, "units": [ "…" ] }
      }
    ]
  }
}
```

**What each delivery field means:**

| Field | Meaning |
|---|---|
| `delivery` | Σ of the shops' `perVendor[].delivery` — what the customer pays for delivery. **Already in `total`.** |
| `perVendor[].delivery` / `.total` | What the customer pays for THIS shop's delivery (0 when the shop pays), and `subtotal + delivery`. |
| `perVendor[].deliveryPayer` | `vendor` (free delivery for the customer) · `customer` · `null` for a digital-only shop. |
| `perVendor[].deliveryPayerReason` | `shop_always` · `shop_threshold_met` (free) · `shop_never` · `threshold_not_met` · `cap_fallback` (the customer pays). |
| `perVendor[].freeDelivery` | The shop's terms: `mode` (`always` · `never` · `above`), `freeAboveAmount` (the threshold when `above`), and **`shortfall`** — how much more **from that shop** would make delivery free (the threshold's gap, or what the 30% cap needs after a `cap_fallback`). `null` when delivery is already free, the shop never delivers free, or no basket size can make it free. `null` (the whole object) for a digital-only shop. |
| `perVendor[].shipments[]` | One per delivery agency the shop's items go through (one fee each): `fee`, `weightGrams` (Σ unit weight × qty), `outOfRegion`, and `components` (the formula's itemisation, for an optional breakdown; `null` when the agency has no pricing policy). |
| `regionKnown` | Whether a drop-off region could be read (the requested `deliveryAddressId`, else the default saved address). `false` ⇒ every shipment was priced **in-region** (never surcharged on a guess); the fee can rise at checkout once the address is chosen. |
| `absorbedByVendor` | What free-delivery shops pay their agencies — **informational, internal; never show it to the customer** and never add it to anything. `null` for a digital cart. |

**How to render it (storefront cart, checkout, the bots):**

- One delivery line **per shop** that ships: `perVendor[].delivery > 0` → the formatted amount;
  `0` → **"Free delivery"**. Do not sum anything yourself — `total` is the figure to charge.
- When `freeDelivery.shortfall` is a positive number, show a non-blocking hint: **"Add 4 000 XAF
  more from <shop> for free delivery."** Items from another shop do not help.
- ⚠ **"Delivery included" is now WRONG** as blanket copy. It was true when every shop paid
  delivery; render the per-shop line instead.
- Send `deliveryAddressId` once the customer picks an address: the out-of-region surcharge
  depends on it, so the quote (and `total`) can change with the address.

The quote is an **estimate** on the same terms as before — an agency editing its pricing, a
vendor editing its delivery terms or re-pointing a product's agency, or a different drop-off
moves it. Checkout prices with the same function and is the authority.

`tax` and `discount` are pinned zeros: there is no tax engine and no coupon model. They are
present rather than absent so the receipt shape does not change the day either arrives, and
they are the same figures written into the order's `price_breakdown` at checkout.

### Errors

| HTTP | Code | When |
|---|---|---|
| 400 | `CART_EMPTY_CHECKOUT` | The cart is empty. |
| 404 | `CUSTOMER_ADDRESS_NOT_FOUND` | `deliveryAddressId` is not one of the customer's. |
| 422 | `ORDER_DELIVERY_ADDRESS_REQUIRED` | The chosen address has no geocoded location. `details.reason: "selected_address_not_geocoded"`. |
| 400 | `VALIDATION_ERROR` | `paymentMethod` is not `online` or `cash_on_delivery`. |

The quote never refuses for the delivery minimum — it **reports** it. Checkout refuses.

### The delivery minimum

**New 2026-09-27 — [ADR-A07](../../docs/ADR-A07-DELIVERY-COST-CAP.md), amended 2026-10-04 by
[ADR-A11](../../docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md).** Checkout refuses a shop's part of the
basket that is too small for the shop to sell at all, with `422 ORDER_BELOW_DELIVERY_MINIMUM`.

⚠ **Since ADR-A11 this is rare.** A free-delivery shop whose part cannot carry its fee (the 30%
cap) no longer refuses — it **falls back to customer-paid** delivery (`deliveryPayerReason:
"cap_fallback"`) and `freeDelivery.shortfall` says how much more makes it free again. The refusal
remains only when even customer-paid delivery leaves the shop earning nothing (its commission and
the cash-on-delivery fee stay the shop's). The quote tells you in advance, per shop:

- **`perVendor[].deliveryMinimum.met: false`** — this shop's items will be refused. Say how
  much more to add **from that shop**: `shortfall`, in the cart currency. Items from a different
  shop become a separate order and do not help.
- **`checkedPer: "order"`** (online) — one unit covering the whole shop, `agencyId: null`.
- **`checkedPer: "shipment"`** (cash on delivery) — one unit per delivery agency, and **each**
  must pass on its own. `shortfall` on the shop is the sum; `units[].shortfall` says which
  agency's items need topping up (the items delivered by that `agencyId`).
- **`minimumSubtotal: null`** on a unit — no basket size can pass for it (the agency's COD fee
  alone is too high). Suggest paying online instead, or removing those items.
- **`deliveryMinimum: null`** — not evaluated: a digital-only shop (no delivery), or the
  estimate was not possible. Checkout still decides.

Disable or annotate the pay button while `meetsDeliveryMinimum` is `false`. It is an
**estimate** like the rest of the quote — checkout is the authority, and it also
counts a price agreed in chat, which the quote cannot see.

Never present the rule to the customer in money terms beyond the shortfall: the vendor's
commission and fee are not the customer's business, and the API deliberately does not return
them.

### Can this basket be paid on delivery? — `cashOnDelivery`

**New 2026-10-03 — [ADR-A09](../../docs/ADR-A09-COD-LIMITS-AND-DELIVERY-FEES.md) G-10.** Every
quote answers whether checkout would **accept this basket as cash on delivery**, whatever
`paymentMethod` you sent — so the first quote on the checkout screen (usually `online`) already
tells you whether to offer the cash-on-delivery option at all.

It runs **checkout's own rule** (`CodEligibilityService.assertVendorOrderEligible`, the call order
creation makes), for every shop in the basket, against the agencies the shop's items would ship
with. The Telegram Mini App's `cashOnDelivery` boolean reads the same verdict.

| `reason` | Checkout would refuse with | Meaning |
|---|---|---|
| `vendor_not_accepted` | `422 COD_VENDOR_NOT_ACCEPTED` | a shop switched cash on delivery off |
| `agency_not_supported` | `422 COD_AGENCY_NOT_SUPPORTED` | a delivery company does not take cash (or is not verified), or the shop has no delivery company |
| `order_amount_exceeds_limit` | `422 COD_ORDER_AMOUNT_EXCEEDS_LIMIT` | a shop's part of the basket is above what its delivery company accepts in cash per order |
| `digital_items` | `422 COD_NOT_AVAILABLE_FOR_DIGITAL` | a digital basket — nothing is handed over |
| `null` with `available: false` | — | the rules could not be checked right now; checkout decides. Show a generic line, or keep the option and handle the 422 |

- `reason` is the **first** refusal (shops in cart order); `vendorIds` lists **every** shop that
  refuses, so you can name them from your cart lines or suggest removing their items. Empty for
  `digital_items`.
- **Hide or disable the cash-on-delivery option while `available` is `false`.** Still handle the
  four `422`s at checkout: a vendor or agency may change its terms between the quote and the POST.
- **Not included, deliberately:** the delivery minimum (that is `meetsDeliveryMinimum` on a quote
  sent with `paymentMethod: "cash_on_delivery"` — COD is checked per shipment) and the agencies' /
  vendors' COD **cash limits** — those never refuse a customer; the order is placed and the parcel
  waits for the vendor.
- No vendor setting or agency limit is exposed — a boolean, a reason and shop ids only.

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

**At order creation, not at add-to-cart.** It is
[`POST /api/customer/orders/checkout`](orders.md#post-apicustomerorderscheckout) that consumes
the lock, inside the checkout transaction — so a checkout that rolls back leaves it spendable.
That means a lock that passed when the item went into the basket **can still be refused at
checkout**: the window is re-read as it stands at that moment. Handle the five codes on both
calls.

See [Customer → Orders](orders.md) for the checkout side.
