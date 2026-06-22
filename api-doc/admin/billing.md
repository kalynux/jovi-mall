# Admin Billing API

Admin-facing endpoints to manage the pricing plan catalog and assign plans to
vendors. Read [overview.md](./overview.md) first for concepts and data shapes.

## Base Path
```
/api/admin
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
| GET | `/api/admin/plans` | List all vendor plans (including inactive) |
| POST | `/api/admin/plans` | Create a pricing plan |
| PATCH | `/api/admin/plans/:id` | Update a pricing plan |
| DELETE | `/api/admin/plans/:id` | Archive (soft-delete) a plan |
| POST | `/api/admin/vendors/:vendorId/plan` | Assign / queue a plan for a vendor |

---

### GET /api/admin/plans

**Description**: List every vendor pricing plan, **including** inactive ones (unlike the vendor-facing list). Sorted by `sort_order`, then `price`. Soft-deleted plans are excluded.

**Request Headers**: `Authorization: Bearer <token>`

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "_id": "665f0001", "role": "vendor", "code": "starter", "name": "Starter",
      "price": 0, "currency": "XAF", "term_days": null, "credit_allowance": 50,
      "max_active_products": 15, "commission_percent": 7, "is_active": true, "sort_order": 1,
      "created_at": "2026-06-19T10:00:00.000Z", "updated_at": "2026-06-19T10:00:00.000Z"
    }
  ]
}
```

**Error Responses**: `401 UNAUTHORIZED`, `403 FORBIDDEN` (non-admin token).

---

### POST /api/admin/plans

**Description**: Create a new pricing plan. The `code` must be unique per role among non-deleted plans.

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request Body**:
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
  "commission_percent": 4,
  "is_active": true,
  "sort_order": 4
}
```

Field rules:
- `role` (string, optional, default `"vendor"`) — only `"vendor"` is supported today.
- `code` (string, **required**, 2–40 chars) — stable identifier, lowercased; unique per role.
- `name` (string, **required**, 2–80 chars).
- `price` (number, **required**, ≥ 0) — per term, in `currency`.
- `currency` (string, optional, 3-letter, default `"XAF"`).
- `term_days` (integer ≥ 1 **or** `null`, **required**) — `null` = never-expiring (free-style) plan.
- `credit_allowance` (integer, **required**, ≥ 0) — credits granted once on each activation.
- `max_active_products` (integer ≥ 0 **or** `null`, **required**) — `null` = unlimited.
- `commission_percent` (number, **required**, 0–100).
- `is_active` (boolean, optional, default `true`).
- `sort_order` (integer, optional).

**Success Response** — `201 Created`:
```json
{ "success": true, "data": { "_id": "665f0004", "code": "pro", "...": "..." }, "message": "Plan created" }
```

**Error Responses**:
- `400 VALIDATION_ERROR` — missing/invalid fields.
- `409 BILLING_PLAN_CODE_EXISTS` — a plan with this `code` already exists for the role.
- `401`, `403`.

---

### PATCH /api/admin/plans/:id

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

### DELETE /api/admin/plans/:id

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

### POST /api/admin/vendors/:vendorId/plan

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
- `paymentRef` (string, optional) — the gateway transaction reference for audit/traceability, stored on the resulting `VendorPlan`.

**Success Response (immediate activation)** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "_id": "667a0003", "vendor_id": "6601", "plan_id": "665f0002", "plan_code": "growth",
    "status": "active", "started_at": "2026-06-19T13:00:00.000Z",
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
    "_id": "667a0004", "plan_code": "business", "status": "pending_activation",
    "started_at": "2026-07-19T13:00:00.000Z", "expires_at": "2026-08-18T13:00:00.000Z",
    "allowance_granted": false, "payment_reference": "notch_tx_xyz789"
  },
  "message": "Plan assigned"
}
```
Inspect `data.status` to tell the admin whether it activated now (`active`) or was queued (`pending_activation`).

**Error Responses**:
- `404 BILLING_PLAN_NOT_FOUND` — `planId` not found.
- `409 BILLING_PLAN_INACTIVE` — the plan is archived/inactive.
- `409 BILLING_PLAN_ROLE_MISMATCH` — the plan is not a vendor plan.
- `409 BILLING_PENDING_PLAN_EXISTS` — the vendor already has a pending plan queued.
- `400 VALIDATION_ERROR` — bad body.
- `401`, `403`.

---

## Notes & constraints

- **Self-serve first.** Vendors buy and activate plans themselves (gateway-confirmed); this admin endpoint is an override for comps/support/migrations and grants the plan without a payment. Either way there is **no recurring charge** — plan expiry/handover and downgrade-to-free are handled automatically by a daily server job.
- **Immutable identity.** A plan's `code`/`role` never change; edit other fields or archive + create a replacement.
- **Editing live plans** changes only future activations. To change an active vendor's terms now, assign them a plan (which activates immediately when their current plan is free/lapsed, or queues otherwise).
- **Credit grants are one-time per activation** and guarded server-side (`allowance_granted`); re-assigning the same active plan will not double-grant.
- **Bulk re-vectorisation** (`POST /api/admin/products/bulk-vectorise`, documented under admin catalogue) is **not** charged to vendor credit wallets.
