# Vendor administration — the internal API

**Verified against source on 2026-09-08** — the eight `/api/internal/admin/vendors` routes, the suspend/restore cascade response, the `PATCH /settings` three-field schema, and every error code named here (all seven are raised in `src/`), against `jovi-mall/src/modules/vendors/{admin-vendor.routes.ts,admin-vendor.service.ts}`. The plan-assignment route was named on the deleted `/api/admin/*` prefix in two places.

> **This is not a dashboard surface.** Every endpoint here lives under
> `/api/internal/admin/vendors` and is called by the **wi-admin backend**, never by a
> browser. The dashboard talks to wi-admin's `/api/v1/vendors`, which reads `jovi_mall`
> directly and delegates each write to one of the calls below.
>
> Design record: `../../../admin/docs/ADR-008-VENDOR-MANAGEMENT.md`.

## Authentication

`requireAdminCaller` (`src/api/middlewares/admin-caller.middleware.ts`):

| Header | Required | Meaning |
|---|---|---|
| `X-Service-Token` | yes | `INTERNAL_ADMIN_SERVICE_TOKEN`, compared in constant time. `Authorization: Bearer <token>` is accepted as an alternative |
| `X-Actor-Id` | yes | The acting administrator's `admin_accounts._id` from the **wi-admin** database. Must be a valid ObjectId |
| `X-Actor-Name` | no | Snapshotted onto every actor stamp this surface writes. Defaults to `Administrator` |
| `X-Request-Id` | no | Correlation id, echoed into logs |

The token is a **full-privilege credential**: authorization is resolved in wi-admin before
the call and re-checked nowhere here. Unset secret ⇒ `503`; bad token ⇒ `401`; missing or
malformed actor ⇒ `400`.

`X-Actor-Id` resolves to **nothing in this database**. Every field it is written into
carries the companion `_source: 'admin'` and a `_name` snapshot, because a cross-database
join cannot exist — see `src/core/types/actor-source.types.ts`.

---

## `POST /:vendorId/suspend`

Body: `{ "reason": string }` — required, 3–500 characters, trimmed.

Moves `Vendor.status` `active | pending_verification → inactive` as a **compare-and-set**,
and in the **same transaction** suspends every one of that vendor's products that is
currently `active`.

Two things happen beyond the column, and both are the reason this is not a wi-admin write:

- **The vendor's API access stops.** `requireAuth` and `login` refuse an `inactive` vendor
  with `403 AUTH_VENDOR_SUSPENDED` from their next request onward.
- **The catalogue comes off sale**, under reason `vendor_suspended`, capturing each
  product's own previous status. Products that are not `active` are untouched — they were
  not on sale — and so is anything already suspended for another reason, which keeps that
  reason.

```jsonc
{
  "success": true,
  "message": "Vendor suspended and their listings taken off sale",
  "data": {
    "id": "…", "status": "inactive",
    "suspension": {
      "at": "2026-08-11T09:14:02.000Z",
      "reason": "fraudulent listings",
      "fromStatus": "active",
      "by": { "id": "<wi-admin id>", "source": "admin", "name": "Jane Doe" }
    },
    "suspendedProductIds": ["…", "…"],
    "suspendedProductCount": 2
  }
}
```

| Status | Code | When |
|---|---|---|
| 404 | `VENDOR_NOT_FOUND` | no such vendor |
| 409 | `VENDOR_STATUS_CONFLICT` | already suspended, or another administrator moved it first |

## `POST /:vendorId/restore`

No body. Moves `inactive → suspended_from_status` — the status recorded at suspension, **not
a hardcoded `active`**: a fraudulent signup suspended while still `pending_verification`
must not be promoted past a verification step it never passed.

Puts back the listings **this** cascade took down, and only those. Each one is re-validated
against the activation gate first, so a product that went stale while it was off sale stays
suspended.

> **`restoredProductCount` is routinely smaller than `suspendedProductCount`.** That is
> correct rather than a partial failure. A listing whose delivery agency went inactive
> meanwhile, for example, cannot go back on sale — and republishing it blindly would put a
> product on the storefront that the vendor's own activation path would refuse.

`409 VENDOR_STATUS_CONFLICT` when the vendor is not suspended.

## `POST /:vendorId/kyc/approve` · `POST /:vendorId/kyc/reject`

Approve body: `{ "note"?: string }`. Reject body: `{ "reason": string }` — **required**.

Writes the whole verdict in one `$set`: `kyc_details.status`, `legit_verified`,
`verified_at`, `rejection_reason` and the reviewer stamp. The boolean and the status can
never disagree.

The rejection reason is stored **here**, on the vendor row, not only in wi-admin's audit
trail — this service cannot read that database, so a reason held only there could never be
shown to the vendor it is about.

> ⚠ **"Verification gates nothing today" was true until 2026-09-15 and is now FALSE.** This
> paragraph used to end there, on the grounds that `requireLegitBusiness` had zero call sites
> and was deleted on 2026-08-19. Two things read the verdict now, and both are about money:
>
> - **the payout allowance** — an unverified owner's withdrawals can be capped within a
>   rolling window (`EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED`), inert until a deployment sets
>   a number, but no longer nothing;
> - **the admin payout queue** — every row carries `verification: { verified, verdict }`, read
>   fresh, because `status: "active"` stopped being evidence that anybody vetted the business.
>
> It is still surfaced to agencies as `kycVerified` through `agency-vendor-browse.dto.ts`, and
> it still refuses nothing on the request path: an unverified vendor trades normally. Working
> with an unverified counterparty is the other party's judgement, not a platform refusal.

`409 VENDOR_KYC_STATUS_CONFLICT` on a second approval or a second rejection — and **only**
on that. A rejected vendor is re-verifiable and a verified one is re-rejectable; the guard
refuses a repeat of the verdict being written, nothing else.

> ⚠ **The guard moved into the write on 2026-09-15** and the rule did not change. It was a
> read, a comparison and then an unpredicated update, which refuses a second administrator
> only if they are far enough apart in time — two opposite verdicts in the same instant both
> read the old value, both passed, and both wrote. It is now a compare-and-set, matching the
> agency endpoints, which gained the same shape in the same release (BR-026 § 2).

## `POST /:vendorId/products/:productId/suspend` · `.../restore`

Suspend body: `{ "note": string }` — required, and it is what the vendor is shown.

Platform oversight on **one** listing, under reason `platform_oversight`. Scoped by both
ids, so a product belonging to another vendor cannot be acted on by naming this one.

Its reason is distinct from `vendor_suspended` for one reason worth stating plainly:
**suspending and reinstating the whole vendor must not republish a listing an administrator
took down on its merits.** Nothing automatic clears `platform_oversight` — only the restore
here does, and it refuses anything suspended for a different reason.

| Status | Code | When |
|---|---|---|
| 422 | `VENDOR_PRODUCT_NOT_SUSPENDABLE` | the product is not currently on sale |
| 422 | `VENDOR_PRODUCT_NOT_OVERSIGHT_SUSPENDED` | it is suspended, but by an agency or the vendor cascade — not this lever's to lift |
| 422 | `VENDOR_PRODUCT_UNSUSPEND_BLOCKED` | the activation gate refuses it; `details.blockers[]` carries the whole checklist |

## `PATCH /:vendorId/settings`

```jsonc
{
  "autoCancelUnpaidDays": 7,          // 1–90
  "autoRedirectOrdersToAgency": true,
  "autoRedirectThresholdAmount": null // null clears the cap
}
```

At least one field; unknown fields are a `400`.

**Three fields only, and the rule that picks them:** a setting is an administrator's when
its effect lands on somebody *other than the vendor* — the platform's unpaid-order sweep,
the agency receiving the shipment, the customer waiting on the order.

Deliberately absent: `notify_days_before_expiry` (notifies the vendor, about the vendor)
and `customer_flags` (their private CRM vocabulary, referenced by `VendorCustomer.flag_ids`).
**Commission is absent and is not an oversight** — it lives on `PricingPlan.commission_percent`
and is set by assigning a plan through `POST /api/internal/admin/billing/vendors/:vendorId/plan`.

---

## What this surface deliberately does not carry

**No reads.** wi-admin queries `vendors`, `stores`, `products`, `vendor_settings`,
`vendor_agency_connections` and `orders` directly — a read protects no invariant, and
routing one through here would put an HTTP hop in front of a `find()`.

**No profile edits.** A vendor's business name, addresses, policies, payout destinations
and catalogue content are theirs. An administrator suspends, verifies and oversees; they do
not act as the vendor.

**No plan assignment.** `POST /api/internal/admin/billing/vendors/:vendorId/plan` already exists in the
billing module, behind `billing.subscriptions.assign`. Nothing here duplicates it.

> ⚠ **Both mentions of that route named `POST /api/admin/vendors/:vendorId/plan` until
> 2026-09-08.** No `/api/admin/*` route has existed since the Phase 5 Part E cutover, and the
> billing router mounts this one under its own `/billing` segment
> (`billing/routes/admin-billing.routes.ts:52`), so the old path was wrong twice over.
> `billing.md` is the contract; wi-admin surfaces it at `POST /api/v1/billing/vendors/:vendorId/plan`.
