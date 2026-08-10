# Agency Inventory

Which SKUs this agency warehouses, at which depot, what they should be costing in
storage rent, and the two things the agency can do about them. Backs the agency
dashboard's inventory screen.

> Related docs: [Magazin](./magazin.md) (the depots themselves) ·
> [Stock requests](./stock-requests.md) (changing a recorded quantity) ·
> [Vendor → Delivery Agencies](../vendor/delivery-agencies.md#list-an-agencys-pickup-locations)
> (how a vendor picks a depot) · [Earnings](./earnings.md) ·
> [Front-end changelog](../FRONTEND-CHANGELOG-agency-storage.md).

## Base Path
```
/api/agency/inventory
```

## Authentication
Bearer token (or cookie session) with the **agency** role. Identity flows
token → agency; there is no `agencyId` in any path, and every query is scoped to
the caller.

## Endpoints

| | |
|---|---|
| [`GET /`](#1-list-inventory) | the roster |
| [`GET /summary`](#2-summary) | whole-magazine totals for the screen header |
| [`GET /:id`](#3-inventory-detail) | one row |
| [`PATCH /products/:productId/depot`](#4-move-a-product-to-another-depot) | re-point a stored product |
| [`POST /products/:productId/suspend`](#5-suspend--unsuspend) | take it off the storefront |
| [`POST /products/:productId/unsuspend`](#5-suspend--unsuspend) | put it back |

---

> [!IMPORTANT]
> ## Two different quantities live on every row. Do not merge them.
>
> | Field | What it is | Real today? |
> |---|---|---|
> | `catalogStock.quantity` | the **agreed** quantity for this SKU — the vendor's catalogue number, which on a warehoused SKU neither party can now change alone | **yes** |
> | `quantityOnHand` / `quantityReserved` | the **counted** quantity — what somebody physically verified on a shelf | **no, always `0`** |
>
> `countsAreDerived: true` and per-row `source: "derived"` still describe the second
> pair only. Phase 1 has no intake flow, stock does not move on delivery, and nothing
> counts a shelf — so those two remain zero and the honest label for them is still
> "not counted".
>
> What *has* changed is that the first one is now meaningful to you: it is the number
> the two of you jointly govern (see [Stock requests](./stock-requests.md)), it is
> guaranteed finite, and it is what the storage fee is quoted against. Label the two
> distinctly on screen — something like **"Agreed"** vs **"Counted on hand"**.

---

## 1. List inventory

### GET /api/agency/inventory

**Query parameters** (all optional):

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer 1–100 | `20` | |
| `locationId` | depot id \| `"unassigned"` | — | Filter to one depot. See the note on `unassigned` below. |
| `vendorId` | ObjectId | — | Filter to one vendor's SKUs. |
| `search` | string, 1–100 | — | Case-insensitive, over variant **SKU** and product **title**. |
| `sortBy` | `createdAt` \| `quantityOnHand` \| `lastReconciledAt` | `createdAt` | |
| `sortDir` | `asc` \| `desc` | `desc` | |

Unknown query parameters are rejected (`400 VALIDATION_ERROR`).

**Success Response** — `200 OK`:

```json
{
  "success": true,
  "countsAreDerived": true,
  "data": [
    {
      "id": "665a1f77bcf86cd799439011",
      "sku": "NIKE-AIR-MAX-90-BLK-42",
      "productTitle": "Nike Air Max 90",
      "variantTitle": "Black / 42",
      "image": {
        "id": "6f1a2b3c4d5e6f7a8b9c0d1e",
        "key": "products/abc.jpg",
        "url": "https://cdn.example.com/products/abc.jpg",
        "mimeType": "image/jpeg",
        "size": 245678,
        "originalName": "airmax.jpg"
      },
      "vendor": { "id": "664b...21", "businessName": "SneakerHub SARL" },
      "location": {
        "id": "6641abc123def458",
        "label": "Bonabéri branch",
        "city": "Douala",
        "isPrimary": false
      },

      "quantityOnHand": 0,
      "quantityReserved": 0,
      "quantityAvailable": 0,
      "source": "derived",
      "lastReconciledAt": "2026-08-06T09:12:00.000Z",

      "catalogStock": {
        "quantity": 120,
        "isInfinite": false,
        "pendingRequest": null
      },
      "storageFee": {
        "basis": "per_sku_monthly",
        "storageBasedEnabled": true,
        "monthlyRatePerSku": 500,
        "quantity": 120,
        "monthlyEstimate": 60000,
        "size": {
          "lengthCm": 30, "widthCm": 20, "heightCm": 12,
          "volumeCm3": 7200, "weightG": 850,
          "source": "variant"
        }
      },
      "suspension": null,
      "productStatus": "active"
    }
  ],
  "meta": { "total": 137, "page": 1, "limit": 20, "totalPages": 7 }
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | The stock-level **row** id — pass to the detail endpoint. Not a variant id. |
| `sku` / `productTitle` / `variantTitle` | string \| null | From the variant and product. `null` if either was deleted after the row was derived. |
| `image` | FileDetail \| null | The thumbnail — `images[0]` from the detail view. |
| `vendor.businessName` | string \| null | From the vendor's Store, resolved live. |
| `location` | object \| null | The depot. **Null means unresolved** — see below. |
| `location.isPrimary` | boolean | `true` for the agency's first depot, which is where a product that names none is collected from. |
| `quantityOnHand` / `quantityReserved` | number | Always `0`. See the banner above. |
| `quantityAvailable` | number | `max(0, onHand − reserved)`. Never negative. |
| `source` | `"derived"` \| `"counted"` | Describes the two counters above only. |
| `lastReconciledAt` | ISO date | When the roster last confirmed this row against the catalog. |
| `catalogStock` | object | [§1a](#1a-catalogstock) |
| `storageFee` | object | [§1b](#1b-storagefee) |
| `suspension` | object \| null | [§1c](#1c-suspension) |
| `productStatus` | string \| null | The product's own status, so you need not infer it. |

> **One row is one SKU at one depot.** The same variant stored at two depots is
> two rows with two different `id`s.

### `location: null` — the unassigned bucket

A row resolves to `null` when the product names a depot **you have since
deleted**. The goods exist; the platform no longer knows which building. Find
them with `?locationId=unassigned` and re-point the product — you can now do that
yourself, with [`PATCH /products/:productId/depot`](#4-move-a-product-to-another-depot).

This is deliberately **not** silently folded into your primary depot. Delivery
*routing* does fall back to the primary in that situation — an agent still has to
be sent somewhere — but attributing one warehouse's goods to another on an
inventory screen would be a number nobody can go and verify.

A product that simply **names no depot** is a different case: it is genuinely
collected from your primary, so it is recorded there, with `isPrimary: true`.

---

### 1a. `catalogStock`

```json
"catalogStock": {
  "quantity": 120,
  "isInfinite": false,
  "pendingRequest": {
    "id": "665a1f77bcf86cd799439061",
    "requestedQuantity": 90,
    "requestedByRole": "vendor",
    "awaitingMyDecision": true,
    "requestedAt": "2026-08-06T09:12:00.000Z",
    "note": "Sold 30 through another channel"
  }
}
```

| Field | Notes |
|---|---|
| `quantity` | `ProductVariant.stock`. `null` if the variant was deleted. |
| `isInfinite` | Effectively always `false` for a live warehoused SKU — unlimited stock blocks activation for `agency_storage` products. It can be `true` only on a legacy or suspended row. |
| `pendingRequest` | The one open stock-adjustment request for this SKU, or `null`. At most one can be open. |

`pendingRequest.awaitingMyDecision` is `true` when the **vendor** raised it — i.e. it is
yours to answer. Use it to badge the row and link to
[the request](./stock-requests.md).

---

### 1b. `storageFee`

```json
"storageFee": {
  "basis": "per_sku_monthly",
  "storageBasedEnabled": true,
  "monthlyRatePerSku": 500,
  "quantity": 120,
  "monthlyEstimate": 60000,
  "size": { "lengthCm": 30, "widthCm": 20, "heightCm": 12, "volumeCm3": 7200, "weightG": 850, "source": "variant" }
}
```

> [!WARNING]
> **The platform does not track storage payment.** It does not invoice this, does not
> know whether it was paid, and never acts on it. This is *what you should be
> charging*, computed from your own policy so you do not have to. Collection is
> out-of-band, and the only platform lever attached to it is your own manual
> [suspension](#5-suspend--unsuspend).
>
> Do not label this "due", "overdue", "outstanding" or "invoice".

| Field | Notes |
|---|---|
| `basis` | `"per_sku_monthly"` — the only basis today. Named so a future volumetric basis is additive. |
| `storageBasedEnabled` | Your `policies.pricing.storage_based.enabled`. When `false`, `monthlyEstimate` is `0` and the screen should say "storage not offered" rather than showing a rate. |
| `monthlyRatePerSku` | Your `policies.pricing.storage_based.monthly_storage_fee_per_sku`. |
| `quantity` | The billable count — `catalogStock.quantity`, clamped at 0, and `0` for an unlimited-stock SKU (inventing a quantity for one would be a fabricated charge). |
| `monthlyEstimate` | `monthlyRatePerSku × quantity`. |
| `size` | Dimensions, and the volume derived from them. `null` when neither the variant nor the product carries any. |

**Size is displayed, not priced.** The rate is flat per SKU because that is the only
rate your policy holds — a pallet and an envelope cost the same. `size` is there so you
can sanity-check the rate against what you are actually shelving (and renegotiate it
out-of-band if it is wrong). **A client must not multiply by it.**

`size.source` is `"variant"` when the variant carries its own dimensions,
`"product_default"` when they came from the product's shipping config, `"unknown"` when
neither does. `volumeCm3` is `null` unless all three dimensions are known — render "—",
never `0`, because `0` reads as a claim that the item has no volume.

To change the rate, edit `policies.pricing.storage_based` on your
[profile](./profile.md). Note that changing your policies bumps `policy_version` and
moves active vendor connections to `paused_reapproval` — a fee change already requires
the vendor's re-consent.

---

### 1c. `suspension`

```json
"suspension": {
  "note": "Storage unpaid since June",
  "suspendedAt": "2026-08-06T10:00:00.000Z",
  "previousStatus": "active"
}
```

Non-null **only for a suspension you applied yourself**. `previousStatus` is what the
product returns to when you lift it.

A product suspended for some other reason (the vendor's delivery agency went inactive,
their connection needs re-approval) reports `suspension: null` with
`productStatus: "suspended"`. Show it as suspended but **hide your unsuspend button** —
that suspension is not yours to lift, and the endpoint will `422`.

---

## 2. Summary

### GET /api/agency/inventory/summary

The screen header. Takes the **same filters as the list** (`locationId`, `vendorId`,
`search`) and totals the whole filtered set — not the visible page.

```json
{
  "success": true,
  "countsAreDerived": true,
  "data": {
    "skuCount": 137,
    "unassignedCount": 1,
    "suspendedCount": 3,
    "totalMonthlyEstimate": 4120000
  }
}
```

| Field | Notes |
|---|---|
| `skuCount` | Rows matching the filter. |
| `unassignedCount` | Rows whose depot you have deleted (`location: null`). Your re-homing to-do list. |
| `suspendedCount` | Distinct **products** you have suspended — a product with three variants is one suspension, not three. |
| `totalMonthlyEstimate` | Σ of every row's `storageFee.monthlyEstimate`. `0` when `storage_based.enabled` is false. |

A separate endpoint rather than a field on the list, deliberately: the totals span the
entire filtered set, so folding them in would make every page load pay for a
full-collection aggregation it usually does not need.

---

## 3. Inventory detail

### GET /api/agency/inventory/:id

`:id` is the **stock-level row id** from the list — not a variant id, because the
same variant at two depots is two rows and this drills into one shelf.

**Success Response** — `200 OK`: everything from the list row, plus:

| Field | Type | Notes |
|---|---|---|
| `productId` / `variantId` | string | The underlying catalog ids. **`productId` is what the three write endpoints below take.** |
| `locationAddress` | AddressDetail \| null | The depot's full address — `label`, `formattedAddress`, `addressLine1/2`, `city`, `state`, `country`, `coordinates: { lat, lng }`. Resolved **live** from your magazin, so a corrected address shows here immediately. `null` when `location` is null. |
| `images` | FileDetail[] | Every image, thumbnail first. The list's `image` is `images[0]`. |

### Error Responses

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Bad query param, or `:id` is not an ObjectId |
| `UNAUTHORIZED` | 401 | Missing or invalid token |
| `FORBIDDEN` | 403 | Wrong role |
| `INVENTORY_STOCK_LEVEL_NOT_FOUND` | 404 | No such row **for this agency** — another agency's row 404s rather than 403s |

---

## 4. Move a product to another depot

### PATCH /api/agency/inventory/products/:productId/depot

```json
{ "locationId": "6641abc123def458" }
```

| Field | Type | Notes |
|---|---|---|
| `locationId` | ObjectId \| `null` | One of **your own** depots, from `GET /api/agency/magazin` → `headquarters_addresses[].id`. `null` means "track my primary depot". |

**`null` is a real answer, not a missing one.** It means the product follows
`headquarters_addresses[0]`, and keeps following it if you later reorder your depots.
Every product written before the depot picker existed is in that state.

**Success Response** — `200 OK`:

```json
{
  "success": true,
  "data": {
    "productId": "664c1f77bcf86cd799439031",
    "locationId": "6641abc123def458",
    "locationLabel": "Bonabéri branch",
    "affectedRows": 3
  },
  "message": "Pickup depot updated. The vendor has been notified."
}
```

`affectedRows` is how many of your stock rows moved — one per active variant, because
the depot is named once on the product.

**Keyed on `productId`, not the row id.** The depot lives on
`product.delivery.pickup_location`, so the move is per product by construction. A
row-keyed endpoint would invite the reading that one variant could sit in a different
building from its siblings, which the model cannot express.

**Applies immediately. No vendor confirmation.** That asymmetry with the stock flow is
deliberate: which of *your* buildings holds the goods is your record to state, which is
exactly why checkout snapshots only the depot **choice** for `agency_storage` and
resolves the address live on every read. The vendor gets a `storage.depot_changed`
notification.

> [!WARNING]
> Because that address resolves live, re-pointing a product **redirects collection for
> shipments already in flight** — an agent yet to collect will be routed to the new
> building. That is the intended behaviour (it is what makes a corrected typo fix every
> in-flight shipment), but say so in your UI before confirming.

**Errors**

| Code | HTTP | Meaning |
|---|---|---|
| `INVENTORY_PRODUCT_NOT_STORED_HERE` | 404 | You do not warehouse this product |
| `INVENTORY_LOCATION_UNKNOWN` | 422 | `locationId` is not one of your depots. `details.locationId` |

---

## 5. Suspend / unsuspend

```
POST /api/agency/inventory/products/:productId/suspend      { "note": "Storage unpaid since June" }
POST /api/agency/inventory/products/:productId/unsuspend
```

Your one lever over a product you warehouse. Suspending takes it **off the storefront** —
customers can no longer buy it — and only you can lift it.

**Nothing here is automatic.** The platform does not track storage payment (see
[§1b](#1b-storagefee)) and never suspends on your behalf. If rent goes unpaid, that is
settled between you and the vendor; this is the button.

### Suspend

| Field | Type | Notes |
|---|---|---|
| `note` | string ≤ 500, optional | Shown to the vendor as the reason. Strongly recommended — it is the only explanation they get. |

**Success** — `200 OK`, `data: { productId, status: "suspended", note }`.

Only an **`active`** product can be suspended. A draft or archived one is not on sale,
so suspending it would achieve nothing but block editing — the same rule the
delivery-agency cascade follows. Hide the button unless `productStatus === "active"`.

The product's rows **stay on this screen** with `suspension` populated. The goods are
still in your building, so the row still counts toward
[depot-deletion protection](#6-how-rows-appear-and-disappear) and toward your storage
fee.

### Unsuspend

**Success** — `200 OK`, `data: { productId, status: "active", note: null }` (`status` is
whatever `suspension.previousStatus` held).

Unsuspending **re-runs the product's activation gate** rather than trusting it. A
product can go stale while it is off sale: the vendor's connection may have lapsed, a
variant may have been archived, a variant may have been flipped to unlimited stock. If
anything blocks it you get:

```json
{
  "success": false,
  "error": {
    "code": "INVENTORY_PRODUCT_UNSUSPEND_BLOCKED",
    "statusCode": 422,
    "message": "This product cannot go back on sale yet — the vendor has to resolve the issues below first.",
    "details": {
      "blockers": [
        { "code": "CATALOG_PRODUCT_NO_DELIVERY_AGENCY", "message": "Your connection with this delivery agency needs to be approved (or reapproved) before this product can be activated." }
      ]
    }
  }
}
```

**Render `details.blockers`.** Each `message` is written to be shown, and it is what
tells you what to go back to the vendor about. The product stays suspended.

### Errors

| Code | HTTP | Meaning |
|---|---|---|
| `INVENTORY_PRODUCT_NOT_STORED_HERE` | 404 | You do not warehouse this product |
| `INVENTORY_PRODUCT_NOT_SUSPENDABLE` | 422 | Suspend: the product is not `active` |
| `INVENTORY_PRODUCT_NOT_AGENCY_SUSPENDED` | 422 | Unsuspend: not suspended, or suspended by someone else / for another reason. `details: { status, reason }` |
| `INVENTORY_PRODUCT_UNSUSPEND_BLOCKED` | 422 | Unsuspend: the activation gate still fails. `details.blockers` |

### How it coexists with the system's own suspensions

The platform also suspends products automatically when a vendor's delivery agency goes
inactive or their connection needs re-approval. The two never interfere:

- **The system cannot clear yours.** Its restore sweep is scoped to its own reasons.
- **You cannot clear the system's.** `INVENTORY_PRODUCT_NOT_AGENCY_SUSPENDED`.
- If the vendor's agency breaks *while* you have the product suspended, your later
  unsuspend re-runs the gate and correctly refuses with the blocker list above.

---

## 6. How rows appear and disappear

You do not create rows. The roster is **derived** from the catalog and refreshed
when you read this endpoint (debounced, so rapid paging costs nothing). A depot change
via [§4](#4-move-a-product-to-another-depot) forces a refresh immediately.

A row appears when a vendor's product is:
- physical, **and**
- `active` — **or** `suspended` **by you** (§5), so your own suspension never deletes
  the row its unsuspend button lives on, **and**
- `delivery.pickupLocation.source === "agency_storage"`, **and**
- fulfilled by **you** — either the product's own `delivery.agencyId` names you,
  or the vendor's default delivery agency is you.

One row is created per active **variant** of that product, because stock lives on
the variant.

A row disappears (soft-deleted, so history survives) when any of those stops
holding — the product is archived or deactivated, suspended for a *system* reason, the
vendor switches it back to `vendor_address` pickup, or re-points it at a different
agency. Moving a product to a **different depot** simply retires the old row and creates
a new one.

> **Deleting a depot that holds stock is refused.** `PATCH /api/agency/magazin`
> returns `409 MAGAZIN_LOCATION_IN_USE`, listing the offending locations and how
> many SKUs each holds. Re-point those products first — you can do that yourself
> now — or ask the vendor to. See [Magazin](./magazin.md).

---

## 7. Not yet available

Deliberately absent, in the order they are planned:

1. **True counted quantities** — reservation at checkout, settlement on delivery,
   restoration on return/failure. This is what flips `source` to `"counted"` and makes
   `quantityOnHand` real. Note this is now the *only* missing quantity: the agreed
   quantity (`catalogStock`) is live, and it is the one the fee is quoted against.
2. **Intake and transfer** — recording what physically arrived, and moving stock
   between your depots. (You can move a product's *routing* today; you cannot yet
   record a physical transfer.)
3. **Storage billing** — the platform still does not invoice or track
   `monthly_storage_fee_per_sku`. `storageFee` above tells you what to charge; charging
   it and chasing it remain yours.
