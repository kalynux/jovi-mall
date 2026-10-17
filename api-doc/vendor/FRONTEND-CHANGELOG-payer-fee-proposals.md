# Vendor — FRONTEND CHANGELOG: propose your own delivery fee (2026-10-14)

**Backend:** built, not deployed. Record: [ADR-A12](../../docs/ADR-A12-PAYER-FEE-PROPOSALS.md).
**Contract:** [delivery-fee-proposals.md § Proposing a fee yourself](./delivery-fee-proposals.md#proposing-a-fee-yourself-2026-10-14).

## What changed

Until now the vendor could only approve or reject a fee the agency (or its agent) proposed. On a
parcel whose delivery **the vendor pays**, the vendor can now propose a fee — **higher or lower** — to
the agency. The agency (or its agent, if allowed) accepts or declines. Until it answers, the parcel
is not picked up. Accepted, the fee applies at once, exactly as the vendor's own approval does.

## Endpoints (new)

| Method | Path | Body |
|---|---|---|
| POST | `/api/vendor/orders/:id/shipments/:shipmentId/delivery-fee-proposals` | `{ proposedFee: int ≥ 0, reason: string 3–500 }` |
| PATCH | `/api/vendor/orders/:id/delivery-fee-proposals/:proposalId` | `{ proposedFee?, reason?, version? }` |
| POST | `/api/vendor/orders/:id/delivery-fee-proposals/:proposalId/withdraw` | — |

## Fields (additive, on every proposal)

- `proposedBy.role` gains `'vendor' | 'customer'`; `approver` gains `'agency'`; `origin` gains `'payer'`.
- `payerAcceptance: { role: 'agency' | 'agent', agentId, version, at } | null` (new).
- Your own proposal: `availableActions` `["withdraw","edit"]` while waiting. A CUSTOMER's proposal on
  a customer-paid parcel of your order is visible read-only (`availableActions: []`).

## Errors (new)

`422 DELIVERY_FEE_PROPOSAL_NOT_PAYER` (the customer pays this parcel's delivery — offer the button only
where `deliveryPayer === 'vendor'`). Also: `VENDOR_NET_NOT_POSITIVE`, `WINDOW_CLOSED`,
`ALREADY_PENDING`, `LIMIT_REACHED` (2 per parcel, yours), `NO_CHANGE`.

## Notifications (new, preference `deliveryFeeProposals`)

`delivery_fee_proposal.agency_approved` · `delivery_fee_proposal.agency_rejected` — both link `orders/{orderId}`.
