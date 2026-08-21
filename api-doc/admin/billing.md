# Admin Billing API

> ## ⚠️ This surface moved at the Phase 5 cutover — read this before the routes below
>
> **The public mount `/api/admin` is DELETED.** It was served to any platform session
> whose `users` row carried `roles: ['admin']` — jovi-mall's second authorization model, which
> carried no tier, no permission set and no audit identity. That model is retired.
>
> **The routes themselves are unchanged and still live, at `/api/internal/admin/billing`**, behind
> `requireAdminCaller` (a service token plus `X-Actor-*` headers, never a user session). One
> factory always served both mounts, so every path, payload and response below is still exact —
> only the prefix and the guard changed. **Every path in this document has been rewritten to
> the internal prefix**, so what you read here is what the service answers.
>
> **If you are building a dashboard, this is not your document.** Call wi-admin's `/api/v1/billing` instead — it resolves the
> administrator's tier and permissions, writes the audit row, and calls this surface on your
> behalf. See [internal-service-api.md](./internal-service-api.md) for the door itself, and
> `admin/docs/api/` in the wi-admin repository for the dashboard contract.

---

Admin-facing endpoints to manage the pricing plan catalog and assign plans to
**vendors, agencies and agents**. The billing engine is one owner-scoped engine
across all three roles; a plan's `role` decides which limit fields it carries.
Read [billing-overview.md](./billing-overview.md) and
[billing-plans-across-roles.md](../billing-plans-across-roles.md) for the shared model.

## Base Path
```
/api/internal/admin/billing
```

## Authentication
All requests require a valid Bearer token with the **admin** role:
```
Authorization: Bearer <access_token>
```

---

## Endpoints summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/internal/admin/billing/plans` | List plans (all roles, incl. inactive; filter with `?role=`) |
| POST | `/api/internal/admin/billing/plans` | Create a pricing plan (any role) |
| PATCH | `/api/internal/admin/billing/plans/:id` | Update a pricing plan |
| DELETE | `/api/internal/admin/billing/plans/:id` | Archive (soft-delete) a plan |
| GET | `/api/internal/admin/billing/entitlements/:ownerType/:ownerId` | The limits this owner's plan grants |
| POST | `/api/internal/admin/billing/vendors/:vendorId/plan` | Assign / queue a plan for a vendor |
| POST | `/api/internal/admin/billing/agencies/:agencyId/plan` | Assign / queue a plan for an agency |
| POST | `/api/internal/admin/billing/agents/:agentId/plan` | Assign / queue a plan for an agent |

> **These routes used to be mounted twice, and the public URLs were SHAPED DIFFERENTLY.** The
> deleted public mount was `router.use('/admin', adminBillingRoutes)` — no `/billing` segment —
> so `/plans` was served at `/api/admin/plans` and `/vendors/:id/plan` at
> `/api/admin/vendors/:id/plan`. The surviving internal mount adds the family segment, which is
> why every path above reads `/api/internal/admin/billing/…`.
>
> That difference is worth knowing if you are reading an old dashboard bug report or an
> `admin_action_log` row: the same operation appears under two different URLs depending on when
> it was recorded. One factory served both
> (`src/modules/billing/routes/admin-billing.routes.ts`); only the public instantiation went.

---

### GET /api/internal/admin/billing/entitlements/:ownerType/:ownerId

**Description**: The limits the owner's **currently active** plan grants. Read-only.

| Param | Validation |
|---|---|
| `ownerType` | `vendor` \| `agency` \| `agent` |
| `ownerId` | 24-hex ObjectId |

```json
{
  "success": true,
  "data": {
    "ownerType": "vendor",
    "ownerId": "664ven...",
    "planCode": "vendor_growth",
    "maxActiveProducts": 500,
    "maxStorageBytes": 5368709120,
    "commissionPercent": 8,
    "maxUnterminatedShipments": null,
    "liveTrackingEnabled": true
  }
}
```

> **Every limit field is `null` when the owner has no active plan** — and this read
> deliberately does **not** lazily create the free tier the way the owner-facing
> `GET /api/{role}/plan` does. An administrator inspecting an account must not change it.
> `planCode: null` is the flag to branch on.

---

### GET /api/internal/admin/billing/plans

**Description**: List pricing plans, **including** inactive ones (unlike the role-facing lists). Sorted by `sort_order`, then `price`. Soft-deleted plans are excluded.

**Request Headers**: `Authorization: Bearer <token>`

**Query Parameters**:
- `role` (string, optional) — `vendor` | `agency` | `agent`. When omitted, **all roles** are returned (concatenated). Pass it to build a per-role catalog table.

**Success Response** — `200 OK` (mixed roles when `?role` omitted):
```json
{
  "success": true,
  "data": [
    {
      "_id": "665f0001", "role": "vendor", "code": "starter", "name": "Starter",
      "price": 0, "currency": "XAF", "term_days": null, "credit_allowance": 50,
      "max_active_products": 15, "max_storage_bytes": 1073741824, "commission_percent": 7,
      "max_unterminated_shipments": null, "live_tracking_enabled": true,
      "is_active": true, "sort_order": 1,
      "created_at": "2026-06-19T10:00:00.000Z", "updated_at": "2026-06-19T10:00:00.000Z"
    },
    {
      "_id": "665f1001", "role": "agency", "code": "agency_free", "name": "Agency Free",
      "price": 0, "term_days": null, "credit_allowance": 50,
      "max_unterminated_shipments": 1000, "live_tracking_enabled": true,
      "max_active_products": null, "max_storage_bytes": null, "commission_percent": null,
      "is_active": true, "sort_order": 1
    },
    {
      "_id": "665f2001", "role": "agent", "code": "agent_free", "name": "Agent Free",
      "price": 0, "term_days": null, "credit_allowance": 20,
      "max_unterminated_shipments": 20, "live_tracking_enabled": true,
      "is_active": true, "sort_order": 1
    }
  ]
}
```
Limit fields are **role-specific** and `null` when not applicable: vendor plans use `max_active_products` / `max_storage_bytes` / `commission_percent`; agency & agent plans use `max_unterminated_shipments`. `live_tracking_enabled` applies to agency/agent (universal `true` today).

**Error Responses**: `400 VALIDATION_ERROR` (bad `role`), `401 UNAUTHORIZED`, `403 FORBIDDEN` (non-admin token).

---

### POST /api/internal/admin/billing/plans

**Description**: Create a new pricing plan. The `code` must be unique per role among non-deleted plans.

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request Body** (vendor plan):
```json
{
  "role": "vendor",
  "code": "pro",
  "name": "Pro",
  "price": 12000,
  "currency": "XAF",
  "term_days": 30,
  "credit_allowance": 600,
  "max_active_products": 400,
  "max_storage_bytes": 21474836480,
  "commission_percent": 4,
  "is_active": true,
  "sort_order": 4
}
```

**Request Body** (agency or agent plan):
```json
{
  "role": "agency",
  "code": "agency_growth",
  "name": "Agency Growth",
  "price": 15000,
  "term_days": 30,
  "credit_allowance": 500,
  "max_unterminated_shipments": 5000,
  "live_tracking_enabled": true,
  "is_active": true,
  "sort_order": 2
}
```

Field rules:
- `role` (string, optional, default `"vendor"`) — `vendor` | `agency` | `agent`.
- `code` (string, **required**, 2–40 chars) — stable identifier, lowercased; unique **per role**.
- `name` (string, **required**, 2–80 chars).
- `price` (number, **required**, ≥ 0) — per term, in `currency`.
- `currency` (string, optional, 3-letter, default `"XAF"`).
- `term_days` (integer ≥ 1 **or** `null`, **required**) — `null` = never-expiring (free-style) plan.
- `credit_allowance` (integer, **required**, ≥ 0) — credits granted once on each activation.
- **Role-specific limit fields (all optional/nullable — send those the role uses):**
  - `max_active_products` (integer ≥ 0 | `null`) — **vendor**; `null` = unlimited.
  - `max_storage_bytes` (integer ≥ 0 | `null`) — **vendor**.
  - `commission_percent` (number, 0–100 | `null`) — **vendor**.
  - `max_unterminated_shipments` (integer ≥ 0 | `null`) — **agency & agent**; `null` = unlimited. For **agent** plans this becomes the agent's concurrent-delivery cap (hard). For **agency** plans it is a soft cap (alert only).
  - `live_tracking_enabled` (boolean, default `true`) — agency/agent; keep `true` (future free-tier gate).
- `is_active` (boolean, optional, default `true`) — set `false` to define a tier that is not yet purchasable.
- `sort_order` (integer, optional).

> The seed (`npm run seed:plans`) already creates 3 tiers per role (free active, two paid inactive). Use this endpoint for ad-hoc tiers/tweaks; prefer editing the seed for the canonical catalog.

**Success Response** — `201 Created`:
```json
{ "success": true, "data": { "_id": "665f0004", "code": "pro", "...": "..." }, "message": "Plan created" }
```

**Error Responses**:
- `400 VALIDATION_ERROR` — missing/invalid fields.
- `409 BILLING_PLAN_CODE_EXISTS` — a plan with this `code` already exists for the role.
- `401`, `403`.

---

### PATCH /api/internal/admin/billing/plans/:id

**Description**: Update a pricing plan's mutable fields. **`code` and `role` are immutable** (silently ignored if sent) so existing vendor assignments stay stable. Changing `price`, `credit_allowance`, `max_active_products`, etc. affects **future** activations only — already-active vendor plans keep the terms they were activated with (allowances were already granted; their stored `expires_at` is unchanged).

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Path Parameters**:
- `id` (string, **required**) — plan `_id` (24-char hex).

**Request Body** (all fields optional; same rules as create, minus `code`/`role`):
```json
{ "price": 6000, "credit_allowance": 300, "is_active": false }
```

**Success Response** — `200 OK`:
```json
{ "success": true, "data": { "_id": "665f0002", "price": 6000, "...": "..." }, "message": "Plan updated" }
```

**Error Responses**:
- `400 VALIDATION_ERROR`, `404 BILLING_PLAN_NOT_FOUND`, `401`, `403`.

---

### DELETE /api/internal/admin/billing/plans/:id

**Description**: Archive (soft-delete) a plan. It disappears from both the vendor and admin lists and can no longer be assigned. Existing vendor assignments referencing it are unaffected.

**Request Headers**: `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, **required**) — plan `_id`.

**Success Response** — `200 OK`:
```json
{ "success": true, "message": "Plan archived" }
```

**Error Responses**: `404 BILLING_PLAN_NOT_FOUND`, `401`, `403`.

---

### POST /api/internal/admin/billing/vendors/:vendorId/plan

**Description**: Manually assign a plan to a vendor. This is an **admin override** for comps, support fixes, or migrations — the normal path is the vendor buying a plan themselves (`POST /vendor/plans/:planId/purchase`, see the [vendor billing doc](../vendor/billing.md)), which auto-activates on payment with no admin step. This endpoint applies the **same two-plan rule** without requiring a payment:

- If the vendor's current active plan is **free / never-expiring** (or they have none): the new plan **activates immediately** — `started_at = now`, `expires_at = now + term_days`, and the credit allowance is granted once. Any existing free record is marked `expired`.
- If the current active plan is a **paid plan with a future `expires_at`**: the new plan is **queued** as `pending_activation`, starting exactly when the active plan expires (`started_at = active.expires_at`). Its allowance is **not** granted until it activates. Only one pending plan is allowed.

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Path Parameters**:
- `vendorId` (string, **required**) — the vendor's id (24-char hex).

**Request Body**:
```json
{ "planId": "665f0002", "paymentRef": "notch_tx_abc123" }
```
- `planId` (string, **required**) — the `_id` of an **active** plan.
- `paymentRef` (string, optional) — the gateway transaction reference for audit/traceability, stored on the resulting `SubscriberPlan`.

**Success Response (immediate activation)** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "_id": "667a0003", "owner_type": "vendor", "owner_id": "6601", "plan_id": "665f0002",
    "plan_code": "growth", "status": "active", "started_at": "2026-06-19T13:00:00.000Z",
    "expires_at": "2026-07-19T13:00:00.000Z", "assigned_by": "60a1",
    "payment_reference": "notch_tx_abc123", "allowance_granted": true
  },
  "message": "Plan assigned"
}
```

**Success Response (queued as pending)** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "_id": "667a0004", "owner_type": "vendor", "plan_code": "business", "status": "pending_activation",
    "started_at": "2026-07-19T13:00:00.000Z", "expires_at": "2026-08-18T13:00:00.000Z",
    "allowance_granted": false, "payment_reference": "notch_tx_xyz789"
  },
  "message": "Plan assigned"
}
```
The returned record is a **SubscriberPlan** (`owner_type`/`owner_id`, generalized from the old `vendor_id`). Inspect `data.status` to tell the admin whether it activated now (`active`) or was queued (`pending_activation`).

**Error Responses**:
- `404 BILLING_PLAN_NOT_FOUND` — `planId` not found.
- `409 BILLING_PLAN_INACTIVE` — the plan is archived/inactive.
- `409 BILLING_PLAN_ROLE_MISMATCH` — the plan's role ≠ `vendor`.
- `409 BILLING_PENDING_PLAN_EXISTS` — the vendor already has a pending plan queued.
- `400 VALIDATION_ERROR` — bad body.
- `401`, `403`.

---

### POST /api/internal/admin/billing/agencies/:agencyId/plan · POST /api/internal/admin/billing/agents/:agentId/plan

**Description**: Manually assign a plan to an **agency** or an **agent** — the same override, same body, same two-plan rule as the vendor endpoint above. The path param is the target's id, and `planId` must be a plan whose `role` matches (`agency` / `agent`). The response is a SubscriberPlan with the matching `owner_type`.

**Path Parameters**: `agencyId` / `agentId` (string, **required**).

**Request Body**: `{ "planId": "665f1002", "paymentRef": "manual-comp-001" }` (same as vendor; `paymentRef` optional).

**Success Response** — `200 OK`: same shape as the vendor assign response, with `owner_type: "agency"` / `"agent"`.

**Agent-specific effect:** assigning/activating an agent plan immediately updates the agent's concurrent-delivery ceiling (`capacity.max_active_shipments`). Assigning `agent_free` (or a downgrade) sets it back to 20.

**Error Responses**: identical to the vendor assign (`BILLING_PLAN_NOT_FOUND`, `BILLING_PLAN_INACTIVE`, `BILLING_PLAN_ROLE_MISMATCH` when the plan's role ≠ the path role, `BILLING_PENDING_PLAN_EXISTS`, `VALIDATION_ERROR`, `401`, `403`).

---

## Notes & constraints

- **Self-serve first.** Vendors, agencies and agents buy and activate plans themselves (gateway-confirmed); these admin endpoints are an override for comps/support/migrations and grant the plan without a payment. Either way there is **no recurring charge** — plan expiry/handover and downgrade-to-free are handled automatically by a daily server job (across all three roles).
- **Immutable identity.** A plan's `code`/`role` never change; edit other fields or archive + create a replacement.
- **Editing live plans** changes only future activations. To change an active owner's terms now, assign them a plan (which activates immediately when their current plan is free/lapsed, or queues otherwise).
- **Role limits differ.** Vendor plans gate products/storage/commission; agency & agent plans gate `max_unterminated_shipments` (agency = soft/alert, agent = hard/enforced). `live_tracking_enabled` is universal `true` today (future free-tier gate).
- **Credit grants are one-time per activation** and guarded server-side (`allowance_granted`); re-assigning the same active plan will not double-grant.
- **Bulk re-vectorisation** (`POST /api/internal/admin/dev-tools/catalogue/vectorise`, documented in [dev-tools.md](./dev-tools.md)) is **not** charged to vendor credit wallets.
