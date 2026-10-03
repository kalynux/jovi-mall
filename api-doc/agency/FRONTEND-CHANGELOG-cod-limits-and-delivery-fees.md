# Agency dashboard — COD limits, delivery-fee proposals and salaried agents

**Backend change: 2026-10-02 · Not deployed yet.** Deploy prerequisite: the index migration
`npm run migrate:delivery-fee-proposal-indexes` (the partial unique index behind "one pending fee
change per shipment"; `autoIndex` is off in production). Decision record:
[ADR-A09](../../docs/ADR-A09-COD-LIMITS-AND-DELIVERY-FEES.md).

Everything **agency-dash** has to change for the 2026-10-02 work, in one page. Self-contained; the
detailed reference pages are linked at the end of each section.

---

## ⛔ Behaviour changes on existing calls — read first

1. **`→ picked_up` can now be refused** with `409 SHIPMENT_DELIVERY_FEE_PENDING`
   (`details.proposalId`) while a delivery-fee proposal on that shipment awaits the vendor —
   on `PATCH /api/agency/shipments/:id/status` and on the agent's status endpoint alike
   (`ShipmentService`, shared core). Grey out **Picked up** when `deliveryFeeProposalPending` is true.
2. **Two notifications now REPLACE older ones**: a vendor's forced dispatch arrives as
   `shipment.cod_limit.forced` **instead of** `shipment.assigned`; an auto-assignment that failed
   because of the agents' COD amount limit arrives as `shipment.assignment.cod_limit_blocked`
   **instead of** `shipment.assignment.unfilled` (at most once per shipment). An inbox that only
   handles the old `type`s will miss these hand-offs.
3. **`PATCH /api/agency/assignment-settings` is now partial** — send `autoAssignEnabled` and/or
   `agentsCanProposeDeliveryFee`; `{}` is `400`. Old bodies still work.
4. **`POST /api/agency/shipments/:id/reject`** (decline) now also works when an agent has already
   accepted: the agent is released, a pending fee proposal is auto-withdrawn and a COD delivery code
   is cancelled. ⚠ It still works **only while `status` is `assigned`** — a `handing_over` shipment
   answers `422 SHIPMENT_REJECTION_NOT_ALLOWED` (`ShipmentService.reject`), so after a rejected fee
   proposal on a hand-over the only options are one more proposal or carrying it at the original fee.

No field was removed or renamed.

---

## 1 · Your agency's COD cash limit

An agency may hold at most **1 000 000 XAF** of COD cash that has not reached the platform, unless
an administrator pinned another amount (above or below).

`GET /api/agency/cod/limit`

```ts
{
  agencyId: string;
  limit: number;                    // the limit in force
  source: 'default' | 'override';   // 'override' = an administrator decided
  defaultLimit: number;             // 1 000 000
  exposure: {
    inFlight: number;               // COD shipments you hold (assigned → agent_delivered), cash not collected
    inFlightCount: number;
    collectedUnremitted: number;    // collected by your agents or you, not yet remitted to the platform
    collectedCount: number;
    total: number;                  // inFlight + collectedUnremitted
  };
  headroom: number;                 // max(0, limit − total)
  overLimit: boolean;               // total > limit (after a vendor force or a lowered pin)
}
```

The administrator's reason and identity are **not** shown to you. What the limit gates: **vendors'
dispatches to you**. A vendor's auto-dispatch that would push you over (or over that vendor's own
`maxCashPerAgency`) is **held** on the vendor's side, and a manual dispatch is refused unless the
vendor forces it — you do not receive those shipments until then. **Remitting cash is what frees
headroom.** The limit is **not** `policies.cod` (your own per-order cap), so changing it never pauses
connections.

UI: a gauge on the COD / cash screen — `exposure.total / limit`, the source badge, `overLimit` in
red, and "remit to free headroom". Source: `src/modules/cod/services/cod-limits.service.ts`
(`reportForAgency`). Reference: [cod-cash-management.md § GET /cod/limit](./cod-cash-management.md#get-apiagencycodlimit).

## 2 · Vendors' COD terms, on the connection screens

- `GET /api/agency/vendor-connections/browse` rows carry `codTerms: { codEnabled, maxCashPerAgency }`.
- `GET /api/agency/vendor-connections` and `/:id` carry `vendorCodTerms: { codEnabled, maxCashPerAgency } | null`.

`codEnabled: false` — that vendor's customers cannot pay cash on delivery. `maxCashPerAgency` —
the most of **that vendor's** COD cash one agency may hold un-remitted (`null` = no vendor cap).
A vendor editing these does **not** pause your connection; you are notified
(`connection.cod_terms_changed`) when you have an **active** connection.
Reference: [vendor-connections.md § Vendor COD terms](./vendor-connections.md#vendor-cod-terms-2026-10-02).

## 3 · Assign / reassign past the agent's COD amount limit — `force`

`PATCH /api/agency/shipments/:id/assign-agent` and `POST /api/agency/shipments/:id/reassign` (with a
named `agentId`) accept an optional `"force": true`.

- It waives **only** `422 COD_AGENT_EXPOSURE_EXCEEDED` (the agent's contract slice / pool, scaled by
  trust; `details: { currentExposure, additionalAmount, effectiveLimit, poolBinds, … }`).
- It **never** waives `422 AGENT_KYC_NOT_VERIFIED`, `422 COD_AGENT_TRUST_TOO_LOW` (trust too low or
  an open cash shortfall), or any non-COD rule. Do not offer **Assign anyway** for those
  (`isForceableCodRefusal`, `contract-policy.service.ts`).
- The force is persisted on the offer; offer summaries carry
  `codLimitForced: { byUserId: string | null, byRole: 'agency' | 'system' | 'admin', at: string } | null`.
  The agent's accept honours it. Auto-assign never forces.

UI: assign without `force`; on `COD_AGENT_EXPOSURE_EXCEEDED` show the numbers and offer **Assign
anyway** → resend with `force: true`. Reference: [assignment.md § Forcing](./assignment.md#forcing-a-cod-shipment-past-the-agents-cash-limit-2026-10-02).

## 4 · Delivery-fee proposals — renegotiate one shipment's fee

A shipment's fee comes from your pricing (today a flat per-shipment amount — `additional_per_kg`
and the out-of-region fields are not used by the formula). The **vendor** pays it. You may now
propose a different fee **for one shipment**, with a reason; the vendor approves or rejects every
change, up or down.

**Rules** (`src/modules/delivery-fee-proposals/domain/delivery-fee-proposal.rules.ts`):

- **Window**: shipment `status` `assigned` or `handing_over` only.
- **Pickup blocked while pending** (see ⛔ 1).
- **One pending per shipment**; at most **two non-withdrawn** per shipment (the first, and one
  more after a rejection). Withdrawn ones do not count.
- **Fee**: integer ≥ 0, minor units, different from the current fee.
- **Ceiling**: the 30% delivery-cost cap does **not** apply; the vendor must still earn **> 0**
  (whole order for online payment, this shipment for COD, after commission, bargain fee and — COD —
  your COD handling fee). Checked at propose, at edit and again at approval. The refusal carries
  **no numbers**, deliberately (they would reveal the vendor's net).
- **Your agents** may propose too — only on a shipment whose accepted offer they hold, and only
  while you have `agentsCanProposeDeliveryFee: true`. Their proposal goes **straight to the vendor**.
- You may **edit** any pending proposal on your shipment, your agent's included. An agency edit
  makes it agency-owned (`agencyEdited: true`): the agent loses its verbs on it, and it is no longer
  auto-withdrawn when that agent leaves the job.
- After a **rejection**: propose once more, or **decline** the shipment
  (`POST /api/agency/shipments/:id/reject`, `assigned` only — see ⛔ 4) — a pending proposal is then auto-withdrawn
  (`withdrawalReason: "shipment_declined"`).

| Method | Path | Body |
|---|---|---|
| `GET` | `/api/agency/assignment-settings` | — → adds `agentsCanProposeDeliveryFee: boolean` (default `false`) |
| `PATCH` | `/api/agency/assignment-settings` | `{ autoAssignEnabled?: boolean, agentsCanProposeDeliveryFee?: boolean }` (≥ 1 key) |
| `GET` | `/api/agency/shipments/:id/delivery-fee-proposals` | — (newest first) |
| `POST` | `/api/agency/shipments/:id/delivery-fee-proposals` | `{ proposedFee: integer ≥ 0, reason: string 3–500 }` → `201` |
| `PATCH` | `/api/agency/shipments/:id/delivery-fee-proposals/:proposalId` | `{ proposedFee?, reason?, version? }` (≥ 1 of fee / reason; `version` optional, must match when sent) |
| `POST` | `/api/agency/shipments/:id/delivery-fee-proposals/:proposalId/withdraw` | — |

**The proposal (agency view)** — same as the vendor's minus `application`:
`{ id, shipmentId, orderId, agencyId, proposedBy: { role, userId, agentId }, currency, feeBefore,
proposedFee, reason, status, respondedBy, rejectionNote, withdrawalReason, version, edits[],
lastEditedBy, agencyEdited, availableActions: Array<'withdraw' | 'edit'>, createdAt, updatedAt }`.
Render buttons from `availableActions` (`dto/delivery-fee-proposal.dto.ts`).

**Shipment payload additions** (every agency shipment list row, detail, status / reject response):

```ts
deliveryFeeProposalPending: boolean;
pendingDeliveryFeeProposalId: string | null;
deliveryFeeOverride: { amount: number; proposalId: string; approvedAt: string } | null;  // the approved fee
```

The shipment **detail** also carries `deliveryFeeProposals: Proposal[]`. Once approved,
`agencyEarning` already reflects the new fee.

**Errors:**

| Code | Status | `details` | UI copy |
|---|---|---|---|
| `DELIVERY_FEE_PROPOSAL_WINDOW_CLOSED` | 422 | `{ status, allowed }` | "Fees can only be changed before pickup" |
| `DELIVERY_FEE_PROPOSAL_ALREADY_PENDING` | 409 | `{ proposalId }` | "A fee change is already waiting for the vendor" |
| `DELIVERY_FEE_PROPOSAL_LIMIT_REACHED` | 422 | `{ used, max }` | hide **Propose** once two non-withdrawn exist |
| `DELIVERY_FEE_PROPOSAL_NO_CHANGE` | 422 | `{ currentFee }` (or none on an empty edit) | "That is already the fee" |
| `DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE` | 422 | none | "That fee is more than this order can carry" |
| `DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH` | 409 | `{ currentVersion }` | reload, show the current figure |
| `DELIVERY_FEE_PROPOSAL_NOT_PENDING` | 409 | `{ status }` | reload |
| `DELIVERY_FEE_PROPOSAL_NOT_YOURS` | 403 | — | (should not happen if you render from `availableActions`) |
| `DELIVERY_FEE_PROPOSAL_NOT_FOUND` | 404 | — | reload |
| `SHIPMENT_DELIVERY_FEE_PENDING` | 409 | `{ proposalId }` | "Waiting for the vendor to answer a fee change" |

Reference: [shipments.md § Delivery-fee proposals](./shipments.md#delivery-fee-proposals-2026-10-02),
cross-role [FRONTEND-CHANGELOG-delivery-fee-proposals.md](../FRONTEND-CHANGELOG-delivery-fee-proposals.md).

## 5 · A third pay model on contracts — `monthly_salary`

The contract's `fee_split.model` gains `monthly_salary` beside `percentage` and `flat`. You pay
the agent a fixed monthly salary **outside Wi-Mall**; the platform pays the agent **0 per
delivery** and you keep the **whole** delivery fee (+ COD handling fee). The platform never
schedules, tracks or pays the salary — the amount is stored only so both parties see the deal.

- Write bodies (invite / join request / counter / `PATCH …/terms` / live terms proposal):
  `{ "fee_split": { "model": "monthly_salary", "agent_monthly_salary": 150000, "currency": "XAF" } }`.
  `agent_monthly_salary`: integer ≥ 1 (minor units per month) or `null`. With a `model`, the other
  models' amount fields must be omitted or `null` (else `400`). The merged split must carry its own
  field, else `422 CONTRACT_FEE_SPLIT_INVALID` (`details: { model, hint }`).
- Read DTOs: `feeSplit.agentMonthlySalary: number | null`. Only the amount matching `model` is
  meaningful — a stale `agentSharePercent` may sit beside `monthly_salary`; ignore it.
- `agencyEarning.basis` may be `contract_salary` → `agentCut` is `0`. Label it "agent salaried",
  not "no cut configured".
- Analytics `perAgent` now includes deliveries that wrote no agent earnings row (salaried agents,
  and agents on an unconfigured 0% split) with `agentShare: 0` — they used to drop out.
- Terms-proposal `diff` may carry the path `fee_split.agent_monthly_salary` ("Monthly salary").

Reference: [FRONTEND-CHANGELOG-contract-salary.md](../FRONTEND-CHANGELOG-contract-salary.md).

## 6 · Notifications

**Two new preference keys** on `GET/PATCH /api/agency/notification-preferences`:
`preferences.codLimitUpdates`, `preferences.deliveryFeeProposals` (boolean, default `true`; a
missing key reads as `true`).

| `type` | `aggregateType` | Preference | `action.path` |
|---|---|---|---|
| `delivery_fee_proposal.approved` | `shipment` | `deliveryFeeProposals` | `shipments/{shipmentId}` |
| `delivery_fee_proposal.rejected` | `shipment` | `deliveryFeeProposals` | `shipments/{shipmentId}` |
| `delivery_fee_proposal.agent_proposed` | `shipment` | `deliveryFeeProposals` | `shipments/{shipmentId}` |
| `delivery_fee_proposal.agent_edited` | `shipment` | `deliveryFeeProposals` | `shipments/{shipmentId}` |
| `shipment.cod_limit.forced` | `shipment` | `codLimitUpdates` | `shipments/{shipmentId}` |
| `shipment.assignment.cod_limit_blocked` | `shipment` | `codLimitUpdates` | `shipments/{shipmentId}` |
| `connection.cod_terms_changed` | `connection` | `codLimitUpdates` | `vendor-connections/{connectionId}` |
| `cod.limit.pinned` | ⭐ `cod_limit` | `codLimitUpdates` | ⭐ `cod/limit` |
| `cod.limit.released` | ⭐ `cod_limit` | `codLimitUpdates` | ⭐ `cod/limit` |

- **New `aggregateType` `cod_limit`** (`aggregateId` = your agency id) — add it to any exhaustive switch.
- **New deep-link label `cod/limit`** — add a case to your translator (`dashboardRoute()`) **before**
  any generic `cod/...` handling (`cod/deposits/{id}` shares the first segment); point it at the
  screen carrying the § 1 gauge.
- `shipments/{id}` and `vendor-connections/{id}` are still on deep-links.md's "do not resolve yet"
  list and fall back to the dashboard home — `shipment.assignment.cod_limit_blocked` is only useful
  if it lands where **Assign anyway** is offered, so this is the moment to add the `shipments/:id` route.
- Copy is server-rendered (en/fr/pt/es/ar). WhatsApp templates for all nine were submitted to Meta
  on 2026-10-02 and are **pending review** (out-of-window WhatsApp fails until approved).
- You are **not** notified when your agency goes over its limit (no such situation exists — read
  `overLimit` on the gauge).

Reference: [FRONTEND-CHANGELOG-cod-fee-notifications.md § agency-dash](../FRONTEND-CHANGELOG-cod-fee-notifications.md),
[notifications.md § 2026-10-02](./notifications.md), [deep-links.md](../notifications/deep-links.md).

## Checklist

- [ ] COD limit gauge (`GET /cod/limit`) + `cod/limit` deep-link case + `cod_limit` aggregateType
- [ ] Render `codTerms` / `vendorCodTerms` on vendor browse / connections
- [ ] **Assign anyway** on `COD_AGENT_EXPOSURE_EXCEEDED` only (`force: true`)
- [ ] Settings toggle `agentsCanProposeDeliveryFee`
- [ ] Propose / edit / withdraw fee on `assigned` / `handing_over`; history; disable **Picked up** while pending; decline after rejection
- [ ] Contract forms: "Monthly salary" model + amount; `contract_salary` basis label
- [ ] Nine notification `type`s, two preference toggles; handle the two replacement situations
