# Public storefront — free delivery is the shop's terms, not a product flag

**Backend change: 2026-10-03 / 2026-10-04 · Not deployed yet.** No migration. Decision record:
[ADR-A11](../../docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md). The signed-in half (cart quote, checkout,
orders) is [`../customer/FRONTEND-CHANGELOG-customer-paid-delivery.md`](../customer/FRONTEND-CHANGELOG-customer-paid-delivery.md).

---

## 1 · `freeDelivery` is DERIVED; `deliveryTerms` is the truth

On the product rows (`GET /api/public/products`, a store's products), the product detail and the
store reads ([catalog.md](./catalog.md) — `deliveryTerms` note):

```jsonc
"freeDelivery": false,                                     // true ONLY when deliveryTerms.mode === "always"
"deliveryTerms": { "mode": "above", "freeAboveAmount": 20000 }
```

| `deliveryTerms.mode` | Badge / line to render |
|---|---|
| `always` | **"Free delivery"** (and `freeDelivery: true`) |
| `above` | **"Free delivery from {freeAboveAmount}"** — free once the basket holds that much **from this shop** (inclusive) |
| `never` | nothing on the card; on the product page at most "Delivery fee shown at checkout" — **never a number** (the fee depends on the delivery company, the basket's weight and the address) |

A shop that never set its terms reads `always`, which is the old behaviour. There is no per-product
free-delivery flag any more; the product's own `freeDelivery` can no longer be `true` for an `above`
shop (the badge would promise what the basket may not reach).

## ⛔ 2 · "Delivery included" is now WRONG

The product page's delivery row (`value={p.freeDelivery ? t("deliveryFree") : t("deliveryIncluded")}`
in the landing app) and the cart/checkout "Delivery included" lines described the old world where every
shop paid delivery. Replace them with the table above on product pages, and with the per-shop delivery
lines of the cart quote on the cart/checkout (customer changelog § 1).

## 3 · Unchanged

- `freeDelivery` is still not filterable on `GET /api/public/products`.
- Cache headers, envelope and every other field are unchanged.

---

**If this page and the backend's observed behaviour disagree, stop and report the difference.**
