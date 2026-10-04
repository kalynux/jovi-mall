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

## 4 · Not in this release

- **Fee changes after checkout** (an agency proposing a different fee on a customer-paid parcel; the
  customer approving an increase or receiving a decrease) — a separate change; its customer endpoints
  are documented with it.
- **Paying the delivery fee in cash to the rider on an online order** — a later wave
  (`accepts_cash_delivery_fee` on agencies is stored but not honoured yet).

---

**If this page and the backend's observed behaviour disagree, stop and report the difference
(endpoint, request, observed response, doc line) rather than guessing which one is right.**
