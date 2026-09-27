# What changed on 2026-09-27: a minimum basket per shop, for delivery

**For:** the storefront (landing / shop) and the customer app — anything that shows a cart or
calls checkout.
**Record:** [ADR-A07](../../docs/ADR-A07-DELIVERY-COST-CAP.md) · **Reference:**
[cart.md § The delivery minimum](./cart.md#the-delivery-minimum) ·
[orders.md § Errors](./orders.md#errors)

## Why

The customer is not charged for delivery. The vendor pays the delivery agency out of their
share. A basket smaller than its delivery fee used to be accepted, and the money then could not
be split: nobody got paid, while the customer's payment or cash had already moved. Checkout now
refuses it up front.

## What you need to do

**1. Checkout can refuse with a new code.** `POST /api/customer/orders/checkout` →
`422 ORDER_BELOW_DELIVERY_MINIMUM`. Nothing is created and no stock is held.

```jsonc
"details": {
  "vendorId": "507f…aaa",
  "scope": "order",             // "shipment" when paying cash on delivery
  "agencyId": null,             // set when scope is "shipment"
  "subtotal": 500,
  "minimumSubtotal": 3334,      // null → no basket size passes (COD: suggest paying online)
  "shortfall": 2834,            // how much more to add FROM THAT SHOP
  "maxDeliveryPercent": 30,
  "reason": "delivery_cost_ratio",
  "currency": "XAF"
}
```

Suggested copy: *"Add 2 834 XAF more from {shop name} to order — delivery for these items
isn't covered yet."* Items from a **different** shop don't help: they become a separate order.

**2. Prevent it with the cart quote.** `POST /api/customer/cart/quote` now takes an optional
`paymentMethod` (`online` | `cash_on_delivery`, default `online`) and returns:

- `meetsDeliveryMinimum` — `false` means checkout will refuse. Disable or annotate the pay button.
- `perVendor[].deliveryMinimum` — `{ met, checkedPer, maxDeliveryPercent, shortfall, units[] }`,
  or `null` when not evaluated (digital-only shop). Show `shortfall` against the shop.

Quote again when the customer switches between online and cash on delivery. **Cash on delivery
is stricter**: it is checked per delivery agency, and the agency's COD fee counts. A basket can
pass online and fail as COD.

**3. Don't explain it in money terms beyond the shortfall.** The vendor's fee and commission
are not returned, deliberately.

## Nothing breaks

Every change is additive: two new optional request/response fields and one new error code.
Existing clients keep working, and will simply see the new `422` at checkout for a basket that
used to fail silently later.
