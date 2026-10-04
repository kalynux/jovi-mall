# Customer app & storefront checkout — the customer may now pay delivery

**Backend change: 2026-10-03 / 2026-10-04 · Not deployed yet.** No migration is needed for anything
on this page. Decision record: [ADR-A11](../../docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md).

The signed-in half of the shop (cart, checkout, order history) and the bots' checkout. Its
unauthenticated half (product cards, product page, store page) is
[`../public/FRONTEND-CHANGELOG-customer-paid-delivery.md`](../public/FRONTEND-CHANGELOG-customer-paid-delivery.md).

---

## What changed, in one paragraph

Until now delivery was free to every customer on every order: the shop paid the agency out of its
earnings, and the quote's `delivery` was always `0`. **Free delivery is now each shop's setting** —
`always` (the shop pays, the default for every shop), `never` (the customer pays) or `above` (free
once the customer's items **from that shop** reach an amount). Where the customer pays, the fee is the
delivery company's posted price for that parcel (weight, region), it is **added to the order total**,
and it is charged with the items (online) or paid to the agent in cash with the goods (COD). One more
case: a free-delivery shop whose part of the basket is too small to carry its fee no longer refuses the
order — it falls back to customer-paid delivery and tells the customer how much more makes it free.

## ⛔ 1 · Cart & checkout — stop saying "Delivery included"

`POST /api/customer/cart/quote` — full contract and example in
[cart.md](./cart.md#post-apicustomercartquote).

| Field | Now |
|---|---|
| `delivery` | what the customer pays for delivery (Σ customer-paid shops) — **real, often non-zero** |
| `total` | `subtotal + delivery` — still exactly what checkout charges. **Never add anything to it.** |
| `perVendor[].delivery` / `.total` | per shop |
| `perVendor[].deliveryPayer` | `vendor` (free) · `customer` · `null` (digital-only shop) |
| `perVendor[].deliveryPayerReason` | `shop_always` · `shop_threshold_met` · `shop_never` · `threshold_not_met` · `cap_fallback` |
| `perVendor[].freeDelivery` | `{ mode, freeAboveAmount, shortfall }` — `shortfall` = how much more **from that shop** makes delivery free (`null` when n/a) |
| `perVendor[].shipments[]` | `{ agencyId, weightGrams, outOfRegion, fee, components }` — one per delivery company (optional breakdown) |
| `regionKnown` | `false` ⇒ priced without a drop-off region; the fee may rise once the address is chosen |
| `absorbedByVendor` | unchanged meaning (what free-delivery shops pay their agencies) — **never show it** |

**What the UI should do:**
- Replace the blanket "Delivery included" line with **one delivery line per shop**: the formatted
  `perVendor[].delivery`, or **"Free delivery"** when it is `0`. Show the grand `delivery` above the
  total if you have a receipt layout.
- When `freeDelivery.shortfall` is a positive number, show a non-blocking hint under that shop:
  **"Add {shortfall} more from {shop} for free delivery."** Never a button that blocks checkout.
- **Remove** any "the seller covers {absorbedByVendor}" line — it was always internal, and is now
  misleading.
- Re-quote with `deliveryAddressId` when the customer picks an address (the out-of-region part of the
  fee depends on it).
- `meetsDeliveryMinimum: false` / `422 ORDER_BELOW_DELIVERY_MINIMUM` still exist but are now **rare**
  (only when the shop would earn nothing even with the customer paying delivery). Keep the handling.

## 2 · Orders — `priceBreakdown.delivery`, `deliveryPayer`, `deliveryFees[]`

`GET /api/customer/orders/:id` and `GET /api/customer/orders/groups/:cartId` — every order object gains
(contract: [orders.md](./orders.md#what-every-order-object-now-carries)):

```jsonc
"priceBreakdown": { "base": 15000, "delivery": 1500, "tax": 0, "discount": 0, "total": 16500 },
"deliveryPayer": "customer",               // "vendor" = free delivery · null on digital orders
"deliveryPayerReason": "threshold_not_met",
"deliveryFees": [                          // one per parcel; [] on digital orders
  { "shipmentId": "507f…100", "amount": 1500 },
  { "shipmentId": "507f…101", "amount": 0, "customerFeeRefundable": 800 }   // present only when > 0
]
```

- Receipt: items (`base`), **Delivery** (`delivery`, or "Free"), total. `total` = `base + delivery`.
- `customerFeeRefundable` — delivery money owed back to the customer (a returned parcel's unspent fee,
  or a fee lowered after payment). Show it as "Delivery refund due: X" on that parcel if you like; how
  it is paid back is documented with the delivery-fee changes after checkout.
- **COD:** each `codCollections[]` entry now carries `itemsAmount` + `deliveryFeeAmount` beside
  `expectedAmount` (their sum). The cash to hand the agent is still `expectedAmount`; you may show
  "of which delivery X".
- The removed `items[].freeDelivery` (2026-10-03) stays removed.

## 3 · Telegram Mini App & the chat checkout — already done server-side

The bot's screens are rendered by the backend; nothing to build, listed so you know what customers see:

- **Chat checkout confirmation** (`checkout_review`): a delivery line per shop before the total —
  "Delivery: 1 500 XAF" / "Delivery: Free", or "Delivery · {shop}: …" with several shops — and the
  hint "Add X more and delivery is free." The total includes delivery. With several saved addresses and
  a customer-paid fee, tapping an address now opens that address's own confirmation (the fee depends on
  the region) instead of placing at once.
- **Telegram checkout page** (`co.html`): `GET …/co/:handle/data` gains
  `delivery: [{ label, valueText, hint }]`, drawn as rows above the total. The page computes nothing.
- **Order screen** (`ol.html`): a group card gains `deliveryText` ("Incl. 1 500 XAF delivery").
- **Product cards and the product screen**: "Free delivery" / "Free delivery from 20 000 XAF" from the
  shop's terms; nothing for a shop that charges delivery.
- **Bargaining agent**: promises free delivery only when the shop's terms give it; never quotes a fee.

## 4 · Fee changes after checkout — SHIPPED 2026-10-04 (W-E)

Full contract: **[delivery-fee-changes.md](./delivery-fee-changes.md)**. On a parcel whose delivery the
customer pays, the delivery company (or the shop, by moving the parcel to another company) may change
the fee before pickup:

- **Decrease** → applied at once, nothing to do; the difference is refunded (online) or the cash to
  collect drops (COD / cash-to-rider). Show it from `refunds` + the notification.
- **Increase** → waits for the customer. Order detail screen: call
  `GET /api/customer/orders/:id/delivery-fee-proposals`, render each pending row with its
  `availableActions` (`approve` · `reject` · `pay`). Approve/reject send the `version` you displayed
  (a `409` means the figure changed — re-fetch and re-show). An approved increase on an ONLINE order
  needs a **top-up payment**: `POST …/:proposalId/pay` (same body/flow as `/payments/initiate`); pickup
  waits until it is paid.
- **Combined price** → on a checkout with ≥2 customer-paid parcels carried by one company, offer
  "Ask for a combined delivery price": `POST /api/customer/orders/groups/:cartId/combined-delivery-requests`
  (+ list / cancel). The company answers by lowering fees or declining.
- New notifications (not mutable): approval needed, top-up due, fee lowered, fee updated, refund
  pending, top-up failed, combined price answered — deep-link to the order.

## 5 · 2026-10-04 (W-E2) — delivery money owed back, and when it clears

- **Order reads** (`GET /api/customer/orders/:id`, the group read) gain
  `deliveryFeeRefund: { owed, returned } | null` — delivery money owed back to the customer on that
  order (`null` when none ever was). `owed` is what has not reached them yet, including money our team
  must send by hand; it drops to 0 when the refund completes or the team records the hand payment.
  ⚠ Use this, not `deliveryFees[].customerFeeRefundable`, for "still owed": the per-parcel figure is
  the gross amount that became theirs and does not shrink once returned.
- **`GET /api/customer/orders/:id/delivery-fee-proposals`**: `refunds.owed` now **includes** money
  waiting to be sent by hand (it read 0 during that wait — the defect this fixes); new
  `refunds.returned`, `refunds.awaitingManual`, and `entries[].settledByHand`. Contract:
  [delivery-fee-changes.md](./delivery-fee-changes.md).
- **New notification** `order.delivery_fee.refund_settled` (cannot be muted): "We have sent you X of
  delivery money for order N". Follows `order.delivery_fee.refund_pending`.

## 6 · 2026-10-04 (W-F) — pay the items online, the delivery fee in cash to the rider

Where a shop charges delivery (customer-paid) and EVERY delivery company carrying that shop's items
accepts it, an online checkout may pay the **items now** and hand the **delivery fee to the rider in
cash**. Additive and optional — nothing changes for a client that does not use it.

- **Quote** (`POST /api/customer/cart/quote`): new `deliveryFeeCash` at the top level —
  `{ available, reason, amountDueOnline, amountDueToRider, vendorIds[] }` — and per shop
  `perVendor[].deliveryFeeCash: { available, reason, amountDueOnline, amountDueToRider } | null`
  (`null` for a digital shop). `reason` when not available: `cash_on_delivery` ·
  `not_customer_paid` (the shop pays delivery) · `no_delivery_fee` · `agency_declines_cash`.
  Offer the choice only when the TOP-LEVEL `available` is true; show `amountDueOnline` as what will
  be charged now and `amountDueToRider` as the cash for the rider. Never compute either.
- **Checkout** (`POST /api/customer/orders/checkout`): new optional body field
  `deliveryFeePayment: "with_order" | "cash_to_rider"` (default `with_order`). `cash_to_rider` is
  only valid with `paymentMethod: "online"` and is refused with
  `422 DELIVERY_FEE_CASH_NOT_AVAILABLE` (`details.reason` as above, `vendorId`, `agencyIds`) when
  it cannot be honoured. A shop that pays its own delivery is unaffected (nothing to pay). The 201
  gains per order `deliveryFeePayment` and `deliveryCashToRider`; `total` is what will be charged
  online. Pay with `POST /api/payments/initiate` as usual — it charges the items only.
- **Order reads**: `total` / `priceBreakdown.total` = what was charged online (the items);
  `priceBreakdown.delivery` = 0 and new `priceBreakdown.deliveryCash` = the delivery fee(s) for the
  rider; new `deliveryFeePayment` (`with_order` | `cash_to_rider` | `null` on digital) and
  `amountDueToRider` (cash still to hand over: parcels not yet delivered). `deliveryFees[]` keep the
  fee per parcel and carry `paidInCash: true` on a parcel paid in cash (absent otherwise).
- **Delivery code**: each cash parcel has an entry in `codCollections[]` — exactly like cash on
  delivery, with `kind: "delivery_fee"`, `itemsAmount: 0`, `deliveryFeeAmount` = `expectedAmount` =
  the fee, and the `deliveryCode` while pending. The customer gives the code to the rider when they
  hand over the fee; the parcel is then delivered (there is no "confirm delivery" for such a parcel —
  `POST …/confirm-delivery` answers `422 SHIPMENT_CONFIRMATION_NOT_ALLOWED`).
- **Fee changes after checkout** on such a parcel work like cash on delivery: a decrease lowers the
  cash for the rider (no refund), an approved increase raises it (no top-up payment).
- **Refunds** of the order return what was charged online; the cash fee is not part of them.
- **Notifications**: the code arrives as for cash on delivery ("amount to pay in cash on delivery" =
  the fee); "out for delivery" says "your items are paid — have X ready in cash for the delivery fee".

---

**If this page and the backend's observed behaviour disagree, stop and report the difference
(endpoint, request, observed response, doc line) rather than guessing which one is right.**
