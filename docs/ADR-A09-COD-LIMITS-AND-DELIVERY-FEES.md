# ADR-A09 — COD cash limits at three levels, per-shipment delivery-fee proposals, salaried agents

**Date:** 2026-10-02
**Status:** Accepted — decided by the product owner on 2026-10-02 and implemented the same day.
**Not deployed** at the time of writing (uncommitted in the working tree).
**Scope:** jovi-mall and wi-admin. No geo-tracker change, no outbox event shape, no webhook body.
**Contracts (frontend):** [`api-doc/FRONTEND-CHANGELOG-cod-limits.md`](../api-doc/FRONTEND-CHANGELOG-cod-limits.md) ·
[`…-delivery-fee-proposals.md`](../api-doc/FRONTEND-CHANGELOG-delivery-fee-proposals.md) ·
[`…-contract-salary.md`](../api-doc/FRONTEND-CHANGELOG-contract-salary.md) ·
[`…-cod-fee-notifications.md`](../api-doc/FRONTEND-CHANGELOG-cod-fee-notifications.md); one page
per app: [vendor](../api-doc/vendor/FRONTEND-CHANGELOG-cod-limits-and-delivery-fees.md) ·
[agency](../api-doc/agency/FRONTEND-CHANGELOG-cod-limits-and-delivery-fees.md) ·
[agent](../api-doc/agent/FRONTEND-CHANGELOG-cod-limits-and-delivery-fees.md) ·
[customer](../api-doc/customer/FRONTEND-CHANGELOG-cod-limits-and-delivery-fees.md) ·
[admin dashboard](../../admin/api-doc/FRONTEND-CHANGELOG-cod-limits.md).
**Code:** `src/modules/cod/domain/cod-limits.ts` (the limit rules, pure) ·
`src/modules/cod/services/cod-limits.service.ts` (exposure, gate, pin) ·
`src/modules/cod/services/cod-eligibility.service.ts` (checkout refusal) ·
`src/modules/orders/order.service.ts` (`maybeDispatchToAgencies`, `dispatchToAgency`) ·
`src/modules/orders/vendor-order.service.ts` (bulk dispatch, change-agency) ·
`src/modules/shipment-assignment/domain/services/contract-policy.service.ts` (`isForceableCodRefusal`) ·
`src/modules/agents/domain/services/agent-cod-pool.ts` (the 500 000 default) ·
`src/modules/delivery-fee-proposals/` (whole module; rules in `domain/delivery-fee-proposal.rules.ts`) ·
`src/modules/agents/models/agent-agency-membership.model.ts` (`FEE_SPLIT_MODELS`) ·
`src/modules/earnings/services/earnings-quote.service.ts` (`basisOf`, `salaryOf`) ·
`src/modules/notifications/catalog/*` · wi-admin `src/modules/agencies/` (cod-limit routes).
**Tests:** see § Tests.

---

## Context

Before 2026-10-02 the only cash-on-delivery limit was the **agent's**: a pool derived from the
agent's plan once KYC is verified (2026-09-21, `max_cod_pool`: Free 500 000 · Plus 1 000 000 · Pro
2 000 000), sub-allocated into per-contract slices, trust-scaled, enforced at agency → agent
assignment by `CodExposureService`. Nothing bounded how much un-remitted COD cash an **agency** as a
whole could hold, and a **vendor** had no say in whether their customers could pay cash at all, or
how much of their cash one agency could sit on.

On delivery fees: a shipment's fee is computed from the agency's published pricing (today a flat
per-shipment amount) and charged to the **vendor** (ADR-A07). There was no way to price one awkward
parcel differently — the agency either carried it at the published price or declined the shipment.

On contracts: the agent's pay was either a percentage of the fee or a flat amount per delivery.
Agencies that pay their riders a monthly wage had no way to say so.

---

## Owner decisions (2026-10-02)

Taken through a question round; every recommended option was chosen except the vendor terms, where
the owner chose "a cap plus COD off" over a per-order maximum.

| # | Decision |
|---|---|
| **D-1** | **Agent COD ceiling = 500 000 for every agent, whatever their plan.** An administrator's pin still overrides it (up or down). KYC not verified = 0. *(Supersedes the plan-driven pool of 2026-09-21.)* |
| **D-2** | **Agency COD limit = 1 000 000**, with an administrator pin / release. It counts **all** COD cash the agency holds that has not reached the platform: active COD shipments plus collected-not-remitted. |
| **D-3** | **Vendor "COD terms"**: `codEnabled` (off = no COD at checkout for that vendor) and `maxCashPerAgency`. **Separate from `policies`** — editing them does not pause connections. |
| **D-4** | **Over a limit the order is still placed.** The auto-redirect **holds** the shipment; the vendor may **force-push** it. |
| **D-5** | **The agency may force-push to an agent.** Force skips **only amount limits** — never KYC, trust, or an open cash shortfall. |
| **D-6** | **Delivery fee can change per shipment.** The agency proposes (the agent too, if the agency's preference is on). **Only before pickup**; **pickup is blocked while a proposal is pending**. |
| **D-7** | **The vendor approves every change**, up or down. The 30% rule (ADR-A07) is **waived** for a negotiated fee, but the **vendor's net must stay > 0**. |
| **D-8** | **On rejection the agency may decline the job or re-propose once.** |
| **D-9** | **Contract pay gains `monthly_salary`**: Wi-Mall pays the agent **0 per delivery**, the agency keeps the whole fee, the salary is paid **off-platform** (the amount is stored for display only), negotiated like the other `fee_split` terms. |

Follow-ups decided the same day, after the first build:

| # | Decision |
|---|---|
| **D-10** | **An agent's proposal goes straight to the vendor; the agency sees it and may EDIT it.** One pending request per shipment at a time. An agency edit makes the proposal agency-owned. |
| **D-11** | **The vendor's approve / reject carries the `version` they saw.** Every edit bumps it; a stale version is refused (`409 DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH`) — a vendor never approves a figure they were not shown. **Breaking** for vendor-dash (the body became required). |
| **D-12** | **Notifications for all of the above**, on every channel, with **21 WhatsApp templates** (`en` + `fr`, 42 submissions) — **submitted to Meta 2026-10-02, pending review**. Three new deep-link labels (agency `cod/limit`, agent `cod`, agent `shipments/{shipmentId}`) and two new preference keys (`codLimitUpdates`, `deliveryFeeProposals`, default on). |
| **D-13** | **`NEVER_SUBMIT` guard**: the template submit script hard-refuses `wi_mall_phone_verification_utility`, which Meta REJECTED on content and which the regeneration kept listing as "missing" (`scripts/submit-whatsapp-templates.ts:79`, pinned by `test:customer-notifications`). |

---

## How the decisions were implemented

### D-1 · The agent pool

`resolveCodPoolCeiling` (`agent-cod-pool.ts:66-71`): not verified → 0 (`not_verified`); a pin →
the pin (`override`); otherwise `AGENT_CONFIG.COD_POOL_DEFAULT` = 500 000 (`default`). `planCode` is
always `null`. The plan-change consumer (`agents/events/agent-plan-cod-pool.consumer.ts`) was
**deleted**; `max_cod_pool` stays on plan documents, dormant. Existing agents **converge** on the
next `agent-cod-pool-reconcile` run (cron `AGENT_COD_POOL_RECONCILE_CRON`, default `30 4 * * *`) —
no data migration; until then `pool.source: "plan"` may still be read and is rendered as `default`.

### D-2, D-3 · One exposure, two caps

`cod-limits.ts` defines one quantity for both caps:

- **in-flight** — COD shipments the agency holds in `assigned · handing_over · picked_up ·
  in_transit · agent_delivered` whose cash is not collected: the pending collection's
  `expected_amount`, else Σ item price × qty;
- **collected-unremitted** — every `collected` CashCollection with `settled_amount <
  expected_amount` (settlement advances only by a confirmed remittance or a direct deposit).

`pending` is not exposure (the agency has not been handed it). The agency limit resolves pin →
default (`resolveAgencyCodLimit`); the vendor cap is `maxCashPerAgency` measured on that vendor's
orders only. The pin lives on `delivery_agencies.cod_limit_override` (not in `policies.cod`, so it
never pauses connections). Vendor terms live on `vendor_settings.cod_terms` and are read with
defaults `{ codEnabled: true, maxCashPerAgency: null }`.

Reads: agency `GET /api/agency/cod/limit` (no pin reason / author); jovi-mall internal
`GET/PUT /api/internal/admin/agencies/:id/cod-limit`; wi-admin
`GET/PUT /api/v1/agencies/:agencyId/cod-limit` + `POST …/release` under the new **financial**
permission `agencies.cod_limit.set` (tier 1 + 2; permission vocabulary 127 → 128), audited as
`agencies.cod_limit.set` / `agencies.cod_limit.release`.

`codEnabled: false` is enforced in `CodEligibilityService.assertVendorOrderEligible`, **before** the
agency rules, inside the checkout transaction → `422 COD_VENDOR_NOT_ACCEPTED { vendorId }`. Both
checkout doors pass `vendorId` (`order.service.ts` `buildVendorOrder`; Mini App
`cashOnDeliveryRefusal`).

### D-4 · Where the gate runs

`CodLimitsService.evaluateHandoffs` judges a batch **in order**, counting the earlier hand-offs of
the same batch, agency cap first, then vendor cap; a zero-value (prepaid) hand-off is never refused.

| Path | Over a cap |
|---|---|
| auto-redirect (`maybeDispatchToAgencies`) | shipment stays `pending` with `cod_limit_hold`; the rest dispatches; timeline entry; vendor notified (`shipment.cod_limit_held`). Never forces, never retries. |
| vendor `POST /orders/:id/dispatch` | `422 COD_AGENCY_LIMIT_EXCEEDED`, nothing dispatched, unless `force: true` → `cod_limit_force` stamped |
| vendor bulk dispatch | per-order `failed[]` entry with `details`; `force` applies to the batch |
| vendor change-agency (`PATCH /orders/:id/delivery-agency`) | gated against the **destination** agency; `422` unless `force` |
| administrator dispatch (wi-admin → `admin-order.controller.ts`) | **not gated** |

### D-5 · Agency → agent force

`PATCH …/assign-agent` and `POST …/reassign` accept `force`. `ContractPolicyService.assert` waives a
failed `cod_exposure` gate only when `isForceableCodRefusal(verdict)` — the verdict's blocker is
`exposure_exceeded`. KYC, trust and shortfall are different blockers that outrank exposure in
`CodExposureService`, so they are never forceable. The force is persisted on the offer
(`cod_limit_forced`) so the agent's accept honours it. Auto-assign never forces.

### D-6 … D-8, D-10, D-11 · Delivery-fee proposals

New collection `delivery_fee_proposals`; the shipment carries `pending_delivery_fee_proposal_id`
(the serialisation pointer) and `delivery_fee_override` (the approved fee, which
`EarningsQuoteService` and the split read ahead of the formula).

- **Window** `assigned | handing_over`; **pickup block** in the shared `ShipmentService` status core
  (`409 SHIPMENT_DELIVERY_FEE_PENDING`), repeated as a CAS filter.
- **One pending** per shipment — the pointer CAS **and** the partial unique index
  `delivery_fee_proposal_one_pending_per_shipment` (migration below). **Max two non-withdrawn**
  (`MAX_NON_WITHDRAWN_PROPOSALS`) realises "re-propose once".
- **Vendor-net ceiling**: unit = whole order (online) / the shipment (COD), reusing ADR-A07's
  arithmetic with its 30% verdict ignored; checked at propose, edit and approve; the refusal carries
  no numbers.
- **Approval money**: COD and not-yet-split prepaid orders only record the override; a split
  prepaid order has its `delivery_fee_snapshot` rewritten and the vendor's held allocation re-priced
  **in place** with a `delivery_fee_adjustment` ledger row (`planFeeApplication`).
- **Authority table** `resolveAvailableActions` — vendor: approve/reject; agency: withdraw/edit (any,
  its agent's included); proposing agent: withdraw/edit its own until the agency edits it.
- **Version**: optional on a proposer's edit, **required** on the vendor's approve/reject.
- **Decline**: the existing `POST /api/agency/shipments/:id/reject`, now also releasing an accepted
  agent, auto-withdrawing a pending proposal and cancelling a COD delivery code.

### D-9 · Salary

`FEE_SPLIT_MODELS = ['percentage', 'flat', 'monthly_salary']`, field `agent_monthly_salary` (integer
≥ 1, minor units per month). Quote basis `contract_salary`, `earning.salary = { monthlyAmount,
currency, paidBy: 'agency_off_platform' }`, agent cut 0, no agent allocation row. wi-admin's contract
DTO gains `feeSplit.agentMonthlySalary`.

### D-12, D-13 · Notifications

21 notification situations across the three stacks (vendor 4, agency 9, agent 8), one WhatsApp
template each; several domain events feed more than one stack (the five `delivery_fee_proposal.*`
events reach vendor, agency and agent handlers, each filtering to its own audience). `shipment.cod_limit.forced` replaces `shipment.assigned` for a forced
hand-off; `shipment.assignment.cod_limit_blocked` replaces `shipment.assignment.unfilled` when the
agents' COD amount was the reason. The administrator's pin reason never reaches the agency or agent.

---

## Decisions made by implementers without owner input ⚑

Each of these was a judgement call during the build. None was put to the owner; each is cheap to
revisit.

| # | Decision | Where |
|---|---|---|
| ⚑ I-1 | The **agency** cap is tested before the vendor's — a vendor told "your terms" for a refusal the platform would have made anyway would loosen their terms for nothing | `evaluateCodLimits` |
| ⚑ I-2 | "Over" is **strictly greater** — holding exactly the limit is allowed | `evaluateCodLimits` |
| ⚑ I-3 | Exposure statuses exclude `pending` and `pending_agency_reassignment`; an un-accepted shipment is priced Σ price × qty | `COD_EXPOSURE_SHIPMENT_STATUSES` |
| ⚑ I-4 | An **administrator's** dispatch is never gated ("the administrator is the platform") | `OrderService.dispatchToAgency` |
| ⚑ I-5 | A pin **below** current holdings is accepted (over-limit is reported and blocks the next dispatch); pin and vendor cap max 100 000 000 | `CodLimitsService.setOverride`, `SetCodTermsSchema` |
| ⚑ I-6 | Held shipments are **never retried automatically**; a later successful dispatch clears the hold | `maybeDispatchToAgencies`, `assignPendingByIds` |
| ⚑ I-7 | A vendor-terms change notifies only **active** connections, only when a value actually changed; `paused_reapproval` is skipped | `publishVendorTermsChanged` |
| ⚑ I-8 | `handing_over` is inside the proposal window (the replacement's pickup is a new run) | `DELIVERY_FEE_PROPOSAL_WINDOW` |
| ⚑ I-9 | Withdrawn proposals do not count toward the two; "re-propose once" is realised as "two non-withdrawn" | `MAX_NON_WITHDRAWN_PROPOSALS` |
| ⚑ I-10 | An agent may propose only on a shipment whose **accepted** offer it holds; otherwise `404 SHIPMENT_NOT_FOUND` (not 403) | `checkProposer` |
| ⚑ I-11 | A split prepaid order is re-priced **in place**; a non-`held` vendor allocation refuses with `SETTLEMENT_CONFLICT` rather than writing an adjusting row | `planFeeApplication` |
| ⚑ I-12 | An agency-edited proposal survives the agent being reassigned away; an agent's own is auto-withdrawn (`agent_detached`) | `withdrawPendingInSession` |
| ⚑ I-13 | The vendor's notifications name the **agency** even when its agent proposed | `notification-catalog.ts` |
| ⚑ I-14 | Analytics attribute a delivery that wrote no agent row (salary, 0% split) to `shipment.agent_id` | `delivery-analytics.service.ts` |

---

## Known gaps and risks

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| G-1 | **Limits are check-then-act, with no lock.** Two dispatches racing for an agency's last headroom can both pass. | `cod-limits.service.ts:92-96` (stated deliberately) | Over-limit is visible (`overLimit`) and stops the next dispatch; the cap bounds a risk, it is not a ledger. |
| G-2 | **No "agency over its limit" notification.** Nobody is pushed when an agency crosses its limit; only reads show `overLimit`. | no such situation in `agency-notification-catalog.ts` | The agency learns from the gauge or from vendors' holds. |
| G-3 | **Change-agency does not check an active vendor↔agency connection** (pre-existing, left alone). | `vendor-order.service.ts:1067-1068` | A vendor can move an item to an agency it has no active connection with. |
| G-4 | **Probable bug — `contract.cod?.threshold ?? 0`.** The contract gate turns a missing per-contract threshold into **0**, whereas `CodExposureService.limitBreakdown` treats `null` as "use `COD_AGENT_MAX_EXPOSURE_DEFAULT`" (300 000). A 0 slice refuses every COD shipment with `exposure_exceeded` — which is exactly what `force` now waives. | `contract-policy.service.ts:394` vs `cod-exposure.service.ts:312` | Unconfirmed intent; owner question. Not changed (docs-only round). |
| G-5 | **Approval vs payment split race (suspected).** Auto-dispatch runs **before** `splitOrder` at payment success (`order.service.ts:1372` vs `:1433`), and a failed split is retried later, so a proposal can be approved while the order is not yet (or half) split. The approval reads the split state and takes the `orderSplit = false` branch (rewrite snapshot, no allocation re-price); a split interleaving between that read and its own allocation write could persist allocations at the old fee. | `planFeeApplication`, `DeliveryFeeProposalService.approve` | No test covers the interleaving. |
| G-6 | **Emailed / WhatsApp / Telegram buttons land on the dashboard home** on both web dashboards, and cannot open the agent app at all; agency `shipments/{id}` and `vendor-connections/{id}` are still unresolved in agency-dash. | `api-doc/notifications/deep-links.md` § Emailed buttons | The new situations inherit it; frontend-owned. |
| G-7 | **The agent sees `edit` after its agency switched the preference off** on shipment reads, then gets `403 DELIVERY_FEE_PROPOSAL_AGENTS_NOT_ALLOWED` on the PATCH — reads build the viewer without the setting. | `listForShipment` / `mapForShipments` vs `edit` | Contradicts "a dashboard never offers a verb the API refuses" (`dto/…dto.ts`). Documented for agent_app. |
| G-8 | **A `handing_over` shipment cannot be declined** after a rejected proposal — the reject endpoint accepts `assigned` only, although `handing_over` is in the proposal window. | `ShipmentService.reject` | D-8 holds only for `assigned`. |
| G-9 | The hold's **timeline sentence** always says "the delivery agency is at its cash-on-delivery limit", also for `kind: vendor_terms`. | `maybeDispatchToAgencies` | Clients must read `kind`. |
| G-10 | ✅ **CLOSED 2026-10-03.** ~~The web storefront cannot predict `COD_VENDOR_NOT_ACCEPTED`.~~ Every cart quote (`POST /api/customer/cart/quote`, and the bot's) now carries `cashOnDelivery: { available, reason, vendorIds }`, reasons 1:1 with `COD_VENDOR_NOT_ACCEPTED` / `COD_AGENCY_NOT_SUPPORTED` / `COD_ORDER_AMOUNT_EXCEEDS_LIMIT` / `COD_NOT_AVAILABLE_FOR_DIGITAL`. Computed by checkout's own `assertVendorOrderEligible` per shop (`CartQuoteService.codRefusalsOf`); the Mini App's `cashOnDeliveryRefusal` now reads the same refusal (`quoteWithCodRefusal`), so one definition serves all three doors. Exposure holds deliberately excluded (they never refuse a customer). Catalogue/store reads still carry no COD flag — availability depends on the basket's agencies. | `cart-quote.service.ts`; `test:cod-limits` § 10 | Checkout still re-checks; clients keep handling the 422 as a race fallback. |
| G-11 | **No wi-admin surface** for vendor COD terms, held / forced shipments, or fee proposals. | wi-admin source scan | Support answers from logs. |
| G-12 | `CodLimitsService.clearHolds` has **no call site** (holds are cleared by `assignPendingByIds`). | grep | Dead code. |
| G-13 | The route comment at `src/modules/vendor/routes.ts:329` documents the reject body as `{ note? }` — it now also requires `version`. | source | Code comment only; not edited in this docs round. |
| G-14 | **21 WhatsApp templates pending Meta review.** Out-of-window WhatsApp delivery of these situations fails until each is APPROVED; Meta may re-categorise UTILITY → MARKETING. | `api-doc/notifications/whatsapp-templates.md` § 2026-10-02 | Other channels work. |

---

## Deploy

1. **jovi-mall first, wi-admin with or after it.** wi-admin's `GET/PUT /api/v1/agencies/:agencyId/cod-limit`
   delegate to jovi-mall's `/api/internal/admin/agencies/:id/cod-limit`, which the deployed jovi-mall
   does not serve.
2. **Run the index migration** before (or as) jovi-mall starts — `autoIndex` is off in production:
   `npm run migrate:delivery-fee-proposal-indexes -- --dry-run`, then without `--dry-run`. It is in
   the ledger (`scripts/migrate.ts`, `npm run migrate:status`). Its partial unique index is a
   **correctness** guarantee (no two pending fee changes on one shipment), not a performance one.
   Then `migrate:declared-indexes` finds nothing missing.
3. **No data migration.** Agent pools converge on the nightly `agent-cod-pool-reconcile` (or trigger
   it manually from the developer tools); vendor terms and the agency pin default when absent.
4. **WhatsApp**: nothing to deploy — wait for the 21 templates' APPROVED status.
5. **Frontends**: vendor-dash must send `version` on approve/reject before vendors use fee proposals
   (D-11). Everything else is additive or degrades to a generic notification.

Rollback: every new field is additive and every new route is new; rolling jovi-mall back leaves the
`delivery_fee_proposals` collection and its index orphaned but harmless, and leaves wi-admin's three
COD-limit routes answering upstream 404s.

## Tests

| Repository | Suite | Pins |
|---|---|---|
| jovi-mall | `npm run test:cod-limits` | exposure sum, cap order, strict-greater, batch running totals, `isForceableCodRefusal` table |
| jovi-mall | `npm run test:delivery-fee-proposals` | window, max-two, authority table, edit / version rules, vendor-net ceilings, `planFeeApplication` |
| jovi-mall | `npm run test:contract-salary` | `monthly_salary` validation and quote arithmetic |
| jovi-mall | `npm run test:agent-cod-pool` | the 500 000 default, pin, KYC zero |
| jovi-mall | `npm run test:customer-notifications` | catalogue completeness; `NEVER_SUBMIT` |
| jovi-mall | `npm run test:notification-deeplinks` | the three new labels and the vocabulary counts |
| jovi-mall | `npm run test:errors` | new codes, one status each, categories |
| wi-admin | `npm run test:agencies` | the cod-limit routes, permission and audit actions |
| both | `npm run typecheck` **and** `npm run typecheck:scripts` | `typecheck` alone skips `scripts/` |

## Decided NOT to change (this round)

- The agent's own "carry less" (`PUT /api/agent/cod/pool`) and the per-contract slice
  (`PATCH /api/agency/agents/:membershipId/cod-limit`) are unchanged.
- The ADR-A07 30% rule still governs **checkout**; only an approved per-shipment fee is exempt.
- ~~No pre-checkout COD signal on the web cart quote (G-10).~~ Built 2026-10-03 — see G-10.
