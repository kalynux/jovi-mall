# vendor-dash — delivery terms, the product `freeDelivery` key is gone, real delivery money on orders

**Backend change: 2026-10-03 / 2026-10-04 · Not deployed yet.** No migration. Decision record:
[ADR-A11](../../docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md).

---

## ⛔ 1 · BREAKING — the product `freeDelivery` key now answers `400`

Free delivery is no longer a product setting. The product write schemas are `.strict()`, so a create or
update that still sends `delivery.freeDelivery` (layered products) or `freeDelivery` (simple products)
is refused with **`400 VALIDATION_ERROR`** — the whole save, not just that field. References:
[products.md](./products.md), [simple-products.md](./simple-products.md),
[product-upload-flow.md](./product-upload-flow.md).

**What the UI must do:** remove the free-delivery switch from every product form (the advanced
wizard's delivery step / agency selector and quick-add), stop sending the key, and drop it from the
product types. Product reads no longer carry it either. Point the vendor to the new shop setting (§ 2).

## ⭐ 2 · New settings card — Delivery terms

`GET /api/vendor/profile/delivery-terms` · `PUT /api/vendor/profile/delivery-terms` —
[profile.md § Delivery terms](./profile.md#delivery-terms-2026-10-03-adr-a11).

```json
{ "mode": "above", "freeAboveAmount": 20000 }
```

| `mode` | Meaning to show the vendor |
|---|---|
| `always` (default) | "You pay delivery — free for your customers." The agency's fee comes out of your earnings, as before. |
| `never` | "Your customers pay delivery." The fee is added to their order; your earnings are not reduced by it. |
| `above` | "Free delivery from {freeAboveAmount}" — you pay when the customer's items from your shop reach the amount (inclusive), the customer pays below it. |

`freeAboveAmount` is required with `above` and must be `null`/absent otherwise (`400`). PUT replaces the
whole block. Changing terms does **not** pause agency connections and does not affect orders already
placed. Suggested helper copy: *"Even with free delivery, a very small order whose delivery would cost
more than 30% of it is charged to the customer instead of being refused."* (ADR-A07 cap, D-6.)

## 3 · Orders — `shipping` is real, and what you bear is separate

[orders.md](./orders.md) — list and detail:

| Field | Meaning |
|---|---|
| `shipping` (list) / `priceBreakdown.shipping` (detail) | what the **customer** paid for delivery on this order — `0` when your terms made it free. `total = subtotal + shipping`. |
| `priceBreakdown.vendorBorneDelivery` 🆕 | what comes out of **your** net for delivery: the whole agency fee on a free-delivery order, `0` when the customer paid. `null` for digital, or before any fee is priced. |
| `deliveryPayer` / `deliveryPayerReason` 🆕 | who paid delivery and why (`shop_always` · `shop_threshold_met` · `shop_never` · `threshold_not_met` · `cap_fallback`). `deliveryPayer` is also on list rows. |
| `deliveries[].deliveryFee` 🆕 (also `items[].delivery.deliveryFee`) | per shipment: `{ payer, fee, customerPaid, vendorBorne }` — `fee` is what the agency is paid (the approved proposal, else the price posted at checkout). |

**What the UI should do:** on the order detail, show "Delivery paid by the customer: {shipping}" or
"Free delivery — you pay {vendorBorneDelivery}"; on the list, a small "Free delivery" / "Customer paid
delivery" tag from `deliveryPayer`. Remove the per-item "Free delivery" badge that read the deleted
`items[].delivery.freeDelivery`. Your commission is always on the items only; the COD handling fee is
always on the goods only (never on a delivery fee the customer pays the agent).

## 4 · Analytics and statements

Net revenue already deducts only the delivery fee **you** bore (`NET_FORMULA` unchanged; its
`deliveryFee` term now means vendor-borne delivery). No client change.

## 5 · Agency pricing you see

Agency cards (`GET /api/vendor/delivery-agencies…`) carry `max_fee_per_shipment` and
`accepts_cash_delivery_fee` ([delivery-agencies.md](./delivery-agencies.md)); the per-kg and
out-of-region prices are now **charged** — the fee grows with the shipment's weight and when the
drop-off is in another region. Show them as the agency's prices; nothing to compute.

---

**If this page and the backend's observed behaviour disagree, stop and report the difference.**
