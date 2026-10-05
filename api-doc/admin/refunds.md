# Admin — the refund queue (`/api/internal/admin/refunds`)

> **Caller: wi-admin only.** Service-to-service, behind `requireAdminCaller`
> (`INTERNAL_ADMIN_SERVICE_TOKEN` here === `JOVI_MALL_SERVICE_TOKEN` there). No public twin, and
> there must never be one. Headers, envelope and the read-a-record / delegate-a-verdict rule:
> [internal-service-api.md](./internal-service-api.md).
>
> Design record: `../PRODUCTION-READINESS/REFUND-FLOW-PLAN.md` § 7 (the queue) and § 11.7 (this
> contract). Built 2026-10-05 (plan step R7).

wi-admin **reads `refund_requests` directly** (field list: plan § 11.1) and delegates every
**write** here: each one is a status transition paired with post-commit effects — an earnings
pause or clawback, a gateway transfer, the customer's notification — that a second writer would
reproduce and miss.

**Authorization is decided in wi-admin before the call** (`orders.refund.read`,
`orders.refund.request`, `orders.refund`, `orders.refund.settle_external`, the four-eyes
threshold). This service re-checks only what it can see:

- **the second-approver rule for a TYPED number** (R-7): the approver's `X-Actor-Id` must differ
  from the requester's (`requested_by.id`, stamped from `X-Actor-Id` at create);
- **Support never sends money**: `requestedByRole: 'support'` always creates `awaiting_approval`,
  whatever `approveNow` says.

**Nothing is audited on this side** — `X-Actor-Id` is a header the token holder sets. wi-admin
audits every write fail-closed, where the human is known.

## The DTO

Every write answers the standard envelope with `data` = the camelCase projection of one
`refund_requests` row (`payments/dto/refund-request.dto.ts`):

```jsonc
{
  "id": "6720…", "sourceKind": "order", "sourceId": "671f…", "orderNumber": "ORD-2026-000123",
  "vendorId": "…", "customerId": "…",
  "reasonKind": "cancellation", "reason": "Customer cancelled before dispatch",
  "itemDefective": null, "overridePolicy": false,
  "attribution": { "goods": 5000, "delivery": 0 },
  "grossAmount": 5000, "feeRate": 2, "feeAmount": 100, "netAmount": 4900, "currency": "XAF",
  "paymentChannel": "mobile_money",              // card | mobile_money | cod | billing
  "channel": "payout",                           // card_refund | payout | external | null (not decided yet)
  "destination": { "phone": "+237677000512", "name": "Jean", "source": "payer" },   // or "typed", or null
  "destinationProofFileId": null,
  "codCollectionIds": [],
  "status": "sending",                           // awaiting_approval | approved | waiting_for_cash | sending | completed | failed | rejected
  "requestedBy": { "id": "<wi-admin admin id>", "role": "admin", "name": "Alice" },
  "approvedBy": { "id": "…", "name": "Alice", "at": "2026-10-05T10:00:00.000Z" },
  "rejectedBy": null, "rejectionReason": null,
  "transferReference": "jm_rf_…", "transferGateway": "NOTCHPAY", "transferGatewayRef": null,
  "transferFailureReason": null, "transferNote": null,
  "transferLegs": [{ "phone": "+237677000512", "amount": 4900, "gross": 5000, "reference": "jm_rf_…", "gatewayRef": null, "status": "sending", "failureReason": null }],
  "externalSettlement": null,                    // or { method, reference, proofFileId, settledBy, settledAt, grossAmount, netAmount } — see settle-external
  "ticketId": null, "refundTransactionIds": [], "completedAt": null,
  "earningsImpact": "clawback",                  // clawback (earnings paused, then recovered) | none (unallocated delivery money: no pause, no clawback)
  "earningsSettledAt": null,                     // completed order/booking + clawback: when the earnings recovery finished (null = still due; the nightly sweep retries it)
  "billingReversedAt": null,                     // completed plan_purchase / credit_topup: when the plan or credits were taken back (null = still due)
  "createdAt": "…", "updatedAt": "…"
}
```

Destination phones are **full** here (the administrator surface). Customer-facing views mask them.

`transferFailureReason: "exceeds_refundable"` means money left the source by another road since the
request was raised (e.g. a delivery-fee refund paid by hand): the send was refused before any money
moved and an `approved` request was moved to `failed` — reject it and raise a smaller one.

⚠ **`create`, `approve` and the COD release never fail for a SEND problem.** Once the request is
committed they answer `2xx` with the row, whatever the gateway did — read `status`,
`transferFailureReason` (`payout_unavailable`, `insufficient_gateway_balance`, a gateway message)
and `transferNote` (an outcome-unknown note). `retry` is the verb that throws for a send problem.

---

## `GET /eligibility`

The preview the dashboard shows before a request is raised. Read-only.

Query (strict — an unknown parameter is a 400):

| Param | Required | Notes |
|---|---|---|
| `sourceKind` | yes | `order` · `booking` · `plan_purchase` · `credit_topup` |
| `sourceId` | yes | 24-hex id |
| `reasonKind` | no | selects which row `maxRefundable` reports. Default: `return` if the order was delivered, else `cancellation` |
| `itemDefective` | no | `true` / `false` — only matters under `customer_reimbursed_if_defect` |
| `amount` | no | integer; decides whether `above_policy_maximum` is in `overrides` (default: `maxRefundable`) |

```jsonc
{
  "sourceKind": "order", "sourceId": "671f…",
  "maxRefundable": 6000,                 // GROSS: min(attribution rule, money still refundable)
  "currency": "XAF",
  "paymentChannel": "mobile_money",
  "hasPayerPhone": true,                 // every payment leg carries a readable payer number
  "payerPhoneMasked": "+•••••••••512",   // null when hasPayerPhone is false
  "attributionPreview": {
    "reasonKind": "cancellation", "itemDefective": null,
    "goods": 5000, "delivery": 1000,     // of maxRefundable
    "goodsAmount": 5000, "deliveryAmountPaid": 1000, "delivered": false,
    "remaining": 6000,                   // money still refundable, before the attribution rule
    "feeAmount": 120, "netAmount": 5880, // of maxRefundable
    "byReasonKind": {
      "cancellation":       { "maxRefundable": 6000, "goods": 5000, "delivery": 1000, "feeAmount": 120, "netAmount": 5880 },
      "return":             { "maxRefundable": 5000, "goods": 5000, "delivery": 0,    "feeAmount": 100, "netAmount": 4900 },
      "goodwill":           { … },
      "dispute_settlement": { … }
    }
  },
  "returnShippingPayer": "customer",     // vendor | customer | customer_reimbursed_if_defect | null
  "overrides": [],                       // vendor return-policy gates a refund would bypass (orders only)
  "codCoverage": [],                     // COD orders: one row per cash collection (below)
  "feePercent": 2                        // 0 for a card payment (R-3)
}
```

`overrides[]` values: `return_window_expired` · `policy_disabled` · `order_not_paid` ·
`above_policy_maximum` — the vendor's own rule (`computeVendorRefundEligibility`), reported, not
enforced. Non-empty means `POST /` needs `overridePolicy: true`. Always `[]` for bookings and
billing.

`codCoverage[]` rows: `{ collectionId, shipmentId, kind: 'order'|'delivery_fee', expected, settled,
settledAt, status: 'pending'|'collected'|'cancelled' }`. A COD refund sends only once every
collected row has `settledAt` (R-5, R-6); until then it waits in `waiting_for_cash`.

Errors: `400` (query) · `404 REFUND_ORDER_NOT_FOUND` · `404 REFUND_PAYMENT_NOT_FOUND` (no settled
payment) · `409 REFUND_ORDER_NOT_PAID` (COD with no cash collected yet; an unpaid purchase).

---

## `POST /` — open a request

```jsonc
{
  "sourceKind": "order",                 // required
  "sourceId": "671f…",                   // required
  "amount": 5000,                        // optional, GROSS, positive integer. Absent = the most allowed
  "reasonKind": "cancellation",          // required: cancellation | return | goodwill | dispute_settlement
  "reason": "Customer cancelled",        // required, 1–1000 chars
  "itemDefective": true,                 // optional
  "overridePolicy": true,                // optional — confirms going past the vendor's return policy
  "destination": { "phone": "+237677000512", "name": "Jean" },   // optional: a TYPED number (R-7)
  "destinationProofFileId": "6721…",     // required with `destination`: an id from POST /proofs
  "requestedByRole": "admin",            // required: admin | support
  "approveNow": false,                   // optional
  "ticketId": "6722…"                    // optional: the support ticket it was raised from
}
```

Strict at every level: an unknown key is a `400`; optional keys are **omitted**, never `null`.

- `requestedByRole: 'support'` → always `awaiting_approval` (Support may hold, never send).
- `approveNow: true` is honoured only for `admin` **and** an untyped destination; the request is
  then approved and sent in the same call (`approved_by` = the requester).
- A typed `destination` always lands `awaiting_approval` and needs a **different** administrator
  to approve it.
- Opening a request for an order or booking **pauses its earnings** (`refund_in_progress`, C-4).

**`201`**, `data` = the DTO.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` (Zod) | bad body, unknown key |
| 400 | `REFUND_AMOUNT_EXCEEDS_MAX` | `amount` above the attribution × money ceiling; `details.maxRefundable` |
| 404 | `REFUND_ORDER_NOT_FOUND` · `REFUND_PAYMENT_NOT_FOUND` | no such source / no settled payment |
| 409 | `REFUND_ORDER_NOT_PAID` · `REFUND_ALREADY_FULLY_REFUNDED` | nothing to refund |
| 409 | `REFUND_ALREADY_OPEN` | one open request per source (`awaiting_approval … failed`) — refused before anything is paused |
| 422 | `REFUND_NOT_ELIGIBLE` | `details.reason: 'billing_full_refund_only'`: a plan purchase or credit top-up is refunded in FULL only (`details.required`). Completing it takes the plan back (downgrade to free) or debits the credits back |
| 422 | `REFUND_POLICY_OVERRIDE_REQUIRED` | order beyond the vendor's return policy without `overridePolicy: true`; `details.overrides` |
| 422 | `REFUND_DESTINATION_PROOF_REQUIRED` | typed number without a proof, or a proof id that is not a file in the `refund-proofs` tree (`details.reason: 'proof_not_found'`) |
| 422 | `REFUND_NO_DESTINATION` | typed number unreadable (`details.reason: 'typed_phone_invalid'`), or `approveNow` by an admin with nowhere to send |
| 500 | `REFUND_PORT_NOT_REGISTERED` | boot wiring missing — nothing was written |

## `POST /:id/approve` — `{}`

`awaiting_approval → approved`, then sends (COD not yet covered → `waiting_for_cash`). The approver
is `X-Actor-Id`. **`200`**, DTO.

| Status | Code | When |
|---|---|---|
| 404 | `REFUND_REQUEST_NOT_FOUND` | |
| 409 | `REFUND_REQUEST_STATUS_CONFLICT` | not `awaiting_approval`, or it changed underneath |
| 409 | `REFUND_SECOND_APPROVER_REQUIRED` | typed destination and approver == requester |
| 422 | `REFUND_DESTINATION_PROOF_REQUIRED` · `REFUND_NO_DESTINATION` | |

## `POST /:id/reject` — `{ reason }`

Only from `awaiting_approval` or `failed` (**never from `sending`**), and never once part of the
money has left. Resumes the earnings pause if it is still the refund's own. **`200`**, DTO.
Errors: `404 REFUND_REQUEST_NOT_FOUND` · `409 REFUND_REQUEST_STATUS_CONFLICT`.

## `POST /:id/retry` — `{}`

Claim and send again: `failed` (or an `approved` row whose send was refused before its claim).
Reuses the `jm_rf_` reference(s). **`200`**, DTO.

| Status | Code | When |
|---|---|---|
| 404 | `REFUND_REQUEST_NOT_FOUND` | |
| 409 | `REFUND_REQUEST_STATUS_CONFLICT` | already `sending`, or not claimable; or `details.reason: 'exceeds_refundable'` (`details.remaining`, `details.grossAmount`) — the source no longer holds this much; nothing was sent |
| 409 | `REFUND_INSUFFICIENT_GATEWAY_BALANCE` | the payout float is short — nothing was sent; `details.required` / `available` |
| 422 | `REFUND_PAYOUT_UNAVAILABLE` | payouts off on this deployment — settle externally |
| 422 | `REFUND_NO_DESTINATION` | |
| 5xx | (gateway) | the gateway gave no readable answer AFTER the claim: the row stays `sending` with a `transferNote`. Check the gateway dashboard before doing anything |

## `POST /:id/settle-external` — `{ method, reference?, proofFileId }`

Records a refund paid **outside** the platform (R-7b) and completes the request exactly like a
transfer would (ledger, totals, earnings recovery, notification). `method`: `mobile_money` ·
`cash` · `bank` · `other`. `proofFileId` is **required** and must be a file uploaded through
`POST /proofs`. Allowed from `awaiting_approval`, `approved`, `waiting_for_cash`, `failed` —
**never from `sending`**. The fee still applies (D-1). **`200`**, DTO.

**After a multi-transfer refund part of which already left** (a transfer leg `succeeded`, or a card
leg Stripe refunded), the administrator pays **only the remainder**:
`externalSettlement.grossAmount` / `netAmount` are that remainder (the whole request otherwise; a
row settled before 2026-10-05 reports the whole request). The ledger records each part as what it
was — the succeeded legs as `payout` / `card_refund`, the rest as `external` — and the customer's
"paid by hand" notification names the remainder.

Errors: `400` · `404 REFUND_REQUEST_NOT_FOUND` · `409 REFUND_REQUEST_STATUS_CONFLICT` (also when
nothing is left to pay by hand, or `details.reason: 'exceeds_refundable'`) ·
`422 REFUND_EXTERNAL_PROOF_REQUIRED` (missing, or not a `refund-proofs` file).

## `POST /:id/resolve-unknown` — `{ outcome: 'arrived' | 'failed', note }`

Resolves a request stuck in `sending`, after the same minimum age the reconciliation sweep waits
(`PAYOUT_RECONCILE_MIN_AGE_MINUTES`). `arrived` completes it; `failed` fails it (then `retry` or
`settle-external`). **`200`**, DTO.

Errors: `404 REFUND_REQUEST_NOT_FOUND` · `409 REFUND_REQUEST_STATUS_CONFLICT` (not `sending`, or
too recent — `details.settleAfter`).

---

## `POST /proofs` — upload one proof picture

`multipart/form-data`, field **`file`**, exactly one file: `image/jpeg` · `image/png` ·
`image/webp` · `application/pdf`, ≤ 10 MB. Virus-scanned and magic-byte sniffed by the upload
pipeline. Stored in the **PRIVATE `refund-proofs/` tree** (never public, never `by-type`), owned by
the calling administrator, with a `file_references` row so the orphan sweep never deletes it.

**`201`**, `data: { "fileId": "6721…" }` — pass it as `destinationProofFileId` or `proofFileId`.

Errors: `400 VALIDATION_ERROR` (no file / a second file / wrong field) · `400 UPLOAD_POLICY_VIOLATION`
(type, size, scan; `details.violations`) · `413 CATALOG_FILE_TOO_LARGE`.

⚠ An uploaded proof is legitimately unreferenced by any `refund_requests` row between this call and
the create / settle that uses it, so reads below do not require a reference.

## `GET /proofs/:fileId` — the bytes

Streams the file (`Content-Type` from the record, `Content-Disposition: inline`,
`Cache-Control: private, no-store`). **Refuses `404 CATALOG_FILE_NOT_FOUND` for any file outside
the `refund-proofs/` tree** — this route cannot reach a KYC scan, a digital product or a public
image. `409 STORAGE_DOWNLOAD_NOT_SUPPORTED` when the storage provider cannot stream.

---

## Not on this surface

- **Reads of the queue** — wi-admin reads `refund_requests` directly.
- **Write-off of an earnings debt** — `POST /api/internal/admin/earnings/clawbacks/:ownerType/:ownerId/write-off`
  ([earnings.md](./earnings.md)).
- **The legacy `POST /api/internal/admin/orders/:id/refund`** — no longer synchronous: it opens a
  refund request through the same service as `POST /` here, created and approved in one call (card
  → `completed`; mobile money with a payer number → `sending`; COD or no number → `awaiting_approval`
  in this queue), and refuses with `422 REFUND_USE_REFUND_QUEUE` when the order's completed refunds
  plus this amount reach 2,000,000 (`details.alreadyRefunded`). See [orders.md](./orders.md).
- **Manual resume of a paused order/booking** (`POST /api/internal/admin/earnings/pauses/:kind/:id/resume`)
  answers `409 EARNINGS_PAUSE_HELD_BY_REFUND` (`details.refundRequestId`, `refundRequestStatus`) while
  a refund request of that source is open, or a completed one has not recovered its earnings yet.
