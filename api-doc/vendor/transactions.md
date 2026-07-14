# Vendor Transactions API

A single, unified feed of every money/credit movement on the vendor's account —
plan purchases, credit top-ups, credit usage, and sales earnings. **This replaces
the old separate histories**: `GET /credits/ledger`, `GET /credits/topups`,
`GET /plan-purchases`, and `GET /earnings/ledger` (all removed). Balance and
current-state endpoints (`GET /credits`, `GET /plan`, `GET /earnings`) are unchanged
— see [**Vendor Earnings API**](./earnings.md) for how the `/earnings` balance is computed.

## Base Path
```
/api/vendor/transactions
```

## Authentication
Requires a vendor Bearer token; the feed is scoped to the authenticated vendor.

---

### GET /api/vendor/transactions

**Description**: Newest-first, paginated feed merging all transaction categories.
Top-ups appear **once** (as a `credit` money row) — the duplicate credit-ledger
entry is filtered out.

**Query Parameters**:
- `page` (integer, optional, default `1`).
- `limit` (integer, optional, default `20`, max `100`).
- `category` (string, optional) — filter to one of `plan`, `credit`, `earning`, `payout`.
  Omit for everything. (`payout` is a placeholder — empty until cash-out is built.)

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "id": "66cc01",
      "category": "plan",
      "type": "plan_purchase",
      "status": "paid",
      "unit": "money",
      "direction": "out",
      "amount": 5000,
      "currency": "XAF",
      "description": "Plan purchase — growth",
      "gateway": "STRIPE",
      "source": { "type": "plan", "id": "growth" },
      "createdAt": "2026-06-24T14:00:00.000Z"
    },
    {
      "id": "66bb02",
      "category": "credit",
      "type": "credit_topup",
      "status": "paid",
      "unit": "money",
      "direction": "out",
      "amount": 600,
      "currency": "XAF",
      "credits": 100,
      "description": "Credit top-up — 100 credits (pack_100)",
      "gateway": "NOTCHPAY",
      "source": { "type": "pack", "id": "pack_100" },
      "createdAt": "2026-06-24T12:00:00.000Z"
    },
    {
      "id": "66aa01",
      "category": "credit",
      "type": "credit_usage",
      "status": "completed",
      "unit": "credit",
      "direction": "out",
      "amount": 1,
      "credits": 1,
      "description": "Product vectorisation",
      "source": { "type": "credit", "id": "prod_123" },
      "createdAt": "2026-06-24T11:00:00.000Z"
    },
    {
      "id": "66ee10",
      "category": "earning",
      "type": "earning_hold",
      "status": "hold",
      "unit": "money",
      "direction": "in",
      "amount": 4500,
      "currency": "XAF",
      "description": "Earning held from order sale",
      "source": { "type": "order", "id": "66dd01" },
      "createdAt": "2026-06-24T10:00:00.000Z"
    }
  ],
  "meta": { "total": 4, "page": 1, "limit": 20, "totalPages": 1 }
}
```

**Field reference** (normalized across all sources):

| Field | Meaning |
|---|---|
| `id` | Source document id |
| `category` | `plan` \| `credit` \| `earning` \| `payout` |
| `type` | `plan_purchase`, `credit_topup`, `credit_allowance`, `credit_usage`, `credit_adjustment`, `earning_hold`, `earning_release`, `earning_reversal` |
| `status` | Source status — money txns: `pending`/`paid`/`failed`/`reversed`; earnings: `hold`/`release`/`reversal`; credit moves: `completed` |
| `unit` | `money` (has `currency`) or `credit` (credit units) |
| `direction` | `in` (value into the vendor) or `out` (value leaving) |
| `amount` | Positive magnitude in `unit` — use `direction` for sign |
| `currency` | Present when `unit === "money"` |
| `credits` | Credits granted (top-up) or the magnitude of a credit move |
| `description` | Human-readable label |
| `gateway` | Payment gateway, for billing rows |
| `source` | `{ type, id }` of the originating entity (plan code, pack code, order/booking id, `cod_collection` id, etc.) |
| `createdAt` | ISO timestamp (feed is sorted by this, desc) |

> **Cash-on-delivery earnings** appear as ordinary `earning_hold`/`earning_release` rows, but with
> `source.type: "cod_collection"` — one per COD **shipment** (the cash handoff), rather than one
> per order. Their release additionally waits for the physical cash to be remitted up the delivery
> chain, so COD earnings can sit in `hold` longer than online ones (see
> [orders.md — Cash-on-delivery orders](./orders.md)).

**How to render a "Transactions" tab:**
- Group/colour by `category`; show a sign from `direction` (`out` = debit, `in` = credit).
- For `unit: "money"` rows show `amount` + `currency`; for `unit: "credit"` rows show
  `±amount` credits.
- Top-up rows (`type: credit_topup`) carry both the money `amount` and the `credits` granted.
- `status: reversed` (top-up/plan) or `earning_reversal` rows are chargeback/refund unwinds.
- Use `?category=` to power sub-tabs (Plans / Credits / Earnings) without separate endpoints.

**Error Responses**: `400 VALIDATION_ERROR` (bad `page`/`limit`/`category`), `401`, `403`.

---

## Migration note (frontend)

| Removed endpoint | Use instead |
|---|---|
| `GET /api/vendor/credits/ledger` | `GET /api/vendor/transactions?category=credit` |
| `GET /api/vendor/credits/topups` | `GET /api/vendor/transactions?category=credit` |
| `GET /api/vendor/plan-purchases` | `GET /api/vendor/transactions?category=plan` |
| `GET /api/vendor/earnings/ledger` | `GET /api/vendor/transactions?category=earning` |

The POST actions (`/credits/topups`, `/plans/:planId/purchase`, the `/verify` routes) and the
balance endpoints (`/credits`, `/plan`, `/earnings`) are unchanged.
