# Billing, Plans & Credit — Cross-Dashboard Guide

**Verified against source on 2026-09-08** — the per-role caps and free-tier numbers, and the four
`BILLING_LIMIT_EXCEEDED` paths with its `details` shape, against
`jovi-mall/scripts/seed/seed-pricing-plans.ts`,
`src/modules/billing/services/entitlement.service.ts`,
`src/modules/catalog/controllers/vendor-product.controller.ts`,
`src/modules/catalog/domain/services/ProductBulkOperationsService.ts` and
`src/modules/catalog/repositories/mongo/product.repository.mongo.ts`.

One billing engine now serves **four dashboards**: vendor, agency, agent, and
admin. Vendors already had plans + a credit wallet; **agencies and agents now have
the identical surface** under their own role roots, and admin manages the catalog
for all three. This page is the map — what is shared, what differs per role, and
which doc each dashboard team should build from.

## The shared model in one paragraph

Every role has **3 pricing-plan tiers** (a free one + two paid). A subscriber holds
at most **one active plan + one queued (`pending_activation`)** plan at a time.
Buying a paid plan charges a payment gateway directly (NotchPay / MyCoolPay /
Stripe) and, on confirmation, activates or queues the plan automatically — **no
recurring charge**; a paid term simply **expires** after `term_days` and either
hands over to the queued plan or **downgrades to the role's free tier** (a daily
server job). Activating a plan grants its `credit_allowance` once into the role's
**credit wallet**; the wallet can also be topped up with credit packs. There is no
"spend credits" endpoint — credits are metered by other actions.

> **Plan and credit purchases do NOT use the `/api/payments` surface.** Billing talks to the gateway
> through its own adapter and creates **no `PaymentTransaction`** row, so its purchases are polled
> with `POST /api/{role}/plan-purchases/:id/verify` and `POST /api/{role}/credits/topups/:id/verify`
> — never `GET /api/payments/:transactionId`. The 2026-07-29 change that made that endpoint
> authenticated and owner-scoped therefore has **no effect on vendor, agency or agent billing**. It
> concerns customer order/cart/booking payments only — see [payments/README.md](./payments/README.md).

## Per-dashboard summary

> ⚠ **The Admin column is NOT a browser surface.** jovi-mall's public `/api/admin/*` mount was
> deleted at the Phase 5 cutover (`src/api/index.ts:186-189`) and the live route census has **zero**
> `/api/admin/*` routes. The admin billing surface is eight routes under
> `/api/internal/admin/billing/*`, reachable only by **wi-admin** with a service token — no browser
> session of any role can reach it, and the admin dashboard talks to wi-admin's `/api/v1/*`, never
> to this. Corrected 2026-09-06 (DOC-PROGRAM F-30); the prose below had been fixed earlier and this
> table had not, which is the half-corrected-page failure mode described in F-29.

| | Vendor | Agency | Agent | Admin |
|---|---|---|---|---|
| **Base path** | `/api/vendor` | `/api/agency` | `/api/agent` | `/api/internal/admin/billing` ⚠ |
| **Doc** | [vendor/billing.md](./vendor/billing.md) | [agency/billing.md](./agency/billing.md) | [agent/billing.md](./agent/billing.md) | [admin/billing.md](./admin/billing.md) |
| **Free tier** | `starter` | `agency_free` | `agent_free` | — |
| **Plan limit** | products / storage / commission | `max_unterminated_shipments` (**soft**) | `max_unterminated_shipments` (**hard**) | defines all |
| **Free-tier limit** | 15 products, 1 GB storage, 7% commission | **1000** unterminated shipments, **5 GB** storage | **20** concurrent deliveries, **1 GB** storage | — |
| **Enforcement** | **four** catalogue paths blocked at cap (`403 BILLING_LIMIT_EXCEEDED`) — see below | never blocks — alert only | offer-accept blocked at cap (`422 AGENT_AT_CAPACITY`) | — |
| **Paid tiers today** | active | `is_active:false` (build UI, not yet buyable) | `is_active:false` | manage via catalog |

> **Launch state:** for agency and agent, **only the free tier is active** right now
> (`GET /{role}/plans` returns one plan). The two paid tiers per role are seeded but
> inactive. Build the upgrade UI to render whatever active plans the catalog returns
> — don't hardcode tiers — and it lights up when the paid tiers are switched on.

### `403 BILLING_LIMIT_EXCEEDED` — four paths, and its `details` is the message

The product cap is checked at **four** places, not one. Three of them used to succeed silently and
now refuse, so a dashboard built before 2026-09 will meet a 403 it does not handle:

| Path | Endpoint |
|---|---|
| create a product | `POST /api/vendor/products` (and the simple-product create) |
| **un-archive** a product | `PATCH /api/vendor/products/:id/status` — only when the current status is `archived` |
| **duplicate** a product | `POST /api/vendor/products/:id/duplicate` — a duplicate lands as a draft, and a draft occupies a slot |
| **bulk status change** | the vendor bulk-operations endpoint — counted as a batch, refused **all-or-nothing** |

⚠ **The bulk path is arithmetic, not a threshold.** It asks "is there room for *N* more", where the
single-product check asks "is there room for one more" — so un-archiving fifty products with one
free slot is refused once, rather than passing fifty identical checks and overshooting the cap.

`details` carries the numbers a good message needs:

```json
{
  "success": false,
  "requestId": "3f9a1c22-6b0e-4a5f-9d31-0c7b2e84a110",
  "error": {
    "code": "BILLING_LIMIT_EXCEEDED",
    "statusCode": 403,
    "category": "business_rule",
    "message": "Your 'starter' plan allows up to 15 products, and you have room for 2 more. Upgrade, or archive some first.",
    "details": { "limit": 15, "current": 13, "requested": 5, "available": 2 }
  }
}
```

**Use `available` and `requested`, not just `limit`.** "You selected 5 and have room for 2" is the
difference between a vendor deselecting three items and a vendor giving up. The server's own
`message` already says this and is safe to show — the code's category is `business_rule`, so it is
**not** replaced at the boundary the way an `internal` or `external_service` message is.

⚠ **A draft occupies a slot.** "Occupies a catalog slot" means *not deleted, status is not
`archived`, and not already suspended by the quota sweep* — so drafts and active products both
count, and only archiving frees a slot. A vendor looking at 12 published products will not
understand a 15-product refusal unless your UI says which products are consuming slots.

## The catalog is also readable without a session

`GET /api/public/plans` and `GET /api/public/credit-packs` serve the same catalog to a **logged-out**
caller, for the marketing site — which prints real prices and previously had to hand-copy them out of
`seed-pricing-plans.ts` and `credit.config.ts`. Same numbers, a trimmed projection (`id` instead of
`_id`, no internal timestamps), plus `?role=` / `?includeInactive=true` and a 5-minute
`Cache-Control`. Contract: [public/README.md](./public/README.md).

**Dashboards should keep using the authenticated `GET /api/{role}/plans`** — it is scoped to the
caller's role and needs no filtering. The public route exists for pages that have no session at all.

## Shared endpoints (same shape for vendor / agency / agent)

Swap `{role}` for `vendor`, `agency`, or `agent`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/{role}/plans` | Active plan catalog |
| GET | `/api/{role}/plan` | Current active + pending plan, entitlements (+ shipment usage for agency) |
| POST | `/api/{role}/plans/:planId/purchase` | Start a self-serve plan purchase |
| POST | `/api/{role}/plan-purchases/:id/verify` | Verify & apply after payment (poll) |
| GET | `/api/{role}/credits` | Credit balance (can be **negative** after a chargeback) |
| GET | `/api/{role}/credits/packs` | Buyable credit packs |
| POST | `/api/{role}/credits/topups` | Start a top-up |
| POST | `/api/{role}/credits/topups/:id/verify` | Verify & credit the wallet (poll) |
| GET / PATCH | `/api/{role}/settings` | Plan-expiry notice window (`notifyDaysBeforeExpiry`, 0–90) |
| GET | `/api/{role}/transactions` | Unified plan + credit + earnings history |

**Payment / verify / polling** mechanics (gateway `instructions`, Stripe client-secret
flow, the two-plan activate-now-vs-queue rule, idempotent verify, ~3–5s polling) are
documented once in [vendor/billing.md](./vendor/billing.md) and apply unchanged to
every role. Stripe specifics: [vendor/stripe-payments.md](./vendor/stripe-payments.md).

### Response field names (changed)

The plan-assignment object is keyed **`subscriberPlan`** and carries
`owner_type` + `owner_id` (generalized from the old vendor-only `vendorPlan` /
`vendor_id`); the purchase record's applied-plan field is **`subscriber_plan_id`**
(was `vendor_plan_id`). Any existing vendor-dashboard code reading the old names
must be updated.

## Admin (catalog + assignment)

- `GET /api/internal/admin/billing/plans?role=vendor|agency|agent` — full catalog incl. inactive (omit `role` for all).
- `POST /api/internal/admin/billing/plans` — create a plan of any role; send only the limit fields that role uses (`max_active_products`/`max_storage_bytes`/`commission_percent` for vendor, `max_unterminated_shipments` for agency/agent, `live_tracking_enabled` for both).
- `POST /api/internal/admin/billing/{vendors|agencies|agents}/:id/plan` — manually assign/queue a plan (comps/support/migrations), no payment. Assigning an agent plan updates their delivery ceiling immediately.

See [admin/billing.md](./admin/billing.md).

## Notifications each dashboard must render

All three role notification stacks gained a **`planUpdates`** preference (defaults on)
and these situations — build them into the notification UI and preferences screen:

| Situation | Roles | Fires when | Deep-link |
|---|---|---|---|
| `plan.expiring` | vendor, agency, agent | Plan enters the notice window | `plans` |
| `plan.expired` | vendor, agency, agent | Plan expired → handover or downgrade to free | `plans` |
| `shipment.cap.exceeded` | agency only | Crossed the unterminated-shipment soft cap (once per crossing) | `plans` |

- Per-role notification docs: [vendor](./vendor/notifications.md) · [agency](./agency/notifications.md) · [agent](./agent/notifications.md).
- Each notification is in-app (always) + push + one preference-gated channel, localized.
- **Deep-link route:** every plan/cap notification's `action.path` is `plans` — each SPA must implement a `plans` route (it's appended to `VENDOR_APP_URL` / `AGENCY_APP_URL` / `AGENT_APP_URL`).
- WhatsApp needs the `{vendor,agency,agent}_plan_*` and `agency_shipment_cap_exceeded` templates approved in Meta before that channel delivers (in-app/push/email/Telegram work regardless): [whatsapp-templates.md](./notifications/whatsapp-templates.md) §9.

## Cap behaviour — the one real per-role difference

- **Agency cap is SOFT.** `GET /agency/plan` returns `shipments: { maxUnterminatedShipments, currentUnterminated, remaining }` for a usage meter. When `remaining === 0`, show "at capacity — upgrade", but **never disable** a shipment/checkout action — deliveries keep flowing and a `shipment.cap.exceeded` alert is raised instead.
- **Agent cap is HARD and plan-driven.** The plan sets the agent's concurrent-delivery ceiling; accepting an offer past it returns `422 AGENT_AT_CAPACITY`. The current held-count comes from the agent working-state surface, not billing.

## Live tracking (build now, gate later)

Every plan carries `live_tracking_enabled` (currently `true` everywhere). Read it,
but **do not gate any tracking UI on it yet** — it exists so a future free-tier
tracking restriction is a data change, not a frontend release. When it flips, hide
live tracking where the entitlement is `false`.

## Payment disputes (all roles)

Card charges can be reversed after the fact (webhook-driven, no user action):
a reversed **plan purchase** downgrades the owner to their free tier; a reversed
**top-up** claws credits back (balance can go negative). Render `status: "reversed"`
in history and handle negative balances.
