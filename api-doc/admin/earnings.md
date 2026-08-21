# Admin — Platform Earnings & owner balances

> ## ⚠️ This surface moved at the Phase 5 cutover — read this before the routes below
>
> **The public mount `/api/admin/earnings` is DELETED.** It was served to any platform session
> whose `users` row carried `roles: ['admin']` — jovi-mall's second authorization model, which
> carried no tier, no permission set and no audit identity. That model is retired.
>
> **The routes themselves are unchanged and still live, at `/api/internal/admin/earnings`**, behind
> `requireAdminCaller` (a service token plus `X-Actor-*` headers, never a user session). One
> factory always served both mounts, so every path, payload and response below is still exact —
> only the prefix and the guard changed. **Every path in this document has been rewritten to
> the internal prefix**, so what you read here is what the service answers.
>
> **If you are building a dashboard, this is not your document.** Call wi-admin's `/api/v1/money` instead — it resolves the
> administrator's tier and permissions, writes the audit row, and calls this surface on your
> behalf. See [internal-service-api.md](./internal-service-api.md) for the door itself, and
> `admin/docs/api/` in the wi-admin repository for the dashboard contract.

---

Read-only view of the **singleton platform earnings account** — the marketplace's accumulated
commission — and its append-only ledger, plus the **per-owner balances** ("what do we owe this
vendor / agency / agent").

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required (cookie or `Bearer`) — see [../auth/README.md](../auth/README.md)
- **Permissions**: `admin` only (`requireRole(['admin'])`)
- **Response envelope**: standard `{ success, data, meta? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

> The marketplace never pays *itself* out — there is no payout pipeline for the platform account
> (unlike vendor/agency). These endpoints are for oversight/reporting only.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/internal/admin/earnings/platform` | Current platform balances |
| `GET` | `/internal/admin/earnings/platform/ledger` | Paginated platform earnings ledger |
| `GET` | `/internal/admin/earnings/accounts` | Every owner's balances, ranked by what is withdrawable |
| `GET` | `/internal/admin/earnings/balances/:ownerType/:ownerId` | One owner's four balances |

> **These four routes used to be mounted publicly at `/api/admin/earnings/*` as well**, behind
> `requireAuth + requireRole(['admin'])`. That mount was deleted at the Phase 5 cutover — one
> factory served both and now serves one. `src/modules/earnings/routes/admin-earnings.routes.ts`
> still exports the factory; only the public instantiation went.

> **`platform` is not a valid `:ownerType`.** The vocabulary on `/accounts` and `/balances` is
> `vendor · agency · agent` only. The commission account has its own endpoint because it answers a
> different question — what the marketplace *earned*, not what it *owes* — and putting it in a
> ranking of liabilities would make the biggest row mean the opposite of the rest.

---

## GET `/internal/admin/earnings/platform`

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

## GET `/internal/admin/earnings/platform/ledger`

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

---

## GET `/internal/admin/earnings/accounts`

**Purpose**: Every owner account the platform holds money for, **sorted by `available` descending**
(ties broken by `_id`) — i.e. ranked by what is withdrawable right now.

**Auth**: Required · **Permissions**: `admin`

### Query parameters

| Param | Type | Required | Validation |
|---|---|---|---|
| `ownerType` | string | ❌ | `vendor` \| `agency` \| `agent`. Omit for all three |
| `page` | integer | ❌ | ≥ 1, default `1` |
| `limit` | integer | ❌ | 1–100, default `20` |

### Example success `200`

```json
{
  "success": true,
  "data": [
    {
      "ownerType": "vendor",
      "ownerId": "664ven...",
      "pending": 34000,
      "available": 210000,
      "reserve": 0,
      "requested": 0,
      "currency": "XAF",
      "updatedAt": "2026-08-11T09:12:00.000Z"
    }
  ],
  "meta": { "total": 87, "page": 1, "limit": 20, "pages": 5 }
}
```

---

## GET `/internal/admin/earnings/balances/:ownerType/:ownerId`

**Purpose**: One owner's four balances.

**Auth**: Required · **Permissions**: `admin`

### Path parameters

| Param | Validation |
|---|---|
| `ownerType` | `vendor` \| `agency` \| `agent` — anything else is `400 VALIDATION_ERROR` |
| `ownerId` | 24-hex ObjectId |

### Example success `200`

```json
{
  "success": true,
  "data": {
    "ownerType": "agency",
    "ownerId": "664agy...",
    "pending": 12000,
    "available": 45000,
    "reserve": 3000,
    "requested": 0,
    "currency": "XAF"
  }
}
```

> **Zeroes, never a 404.** An owner with no account row has genuinely been allocated nothing, and
> the read does not create one. 404ing would make "no earnings yet" indistinguishable from "no such
> vendor" — and the caller already knows the owner exists, because it looked them up to get here.

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
