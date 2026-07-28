# Agent Contract Refactor — IN FLIGHT (compiles; incomplete)

> **Read this before touching `src/modules/agents/`, `src/modules/cod/`, or
> `src/modules/shipments/shipment.service.ts`.**
>
> A large refactor is part-applied. The domain layer is done, the COD cash chain
> is complete and reachable over HTTP, and the mechanism that releases COD
> headroom now exists (agent→agency deposits draw down the contract balance via
> `AgentDepositService` → `recordSettlement`). Still incomplete: the agent's cut
> on PREPAID orders, the trust composite engine, several admin/agent controllers,
> the collection-rename migration, and the doc refresh.
>
> **As of 2026-07-16: `npx tsc --noEmit` and `npm run lint` are both clean,
> `src/app.ts` loads, and `npm run test:agent-domain` is green at 88 assertions.**
> Steps 1–3g below are finished. Steps 3(prepaid)/4–8 are not — see "Not built at
> all" and "Ordering for the next session".
>
> Delete this file when the work below is finished.

## What this refactor is

Replaces the per-agency COD cap with a **shared-pool allocation model**, and
reframes `agent_agency_memberships` as a **contract** with a conditional status
lifecycle.

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
  `AgentAgencyContractModel`) — statuses `pending | rejected | active | paused |
  suspended | deactivated`. `approved` is an ACTION, not a state; approving
  lands in `active`. Terms: `cod.threshold`, `cod.outstanding_balance`,
  `payment.outstanding_to_agent`, `remittance_terms`, `coverage`, `fee_split`,
  `shipment_value_ceiling`.
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

## Not built at all

1. **The agent's cut on PREPAID orders — the last piece of step 3.** COD pays agents; prepaid does
   not. Decided with the product owner: **defer the agency's delivery fee to delivery time** — at
   payment split only commission + vendor net; when the shipment is delivered and the agent is known,
   create the agency and agent delivery-fee rows together, mirroring COD. The blocker (orders that
   could never complete) is fixed above, so this is now unblocked. What it needs:
   - **Hook at `agent_delivered`**, not at customer confirmation. The product owner's requirement is
     that the agent knows what they will earn once the shipment is completed; waiting for a customer
     click could mean never. It is safe because the row is created `held` with no maturity and still
     cannot release until the ORDER completes.
   - **A new `EarningsSourceType: 'shipment'`.** The delivery fee is earned per shipment, and one
     agency can have two shipments on one order — today they are summed into a single `(order, agency)`
     row precisely to dodge the allocation uniqueness index, which a per-shipment allocation cannot do.
   - **`onOrderCompleted` must then also stamp shipment-sourced rows**, the same way it already sweeps
     up an order's `cod_collection` rows. Miss that and prepaid agent/agency money is held forever —
     the exact failure already caught once for COD.
   - `splitOrder` keeps computing the delivery fee (the vendor's net still nets it off); it just stops
     creating the agency allocation.
   See the TODO(agent) in `computeAgencyDeliveryFees`.
3. **Trust composite engine** + nightly worker (see decisions below).
4. **Controllers/routes** for: agent threshold, contract terms, settlements,
   KYC/ban admin, status-request inbox. None of the new surface is reachable
   over HTTP.
5. **Migration** — collection rename `agent_agency_memberships` →
   `agent_agency_contracts`, status remap (`approved`→`active`,
   `removed`→`deactivated`), `cod.max_exposure_override` → `cod.threshold`,
   capacity backfill from `settings.max_concurrent_shipments`. Must be
   idempotent with `--dry-run`, like `migrate:agent-memberships`.
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
8. **Docs** — `ARCHITECTURE.md` / `CLAUDE.md` still describe the old model.

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
- With **nightly-only recompute**, a cash shortfall no longer throttles an
  agent's limit until the next night — today the −20 penalty is instant. This is
  a safety regression; consider an immediate recompute on COD-negative events.
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
   the agent→agency handover (3f).
   Still open from step 3: **the agent's cut on PREPAID orders — START HERE** (§1 under "Not built at
   all"; it is now unblocked, and the `EarningsSourceType: 'shipment'` + `onOrderCompleted` notes there
   are the parts that are easy to get wrong).
4. Trust engine + nightly worker; stop `CodTrustService` writing the score.
5. Controllers + routes.
6. Migration (+ `--dry-run` count against live Mongo). **`migrate:agent-deposits` is written and
   dry-run clean (2 legacy rows locally) but has NOT been applied — it must run before 3f deploys.**
7. Tests, then E2E.
8. Docs.
