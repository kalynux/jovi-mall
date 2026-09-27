# Agent Analytics API

**New 2026-09-27.** Implemented in `modules/earnings/analytics/delivery-analytics.service.ts`.

**Endpoint:** `GET /api/agent/analytics`. **Auth:** agent role only.

What you earned and carried over a period. The earnings figures are **the entries actually
credited to you**, not estimates.

## Query

The parameters are `from` and `to` (local days `YYYY-MM-DD`, both included, at most 366 days) and
`timezone` (optional; the default is `Africa/Douala`). An earning is dated when it was credited:
at delivery for an online-paid order, and at cash collection for cash on delivery.

## Response (200)

```json
{
  "success": true,
  "data": {
    "earnings": {
      "deliveriesCredited": 31,
      "yourShare": 13950,
      "byStatus": { "held": 3000, "released": 10950, "reversed": 0 },
      "reversedInPeriod": 0,
      "netEarnings": 13950
    },
    "deliveries": { "delivered": 30, "returned": 1, "failed": 2 },
    "cod": { "collected": 640000, "handedOverConfirmed": 600000, "cashHeldNow": 40000 },
    "payouts": { "paidInPeriod": 10000, "lifetimePaidOut": 52000 }
  },
  "meta": { "from": "2026-09-01", "to": "2026-09-30", "timezone": "Africa/Douala", "computedAt": "…", "currency": "XAF" }
}
```

- `cod` is **cash you carry for the platform**, not income. `cashHeldNow` is your current cash balance, across every agency you serve.
- `deliveries` counts shipments that reached each outcome during the period.
- A returned cash-on-delivery shipment earns nothing.

## Errors

The errors are the same as for the vendor and agency analytics (`ANALYTICS_*`, 400).
