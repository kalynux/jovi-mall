# Agency Analytics API

**New 2026-09-27.** Implemented in `modules/earnings/analytics/delivery-analytics.service.ts` and
pinned by `npm run test:vendor-analytics` § 5.

**Endpoint:** `GET /api/agency/analytics`. **Auth:** agency role only.

The agency's money and work over a period. Every earnings figure is **read from the entries the
platform actually wrote**, the same entries that fill your balance. They are not estimates.

## Query

| Parameter | Rule |
|---|---|
| `from`, `to` | Local calendar days as `YYYY-MM-DD`. **Both are included.** The range can be at most 366 days. |
| `timezone` | Optional IANA zone. The default is `Africa/Douala`. |

An earning is dated **when it was credited**: at delivery for an online-paid order, and at cash
collection for cash on delivery.

## Response (200)

```json
{
  "success": true,
  "data": {
    "earnings": {
      "deliveriesCredited": 84,
      "deliveryFeesEarned": 126000,
      "codFees": 9400,
      "agentShares": 37800,
      "agencyNet": 97600,
      "byStatus": { "held": 21000, "released": 76600, "reversed": 0 },
      "reversedInPeriod": 0,
      "netEarnings": 97600
    },
    "deliveries": { "delivered": 80, "returned": 3, "failed": 5 },
    "cod": {
      "collectedByAgents": 1850000,
      "depositsConfirmed": 1700000,
      "remittedToPlatform": 1500000,
      "liabilityNow": 350000
    },
    "perAgent": [
      { "agentId": "…", "name": "Paul N.", "deliveriesCredited": 31, "agentShare": 13950, "codCollected": 640000 }
    ],
    "payouts": { "paidInPeriod": 80000, "lifetimePaidOut": 410000 }
  },
  "meta": { "from": "2026-09-01", "to": "2026-09-30", "timezone": "Africa/Douala", "computedAt": "…", "currency": "XAF" }
}
```

| Field | Meaning |
|---|---|
| `earnings.deliveryFeesEarned` | The delivery fees your runs earned, before the agent's share. On a returned online-paid order this is the RTO fee. **`null`** when a cash-on-delivery run has no recorded delivery fee, which means the COD fee cannot be separated from it. |
| `earnings.codFees` | The COD handling fees you kept. It is `null` in the same case as above. |
| `earnings.agentShares` | What your agents were credited out of those fees. |
| `earnings.agencyNet` | What was credited to **you** = fees earned − agents' shares + COD fees. |
| `earnings.byStatus` | Where that money is now: `held` (in escrow), `released` (available) or `reversed`. |
| `earnings.netEarnings` | `agencyNet − reversedInPeriod`. |
| `deliveries` | Shipments that **reached** each outcome during the period, each counted once. |
| `cod` | **Cash is a liability, not income**, so it is reported separately from earnings. `liabilityNow` is what you owe the platform at this moment. |
| `perAgent` | Every agent with credited deliveries or collected cash in the period. |
| `payouts.lifetimePaidOut` | Every payout ever **paid** to the agency, regardless of period. |

A cash-on-delivery shipment that comes back **earns nothing**. No cash was collected, so nothing
is credited. See [earnings.md](./earnings.md).

## Errors

`400 ANALYTICS_INVALID_DATE_RANGE`, `400 ANALYTICS_DATE_RANGE_EXCEEDED` and `400 ANALYTICS_UNSUPPORTED_TIMEZONE`, the same as the vendor analytics.
