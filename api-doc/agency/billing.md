# Agency Billing API

Agency-facing endpoints for pricing plans, the credit wallet, top-up purchases
and billing settings. **The agency billing engine is the same engine as the
vendor's** — same endpoints, same request/response shapes, same payment flow —
only the plan *limits* differ (agencies are capped on **unterminated shipments**,
not products/storage). Where a flow is identical to the vendor's, this doc links
to [vendor/billing.md](../vendor/billing.md) rather than repeating it.

## Base Path
```
/api/agency
```

## Authentication
All requests require a valid Bearer token with the **agency** role:
```
Authorization: Bearer <access_token>
```
Every endpoint is automatically scoped to the authenticated agency (`role_entity._id`).

---

## What the dashboard must implement

1. **Plan page** — show the current plan (`GET /agency/plan`), the unterminated-shipment usage meter, and the list of buyable plans (`GET /agency/plans`).
2. **Buy / upgrade flow** — `POST /agency/plans/:planId/purchase` → gateway → `POST /agency/plan-purchases/:id/verify` (poll). Identical to vendor.
3. **Credit wallet** — balance (`GET /agency/credits`), packs (`GET /agency/credits/packs`), top-up (`POST /agency/credits/topups` → verify).
4. **Billing settings** — plan-expiry notice window (`GET`/`PATCH /agency/settings`).
5. **Transactions history** — `GET /agency/transactions` (see [Transactions](#transactions)).
6. **Notifications** — render the new `plan.expiring`, `plan.expired`, and `shipment.cap.exceeded` situations (see [Agency Notifications](./notifications.md)).
7. **Deep-link route** — the notification buttons point at `plans`; implement that route in the agency SPA (it is appended to `AGENCY_APP_URL`).

> **Launch state:** only the **free tier (`agency_free`)** is active today, so `GET /agency/plans` returns a single plan and the purchase endpoints will 409 on the (inactive) paid tiers. The two paid tiers (`agency_growth`, `agency_scale`) are defined but `is_active:false` — build the upgrade UI now; it lights up when they are activated. See [Roadmap](#roadmap-live-tracking--paid-tiers).

---

## Endpoints summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agency/plans` | List purchasable plans (catalog, active only) |
| GET | `/api/agency/plan` | The agency's current plan + entitlements + shipment usage |
| POST | `/api/agency/plans/:planId/purchase` | Buy a plan (self-serve; auto-activates/queues on payment) |
| POST | `/api/agency/plan-purchases/:id/verify` | Verify & apply a plan purchase after payment |
| GET | `/api/agency/credits` | Current credit balance |
| GET | `/api/agency/credits/packs` | List buyable credit top-up packs |
| POST | `/api/agency/credits/topups` | Start a credit top-up purchase |
| POST | `/api/agency/credits/topups/:id/verify` | Verify/complete a top-up after payment |
| GET | `/api/agency/settings` | Read billing settings (expiry-notice window) |
| PATCH | `/api/agency/settings` | Update billing settings |
| GET | `/api/agency/transactions` | Unified billing + earnings history |

---

### GET /api/agency/plans

List the **active** agency pricing plans. Sorted by `sort_order`, then `price`. Inactive/archived plans are excluded.

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "_id": "665f1001",
      "role": "agency",
      "code": "agency_free",
      "name": "Agency Free",
      "price": 0,
      "currency": "XAF",
      "term_days": null,
      "credit_allowance": 50,
      "max_unterminated_shipments": 1000,
      "live_tracking_enabled": true,
      "max_active_products": null,
      "max_storage_bytes": null,
      "commission_percent": null,
      "is_active": true,
      "sort_order": 1
    }
  ]
}
```

Field notes (agency plans):
- `max_unterminated_shipments` (number | `null`) — the plan's cap on shipments **not yet in a terminal state**; `null` = unlimited. This is a **soft cap** (see below).
- `live_tracking_enabled` (boolean) — always `true` today; reserved for a future free-tier restriction. Do not gate any UI on it yet, but read it so you are ready.
- `max_active_products`, `max_storage_bytes`, `commission_percent` — vendor-only; always `null` for agency plans (ignore them in the agency UI).

**Error Responses**: `401 UNAUTHORIZED`, `403 FORBIDDEN` (non-agency token).

---

### GET /api/agency/plan

The agency's current plan situation: the `active` plan, any `pending_activation` plan, the resolved `entitlements`, and the live **shipment usage** against the soft cap. If the agency has never had a plan, the free `agency_free` is created on the fly (and its signup credit allowance granted).

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "active": {
      "plan": {
        "_id": "665f1001", "code": "agency_free", "name": "Agency Free", "price": 0,
        "currency": "XAF", "term_days": null, "credit_allowance": 50,
        "max_unterminated_shipments": 1000, "live_tracking_enabled": true
      },
      "subscriberPlan": {
        "_id": "667b0001", "owner_type": "agency", "owner_id": "6602", "plan_id": "665f1001",
        "plan_code": "agency_free", "status": "active",
        "started_at": "2026-07-01T10:00:00.000Z", "expires_at": null,
        "assigned_by": null, "payment_reference": null, "allowance_granted": true
      }
    },
    "pending": null,
    "entitlements": {
      "planCode": "agency_free",
      "maxUnterminatedShipments": 1000,
      "liveTrackingEnabled": true
    },
    "shipments": {
      "maxUnterminatedShipments": 1000,
      "currentUnterminated": 342,
      "remaining": 658
    }
  }
}
```

- `subscriberPlan` — the assignment record. **Note the key is `subscriberPlan`** (the model was generalized from the old vendor-only `vendorPlan`); its `owner_type`/`owner_id` replace the old `vendor_id`. For the never-expiring free tier `expires_at` is `null`.
- `pending` is `null` when nothing is queued (a plan bought in advance while a paid plan is still running).
- `entitlements` — the active plan's resolved limits.
- `shipments` — usage for the meter: `currentUnterminated` = shipments in any non-terminal state (`pending`, `assigned`, `handing_over`, `picked_up`, `in_transit`, `agent_delivered`, `pending_agency_reassignment`); `remaining` is clamped at 0; both `maxUnterminatedShipments` and `remaining` are `null` when the plan is unlimited.

**Error Responses**: `401`, `403`. `404 BILLING_PLAN_NOT_FOUND` only if `agency_free` has not been seeded (`npm run seed:plans`).

---

### The shipment cap is a SOFT cap (important for the dashboard)

The `max_unterminated_shipments` limit **never blocks a delivery or a customer checkout.** It is a monitoring threshold:

- Deliveries keep flowing even when `currentUnterminated ≥ maxUnterminatedShipments`.
- When the agency crosses the cap, a daily sweep raises a **`shipment.cap.exceeded`** notification (once per crossing; re-armed when it drops back under) — render it as an upgrade nudge, not an error.
- In the plan UI, when `remaining === 0` show an "at capacity — upgrade for more headroom" banner, but **do not** disable any shipment/assignment action.

Contrast with the agent cap, which **is** hard (an agent cannot accept an offer past their plan cap — see [agent/billing.md](../agent/billing.md)).

---

### POST /api/agency/plans/:planId/purchase · POST /api/agency/plan-purchases/:id/verify

Self-serve plan purchase and verification. **Flow, request body, gateway `instructions`, Stripe/mobile-money handling, polling, and the two-plan rule (activate-now vs queue-as-pending) are identical to the vendor flow** — see [vendor/billing.md → purchase](../vendor/billing.md#post-apivendorplansplanidpurchase) and [→ verify](../vendor/billing.md#post-apivendorplan-purchasesidverify). Differences for agency:

- Paths are `/api/agency/plans/:planId/purchase` and `/api/agency/plan-purchases/:id/verify`.
- The verify response's applied-plan key is **`subscriberPlan`** (not `vendorPlan`), and the purchase row carries `owner_type: "agency"`, `owner_id`, and `subscriber_plan_id` (not `vendor_id`/`vendor_plan_id`).
- `planId` must be an **active** agency plan. Today the paid tiers are inactive, so these endpoints return `409 BILLING_PLAN_INACTIVE` until they launch.

Error codes: `400 VALIDATION_ERROR`, `404 BILLING_PLAN_NOT_FOUND`, `409 BILLING_PLAN_INACTIVE`, `409 BILLING_PLAN_ROLE_MISMATCH` (not an agency plan), `409 BILLING_PLAN_NOT_PURCHASABLE` (free tier), `409 BILLING_PENDING_PLAN_EXISTS`, `400 PAYMENT_GATEWAY_NOT_SUPPORTED`, `502 PAYMENT_INITIATION_FAILED`, `404 BILLING_PLAN_PURCHASE_NOT_FOUND`, `409 BILLING_PURCHASE_INVALID_STATE`, `401`, `403`.

---

### Credit wallet — GET /credits · GET /credits/packs · POST /credits/topups · POST /credits/topups/:id/verify

Identical in shape and behaviour to the vendor credit endpoints (same shared `CREDIT_TOPUP_PACKS`, same gateways, same idempotent verify/poll, same negative-balance-after-chargeback rule) — see [vendor/billing.md → credits](../vendor/billing.md#get-apivendorcredits). Just use the `/api/agency/...` paths. The top-up row carries `owner_type: "agency"` + `owner_id` instead of `vendor_id`.

> **What does an agency spend credits on?** Nothing is metered against the agency wallet **yet** — the wallet, allowance and top-ups exist so credit-metered agency features can be added without a billing change. Show the balance and let agencies top up; there is no "spend" endpoint.

`GET /api/agency/credits` → `{ "success": true, "data": { "balance": 50 } }` (can be negative after a top-up chargeback).

---

### GET /api/agency/settings · PATCH /api/agency/settings

Read/update the plan-expiry notification window. Same shape as the vendor settings endpoint.

`GET` → `{ "success": true, "data": { "notifyDaysBeforeExpiry": 7 } }` (default `7`).
`PATCH` body `{ "notifyDaysBeforeExpiry": 14 }` (integer `0`–`90`) → `{ "success": true, "data": { "notifyDaysBeforeExpiry": 14 }, "message": "Settings updated" }`.

**Error Responses**: `400 VALIDATION_ERROR`, `401`, `403`.

---

## Transactions

`GET /api/agency/transactions` returns the agency's unified history — plan purchases, credit top-ups, credit-ledger movements and delivery-fee **earnings** — merged into one normalized, paginated feed. **Same response shape and query params as the vendor feed** — see [vendor/transactions.md](../vendor/transactions.md). Query: `?page=&limit=&category=plan|credit|earning|payout`.

---

## Payment disputes / chargebacks (dashboard states)

Card (Stripe) charges can be disputed/refunded after the fact; the backend unwinds automatically — render the resulting states:

- **Plan purchase** → `status: "reversed"`; the agency is **downgraded to `agency_free`**. `GET /agency/plan` shows the free plan active. Surface a notice and allow re-purchase.
- **Credit top-up** → `status: "reversed"`; granted credits are **clawed back** (`reason_code: topup_reversal`), and the wallet **balance can go negative**. Show it.

No agency action/endpoint — these are webhook-driven. Just handle `reversed` in history views and negative balances.

---

## Roadmap: live tracking & paid tiers

- **Live tracking stays on for all plans today.** `live_tracking_enabled` is `true` on every tier and no UI gates on it. It is wired so a **future** free-tier restriction is a data/plan change only — read the flag now, but don't hide tracking on its value yet.
- **Paid tiers** (`agency_growth`, `agency_scale`) are seeded `is_active:false`. When activated they appear in `GET /agency/plans` and become purchasable with higher/`null` (unlimited) `max_unterminated_shipments`. Build the upgrade UI to render whatever active plans the catalog returns rather than hardcoding tiers.

## Reference

- Plan `role` = `"agency"`; free-tier code = `agency_free`.
- Shared concepts (statuses, two-plan rule, gateways, Stripe): [vendor/billing.md](../vendor/billing.md) and [stripe-payments.md](../vendor/stripe-payments.md).
- Cross-role model: [billing-plans-across-roles.md](../billing-plans-across-roles.md).
- Error envelope: `{ "success": false, "error": { "code": "...", "message": "..." } }`.
