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

## DELETE /api/customer/cart/items/:productId

Remove a product from the cart. Removes **all** items for that `productId` (all its variants). When
the cart becomes empty its `productType` is reset.

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
