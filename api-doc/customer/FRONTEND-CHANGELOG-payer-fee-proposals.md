# Customer — FRONTEND CHANGELOG: propose your own delivery fee (2026-10-14)

**Backend:** built, not deployed. Record: [ADR-A12](../../docs/ADR-A12-PAYER-FEE-PROPOSALS.md).
**Contract:** [delivery-fee-changes.md § Propose your own delivery fee](./delivery-fee-changes.md#propose-your-own-delivery-fee-2026-10-14).

## What changed

On a parcel whose delivery **the customer pays** (`deliveryPayer: 'customer'` on the shipment), the
customer can now propose a different delivery fee — **higher or lower** — to the delivery company.
The company accepts or declines. Until it answers, the parcel is not picked up.

## Endpoints (new)

| Method | Path | Body |
|---|---|---|
| POST | `/api/customer/orders/:id/shipments/:shipmentId/delivery-fee-proposals` | `{ proposedFee: int ≥ 0, reason: string 3–500 }` |
| PATCH | `/api/customer/orders/:id/delivery-fee-proposals/:proposalId` | `{ proposedFee?, reason?, version? }` |
| POST | `/api/customer/orders/:id/delivery-fee-proposals/:proposalId/withdraw` | — |

The existing `…/pay` route pays the difference once the company accepted a higher fee on an online order.

## Fields (additive, on `proposals[]` of `GET /api/customer/orders/:id/delivery-fee-proposals`)

- `raisedBy` gains `'you'`; `origin` gains `'payer'`.
- `acceptedByDeliveryCompany: boolean` (new).
- `availableActions` on your own proposal: `["withdraw","edit"]` while waiting; `["pay","reject"]`
  once accepted with a difference to pay (reject = take it back).

## Errors (new)

`422 DELIVERY_FEE_PROPOSAL_NOT_PAYER` (the shop pays this parcel's delivery — hide the button where
`deliveryPayer !== 'customer'`). Existing ones apply: `WINDOW_CLOSED`, `ALREADY_PENDING`,
`LIMIT_REACHED` (2 per parcel), `NO_CHANGE`, `ORDER_NOT_PAID`, `TOPUP_IN_PROGRESS`.

## Notification (new, cannot be muted)

`order.delivery_fee.proposal_declined` — the company declined your figure; the fee stays. An accepted
figure arrives as the existing `lowered` / `updated` / `topup_due`.

## Chat

The WhatsApp / Telegram assistant gains `delivery_fees_propose` and `delivery_fees_withdraw`
(`api-doc/n8n/bot-surface.md`). Nothing to build in a web client for that.
