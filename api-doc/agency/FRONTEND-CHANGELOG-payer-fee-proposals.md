# Agency — FRONTEND CHANGELOG: answering a fee the payer proposed (2026-10-14)

**Backend:** built, not deployed. Record: [ADR-A12](../../docs/ADR-A12-PAYER-FEE-PROPOSALS.md).
**Contract:** [shipments.md § Answering a fee the PAYER proposed](./shipments.md#answering-a-fee-the-payer-proposed-2026-10-14).

## What changed

Whoever pays a parcel's delivery — the **vendor** or the **customer** — can now propose a fee for it,
higher or lower. The agency answers: accept or decline. **Pickup is blocked until it does** (the same
`409 SHIPMENT_DELIVERY_FEE_PENDING` as for the agency's own proposals).

## Endpoints (new)

| Method | Path | Body |
|---|---|---|
| GET | `/api/agency/delivery-fee-proposals?status=pending&page=&limit=` | inbox of payer proposals |
| POST | `/api/agency/shipments/:id/delivery-fee-proposals/:proposalId/approve` | `{ version }` |
| POST | `/api/agency/shipments/:id/delivery-fee-proposals/:proposalId/reject` | `{ version, note? }` |

## Fields (additive, on every proposal)

- `proposedBy.role` gains `'vendor' | 'customer'`; `approver` gains `'agency'`; `origin` gains `'payer'`.
- `payerAcceptance: { role, agentId, version, at } | null` (new).
- On a payer proposal: `availableActions` `["approve","reject"]`; once accepted and waiting for the
  customer's payment (`topup.status: 'awaiting_payment'`): `["reject"]`. Never edit / withdraw.

Render the buttons from `availableActions` — never from `proposedBy.role`.

## Agents

Agents can answer only while `agentsCanProposeDeliveryFee` is on (the existing switch). Consider
updating the switch's label/help text: it now means "my agents may negotiate fees" (propose AND answer).

## Notifications (new, preference `deliveryFeeProposals`)

`delivery_fee_proposal.payer_proposed` · `payer_edited` · `payer_withdrawn` · `payer_paid` — all link
`shipments/{shipmentId}`.
