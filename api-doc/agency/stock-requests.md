# Agency Stock Requests

Changing the recorded stock of a SKU you warehouse. Every change needs both
signatures — yours and the vendor's.

> Related docs: [Inventory](./inventory.md) (where these requests surface per SKU) ·
> [Vendor → Stock requests](../vendor/stock-requests.md) (the mirror) ·
> [Vendor connections](./vendor-connections.md) (the flow this one is modelled on) ·
> [Front-end changelog](../FRONTEND-CHANGELOG-agency-storage.md).

## Base Path
```
/api/agency/stock-requests
```

## Authentication
Bearer token (or cookie session) with the **agency** role. Identity flows
token → agency; there is no `agencyId` in any path. Another party's request returns
**404**, never 403 — whether a given request id exists is not information you are owed.

---

## Why stock needs two signatures

`ProductVariant.stock` used to be the vendor's alone. For a product you warehouse that
is the wrong owner for it:

- **You** are the party who can go and count the shelf, you bill storage per SKU
  against that figure, and you are the one left short when a delivery is dispatched
  against stock that never arrived.
- **The vendor** owns the goods and the catalogue, so you cannot write it either.

So neither side writes it. One proposes, the other approves, and the number moves in
the same transaction that records the approval.

This applies **only** to products whose pickup is `agency_storage` and whose effective
agency is you. Everything else in the catalogue is unaffected — a vendor still edits
their own stock directly.

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

The asymmetry is deliberate. Give the author a `reject` and a request has two ways to
die that mean different things; give the counterparty a `withdraw` and either side can
retract the other's ask.

**Do not re-implement this table.** Every response carries `availableActions` — the
server's verdict for *you* — and rendering buttons from anything else is how a client
ends up offering a verb the API refuses.

> **At most one open request per SKU.** A second `POST` while one is pending is
> `409 STOCK_REQUEST_ALREADY_PENDING`, with `details.hint` telling you whether to
> withdraw yours or answer theirs.

---

## 1. Raise a request

### POST /api/agency/stock-requests

```json
{
  "productId": "664c1f77bcf86cd799439031",
  "variantId": "664d1f77bcf86cd799439041",
  "quantity": 118,
  "note": "Counted 118 on the shelf this morning"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `productId` | ObjectId | yes | Must be a product **you warehouse** |
| `variantId` | ObjectId | yes | An `active` variant of that product |
| `quantity` | integer ≥ 0 | yes | The **absolute** target, never a delta. `0` is valid — a warehouse can be emptied |
| `isInfiniteStock` | boolean | no | Accepted only so it can be *refused*: a warehoused SKU may never be unlimited |
| `note` | string ≤ 500 | no | Shown to the vendor. Say what you counted |

**Why absolute and not a delta:** a `-10` approved three days later applies to a number
nobody agreed on. An absolute figure means the request states exactly what the shelf
will read. Drift is preserved instead of rejected — see `quantityBefore` vs
`currentQuantity` below.

**Success** — `201 Created`, body is the request (see the shape in §3).

**Errors**

| Code | HTTP | Meaning |
|---|---|---|
| `INVENTORY_PRODUCT_NOT_STORED_HERE` | 404 | You do not warehouse this product |
| `CATALOG_VARIANT_NOT_FOUND` | 404 | No such SKU on that product |
| `CATALOG_VARIANT_ARCHIVED` | 422 | Archived SKUs hold nothing you have to shelve |
| `STOCK_REQUEST_NO_CHANGE` | 422 | That is already the recorded quantity |
| `STOCK_REQUEST_ALREADY_PENDING` | 409 | `details: { requestId, requestedByRole, hint }` |
| `CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK` | 422 | You asked for unlimited on a warehoused SKU |

---

## 2. Your inbox

### GET /api/agency/stock-requests

**Query parameters** (all optional):

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer 1–100 | `20` | |
| `status` | `pending` \| `approved` \| `rejected` \| `withdrawn` | — | **No filter returns every status** |
| `productId` | ObjectId | — | |
| `variantId` | ObjectId | — | One SKU's whole negotiation history |
| `direction` | `awaiting_me` \| `raised_by_me` | — | See below |

Unknown query parameters are rejected (`400 VALIDATION_ERROR`).

**Every status by default, terminal rows included.** A live-only default would make a
SKU's history impossible to fetch, and the list is the only place you learn the id of a
request you raised yourself.

`direction=awaiting_me` is "pending, and the vendor raised it" — your action list, in
one query. `direction=raised_by_me` is the converse.

**Success** — `200 OK`:

```json
{
  "success": true,
  "data": [ /* requests, newest first */ ],
  "meta": { "total": 7, "page": 1, "limit": 20, "totalPages": 1 }
}
```

### GET /api/agency/stock-requests/:id

One request, with `currentQuantity` resolved live.

---

## 3. The request object

```json
{
  "id": "665a1f77bcf86cd799439061",
  "productId": "664c1f77bcf86cd799439031",
  "variantId": "664d1f77bcf86cd799439041",
  "vendorId": "664b1f77bcf86cd799439021",
  "agencyId": "664a1f77bcf86cd799439051",

  "requestedByRole": "vendor",
  "requestedAt": "2026-08-06T09:12:00.000Z",

  "quantityBefore": 120,
  "infiniteBefore": false,
  "requestedQuantity": 90,
  "requestedInfinite": false,

  "currentQuantity": 100,
  "currentInfinite": false,

  "status": "pending",
  "note": "Sold 30 through another channel",

  "awaitingMyDecision": true,
  "availableActions": ["approve", "reject"],

  "approval": null,
  "rejection": null,
  "withdrawal": null,

  "statusHistory": [
    { "status": "pending", "changedAt": "2026-08-06T09:12:00.000Z", "changedByRole": "vendor", "note": "Sold 30 through another channel" }
  ],

  "createdAt": "2026-08-06T09:12:00.000Z",
  "updatedAt": "2026-08-06T09:12:00.000Z"
}
```

### The three quantities, and why there are three

| Field | Answers |
|---|---|
| `quantityBefore` | what the **proposer** saw when they raised it |
| `currentQuantity` | what the SKU reads **right now** (`null` in the list when unresolvable) |
| `requestedQuantity` | what it will read **if you approve** |

`quantityBefore ≠ currentQuantity` is **drift**, not an error. Somebody changed the
number between the proposal and now. It is deliberately not a `409`: the request
proposes an absolute figure, so drift changes *what is replaced*, not whether the
request still makes sense. Show both when they differ — that is the one thing an
approver needs to notice before signing off.

### The affordance fields

| Field | Use |
|---|---|
| `awaitingMyDecision` | drive your badge count off this |
| `availableActions` | render buttons from **exactly** this array |

`availableActions` is `['withdraw']` when you raised it, `['approve','reject']` when
the vendor did, and `[]` once resolved.

### The outcome sub-documents

Exactly one of `approval` / `rejection` / `withdrawal` is non-null once resolved.

```json
"approval":   { "byRole": "agency", "at": "…", "quantityAtApply": 100 }
"rejection":  { "byRole": "agency", "at": "…", "reason": "Counted 118 on the shelf" }
"withdrawal": { "byRole": "vendor", "at": "…" }
```

`approval.quantityAtApply` is what the SKU actually held the instant it was replaced —
the audit trail for the drift above.

---

## 4. Answering a request

### POST /api/agency/stock-requests/:id/approve

No body. **Applies the change**: `variant.stock` is written, a `StockAuditLog` row is
recorded (`operation: 'adjustment'`, `actorType: 'agency'`, `metadata.requestId`), and
the request flips to `approved` — all in one transaction. A request marked approved
whose stock never landed would leave the two parties believing different things about a
warehouse, so the three cannot come apart.

### POST /api/agency/stock-requests/:id/reject

```json
{ "reason": "I counted 118, not 90" }
```
`reason` is optional and shown to the vendor. Nothing is written to the SKU.

### POST /api/agency/stock-requests/:id/withdraw

No body. Retracts a request **you** raised. Deliberately produces **no notification** —
retracting something the vendor had not acted on is not news worth pushing, the same
call the connection flow makes.

### Errors on all three

| Code | HTTP | Meaning |
|---|---|---|
| `STOCK_REQUEST_NOT_FOUND` | 404 | Not yours |
| `STOCK_REQUEST_NOT_PENDING` | 409 | Already resolved. **Reload — do not retry.** The other party got there first, and re-applying an intent formed against a state that no longer holds would resolve a request twice |
| `STOCK_REQUEST_NOT_YOURS` | 403 | Wrong verb for your side. `details.availableActions` says what you may do |
| `STOCK_REQUEST_STALE` | 409 | The product stopped being warehoused by you while the request stood — re-pointed at another agency, or switched off agency storage |
| `CATALOG_VARIANT_NOT_FOUND` | 404 | The SKU was deleted under the request |

---

## 5. Notifications

Three situations, in-app plus your usual channels:

| `type` | When |
|---|---|
| `storage.stock_request.received` | the vendor proposed a change — yours to answer |
| `storage.stock_request.approved` | the vendor approved a change **you** proposed |
| `storage.stock_request.rejected` | the vendor rejected a change **you** proposed |

`aggregateType` is `stock_request`; `aggregateId` is the request id. Gated by
`preferences.stockRequestUpdates` (default on) — **not** by `preferences.storageAlert`,
which is the media-file quota and shares only the word.

Switching the preference off silences the push, not the obligation: a vendor's request
still sits in your inbox awaiting an answer.

There is no notification for `withdrawn`.

---

## 6. How this interacts with the rest

- **The vendor's own stock edits route here automatically.** A vendor PATCHing
  `stock` on a warehoused SKU does not write it — the backend turns it into a request.
  They do not have to use this endpoint for the gate to work, which is the point: there
  is no unguarded spelling of the operation left.
- **Not gated:** a vendor *creating* a variant or a simple product, or duplicating a
  product, writes the initial quantity directly. An initial quantity is a declaration,
  not an adjustment. You will see the new SKU on your roster within a minute and can
  propose a correction from there.
- **Unlimited stock is impossible on a warehoused SKU.** Any request asking for it is
  refused at creation, so no approvable request can leave a product in a state its own
  activation gate rejects. See [Inventory](./inventory.md).
- **A pending request shows on the inventory row** as
  `catalogStock.pendingRequest`, so the SKU list is a viable entry point to this flow.
