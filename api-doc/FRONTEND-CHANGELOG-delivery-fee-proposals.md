# FRONTEND-CHANGELOG — per-shipment delivery-fee proposals (2026-10-02)

**Backend: jovi-mall, `src/modules/delivery-fee-proposals/`.** Additive — no existing field was
removed or renamed. One existing request changed shape (assignment settings PATCH, now partial;
old bodies still work). One existing transition can now be refused (`→ picked_up`).

## What it is, in one paragraph

Each shipment's delivery fee comes from the agency's pricing — **today a flat amount per
shipment** (`pickup_based.base_rate_first_kg`, and/or `storage_based.local_delivery_fee +
pick_pack_fee_per_order`; ⚠ `additional_per_kg` and the out-of-region fields are **not used by
the formula yet** — don't show them as if they priced anything). The **vendor** pays it out of
their net. Now the **agency** can propose a different fee for one specific shipment, and so can
the **agent** holding its accepted offer **if** the agency enabled it. The **vendor** approves or
rejects every change (up or down). Proposals are allowed only **before pickup** (shipment
`assigned` or `handing_over`), and **while one is pending the shipment cannot be picked up**.
One pending per shipment; at most **two** non-withdrawn per shipment (so one retry after a
rejection). The 30% delivery-cost cap does **not** apply; the only ceiling is that the vendor
must still earn more than 0. After a rejection the agency may also **decline** the shipment
(existing reject endpoint, now documented as working even with an agent already accepted).

## Shared shapes (all three dashboards)

**Proposal** (`DeliveryFeeProposalDto`):

```ts
{
  id: string; shipmentId: string; orderId: string; agencyId: string;
  proposedBy: { role: 'agency' | 'agent'; userId: string | null; agentId: string | null };
  currency: string;            // e.g. "XAF"
  feeBefore: number;           // minor units
  proposedFee: number;         // minor units, integer ≥ 0
  reason: string;              // required, 3–500 chars
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  respondedBy: { role: 'vendor' | 'agency' | 'agent' | 'system'; userId: string | null; at: string } | null;
  rejectionNote: string | null;     // the vendor's optional note
  withdrawalReason: string | null;  // 'shipment_declined' | 'agent_detached' when role is 'system'
  application?: {                   // VENDOR view only, set on 'approved'
    feeAtApply: number;
    vendorAllocationBefore: number | null;
    vendorAllocationAfter: number | null;
    snapshotRewritten: boolean;
  } | null;
  availableActions: Array<'approve' | 'reject' | 'withdraw'>;  // render buttons from THIS
  createdAt: string; updatedAt: string;
}
```

**Shipment payload additions** — on every agency/agent shipment list row, detail, status /
reject responses, and on agent **offer** rows:

```ts
deliveryFeeProposalPending: boolean;
pendingDeliveryFeeProposalId: string | null;
deliveryFeeOverride: { amount: number; proposalId: string; approvedAt: string } | null;
```

The agency and agent shipment **detail** also gains `deliveryFeeProposals: Proposal[]` (newest first).

**Errors** (full table in `api-doc/errors/README.md` § Delivery-fee proposals):
`DELIVERY_FEE_PROPOSAL_{NOT_FOUND 404, ALREADY_PENDING 409, NOT_PENDING 409, WINDOW_CLOSED 422,
AGENTS_NOT_ALLOWED 403, LIMIT_REACHED 422, NO_CHANGE 422, VENDOR_NET_NOT_POSITIVE 422,
NOT_YOURS 403, STALE 409, SETTLEMENT_CONFLICT 409}` and `SHIPMENT_DELIVERY_FEE_PENDING 409`.

## Agency dashboard (agency-dash)

1. **Assignment settings** — `GET/PATCH /api/agency/assignment-settings` now carry
   `agentsCanProposeDeliveryFee: boolean` (default `false`) beside `autoAssignEnabled`. PATCH is
   **partial**: send either or both; `{}` → 400. Add a toggle: *"Let my agents propose a delivery
   fee for a job they accepted (the vendor still approves)"*.
2. **Shipment detail / dispatch board** — when `status` is `assigned` or `handing_over`, offer
   **"Propose a different fee"**: `POST /api/agency/shipments/:id/delivery-fee-proposals`
   `{ proposedFee, reason }`. Show `feeBefore` (the current fee — `agencyEarning.earnedFee` on the
   list is the closest existing figure) and validate an integer ≥ 0 that differs from it.
3. **Pending state** — when `deliveryFeeProposalPending` is true: badge *"Fee change awaiting
   vendor"*, **disable "Picked up"** (the API answers `409 SHIPMENT_DELIVERY_FEE_PENDING`), offer
   **Withdraw** (`POST …/delivery-fee-proposals/:proposalId/withdraw`).
4. **History** — render `deliveryFeeProposals` on the detail (who, before → proposed, reason,
   outcome, vendor's `rejectionNote`).
5. **After a rejection** — two choices: send **one** more proposal (the button disappears once
   two non-withdrawn exist — `422 DELIVERY_FEE_PROPOSAL_LIMIT_REACHED`), or **Decline the
   shipment** (existing `POST /api/agency/shipments/:id/reject`), which now works even when an
   agent has already accepted (the agent is released; a COD delivery code is cancelled). ⚠ Only while
   the shipment is `assigned`: `ShipmentService.reject` refuses `handing_over` with
   `422 SHIPMENT_REJECTION_NOT_ALLOWED`, so a hand-over cannot be declined after a rejection.
6. **Approved** — `deliveryFeeOverride.amount` is the fee; `agencyEarning` already reflects it.
7. Error copy: `VENDOR_NET_NOT_POSITIVE` → *"That fee is more than this order can carry"* (no
   numbers are returned, deliberately); `WINDOW_CLOSED` → *"Fees can only be changed before
   pickup"*; `ALREADY_PENDING` → *"A fee change is already waiting for the vendor"*.

## Agent app (agent_app)

1. On a shipment the agent holds (status `assigned` / `handing_over`), show **"Propose a
   different fee"** → `POST /api/agent/shipments/:id/delivery-fee-proposals`
   `{ proposedFee, reason }`. If the agency has not enabled it the API answers
   `403 DELIVERY_FEE_PROPOSAL_AGENTS_NOT_ALLOWED` — there is no agent-side read of the setting,
   so either hide the action after that answer or show it with that message.
2. When `deliveryFeeProposalPending` is true, **disable "Picked up"** and say *"Waiting for the
   vendor to answer a fee change"* (API: `409 SHIPMENT_DELIVERY_FEE_PENDING`). Pickup unblocks
   when the vendor answers or the proposal is withdrawn.
3. Withdraw **your own** proposal: `POST …/delivery-fee-proposals/:proposalId/withdraw`
   (`availableActions` includes `withdraw` only on yours).
4. Offer rows (`GET /api/agent/offers`) carry the same three summary fields; `earning` is cut
   from the approved fee once `deliveryFeeOverride` is set (`earning.deliveryFee` shows it).
5. If you cancel the job, or are reassigned away, your pending proposal is withdrawn
   automatically (`withdrawalReason: "agent_detached"`).

## Vendor dashboard (vendor-dash)

1. **Inbox** — `GET /api/vendor/delivery-fee-proposals?status=pending` (paginated, `meta.totalPages`).
   A badge count on Orders is worth it: **a pending proposal blocks that parcel's pickup**.
2. **Order detail** — `GET /api/vendor/orders/:id` now carries `deliveryFeeProposals[]`
   (also `GET /api/vendor/orders/:id/delivery-fee-proposals`). For each pending one show who
   proposed (agency / agent), `feeBefore → proposedFee`, the `reason`, and **Approve / Reject**.
3. **Approve** — `POST /api/vendor/orders/:id/delivery-fee-proposals/:proposalId/approve`.
   Explain the effect before confirming: *"Your earnings on this order change by
   {feeBefore − proposedFee}"*. For an order paid online, the held earnings move immediately
   (`application.vendorAllocationBefore → vendorAllocationAfter`, ledger reason
   `delivery_fee_adjustment`); for cash on delivery the new fee is charged when the cash is collected.
4. **Reject** — `POST …/reject` `{ note? }` (≤ 500). The original fee stands; the agency may
   send one more proposal or decline the shipment (you'd then get the existing
   `shipment.rejected` notification and re-route via `PATCH /api/vendor/orders/:id/delivery-agency`).
5. Errors to handle: `NOT_PENDING` / `STALE` → reload the order; `VENDOR_NET_NOT_POSITIVE` →
   *"Approving this would leave you earning nothing on this order"*; `SETTLEMENT_CONFLICT` →
   *"Your earnings for this order can no longer be adjusted"*.

## Update (same day) — EDIT a pending proposal, and the vendor answers a VERSION

**Breaking for vendor-dash only:** approve and reject now **require** the `version` you displayed.

- **Rule recap (owner):** an agent's proposal (when the agency allows it) goes **straight to the
  vendor**; the agency sees it on the shipment and may **edit** it; a shipment has **one** pending
  request at a time.
- **New routes:** `PATCH /api/agency/shipments/:id/delivery-fee-proposals/:proposalId` and
  `PATCH /api/agent/shipments/:id/delivery-fee-proposals/:proposalId`, body
  `{ proposedFee?, reason?, version? }` (at least one of fee / reason). Same window, same
  vendor-net ceiling, still `pending`, **same document** (no extra count toward the max-2).
- **Who:** the agency — any pending proposal on its shipment, its agent's included. The proposing
  agent — their own, only while `agentsCanProposeDeliveryFee` is on and until the agency has
  edited it. **An agency edit makes the proposal agency-owned** (`agencyEdited: true`): the agent
  then has no verbs on it, and it is NOT auto-withdrawn when the agent is reassigned away.
- **New proposal fields:** `version` (starts at 1, +1 per edit), `edits[]` (`{ editedBy: { role,
  userId, agentId }, feeBefore, feeAfter, reasonBefore, reasonAfter, version, at }`, oldest first),
  `lastEditedBy` (`{ role, userId, agentId, at }` | null), `agencyEdited`. `availableActions` may
  now include `edit`.
- **New error:** `409 DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH` (`details.currentVersion`).
- **agency-dash:** an **Edit** action (when `availableActions` has `edit`) on pending proposals,
  including the agent's; show the `edits[]` trail.
- **agent_app:** an **Edit** action on your own pending proposal while `availableActions` has it.
- **vendor-dash:** send `{ "version": proposal.version }` on approve and `{ "version", "note"? }`
  on reject. On `VERSION_MISMATCH`, reload the order/inbox and show the new fee before letting the
  vendor answer again. Showing the `edits[]` trail ("changed from 3 000 to 2 500 by the agency")
  is recommended.
- **Event:** `delivery_fee_proposal.edited` is published (payload adds `version`, `previousFee`,
  `reasonChanged`, `editedByRole`, `editedByAgentId`); notifications are being wired separately.

## Not in this change

> ⚠ **The first bullet below is SUPERSEDED (same day).** Notifications were built after this page
> was written: vendor `delivery_fee_proposal.{received,edited,withdrawn}`, agency
> `delivery_fee_proposal.{approved,rejected,agent_proposed,agent_edited}`, agent
> `delivery_fee_proposal.{approved,rejected,edited,withdrawn}` + `fee_proposals.{enabled,disabled}`,
> preference key `deliveryFeeProposals`. Contract:
> [FRONTEND-CHANGELOG-cod-fee-notifications.md](./FRONTEND-CHANGELOG-cod-fee-notifications.md).
> Kept as written for the record.

- **No notifications** *(superseded — see above)*. Proposal created / approved / rejected are published as in-process
  events (`delivery_fee_proposal.created|approved|rejected|withdrawn`) but no push / WhatsApp /
  email situation is wired — each would need five-language copy per stack and, for WhatsApp, a
  Meta-approved template. Poll (inbox, order detail, shipment detail) for now.
- **No admin (wi-admin) surface.** wi-admin's shipment DTO keeps reading `delivery_fee_snapshot`,
  which stays "the fee actually charged" (it is rewritten on an approval for an already-paid
  online order).
