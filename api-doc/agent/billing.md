# Agent Billing API

**Verified against source on 2026-09-08** — every route, the three seeded agent tiers and their
limits, and the settings schema, against `src/modules/billing/{routes/agent-billing.routes.ts,
controllers/subscriber-billing.controller.ts, validators/billing.validators.ts,
services/entitlement.service.ts, dto/public-plan.dto.ts}` and
`scripts/seed/seed-pricing-plans.ts`.
**One correction: `max_storage_bytes` is NOT a vendor-only null field on an agent plan.**

Agent-facing endpoints for pricing plans, the credit wallet, top-up purchases
and billing settings. **The agent billing engine is the same engine as the
vendor's** — same endpoints, same shapes, same payment flow — only the plan
*limit* differs: an agent's plan sets **how many deliveries they can hold at
once**. Where a flow is identical to the vendor's, this doc links to
[vendor/billing.md](../vendor/billing.md) instead of repeating it.

## Base Path
```
/api/agent
```

## Authentication
All requests require a valid Bearer token with the **agent** role:
```
Authorization: Bearer <access_token>
```
Every endpoint is automatically scoped to the authenticated agent (`role_entity._id`).

---

## What the dashboard must implement

1. **Plan page** — current plan (`GET /agent/plan`) + the buyable plans (`GET /agent/plans`), highlighting the **concurrent-delivery limit** each tier grants.
2. **Buy / upgrade flow** — `POST /agent/plans/:planId/purchase` → gateway → `POST /agent/plan-purchases/:id/verify` (poll). Identical to vendor.
3. **Credit wallet** — balance, packs, top-up + verify.
4. **Billing settings** — plan-expiry notice window (`GET`/`PATCH /agent/settings`).
5. **Transactions history** — `GET /agent/transactions`.
6. **Notifications** — render the new `plan.expiring` / `plan.expired` situations (see [Agent Notifications](./notifications.md)). The expiry copy warns that a downgrade **lowers the concurrent-delivery cap**.
7. **Deep-link route** — notification buttons point at `plans`; implement that route (appended to `AGENT_APP_URL`).

> **Launch state:** only the **free tier (`agent_free`, 20 deliveries)** is active. `GET /agent/plans` returns a single plan; the paid tiers (`agent_plus` = 50, `agent_pro` = 100) are `is_active:false`. Build the upgrade UI now; it lights up when they launch.

---

## Endpoints summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agent/plans` | List purchasable plans (catalog, active only) |
| GET | `/api/agent/plan` | The agent's current plan + entitlements |
| POST | `/api/agent/plans/:planId/purchase` | Buy a plan (self-serve; auto-activates/queues on payment) |
| POST | `/api/agent/plan-purchases/:id/authorize` | Relay the Orange Money SMS code for a plan purchase |
| POST | `/api/agent/plan-purchases/:id/verify` | Verify & apply a plan purchase after payment |
| GET | `/api/agent/credits` | Current credit balance |
| GET | `/api/agent/credits/packs` | List buyable credit top-up packs |
| POST | `/api/agent/credits/topups` | Start a credit top-up purchase |
| POST | `/api/agent/credits/topups/:id/authorize` | Relay the Orange Money SMS code for a top-up |
| POST | `/api/agent/credits/topups/:id/verify` | Verify/complete a top-up after payment |
| GET | `/api/agent/settings` | Read billing settings (expiry-notice window) |
| PATCH | `/api/agent/settings` | Update billing settings |
| GET | `/api/agent/transactions` | Unified billing + earnings history |

> ⚠️ **`/api/agent/settings` is billing settings only** — the plan-expiry notice window, nothing
> else. Dispatch behaviour (auto-accept) lives on `/api/agent/dispatch-settings`, documented in
> [profile.md](./profile.md#patch-agentdispatch-settings). The two routers share the `/agent`
> prefix and this one is mounted first, so a body meant for the other one is validated against
> `notifyDaysBeforeExpiry` and `400`s.

> **Your plan sets your concurrent-delivery cap.** `max_unterminated_shipments` on the active plan
> is written straight onto the agent's capacity, which is what the platform admits new offers
> against. Read it back as `capacity` on [profile.md](./profile.md#capacity-is-read-only) or
> `GET /api/agent/dispatch-settings` — it is not settable anywhere else.

---

### GET /api/agent/plans

List the **active** agent pricing plans, sorted by `sort_order` then `price`.

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "_id": "665f2001",
      "role": "agent",
      "code": "agent_free",
      "name": "Agent Free",
      "price": 0,
      "currency": "XAF",
      "term_days": null,
      "credit_allowance": 20,
      "max_unterminated_shipments": 20,
      "live_tracking_enabled": true,
      "max_active_products": null,
      "max_storage_bytes": 1073741824,
      "commission_percent": null,
      "is_active": true,
      "sort_order": 1
    }
  ]
}
```

Field notes (agent plans):
- `max_unterminated_shipments` (number | `null`) — the agent's **concurrent-delivery cap**. This value becomes the agent's `capacity.max_active_shipments` when the plan activates, and is enforced **hard** at offer-accept time (see below). Free = `20`.
- `live_tracking_enabled` — always `true` today; reserved for a future free-tier restriction.
- `max_storage_bytes` (number | `null`) — the cap on the agent's **own** media library. It is **not**
  a vendor-only field and it is **not** null: the seeded tiers are **1 GB** (free), 3 GB (Plus) and
  10 GB (Pro). A plan that omits it falls back to 1 GB. This is the number behind
  [storage.md](./storage.md); an agent's delivery-proof photos are charged to the **agency** and do
  not count here.
- genuinely vendor-only fields (`max_active_products`, `commission_percent`) are always `null` on an
  agent plan — ignore them.

---

### GET /api/agent/plan

The agent's current plan + resolved entitlements. Lazily creates `agent_free` on first read (and grants its signup credit allowance).

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "active": {
      "plan": {
        "_id": "665f2001", "code": "agent_free", "name": "Agent Free", "price": 0,
        "currency": "XAF", "term_days": null, "credit_allowance": 20,
        "max_unterminated_shipments": 20, "live_tracking_enabled": true
      },
      "subscriberPlan": {
        "_id": "667c0001", "owner_type": "agent", "owner_id": "6603", "plan_id": "665f2001",
        "plan_code": "agent_free", "status": "active",
        "started_at": "2026-07-01T10:00:00.000Z", "expires_at": null,
        "assigned_by": null, "payment_reference": null, "allowance_granted": true
      }
    },
    "pending": null,
    "entitlements": {
      "planCode": "agent_free",
      "maxUnterminatedShipments": 20,
      "liveTrackingEnabled": true
    }
  }
}
```

- `subscriberPlan` — the assignment record (`owner_type`/`owner_id`, generalized from the old vendor-only `vendorPlan`). Free tier `expires_at` is `null`.
- `entitlements.maxUnterminatedShipments` — the plan's concurrent-delivery cap.
- **No `shipments` usage block here.** The agent's live count of held deliveries comes from the **agent working-state / capacity** surface, not billing — see [Availability & device](./availability-and-device.md) / [Offers](./offers.md). The plan endpoint tells you the *ceiling*; the working-state tells you the *current count*.

---

### The delivery cap is a HARD, plan-driven cap

Unlike the agency (soft) cap, the agent's `max_unterminated_shipments` is **enforced**:

- On plan activation, it is written to the agent's `capacity.max_active_shipments`.
- When the agent tries to **accept an offer** past that ceiling, the accept fails with **`422 AGENT_AT_CAPACITY`** (`details: { activeShipmentCount, maxActiveShipments }`) — see [Offers](./offers.md).
- The count that matters is `ACTIVE_SHIPMENT_STATUSES` (assigned / handing_over / picked_up / in_transit / agent_delivered / failed) — the shipments actually bound to the agent.

Dashboard: show `heldDeliveries / maxUnterminatedShipments` and, when full, an "at capacity — upgrade to take more" prompt. On downgrade (plan expiry), the ceiling drops to the free tier's 20; the `plan.expired` notification says so.

---

### POST /api/agent/plans/:planId/purchase · POST /api/agent/plan-purchases/:id/authorize · POST /api/agent/plan-purchases/:id/verify

Self-serve purchase + verification. **Flow, request body, gateway `instructions`, Stripe/mobile-money handling, polling and the two-plan rule are identical to vendor** — see [vendor/billing.md → purchase](../vendor/billing.md#post-apivendorplansplanidpurchase) / [→ verify](../vendor/billing.md#post-apivendorplan-purchasesidverify). Differences:

- Paths are `/api/agent/...`.
- The verify response's applied-plan key is **`subscriberPlan`**; rows carry `owner_type: "agent"`, `owner_id`, `subscriber_plan_id`.
- When a paid plan activates, the agent's concurrent-delivery ceiling rises immediately (the capacity is synced from the plan). No agent action needed beyond paying.

Error codes: same set as [agency](../agency/billing.md) (`BILLING_PLAN_*`, `BILLING_PENDING_PLAN_EXISTS`, `PAYMENT_*`), `401`, `403`.

> **Orange Money needs one extra call, and it is easy to miss.** When `purchase`/`topups`
> answers `instructions.requiresOtp: true` (My-CoolPay + Orange Money), **nothing has been
> charged yet**: relay the SMS code to `POST /api/agent/plan-purchases/:id/authorize` or
> `POST /api/agent/credits/topups/:id/authorize` before you start polling. Shape, response and
> error codes are the vendor ones —
> [plan purchase](../vendor/billing.md#post-apivendorplan-purchasesidauthorize) ·
> [top-up](../vendor/billing.md#post-apivendorcreditstopupsidauthorize).

---

### Credit wallet & settings

Identical to vendor/agency — `/api/agent/credits`, `/api/agent/credits/packs`, `/api/agent/credits/topups(+/:id/verify)`, `/api/agent/settings`. Same packs, gateways, idempotent verify, negative-balance-after-chargeback rule, and expiry-notice window (`notifyDaysBeforeExpiry`, `0`–`90`, default `7`). See [vendor/billing.md → credits](../vendor/billing.md#get-apivendorcredits).

> Nothing is metered against the agent wallet yet — the wallet/allowance/top-up exist for future credit-metered agent features. Show the balance; there is no "spend" endpoint.

---

## Transactions

`GET /api/agent/transactions` — the agent's unified history (plan purchases, credit top-ups, credit ledger, and delivery-fee earnings), same shape/params as [vendor/transactions.md](../vendor/transactions.md). Query: `?page=&limit=&category=plan|credit|earning|payout`.

---

## Payment disputes / chargebacks

Same as the other roles: a reversed **plan purchase** downgrades the agent to `agent_free` (and their delivery ceiling drops to 20); a reversed **top-up** claws credits back (balance can go negative). Webhook-driven, no agent endpoint — just render `reversed` states and negative balances.

## Reference

- Plan `role` = `"agent"`; free-tier code = `agent_free`.
- Plan → capacity relationship and the `AGENT_AT_CAPACITY` error: [Offers](./offers.md).
- Cross-role model: [billing-plans-across-roles.md](../billing-plans-across-roles.md).
- Shared payment mechanics: [vendor/billing.md](../vendor/billing.md), [stripe-payments.md](../vendor/stripe-payments.md).
