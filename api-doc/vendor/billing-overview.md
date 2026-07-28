# Billing Module — Overview (Pricing Plans & Credit Wallet)

The billing module monetizes vendors through **pricing plans** and meters two
costly platform actions (AI product **vectorisation** and outbound **WhatsApp
template messages**) through a **credit wallet**.

This overview explains the domain concepts and data shapes shared by all billing
endpoints. See the companion docs for the actual requests:

- [**Vendor Billing API**](./billing.md) — plans, plan purchase, current plan, credit balance/ledger, top-ups, settings (vendor role)
- [**Admin Billing API**](../admin/billing.md) — pricing plan catalog CRUD + manual plan assignment (admin role)

---

## Response & error envelope

All billing endpoints use the platform-standard envelope.

**Success:**
```json
{ "success": true, "data": <object|array>, "message": "<optional>", "meta": <optional pagination> }
```

**Paginated list `meta`:**
```json
{ "total": 100, "page": 1, "limit": 20, "totalPages": 5 }
```

**Error:**
```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "Human-readable description", "details": { } } }
```
`details` is present on some errors (e.g. insufficient credits, limit exceeded).

---

## Core concepts

### 1. Pricing plans (the catalog)

Plans are an **admin-managed catalog** stored in the database (not hardcoded), scoped by `role`. Only the `vendor` role is in use today. The three seeded vendor tiers:

| Plan (`code`) | Price (`price`) | Credit allowance | Max active products | Max media storage | Commission % | Term |
|---|---|---|---|---|---|---|
| `starter` | 0 XAF | 50 | 15 | 1 GB | 7 | never expires (`term_days: null`) |
| `growth` | 5,000 XAF | 850 | 150 | 10 GB | 5 | 30 days |
| `business` | 25,000 XAF | 4,500 | unlimited (`null`) | 100 GB | 3 | 30 days |

**All other capabilities are identical across plans** — every plan can sell physical / digital / service products, send WhatsApp notifications (metered by credits, not by plan), use Google Calendar sync, see analytics and duplicate products. Plans differ **only** by the five columns above.

**Media storage limit** (`max_storage_bytes`) caps the total bytes of **product media** a vendor can store — product/variant images, product videos, and any docs/audio/archives uploaded via the file endpoints. **Digital-product assets are excluded**: they have their own fixed cap of **500 MB per asset on every plan** and never count toward this limit. The limit is admin-editable per plan (e.g. raising Business). See storage analytics on the media endpoints and `GET /vendor/plan`. **Full guide: [Vendor Media Storage](./storage.md).**

Admins can create/edit/archive plans, so prices and limits may change without a deploy. Always read the live catalog (`GET /vendor/plans`) for display rather than hardcoding.

### 2. The two-plan model (active + pending)

A vendor holds **at most two** non-terminal plan records:

- exactly one **`active`** plan (the one currently in force), and
- optionally one **`pending_activation`** plan (bought in advance).

When a vendor buys a new plan while a **paid** plan is still running, the new plan is **queued** as `pending_activation` and is scheduled to start **exactly when the active plan expires** — no paid days are lost. On the expiry day a daily job promotes the pending plan to active. If there's no pending plan, the vendor is **downgraded to the free Starter**.

A vendor may not queue a second pending plan while one already exists (`BILLING_PENDING_PLAN_EXISTS`).

`SubscriberPlan.status` values: `active`, `pending_activation`, `expired`, `cancelled`. (The plan-assignment model is now owner-scoped — `SubscriberPlan`, `owner_type`/`owner_id` — and shared by vendor/agency/agent.)

**How a vendor gets a plan.** New vendors start on free Starter automatically. To upgrade, the vendor **buys a plan themselves** — `POST /vendor/plans/:planId/purchase` opens a gateway payment; once confirmed (via `POST /vendor/plan-purchases/:id/verify`) the plan is **assigned/activated automatically, with no admin step**: immediately if currently on free/lapsed, or queued as `pending_activation` behind a still-running paid plan. Admins can also assign a plan manually for comps/overrides. This mirrors the credit top-up flow exactly.

### 3. Credit wallet (single pooled balance)

Each vendor has **one** credit wallet. Credits **never expire or reset** — the balance is a running pool of:
- the allowance granted when a plan **activates** (granted **once** per activation, not monthly),
- purchased top-up packs, and
- leftover credits from a previous plan.

A new (pending) plan's allowance is added **only when it activates**, not when it is queued/purchased.

> The free Starter grants its 50 credits **once**, the first time a vendor's plan is resolved (effectively at signup). A later downgrade back to free does **not** re-grant credits.

### 4. What credits are spent on

| Action | Cost (credits) | Who triggers it |
|---|---|---|
| Vectorise one product (AI search indexing) | **1** | Vendor — on product create / update / enabling vectorisation / retry |
| Send one WhatsApp **template** message to a customer | **1** | Vendor-initiated outbound templates |

Notes:
- Vendor-facing vectorisation is charged automatically; if the balance is too low the product still saves but its `vectorisationStatus` becomes `skipped_no_credits` (no error to the request). A failed external vectorisation is **refunded**.
- Admin bulk re-vectorisation (`POST /admin/products/bulk-vectorise`) is **not** charged to vendors.
- WhatsApp system messages (verification codes, delivery-agent dispatch) are **exempt** — only vendor→customer templates are billed.
- Costs are configurable server-side and may change; don't hardcode them in the UI if you can read them from responses.

### 5. Top-ups

Vendors can buy additional credits in fixed **packs** via a payment gateway (NotchPay / MyCoolPay mobile money, or Stripe card). Flow:

1. `POST /vendor/credits/topups` → creates a `pending` top-up and returns gateway `instructions`.
2. Vendor completes the payment on the gateway (USSD / card confirmation).
3. `POST /vendor/credits/topups/:id/verify` → polls the gateway; on success the wallet is credited and the top-up becomes `paid` (idempotent).

Seeded packs (read live via `GET /vendor/credits/packs`):

| `code` | Credits | Price |
|---|---|---|
| `pack_100` | 100 | 600 XAF |
| `pack_320` | 320 | 1,800 XAF |
| `pack_1100` | 1,100 | 6,000 XAF |
| `pack_2250` | 2,250 | 12,000 XAF |

### 6. Expiry notifications

Vendors choose how many days **before** plan expiry they want to be warned (`notifyDaysBeforeExpiry`, default **7**, range 0–90), via `GET|PATCH /vendor/settings`. A daily job emits an event when a plan crosses that window; dispatch of the actual notification is handled by the notifications module.

---

## Data shapes

### `PricingPlan`
```json
{
  "_id": "665f...",
  "role": "vendor",
  "code": "growth",
  "name": "Growth",
  "price": 5000,
  "currency": "XAF",
  "term_days": 30,
  "credit_allowance": 850,
  "max_active_products": 150,
  "max_storage_bytes": 10737418240,
  "commission_percent": 5,
  "is_active": true,
  "sort_order": 2,
  "created_at": "2026-06-19T10:00:00.000Z",
  "updated_at": "2026-06-19T10:00:00.000Z"
}
```
`term_days: null` = never expires (free tier). `max_active_products: null` = unlimited.

### `SubscriberPlan`
```json
{
  "_id": "667a...",
  "owner_type": "vendor",
  "owner_id": "6601...",
  "plan_id": "665f...",
  "plan_code": "growth",
  "status": "active",
  "started_at": "2026-06-19T10:00:00.000Z",
  "expires_at": "2026-07-19T10:00:00.000Z",
  "assigned_by": "60a1...",
  "payment_reference": "notch_tx_abc123",
  "allowance_granted": true,
  "created_at": "2026-06-19T10:00:00.000Z",
  "updated_at": "2026-06-19T10:00:00.000Z"
}
```
`expires_at: null` for the never-expiring free plan. `started_at: null` while a plan is still `pending_activation`.

### `CreditTransaction` (ledger entry)
```json
{
  "_id": "66aa...",
  "wallet_id": "6699...",
  "owner_type": "vendor",
  "owner_id": "6601...",
  "type": "debit",
  "amount": -1,
  "balance_after": 849,
  "reason_code": "vectorisation",
  "ref": "<productId | messageId | topupId | planId>",
  "created_at": "2026-06-19T11:00:00.000Z"
}
```
`type` ∈ `allowance | topup | debit | adjustment | refund`. `amount` is **signed** (positive credits, negative debits). `reason_code` ∈ `plan_allowance | topup_purchase | vectorisation | whatsapp_template | admin_adjustment`.

### `CreditTopup`
```json
{
  "_id": "66bb...",
  "owner_type": "vendor",
  "owner_id": "6601...",
  "pack_code": "pack_100",
  "credits": 100,
  "price": 600,
  "currency": "XAF",
  "status": "pending",
  "gateway": "NOTCHPAY",
  "gateway_ref": "notch_tx_abc123",
  "payment_transaction_id": null,
  "created_at": "2026-06-19T11:05:00.000Z",
  "updated_at": "2026-06-19T11:05:00.000Z"
}
```
`status` ∈ `pending | paid | failed`. `gateway` ∈ `NOTCHPAY | MYCOOLPAY | STRIPE`.

### `PlanPurchase`
```json
{
  "_id": "66cc...",
  "owner_type": "vendor",
  "owner_id": "6601...",
  "plan_id": "665f...",
  "plan_code": "growth",
  "price": 5000,
  "currency": "XAF",
  "status": "pending",
  "gateway": "NOTCHPAY",
  "gateway_ref": "notch_tx_p1",
  "subscriber_plan_id": null,
  "created_at": "2026-06-19T14:00:00.000Z",
  "updated_at": "2026-06-19T14:00:00.000Z"
}
```
`status` ∈ `pending | paid | failed`. `subscriber_plan_id` is the `SubscriberPlan` created once the purchase is applied (null until `paid`). (The engine is now owner-scoped — `owner_type`/`owner_id` replace the old `vendor_id`; the same rows serve agency/agent purchases.)

### `CreditPack` (catalog item)
```json
{ "code": "pack_100", "credits": 100, "price": 600, "currency": "XAF" }
```

---

## Billing error codes

| Code | HTTP | Meaning |
|---|---|---|
| `BILLING_PLAN_NOT_FOUND` | 404 | Plan id/code does not exist (or default plan not seeded) |
| `BILLING_PLAN_INACTIVE` | 409 | Tried to assign a plan that is not `is_active` |
| `BILLING_PLAN_ROLE_MISMATCH` | 409 | Plan belongs to a different role than the target |
| `BILLING_PLAN_CODE_EXISTS` | 409 | Creating a plan with a `code` already used for that role |
| `BILLING_PENDING_PLAN_EXISTS` | 409 | A pending plan is already queued for this vendor |
| `BILLING_INSUFFICIENT_CREDITS` | 402 | Wallet balance can't cover the action (`details: { balance, requested }`) |
| `BILLING_LIMIT_EXCEEDED` | 403 | Active-product cap reached (`details: { limit, current }`) |
| `BILLING_TOPUP_NOT_FOUND` | 404 | Top-up id not found / not owned by the vendor |
| `BILLING_TOPUP_PACK_NOT_FOUND` | 404 | Unknown credit pack `code` |
| `BILLING_TOPUP_INVALID_STATE` | 409 | Top-up has no gateway reference yet (cannot verify) |
| `BILLING_PLAN_NOT_PURCHASABLE` | 409 | Tried to purchase the free/0-price plan (it's the default tier) |
| `BILLING_PLAN_PURCHASE_NOT_FOUND` | 404 | Plan-purchase id not found / not owned by the vendor |
| `BILLING_PURCHASE_INVALID_STATE` | 409 | Plan purchase has no gateway reference yet (cannot verify) |
| `PAYMENT_GATEWAY_NOT_SUPPORTED` | 400 | Unsupported `gateway` value on a top-up or plan purchase |
| `PAYMENT_INITIATION_FAILED` | 502 | Gateway rejected the top-up / plan-purchase initiation |

Plus the platform-standard `UNAUTHORIZED` (401), `FORBIDDEN` (403), `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `INTERNAL_ERROR` (500).
