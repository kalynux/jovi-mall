# Verification no longer gates work or withdrawals — cross-role

> **Date:** 2026-09-27 · **Breaking:** no request or response shape changed. Two error codes
> stop being returned on some endpoints, one code is gone entirely, one eligibility reason is
> gone, and one existing error appears on new endpoints.

**The owner decision.** Identity verification (KYC) is a **trust badge, not a licence to work**,
and *"we should not block someone's money just because he is not verified."* Two consequences:

1. **An unverified agent can work.** They can contract with agencies, appear in the agency
   directory and be dispatched **prepaid** shipments. Verification gates **cash on delivery only**.
2. **An unverified vendor, agency or agent withdraws their whole balance.** The optional payout
   allowance for unverified owners (added 2026-09-15, inert by default) is **deleted**.

**What still needs verification:** COD. A COD order needs **both** a verified agency (refused at
checkout, unchanged) **and** a verified agent (refused at dispatch, new wording of an old rule).

| App | What it has to do |
|---|---|
| **Agency app** | Stop hiding unverified agents; drop the KYC error from contract screens; handle `AGENT_KYC_NOT_VERIFIED` on COD assignment; label a dormant COD limit; stop treating `kyc_not_verified` as an eligibility reason; payout-limit copy |
| **Agent app** | Drop "get verified to receive deliveries"; say "verify to carry cash on delivery"; handle `AGENT_KYC_NOT_VERIFIED` on accepting a COD offer; payout-limit copy |
| **Vendor dashboard** | Payout-limit copy only |
| **Admin dashboard** | New remedy `verify_agent_kyc` in assignability; KYC gone from eligibility; relabel the KYC action; payout queue verdict is informational |
| Customer app · landing · geo-tracker clients | Nothing to do |

---

## 1. Agent contracts — `AGENT_KYC_NOT_VERIFIED` is no longer returned

`AgentGateService.assertCanHoldContract` now refuses only a missing agent (`404 AGENT_NOT_FOUND`)
or a platform-banned one (`403 AGENT_PLATFORM_BANNED`). These endpoints **no longer return**
`422 AGENT_KYC_NOT_VERIFIED`:

| Endpoint | Side |
|---|---|
| `POST /api/agency/agents/requests` | agency requests an agent |
| `POST /api/agency/agents/:membershipId/approve` | agency approves an agent's application |
| `POST /api/agent/memberships/requests` | agent applies to an agency |
| `POST /api/agent/memberships/:membershipId/approve` | agent accepts an agency's terms |
| `POST /api/v1/agents/transfer` (wi-admin → `POST /api/internal/admin/agents/transfer`) | administrator transfer |

Keeping a handler for the code does no harm — it will simply never fire there.

## 2. The agency directory lists unverified agents

`GET /api/agency/agents/browse` no longer filters on `kyc.status: 'verified'`. Unverified agents
appear with **`kycVerified: false`**. Render it as a badge (optionally "cannot carry COD yet"),
**never** as a reason to hide the row or disable *Request*.

## 3. Eligibility — `kyc_not_verified` is gone

`GET /api/agency/agents/:agentId/eligibility` (and wi-admin's `GET /api/v1/agents/:agentId/eligibility`)
no longer has a `kyc` rule, and `reasons` can no longer contain `kyc_not_verified`. The full set is:

`agent_not_found` · `platform_banned` · `agent_not_active` · `membership_not_approved` ·
`not_available` · `tracking_not_allowed` · `device_location_disabled` · `device_location_unknown` ·
`at_capacity`

The same applies to `details.reasons` on `422 AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT`. Delete any copy
keyed on `kyc_not_verified`.

## 4. COD shipments — `AGENT_KYC_NOT_VERIFIED` appears on assignment

The COD exposure gate now refuses **any COD shipment** to an agent whose KYC is not `verified`,
**before** trust, cash-shortfall and exposure checks. Same code and `details` shape the contract
endpoints used to return:

```json
{
  "code": "AGENT_KYC_NOT_VERIFIED",
  "statusCode": 422,
  "details": {
    "kycStatus": "pending",
    "hint": "An unverified agent may take prepaid shipments but cannot carry cash on delivery until an administrator verifies their identity."
  }
}
```

| Endpoint | Who sees it |
|---|---|
| `PATCH /api/agency/shipments/:id/assign-agent` | agency, manual pick of an unverified agent for a COD shipment |
| `POST /api/agency/shipments/:id/reassign` | agency, same |
| `POST /api/agent/offers/:id/accept` | agent, accepting a COD offer (e.g. one made before their verification was withdrawn) |
| `POST /api/agency/shipments/:id/auto-assign` · `GET …/assignment-candidates` | nobody — unverified agents are **silently absent** from the COD candidate list, like any other COD-refused agent |

Prepaid shipments are never refused for this. **Display `hint`; never parse it.**

## 5. A COD limit on an unverified agent's contract is DORMANT

`PATCH /api/agency/agents/:membershipId/cod-limit`, and approving a contract that carries
`cod.threshold > 0`, no longer fail `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM` for an unverified
agent (their pool is 0, so the headroom check is skipped; the per-contract min/max bounds still
apply). The value is stored but gives **no cash** until the agent is verified.

- **Agency app:** beside the value, show *"inactive until the agent is verified"* when the agent's
  `kycVerified` is `false`.
- **Agent app:** the slice appears in `GET /api/agent/cod/allocation` `contracts[]` while
  `pool.source` is `"not_verified"` and `maxThreshold` is `0`. Explain it the same way.
- **On verification** the pool opens to the plan's value. If the dormant slices add up to more,
  `overAllocatedBy > 0` and `COD_AGENT_EXPOSURE_EXCEEDED` carries `poolBinds: true` — the state a
  plan downgrade already produces; existing handling covers it.

## 6. Payouts — no limit for unverified owners

- `GET /api/{vendor,agency,agent}/earnings` still returns **`payoutAllowance`**, but it is
  **always `null`**. `null` means *no limit*. The field is deprecated and kept for compatibility.
- `POST /api/{vendor,agency,agent}/earnings/payout` takes the **whole** `available` balance for
  everyone. No partial move, no `details.cappedAt` / `capReason`.
- **`409 EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED` no longer exists** (neither reason,
  `allowance_spent` nor `remainder_below_minimum`). Remove its handling.
- Admin payout queue: the owner's `verification: { verified, verdict }` and the ticket's
  `KYC: …` line are still there — **informational only**, they limit nothing.

## 7. Admin dashboard — assignability and the KYC action

`GET /api/v1/agents/:agentId/assignability` (delegated to jovi-mall):

- The `platform` family no longer contains a KYC gate.
- An unverified agent on a COD shipment fails the `contract` gate **`cod_exposure`** with
  `reason: "AGENT_KYC_NOT_VERIFIED"` and `observed.blocker: "kyc_not_verified"`; the raw verdict
  (`contractPolicy.codVerdict`) carries a new `kycStatus`.
- **New remedy action `verify_agent_kyc`**, `params: { kycStatus }` — the only remedy for that
  blocker. Render it as a link to the agent's KYC review (`PUT /api/v1/agents/:agentId/kyc`), not
  as something the agency can do. An unknown remedy action should already render generically; add
  copy for this one.

The KYC review action (`PUT /api/v1/agents/:agentId/kyc`) now means *"may carry cash on
delivery"*, not *"may work"*. Update its label, help text and any confirmation that says the agent
"cannot be dispatched" until verified.

---

## Copy to remove or reword — checklist

**Agent app**
- [ ] "Get verified to receive deliveries" / "You can't take deliveries until you're verified" → *"Verify your identity to carry cash-on-delivery orders"*
- [ ] Any gate that hides the offers list, the agency directory or the *Apply* button for unverified agents
- [ ] "You earn nothing until you're verified" (identity-verification screen)
- [ ] Payout screen: any "withdrawal limit", "remaining allowance", "resets on …" or "verify to withdraw more" copy
- [ ] Handling for `EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED`
- [ ] Handling for `AGENT_KYC_NOT_VERIFIED` on the contract request / accept screens (unreachable now) — keep or add it on **accepting a COD offer**

**Agency app**
- [ ] Directory filter or empty-state copy that implies only verified agents are listed
- [ ] `AGENT_KYC_NOT_VERIFIED` copy on *Request agent* / *Approve application*
- [ ] Eligibility screen copy for `kyc_not_verified`
- [ ] Add: `AGENT_KYC_NOT_VERIFIED` on assign / reassign of a **COD** shipment ("this agent can't carry cash until verified — assign a prepaid shipment or another agent")
- [ ] Add: "inactive until the agent is verified" beside a COD limit on an unverified agent
- [ ] Payout screen: withdrawal-limit copy and `EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED` handling

**Vendor dashboard**
- [ ] Payout screen: withdrawal-limit copy and `EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED` handling
- [ ] No app treats `payoutAllowance: null` as a zero limit (it never was one)

**Admin dashboard**
- [ ] Assignability: copy for remedy `verify_agent_kyc`; no KYC row under the platform family
- [ ] KYC review: relabel from "allow this agent to work" to "allow cash on delivery"
- [ ] Payout queue: present the verdict as information, not as a limit ("capped", "allowance")

Related: [agency/agent-roster.md](./agency/agent-roster.md) ·
[agency/assignment.md](./agency/assignment.md) ·
[agent/identity-verification.md](./agent/identity-verification.md) ·
[admin/agents.md](./admin/agents.md#get-internaladminagentsagentidassignability) ·
[admin/payout-requests.md](./admin/payout-requests.md) · [errors/README.md](./errors/README.md) ·
earlier: [FRONTEND-CHANGELOG-cod-pool.md](./FRONTEND-CHANGELOG-cod-pool.md)
