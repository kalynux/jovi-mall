# Agent app — COD pool, forced offers, delivery-fee proposals and salaried contracts

**Backend change: 2026-10-02 · Not deployed yet.** Deploy prerequisite: the index migration
`npm run migrate:delivery-fee-proposal-indexes` (one pending fee change per shipment;
`autoIndex` is off in production). Decision record:
[ADR-A09](../../docs/ADR-A09-COD-LIMITS-AND-DELIVERY-FEES.md).

Everything **agent_app** (Flutter) has to change for the 2026-10-02 work. Self-contained; detailed
references are linked at the end of each section.

---

## ⛔ Read first

1. **`pool.source` has a new value, `"default"`, which replaces `"plan"`**, and `pool.planCode` is
   always `null` (deprecated). If your Dart enum for `pool.source` is closed
   (`not_verified | override | plan`), parsing breaks — add `default`, and keep accepting `plan`
   (an agent not yet re-synced may still read it; render it like `default`).
2. **`POST /api/agent/shipments/:id/status` → `picked_up` can now be refused** with
   `409 SHIPMENT_DELIVERY_FEE_PENDING` (`details.proposalId`) while a delivery-fee proposal on that
   shipment awaits the vendor (yours or your agency's).
3. **`earning.basis` has a new value, `"contract_salary"`**, with `earning.amount` always `0` — and a
   new `earning.salary` object. A closed enum breaks; a bare "0 XAF earned" is wrong copy.
4. **Remove "upgrade your plan to carry more cash"** everywhere. The plan no longer sets the pool;
   plan cards must stop advertising `max_cod_pool`.

---

## 1 · The COD pool is 500 000 for every verified agent

| Before (2026-09-21) | Now |
|---|---|
| verified → your plan's `max_cod_pool` (Free 500 000 · Plus 1 000 000 · Pro 2 000 000) | verified → **500 000**, whatever your plan |
| `pool.source: "plan"`, `pool.planCode: "agent_plus"` | `pool.source: "default"`, `pool.planCode: null` |
| changing plan reset the pool | plan changes do nothing to the pool |

Unchanged: not verified → `0` (`source: "not_verified"`); an administrator's pin
(`source: "override"`) outranks the default up or down and never outranks KYC; you may still carry
**less** (`PUT /api/agent/cod/pool`). Read on `GET /api/agent/cod/allocation` → `pool`
(`src/modules/agents/domain/services/agent-cod-pool.ts`: `COD_POOL_DEFAULT = 500 000`).
`max_cod_pool` stays on plan objects but is **dormant** — do not show it as a benefit.

Reference: [cod-cash.md § GET /cod/allocation](./cod-cash.md#get-apiagentcodallocation),
cross-role [FRONTEND-CHANGELOG-cod-limits.md § 1](../FRONTEND-CHANGELOG-cod-limits.md).

## 2 · Offers your agency forced past your COD amount limit

Your agency may now assign / reassign a COD shipment to you with `force: true` when the **only**
refusal was your cash **amount** limit (`COD_AGENT_EXPOSURE_EXCEEDED`). It can never force past an
unverified identity, a trust score too low, or an open cash shortfall.

- Offer rows (`GET /api/agent/offers`) and offer summaries carry
  `codLimitForced: { byUserId: string | null, byRole: 'agency' | 'system' | 'admin', at: string } | null`.
  Informational — show a small "sent above your COD limit" note.
- Your **accept** of a forced offer honours the force (you are not refused on the amount).
- The `shipment.offer.received` notification's `message` may end with an extra sentence saying so.
  Nothing to build; it is server-rendered.

## 3 · Delivery-fee proposals — ask for a different fee on a job you hold

The vendor pays each shipment's delivery fee. Your agency may now let **you** propose a different
fee for **one shipment you hold the accepted offer for**, with a reason. The vendor approves or
rejects it. Your agency sees it and may **edit** it.

**When the button may show:** shipment `status` `assigned` or `handing_over`, you are its agent,
and `deliveryFeeProposalPending` is `false`. There is **no agent-side read of the agency setting**:
either hide the action after a `403 DELIVERY_FEE_PROPOSAL_AGENTS_NOT_ALLOWED`, or show it with that
message. The `fee_proposals.enabled` / `.disabled` notifications (§ 5) tell you when it changes.

| Method | Path | Body |
|---|---|---|
| `GET` | `/api/agent/shipments/:id/delivery-fee-proposals` | — (newest first) |
| `POST` | `/api/agent/shipments/:id/delivery-fee-proposals` | `{ proposedFee: integer ≥ 0, reason: string 3–500 }` → `201` |
| `PATCH` | `/api/agent/shipments/:id/delivery-fee-proposals/:proposalId` | `{ proposedFee?, reason?, version? }` (≥ 1 of fee / reason) |
| `POST` | `/api/agent/shipments/:id/delivery-fee-proposals/:proposalId/withdraw` | — |

**Rules:** one pending per shipment; at most two non-withdrawn per shipment; the fee must differ from
the current one; the vendor must still earn more than 0 (refusal carries no numbers); the 30%
delivery-cost cap does not apply. You may **edit / withdraw your own** proposal until your agency
edits it (`agencyEdited: true` — then it is the agency's and you have no verbs on it). If you cancel
the job (`POST /api/agent/shipments/:id/cancel`) or are reassigned away, your pending proposal is
withdrawn automatically (`withdrawalReason: "agent_detached"`) — unless the agency had edited it.

**The proposal (agent view):** `{ id, shipmentId, orderId, agencyId, proposedBy: { role, userId,
agentId }, currency, feeBefore, proposedFee, reason, status: 'pending'|'approved'|'rejected'|'withdrawn',
respondedBy, rejectionNote, withdrawalReason, version, edits[], lastEditedBy, agencyEdited,
availableActions: Array<'withdraw' | 'edit'>, createdAt, updatedAt }` (no `application` — that is the
vendor's money). Render buttons from `availableActions`.

⚠ **One known mismatch:** on shipment reads (`GET /api/agent/shipments/:id`, the `…/delivery-fee-proposals`
list) your own pending proposal lists `edit` **even after your agency switched the setting off** —
those reads do not look the setting up (`DeliveryFeeProposalService.listForShipment` /
`mapForShipments`), while the `PATCH` does and answers `403 DELIVERY_FEE_PROPOSAL_AGENTS_NOT_ALLOWED`.
Handle that 403 on **Edit** by hiding the button; **Withdraw** keeps working.

**Payload additions** — shipment list rows, detail, status responses **and offer rows**:

```dart
bool deliveryFeeProposalPending;
String? pendingDeliveryFeeProposalId;
DeliveryFeeOverride? deliveryFeeOverride;   // { int amount; String proposalId; DateTime approvedAt }
```

The shipment detail also carries `deliveryFeeProposals: List<Proposal>`. Once a fee is approved,
`earning` is cut from it (`earning.deliveryFee` shows the approved fee).

**Errors:**

| Code | Status | `details` | Copy |
|---|---|---|---|
| `DELIVERY_FEE_PROPOSAL_AGENTS_NOT_ALLOWED` | 403 | — | "Your agency hasn't enabled fee proposals" |
| `SHIPMENT_NOT_FOUND` | 404 | — | you are not the agent holding this job's accepted offer |
| `DELIVERY_FEE_PROPOSAL_WINDOW_CLOSED` | 422 | `{ status, allowed }` | "Fees can only be changed before pickup" |
| `DELIVERY_FEE_PROPOSAL_ALREADY_PENDING` | 409 | `{ proposalId }` | "A fee change is already waiting for the vendor" |
| `DELIVERY_FEE_PROPOSAL_LIMIT_REACHED` | 422 | `{ used, max }` | hide **Propose** |
| `DELIVERY_FEE_PROPOSAL_NO_CHANGE` | 422 | `{ currentFee }` or none | "That is already the fee" |
| `DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE` | 422 | none | "That fee is more than this order can carry" |
| `DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH` | 409 | `{ currentVersion }` | reload |
| `DELIVERY_FEE_PROPOSAL_NOT_PENDING` | 409 | `{ status }` | reload |
| `DELIVERY_FEE_PROPOSAL_NOT_YOURS` | 403 | — | hide the button |
| `SHIPMENT_DELIVERY_FEE_PENDING` | 409 | `{ proposalId }` | on **Picked up**: "Waiting for the vendor to answer a fee change" |

Reference: [shipments.md § Delivery-fee proposals](./shipments.md#delivery-fee-proposals-2026-10-02),
cross-role [FRONTEND-CHANGELOG-delivery-fee-proposals.md](../FRONTEND-CHANGELOG-delivery-fee-proposals.md).

## 4 · Salaried contracts — `monthly_salary`

A contract's pay model may now be `monthly_salary`: your agency pays you a fixed monthly salary
**outside Wi-Mall**; the platform pays you **0 per delivery** for that agency's jobs, and nothing on
the platform schedules, tracks or pays the salary. You may propose it too.

- Terms bodies (join request, counter, live terms proposal):
  `{ "fee_split": { "model": "monthly_salary", "agent_monthly_salary": 150000, "currency": "XAF" } }`
  — integer ≥ 1 (minor units **per month**). With a `model`, the other models' amounts must be
  omitted or `null` (else `400`); a split missing its own amount is `422 CONTRACT_FEE_SPLIT_INVALID`.
- Contract reads: `feeSplit.agentMonthlySalary: int?`. Only the amount matching `model` is meaningful.
- Offer / shipment `earning`:

  ```json
  { "amount": 0, "currency": "XAF", "estimated": true, "deliveryFee": 2000,
    "basis": "contract_salary",
    "salary": { "monthlyAmount": 150000, "currency": "XAF", "paidBy": "agency_off_platform" } }
  ```

  `salary` is `null` under the other bases. Copy: "Covered by your monthly salary from <agency>
  (150 000 XAF / month, paid by the agency)", never a bare "0 XAF".
- Earnings balance and payouts: unchanged — salaried runs add nothing, by design. Analytics count
  them in `deliveries` with `0` earned.

Reference: [FRONTEND-CHANGELOG-contract-salary.md](../FRONTEND-CHANGELOG-contract-salary.md).

## 5 · Notifications

**Two new preference keys** on `GET/PATCH /api/agent/notification-preferences`:
`preferences.codLimitUpdates`, `preferences.deliveryFeeProposals` (bool, default `true`; missing = `true`).

| `type` | `aggregateType` | Preference | `action.path` | Sent when |
|---|---|---|---|---|
| `delivery_fee_proposal.approved` | `shipment` | `deliveryFeeProposals` | ⭐ `shipments/{shipmentId}` | the vendor approved **your** proposal |
| `delivery_fee_proposal.rejected` | `shipment` | `deliveryFeeProposals` | ⭐ `shipments/{shipmentId}` | the vendor rejected **your** proposal |
| `delivery_fee_proposal.edited` | `shipment` | `deliveryFeeProposals` | ⭐ `shipments/{shipmentId}` | **your agency** edited your proposal |
| `delivery_fee_proposal.withdrawn` | `shipment` | `deliveryFeeProposals` | **none** (`action: null`) | the **system** withdrew yours (declined / you left the job) |
| `fee_proposals.enabled` | `contract` | `deliveryFeeProposals` | `memberships/{contractId}` | your agency allowed agents to propose |
| `fee_proposals.disabled` | `contract` | `deliveryFeeProposals` | `memberships/{contractId}` | your agency switched it off |
| `cod.pool.pinned` | ⭐ `cod_pool` | `codLimitUpdates` | ⭐ `cod` | an administrator pinned your pool |
| `cod.pool.released` | ⭐ `cod_pool` | `codLimitUpdates` | ⭐ `cod` | the pin was released (back to the default) |

(`src/modules/notifications/agent-notification-event-consumer.ts`; the pool pair ignores every
non-administrator change, including the mass reset to the default.)

**Two new deep-link labels** — add arms to `resolveDeepLink` (`lib/core/router/deep_links.dart`),
its doc table and `test/core/router/deep_links_test.dart`:

```dart
['shipments', final id] => DeepLinkTarget(AppRoutePaths.shipmentDetail(id), isFullScreen: false),
['cod']                 => const DeepLinkTarget(AppRoutePaths.cod, isFullScreen: false),
```

Keep `['cod', 'deposits', id]` as its own arm. **New `aggregateType` `cod_pool`** (`aggregateId` =
your agent id). `delivery_fee_proposal.withdrawn` has no button on purpose (the shipment has left you
and its detail would 404) — your null-to-inbox fallback is correct. WhatsApp templates for all eight
were submitted to Meta on 2026-10-02 and are pending review. ⚠ Still outstanding from 2026-09-16:
the `earnings` label has no arm either; and emailed buttons cannot open the app at all until App
Links / a custom scheme exist (deep-links.md § Emailed buttons).

Reference: [FRONTEND-CHANGELOG-cod-fee-notifications.md § agent_app](../FRONTEND-CHANGELOG-cod-fee-notifications.md),
[notifications.md § 2026-10-02](./notifications.md), [deep-links.md](../notifications/deep-links.md).

## Checklist

- [ ] `pool.source` accepts `default` (and still `plan`); drop "upgrade your plan" copy; hide `max_cod_pool` as a benefit
- [ ] `codLimitForced` note on offers
- [ ] Propose / edit / withdraw fee on held jobs; disable **Picked up** while pending; handle the 403 on Edit
- [ ] `earning.basis == contract_salary` + `earning.salary`; salary model in contract forms
- [ ] Eight notification `type`s; `shipments/{id}` and `cod` deep-link arms; `cod_pool` aggregateType; two toggles
