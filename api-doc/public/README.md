# Public API

**No authentication.** These endpoints are readable by a logged-out visitor, and they exist for the
marketing site: it prints real prices and real articles, so it needs to *read* them rather than keep
a hand-copy.

Two groups, documented separately:

| | Contract |
|---|---|
| The published **price list** | this file |
| The **catalog** (`/products`, `/categories`, `/stores`) | [catalog.md](./catalog.md) |
| The **blog** (`/articles`) | [articles.md](./articles.md) |

Everything else in this API is behind `requireAuth`. `/api/public` is the only exception, so the rule
for anything added here is narrow: **read-only, no identity, and already published on a public page.**
An endpoint that needs to know who is asking belongs on a role router instead.

## Base path

```
/api/public
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public/plans` | Pricing-plan catalog for every role |
| GET | `/api/public/credit-packs` | Credit top-up packs + per-action credit costs |

The blog's three endpoints and the catalog's seven share this prefix and these rules — see
[articles.md](./articles.md) and [catalog.md](./catalog.md).

> **This prefix now has its own rate-limit bucket.** `RATE_LIMIT_PUBLIC_PER_MIN` (default
> 3000/min per IP) applies **in addition to** the global 1200/min backstop, so the effective
> ceiling is the lower of the two. It exists because the catalog put real traffic on this
> prefix: a product grid fires two calls per page view, and without separate counters an
> anonymous crawler behind an office NAT would 429 the signed-in shoppers beside it.

Both use the standard [response envelope](../README.md#the-response-envelope-read-this-first) and
send `Cache-Control: public, max-age=300`.

> **Why the 5-minute cache.** Plans are admin-editable, so this is the window in which a price change
> is invisible to the marketing site. It is the trade for not putting an unauthenticated endpoint
> straight onto Mongo. If you need a price change live *now*, bust it on your side — don't lower it
> here.

---

## GET /api/public/plans

The plan catalog. **Active tiers only by default** — the ones that can actually be bought today.

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `role` | `vendor` \| `agency` \| `agent` | all three | Narrows to one role. An unknown value is `400 VALIDATION_ERROR`. |
| `includeInactive` | `"true"` | off | Also return tiers that are defined but not purchasable. Only the literal string `true` enables it. |

### Ordering

A **flat array**, grouped by role in the order `vendor → agency → agent`, and within a role by
`sort_order` then `price`. Group by the `role` field in one pass; don't rely on the array being
pre-split.

### Success — `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": "6a35924c05a45b3a11b07ddb",
      "role": "vendor",
      "code": "starter",
      "name": "Starter",
      "price": 0,
      "currency": "XAF",
      "term_days": null,
      "credit_allowance": 50,
      "max_active_products": 15,
      "max_storage_bytes": 1073741824,
      "commission_percent": 7,
      "max_unterminated_shipments": null,
      "live_tracking_enabled": true,
      "is_active": true,
      "sort_order": 1
    }
  ]
}
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | ObjectId. For deep-linking a CTA at one tier; nothing public needs it otherwise. |
| `role` | `vendor` \| `agency` \| `agent` | Who the tier is for. |
| `code` | string | Stable identifier (`starter`, `growth`, `agency_free`…). **Key your copy off this, not `name`.** |
| `name` | string | Display name as the admin set it. Not localized. |
| `price` | number | Per term, in `currency`. `0` on a free tier. |
| `currency` | string | ISO-4217. `XAF` on every seeded tier. |
| `term_days` | number \| null | Term length. **`null` = never expires** (the free tier), not "unknown". |
| `credit_allowance` | number | Credits granted **once** on activation. |
| `max_active_products` | number \| null | Vendor only. `null` = unlimited *on a vendor plan*, not-applicable elsewhere. |
| `max_storage_bytes` | number \| null | Media cap, all roles. Bytes. |
| `commission_percent` | number \| null | Vendor only. % of order gross taken at payment. |
| `max_unterminated_shipments` | number \| null | Agency (**soft** cap) and agent (**hard** cap). `null` = unlimited. |
| `live_tracking_enabled` | boolean | `true` on every tier today. Read it, don't build copy on it. |
| `is_active` | boolean | Whether the tier is buyable today — see below. |
| `sort_order` | number | Display order within the role. |

> **A `null` limit means two different things** depending on whether the role uses that field at all.
> `commission_percent: null` on an *agency* plan means "agencies don't have a commission", while
> `max_active_products: null` on a *vendor* plan means "unlimited products". Branch on `role` before
> rendering a limit, or you will print "unlimited commission".

### `is_active` and the "coming soon" tiers

`is_active: false` covers **two situations the model cannot distinguish**: a tier seeded ahead of
launch, and a tier withdrawn from sale. That ambiguity is why they are opt-in rather than returned by
default — the API will not guess which story to tell.

Today every inactive tier is the first kind (agency and agent paid tiers, defined but not yet
purchasable — see [billing-plans-across-roles.md](../billing-plans-across-roles.md)), so
`includeInactive=true` is a safe source for a "coming soon" column *right now*. If a tier is ever
retired, that stops being true silently. Either re-check before launch copy leans on it, or keep
labelling inactive tiers neutrally ("not available") rather than "coming soon".

### Difference from the authenticated catalog

`GET /api/{role}/plans` returns the raw document. This returns a projection: `_id` becomes **`id`**,
and `deletedAt`, `__v`, `created_at` and `updated_at` are dropped. Soft-deleted plans are never
returned by either. Adding a field to the plan model does **not** publish it here — publication is a
deliberate edit to `dto/public-plan.dto.ts`.

---

## GET /api/public/credit-packs

The buyable top-up packs **and** what a metered action costs. Both are published on the pricing page
and both live in `credit.config.ts`, so both are served here — the per-action costs are
env-overridable, which is exactly why they must be read rather than copied.

### Success — `200 OK`

```json
{
  "success": true,
  "data": {
    "packs": [
      { "code": "pack_100",  "credits": 100,  "price": 600,   "currency": "XAF" },
      { "code": "pack_320",  "credits": 320,  "price": 1800,  "currency": "XAF" },
      { "code": "pack_1100", "credits": 1100, "price": 6000,  "currency": "XAF" },
      { "code": "pack_2250", "credits": 2250, "price": 12000, "currency": "XAF" }
    ],
    "actionCosts": {
      "vectorisation": 1,
      "whatsappTemplate": 1
    }
  }
}
```

Note `data` is an **object**, not an array — unlike the authenticated
`GET /api/{role}/credits/packs`, which returns the bare pack array.

| Field | Notes |
|---|---|
| `packs[].code` | Stable identifier the dashboard sends when buying. Key your copy off it. |
| `packs[].credits` | Credits granted. Larger packs give a better FCFA/credit rate by design. |
| `actionCosts.vectorisation` | Credits to vectorise one product. `0` means the action is free. |
| `actionCosts.whatsappTemplate` | Credits per billable WhatsApp template sent to a customer. |

---

## Errors

Standard envelope. The only failure these endpoints produce on their own is a bad `role`:

| `error.code` | Status | Cause |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `role` was not `vendor`/`agency`/`agent`. `details.fields[]` names it. |

There is no `401`/`403` path — the routes carry no guard.

---

## Not built (deliberately)

`GET /api/public/authors` was sketched in
[BACKEND-BLOG-REQUIREMENTS.md](../BACKEND-BLOG-REQUIREMENTS.md) §5d and is **not** implemented —
authors are resolved inline on every article, so while there are two house bylines a separate
round-trip buys nothing. See [articles.md](./articles.md).

`GET /api/public/coverage` and `GET /api/public/stats` were sketched in
[BACKEND-REQUIREMENTS.md](../BACKEND-REQUIREMENTS.md) §3 and are **not** implemented. Both carry an
open product decision (how an uncovered region reads; whether a small count helps or hurts), and
neither is a correctness risk the way a stale price is. They are additions to this router when those
decisions are made.
