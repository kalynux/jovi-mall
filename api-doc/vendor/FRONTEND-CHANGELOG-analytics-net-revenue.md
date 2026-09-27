# Vendor dashboard: net revenue, analytics rebuild and a summable transactions feed (2026-09-27)

**Audience:** vendor-dash. **⚠ Breaking** on all four `/api/vendor/analytics/*` endpoints.
Contracts: [vendor/analytics.md](./analytics.md) and [vendor/transactions.md](./transactions.md).

## Why

The old analytics could not be reconciled with the wallet:

- **"Net revenue" had no deductions.** It was order totals minus refunds, with no commission, bargain fee, delivery fee or COD fee taken off.
- **Refunds were subtracted twice** in some cases.
- **Cash-on-delivery sales were almost never counted.**
- **The last day of every range was dropped.**
- **Product titles** always read "Unknown Product".
- **Customer counts** were inflated.

The figures now come from the earnings records, the same ones that fill the wallet. Finished days
are pre-computed at night and today is calculated live, so the figures are always current.

## 1. Analytics: what changed on the wire

| Before | Now |
|---|---|
| `data.sales.gmv` | `data.sales.grossSales` |
| `data.sales.refunds` | Removed from `sales`. Customer refunds are `data.refunds.{count, amount}`, for information. The effect on earnings is `data.adjustments.earningsReversed`. |
| `data.sales.netRevenue` = gmv − refunds | `data.sales.netRevenue` = **gross − bargainFee − commission − deliveryFee − codFee** |
| (none) | **New:** `bargainFee`, `commission`, `deliveryFee`, `codFee`, `deliveryAndCodFees`. `deliveryFee`/`codFee` can be `null`; when they are, show `deliveryAndCodFees`. |
| `data.sales.aov` = net / count | `aov` = **gross** / distinct orders |
| `data.bookings.{count, revenue}` | `data.bookings.{count, grossRevenue, commission, netRevenue}` |
| (none) | **New:** `data.adjustments.{deliveryFeesReturned, earningsReversed}` and `data.netEarnings` |
| `/sales` with `breakdown=none`: `data.{gmv, …}` | `data.totals.{…}` |
| `/sales` with `breakdown=daily`: `data.daily[]` only | `data.totals` **and** `data.daily[]`. Every day of the range is present, and a quiet day has zeros. |
| `meta.lastCalculatedAt` | Removed. Use `meta.computedAt`. |
| `meta.from`/`meta.to` as ISO timestamps | `YYYY-MM-DD`, both days included |
| `503 ANALYTICS_AGGREGATION_NOT_READY` | No longer raised. An empty period is `200` with zeros. |
| `timezone` ignored | `timezone` is **applied**. |
| `/products`: `productTitle` = "Unknown Product" | The real title. The row also has `productId` and `sku`. `orderCount` counts orders, not lines. |
| `/customers`: `total`, `repeat` summed per day | Distinct over the period. `repeatRate` has one decimal place. |

## 2. Transactions feed (`GET /api/vendor/transactions`)

- **`direction` can now be `internal`.** It means money moved between your own balances: an escrow release, a pending, rejected or failed payout, or a COD reserve move. Before this change a sale's hold and its release were both `in`, so **every sale was counted twice** in any sum.
- **`category=payout` now returns your payout requests.** It used to always be empty.
- Descriptions are clearer: "Sale credited from an online order — held in escrow", "Payout sent (mobile_money)", and so on.

## 3. Work to do in vendor-dash

- [ ] **Analytics types and API client:** rename `gmv` → `grossSales`, and read `/sales` totals from `data.totals`. Add the new fields.
- [ ] **Dashboard summary:** show gross sales, then each deduction on its own line (bargain fee, commission, delivery fee, COD fee), then **net revenue** in bold. When `deliveryFee` or `codFee` is `null`, show one "Delivery + COD fees" line from `deliveryAndCodFees`.
- [ ] **Show `netEarnings`,** with `adjustments` (delivery fees returned, earnings reversed) as secondary lines. Show `refunds` as information only; it is already reflected in `earningsReversed`.
- [ ] **Remove the "analytics not ready / 503" state** and treat an empty period as zeros.
- [ ] **Date pickers:** send `YYYY-MM-DD`. The `to` day is now included, so remove any "+1 day" workaround.
- [ ] **Daily chart:** it can rely on one row per day and no longer needs gap filling.
- [ ] **Top products:** show `productTitle` and optionally `sku`. `orderCount` is the number of orders.
- [ ] **Transactions tab:** leave `internal` rows out of any total. Render them without a +/− sign and muted. A "Payouts" filter (`category=payout`) now works.
- [ ] Optionally show `meta.netFormula` as a tooltip on the net revenue figure.

Nothing else in vendor-dash is affected. Account statements are sent by administrators; there is no vendor-side screen for them.
