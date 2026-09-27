# Vendor Analytics API

**Rebuilt 2026-09-27. ⚠ BREAKING for every consumer — read the [changelog](./FRONTEND-CHANGELOG-analytics-net-revenue.md) first.**
Verified against `modules/vendors/services/vendor-analytics.service.ts`,
`controllers/vendor-analytics.controller.ts`, `validators/analytics.validator.ts` and
`analytics/net-revenue.ts`. Pinned by `npm run test:vendor-analytics`.

**Base Path:** `/api/vendor/analytics`

**Authentication Required:** Yes, **vendor role only.** Any other role gets `403 AUTH_ROLE_NOT_FOUND`.

---

## What the numbers mean

These endpoints report the **money that reached your earnings**. They are read from the
platform's earnings records, the same records that fill your wallet.

**Finished days are pre-computed at night; today is always calculated live.** A nightly job stores
each finished day, computed from those earnings records, and a request calculates only today
(plus any day the job has not covered yet). A finished day cannot change afterwards, because
every sale is dated when its money arrived. So the figures are always current, and the result is
the same as a fully live calculation. This replaced the old nightly snapshot of *orders*, which
missed cash-on-delivery sales.

| Term | Meaning |
|---|---|
| **Gross sales** | What customers paid: the order total (online) or the cash collected (cash on delivery). |
| **Bargain fee** | The platform's 30% share of the amount agreed **above your floor price** on bargained items. Nothing is charged on a sale at the listed price. |
| **Commission** | Your plan's commission, taken on gross − bargain fee. |
| **Delivery fee** | The delivery charged for the shipment, which is taken out of your side of the sale. |
| **COD fee** | The agency's cash-handling fee, on cash-on-delivery sales only. |
| **Net revenue** | **gross − bargain fee − commission − delivery fee − COD fee.** This is what was credited to your earnings. `meta.netFormula` states the formula. |

**When a sale is counted: the day the money was received.** For an online order, that is when
it was paid. For cash on delivery, it is when the agent collected the cash. The date the order
was placed does not matter, so a cash-on-delivery order placed on the 28th and collected on the
2nd counts on the 2nd.

**The same figures appear on the account statement** that support can email you. Both use the
same formula on the same records, so your dashboard and your statement agree.

### Date range

| Parameter | Rule |
|---|---|
| `from`, `to` | Your **local calendar days**, as `YYYY-MM-DD`. **Both are included.** A full ISO timestamp is accepted too, and only its date part is used. |
| `timezone` | Optional IANA zone. It defaults to your profile's timezone, then `Africa/Douala`. **It is applied**: it decides which local day each sale falls on. |
| Range | At most **366 days**. `from` must not be after `to`. |
| `fiscalCalendar` | `gregorian` only. |

### No more "not ready"

An empty period answers **200 with zeros**. `503 ANALYTICS_AGGREGATION_NOT_READY` is no longer
raised by these endpoints, because a live read has nothing to wait for.

### Response envelope

These four responses have **no `success` key**. The body is `{ data, meta }`. Errors still use
the standard `{ success: false, error }` envelope.

Every response includes this `meta`:

```json
{
  "from": "2026-09-01",
  "to": "2026-09-30",
  "timezone": "Africa/Douala",
  "computedAt": "2026-09-27T10:15:02.114Z",
  "netFormula": "net = gross - bargainFee - commission - deliveryFee - codFee",
  "fiscalCalendar": "gregorian"
}
```

---

## Endpoints

### GET /api/vendor/analytics/dashboard

```json
{
  "data": {
    "sales": {
      "grossSales": 1250000,
      "bargainFee": 18000,
      "commission": 61600,
      "deliveryFee": 84000,
      "codFee": 9000,
      "deliveryAndCodFees": 93000,
      "netRevenue": 1077400,
      "orderCount": 52,
      "aov": 24038
    },
    "bookings": { "count": 4, "grossRevenue": 80000, "commission": 4000, "netRevenue": 76000 },
    "adjustments": { "deliveryFeesReturned": 1500, "earningsReversed": 12000 },
    "netEarnings": 1142900,
    "refunds": { "count": 1, "amount": 12500 }
  },
  "meta": { "...": "see above", "currency": "XAF" }
}
```

| Field | Notes |
|---|---|
| `sales.deliveryFee`, `sales.codFee` | **`null`** when at least one cash-on-delivery sale in the period has no recorded delivery fee, so the two cannot be separated. `deliveryAndCodFees` always has the combined figure. Render the combined figure when either one is `null`. |
| `sales.orderCount` | Distinct **orders** with money received in the period. A cash-on-delivery order split into two shipments counts once. |
| `sales.aov` | Average **gross** per order, which is what a customer spent (not what you kept). |
| `adjustments.deliveryFeesReturned` | Delivery fee given back to you when a shipment earned less than was reserved, e.g. a return. |
| `adjustments.earningsReversed` | Earnings taken back in the period, e.g. after a full refund. |
| `netEarnings` | `sales.netRevenue + bookings.netRevenue + deliveryFeesReturned − earningsReversed`: what this period added to your earnings. |
| `refunds` | Refunds **paid to customers** in the period. This is for information only; the effect on your earnings is already in `adjustments.earningsReversed`. |

### GET /api/vendor/analytics/sales

Extra parameter: `breakdown`, either `none` (the default) or `daily`.

```json
{
  "data": {
    "totals": { "grossSales": 1250000, "...": "same shape as dashboard.sales" },
    "daily": [
      { "date": "2026-09-01", "grossSales": 42000, "bargainFee": 0, "commission": 2100, "deliveryFee": 3000, "codFee": 0, "deliveryAndCodFees": 3000, "netRevenue": 36900, "orderCount": 2, "aov": 21000 },
      { "date": "2026-09-02", "grossSales": 0, "...": "zeros" }
    ]
  },
  "meta": { "...": "see above", "breakdown": "daily" }
}
```

`daily` has **one row for every day** of the range, and a day with no sales has zeros instead of
being left out. `daily` is present only when `breakdown=daily`.

### GET /api/vendor/analytics/products

Extra parameter: `limit`, from 1 to 50. The default is 5, and any out-of-range value falls back to 5.

```json
{
  "data": {
    "topByRevenue": [
      { "variantId": "…", "productId": "…", "productTitle": "Wax print dress", "sku": "WAX-01-M", "revenue": 180000, "quantity": 12, "orderCount": 9 }
    ],
    "topByQuantity": [ "…same shape…" ]
  },
  "meta": { "...": "see above", "limit": 5 }
}
```

- `revenue` is the line value at the price the customer **actually paid**, which is the negotiated price when the item was bargained. Deductions are per order, so they are on `/sales`, not here.
- An order's items are counted **once**, in the period when its first payment arrived.
- `orderCount` is distinct orders, not order lines.
- `productTitle` is the real title stored on the order.

### GET /api/vendor/analytics/customers

```json
{ "data": { "total": 38, "repeat": 6, "repeatRate": 15.8 }, "meta": { "...": "see above" } }
```

- `total` is the number of **distinct** customers over the whole period.
- `repeat` is customers with **two or more** orders whose money arrived in this period.
- `repeatRate` is a percentage with one decimal place.

---

## Error codes

| Status | Code | When |
|---|---|---|
| 400 | `ANALYTICS_INVALID_DATE_RANGE` | `from`/`to` is not a real date, or `from` is after `to`. |
| 400 | `ANALYTICS_DATE_RANGE_EXCEEDED` | The range is longer than 366 days. |
| 400 | `ANALYTICS_UNSUPPORTED_TIMEZONE` | `timezone` is not a valid IANA zone. |
| 400 | `VALIDATION_ERROR` / `VENDOR_UNSUPPORTED_FISCAL_CALENDAR` | The fiscal calendar is not `gregorian`. |
| 403 | `AUTH_ROLE_NOT_FOUND` | The caller is not a vendor. |

---

## Examples

```
GET /api/vendor/analytics/dashboard?from=2026-09-01&to=2026-09-30
GET /api/vendor/analytics/sales?from=2026-09-21&to=2026-09-27&breakdown=daily
GET /api/vendor/analytics/products?from=2026-09-01&to=2026-09-30&limit=10
GET /api/vendor/analytics/customers?from=2026-07-01&to=2026-09-30&timezone=UTC
```
