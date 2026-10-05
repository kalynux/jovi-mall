# Admin — Platform Earnings & owner balances

**`/platform` and `/orders/:orderId/split` re-verified against source 2026-10-04.** **Verified against source on 2026-09-08** — the four routes and their relative-path mount, the platform balance and ledger shapes, the `/accounts` query schema and its `meta.totals` array, and the zero-not-404 rule on `/balances`, against `jovi-mall/src/modules/earnings/{routes/admin-earnings.routes.ts,controllers/admin-earnings.controller.ts,services/earnings-account.service.ts}`. The page described the deleted `requireRole([\x27admin\x27])` cookie session as its auth model, and omitted `meta.totals`.

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
> `admin/api-doc/api/` in the wi-admin repository for the dashboard contract.

---

Read-only view of the **singleton platform earnings account** — the marketplace's accumulated
commission — and its append-only ledger, plus the **per-owner balances** ("what do we owe this
vendor / agency / agent").

- **Base URL**: `http://localhost:8022/api`
- **Auth**: `requireAdminCaller` — a **service** call from wi-admin. `X-Service-Token`
  (`INTERNAL_ADMIN_SERVICE_TOKEN`, or the same value as `Authorization: Bearer`) plus `X-Actor-Id`,
  the administrator’s `admin_accounts._id`. **No user session, no cookie.**
- **Permissions**: resolved in **wi-admin**, before the call, and re-checked nowhere here — the
  token is a full-privilege credential.

> ⚠ **These two lines read *"Auth: Required (cookie or `Bearer`)"* and *"Permissions: `admin` only
> (`requireRole(['admin'])`)"* until 2026-09-08.** That is the authorization model deleted at the
> Phase 5 Part E cutover, and following it would mean building against a mount that does not exist.

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
| `GET` | `/internal/admin/earnings/orders/:orderId/split` | Who gets what from one order, on what basis — allocated or projected (2026-10-04) |
| `GET` | `/internal/admin/earnings/clawbacks` | Owners who owe money back after a refund clawback (2026-10-05) |
| `POST` | `/internal/admin/earnings/clawbacks/:ownerType/:ownerId/write-off` | Forgive (part of) that debt (2026-10-05) |

> **Every balance read now carries `clawback`** (2026-10-05, REFUND-FLOW-PLAN § 6): what the
> owner OWES BACK after a refund recovered more than their balances held. `/accounts` rows and
> `meta.totals`, `/balances/:ownerType/:ownerId`, and the owner-facing earnings views all report
> it. ⚠ It runs the **opposite direction** from `pending · available · reserve · requested` —
> never add it to them. While it is above 0, `available` is 0 and every future release pays it
> down first. The admin payout DTO reports the owner's live debt as `ownerClawback`; a payout
> already waiting when a debt appears is never cut (C-7).

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

**Purpose**: Return the marketplace's balances — **both** platform accounts and their total.

⚠ **Until 2026-10-04 this returned the `platform` account alone — commission only.** The bargain
fee (30% of what a bargainable line sold for above the vendor's minimum) is credited to a second
singleton, `platform_ai`, kept apart so it stays separately answerable; nothing added the two. The
top-level fields are still the commission account, unchanged; `accounts` and `total` are new.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller)

### Example success `200`

```json
{
  "success": true,
  "data": {
    "pending": 125000,
    "available": 480000,
    "reserve": 0,
    "requested": 0,
    "currency": "XAF",
    "accounts": {
      "commission": { "pending": 125000, "available": 480000, "reserve": 0, "requested": 0, "currency": "XAF" },
      "bargainFee": { "pending": 9000, "available": 31500, "reserve": 0, "requested": 0, "currency": "XAF" }
    },
    "total": { "pending": 134000, "available": 511500, "earned": 645500, "currency": "XAF" }
  }
}
```

| Field | Meaning |
|---|---|
| `pending` … `currency` (top level) | **The commission account** — kept for compatibility |
| `accounts.commission` / `accounts.bargainFee` | The `platform` and `platform_ai` accounts |
| `pending` | Held in escrow (order not yet completed / hold not released) |
| `available` | Released (the platform never withdraws, so this only grows) |
| `reserve` | COD rolling-reserve held amount (always `0` for the platform) |
| `requested` | Earmarked by a payout request (always `0` for the platform — no platform payouts) |
| `total.earned` | Σ all four sub-balances of both accounts — what the platform has made, net of reversals |
| `total` | `null` if the two accounts ever hold different currencies |

---

## GET `/internal/admin/earnings/platform/ledger`

**Purpose**: Return the platform's append-only earnings ledger, newest first. Every balance movement
(hold, release, reserve, reversal) writes one row.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller)

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

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller)

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
  "meta": {
    "total": 87, "page": 1, "limit": 20, "pages": 5,
    "totals": [
      { "currency": "XAF", "pending": 1420000, "available": 8830000, "reserve": 210000, "requested": 95000 }
    ]
  }
}
```

> ⚠ **`meta.totals` was missing from this example until 2026-09-08, and it is the field the
> screen is for.** It is an **array**, one entry per currency present in the *filtered* set — it
> respects the active `ownerType`, so it can never disagree with the table above it. An array
> rather than an object deliberately: a single object would force a currency choice the data does
> not support (`admin-earnings.controller.ts:57-73`,
> `earnings/services/earnings-account.service.ts:265-310`).
>
> There is **no sum across the four balances** and there must not be — see
> `EarningsAccountRepository.totalsForAdmin`.

---

## GET `/internal/admin/earnings/balances/:ownerType/:ownerId`

**Purpose**: One owner's four balances.

**Auth**: `requireAdminCaller` · **Permissions**: `admin` (service caller)

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

## GET `/internal/admin/earnings/orders/:orderId/split`

**Purpose**: Who gets what from one order, and on what basis — the administrator's money-split
view (owner request 2026-10-04: support must be able to explain a vendor's amount). wi-admin
serves it as `GET /api/v1/money/orders/:orderId/split` and adds display names; **the full field
reference is `admin/api-doc/api/money.md` § that route.**

**Auth**: `requireAdminCaller` · **Errors**: `404 ORDER_NOT_FOUND`

One section per split moment — `payment` (prepaid items), `delivery` (one prepaid parcel's fee),
`cash_collection` (one COD parcel). A section is `allocated` once its split ran (figures read from
`earnings_allocations`), `projected` before it (figures from `EarningsSplitService.compute*`, the
**same** methods the splits call — `splitOrder` → `computeOrderSplit`, `splitCodCollection` →
`computeCodCollectionSplit`, `splitDeliveryFeeCollection` → `computeDeliveryFeeCollectionSplit`,
`splitShipmentDelivery` → `computeShipmentDeliverySplit`), or `none` / `unavailable`.
`reconciliation.difference` (charged − Σ non-reversed lines) is 0 on a normal order.

⚠ **Read-only and prices nothing itself** (`services/order-money-split.service.ts`,
`domain/order-money-split.ts`). `test:order-money-split` pins both by source scan: every `split*`
computes through its write-free twin, and the view holds no rate, no rounding and no fee helper.
Lives in `earnings`, not `orders`, because `test:bargain-price` keeps the orders module out of the
bargain fee.

---

## Earnings pauses — `/internal/admin/earnings/pauses` (2026-10-05)

Paused money is **never released**: the release worker skips it, in its query and again in its
release claim. Resuming moves each held row's release date later by the paused time that fell
inside its hold, so a pause never shortens or restarts a hold (`earnings/domain/earnings-hold.ts`).

The pause record lives on the **Order** (`earnings_pause`) or **Booking** (`earningsPause`).

| Reason | Raised by | Lifted by |
|---|---|---|
| `seller_cancelled_paid_order` | the seller cancelling an order the customer had paid (also opens a HIGH-priority `ORDER_REFUND` ticket) | an administrator |
| `booking_cancelled_unrefunded` | a paid booking cancelled from the seller's **status menu** (also opens a HIGH-priority ticket) | an administrator |
| `card_dispute` | a card payment disputed with the bank | **itself** when the dispute is won or lost; or an administrator |
| `admin` | an administrator | an administrator |
| `refund_in_progress` | a refund request opened on it (REFUND-FLOW-PLAN C-4) | **itself** when the refund completes (`closeOnRefund`) or is rejected/abandoned; or an administrator |

A **completed refund** closes `refund_in_progress`, `seller_cancelled_paid_order` and
`booking_cancelled_unrefunded` — never `card_dispute` or `admin` — and, unlike a resume, does
**not** move hold dates. A booking's pause covers its balance-payment shares too.

## Refund clawback debt — `/internal/admin/earnings/clawbacks` (2026-10-05)

A refund that lands after the money was released takes it back: from the share's pending money
if still held, else its own COD reserve slice, else `available`, and the rest becomes debt
(`clawback_balance`) that every later inflow pays first (REFUND-FLOW-PLAN § 6). Each movement is
an `earnings_adjustments` row (read directly by wi-admin).

### GET `/internal/admin/earnings/clawbacks`
Owners with a debt, largest first. Query: `ownerType?` (`vendor`|`agency`|`agent`), `page`, `limit` (≤ 100).
Paginated rows: `{ ownerType, ownerId, clawback, available, pending, reserve, requested, currency,
heldPayout: { id, amount, status, ticketId } | null, updatedAt }`.

### POST `/internal/admin/earnings/clawbacks/:ownerType/:ownerId/write-off`
Body `{ "amount": integer > 0, "reason": string (3–500) }`, `.strict()`. Actor from `X-Actor-*`.
The platform absorbs the amount. Four-eyes at ≥ 2,000,000 is enforced by wi-admin.
`200` data: `{ writeOffKey, ownerType, ownerId, amount, currency, clawbackBefore, clawbackAfter, adjustmentId }`.
`409 EARNINGS_CLAWBACK_NOTHING_OWED` (no debt) · `409 EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT` (more than owed).

### GET `/internal/admin/earnings/pauses`
Every order and booking paused now, newest pause first. Query: `kind?` (`order`|`booking`), `page`, `limit` (≤ 100).
Rows: `{ kind, id, reference, vendorId, amount, currency, pause }` — `reference` is the order or booking number, `amount` what the customer paid.

### GET `/internal/admin/earnings/pauses/:kind/:id`
`{ kind, id, pause }`; `pause` is `null` if it was never paused. `404 EARNINGS_PAUSE_TARGET_NOT_FOUND` for an unknown id.

### POST `/internal/admin/earnings/pauses/:kind/:id/pause`
Body `{ "note": string (3–500, required) }`, `.strict()`. Reason recorded as `admin`, actor stamped from `X-Actor-*`.
`409 EARNINGS_ALREADY_PAUSED` if already paused (a second pause would overwrite who paused it and why).

### POST `/internal/admin/earnings/pauses/:kind/:id/resume`
Body `{ "note"?: string (1–500) }`, `.strict()`. Lifts **any** pause, whoever raised it.
`409 EARNINGS_NOT_PAUSED` if it is not paused. `409 EARNINGS_PAUSE_HELD_BY_REFUND`
(`details.refundRequestId`, `details.refundRequestStatus`) while a refund request of this order or
booking is open, or a completed one has not recovered its earnings yet (C-4) — the refund resumes
or closes the pause itself.

The `pause` object: `{ active, reason, note, paused_at, paused_by_user_id, paused_by_source, paused_by_name,
resumed_at, resumed_by_user_id, resumed_by_source, resumed_by_name, resume_note }`. A system pause has
`paused_by_user_id: null` and `paused_by_name: "system"`. Orders also get `earnings.paused` /
`earnings.resumed` timeline entries.

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
