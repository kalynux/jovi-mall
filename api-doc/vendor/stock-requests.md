# Vendor Stock Requests

Changing the recorded stock of a product a delivery agency warehouses for you. Every
change needs both signatures — yours and the agency's.

> Related docs: [Agency → Stock requests](../agency/stock-requests.md) (the mirror,
> and the fuller explanation of the flow) · [Inventory](./inventory.md) (bulk update) ·
> [Variants](./variants.md) · [Simple products](./simple-products.md) ·
> [Front-end changelog](../FRONTEND-CHANGELOG-agency-storage.md).

## Base Path
```
/api/vendor/stock-requests
```

## Authentication
Bearer token (or cookie session) with the **vendor** role. Identity flows
token → vendor; there is no `vendorId` in any path. Another party's request returns
**404**, never 403.

---

## When this applies to you

Only for a product whose `delivery.pickupLocation.source` is `agency_storage` — one an
agency physically warehouses. Every other product in your catalogue is unchanged: you
edit its stock directly, as always.

For a warehoused product, **neither side writes the quantity alone.** The agency is the
party that can go and count the shelf and bills storage per SKU against that figure;
you own the goods and the catalogue. So one side proposes, the other approves.

---

## ⚠️ You may already be using this without calling it

Your existing stock edits are routed into this flow automatically. For an
agency-warehoused product, these three **no longer change the quantity**:

| Endpoint | Behaviour |
|---|---|
| `PATCH /api/vendor/products/:productId/variants/:variantId` | every other field applies; `stock`/`isInfiniteStock` become a request |
| `PATCH /api/vendor/products/:id/simple` | same |
| `PATCH /api/vendor/inventory/bulk-update` | non-warehoused rows apply; warehoused rows become requests |

They still return **`200`** — not `202` — with a new `meta.stockAdjustment` block:

```json
{
  "success": true,
  "data": { "id": "664d…", "sku": "NIKE-…", "stock": 120 },
  "meta": {
    "stockAdjustment": {
      "status": "pending_agency_approval",
      "request": { "id": "665a…", "requestedQuantity": 90, "availableActions": ["withdraw"] }
    }
  },
  "message": "Variant updated. The stock change is awaiting the storage agency's approval."
}
```

**`data.stock` is the OLD quantity.** One status code rather than two because you have
to read the body either way; branching on 200-vs-202 would buy nothing.

Interception rather than a separate endpoint is the point. Leaving those three writing
directly and adding this surface beside them would make the rule advisory — bypassable
by simply not using it.

**Not gated, deliberately:** *creating* a variant, creating a simple product, and
duplicating a product write stock directly. An initial quantity is a declaration, not an
adjustment; gating it would strand a brand-new SKU at 0 awaiting approval. The agency
sees the SKU on its roster within a minute and can propose a correction.

---

## The state machine

```
                    ┌──────────── approve ───────────▶ approved  (stock is written)
                    │
   raise ──▶ pending ──────────── reject ────────────▶ rejected  (nothing written)
                    │
                    └──────────── withdraw ──────────▶ withdrawn (nothing written)
```

| Verb | From | Who may |
|---|---|---|
| raise (`POST /`) | — | either party |
| `approve` / `reject` | `pending` | **the counterparty only** |
| `withdraw` | `pending` | **the author only** |

**Do not re-implement this table.** Every response carries `availableActions` — the
server's verdict for you.

> **At most one open request per SKU.** A second `POST` while one is pending is
> `409 STOCK_REQUEST_ALREADY_PENDING`, with `details.hint` saying whether to withdraw
> yours or answer theirs.

---

## 1. Raise a request

### POST /api/vendor/stock-requests

```json
{
  "productId": "664c1f77bcf86cd799439031",
  "variantId": "664d1f77bcf86cd799439041",
  "quantity": 90,
  "note": "Sold 30 through another channel"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `productId` | ObjectId | yes | Must be **your** product, and agency-warehoused |
| `variantId` | ObjectId | yes | An `active` variant of it |
| `quantity` | integer ≥ 0 | yes | The **absolute** target, never a delta. `0` is valid |
| `isInfiniteStock` | boolean | no | Accepted only so it can be *refused* — see below |
| `note` | string ≤ 500 | no | Shown to the agency. Say why |

**Success** — `201 Created`, body is the request (§3).

**Errors**

| Code | HTTP | Meaning |
|---|---|---|
| `INVENTORY_PRODUCT_NOT_STORED_HERE` | 404 | Not your product, or it is not agency-warehoused |
| `CATALOG_VARIANT_NOT_FOUND` | 404 | No such SKU on that product |
| `CATALOG_VARIANT_ARCHIVED` | 422 | Archived SKUs hold nothing the agency shelves |
| `STOCK_REQUEST_NO_CHANGE` | 422 | That is already the recorded quantity |
| `STOCK_REQUEST_ALREADY_PENDING` | 409 | `details: { requestId, requestedByRole, hint }` |
| `CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK` | 422 | See below |

### Unlimited stock cannot be requested

A warehouse holds a countable number of things, so `agency_storage` and
`isInfiniteStock` are mutually exclusive — it is an activation blocker on the product
too. The request is refused at **creation** rather than at approval, on purpose: an
approvable request that broke the product's own activation gate would be a trap, where
the agency signs off, the write lands, and the product silently stops being publishable.

To sell a warehoused product with no fixed ceiling, move its pickup back to a vendor
address first.

---

## 2. Your inbox

### GET /api/vendor/stock-requests

**Query parameters** (all optional):

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer 1–100 | `20` | |
| `status` | `pending` \| `approved` \| `rejected` \| `withdrawn` | — | **No filter returns every status** |
| `productId` | ObjectId | — | |
| `variantId` | ObjectId | — | One SKU's whole history |
| `direction` | `awaiting_me` \| `raised_by_me` | — | |

Unknown query parameters are rejected (`400 VALIDATION_ERROR`).

`direction=awaiting_me` is "pending, and the agency raised it" — your action list.
`raised_by_me` is the converse, which is also where requests the backend created for you
out of a variant PATCH show up.

**Success** — `200 OK`, `{ success, data, meta: { total, page, limit, totalPages } }`.

### GET /api/vendor/stock-requests/:id

---

## 3. The request object

Identical shape to the agency's — see
[Agency → Stock requests §3](../agency/stock-requests.md#3-the-request-object) for the
full field-by-field breakdown. The three points that matter most:

- **Three quantities.** `quantityBefore` is what the proposer saw, `currentQuantity` is
  what the SKU reads now, `requestedQuantity` is what it will read if approved. The
  first two differing is *drift*, not an error — show both.
- **`availableActions`** is the button list. `['withdraw']` if you raised it,
  `['approve','reject']` if the agency did, `[]` once resolved.
- **`awaitingMyDecision`** drives your badge count.

---

## 4. Answering a request

### POST /api/vendor/stock-requests/:id/approve

No body. **Applies the change**: `variant.stock` is written, a `StockAuditLog` row is
recorded (`operation: 'adjustment'`, `actorType: 'vendor'`, `metadata.requestId`), and
the request flips to `approved` — one transaction, so the three cannot come apart.

### POST /api/vendor/stock-requests/:id/reject

```json
{ "reason": "Our own count says 120" }
```
Optional, shown to the agency. Nothing is written.

### POST /api/vendor/stock-requests/:id/withdraw

No body. Retracts a request **you** raised — including one the backend created from a
variant PATCH. No notification is sent, matching the connection flow.

### Errors on all three

| Code | HTTP | Meaning |
|---|---|---|
| `STOCK_REQUEST_NOT_FOUND` | 404 | Not yours |
| `STOCK_REQUEST_NOT_PENDING` | 409 | Already resolved. **Reload — do not retry** |
| `STOCK_REQUEST_NOT_YOURS` | 403 | Wrong verb for your side; `details.availableActions` |
| `STOCK_REQUEST_STALE` | 409 | The product stopped being warehoused by that agency |
| `CATALOG_VARIANT_NOT_FOUND` | 404 | The SKU was deleted under the request |

---

## 5. Notifications

| `type` | When |
|---|---|
| `storage.stock_request.received` | the agency proposed a change — yours to answer |
| `storage.stock_request.approved` | the agency approved a change **you** proposed |
| `storage.stock_request.rejected` | the agency rejected a change **you** proposed |

`aggregateType` is `stock_request`. Gated by `preferences.agencyStorageUpdates`
(default on) on `GET|PATCH /api/vendor/notification-preferences` — the same flag that
covers the agency's unilateral depot and suspension actions. Distinct from
`preferences.storageAlert`, which is your media-file quota.

Nothing is sent for `withdrawn`.
