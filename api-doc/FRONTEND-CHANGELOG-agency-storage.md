# Front-end changelog — agency storage management

**Audience:** whoever builds the **agency dashboard** and the **vendor dashboard**.
**Status:** backend shipped. Nothing here is behind a flag.

Four changes to how a product warehoused by a delivery agency behaves. Read §0, then
your role's section. Everything is additive except the two behaviour changes flagged
**⚠️ BREAKING FOR CLIENTS** — those will make an existing screen lie if you ignore them.

> Reference docs: [Agency → Inventory](./agency/inventory.md) ·
> [Agency → Stock requests](./agency/stock-requests.md) ·
> [Vendor → Stock requests](./vendor/stock-requests.md) ·
> [Agency → Magazin](./agency/magazin.md) · [Errors](./errors/README.md)

---

## 0. What changed, in one paragraph each

1. **The agency can move a stored product between its own depots.** One new endpoint.
   Applies immediately; the vendor is notified. *(agency dashboard: new action)*

2. **⚠️ Stock on an agency-warehoused SKU now needs both signatures.** Neither the
   vendor nor the agency can write `variant.stock` alone. One side proposes, the other
   approves. **The three existing vendor stock-write endpoints no longer write stock
   for such products** — they return `200` with a new `meta.stockAdjustment` block
   instead. *(both dashboards: new inbox + a response you must read)*

3. **⚠️ A product stored in an agency warehouse cannot have unlimited stock.** New
   activation blocker, and a hard `422` on the two write paths that could otherwise
   reach that state. *(vendor dashboard: new blocker code + a refusable save)*

4. **The agency can see the storage rent due, and suspend a product by hand.** The
   platform does **not** track storage payment — it only displays what is owed. Two
   new endpoints and three new response fields. *(agency dashboard: new column,
   header, and two actions)*

---

## 1. Agency dashboard

### 1a. The inventory screen gains three response blocks

`GET /api/agency/inventory` and `GET /api/agency/inventory/:id` rows are unchanged in
every existing field, plus:

```json
{
  "catalogStock": {
    "quantity": 120,
    "isInfinite": false,
    "pendingRequest": {
      "id": "665a…",
      "requestedQuantity": 90,
      "requestedByRole": "vendor",
      "awaitingMyDecision": true,
      "requestedAt": "2026-08-06T09:12:00.000Z",
      "note": "Counted this morning"
    }
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
  "suspension": { "note": "Storage unpaid since June", "suspendedAt": "…", "previousStatus": "active" },
  "productStatus": "suspended"
}
```

**`catalogStock` is NOT `quantityOnHand`.** Do not merge them into one column.
`quantityOnHand` is still `0` on every row (Phase 1, unchanged, still flagged by
`countsAreDerived`). `catalogStock.quantity` is the vendor's catalogue number for that
SKU — which is now a *jointly agreed* figure, since neither side moves it alone.
Label them distinctly: something like **"Agreed quantity"** vs **"Counted on hand"**.

**`storageFee` is a display figure only.** Three rules for the UI:
- The rate is **flat, per SKU, per month**. `monthlyEstimate = monthlyRatePerSku ×
  quantity`. **Do not multiply by size.**
- `size` is shown so the agency can sanity-check the rate against what it is actually
  shelving. `source` tells you where it came from (`variant` / `product_default` /
  `unknown`); `volumeCm3` is `null` when any dimension is missing — render "—", never `0`.
- `storageBasedEnabled: false` means the agency does not offer warehousing at all.
  `monthlyEstimate` is then `0`; say "not offered" rather than showing a rate.
- **The platform does not track payment.** Never render this as "due", "overdue",
  "invoice" or "paid". It is "what you should be charging".

**`suspension` is non-null only for a suspension THIS agency applied.** A product
suspended by a delivery-agency cascade reports `suspension: null` with
`productStatus: "suspended"` — show it as suspended but **hide the unsuspend button**,
because the endpoint will `422`.

### 1b. New: the screen header

```
GET /api/agency/inventory/summary
```
Takes the **same query parameters as the list** (`locationId`, `vendorId`, `search`)
and totals the whole filtered set, not the visible page.

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

`suspendedCount` counts **products**, not rows — a product with three variants is one
suspension.

### 1c. New: three product-level actions

All three are keyed on the **`productId`**, not the row `id`. The list row already
carries `productId`. They act on every row of that product at once, because a depot is
named once on the product and suspension is a product status.

```
PATCH /api/agency/inventory/products/:productId/depot        { "locationId": "6641…" | null }
POST  /api/agency/inventory/products/:productId/suspend      { "note": "Storage unpaid since June" }
POST  /api/agency/inventory/products/:productId/unsuspend
```

- **depot** — `locationId` must be one of your own depots (from
  `GET /api/agency/magazin` → `headquarters_addresses[].id`), or `null` meaning
  "track my primary depot". Applies immediately; the vendor is notified. The row's
  `location` changes on the next list read. Warn the user in the UI that this
  **redirects collection for shipments already in flight** — the depot address
  resolves live on every read, which is by design.
- **suspend** — the product leaves the storefront. Only an `active` product can be
  suspended (`422 INVENTORY_PRODUCT_NOT_SUSPENDABLE` otherwise), so hide the button
  unless `productStatus === "active"`. `note` is optional but shown to the vendor —
  prompt for it.
- **unsuspend** — re-runs the product's activation gate. If the product cannot go back
  on sale, you get **`422 INVENTORY_PRODUCT_UNSUSPEND_BLOCKED`** with
  `error.details.blockers: [{ code, message, details }]`. **Render that list** — the
  `message` on each blocker is written to be shown, and it is what tells the agency to
  go back to the vendor.

### 1d. New: the stock-request inbox

```
POST /api/agency/stock-requests                    { productId, variantId, quantity, note? }
GET  /api/agency/stock-requests                    ?status=&productId=&variantId=&direction=&page=&limit=
GET  /api/agency/stock-requests/:id
POST /api/agency/stock-requests/:id/approve
POST /api/agency/stock-requests/:id/reject         { reason? }
POST /api/agency/stock-requests/:id/withdraw
```

**Render buttons from `availableActions`, never from your own logic.** The server sends
the authority table's verdict on every row:

| field | meaning |
|---|---|
| `availableActions` | `['withdraw']` if you raised it · `['approve','reject']` if the vendor did · `[]` once resolved |
| `awaitingMyDecision` | `true` when it is your turn — drive the badge count off this |
| `quantityBefore` | what the **proposer** saw when they raised it |
| `currentQuantity` | what the SKU reads **now** — show both when they differ |
| `requestedQuantity` | the **absolute** target, never a delta |

`?direction=awaiting_me` pages straight to your action list. `?direction=raised_by_me`
gives you yours. **No filter returns every status**, terminal rows included — that is
deliberate, so a SKU's negotiation history is fetchable.

### 1e. New notification preference

`GET|PATCH /api/agency/notification-preferences` → `preferences.stockRequestUpdates`
(boolean, default `true`). Separate from `preferences.storageAlert`, which is the
**media-file quota** and shares only the word "storage". Label them so they are not
confused.

New notification `type` values to key i18n off:
`storage.stock_request.received`, `storage.stock_request.approved`,
`storage.stock_request.rejected`. New `aggregateType`: `stock_request`.

---

## 2. Vendor dashboard

### 2a. ⚠️ BREAKING FOR CLIENTS — three endpoints stopped writing stock

For a product whose pickup is `agency_storage`, these **no longer change the
quantity**:

| endpoint | what it now does |
|---|---|
| `PATCH /api/vendor/products/:productId/variants/:variantId` | applies every other field; queues `stock`/`isInfiniteStock` |
| `PATCH /api/vendor/products/:id/simple` | same |
| `PATCH /api/vendor/inventory/bulk-update` | applies non-stored rows; queues the stored ones |

**Still `200`, not `202`.** One status code, deliberately — you have to read the body
either way. The signal is a new `meta.stockAdjustment`:

```json
{
  "success": true,
  "data": { "…": "…", "stock": 120 },
  "meta": {
    "stockAdjustment": {
      "status": "pending_agency_approval",
      "request": { "id": "665a…", "requestedQuantity": 90, "availableActions": ["withdraw"], "…": "…" }
    }
  },
  "message": "Variant updated. The stock change is awaiting the storage agency's approval."
}
```

**`data.stock` is the OLD quantity.** If your UI optimistically shows what was typed,
it will now be wrong. Two things to change:
1. Render `data` as returned, not as submitted.
2. When `meta.stockAdjustment` is present, show a "pending approval: 120 → 90" badge on
   that SKU rather than a success toast.

The simple-product endpoint keeps `meta.activation` exactly as before —
`meta.stockAdjustment` sits beside it.

**Bulk update** gains two sibling arrays to `variants`:

```json
{
  "success": true, "batchId": "…", "updated": 12,
  "variants":    [{ "variantId": "…", "sku": "…", "previousStock": 5, "newStock": 8 }],
  "requested":   [{ "variantId": "…", "sku": "…", "requestId": "…", "requestedQuantity": 90 }],
  "notRequested":[{ "variantId": "…", "sku": "…", "error": "STOCK_REQUEST_ALREADY_PENDING", "message": "…" }]
}
```

`updated` counts only `variants`. Report the three groups separately — `notRequested`
is almost always "a request is already open on that SKU", which the user has to go and
resolve.

**What still writes stock directly** (unchanged): creating a variant, creating a simple
product, and duplicating a product. An initial quantity is a declaration, not an
adjustment.

### 2b. New: the stock-request inbox (mirror of the agency's)

```
POST /api/vendor/stock-requests                    { productId, variantId, quantity, note? }
GET  /api/vendor/stock-requests                    ?status=&productId=&variantId=&direction=&page=&limit=
GET  /api/vendor/stock-requests/:id
POST /api/vendor/stock-requests/:id/approve
POST /api/vendor/stock-requests/:id/reject         { reason? }
POST /api/vendor/stock-requests/:id/withdraw
```

Endpoint-for-endpoint identical to the agency's, same DTO, same
`availableActions` / `awaitingMyDecision` contract — see §1d. You can build one
component and mount it on both dashboards.

The vendor raises a request here **or** simply PATCHes the variant as before and lets
the gate create it (§2a). Both land in the same inbox.

### 2c. ⚠️ BREAKING FOR CLIENTS — unlimited stock is refused for agency storage

New error code **`CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK`** (422). It appears in
three places:

1. **As an activation blocker.** In `meta.activation.blockers[]` on the simple-product
   endpoints; thrown as the `422` on `PATCH /api/vendor/products/:id/status`. Message:
   *"A product stored in an agency warehouse must have a countable stock quantity. Turn
   off unlimited stock on every active variant."* `details.variant` names the offender.
2. **On `PATCH /api/vendor/products/:id`** when the body moves pickup to
   `agency_storage` while a variant is unlimited. The save is **refused** — it does not
   silently unpublish the product. `details.variants` lists every offender.
3. **On a stock request** asking to go unlimited on a stored SKU — refused at creation.

UI consequence: in the pickup-location picker, disable or warn on "agency storage"
while any active variant has unlimited stock, and offer the fix (turn it off, enter a
quantity) inline.

Products that were **already** live in this state stay live until something
revalidates them. Ops can list them with `npm run audit:infinite-agency-stock`.

### 2d. New: notifications about your goods in someone else's warehouse

New `type` values: `storage.stock_request.received`, `storage.stock_request.approved`,
`storage.stock_request.rejected`, `storage.depot_changed`,
`storage.product_suspended`, `storage.product_unsuspended`.
New `aggregateType` values: `stock_request`, `product`.

One new preference: `preferences.agencyStorageUpdates` (default `true`) on
`GET|PATCH /api/vendor/notification-preferences`. Covers all six. Distinct from
`preferences.storageAlert` (media quota).

`storage.product_suspended` is the important one to surface prominently: the product
has left the storefront and the only explanation is the agency's note.

---

## 3. Error codes added

| Code | HTTP | Where you will meet it |
|---|---|---|
| `INVENTORY_LOCATION_UNKNOWN` | 422 | depot change, id is not one of the agency's |
| `INVENTORY_PRODUCT_NOT_STORED_HERE` | 404 | any agency product action on a product it does not warehouse |
| `INVENTORY_PRODUCT_NOT_SUSPENDABLE` | 422 | suspend, product is not `active` |
| `INVENTORY_PRODUCT_NOT_AGENCY_SUSPENDED` | 422 | unsuspend, not yours to lift |
| `INVENTORY_PRODUCT_UNSUSPEND_BLOCKED` | 422 | unsuspend, gate still fails — read `details.blockers` |
| `STOCK_REQUEST_NOT_FOUND` | 404 | not yours (another party's request 404s, never 403s) |
| `STOCK_REQUEST_ALREADY_PENDING` | 409 | one open request per SKU — `details.requestId` + `details.hint` |
| `STOCK_REQUEST_NOT_PENDING` | 409 | somebody resolved it first. **Reload, do not retry** |
| `STOCK_REQUEST_NOT_YOURS` | 403 | wrong verb for your side — `details.availableActions` |
| `STOCK_REQUEST_STALE` | 409 | product stopped being warehoused by that agency |
| `STOCK_REQUEST_NO_CHANGE` | 422 | the target equals the current quantity |
| `CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK` | 422 | see §2c |

---

## 4. Checklist

**Agency dashboard**
- [ ] Inventory list/detail: new "Agreed quantity" column, kept separate from "On hand"
- [ ] Inventory list/detail: storage-fee column + size tooltip; never multiply by size
- [ ] Inventory header: wire `GET /api/agency/inventory/summary`
- [ ] Row actions: change depot (picker from your magazin), suspend (+ note), unsuspend
- [ ] Hide unsuspend when `suspension === null` but `productStatus === "suspended"`
- [ ] Render `details.blockers` on `INVENTORY_PRODUCT_UNSUSPEND_BLOCKED`
- [ ] Stock-request inbox driven by `availableActions` / `awaitingMyDecision`
- [ ] Pending-request badge on inventory rows from `catalogStock.pendingRequest`
- [ ] New preference toggle `stockRequestUpdates`; i18n for 3 new notification types

**Vendor dashboard**
- [ ] Stop assuming a stock PATCH took effect — read `data` and `meta.stockAdjustment`
- [ ] Pending-approval badge per SKU when a request is open
- [ ] Bulk-update result: report `variants` / `requested` / `notRequested` separately
- [ ] Stock-request inbox (same component as the agency's)
- [ ] Pickup picker: block/warn on `agency_storage` + unlimited stock
- [ ] Handle `CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK` in the blocker list
- [ ] New preference toggle `agencyStorageUpdates`; i18n for 6 new notification types
