# Vendor dashboard: only active agencies are offered, and "why can't I publish" is answered

**2026-10-18 · not deployed yet · additive** (one list gets shorter; every field is new).

## Why

A vendor could find, request and connect to an agency that had not finished activating its
account (`pending_verification`: phone not yet verified, or no display name). Publishing a
physical product needs an **active** agency, so the product was then refused with a sentence
that did not say why. The first such connection also became the vendor's default agency
automatically, which blocked every physical product and stayed that way.

## 1. Agency lists show `active` agencies only

`GET /api/vendor/agency-connections/browse` and `GET /api/vendor/delivery-agencies` no longer
return `pending_verification` agencies. This does not depend on the vendor's own status: a vendor
still onboarding sees the same list.

Nothing to change in the client. Existing connections still appear in
`GET /api/vendor/agency-connections`, whatever the agency's status.

## 2. New field on every connection: `counterpartyStatus`

Every `ConnectionDto` (list, detail, and the responses of request / approve / reject / withdraw /
terminate) now carries:

```ts
counterpartyStatus: 'active' | 'pending_verification' | 'inactive' | null; // the AGENCY's status
```

An agency can still send a request before it has activated, and the vendor can still approve it.
Approval does not look at this field. Use it to warn the vendor:

| `counterpartyStatus` | Show |
|---|---|
| `active` | nothing |
| `pending_verification` | badge "Not active yet". Beside **Approve**: "You can approve, but this agency can't deliver your products until it finishes activating its account." |
| `inactive` | badge "Inactive" |
| `null` | the agency record no longer exists |

## 3. The automatic default only picks an active agency

When a vendor's first connection is approved, the agency becomes their default **only if it is
`active`**. If it is not, the default stays empty and the next approval with an active agency
fills it. When a pending agency activates later, it is **not** made the default automatically.
The vendor sets it with `PUT /api/vendor/profile/default-delivery-agency`, and the publish
checklist below tells them so.

## 4. The publish checklist says which agency problem it is

`CATALOG_PRODUCT_NO_DELIVERY_AGENCY` stays the same code. On the **publish checklist** (every
activation blocker: `meta.activation.blockers[]` on the simple-product endpoints, and the 422
from `PATCH /api/vendor/products/:id/status` → `active`) it now carries `details`:

```ts
details: {
  reason: 'no_default_agency' | 'agency_pending_activation' | 'agency_inactive'
        | 'agency_not_found' | 'connection_not_active';
  scope: 'default' | 'product';   // the vendor's default agency, or this product's own agency
  agencyId?: string;              // absent for no_default_agency
  agencyName?: string | null;     // for the three agency_* reasons
}
```

The `message` names the agency and the cause, so it can be shown as it is. To add a button,
branch on `reason`:

| `reason` | Button |
|---|---|
| `no_default_agency` | "Choose a default agency" |
| `agency_pending_activation` | none needed ("waiting for the agency"), or "Choose another agency" |
| `agency_inactive` / `agency_not_found` | "Choose another agency" (`scope: 'product'` means the product's own agency setting) |
| `connection_not_active` | "Open the connection" |

Full table: [simple-products.md](./simple-products.md) (the blockers section).

⚠ **One path is unchanged and carries no `details`:** `PATCH /api/vendor/products/:id` setting
`delivery.pickupLocation` while no agency resolves still answers
`422 CATALOG_PRODUCT_NO_DELIVERY_AGENCY` with only a message ([products.md](./products.md),
Update Product errors). Treat a missing `details.reason` as "set a delivery agency first".
