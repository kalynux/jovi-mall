# Customer — delivery-fee changes after checkout

**Since 2026-10-04** ([ADR-A11](../../docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md) § Fee changes after
checkout, owner decisions D-8 · D-9 · D-10). Applies only to **customer-paid** shipments
(`deliveryPayer: 'customer'` on the order / shipment). A vendor-paid shipment's fee is between
the shop and the delivery company and never appears here.

Delivery fees are posted prices at checkout. After you pay, a fee can change only in four ways:

| What happens | Who starts it | What you do | Money |
|---|---|---|---|
| The delivery company **lowers** a fee | delivery company | nothing — it applies at once | online: the difference is refunded to you · COD: you pay less cash |
| The delivery company **raises** a fee | delivery company | approve or decline | online: approve → pay the difference (top-up) · COD: approve → more cash at the door · decline → the company carries at the old fee, proposes once more, or declines the job |
| The shop **moves your parcel** to another delivery company | shop | if the new company costs more: approve or decline | you keep what you paid; lower → refunded/less cash; higher → approve (pay the difference) or decline (**the shop pays it**) |
| You ask for a **combined price** on several parcels | you | wait for the answer | only lower fees are possible; applied at once like any decrease |

All are before pickup. While an increase waits for your answer (or, online, for your top-up), the
parcel **cannot be picked up**.

---

## GET /api/customer/orders/:id/delivery-fee-proposals

Everything about one order's delivery fees. `:id` is one per-vendor order (the `orders[].id` of a
checkout group).

```json
{
  "success": true,
  "data": {
    "currency": "XAF",
    "proposals": [
      {
        "id": "66f…",
        "shipmentId": "66e…",
        "orderId": "66d…",
        "raisedBy": "delivery_company",
        "origin": "agency",
        "direction": "increase",
        "currency": "XAF",
        "feeBefore": 1500,
        "proposedFee": 2000,
        "reason": "Bulky parcel, needs a car",
        "status": "pending",
        "version": 1,
        "topup": null,
        "availableActions": ["approve", "reject"],
        "respondedAt": null,
        "createdAt": "2026-10-04T10:00:00.000Z"
      }
    ],
    "shipments": [
      { "shipmentId": "66e…", "status": "assigned", "deliveryPayer": "customer",
        "fee": 1500, "customerFee": 1500, "pendingProposalId": "66f…" }
    ],
    "refunds": {
      "owed": 0,
      "entries": [ { "amount": 300, "status": "completed", "cause": "fee_decrease",
                     "createdAt": "…", "settledAt": "…" } ]
    }
  }
}
```

- `raisedBy`: `delivery_company` · `platform` (a change-agency difference).
- `origin`: `agency` · `change_agency` · `combined_request`.
- `status`: `pending` · `approved` · `rejected` · `withdrawn`. A decrease is `approved` the moment
  it is created.
- `availableActions` ⊂ `approve` · `reject` · `pay` — render only these. After an online approval
  it becomes `["pay","reject"]` and `topup` is `{ amount, status: "awaiting_payment", paidAt: null }`.
- `shipments[].fee` — what the delivery company is paid; `customerFee` — online: what you have paid
  for that delivery (checkout + top-ups, never lowered — refunds are listed under `refunds`);
  COD: the delivery cash you will hand over.
- `refunds.owed` — delivery money owed back to you and not yet claimed by a refund. `entries[].status`:
  `processing` · `completed` · `manual_required` (our team pays it by hand — you get a
  notification) · `failed` (retried automatically).

## POST /api/customer/orders/:id/delivery-fee-proposals/:proposalId/approve

Body `{ "version": 1 }` — the `version` you were shown (required; an edited figure answers
`409 DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH` with `details.currentVersion` — reload, never retry blind).

- **COD**: applies at once — the new fee, and the delivery code's cash amount grows.
- **Online**: freezes the figure; the response carries `topup: { amount, status: "awaiting_payment" }`
  and the parcel waits for the payment below. Calling approve again returns the same proposal.

## POST /api/customer/orders/:id/delivery-fee-proposals/:proposalId/pay

Online, after approve. Same body as every payment door:

```json
{ "provider": "MTN", "channel": { "phoneNumber": "+237670000000" } }
```

Answers like `POST /payments/initiate` (`transactionId`, `status`, `instructions`, `amount`,
`currency`, plus `proposalId`). Confirm with `POST /payments/verify` or wait for the webhook; a
card link can be minted with `POST /payments/:transactionId/pay-link`. When it succeeds the new fee
applies, the order's `total` grows by the top-up, and the parcel can be picked up. If it fails you
are told (`order.delivery_fee.topup_failed`) and may pay again. `409 DELIVERY_FEE_TOPUP_NOT_DUE`
when nothing is owed.

## POST /api/customer/orders/:id/delivery-fee-proposals/:proposalId/reject

Body `{ "version": 1, "note": "optional" }`.

- A delivery company's increase: the fee stays; the company may carry at the old fee, propose once
  more, or decline the job (then the shop picks another company).
- A change-agency difference: you pay nothing more — **the shop covers it**.
- `409 DELIVERY_FEE_TOPUP_IN_PROGRESS` while a top-up payment you started is still live.

---

## Combined delivery price

### POST /api/customer/orders/groups/:cartId/combined-delivery-requests

```json
{ "agencyId": "66a…", "shipmentIds": ["66e…", "66f…"], "note": "Same street — one trip?" }
```

`shipmentIds` optional: omitted = every eligible parcel this company carries on the checkout.
Eligible = same checkout, same delivery company, customer-paid, not picked up, no pending fee
change, and the parcel's change cap not reached; at least **two**. `201` with the request DTO:

```json
{ "id": "…", "cartId": "…", "agencyId": "…", "currency": "XAF", "status": "open", "note": "…",
  "shipments": [ { "shipmentId": "…", "orderId": "…", "feeAtRequest": 1500 } ],
  "answer": null, "declineNote": null, "createdAt": "…", "closedAt": null }
```

Errors: `422 COMBINED_DELIVERY_REQUEST_INELIGIBLE` (`details.reason` agency · cart · status · payer
· pending · limit · too_few), `409 COMBINED_DELIVERY_REQUEST_ALREADY_OPEN` (`details.requestId`).

### GET /api/customer/orders/groups/:cartId/combined-delivery-requests

Your requests on that checkout, newest first. `status`: `open` · `answered` · `declined` ·
`cancelled`. An answered one carries `answer: { fees: [{ shipmentId, feeBefore, feeAfter,
proposalId }], saving, note, answeredAt }`; the lowered fees also appear as `approved` decreases on
the orders' proposal lists, and their money moves exactly as any decrease.

### POST /api/customer/orders/groups/:cartId/combined-delivery-requests/:requestId/cancel

While `open`. `409 COMBINED_DELIVERY_REQUEST_NOT_OPEN` otherwise.

---

## Notifications (cannot be muted — money)

| Situation | When |
|---|---|
| `order.delivery_fee.approval_needed` | an increase awaits your answer (again after the company edits it) |
| `order.delivery_fee.topup_due` | you approved an online increase — pay the difference |
| `order.delivery_fee.lowered` | a lower fee applied (says refund or less cash) |
| `order.delivery_fee.updated` | a higher fee now applies (cash at the door / top-up received / the shop covers it) |
| `order.delivery_fee.refund_pending` | money owed back must be paid by hand |
| `order.delivery_fee.topup_failed` | the top-up payment did not go through |
| `order.combined_delivery.answered` | the delivery company answered your combined request |
| `order.refunded` (existing) | an automatic refund went through |

All link to `shop/account/orders/detail/{orderId}`.
