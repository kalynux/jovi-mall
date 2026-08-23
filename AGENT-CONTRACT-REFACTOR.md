# Agent Contract Refactor — the build is DONE; two verification items are not

> **Read this before touching `src/modules/agents/`, `src/modules/cod/`, or
> `src/modules/shipments/shipment.service.ts`.**
>
> **Every behavioural item of this refactor has shipped.** The domain layer, the
> COD shared-pool model, the contract lifecycle with negotiated terms, the COD
> cash chain and its release mechanism (agent→agency deposits draw down the
> contract balance via `AgentDepositService` → `recordSettlement`), agent
> earnings on **both** payment methods, and all five admin/agent controller
> groups are built, routed and reachable.
>
> **As of 2026-08-22: `npx tsc --noEmit` and `npm run lint` are clean,
> `npm run test:agent-domain` is green at 211, `test:agent-trust` at 35,
> `test:agent-shipment-status` at 32, `test:earnings-quote` at 29, and
> `test:system` at 228.**
>
> **Delete this file when § "Still open" below is empty — not before.**

---

## Where every remaining item stands — the close-out ledger

Written 2026-08-22 as Phase 6 Step 16.3. The rule it exists to satisfy: *a banner
removed while an item is silently open is worse than the banner.* Everything this
document ever listed as unbuilt is in one of the two tables below, and nothing is
in neither.

### ✅ Closed — built, or ruled not applicable

| Item | How it closed |
|---|---|
| §1 · The 8 errors | **Built** 2026-07-16 |
| §2 · Settlement, COD half | **Built** 2026-07-16 — the increment, the decrement, and the §4 gate made real |
| §3 · Earnings `owner_type: 'agent'` | **Built** — COD 2026-07-16, **prepaid 2026-07-29**. Agents are paid on every physical delivery, cash or card, and can see and withdraw it. Sub-steps 3b–3h all built |
| §3's agency-side quote | **Built** 2026-08-05 — `quoteAgencyForShipment(s)`, from the same four pure helpers the split uses |
| "Not built at all" #1 · the agent's cut on PREPAID orders | **Built** 2026-07-29 |
| "Not built at all" #2 · trust composite **engine** + nightly worker | **Built** 2026-08-21 (Phase 6 Step 3). `AgentTrustService` + `AgentTrustRecomputeWorker` + `test:agent-trust`. ⚠ **The engine is built; the CUTOVER is not** — see the open table |
| "Not built at all" #3 · controllers/routes | **Built** 2026-07-29 — agent threshold, contract terms, settlements, KYC/ban, status-request inbox |
| "Not built at all" #4 · the collection-rename migration | **Not applicable pre-production** (owner decision **D-5**, 2026-08-21). Code was already post-rename; the orphan collection was backed up and dropped rather than migrated |
| "Not built at all" #4 · the `cod.outstanding_balance` backfill | **Not applicable pre-production** (D-5). Fixed in **`seed:cod-shipments`** instead, with a seed-level assertion — Phase 6 Step 2.3. This was the "single most load-bearing item in §4" and it closed by making the fixture correct rather than by carrying rows nobody is keeping |
| "Not built at all" #8 · **Docs** | **Done 2026-08-22** (Phase 6 Step 16). `CLAUDE.md` and `ARCHITECTURE.md` no longer describe the pre-refactor model: the contract vocabulary, the seven statuses, the shared pool, and a new § *Agent trust score* stating which of the two scores is live |
| §4's terms-negotiation dependency · `migrate:contract-terms` | **Written and registered** in the ledger. Same D-5 caveat as its siblings: it is a legacy-data migration and there is no legacy data |
| §4's `late_deposit` index swap | **Written and registered** as `migrate:cod-late-deposit-index`. This one is an **index** migration and D-5 does **not** exempt it — `autoIndex` is off in production, so the first deploy still needs it |

### ⛔ Still open

| Item | Status | Trigger to close it |
|---|---|---|
| **The trust CUTOVER** (locked decision: *"composite REPLACES the delta model; `CodTrustService.applyEvent` stops writing the score"*) | Engine built, running in **shadow**. `cod.trust_score` is byte-identical to what it always was | Two blockers, both measured (Phase 6 Step 11): **(a)** zero delivery reviews exist, so 50 of 100 weight still resolves to the seed and the composite cannot lower anybody — re-run `npm run audit:trust-shadow` and reopen when its footer stops printing the `every delta is ≥ 0` line; **(b)** **O-7** — an agent at a live 35 (COD-**blocked**) scores 100, so a flip hands them full exposure. Either administrators keep a persistent override outside the composite, or manual adjustment stops surviving a recompute. **Undecided.** Then the flip itself is one line: `setTrustSignalsShadow` → `setTrustScore` |
| **"Not built at all" #6 · Tests** — the 7 named scenarios, the §1 worked example, the concurrent-allocation race | **Not written.** `test:agent-domain` (211) is DB-free by construction, so it covers neither the allocation race nor the money movements | Needs a Mongo-backed suite or the E2E path below. Nothing blocks starting it |
| **"Not built at all" #7 · E2E** against live Mongo — the 8-step scenario | **Not written** | Same |

### 🔸 Known-and-accepted, not tracked as refactor debt

| | |
|---|---|
| `cod_limit_changed` is declared and **written by nothing** | `setContractThreshold` takes no actor and appends no event, so a COD threshold change is the one contract mutation with no audit trail. Closing it needs an `Actor` threaded to the call site. See § "Found while doing step 1" |
| `CodExposureService.effectiveLimit(agent, maxExposureOverride)` is named for a dead field | Cosmetic, on a live dispatch path. Both call sites pass a definite number, so the `?? AGENT_MAX_EXPOSURE_DEFAULT` fallback is unreachable |
| ~~⚠ `scripts/migrate-agent-memberships.ts` writes the **retired** status literal `'approved'`~~ | ✅ **CLOSED 2026-08-23 by DELETION** (Phase 6 Step 17). It created rows with `status: 'approved'`, which the schema enum no longer accepts, and its idempotence filter `$in: ['pending','approved','suspended']` could never match an `approved` row either — so it would have thrown a Mongoose `ValidationError` the moment it met a legacy agent. Found 2026-08-22 during Step 16 and deliberately left for a step that could touch code. The script, its `migrate:agent-memberships` npm binding and its `MIGRATIONS` row are **gone**; repairing it would have moved the checksum of an already-applied migration to save a script whose only job is to carry pre-refactor rows **D-5 says will never exist**. Its `schema_migrations` row survives as history and is not reported — the runner maps over `MIGRATIONS`, not over the ledger |
| Settlement-vs-deactivation race | Not covered by a test. The re-check at approval handles it in principle; unverified |

> ### ⚠️ 2026-08-02 — terms negotiation landed, and it took a dependency on §4
>
> The contract's terms became **negotiable** (see `CLAUDE.md` § Agent domain):
> `terms_proposed_by` replaced `origin` as the approver discriminator, a
> `ContractTermsProposal` collection stages changes to live contracts, and the
> four previously-inert terms are now enforced. `npm run test:agent-domain` is
> green at **197 assertions**; `tsc`, `lint`, an `src/app.ts` boot and a route-
> order check on both routers are all clean.
>
> **Two of §4's pending migrations are now blockers rather than tidy-ups:**
>
> ✅ **BOTH CLOSED, and by different routes — 2026-08-21.** Kept in full because the
> reasoning below is why item 1 was load-bearing at all. **(1)** was closed **without a
> backfill**: owner decision **D-5** rules that there is no production data to carry, so the
> derivation was moved into `seed:cod-shipments` with a seed-level assertion instead
> (Phase 6 Step 2.3). The silent no-op this warns about was then measured on the dev database
> and was **not present** — `cod.outstanding_balance` is populated and the late-deposit sweep
> is demonstrably writing rows. **(2)** was closed by **running it**: it is an *index*
> migration, which D-5 does not exempt, and `migrate:cod-late-deposit-index` is applied.
> ⚠ Do not read (1) as licence to skip index migrations — `autoIndex` is off in production,
> so the first deploy against an empty database still needs every one of them.
>
> 1. **`cod.outstanding_balance` backfill.** `CodDepositDeadlineWorker` no longer
>    iterates cash accounts — it iterates contracts and reads
>    `cod.outstanding_balance` directly, because the cadence is per-contract while
>    the agent's cash pot is global. Un-backfilled, that field reads `0`
>    everywhere and the sweep flags **nobody**: a silent no-op that looks like a
>    working feature. This is now the single most load-bearing item in §4.
> 2. **The `late_deposit` index swap.** `{ agent_id, type }` → `{ agent_id,
>    agency_id, type }`. `autoIndex` creates the new one but never drops the old,
>    and the stale one would keep enforcing one-open-flag-per-agent globally —
>    duplicate-key errors swallowed by the worker's per-contract try/catch, so the
>    run reports success having flagged nothing. Run
>    `npm run migrate:cod-late-deposit-index` (idempotent, `--dry-run`).
>
> New migration for this work: `npm run migrate:contract-terms` (idempotent,
> `--dry-run`). Note its conditional — a pending contract whose stored fee split
> is incoherent is deliberately left at `terms_proposed_by: null` rather than
> stamped from `origin`, because stamping it would assert that an agency proposed
> terms paying the agent zero. It reports how many rows land there; that count is
> how many agencies will be asked to propose terms on next login.

## What this refactor is

Replaces the per-agency COD cap with a **shared-pool allocation model**, and
reframes the agent↔agency **membership** as a **contract** with a conditional
status lifecycle. The collection followed the vocabulary:
`agent_agency_memberships` → **`agent_agency_contracts`**, which is what the code
has read since before Phase 6. The model *file* and a handful of exported aliases
(`AgentAgencyMembershipModel`, `MembershipStatus`, `LIVE_MEMBERSHIP_STATUSES`)
still say "membership" — they are aliases of the contract exports, not a second
concept, and `agent_membership_events` kept its name on purpose.

**The governing rule:** *an agent's COD threshold is a shared pool; every
contract is a sub-allocation of it, and the sum across allocating contracts can
never exceed the agent's own limit.*

The old model (`cod.max_exposure_override`, an independent cap per agency) let
three agencies each grant 1M to an agent willing to hold 1M — the platform only
discovered the 3M of real exposure when cash went missing. A pool cannot be
over-committed by construction.

## Step 1 — the 8 errors — DONE (2026-07-16)

What was done, and the decisions taken while doing it:

- **`AgentContractService.transfer()`** — added, admin-only. Deliberately NOT routed through
  `requestTransition`: the authority matrix is written in terms of the two contract parties and a
  transfer is the platform overriding both, and it moves two contracts as one unit. Both halves run in
  ONE transaction, source deactivated **first** so its slice returns to the pool before the target's
  threshold is checked against headroom (check the target first and a straight move at an unchanged
  threshold needs double the pool and always fails). The §4 gates still apply — a transfer must not
  strand cash or wages. Primary standing carries to the target. Note `transactionManager` does **not**
  nest: it starts a fresh session every call, so composing the façade methods here would have silently
  produced two transactions.
- **`remove`** now returns `{ request, membership }`; `membership` is null while pending — which, for
  an agency-initiated deactivation, is always, since its authority is `requires_counterparty`.
- **`setCodLimit`** loads the contract via `getForAgency` (404-scopes it to the agency, resolves the
  agent), then calls `setContractThreshold(agentId, contractId, threshold)`.
- **`SetCodLimitSchema`** — `maxExposureOverride: number|null` → `threshold: number`, non-nullable and
  bounded by `CONTRACT_COD_THRESHOLD_{MIN,MAX}`. Null meant "platform default", which is precisely the
  implicit capacity the pool model exists to remove. `0` grants nothing and is the default.
- **`ContractStatusRequestMapper`** — new (`dto/contract-status-request.dto.ts`), omitting actor user
  ids like `AgentMembershipMapper`. The status-request inbox (§4 below) should reuse it.
- **Agent COD self-view** and **admin COD list** now report the agent's own `cod.max_threshold`.
- **`agent.config.ts`** trust-weight assertion — kept as a bare `Error` with an
  `eslint-disable-next-line`, matching the payment gateways' precedent. It runs at module load with no
  request in flight and nothing to catch it; an AppError exists to become an HTTP response and there is
  none. This was the only `npm run lint` failure.
- **API docs updated** for the three contracts changed: `PATCH …/cod-limit` (body + response),
  `DELETE /api/agency/agents/:membershipId` (now returns a request), `GET /api/admin/cod/agents`
  (`maxExposureOverride` → `codMaxThreshold`; `agencyId` → `agencyIds`, which was already stale).

## Test harness — REPAIRED (2026-07-16), part of §7 pulled forward

`npm run test:agent-domain` was stale and would have failed wholesale; it compiled only because its
fixtures are typed `any`. It is now green at **47 assertions** (was 41) and is a trustworthy signal
again. It was brought forward out of §7 because the settlement service moves real money and would
otherwise be written with nothing to verify it.

What was wrong, for reference: it stubbed `findApproved` / `listApprovedAgentIds` (now `findActive` /
`listActiveAgentIds`) and stubbed a private `countActiveShipments` that no longer exists; `makeAgent`
had no `kyc`, no `platform_ban` and no `capacity`, so every agent it built was `kyc_not_verified`;
`makeMembership` used `status: 'approved'` and `cod.max_exposure_override`.

The fixture now mirrors the model rather than working around it — `makeEligibility` merges
`activeShipments` onto `capacity.active_shipment_count` instead of stubbing a query, because that
counter is what admission control atomically reserves against. Six assertions were added for the new
platform gates and for capacity being global rather than per-agency.

**Still owed by §7:** the 7 named scenarios, the §1 worked example, and the concurrent-allocation race
— none of which this harness covers. It is DB-free by construction, so the allocation race needs the
E2E path (§7/§8) or a Mongo-backed test.

## Found while doing step 1 — not yet addressed

1. **COD threshold changes are no longer audited.** The `cod_limit_changed` event type exists on
   `AgentMembershipEvent` and nothing writes it — `setContractThreshold` takes no actor and appends no
   event, unlike every other contract mutation. Decide whether the audit trail matters here; if so it
   needs an `Actor` parameter.
2. **`CodExposureService.effectiveLimit(agent, maxExposureOverride: number | null)`** is named for a
   field that no longer exists, and its `?? AGENT_MAX_EXPOSURE_DEFAULT` fallback is now dead — both
   call sites pass a definite number (`contract.cod.threshold ?? 0` from `ShipmentService`, the agent's
   pool from the self-view). Left alone deliberately: it is a live dispatch path and the rename is
   cosmetic. Fold it into §5 or §8.

## Done and sound

- **Config** (`config/agent.config.ts`) — all four COD threshold bounds, four
  capacity keys, trust weights (asserted to sum to 100 at import). Every bound
  the rules depend on is here, never inline.
- **Agent model** — `cod.max_threshold` (the pool), `capacity` (counter + max),
  `kyc`, `platform_ban`, `payout_details` (sensitive), `home_base`,
  `trust_signals`. `settings.max_concurrent_shipments` moved to `capacity`.
- **Contract model** (`models/agent-agency-membership.model.ts`, exports
  `AgentAgencyContractModel`) — statuses `pending | rejected | withdrawn |
  active | paused | suspended | deactivated`. `approved` is an ACTION, not a
  state; approving lands in `active`. Terms: `cod.threshold`,
  `cod.outstanding_balance`, `payment.outstanding_to_agent`,
  `remittance_terms`, `coverage`, `fee_split`, `shipment_value_ceiling`.
  **`withdrawn` arrived later**, with the symmetric agent↔agency handshake that
  replaced the email-invite subsystem, and it is deliberately outside
  `LIVE_CONTRACT_STATUSES` — that list backs the partial unique index on
  `(agent_id, agency_id)`, so including it would make a withdrawn request block
  the re-request it exists to permit.
- **`ALLOCATING_CONTRACT_STATUSES`** = `active | paused | suspended`. Pausing
  does NOT free the pool (the agent may still hold that agency's cash), so
  reactivation can never fail a headroom check. `pending` never allocated;
  `deactivated` is necessarily zero (§4 blocks termination otherwise).
- **`AgentCodThresholdService`** — headroom, the sum constraint enforced from
  both directions, all inside the caller's transaction. Lowering below allocated
  is a hard rejection with no side effects.
- **`AgentCapacityService`** — global (NOT sub-allocated per agency), atomic
  `tryReserveCapacity` via one conditional `$inc`, guarded release, `reconcile()`
  for drift.
- **`AgentContractService`** — the `ContractStatusRequest` workflow, authority
  matrix, per-contract COD + payment gates on deactivation, conditions
  re-checked at approval time.
- **`AgentGateService`** — KYC + platform ban, evaluated before COD/capacity.
- **Models built, services not yet written for them:**
  `contract-settlement.model.ts`, `contract-status-request.model.ts` (the
  repository for the latter exists).

## Step 2, COD half — DONE (2026-07-16)

**The original premise was wrong, and the correction is the important part:** nothing *incremented*
`cod.outstanding_balance` either. Both it and `payment.outstanding_to_agent` had zero writers, so
`evaluateDeactivationBlockers` always returned `clear: true` — the §4 termination gate was
decorative, and `setContractThreshold`'s below-outstanding check could never fire.

**A settlement mechanism already existed.** `POST /api/agency/cod/deposits` →
`AgentDepositService.record()` has always been the agent→agency COD handover: it resolves the live
membership, debits the agent's `CodCashAccount`, writes an `AgentDeposit` row and a `CodCashLedger`
entry, and emits `cod.deposit.recorded`. `ContractSettlement.cod_remittance` describes that *same*
physical movement. Decision taken with the product owner: **extend the existing chain, don't duplicate
it** — one cash movement, one row. So:

- **Increment** — `CashCollectionService.creditCashLiabilitiesInSession` now also attributes the
  collection to its contract (`findLive`, then `adjustOutstandingBalance(+amount)`), inside the
  existing collect transaction. `findLive` not `findActive`: suspend/pause deliberately leave in-flight
  shipments alone, so cash legitimately lands under a contract that takes no new work. A missing
  contract logs loudly and does **not** fail the collection — this is the only transaction by which a
  COD shipment reaches `delivered`, and a bookkeeping gap must not strand a handover that physically
  happened.
- **Decrement** — `AgentDepositService.record()` calls `recordSettlement` (guarded compare-and-set)
  inside its existing transaction, so a double-recorded handover yields one settlement and one visible
  conflict rather than freeing headroom twice.
- **New guard** — the deposit amount is now bounded by the *contract's* outstanding balance, not only
  the agent's pot. The pot spans every agency, so the old check alone would let agency A bank cash the
  agent was holding for agency B: a settlement attributed to the wrong contract, freeing headroom the
  wrong contract never consumed. Rejects with `CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING`.
- **`ContractSettlement` remains unused**, now deliberately — reserved for `agent_payment`. Its
  docstring's "both directions in one collection" intent is therefore not honoured for the COD half;
  update it when §1 below lands, or reconsider the model.
- Only two paths move an agent's `CodCashAccount` (the collect credit, the deposit debit) and both now
  mirror onto the contract. Discrepancies and agency→platform remittances don't touch it.

**⚠️ §4 below MUST backfill `cod.outstanding_balance`, or every deposit will 422.** With the field at
0, the new guard rejects everything. It is derivable exactly, per (agent, agency):
`sum(CashCollection.expected_amount where status='collected') − sum(AgentDeposit.amount)`. Both
already carry `agent_id` + `agency_id`, and the per-agency sums must reconcile to
`CodCashAccount('agent').balance`.

Tests: 8 added — the §4 gate in both directions, the multi-agency mis-attribution guard, and the
`>` vs `>=` boundary that would otherwise strand every agent at their last franc.
`npm run test:agent-domain` is green at **55**.

## Step 3, earnings `owner_type: 'agent'` — DONE for COD (2026-07-16)

**A contradiction had to be settled first: who owes the agent?** The contract side said the *agency*
(`payout_details` was documented as "where the agency sends the agent's money";
`ContractSettlement.agent_payment` is `agency_to_agent`; `payment.outstanding_to_agent` is "what this
agency still owes"; the §4 error says "The agency must pay the agent"). But `EarningsAccount` means
platform-held money — `available_balance` → PayoutRequest → admin marks paid → *the platform* pays. So
adding `'agent'` to `EarningsOwnerType` literally, as the locked decision says, would have let an agent
request a payout from the platform for money the platform never collected, with `available_balance`
silently meaning a different debtor for agents than for vendors.

**Resolved with the product owner: the PLATFORM pays the agent**, and agents use the ordinary payout
pipeline. Consequences applied:

- `EarningsOwnerType` += `'agent'`, plus the schema enums on `earnings-account`, `earnings-allocation`
  (`beneficiary_type`), `earnings-ledger`, and `payout-request` (which gains `agent` but still has no
  `platform` — the marketplace does not pay itself out).
- **`agent.payout_details` is now `IPayoutMethod[]`**, the same ordered shape vendors and agencies use,
  replacing the bespoke `{ method, account_number, provider }` record. That record only made sense when
  an agency was paying informally off-platform; the real pipeline snapshots an `IPayoutMethod` onto
  every PayoutRequest and its bank branch requires a `country` the old shape never carried. It had no
  DTO, no validator and no callers, so this cost nothing.
- **`splitCodCollection` carves the agent's cut out of the AGENCY's delivery fee** per the contract's
  `fee_split` — the vendor pays exactly what they paid before. The COD handling fee stays whole with
  the agency: `fee_split` is defined as a share "of the delivery fee", and the agency is the party the
  rolling reserve is held against.
- The agent's allocation inherits `requires_cash_settlement: true`, so an agent cannot withdraw a cut
  of cash they are still holding or never handed back. The rolling reserve stays agency-only
  (`reserveAmountFor` already checks `beneficiary_type === 'agency'`), which is right — the agency is
  the cash-accountable party.
- `computeAgentCut` clamps to the delivery fee and logs: a flat fee negotiated above what a delivery
  earns would drive the agency's allocation negative, and the platform can only divide the fee it
  collected. A missing live contract yields no cut and does not fail the split — same cause and same
  treatment as the unattributed-collection case in step 2.
- The refund path needed no change: it reverses allocations generically off `beneficiary_type`.

Tests: 7 added (percentage, flat, floor-rounding, the clamp, zero fee, no contract, zero share).
`npm run test:agent-domain` is green at **62**.

### Who owes vs who pays — settled 2026-07-16, and the two are different

The product owner's framing resolves what first looked like a contradiction: **the agency owes the
agent** (the cut comes out of the agency's share, per their contract) **but the platform enforces
every payment.** Nobody is paid off-platform. So `payout_details`, `payment.outstanding_to_agent` and
the §4 wage gate are NOT orphaned, and `ContractSettlement` is not dead — the debt is real and
agency-owed, the platform is merely the payer of record. Earlier notes in this file claiming
otherwise were wrong and have been removed.

## Step 3b, escrow maturity — DONE (2026-07-16)

**The rule, from the product owner: every actor's share becomes available only after a hold period
following ORDER completion — where completion means every shipment for that order is finished.** It
held for prepaid and was broken for COD.

- **COD no longer matures per shipment.** `splitCodCollection` used to create allocations *already
  completed*, with the hold running from that one handoff, reasoning that the delivery code was that
  shipment's customer confirmation. True, but it made one shipment's money releasable while its
  siblings were still out — actors on a split order were paid at different times for the same order.
  COD rows are now created unstamped like prepaid.
- **`EarningsCompletionService.onOrderCompleted`** matures everything an order produced: its own
  `('order', orderId)` row AND every per-shipment `('cod_collection', collectionId)` row. This is the
  subtle part — `markCompletedBySource` is keyed by source, and a COD order's sources are its
  collections, not itself, so stamping only the order silently left COD money held forever
  (`findMaturedHeld` skips a null `hold_release_at`).
- **`OrderCompletionService.isSettled`** replaces `fulfillment_status === 'delivered'` as the
  completion test. An order with one item delivered and one returned is finished, but sits at
  `partially_delivered` forever — it would never complete, stranding the delivered item's escrow
  permanently. For COD that is cash already taken from a customer. Terminal = `delivered | returned`;
  `failed` is deliberately excluded (the agent still holds it and the agency can retry via
  `failed → in_transit`). Applied in three places: `assertConfirmable`, the auto-confirm sweep (which
  now pre-filters on `partially_delivered` too), and the post-confirm hook in `ShipmentService`.
- **Ordering bug caught while doing this:** the COD collect path completes the order *before* it
  splits, and the recovery sweep re-splits long after completion — so both would have created
  allocations after the completion that was supposed to stamp them, leaving them held forever.
  `splitCodCollection` now inherits `order.completion.confirmed_at` when the order has already
  completed.
- **Agent-after-agency needs no gate:** the two share a source, a hold window and the same
  cash-settlement requirement, so they release in the same sweep. The agent's money can never be
  available before the agency's.

Tests: 10 added for `isSettled` (a pure function). `npm run test:agent-domain` green at **72**.

## Step 3c, the confirmation gap — FIXED (2026-07-16)

**The bug found:** `agent_delivered → delivered` had exactly one trigger — the customer clicking
confirm on that shipment. No sweep, no timeout. A prepaid order whose customer never clicked left its
items at `agent_delivered`, `recomputeFulfillmentStatus` landed on `shipped` (`agent_delivered` is in
`SHIPPED_OR_BEYOND`), the order-level sweep only looked at `delivered | fulfilled`, so it never
matched — and **the vendor, platform, agency and agent were never paid. Indefinitely.**
`AUTO_CONFIRM_DAYS` never covered it: that is a backstop for the ORDER-level click and only fires once
fulfilment already reached `delivered`, which requires every shipment to have been confirmed already.

**The fix:** `ShipmentService.autoConfirmStaleDeliveries`, run as stage 0 of the earnings sweep
(before the order stage, so confirming the last shipment completes its order in the same pass rather
than a day later). Window: `SHIPMENT_AUTO_CONFIRM_DAYS`, **7 days**, product-supplied. Measured from
`updated_at`, which the shipment records, rather than from the un-recorded moment it became
`agent_delivered` — that errs long, never short, so a customer never gets less dispute time than
configured.

`isSettled` was deliberately NOT changed to treat `agent_delivered` as terminal: it is an agent's
claim, and letting an unverified claim release escrow is what the confirmation design exists to
prevent. The sweep confirms explicitly and records `customer_confirmation.auto = true` with
`confirmed_by: null`, so a lapsed window stays distinguishable from a customer who actually looked at
the parcel and said yes — which is the evidence a delivery dispute turns on.

## Step 3d, the COD arrival state — CHANGED (2026-07-16)

Product decision: a COD agent now marks `agent_delivered` on arrival, gets
`requiresDeliveryCode: true` back, and submits the customer's code to reach `delivered`. Previously
`agent_delivered` was rejected outright for COD. The customer has held the code since pickup, so they
can read it out immediately.

- `AGENCY_TRIGGERABLE_TRANSITIONS` gains `agent_delivered: ['failed']`. Without it a COD customer who
  refuses to pay strands the shipment: `delivered` needs a code that is not coming, and there was no
  other way out.
- `collect` accepts `agent_delivered` alongside `picked_up`/`in_transit`.
- The COD guard now rejects `delivered` as a status change instead of rejecting `agent_delivered`.

### The delivery code now issues at AGENT ASSIGNMENT, not pickup

Product decision: the customer should have their code as early as possible, so they are holding it
before the agent reaches the door. `CashCollectionService.ensureForShipmentInSession` (was
`createForShipmentInSession`) is now called from `ShipmentService.assignAgent`, inside a transaction
with the assignment itself — a COD shipment with an agent but no collection, or a collection naming a
different agent, must never be observable.

Two things the idempotency is carrying, both easy to break:

- **Reassignment re-points the PENDING collection at the new agent.** `creditCashLiabilitiesInSession`
  credits `collection.agent_id`, so a stale one puts the cash on the balance of an agent who never
  touched it while the one who did carries nothing. `reassignPendingAgent` is guarded on `pending`:
  once collected, `agent_id` records who actually took the money and must never be rewritten.
- **An existing collection returns `code: null` and nothing is re-sent.** The customer keeps the code
  they have. Re-issuing on reassignment would invalidate a code they may already be holding and train
  them to expect a fresh one that is not coming. Lost codes are the resend endpoint's job
  (`POST /api/agent/shipments/:id/cod/resend-code`, already existed, rate-limited to 60s).

Pickup still calls `ensure` as a safety net, so the old invariant (a picked-up COD shipment always has
a collection) survives for shipments assigned before this hook existed.

### Why the sweep branches on payment method — SUPERSEDED by step 3e, kept for the reasoning

COD and online shipments now BOTH pass through `agent_delivered`, so the shipment state machine no
longer keeps COD out of the auto-confirm sweep — and a COD shipment sits at `agent_delivered`
precisely while the cash is **unproven**. `autoConfirmStaleDeliveries` therefore loads each
candidate's order and, as of step 3e, routes COD through `CashCollectionService.autoCollectWithoutCode`
instead of the prepaid confirmation path. Until 3e it skipped COD outright.

**The branch on `payment_method` is still load-bearing** — the shipment state alone cannot tell COD
apart, and sending a COD shipment down the prepaid path is exactly the silent ledger hole 3e exists to
close. Step 3d is also what let a *customer* confirm a COD shipment; see 3e for that guard.

## Step 3e, COD auto-confirm at 7 days — DONE (2026-07-16)

Built as analysed below, with the two open product questions settled against the doc's tentative
answers. The analysis is kept because it is the reasoning the design rests on.

**What was built:**

- **`CashCollectionService.autoCollectWithoutCode(shipment)`** — records the collection as
  `collected` with no code, attributed to the system, then delivers the shipment, mirrors the order
  items, recomputes fulfilment + COD payment status and credits both cash liabilities, all in ONE
  transaction. Post-commit it completes the order (`isSettled`, `'system'`/auto) and splits earnings,
  exactly as `collect()` does — the downstream money mechanics cannot tell the two apart.
- **`verification.method: 'code' | 'auto_no_code'`** on `ICollectionVerification`, defaulted to
  `'code'` so every pre-existing row keeps the truth. An uncoded collection carries no customer
  evidence, and a dispute turns on exactly that.
- **The `payment_method === 'cash_on_delivery'` skip in `autoConfirmStaleDeliveries` is gone**,
  replaced by a branch: COD routes through `autoCollectWithoutCode`, everything else through
  `_applyDeliveryConfirmation` as before. That method now returns `{ order, applied }` so the sweep
  counts what actually landed rather than what it looked at.
- **Ordering inside the transaction:** `claimCollected` (guarded `pending`) first — the double-collect
  guard, and the same write order `collect()` takes — then `applyCustomerConfirmation` (guarded
  `agent_delivered`). The second guard is load-bearing: the agency may have moved the shipment to
  `failed` since the sweep read it, and a failed delivery must never be auto-collected, so a null
  there aborts and rolls the claim back.
- **No collection → refuse and log loudly.** A COD shipment stale at `agent_delivered` with no
  collection has no expected amount to record; confirming it anyway would create the very ledger hole
  this step exists to close.

**The two design questions, settled 2026-07-16 — both AGAINST this file's earlier lean:**

1. **No `CodDiscrepancy` is raised.** The doc said "probably yes"; the model says otherwise. An *open*
   discrepancy blocks the agency's rolling-reserve releases (`releaseMaturedReserves` →
   `hasOpenForAgency`), and at auto-collect nothing has actually gone wrong — a customer who would not
   read out a code is not the agency's failure. If the cash never arrives, the existing
   deposit-deadline worker opens `late_deposit` on its own, which is what it is for. Visibility comes
   instead from `verification.method`, a distinct timeline description, and `verificationMethod` on the
   `cod.collection.recorded` payload.
2. **No trust penalty.** Trust gates COD eligibility and the exposure multiplier, so penalising this
   would cut off agents working uncooperative areas for something outside their control. The failure it
   might hint at — the agent pocketing the cash — is already penalised where it is observable, by
   `late_deposit` (−5) and `cash_shortfall` (−20).

**A second, worse hole found and fixed while doing this: `confirmDeliveryByCustomer` had no COD
guard.** A COD customer could click confirm-delivery instead of releasing their code, marking the
shipment `delivered` with its collection still `pending`. Same silent ledger hole, and worse — the
agent's cash liability is never credited at all, so even the deposit-deadline worker cannot see it,
and the auto-confirm sweep never will either (the shipment has left `agent_delivered`). It became
reachable in step 3d; before that the state machine kept COD out of that path. Now rejected with
`SHIPMENT_CONFIRMATION_NOT_ALLOWED`, pointing the customer at their code.

**Still owed:** the money movement itself (liability credit, split, completion) is verified only by
compile + boot — the harness is DB-free, so only the pre-transaction guards are covered (3 asserts;
green at **75**). This wants a Mongo-backed integration test along with the rest of the COD flow.

### The original analysis (kept — it is why the design looks like this)

**What the product owner asked for (2026-07-16):** a COD shipment should auto-confirm after 7 days
*even if the code never reached the backend*. The reasoning is sound: a customer can pay in cash and
still not produce the code — phone not to hand, or simply unwilling. The agent's duty is the other
half: **an agent who was NOT paid must move the shipment to `failed` → `returned`.** Leaving it at
`agent_delivered` for seven days is therefore an implicit assertion that the cash WAS collected.
Proposed guard: check the agent's cash deposit to the agency.

### Correction to an earlier claim in this file — I had the danger wrong

It was previously written here (and told to the product owner) that auto-confirming COD would
"release every actor's earnings against money nobody collected". **That is false.** COD allocations
carry `requires_cash_settlement: true`, and `findMaturedHeld` requires `cash_settled_at`, which is
only stamped when an admin confirms an AgencyRemittance and the FIFO settlement covers that
collection. **COD earnings can never release until the platform physically holds the cash.**

The real failure of a naive auto-confirm (flip the status, skip the collection) is different, and
quieter:

- `splitCodCollection` is triggered from `collect()`. No collect → **no allocations at all**, so
  nobody ever earns from that delivery — including the vendor.
- The CashCollection stays `pending` forever. `recoverMissedCodSplits` only looks at
  `status: 'collected'`, so the recovery sweep never picks it up.
- `recomputeCodPaymentStatusInSession` also only runs inside `collect()`, so the order's
  `payment_status` never becomes `paid` despite the order being delivered and completed.

So the money does not get wrongly released — it silently falls out of the ledger, leaving a delivered,
completed order that nobody was paid for and whose payment status is a lie.

### The proposed deposit guard cannot work — it is circular

Verified, and it kills the guard as specified:

- **`AgentDeposit` has no `shipment_id` or `collection_id`** — it is a bulk `(agent, agency, amount)`
  row. There is no way to ask "has the agent deposited the cash for THIS shipment".
- `AgentDepositService.record` bounds the amount by the agent's `CodCashAccount` balance **and** by
  the contract's `cod.outstanding_balance`. Both are credited **only** by
  `creditCashLiabilitiesInSession`, which runs **inside `collect()`**.

So: to deposit against a shipment, its collection must be `collected`; to be `collected`, the code
must have been submitted. A shipment whose code never arrived can never have a deposit attributed to
it. **The guard can never be satisfied.**

### Recommended design: auto-confirm must go THROUGH the collection, not around it

At 7 days at `agent_delivered` on a COD shipment, record the collection as **collected without code
verification**, attributed to the system. That is the only route that keeps every downstream
mechanism intact:

- credits the agent's cash liability **and** the contract's `cod.outstanding_balance` (step 2);
- runs `splitCodCollection`, so vendor/platform/agency/agent allocations exist;
- marks the shipment `delivered` and recomputes the order's COD payment status;
- earnings **still** wait for the real cash via `requires_cash_settlement` — the safety property holds
  without any new guard.

The liability lands on the **agent**, which is precisely the product owner's intent: they claimed
delivery and had seven days to mark it returned if unpaid. The existing deposit-deadline worker and
discrepancy machinery then handle non-payment, which is what they are for.

**Design points that had to be settled before building — all five resolved, see the summary above:**
1. `ICollectionVerification` currently records `{ location, device_info, ip }` from a code submission.
   An uncoded auto-collection needs to be distinguishable — add a `method: 'code' | 'auto_no_code'`
   (or similar). An uncoded collection is weaker evidence and a dispute turns on exactly that.
   → **Done as `method`, defaulted to `'code'`.**
2. Should it raise a `CodDiscrepancy` for agency/admin visibility? Probably yes.
   → **No** — it would block the agency's reserve releases over a customer's silence. See above.
3. Should it cost the agent trust? An uncoded collection is not misconduct, but it is not proof
   either. → **No** — not the agent's to control; `late_deposit` covers the real risk.
4. What if the agent is over their COD exposure limit at that moment — force it through, or flag?
   (`assertCanTakeCodShipment` gates assignment, not collection, so nothing currently stops it.)
   → **Force it through**, matching `collect()`, which does not check exposure either. The limit is
   admission control at assignment; refusing to *record* cash that physically exists would only make
   the books wrong, and the cash does not disappear because a counter says it should not exist.
5. Reuse `CashCollectionService`'s collect internals rather than duplicating them — `claimCollected` +
   `creditCashLiabilitiesInSession` + the post-commit split are the pieces to lift. → **Done.**

**Then** remove the `payment_method === 'cash_on_delivery'` skip in `autoConfirmStaleDeliveries` — but
only once the above exists, because that filter is the only thing currently preventing the silent
ledger hole described above. → **Done — the filter is now a branch, not a skip.**

## Step 3f, the agent→agency handover — DONE (2026-07-16)

**The gap, asked about by the product owner and confirmed in the code:** we could prove the customer
paid the agent (the delivery code) and prove the agency paid the platform (declare → admin confirms,
with an external transfer reference). We could NOT prove the middle leg. `POST /api/agency/cod/deposits`
was `requireRole(['agency'])`, single-step, and the model said so outright: *"recording IS the
confirmation — the agency is the receiving party."* The agent's whole COD surface was read-only.

That one-sidedness had teeth. An agency that under-recorded (or never recorded) left the agent still
carrying the liability, still short of headroom, and — after `DEPOSIT_DEADLINE_DAYS` — wearing a
`late_deposit` trust penalty for cash they had handed over. They could not dispute it: `raised_by`
was `system | agency | admin`, with **no `agent`**. The chain had no way to represent "the agent says
this is wrong". Note the platform's own money was never at risk (collect credits agent and agency
independently; the agency stays liable regardless) — this was always an agent-vs-agency exposure. But
the platform pays every actor and penalises the agent automatically, so an unfalsifiable record was
the platform taking the agency's side by default.

**What was built:**

- **Two-step deposits, mirroring `AgencyRemittance`.** `AgentDeposit` gains
  `status: declared | confirmed | rejected`. The agent declares; the receiving party confirms.
  **Only a confirmed deposit moves money** — a declaration is a timestamped claim, so an agent
  cannot free their own headroom by lying. The agency keeps its one-step `record()` (it IS the
  counterparty, and an agent without the app must still be able to hand cash over); what changed is
  that it is no longer the only way a deposit can exist.
- **`recipient: 'agency' | 'platform'` — the direct route.** A platform deposit does everything the
  agency route does AND what a confirmed remittance does: the agency's liability falls too and the
  cash is FIFO-applied to that agency's collections. The cash physically skipped the middle leg, so
  the ledger does too. Both routes land at agent 0 / agency 0 / platform holding the cash, which is
  why one row serves both. Reference required (the platform isn't at the handover). Product decision:
  **always available**, no precondition.
- **`assertPlatformIsStillOwed`** — the correctness guard "always available" needs. Agencies are
  liable whether or not their agent has paid up, so a diligent one may already have remitted this
  cash from its own pocket; then the platform is square and the agent genuinely owes the AGENCY.
  Taking it again would leave the platform holding it twice and owing the agency a refund, which
  this ledger does not model. Bounded by the agency's live liability, and the error names the
  remainder. It only fires when paying the platform would be *wrong*.
- **`raised_by: 'agent'`** + `POST /api/agent/cod/discrepancies`. The recourse that did not exist.
- **`deposit_not_confirmed`** (system, one per deposit): the agency ignored a declaration past
  `DEPOSIT_CONFIRM_DEADLINE_DAYS`. **No trust penalty** — the agency is at fault. It does carry the
  reserve block every open discrepancy carries, which is the only automatic pressure to answer.
  Product decision: **yes, block** — unlike the uncoded-collection case in 3e, this IS the agency's
  fault and both answers are one call.
- **Late-deposit suppression.** `flagLateAgents` now subtracts open declarations from the balance and
  anchors the FIFO age on the UNCOVERED amount. An agent who declared is not penalised for the
  agency's silence. The griefing vector closes itself: a rejection stops covering immediately, so a
  false claim just restarts the agent's own clock. `DEPOSIT_CONFIRM_DEADLINE_DAYS` is deliberately
  ≤ `DEPOSIT_DEADLINE_DAYS` for the same reason.
- **Ledger:** a direct deposit debits the agency as `entry_type: 'remittance'`, `ref_type:
  'agent_deposit'` — both already in the enums, no schema change. In substance it IS a remittance;
  the evidence is just an agent's deposit rather than an agency's transfer.

**⚠️ `npm run migrate:agent-deposits` MUST run before this deploys.** Mongoose applies a default on
*hydration*, not to what is stored, so a legacy row (no `status` field) reads back as 'confirmed' but
is **invisible** to any query filtering `status: 'confirmed'` — the agency deposit list, the admin
queue and `sumOpenDeclarationsForAgent` all filter on status. Idempotent, `--dry-run` supported; the
dry-run found 2 legacy rows on the local Mongo.

**Still owed:** the money movement is compile+boot only, as ever. Asserts cover the reachable guards
(the direct-payment bound in both directions, the wrong-contract guard surviving the direct route, the
reference rule). `confirm`/`reject` and the worker's suppression arithmetic need Mongo — they load
documents before their guards.

## Step 3g, deposit notifications — DONE (2026-07-16)

Closes the "nobody is told" gap 3f left. Product decision: **full agent notification stack** (agents
had none at all — only device tokens) plus the fair set of events on both sides.

- **A third notification stack for agents**, mirroring the agency one 1:1 (model, preference,
  repository, catalog in en/fr/pt/es/ar, event handler, consumer, list/read + preferences routes,
  FCM `/api/agent/devices`). Registered in `server.ts`. See the notifications section in CLAUDE.md.
- **Agent is notified on:** `cod.deposit.recorded` — split on `declaredAt` into `cod.deposit.recorded`
  (the agency recorded a hand-over the agent never declared: the detection message, the only way an
  agent spots an under-recording) vs `cod.deposit.confirmed` (they answered the agent's own claim);
  and `cod.deposit.rejected` (their late-deposit clock restarts, so the copy says so).
- **Agency is notified on:** `cod.deposit.declared` (they are on a 2-day clock we flag them for) and
  the direct-to-platform case of `cod.deposit.recorded` (their liability fell without them acting).
  `cod.deposit.recorded` is now consumed by BOTH the agent and agency handlers, each no-oping on
  payloads that are not theirs — the shared-event pattern the `connection.*` events already use.
- **Payload enrichment:** `cod.deposit.*` now carry `declaredAt` and `rejectionReason`, so a handler
  never has to re-read the document. `declaredAt` is the load-bearing one — it is what splits recorded
  from confirmed.
- **Two route-name traps documented in code:** agent FCM tokens are `/api/agent/devices` (plural),
  NOT `/api/agent/device` (the agent domain's device *capabilities*); and notification preferences are
  `/api/agent/notification-preferences`, NOT the agent domain's own `/api/agent/preferences`.

Tests: 5 catalog-rendering asserts (completeness, amount/actor present, recorded≠confirmed, reason
surfaced, real localization). `npm run test:agent-domain` green at **88**. The dispatch path itself
needs Mongo (prefs + entity lookups before any branch), so it is compile+boot verified like the rest.
**WhatsApp templates** (`agent_cod_deposit_*`, `agency_cod_deposit_*`) still need creating in Meta
Business Manager before that one channel delivers — in-app/push/email/telegram work today.

## Step 4, the missing controllers/routes — DONE (2026-07-29)

Prompted by an agent-app frontend review that found three planned screens unbuildable. The three
defects it named were real and are fixed; item 3's controllers were built in the same pass because
the KYC one blocks everything else.

**The three agent-app defects.**

- **`PATCH /api/agent/settings` was unreachable.** Four routers stack on `/agent`; billing mounts at
  `api/index.ts:68` and the agent-self router at `:185`, both declared `/settings`, and Express
  matches in mount order. Requests meant for the agent-domain handler were validated against
  billing's schema and **400'd on a required `notifyDaysBeforeExpiry`** — so
  `auto_accept_assignments` had never been settable, and both branches reading it in
  `ShipmentAssignmentService` (`:383`, `:909`) were dead in production. Billing keeps `/settings`
  (symmetric with vendor/agency and already documented); the agent-domain pair moved to
  **`GET|PATCH /api/agent/dispatch-settings`**. A comment at the mount records why, because the
  collision is silent and will otherwise recur.
- **`max_concurrent_shipments` was a phantom.** Accepted by Zod, clamped in the service, then
  dropped by the strict Mongoose cast because `SettingsSchema` never declared it — a 200 describing
  a write that did not happen. Removed. The real cap is `capacity.max_active_shipments`, written by
  `AgentPlanCapacityConsumer`, and it is now **exposed read-only** as `capacity` on the profile DTO
  so the app can render "3 of 20" without inventing a control for it. An `as Partial<IDeliveryAgent>`
  cast was what hid this from the compiler; it is gone.
- **`preferences` wrote flags nothing read.** `notify_on_assignment` and
  `notify_on_shipment_update` had zero readers, and were worse than inert: the real gating is
  `AgentNotificationPreference.preferences.assignmentOffers`, so switching them off returned 200 and
  changed nothing. Both removed from the schema and the model. `navigation_app` stays, documented as
  client-consumed.

Also corrected: the roster DTO reported `working_state.active_shipment_count` while admission
control uses `capacity.active_shipment_count`. Two independently-maintained counters, one of them
compare-and-set on accept — only that one is now reported.

**Item 3's controllers.**

| Surface | Route(s) | Note |
|---|---|---|
| KYC | `PUT /admin/agents/:agentId/kyc` | **The unblocker.** `kyc.status` defaults to `unverified`, eligibility passes only on `verified`, and nothing but the seed script could write it — so in any non-seeded environment no agent could accept an offer at all. |
| Platform ban | `PUT /admin/agents/:agentId/ban` | |
| Agent COD pool | `PUT /admin/agents/:agentId/cod-threshold`, `GET .../cod-allocation`, `GET /agent/cod/allocation` | Pool bounds (`COD_THRESHOLD_*`), not the contract bounds `SetCodLimitSchema` uses. |
| Contract terms | `PATCH /agency/agents/:membershipId/terms` | `updateEmployment` is now a thin alias. `fee_split` coherence throws the previously-unthrown `CONTRACT_FEE_SPLIT_INVALID`; the patch is merged over the stored split first, so a partial update that changes only `model` is legitimate. |
| Status-request inbox | `GET|POST /agency/agents/status-requests[/:requestId/{resolve,cancel}]`, `GET|POST /agent/memberships/status-requests[/:requestId/{resolve,cancel}]`, `POST /agent/memberships/:membershipId/transitions` | Closes the dead end: an agency `DELETE` raised a pending deactivation nobody could resolve. |
| Agency pause | `POST /agency/agents/:membershipId/pause` | The matrix granted it unilaterally; no route existed. |

`resolveRequestAs` is the only safe HTTP entry point for a resolution: `resolveRequest` deliberately
does not check who is resolving (it is also the auto-approval path, where there is no counterparty),
so the wrapper adds the scope check (404, not 403 — the caller should not learn a foreign request
exists) and the consent check, throwing the previously-unthrown `CONTRACT_STATUS_REQUEST_NOT_YOURS`.

**A pending request has two exits, one per party.** `cancelRequestAs` is `resolveRequestAs` with
both guards inverted: same 404 scope rule, but it refuses everyone *except* the author (same
`CONTRACT_STATUS_REQUEST_NOT_YOURS`, opposite condition), and writes `state: 'cancelled'` through the
same `state: 'pending'` compare-and-set — so a cancel racing the counterparty's approval yields one
winner and a clean 409 for the loser. Without it, a termination proposal could only be retracted by
asking the other party to reject it. It touches **no** contract, appends **no**
`AgentMembershipEvent` (the enum has no fitting value, and a cancelled request never moved the state
machine — the request row's own `state`/`resolved_by_role`/`resolved_at` is the trail), runs **no**
`evaluateDeactivationBlockers` (cancelling moves nothing, so outstanding COD is irrelevant), and
sends **no** notification (consistent with lifecycle transitions — only the handshake pair notifies).
Both inbox listers return pending rows in *both* directions, so `requestedByRole` is what tells a
client which verb to render.

**Deviation: settlements.** `ContractSettlement` was **deleted rather than wired up.** It was fully
orphaned — nothing imported it, so `mongoose.model()` never ran and it was not registered at boot —
and both its directions are already served: `cod_remittance` by `AgentDeposit` + `CodCashLedger`
(with `AgentDepositService.confirm` already drawing the contract balance down via `recordSettlement`),
and `agent_payment` by the locked decision that the platform pays the agent through the earnings
module. Building it would have been a third ledger for movements already recorded twice, with the
balance to keep in agreement. What was genuinely missing — a **per-contract** view — shipped instead
as `GET /agency/agents/:membershipId/settlements` and `GET /agent/memberships/:membershipId/settlements`,
projected from the deposits. `CONTRACT_SETTLEMENT_INVALID_AMOUNT` (declared, never thrown) went with
it; `CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING` stays, since `AgentDepositService` throws it.

Verification: `npx tsc --noEmit` and `npm run lint` clean, `npm run test:agent-domain` green at
**115** (was 96 — 19 added for fee-split coherence, counterparty consent and the gate validators),
`scripts/test/test-profile-mappers.ts` green at 19 (it had been failing to compile since the
file-detail refactor made those mappers async; repaired in the same pass), and `src/app.ts` loads.

## Step 3h, agent-driven status transitions — DONE (2026-07-30)

Product decision: **an agent drives their own shipment's status.** Until now `PATCH
/api/agency/shipments/:id/status` was the only generic status endpoint in the codebase, so the
person physically collecting, driving and knocking on the door had to have an operator mirror what
they said. On a **prepaid** order that was worse than clumsy: `agent_delivered` is both the only
route to `delivered` and the hook that pays the agent (see the earnings split above), so an agent
could not finish a job or trigger their own earnings without the agency.

`POST /api/agent/shipments/:id/status` now exists. `ShipmentService.updateStatus` and the new
`updateStatusByAgent` are thin ownership-scoping wrappers over a shared private `_transitionStatus`
— two wrappers rather than one method with an actor parameter, because the agent path takes a
`failure` argument that must not be reachable from the agency call. The actor is a discriminated
union (`{role:'agency',agencyId,userId} | {role:'agent',agentId,userId}`), which selects the scoped
read, the `status_history.changed_by_role` value and the audit's `actorRole`. It does **not** select
a transition map: both actors share one.

- **There is ONE transition map, `TRIGGERABLE_TRANSITIONS`, shared by both actors** — the former
  `AGENCY_TRIGGERABLE_TRANSITIONS` renamed. The first cut of this step gave the agent a near-copy
  with `handing_over` removed; the product owner corrected that the same day: **a reassigned
  shipment is not a second-class one**, and a replacement agent has the same rights as any other.
  Two byte-identical maps would only have invited a reader to hunt for a difference that is not
  there, so they were collapsed. `handing_over → picked_up` is reachable from the agent endpoint
  because acceptance binds `agent_id` while the status is still `handing_over`
  (`bindAgentIfUnassigned` + `OFFERABLE_STATUSES`), which also satisfies the
  `picked_up`-requires-`agent_id` guard. If the two actors ever genuinely need to diverge, split the
  map and select on `actor.role` in `_transitionStatus` — do not add a role-specific exception to
  the shared one.
- **Step 3d's reasoning carries over unchanged.** `agent_delivered` is still "I am at the door", the
  COD guard still rejects `delivered` as a status change, and `agent_delivered → failed` is still
  the escape hatch for a customer who will not pay — it is just that the agent can now reach all
  three themselves.
- **Both actors now write through a from-guarded CAS** (`ShipmentRepository.applyStatusChangeIfCurrent`)
  under `runInTransactionWithRetry`; a miss is the new `409 SHIPMENT_STATUS_CONFLICT`. This was not
  optional. `applyStatusChange` is an unguarded `findByIdAndUpdate` that was only ever safe because
  the agency was the sole writer: with two actors, both can read `in_transit`, one write
  `agent_delivered` and the other `failed`, and the loser's post-commit block — the earnings split,
  the capacity release, `handleShipmentReturnedInSession` — still fires for a status nobody is in.
  The unguarded method is **kept** for `CashCollectionService.collect`, whose race is already closed
  by `claimCollected`. Every side effect now reads the document the CAS returned rather than a fresh
  `findById`, so a burst of transitions yields one honest verdict each.
- **`delivery_failures`** is a new append-only array on the Shipment: an optional
  `ShipmentFailureReason` + `note` (≤200) the agent may attach to `failed`/`returned`, written in
  the same atomic update as the transition. Append-only because `failed → in_transit → failed →
  returned` is an allowed cycle and each attempt is the record. The enum is deliberately **distinct**
  from `AgentCancellationReason` — half of that one (`vehicle_breakdown`, `personal_emergency`,
  `too_far`, `safety_concern`) describes an agent who cannot continue, whose correct action is
  cancelling; offering those as `failed` reasons invites an agent to strand a parcel on themselves.
  The agency endpoint stays reason-less.
- **New event `shipment.agent_status_changed`** → four agency notification situations
  (`shipment.agent.{picked_up,delivered,failed,returned}`), gated on the existing `shipmentAssigned`
  preference. `in_transit` is excluded as a routine progress ping. Four situations rather than one
  parameterised by status: the render context is built before the agency's language is resolved, so
  a status label would leak English into a localized body.
- **geo-tracker untouched.** `actor_role` is a free TEXT column there, its handler validates only
  action/outcome, and `TerminalStatus()` switches on outcome+action — and `AgentCodController`
  already sent `'agent'`. A one-sided change.

Two pre-existing hazards this makes *more likely* rather than creating, flagged rather than fixed:

1. **`agent_delivered → failed → returned` books delivery-priced earnings for a parcel that came
   back.** `splitShipmentDelivery` early-returns on `existsForSource('shipment', id)`, so it does not
   double-pay — but the `returned` call no-ops and the allocations keep the `delivered` numbers
   instead of the agency's `rto_fee` plus the vendor refund. Reachable by an agency today; it is now
   a three-tap sequence in one app. The fix is to reverse-and-re-split when the recorded source
   outcome disagrees with the shipment's terminal status.
2. **A COD shipment parked at `failed` keeps its pending collection** (only `returned` runs
   `handleShipmentReturnedInSession`), so it counts against the agent's own COD headroom and they
   start getting refused new dispatches with no obvious cause. Documented agent-side; an
   agency "stuck at failed" view is the natural follow-up.

Verification: `npx tsc --noEmit` and `npm run lint` clean, `src/app.ts` loads with the new consumer
registered, and `npm run test:agent-shipment-status` is green at **32** (the transition map, a guard
that no system-only status — `delivered` above all — is directly settable, the map↔schema drift
guard, the enum-distinctness assertions, the Zod rules, and `assertAgencyCatalogComplete()`, the
only DB-free check that all four new situations carry copy in all five languages).

## Not built at all

1. ~~**The agent's cut on PREPAID orders.**~~ **Done 2026-07-29 — step 3 is complete.** Built as
   decided: the agency's delivery fee is **deferred to delivery time**. `splitOrder` still computes
   the fee (the vendor's net nets it off) and now snapshots it onto each shipment, but allocates
   only commission + vendor net; `EarningsSplitService.splitShipmentDelivery` divides that snapshot
   between agency and agent at `agent_delivered`, mirroring `splitCodCollection`. What landed
   beyond the sketch above:
   - **`EarningsSourceType: 'shipment'`** added (plus a `delivery_split` ledger reason code), so an
     agency with two shipments on one order gets a row per run instead of the summed
     `(order, agency)` row that existed to dodge the uniqueness index.
   - **`onOrderCompleted` sweeps shipment-sourced rows** alongside `cod_collection` — this is what
     makes the 7-day hold uniform, and the trap that would have held prepaid agent money forever.
   - **`IShipment.delivery_fee_snapshot`** — new. Deferring meant computing the fee at two moments
     from a *mutable* agency policy; without a snapshot the vendor's already-held net and the
     agency's payout could not be made to reconcile. COD writes it too, for audit.
   - **`returned` also splits.** Per the product owner ("check the agency policy for that"), the
     agency earns its `additional_fees.rto_fee` (clamped to the reserved fee), the agent their
     contracted share of that, and the remainder is credited **back to the vendor** — so an order's
     gross reconciles whichever way the run ended. `failed_delivery_fee` stays deferred: `failed`
     is not terminal, so it needs its own charge path rather than a slice of this one.
   - **`EarningsRefundService.onOrderRefund`** — reverses every source an order produced
     (`order` + `shipment` + `cod_collection`), not just its own row. Also closes a pre-existing
     gap: nothing reversed COD collections on refund.
   - **Recovery sweep stage 3b** (`recoverMissedDeliverySplits`) — the delivery split is
     post-commit best-effort, so it needs the same safety net COD has.
   - **Agent earnings surface** (was item 4 below): `GET /api/agent/earnings`,
     `POST|GET /api/agent/earnings/payout`, and `GET|PUT /api/agent/payout-methods`. Everything
     under it already handled `'agent'`; only the entry point was missing, so agents accrued a
     balance they could neither see nor withdraw — and the auto-payout sweep had no method to pay.
   - `EarningsQuoteService`'s `earningUnavailable: 'prepaid'` branch is **retired** — the quote is
     now answerable for every physical shipment.

   **Follow-up, 2026-08-05 — the agency can now see its own side of the same fee.** The split
   arithmetic was half-named: `applyFeeSplit` gave the agent's cut a home, while the agency's
   remainder existed only as two inline expressions inside `EarningsSplitService`
   (`earnedFee - agentCut`, `deliveryFee - agentCut + codFee`) — so there was nothing an agency
   could be quoted from without writing the formula a third time. Now:
   - **`resolveEarnedFee` moved** from `EarningsSplitService` into `EarningsQuoteService` (the split
     imports it back — the only direction that does not close a cycle, since the split already
     delegates `computeAgentCut` there), joined by new pure `computeCodHandlingFee` and
     `computeAgencyCut`. Both split paths call them; **no behaviour changed**, the arithmetic is
     simply defined once. `npm run test:earnings-quote` (29, DB-free) re-derives what each split
     allocates from those helpers, so the two can no longer drift silently.
   - **`quoteAgencyForShipment(s)`** feeds `agencyEarning` on the agency's shipment list and detail:
     `earnedFee − agentCut + codHandlingFee`, itemised. It withholds (`agencyEarningUnavailable:
     'no_agent'`) until an agent accepts, since before that there is no `fee_split` to subtract. A
     missing *contract* is **not** withheld — that is a cut of 0 and the agency keeps the fee, which
     is what the split does.
   - Unrelated to the split but shipped alongside it: `paymentMethod` on shipment **list** rows
     (previously detail-only, though the query already loaded it), and
     `CashCollectionService.getProjectedCodSummary…`, which answers the COD amount **before** an
     agent accepts. The collection row is created at acceptance, so the old read returned `null`
     exactly when an agency was deciding who to send; the projection reports `status: null` to mark
     itself as such rather than inventing a fourth `CashCollectionStatus`.
2. ~~**Trust composite engine** + nightly worker~~ — ⚠ **ENGINE BUILT 2026-08-21
   (Phase 6 Step 3). THE CUTOVER IS NOT DONE and is the one open behavioural item.**

   > `AgentTrustService` (pure `computeComposite` + I/O `collectSignals`) and
   > `AgentTrustRecomputeWorker` (nightly, `AGENT_TRUST_RECOMPUTE_CRON`, lock-guarded)
   > are built, registered and green at `npm run test:agent-trust` (35). All five
   > factors have a real source — the three rating factors got theirs when
   > `modules/reviews` shipped (Phase 6 Step 10). An immediate `recomputeOne` fires
   > after a COD discrepancy resolution and after a review moves an agent's
   > aggregate, which **closes the safety regression flagged below**.
   >
   > **What has NOT happened is the decision this refactor locked**: *"composite
   > REPLACES the delta model; `CodTrustService.applyEvent` stops writing the
   > score."* The worker writes `trust_signals.composite_score` only;
   > `cod.trust_score` is untouched and `CodExposureService` still reads the delta
   > model. Phase 6 **D-2** made the shadow deliberate — the cutover was to be *"a
   > decision taken against observed numbers instead of a deploy"* — and the
   > observed numbers said not yet. See the close-out ledger at the top of this
   > file for both blockers and the trigger, and `npm run audit:trust-shadow` for
   > the instrument.
3. ~~**Controllers/routes** for: agent threshold, contract terms, settlements,
   KYC/ban admin, status-request inbox.~~ **DONE 2026-07-29** — see the step 4 section below for
   what shipped and the one deliberate deviation (settlements).
4. ~~**Migration**~~ — ✅ **CLOSED 2026-08-21 as NOT APPLICABLE PRE-PRODUCTION.**

   > **There is no production data.** Everything in every database is development data that will
   > be deleted and repopulated at the production cutover — owner decision **D-5**, recorded in
   > [`PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md`](../PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md).
   > A rename and a backfill are "carry existing rows across" jobs with no rows worth carrying, so
   > neither is written. **Index migrations are unaffected** and still matter: `autoIndex` is off
   > in production, so the first deploy against an empty database still needs them.
   >
   > Measured in the dev database on 2026-08-21 before closing this (plan P-11 … P-14):
   >
   > - The **code is already post-rename** — `collections.ts:231` reads `agent_agency_contracts`
   >   and `agent_agency_memberships` appears **nowhere** in `src/`.
   > - The old collection **was still in dev** with 7 documents, **zero** of whose `_id`s appeared
   >   in `agent_agency_contracts`. They carried the pre-refactor shape (`status: "approved"`,
   >   `cod.max_exposure_override`), last written 2026-07-15 — orphaned and inert.
   >   ✅ **DROPPED 2026-08-21**, on the owner's instruction, after a JSON backup of all 7. The
   >   contracts collection did not move (7 before, 7 after) and `test:agent-domain` stayed
   >   **211 / 0**. `agent_agency_memberships` no longer exists in the dev database.
   > - **`cod.outstanding_balance` is populated, not zero** — so the silent-no-op this item warned
   >   about is not present. The COD late-deposit sweep is demonstrably writing rows
   >   (open `late_deposit` discrepancies at 8 000 and 1 200).
   > - ⚠ **The derivation stated below is the BACKFILL's formula and is not what the application
   >   maintains.** Re-deriving `sum(collected) − sum(deposits)` from current rows disagrees with
   >   one of seven contracts, because `seed:cod-shipments --clean` removes source rows while
   >   `cod_cash_ledgers` is append-only. The invariants that **do** hold exactly are
   >   `cod_cash_accounts.balance == Σ its ledger rows` and `Σ contract slices == the agent's pot`.
   >   Assert those, never the re-derivation.

   *Original text, kept because the reasoning is still the record of what was intended:*
   collection rename `agent_agency_memberships` →
   `agent_agency_contracts`, status remap (`approved`→`active`,
   `removed`→`deactivated`), `cod.max_exposure_override` → `cod.threshold`,
   capacity backfill from `settings.max_concurrent_shipments`. Must be
   idempotent with `--dry-run`, like `migrate:agent-memberships` *(which no longer exists — deleted
   2026-08-23, see the Known-and-accepted table)*.
   **Note (2026-07-29):** `settings.max_concurrent_shipments` no longer exists in code — the
   validator that still accepted it was removed, since the strict Mongoose cast had been silently
   dropping it all along. The migration must therefore read the raw field straight out of Mongo,
   not through the model.
   **Plus `cod.outstanding_balance`, which is now load-bearing** — see the ⚠️ above. Skip it and
   every `POST /api/agency/cod/deposits` 422s, because the guard added in step 2 bounds deposits by a
   balance that would still read 0. Derive per (agent, agency):
   `sum(CashCollection.expected_amount where status='collected') − sum(AgentDeposit.amount)`.
   Also backfill `cod.max_threshold` on the agent: it defaults to `COD_THRESHOLD_MIN` (0), and an
   agent whose pool is 0 can hold no cash at all, so every existing agent must come out of the
   migration with a pool at least equal to the sum of their contracts' thresholds.
6. **Tests** — the 7 named scenarios, incl. the §1 worked example and the
   concurrent-allocation race.
7. **E2E** against live Mongo — the 8-step scenario.
8. ~~**Docs** — `ARCHITECTURE.md` / `CLAUDE.md` still describe the old model.~~
   ✅ **DONE 2026-08-22 (Phase 6 Step 16).** Both files carry the contract
   vocabulary, the seven statuses including `withdrawn`, the shared-pool rule in
   place of the per-agency cap, and a new § *Agent trust score* in `CLAUDE.md`
   stating plainly which of the two scores is live. `CLAUDE.md`'s in-flight banner
   was **shrunk, not deleted** — it now names only the three items still open, per
   the rule that a banner removed while an item is silently open is worse than the
   banner.

## Decisions locked (do not re-litigate)

- **Trust score:** composite REPLACES the delta model. `cod.trust_score` becomes
  a pure function of five factors; `CodTrustService.applyEvent` stops writing the
  score; `CodTrustEvent` stays as the append-only signal log feeding the COD
  factor. Weights (product-supplied, in config): **COD 30, activity 20,
  customer 30, agency 10, vendor 10**. Recompute: **nightly batch only**.
- **Agent payment:** extend the earnings module to `owner_type: 'agent'` (NOT a
  contract-local balance). **Extended 2026-07-16 with the debtor settled: the
  PLATFORM pays the agent**, out of the agency's delivery fee at split time, and
  agents withdraw through the ordinary payout pipeline. The original decision
  fixed where the balance lives but not who owes it, and every contract-side
  docstring assumed the agency — see the step 3 section above for what that
  invalidates.
- **Contract-level threshold lowering** below that contract's outstanding
  balance is hard-rejected, mirroring the agent-level rule.
- **Platform ban is an override, not a cascade** — it does not walk contracts
  flipping each to paused (lossy: un-banning couldn't restore which were already
  paused). Every gate consults the flag instead. A contract `reactivate` while
  banned WRITES `active` but the agent stays unusable.
- **`vehicle_info` already existed** (`bike|car|van|truck`) — it IS the §6b
  delivery-method capability. Do not add a duplicate.
- **Capacity is a counter, not derived.** This reverses the earlier design
  deliberately: you cannot atomically check-and-increment a computed value.
  `reconcile()` handles the drift that motivated the old approach.

## Consequences flagged to the product owner, unresolved

- Because `cod.trust_score` *is* the composite and `CodExposureService` reads it,
  **customer ratings now influence COD cash limits**.
- ~~With **nightly-only recompute**, a cash shortfall no longer throttles an
  agent's limit until the next night — today the −20 penalty is instant. This is
  a safety regression; consider an immediate recompute on COD-negative events.~~
  ✅ **CLOSED 2026-08-21 (Phase 6 Step 3.5), as suggested.**
  `AgentTrustRecomputeWorker.recomputeOne(agentId)` fires from
  `CodTrustService.applyEvent` — the choke point every COD trust movement passes
  through, so a third caller inherits it — and from `ReviewService` when a review
  moves an agent's aggregate. It is deliberately **not** behind the sweep lock (a
  single-document write should not queue behind a batch) and is best-effort: it
  catches its own failure so a trust recompute can never fail the COD write that
  triggered it. The nightly sweep is the backstop, not the mechanism.
  **Note this closes the regression in the SHADOW.** Until the cutover it moves
  `composite_score`, not `cod.trust_score` — so today the instant `−20` is still
  what actually throttles an agent, and the immediate recompute is what makes the
  cutover safe rather than what makes it unnecessary.
- **Settlement-vs-deactivation race** is not covered by a test: cash could be
  collected between a deactivation request and its approval. The re-check at
  approval handles it in principle; unverified.

## Ordering for the next session

1. ~~Fix the 8 errors → `npx tsc --noEmit` clean → `npm run lint` clean.~~ **Done 2026-07-16.**
   (Test harness repaired the same day, pulled forward from §7.)
2. ~~Settlement, COD half — the increment, the decrement, and the §4 gate made real.~~
   **Done 2026-07-16.** The `agent_payment` half is deferred behind step 3, which it depends on.
3. ~~Earnings `owner_type: 'agent'`.~~ **Done for COD 2026-07-16**, along with escrow maturity (3b),
   the shipment confirmation gap (3c), the COD arrival state (3d), COD auto-confirm at 7 days (3e) and
   the agent→agency handover (3f). **Step 3 closed 2026-07-29** with the agent's cut on PREPAID
   orders (§1 under "Not built at all") — agents are now paid on every physical delivery, cash or
   card, and can see and withdraw it.
4. ~~Trust engine + nightly worker~~ **Engine done 2026-08-21.** ⛔ *"…stop `CodTrustService`
   writing the score"* is **NOT done** — the worker runs in shadow. This is the one open
   behavioural item; both blockers and the trigger are in the close-out ledger at the top.
5. ~~Controllers + routes (agent threshold, contract terms, settlements, KYC/ban, status inbox).~~
   **Done 2026-07-29** — see step 4 below.
6. ~~Migration (+ `--dry-run` count against live Mongo).~~ **Closed 2026-08-21.** The two items
   that were never written (the collection rename, the `cod.outstanding_balance` backfill) are
   **not applicable pre-production** under D-5. The three that *were* written are all applied:
   `migrate:status` reads **21 of 21, 0 not applied** as of 2026-08-22, and that includes
   `migrate:agent-deposits`, which this line used to warn had to run before 3f deploys.
7. ⛔ **START HERE:** tests, then E2E — the 7 named scenarios, the §1 worked example, the
   concurrent-allocation race, and the 8-step E2E against live Mongo. Nothing blocks this.
8. ~~Docs.~~ **Done 2026-08-22** (Phase 6 Step 16).
