# Customer shop + bot: an administrator can switch cash on delivery off for a customer

**2026-10-10 · not deployed yet · additive.** Nothing changes for a customer nobody restricted.

## What it is

Returns policy § 3.4 says that refusing parcels without a valid reason "may lead us to restrict
cash on delivery on your account". An administrator can now do that from the admin dashboard, and
lift it again. While it is on, that customer cannot **place** a cash-on-delivery order. Their
existing orders, and every other payment method, are untouched.

## What you receive

### 1. The cart quote says so before the pay screen

`cashOnDelivery.reason` on the cart quote gains one value:

```json
"cashOnDelivery": { "available": false, "reason": "customer_restricted", "vendorIds": [] }
```

| | |
|---|---|
| When | The signed-in customer is restricted. It is the **first** reason reported, even if a shop in the basket also refuses cash |
| `vendorIds` | Always empty. It is about the account, not about a shop |
| What to show | Hide or disable cash on delivery, with a line such as *"Pay on delivery is not available on your account. Pay online, or contact support."* |
| What NOT to show | "Remove items" / "choose another shop" advice. No change to the basket makes it available |

The full list is now `vendor_not_accepted · agency_not_supported · order_amount_exceeds_limit ·
digital_items · customer_restricted`. An unknown value must still be treated as "unavailable".

### 2. Checkout refuses it

`POST` checkout with `paymentMethod: "cash_on_delivery"` answers:

```json
{ "success": false, "error": { "code": "COD_CUSTOMER_RESTRICTED", "statusCode": 422,
  "category": "business_rule",
  "message": "Cash on delivery is not available on this account — choose another payment method" } }
```

There is no `details`. Nothing was reserved and no order was created: offer the online methods.

### 3. The reason is never sent

The administrator's reason is an internal note. No customer endpoint returns it, and there is no
field telling the customer *why*. Point them at support.

## A restricted delivery agency (same release)

An administrator can also switch cash on delivery off for a **delivery company**. You need no new
code for it: a basket that company would carry reads `reason: "agency_not_supported"` with the
shop in `vendorIds`, and checkout answers the existing `422 COD_AGENCY_NOT_SUPPORTED` — exactly as
for a company that never offered cash on delivery.

## Bot / Mini App

Nothing to build. The checkout review reads the same verdict, so the **Pay on delivery** button is
simply not drawn for a restricted customer. If the restriction lands between the review and the
tap, the reply carries the code above with a translated `error.customerMessage` (en, fr, pt, es, ar).

## Not built

The customer is **not notified** when the restriction is set or lifted. They find out at the pay
screen. This is an open owner decision.

## Checklist

- [ ] Add `customer_restricted` to the `cashOnDelivery.reason` copy table
- [ ] Handle `422 COD_CUSTOMER_RESTRICTED` at checkout like `COD_VENDOR_NOT_ACCEPTED` (offer online payment), without basket advice
