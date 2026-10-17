# ADR-A12 — The payer proposes a delivery fee; the agency answers

**Date:** 2026-10-14
**Status:** Accepted — decided by the product owner; built, uncommitted, not deployed.
**Scope:** jovi-mall (+ two comment/doc lines in wi-admin, which reads `delivery_fee_proposals`
directly and passes the new values through as strings). **No geo-tracker change.**
**Amends:** [ADR-A09](./ADR-A09-COD-LIMITS-AND-DELIVERY-FEES.md) D-6 (only the agency side
proposed) and [ADR-A11](./ADR-A11-CUSTOMER-PAID-DELIVERY.md) § Fee changes after checkout (the
customer could only answer, or ask for a combined price).

**Code:** `src/modules/delivery-fee-proposals/` — rules `domain/delivery-fee-proposal.rules.ts`
(`checkPayerProposer`, `proposalSideOf`, the payer branch of `resolveAvailableActions`), service
`DeliveryFeeProposalService.{proposeAsPayer, editAsPayer, withdrawAsPayer, answerPayerProposal,
closePayerProposal, listForAgency}`. Chat: `bot-surface` tools `delivery_fees_propose`,
`delivery_fees_withdraw`. **Tests:** `npm run test:delivery-fee-proposals` § 14 (42 assertions).

## Context

Until this record a delivery fee could be renegotiated after checkout in ONE direction only: the
agency (or its agent, when the agency allows) proposed, and whoever paid the delivery — the vendor
(ADR-A09) or the customer (ADR-A11) — accepted or declined. The payer could not name a figure of
their own. A customer's only lever was the combined-price request (≥ 2 parcels, lower only). The
owner reported this as a defect: the customer must be able to propose to the agency, as the
vendor must.

⚠ The owner's request assumed the vendor could already propose. **It could not** — that was
verified in code before building and confirmed with the owner, who chose to add it for vendors
too (decision P-1 below).

## Decisions (owner, 2026-10-14)

| # | Decision |
|---|---|
| **P-1** | **Both payers propose.** The VENDOR on a vendor-paid parcel, the CUSTOMER on a customer-paid one. Never the other way round (`422 DELIVERY_FEE_PROPOSAL_NOT_PAYER`). |
| **P-2** | **Pickup waits** for the agency's answer — the same pointer (`pending_delivery_fee_proposal_id`) that blocks pickup during an agency proposal. |
| **P-3** | **Higher or lower.** The payer may offer more as well as less. |
| **P-4** | **Customers propose in the storefront AND in the chat.** |
| P-5 *(default, not asked)* | The **agency** answers; the **agent** holding the parcel answers too while the agency's existing `agents_can_propose_delivery_fee` switch is on — one switch for "my agents negotiate fees". |
| P-6 *(default, not asked)* | Each SIDE has its own two-proposal cap (`MAX_NON_WITHDRAWN_PROPOSALS`): payer (vendor/customer) and agency (agency/agent/combined answer). Shared, a payer's two declined offers would spend the agency's right to re-propose. |

## The row

`proposed_by_role: 'vendor' | 'customer'`, `approver: 'agency'`, `origin: 'payer'`; a customer's
row carries `customer_id` (the customer reads are scoped by it), a vendor's carries none.
`payer_acceptance { role, user_id, agent_id, version, at }` records the agency side's yes.

## Who may do what (`resolveAvailableActions`, one table for the API and the screens)

| Viewer | Unanswered | Accepted, awaiting the customer's top-up |
|---|---|---|
| the proposing payer | withdraw · edit | pay · reject (= take it back, recorded `withdrawn`) |
| the agency | approve · reject | reject (it may not wait forever) |
| the agent on the parcel | approve · reject — only while agents may propose | reject |
| anyone else | — | — |

Every answer carries the `version` the answerer saw (`409 DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH`).

## What accepting does to the money — existing paths only, nothing new

| Parcel | Accepted figure | Path |
|---|---|---|
| vendor-paid | any | `applyVendorPaidApproval` — **the same transaction the vendor's own approval runs** (override, snapshot / held vendor allocation re-priced in place, vendor net re-checked > 0) |
| customer-paid | lower | `planDecrease` → `applyInSession` (online: the excess is refunded; COD / cash for delivery: less cash) |
| customer-paid | higher, COD / cash for delivery | `planCustomerApprovedIncrease`, applied now (more cash at the door) |
| customer-paid | higher, online | the figure freezes (`payer_acceptance` + `customer_approval` + `topup.awaiting_payment`); the existing top-up payment applies it and unblocks pickup (`DeliveryFeeTopupService`, unchanged) |

Declining, withdrawing and the payer's "no longer want to pay" all close the row and release the
pointer: the fee stays, pickup unblocks.

## Notifications (8 new situations, 8 WhatsApp templates GENERATED, NOT SUBMITTED)

agency `payer_proposed` · `payer_edited` · `payer_withdrawn` · `payer_paid`; agent `payer_proposed`
(only to the agent on the parcel, only while agents may answer); vendor `agency_approved` ·
`agency_rejected`; customer `order.delivery_fee.proposal_declined`. An accepted customer proposal
reuses `lowered` / `updated` / `topup_due`, which describe the result.

## Consequences

- **A payer can hold a parcel's pickup until the agency answers** (P-2, chosen knowingly). The
  agency unblocks it with one tap (decline). The two-per-side cap bounds how often.
- **Index:** `delivery_fee_proposal_agency_inbox` — added to `migrate:delivery-fee-proposal-indexes`,
  which therefore reads `applied-but-changed` where it already ran; re-run it (idempotent).
- **wi-admin** shows the new values unchanged (it reads strings); it still has no fee-proposal
  surface of its own (ADR-A09 G-11).
- **The n8n tool nodes were NOT regenerated** — `gen-mcp-workflow` needs the live `wi-mall-core`
  workflow and n8n was unreachable. The two chat tools exist on the backend and in `catalog.json`;
  the customer agent cannot call them until the nodes are generated and published.
