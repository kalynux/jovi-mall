# Frontend changelog — plan limits are now enforced after a downgrade

**Verified against source on 2026-09-08** — the three refusal endpoints and the `details` shape against `billing/services/entitlement.service.ts:100-115` and `catalog/controllers/vendor-product.controller.ts:323,371`, the suspension-reason enum against `catalog/models/product.model.ts:85-101`, the gallery filter against `catalog/read-models/product-image.resolver.ts:41-42`, the release path against `plan-quota/events/plan-quota.consumer.ts` and `config/plan-quota.config.ts`. **Three defects fixed** — the content-route claim in §1.3 contradicted §5 and named an admin-only route, and §4 named an `/api/tickets/…` mount that does not exist.

**Applies to:** vendor dashboard · agency dashboard · agent app · admin dashboard · storefront
**Status:** shipped 2026-09-06
**Wire changes:** one new `FileDetail.access` value and one new product suspension reason (both
**additive** — nothing removed, no endpoint changed shape), plus **two ticket file URLs that became
nullable** (§4 — they were returning links that could not load). Three endpoints can now refuse
where they previously did not (§3).

---

## What changed on the platform

Plan limits used to bind **only at the moment a product was created**, on two endpoints. A vendor
who dropped from a 100 GB / unlimited-product plan to a 1 GB / 15-product one kept every product
live and every byte served, indefinitely. Nothing ever recounted.

Now, on every plan change, the backend recomputes what fits inside the plan the owner is actually
on — **oldest first** — and holds back whatever no longer does:

- products past the allowance are **suspended** (`status: "suspended"`, reason
  `plan_quota_exceeded`);
- files past the storage allowance are **blocked** (`access: "quota_blocked"`, `url: null`).

**Nothing is deleted.** Both states are reversible, and an upgrade releases items **oldest-first**
until the new allowance is full. The same file, with the same id, comes back unchanged.

### Worked example

A vendor has products **A** (images 1, 2, 3), **B** (4, 5) and **C** (6, 7, 8), created in that
order. They downgrade to a plan allowing **2 products**, whose storage allowance is exactly filled
by images 1–4.

| | Result |
|---|---|
| Product A | active, shows images 1, 2, 3 |
| Product B | **active**, shows image 4 only — image 5 is blocked |
| Product C | **suspended** — off the storefront entirely |

Note the second row: **a live product can have blocked images.** The two allowances are counted
independently, so do not infer one from the other.

---

## 1. `FileDetail.access` gained a third value

```diff
- access: "public" | "authorized"
+ access: "public" | "authorized" | "quota_blocked"
```

| value | `url` | what it means | what to render |
|---|---|---|---|
| `public` | a real URL | ordinary public file | the image |
| `authorized` | `null` | private tree (delivery proof, digital asset) — fetch via the owning entity's own route | the entity's authorized viewer |
| **`quota_blocked`** | `null` | **the owner is over their plan's storage allowance and this file falls outside it** | a placeholder + a link to the plan page |

**Three things to get right:**

1. **It is a billing state, not a missing file and not a permissions problem.** The bytes are
   intact. Do not render "file not found", "deleted", or an error — and do not send the user to
   support. The correct message is *"this image is above your current plan's storage allowance"*,
   with a route to upgrade.
2. **It outranks `authorized`.** A blocked file that also sits in a private tree reports
   `quota_blocked`. So branch on `quota_blocked` **before** `authorized`, or you will send the user
   to a content route that cannot help them.
3. **There is no byte route to fall back to, and the one that exists is not a way around this.**
   ⚠ **Corrected 2026-09-08 (R7): this item used to say "the authorized content route will not
   serve it either", and it was wrong twice.** There is **no** `GET /api/files/:id/content` on the
   session-reachable router at all (`api/routes/file-upload.routes.ts` declares seven routes and
   none of them streams bytes), so a vendor, agency or agent client has nothing to try. The route
   it named is wi-admin's `GET /api/v1/files/:fileId/content`, which a dashboard cannot call — and
   that route **does** serve a blocked file, deliberately (see § 5). The two per-entity byte routes
   (the digital download and the delivery-proof photo) are not gated on the quota either, but they
   are scoped to the entity's own customer/agent/agency and a quota-blocked file is by definition
   ordinary media — digital assets are exempt from the cap. **Render the placeholder; there is no
   second attempt worth making.**

```ts
// Before
if (file.access === 'authorized') return <AuthorizedViewer id={file.id} />;
return <img src={file.url!} />;

// After — note the ORDER
if (file.access === 'quota_blocked') return <OverPlanPlaceholder />;
if (file.access === 'authorized') return <AuthorizedViewer id={file.id} />;
return <img src={file.url!} />;
```

⚠ **A client that does not update still behaves safely** — `url` is already typed `string | null`
and has been since ADR-A01 D-2, so an un-updated client shows whatever it already shows for a
private file. It will simply give the wrong *explanation*. Updating is about the message, not
about avoiding a crash.

### Product galleries are filtered for you

`resolveProductImages` — which backs the storefront grid, the product detail, the admin product
view and every order/shipment thumbnail — **omits blocked files from the arrays entirely**. So a
gallery is already correct with no client change: product B simply returns one image instead of
two. You only need the `access` branch where you render a *named* file slot (a store logo, an
avatar, a policy document, the media library).

---

## 2. `Product.suspension.reason` gained `plan_quota_exceeded`

```diff
  reason: "default_delivery_agency_removed" | "product_delivery_agency_removed"
        | "agency_connection_paused" | "agency_storage_suspended"
-       | "vendor_suspended" | "platform_oversight"
+       | "vendor_suspended" | "platform_oversight" | "plan_quota_exceeded"
```

A product with this reason is off the storefront exactly as any other suspended product is. What is
different is **who can lift it, and how**:

- the vendor **cannot** un-suspend it from the product screen — `suspended` is terminal for vendors,
  as it already is for every other reason;
- **no administrator or agency action lifts it either.** None of them buys the vendor a bigger plan;
- it is lifted **automatically**, oldest-first, when the vendor **upgrades their plan**, or when they
  **archive or delete an older product** to free a slot.

So the call to action on this one is *"upgrade, or archive something older"* — not *"contact
support"*.

⚠ **A suspended-for-quota product is the only suspension that can apply to a `draft`.** Drafts
occupy a catalog slot (the plan caps slots, not live listings), so the overflow may include products
that were never published. Do not assume `suspended` implies "was on sale".

---

## 3. Endpoints that can now refuse where they did not

These already returned `403 BILLING_LIMIT_EXCEEDED` on create. They now return the same code, at the
same status, on three more paths that previously let a vendor past their plan:

| Endpoint | When it now refuses |
|---|---|
| `POST /api/vendor/products/:id/duplicate` | the duplicate would exceed the plan (a duplicate is a new draft, and a draft takes a slot) |
| `PATCH /api/vendor/products/:id/status` | **un-archiving** (`archived → draft`) would exceed the plan |
| `POST /api/vendor/products/bulk/status` | the batch would exceed the plan — **all-or-nothing**, nothing is applied |

`details` carries the numbers, so the message can be specific:

```json
{
  "code": "BILLING_LIMIT_EXCEEDED",
  "statusCode": 403,
  "category": "authorization",
  "details": { "limit": 15, "current": 15, "requested": 4, "available": 0 }
}
```

`available` is what a bulk selection screen should show *before* the user presses the button.

⚠ **`draft → active` is NOT gated and never refuses on quota.** Both statuses occupy a slot, so
publishing a draft the vendor was already allowed to create takes nothing. If you see a quota
refusal there, it is a bug — report it rather than working around it.

---

## 4. Two file URLs that were always wrong are now `null`

Fixing the quota rule meant routing three sites through the shared resolver that had been
building URLs on their own. Two of them were **already** wrong before this change — they applied
no privacy rule at all — so they returned a URL that 404s whenever the file sat in a private
storage tree. Both now return `null` in that case, honestly:

| Field | Endpoint |
|---|---|
| `url` on a ticket attachment | `POST` and `GET /api/<role>/tickets/:ticketId/attachments` |
| `firstFileUrl` on a ticket product reference | `GET /api/<role>/tickets/reference/products` |

⚠ **Corrected 2026-09-08 (R7): there is no `/api/tickets/…` mount.** This table named one, and it
does not exist. Every ticket route is **role-prefixed** — `/api/vendor/tickets`,
`/api/agency/tickets`, `/api/agent/tickets`, `/api/customer/tickets` (`api/index.ts:349-352`), plus
wi-admin's own `/api/internal/admin/tickets`. Use your own role's prefix; the attachment and
product-reference routes are declared identically on all four
(`modules/tickets/routes/vendor-ticket.routes.ts:25,39-40`).

**In practice you will rarely see it**, because ticket attachments land in the public
`documents/`/`images/` trees today rather than in `ticket-attachments/`. But the field is now
typed and behaved as nullable, and a client should render the same placeholder it renders for any
other `url: null`. This is strictly an improvement — the previous value was a link that could
not load.

## 5. Reactivation is automatic — and one case where it waits

**Paying for a bigger plan releases everything on its own.** The gateway confirms → the plan is
applied → products un-suspend and files unblock, oldest-first, in the same pass. There is no button
to press, no support ticket, and no separate "restore my catalogue" call for a client to make. The
vendor's next page load already shows it.

Archiving or deleting an older item works the same way: the freed slot or bytes release the
next-oldest held item immediately, and a nightly sweep is the backstop if that ever misses.

⚠ **The one exception: buying a plan while a PAID term is still running.** The existing billing rule
queues it as `pending_activation` and starts it when the current term ends — so the entitlements,
and the release with them, wait too. This is pre-existing behaviour that applies to every plan
feature, not just the quota, and the release does happen normally once the queued plan is promoted.
It does **not** affect the ordinary case: a lapsed plan drops to the free tier, which never expires,
so a re-purchase applies instantly.

**What to show a vendor who is over cap:** *"Upgrade, or archive something older."* Not "contact
support" — support cannot lift this, because nothing an administrator does to a product buys a
bigger plan. What an administrator **can** do is assign a plan, which releases through exactly the
same path.

### For the admin dashboard

Administrative staff keep full visibility:

- quota-suspended products appear in the vendor's product list with no extra filter, carry
  `suspension.reason: "plan_quota_exceeded"`, and are counted in the status breakdown;
- blocked files appear in the media library as `access: "quota_blocked"` with `url: null`;
- **the bytes are still viewable** via wi-admin's `GET /api/v1/files/:fileId/content` (permission
  `files.content.read`, tier-3/support, **audited** — `admin/src/modules/files/routes/file.routes.ts:187`)
  — that route carries no quota check at all and streams any tree identically, so an administrator
  investigating "why did this vendor's image vanish" can look at it. It is an **administrator-only**
  door: no vendor, agency or agent session can reach it.

There is deliberately **no admin un-suspend** for this reason. The admin remedy is to assign a
bigger plan.

## What has NOT changed

- No endpoint changed its path, method, or response envelope.
- `url` was already `string | null`. No field changed type.
- Storefront visibility is unchanged in mechanism: a suspended product is excluded by the same
  single predicate that already excluded every other suspended product.
- Uploads were already refused when over the storage cap. That is unchanged.
- Nothing is deleted, ever. There is no data-loss path in this feature.
