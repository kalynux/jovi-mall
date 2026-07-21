# Admin — Platform Earnings

Read-only view of the **singleton platform earnings account** — the marketplace's accumulated
commission — and its append-only ledger. This is the platform's own money account (the counterpart to
vendor/agency earnings).

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required (cookie or `Bearer`) — see [../auth/README.md](../auth/README.md)
- **Permissions**: `admin` only (`requireRole(['admin'])`)
- **Response envelope**: standard `{ success, data, meta? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

> The marketplace never pays *itself* out — there is no payout pipeline for the platform account
> (unlike vendor/agency). These endpoints are for oversight/reporting only.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/earnings/platform` | Current platform balances |
| `GET` | `/admin/earnings/platform/ledger` | Paginated platform earnings ledger |

---

## GET `/admin/earnings/platform`

**Purpose**: Return the platform account's current balances.

**Auth**: Required · **Permissions**: `admin`

### Example success `200`

```json
{
  "success": true,
  "data": {
    "pending": 125000,
    "available": 480000,
    "reserve": 0,
    "requested": 0,
    "currency": "XAF"
  }
}
```

| Field | Meaning |
|---|---|
| `pending` | Commission held in escrow (order not yet completed / hold not released) |
| `available` | Released, withdrawable-in-principle (platform doesn't withdraw, but this is the freed balance) |
| `reserve` | COD rolling-reserve held amount |
| `requested` | Earmarked by a payout request (always `0` for the platform — no platform payouts) |
| `currency` | ISO-4217 (default `XAF`) |

---

## GET `/admin/earnings/platform/ledger`

**Purpose**: Return the platform's append-only earnings ledger, newest first. Every balance movement
(hold, release, reserve, reversal) writes one row.

**Auth**: Required · **Permissions**: `admin`

### Query parameters

| Param | Type | Required | Validation |
|---|---|---|---|
| `page` | integer | ❌ | ≥ 1, default `1` |
| `limit` | integer | ❌ | 1–100, default `20` |

### Example success `200`

```json
{
  "success": true,
  "data": [
    {
      "_id": "664led...",
      "account_id": "664acc...",
      "owner_type": "platform",
      "owner_id": null,
      "entry_type": "hold",
      "amount": 2500,
      "pending_after": 125000,
      "available_after": 480000,
      "source_type": "order",
      "source_id": "664ord...",
      "allocation_id": "664alloc...",
      "reason_code": "order_split",
      "created_at": "2026-07-16T18:20:00.000Z"
    }
  ],
  "meta": { "total": 342, "page": 1, "limit": 20, "pages": 18 }
}
```

| Field | Notes |
|---|---|
| `entry_type` | `hold` \| `release` \| `reserve_hold` \| `reserve_release` \| `reversal` |
| `reason_code` | `order_split` \| `cod_split` \| `hold_release` \| `cod_rolling_reserve` \| `reserve_matured` \| `refund_reversal` |
| `source_type` | Origin of the money movement, e.g. `order` \| `cod_collection` |
| `pending_after` / `available_after` | Account balances immediately after this entry (running balance) |

## Business rules & notes

- Balances and the ledger can never diverge — each mutation writes both inside one transaction.
- Payout-request entries do **not** appear here (the platform has no payouts); the ledger is scoped to
  order/booking/COD-split allocations.

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Non-admin caller |

## Related
- [../vendor/earnings.md](../vendor/earnings.md) · [../agency/earnings.md](../agency/earnings.md) — the per-actor equivalents
- [./payout-requests.md](./payout-requests.md) — admin payout processing
- [./cod.md](./cod.md) — the COD cash chain that feeds these splits
