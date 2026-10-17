# Agent — FRONTEND CHANGELOG: answering a fee the payer proposed (2026-10-14)

**Backend:** built, not deployed. Record: [ADR-A12](../../docs/ADR-A12-PAYER-FEE-PROPOSALS.md).
**Contract:** [shipments.md § Delivery-fee proposals](./shipments.md) — the paragraph "Answering a fee the PAYER proposed".

## What changed

The vendor or the customer — whoever pays the delivery — can now propose a fee on a shipment the
agent holds. The agency answers, and **the agent can too while the agency's
`agentsCanProposeDeliveryFee` is on**. The agent cannot mark the shipment `picked_up` until it is
answered (`409 SHIPMENT_DELIVERY_FEE_PENDING`).

## Endpoints (new)

| Method | Path | Body |
|---|---|---|
| POST | `/api/agent/shipments/:id/delivery-fee-proposals/:proposalId/approve` | `{ version }` |
| POST | `/api/agent/shipments/:id/delivery-fee-proposals/:proposalId/reject` | `{ version, note? }` |

`403 DELIVERY_FEE_PROPOSAL_AGENTS_NOT_ALLOWED` when the agency has agents switched off.

## Fields

`proposedBy.role` gains `'vendor' | 'customer'`, `approver` gains `'agency'`, `origin` gains `'payer'`,
`payerAcceptance` is new. Show Accept / Decline only when `availableActions` contains them.

## Notification (new)

`delivery_fee_proposal.payer_proposed` — links `shipments/{shipmentId}`; sent only while the agent may answer.
