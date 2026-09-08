# Admin Delivery Agencies API

**Verified against source on 2026-09-08** — the six `/api/internal/admin/agencies` routes, the `.strict()` reject body (`reason` 3-500 required), the verify/reject compare-and-set on `pending_verification` and the fields each verdict moves, against `jovi-mall/src/modules/delivery/{admin-agency.routes.ts,validators/admin-agency.validator.ts:25-34}`. Three defects: the Base Path read `/api/admin`, the Authentication section described the deleted `requireRole([\x27admin\x27])` session, and a leftover two-mount note claimed five routes on a second mount that no longer exists.

> ## ⚠️ This surface moved at the Phase 5 cutover — read this before the routes below
>
> **The public mount `/api/admin/delivery-agencies` is DELETED.** It was served to any platform session
> whose `users` row carried `roles: ['admin']` — jovi-mall's second authorization model, which
> carried no tier, no permission set and no audit identity. That model is retired.
>
> **The routes themselves are unchanged and still live, at `/api/internal/admin/agencies`**, behind
> `requireAdminCaller` (a service token plus `X-Actor-*` headers, never a user session). One
> factory always served both mounts, so every path, payload and response below is still exact —
> only the prefix and the guard changed. **Every path in this document has been rewritten to
> the internal prefix**, so what you read here is what the service answers.
>
> **If you are building a dashboard, this is not your document.** Call wi-admin's `/api/v1/agencies` instead — it resolves the
> administrator's tier and permissions, writes the audit row, and calls this surface on your
> behalf. See [internal-service-api.md](./internal-service-api.md) for the door itself, and
> `admin/api-doc/api/` in the wi-admin repository for the dashboard contract.

---

Admin-facing endpoints to manage delivery agency accounts. There is no hard delete —
"deactivating" an agency flips its `status` to `inactive` (agencies are referenced by
historical orders/shipments and can't be safely removed).

## Base Path
```
/api/internal/admin/agencies
```

## Authentication

`requireAdminCaller` (`src/api/middlewares/admin-caller.middleware.ts`) — a **service** call from
wi-admin, not a browser session:

| Header | Required | Meaning |
|---|---|---|
| `X-Service-Token` | yes | `INTERNAL_ADMIN_SERVICE_TOKEN`, compared in constant time. `Authorization: Bearer <token>` is accepted as an alternative |
| `X-Actor-Id` | yes | The acting administrator’s `admin_accounts._id` from the **wi-admin** database. Must be a valid ObjectId |
| `X-Actor-Name` | no | Snapshotted onto the actor stamps this surface writes. Defaults to `Administrator` |
| `X-Request-Id` | no | Correlation id, echoed into logs |

Unset secret ⇒ `503`; bad token ⇒ `401`; missing or malformed actor ⇒ `400`.

> ⚠ **This section said *"a valid Bearer token with the admin role"* until 2026-09-08** — the
> deleted public mount’s `requireRole(['admin'])` guard, on a platform `users` row. There is no
> such mount: every `/api/admin/*` route went at the Phase 5 Part E cutover, and this router is
> instantiated once, with `[requireAdminCaller]` (`api/routes/internal-admin.routes.ts`).

---

## Endpoints summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/internal/admin/agencies` | List all agencies (any status), paginated |
| GET | `/api/internal/admin/agencies/:id` | Get one agency by id |
| POST | `/api/internal/admin/agencies/:id/verify` | Approve business verification — the exit from `pending_verification` |
| POST | `/api/internal/admin/agencies/:id/reject` | Refuse business verification, with a reason. Changes no status |
| PATCH | `/api/internal/admin/agencies/:id/deactivate` | Deactivate an agency |
| PATCH | `/api/internal/admin/agencies/:id/reactivate` | Reactivate an agency |

> ⚠ **This note said *"the same five routes are also mounted at `/api/internal/admin/agencies/*`
> behind the service token"* until 2026-09-08, and it is now circular** — the six rows above ARE
> that mount, and there is no second one. The public `/api/admin/delivery-agencies` twin the note
> was contrasting against went at the Phase 5 Part E cutover. Note also **six** routes, not five.

---

## POST `/api/internal/admin/agencies/:id/verify`

The **only** exit from `pending_verification`. Approving moves `status` and both
`legit_verified` mirrors together in **one compare-and-set**, and stamps the approving actor
onto the agency.

**This is not `reactivate`.** `reactivate` was being used for first approvals and also runs the
product-restore cascade — which a never-verified agency has nothing for. Use `verify` for the
first approval and `reactivate` only to undo a `deactivate`.

### Responses

```json
{ "success": true, "data": { "...": "the agency" }, "message": "Agency verified and activated." }
```

| `error.code` | Status | When |
|---|---|---|
| `DELIVERY_AGENCY_NOT_FOUND` | 404 | No agency with that id |
| `DELIVERY_AGENCY_STATUS_CONFLICT` | 409 | The agency is not `pending_verification` — usually because another administrator approved it first. `details.currentStatus` carries the actual status. **Re-read before deciding**; do not resend |

---

## POST `/api/internal/admin/agencies/:id/reject`

The other verdict. Same compare-and-set on `pending_verification`, same 409 on a miss.

```jsonc
{ "reason": "Transport licence has expired" }   // required, 3–500 chars, trimmed
```

**The reason is stored on the agency** (`kyc_details.rejection_reason`) rather than only in
wi-admin's audit trail, and that is the point of the endpoint: the agency is shown it, and
cannot read the admin database. A refusal whose cause they cannot see is one they cannot act
on — they re-submit the same unchanged application, and it costs a second review.

### ⚠ It changes no status, and that is deliberate

The agency stays `pending_verification`. It is **not** moved to `inactive` — that is
`deactivate`, which runs the whole product-suspension cascade a never-verified agency has
nothing for.

Staying pending is what makes rejection safe to apply without new enforcement: a
non-`active` agency is already refused by product activation, pickup resolution, COD
eligibility and vendor default-agency selection. And it is why **there is no un-reject** —
the agency is still pending, so `POST /verify` accepts them once they fix what the reason
names.

### What moves

| Field | After a rejection |
|---|---|
| `kyc_details.status` | `rejected` |
| `kyc_details.rejection_reason` | the reason |
| `kyc_details.legit_verified` · `legit_verified` | `false` (both, together) |
| `kyc_details.verified_at` | `null` — cleared, so an approval that was withdrawn does not read as still standing |
| `kyc_details.verified_by_*` | the reviewing actor |
| `status` | **unchanged** — still `pending_verification` |

### Why the verdict exists at all

`legit_verified: false` meant BOTH "never reviewed" and "reviewed and refused". No reader
could tell them apart, so a review queue was unbuildable and an agency was never told what
to fix. `kyc_details.status` carries the verdict; `legit_verified` stays as its boolean
projection, and the two are **written together and never apart**. Same shape as the vendor
lifecycle, for the same reason.

### Responses

```json
{ "success": true, "data": { "...": "the agency" }, "message": "Agency verification rejected." }
```

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing, blank, under 3 or over 500 characters, or an unknown field (the schema is strict) |
| `DELIVERY_AGENCY_NOT_FOUND` | 404 | No agency with that id |
| `DELIVERY_AGENCY_STATUS_CONFLICT` | 409 | Not `pending_verification` — another administrator reached a verdict first. `details.currentStatus` carries it |

---

## Deactivation cascade — what actually happens

A vendor's **default delivery agency** (`Vendor.default_delivery_agency_id`) is a hard
prerequisite for selling physical products — a physical product can never reach `active`
status unless the vendor's default agency exists and is currently `active` (see
[Catalog: Product Status](../vendor/product-upload-flow.md)). **Independently**, if a
product has its **own** delivery-agency override set, that override must ALSO be active —
both conditions are enforced together, not either/or. A broken override blocks just that
one product; a broken vendor default blocks every physical product the vendor has.

**`PATCH /:id/deactivate`**:
1. Sets the agency's `status` to `inactive`.
2. Finds every vendor whose `default_delivery_agency_id` currently points at this agency,
   and suspends their **`active`** physical products — moving each to `status: "suspended"`
   and individually snapshotting its own prior status so it can be restored exactly later.
   Non-active products (draft/archived/pending_review) are left untouched: they cannot
   reach `active` without passing the activation gate anyway, and stay freely editable
   while the agency problem lasts.
3. Separately, finds every physical product (any vendor) whose **own** delivery-agency
   override points at this agency, and suspends just those specific products the same way
   — independent of whether their vendor's default agency is fine.
4. Puts every still `pending`/`assigned` order item currently riding this agency on hold
   (`delivery.status: "pending_agency_reassignment"`) — **any vendor, regardless of
   whether the item got this agency via a product override or the vendor default** — and
   mirrors the hold onto the corresponding `Shipment.status`. Already-suspended products
   and already-held/dispatched items are left untouched.

**`PATCH /:id/reactivate`** reverses all three: restores vendor-default-suspended products,
restores own-override-suspended products, and resumes held order items/shipments back to
their individually-saved prior status — **but only for products/items affected by THIS
specific reason**; anything suspended/held for a different reason is left alone.

> [!IMPORTANT]
> **Restoring to `active` is validated, not blind.** A product can be suspended for two
> independent reasons (its vendor's default agency gone, or its own override gone). When
> restoring, if the saved previous status was `active`, the activation gate is re-checked
> before flipping the status back — if the *other* reason is still broken, the product stays
> suspended (with its existing suspension reason left as-is). Non-`active` previous statuses
> (legacy rows suspended before the active-only rule) always restore directly.

Both actions are **idempotent** — deactivating an already-inactive agency (or reactivating
an already-active one) is a no-op that returns the current state with everything zeroed out.

A vendor can also independently clear a vendor-default-driven suspension by switching to a
**different active** default agency via `PUT /api/vendor/profile/default-delivery-agency`
— see [Vendor Profile](../vendor/profile.md#put-apivendorprofiledefault-delivery-agency).
Vendors cannot clear their default to null themselves; deactivation by an admin is the only
way a default becomes unset. Similarly, a vendor can clear a product-override-driven
suspension by editing that product's own delivery agency — see
[Vendor Products](../vendor/products.md).

> [!IMPORTANT]
> **In-flight orders are held, not silently abandoned.** `Order.items[].delivery.agency_id`
> and `Shipment.agency_id` are resolved once, at order-creation (or manual-reassignment)
> time — they never dynamically follow the vendor's default or a product's override. Without
> the hold mechanism above, an order riding a deactivated agency would just sit there with no
> visible indication it can't be delivered. A deactivated agency is **not** locked out of
> acting on shipments it already holds past the hold boundary (anything already
> `picked_up`/`in_transit`/etc. is left completely alone — the hold only ever touches
> `pending`/`assigned` items, mirroring the existing reassignment boundary).
>
> Held items only resume once a replacement agency is configured: reactivating the SAME
> agency resumes them in place (nothing moved); setting a **different** default agency
> (`PUT /api/vendor/profile/default-delivery-agency`) or fixing a product's own override
> (`PATCH /api/vendor/products/:id`) reassigns the relevant held items to the new agency.

---

### GET /api/internal/admin/agencies

**Description**: List every delivery agency, including `inactive` and
`pending_verification` ones (unlike the vendor-facing agency browser).

**Query Parameters**:
| Param | Type | Notes |
|---|---|---|
| `status` | `'active' \| 'pending_verification' \| 'inactive'` | Optional filter |
| `page` | `number` | Default `1` |
| `limit` | `number` | Default `20`, max `50` |

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "id": "683abc1234567890abcdef01",
      "userId": "683abc1234567890abcdef00",
      "agencyName": "Swift Deliveries Cameroon",
      "logo": { "id": "507f1f77bcf86cd799439030", "key": "images/2026/07/swift-logo.png", "url": "https://cdn.example.com/logos/swift-deliveries.png", "access": "public", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" },
      "status": "active",
      "onboardingStep": 0,
      "createdAt": "2026-01-10T08:00:00.000Z",
      "updatedAt": "2026-06-01T12:30:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

---

### GET /api/internal/admin/agencies/:id

**Success Response** — `200 OK`: same item shape as the list endpoint.

**Error Responses**: `404 DELIVERY_AGENCY_NOT_FOUND`.

---

### PATCH /api/internal/admin/agencies/:id/deactivate

**Description**: Deactivate the agency and cascade-suspend affected vendors' physical
products (see above). No request body.

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "id": "683abc1234567890abcdef01",
    "userId": "683abc1234567890abcdef00",
    "agencyName": "Swift Deliveries Cameroon",
    "logo": { "id": "507f1f77bcf86cd799439030", "key": "images/2026/07/swift-logo.png", "url": "https://cdn.example.com/logos/swift-deliveries.png", "access": "public", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" },
    "status": "inactive",
    "onboardingStep": 0,
    "createdAt": "2026-01-10T08:00:00.000Z",
    "updatedAt": "2026-07-07T09:00:00.000Z"
  },
  "meta": { "suspendedProductCount": 14, "heldOrderItemCount": 6 },
  "message": "Agency deactivated. 14 product(s) suspended, 6 order item(s) put on hold."
}
```
`suspendedProductCount` combines both vendor-default-driven and own-override-driven
suspensions. `heldOrderItemCount` is every still pending/assigned order item (any vendor,
any provenance) that was riding this agency.

**Error Responses**: `404 DELIVERY_AGENCY_NOT_FOUND`.

---

### PATCH /api/internal/admin/agencies/:id/reactivate

**Description**: Reactivate the agency and cascade-restore affected vendors' physical
products suspended for this reason (see above). No request body.

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "id": "683abc1234567890abcdef01",
    "userId": "683abc1234567890abcdef00",
    "agencyName": "Swift Deliveries Cameroon",
    "logo": { "id": "507f1f77bcf86cd799439030", "key": "images/2026/07/swift-logo.png", "url": "https://cdn.example.com/logos/swift-deliveries.png", "access": "public", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" },
    "status": "active",
    "onboardingStep": 0,
    "createdAt": "2026-01-10T08:00:00.000Z",
    "updatedAt": "2026-07-07T10:00:00.000Z"
  },
  "meta": { "restoredProductCount": 12, "unheldOrderItemCount": 6 },
  "message": "Agency reactivated. 12 product(s) restored, 6 order item(s) resumed."
}
```
`restoredProductCount` can be lower than what was originally suspended if some products are
still blocked by an unrelated, still-broken agency reference (see the restore-validation
note above) — those stay suspended.

**Error Responses**: `404 DELIVERY_AGENCY_NOT_FOUND`.
