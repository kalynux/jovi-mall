# Vendor — Delivery-fee proposals

**Added 2026-10-02.** Source: `src/modules/delivery-fee-proposals/`.

You pay each shipment's delivery fee out of your net (the customer never pays it). The fee comes
from the agency's published pricing — today a **flat amount per shipment** (`additional_per_kg`
is not used by the formula yet). When one particular parcel needs a different price, the agency
— or, if the agency allows it, the agent who accepted the job — **proposes** a new fee for that
shipment, with a reason. Nothing changes until **you** approve. A rise or a cut, every change
needs your answer.

While a proposal is pending, **that shipment cannot be picked up**, so answer promptly.

> **Customer-paid shipments (ADR-A11, 2026-10-04).** When your shop's delivery terms make the
> CUSTOMER pay a shipment's delivery (`deliveryPayer: 'customer'`), its fee changes are the
> customer's to answer, not yours: a lower fee applies at once, a higher one waits for the
> customer. Such proposals appear in your lists read-only — `approver: 'customer' | 'none'`,
> `availableActions: []`, and approve/reject answer `403 DELIVERY_FEE_PROPOSAL_NOT_YOURS`. Your net
> does not move. New fields on every proposal: `approver` (`vendor`·`customer`·`none`), `origin`
> (`agency`·`change_agency`·`combined_request`), `direction`, `customerApproval`, `topup`,
> `combinedRequestId`; `application` gains `customerFeeBefore/After`, `customerTopupAmount`,
> `customerRefundDue`, `codCollectionAdjusted`, `vendorBorneDelta`.
>
> **Changing the delivery company on a customer-paid order** (`PATCH /orders/:id/delivery-agency`):
> moving a whole shipment carries what the customer paid; if the new company is cheaper the
> customer gets the difference back, if it costs more the customer is asked — and if they decline,
> **you cover the difference** (out of your net; you are notified: `delivery_fee_proposal.customer_declined`).
> The move is refused with `422 DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE` if you could not
> afford that. You may cover it immediately instead of waiting:
>
> `POST /api/vendor/orders/:id/delivery-fee-proposals/:proposalId/cover` — no body; only on a
> pending `origin: 'change_agency'` proposal (`availableActions: ["cover"]`). The new company is
> paid its price, the customer pays nothing more, your net carries the difference.

## Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/api/vendor/delivery-fee-proposals?status=pending&orderId=&page=1&limit=20` | your inbox across orders (every status by default; `limit` ≤ 100) |
| GET | `/api/vendor/orders/:id/delivery-fee-proposals` | one order's proposals, newest first (also on `GET /api/vendor/orders/:id` as `deliveryFeeProposals`) |
| POST | `/api/vendor/orders/:id/delivery-fee-proposals/:proposalId/approve` | accept the new fee. Body **`{ "version": int }`** (required) |
| POST | `/api/vendor/orders/:id/delivery-fee-proposals/:proposalId/reject` | keep the original fee. Body **`{ "version": int, "note"?: string ≤ 500 }`** |

> ⚠ **Send back the `version` you displayed** (changed 2026-10-02). The agency — or the proposing
> agent — may **edit** a pending proposal (fee and/or reason); every edit bumps `version`. An
> approve/reject whose `version` is not the current one is refused with
> `409 DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH` (`details.currentVersion`) and changes nothing —
> reload the proposal and show the vendor the new figure. You never approve a fee you did not see.
> A request without `version` is `400 VALIDATION_ERROR`.

A shipment has at most **one** pending proposal; an edit changes that request in place (it does not
create a new one). The `edits[]` trail shows each change.

List response: `{ success, data: Proposal[], meta: { total, page, limit, totalPages } }`.

## The proposal

```json
{
  "id": "66fd…01",
  "shipmentId": "66fc…aa",
  "orderId": "66fb…10",
  "agencyId": "66f0…99",
  "proposedBy": { "role": "agent", "userId": "66e1…07", "agentId": "66e2…33" },
  "currency": "XAF",
  "feeBefore": 1500,
  "proposedFee": 2500,
  "reason": "Two 25 kg sacks — needs a van, not a bike",
  "status": "pending",
  "respondedBy": null,
  "rejectionNote": null,
  "withdrawalReason": null,
  "application": null,
  "version": 2,
  "edits": [
    {
      "editedBy": { "role": "agency", "userId": "66e1…01", "agentId": null },
      "feeBefore": 3000, "feeAfter": 2500,
      "reasonBefore": "Two sacks", "reasonAfter": "Two 25 kg sacks — needs a van, not a bike",
      "version": 2, "at": "2026-10-02T09:20:00.000Z"
    }
  ],
  "lastEditedBy": { "role": "agency", "userId": "66e1…01", "agentId": null, "at": "2026-10-02T09:20:00.000Z" },
  "agencyEdited": true,
  "availableActions": ["approve", "reject"],
  "createdAt": "2026-10-02T09:00:00.000Z",
  "updatedAt": "2026-10-02T09:00:00.000Z"
}
```

- `status`: `pending | approved | rejected | withdrawn`. `withdrawn` = the proposer pulled it, or
  the system did (`withdrawalReason`: `shipment_declined` when the agency declined the shipment,
  `agent_detached` when the proposing agent left the job).
- `respondedBy.role`: `vendor | agency | agent | system`.
- `availableActions` is exactly what the API will accept from you — render the buttons from it.
- `application` (**vendor-only**, set on `approved`): what the approval did to your money —
  `{ feeAtApply, vendorAllocationBefore, vendorAllocationAfter, snapshotRewritten }`.
  `vendorAllocation*` are your held earnings for the order before/after, when the order had already
  been paid online; `null` otherwise.

## What approving does

The shipment's fee **becomes** `proposedFee`:

- **Paid online, already paid**: your order earnings were reduced by the original fee at payment.
  They are **adjusted in the same step** by `feeBefore − proposedFee` (up when the fee goes down,
  down when it goes up) — your pending balance moves and a ledger entry with reason
  `delivery_fee_adjustment` records it. Analytics and statements read the adjusted figure.
- **Cash on delivery**: nothing moves yet; when the cash is collected, the split charges the new fee.

The platform's usual **30% delivery-cost cap does not apply** to a fee you approve. The only limit is
that you must still earn more than 0 on the order (online) / that shipment (cash on delivery), after
commission, the bargain fee and any COD handling fee. It is checked when the proposal is made **and
again when you approve** — `422 DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE` if it no longer holds.

## What rejecting does

The original fee stands and pickup is unblocked. The agency may then send **one** more proposal
(max two per shipment, withdrawn ones excluded) — or **decline the shipment**, in which case you get
the usual `shipment.rejected` notification and route those items to another agency
(`PATCH /api/vendor/orders/:id/delivery-agency`).

## Errors

| Code | Status | When |
|---|---|---|
| `ORDER_NOT_FOUND` | 404 | not your order |
| `DELIVERY_FEE_PROPOSAL_NOT_FOUND` | 404 | unknown proposal, or not on this order |
| `DELIVERY_FEE_PROPOSAL_NOT_PENDING` | 409 | already answered or withdrawn (`details.status`) — reload |
| `DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH` | 409 | edited since you loaded it (`details.currentVersion`) — reload and show the new figure |
| `DELIVERY_FEE_PROPOSAL_STALE` | 409 | the shipment was picked up / left the window, or the proposing agent is no longer on it — the agency can withdraw it |
| `DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE` | 422 | approving would leave you earning ≤ 0 |
| `DELIVERY_FEE_PROPOSAL_SETTLEMENT_CONFLICT` | 409 | your order earnings were already released/reversed or changed concurrently; nothing was applied |
| `VALIDATION_ERROR` | 400 | bad ids, `note` > 500 chars, unknown body key |

## Notifications

**Sent since 2026-10-02** (this section said "not sent yet" until the notification change of the
same day). Preference key `deliveryFeeProposals` (default `true`) on
`GET/PATCH /api/vendor/notification-preferences`; every one links `orders/{orderId}`:

| `type` | When |
|---|---|
| `delivery_fee_proposal.received` | a proposal was raised (by the agency or its agent — named after the agency) |
| `delivery_fee_proposal.edited` | the pending figure or reason changed — re-read it; your approve/reject must carry the new `version` |
| `delivery_fee_proposal.withdrawn` | withdrawn by the proposer or by the system; nothing to answer |

You are not notified of your own approve/reject. Full contract:
[FRONTEND-CHANGELOG-cod-fee-notifications.md](../FRONTEND-CHANGELOG-cod-fee-notifications.md).
