# Admin — Agent Administration

Platform-level administration of delivery agents: view an agent's full record, change account status,
control the tracking-allow flag, transfer an agent between agencies, and inspect eligibility/history.

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required (cookie or `Bearer`) — see [../auth/README.md](../auth/README.md)
- **Permissions**: `admin` only (`requireRole(['admin'])`)
- **Response envelope**: standard `{ success, data, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

> **Model note.** An agent is a **platform identity**, not an agency-owned record — they may serve
> several agencies at once via `AgentAgencyMembership` rows. Four state axes are kept separate:
> `status` (may the account work — admin-written), `availability` (does the agent want work — agent-written),
> `working_state` (how loaded — system-derived), and `tracking.allowed` (may they be tracked —
> admin/agency-written). See [../agent/agency-membership.md](../agent/agency-membership.md) and
> [../tracking/agent-tracking-policy.md](../tracking/agent-tracking-policy.md).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/agents/transfer` | Move an agent from one agency to another |
| `GET` | `/admin/agents/:agentId` | Agent profile + every membership |
| `PATCH` | `/admin/agents/:agentId/status` | Set account status (activate/suspend/…) |
| `PUT` | `/admin/agents/:agentId/tracking-allow` | Enable/disable tracking-allow |
| `GET` | `/admin/agents/:agentId/tracking-policy` | The tracking policy geo-tracker would see |
| `PUT` | `/admin/agents/:agentId/kyc` | Set the KYC verdict — **required before the agent can be dispatched** |
| `PUT` | `/admin/agents/:agentId/ban` | Ban or unban platform-wide |
| `PUT` | `/admin/agents/:agentId/cod-threshold` | Set the agent's whole COD pool |
| `GET` | `/admin/agents/:agentId/cod-allocation` | The pool, every contract's slice, and the headroom |
| `GET` | `/admin/agents/:agentId/history` | Membership/lifecycle history |
| `GET` | `/admin/agents/:agentId/eligibility?agencyId=` | Assignment-eligibility check for an agency |

> Route order matters: `/transfer` is declared **before** `/:agentId` so it is not read as an agent id.

---

## POST `/admin/agents/transfer`

**Purpose**: Move an agent from one agency's roster to another. **Admin-only** — an agency must not be
able to pull an agent off a rival's roster.

**Auth**: Required · **Permissions**: `admin`

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `agentId` | string (ObjectId) | ✅ | Agent to transfer |
| `fromAgencyId` | string (ObjectId) | ✅ | Source agency |
| `toAgencyId` | string (ObjectId) | ✅ | Destination agency |
| `reason` | string | ❌ | Audit note |

### Example request

```json
{ "agentId": "664agt...", "fromAgencyId": "664agyA...", "toAgencyId": "664agyB...", "reason": "Agent relocated" }
```

### Example success `200`

```json
{ "success": true, "data": { "agentId": "664agt...", "fromAgencyId": "664agyA...", "toAgencyId": "664agyB..." }, "message": "Agent transferred" }
```

> The transfer moves both membership sides as one unit; the source is deactivated before the destination
> threshold is checked against pooled COD headroom, and COD/wage settlement gates still apply.

---

## GET `/admin/agents/:agentId`

**Purpose**: Return the agent's profile and **every** membership (across all agencies).

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Example success `200` (representative shape)

```json
{
  "success": true,
  "data": {
    "agent": {
      "_id": "664agt...",
      "name": "Sam Rider",
      "status": "active",
      "availability": "online",
      "working_state": "available",
      "tracking": { "allowed": true },
      "capacity": { "active_shipment_count": 1, "max_active_shipments": 20 },
      "cod": { "max_threshold": 500000, "trust_score": 82 },
      "vehicle_info": { "vehicle_type": "bike", "color": "red" }
    },
    "memberships": [
      {
        "id": "664mem...",
        "agencyId": "664agy...",
        "status": "active",
        "origin": "invitation",
        "initiatedBy": "agency",
        "termsProposedBy": "agency",
        "termsVersion": 3,
        "awaitingDecisionFrom": null,
        "openTermsProposalId": null,
        "feeSplit": { "model": "percentage", "agentSharePercent": 38, "agentFlatFee": null, "currency": "XAF" },
        "remittanceTerms": { "cadence": "weekly", "dayOfWeek": 5, "dayOfMonth": null, "graceHours": 24 },
        "coverage": { "regions": ["littoral"], "area": null },
        "shipmentValueCeiling": 250000,
        "codThreshold": 200000,
        "codOutstandingBalance": 0
      }
    ]
  }
}
```

Every contract is an `AgentMembershipDto` — full field reference in
[agency/agent-roster.md](../agency/agent-roster.md#agentmembershipdto). **Unpaginated by design**: an
investigation must not lose rows to a page boundary, unlike the agent's and agency's own list
endpoints.

> **Reading a contract's negotiation state during an investigation.** `termsProposedBy` names whose
> terms are currently standing and `termsVersion` counts how many rounds the negotiation took;
> `awaitingDecisionFrom` is non-null only while a `pending` contract is waiting on someone.
> `termsVersion: 0` with `termsProposedBy: null` means terms were **never stated** — either a bare
> agent join request, or a pre-migration row whose fee split could not pay (see
> `npm run migrate:contract-terms`). Such a contract cannot be approved by either party until the
> agency proposes; that is deliberate, not a stuck record.
>
> `openTermsProposalId` is **always `null` here** — this endpoint does not resolve proposals. The
> parties' own `/terms-proposals` endpoints are authoritative for that.

> Exact field set is defined by the agent domain (`src/modules/agents/`). Treat unknown fields as additive.

---

## PATCH `/admin/agents/:agentId/status`

**Purpose**: Set the agent's account status. Memberships are intentionally left intact so reinstatement
restores them.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | string | ✅ | New account status (e.g. `active`, `suspended`) |
| `reason` | string | conditionally | **Required when suspending** |

### Example request

```json
{ "status": "suspended", "reason": "KYC re-check pending" }
```

### Example success `200`

```json
{ "success": true, "data": { "_id": "664agt...", "status": "suspended" }, "message": "Status updated" }
```

---

## PUT `/admin/agents/:agentId/tracking-allow`

**Purpose**: Enable or disable the **tracking-allow** flag. jovi-mall owns this flag; geo-tracker
enforces it — flipping it here revokes/permits live tracking downstream.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `allowed` | boolean | ✅ | `true` permits tracking, `false` disables it |
| `reason` | string | conditionally | **Required when disabling** (`allowed: false`) |

### Example request

```json
{ "allowed": false, "reason": "Privacy complaint under review" }
```

---

## GET `/admin/agents/:agentId/tracking-policy`

**Purpose**: Return the tracking policy geo-tracker would resolve for this agent (what the tracking
service sees). Read-only.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

---

## PUT `/admin/agents/:agentId/kyc`

**Purpose**: Record the KYC verdict for an agent.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

> **This is what lets an agent work.** `kyc.status` starts at `unverified` and assignment
> eligibility passes only on `verified` — so until an admin calls this, every offer the agent tries
> to accept fails with `kyc_not_verified`, regardless of availability, capacity or tracking.

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `status` | string | ✅ | one of `unverified`, `pending`, `verified`, `rejected` |
| `reference` | string \| null | ❌ | External provider reference, ≤200 chars — *clearable*. **Omit to leave the stored reference untouched**; send `null`/`""` to clear it |
| `rejectionReason` | string \| null | ❌ | ≤300 chars. **Required when `status` is `rejected`** |

Side effects: `verified_at` and `verified_by_user_id` are stamped only on `verified`;
`rejection_reason` is persisted only on `rejected`; an `agent.kyc_status_changed` event is emitted.

### Example request

```json
{ "status": "verified", "reference": "SUMSUB-8891" }
```

### Example success `200`

```json
{
  "success": true,
  "data": {
    "agentId": "664agt...",
    "kyc": {
      "status": "verified",
      "verified_at": "2026-07-29T10:00:00.000Z",
      "verified_by_user_id": "664usr...",
      "rejection_reason": null,
      "reference": "SUMSUB-8891"
    }
  },
  "message": "KYC set to verified."
}
```

---

## PUT `/admin/agents/:agentId/ban`

**Purpose**: Ban or unban an agent platform-wide.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `banned` | boolean | ✅ | — |
| `reason` | string \| null | ❌ | ≤300 chars. **Required when `banned` is `true`** |

> **A ban is an override, not a cascade.** It does not walk the agent's contracts flipping each to
> paused — that would be lossy, since un-banning could not know which were already paused. Every
> gate consults the flag instead, so one field suppresses every agency at once and lifting it
> restores exactly the prior state.
>
> The subtle consequence: an agency **can** still `reactivate` a contract while the ban is set, and
> the contract will read `active` — but the agent stays unusable because every gate still refuses.
> That is intended: the contract describes the agency relationship, the ban describes the
> platform's.

### Example request

```json
{ "banned": true, "reason": "Confirmed cash theft — case #4471" }
```

---

## PUT `/admin/agents/:agentId/cod-threshold`

**Purpose**: Set the agent's **whole COD pool** — the most cash they may carry across every agency.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `maxThreshold` | integer | ✅ | 0 – 5,000,000 (minor units) |

> Bounded differently from a **contract's** threshold (`PATCH /agency/agents/:membershipId/cod-limit`,
> 0 – 1,000,000). This is the pool; that is a slice of it. Lowering below what contracts already
> hold is refused rather than silently over-committing them.
>
> The pool defaults to `0`, so a new agent can carry no COD at all until this is set.

### Example success `200`

Returns the same shape as `GET /admin/agents/:agentId/cod-allocation`.

### Errors specific to this endpoint

| `error.code` | Status | When |
|---|---|---|
| `AGENT_COD_THRESHOLD_OUT_OF_BOUNDS` | 422 | Outside 0–5,000,000. `details: { requested, min, max }` |
| `AGENT_COD_THRESHOLD_BELOW_ALLOCATED` | 422 | Below the sum of the contracts' slices. `details: { requested, currentlyAllocated, shortfall, contracts[] }` — lower those first |

---

## GET `/admin/agents/:agentId/cod-allocation`

**Purpose**: The agent's pool, each contract's slice of it, and the unallocated headroom. The view
to consult before changing either level.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Example success `200`

```json
{
  "success": true,
  "data": {
    "agentId": "664agt...",
    "maxThreshold": 500000,
    "allocated": 350000,
    "headroom": 150000,
    "contracts": [
      {
        "contractId": "664ctr...",
        "agencyId": "664agc...",
        "status": "active",
        "threshold": 200000,
        "outstandingBalance": 45000
      }
    ]
  }
}
```

---

## GET `/admin/agents/:agentId/history`

**Purpose**: Return the agent's append-only membership/lifecycle history.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

---

## GET `/admin/agents/:agentId/eligibility`

**Purpose**: Evaluate whether the agent is eligible for assignment **for a given agency**, reporting
**every** failed rule at once (not banned · KYC verified · account active · holds an **active
contract** with the dispatching agency · online · tracking allowed · device location not disabled ·
under capacity).

> The rule is named `approved` and its failure reason `membership_not_approved`, but it passes only
> on an `active` contract — `observed.contractStatus` reports what was actually seen. Both names
> predate the `approved` → `active` status rename and are kept because they are part of the wire
> contract. See [agency/agent-roster.md](../agency/agent-roster.md#get-apiagencyagentsagentideligibility).

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Query parameters

| Param | Type | Required | Notes |
|---|---|---|---|
| `agencyId` | string (ObjectId) | ✅ | The dispatching agency to evaluate against |

### Example success `200` (representative shape)

```json
{
  "success": true,
  "data": {
    "eligible": false,
    "failedRules": ["tracking_not_allowed", "over_capacity"]
  }
}
```

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing/invalid body or query (e.g. `reason` required to suspend/disable) |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Non-admin caller |
| `NOT_FOUND` | 404 | Agent / agency / membership not found |

## Related

- [../agency/agent-roster.md](../agency/agent-roster.md) — agency-side roster management
- [../agent/agency-membership.md](../agent/agency-membership.md) · [../agent/availability-and-device.md](../agent/availability-and-device.md)
- [../tracking/agent-tracking-policy.md](../tracking/agent-tracking-policy.md)

> **Refactor in flight.** A shared-pool COD / contract-status refactor is part-applied in the agent
> domain. The admin surfaces it needed — KYC/ban, the agent COD pool and its allocation view — are
> now mounted and documented above; contract terms, settlements and the status-request inbox landed
> on the **agency** side ([../agency/agent-roster.md](../agency/agent-roster.md)). Still outstanding:
> the trust-composite engine and the collection-rename migration. See `../../AGENT-CONTRACT-REFACTOR.md`.

---

## There is no admin write path to contract terms

Deliberate, and worth stating because its absence looks like an omission.

The terms of an agent↔agency contract — fee split, remittance cadence, coverage, value ceiling — are
**negotiated between the two parties**. An admin endpoint that overwrote them would let the platform
change what an agent is paid without either signatory agreeing, which is the exact thing the
negotiation exists to prevent. Admin sees the terms (above) and the history, and acts through the
levers it legitimately owns:

| To affect… | Admin uses | Not |
|---|---|---|
| whether the agent can work at all | `PATCH /status`, `PUT /ban`, `PUT /kyc` | editing contracts |
| the agent's total cash risk | `PUT /cod-threshold` (the **pool**) | a contract's slice |
| which agency an agent belongs to | `POST /admin/agents/transfer` | approving contracts for them |

### Transfers carry the terms across

`POST /admin/agents/transfer` is the one admin action that creates a contract, and it lands the
destination **`active`** — it does not pass through the handshake, so neither party approves it and
the terms guard on `approve` never runs.

For that reason the transfer **copies the source contract's negotiated terms verbatim**: fee split,
remittance cadence and grace, coverage, value ceiling and employment, alongside the COD slice and
primary standing it already carried. The destination contract reads `termsProposedBy: "agency"` and a
non-zero `termsVersion`.

> **Why this is not cosmetic.** Before it, a transferred agent arrived on
> `contractDefaults.feeSplit()` — a `percentage` model with a **null** share, which the earnings
> split resolves to a cut of **zero**. Because the contract is created `active`, nothing in the
> approval path could catch it, and the agent would have worked the new agency's deliveries for
> nothing until someone noticed the balance. Covered by `contractTermsOf` in
> `npm run test:agent-domain`.

The destination agency is not stuck with the inherited terms — they are a live contract's terms like
any other, so the agency proposes a change and the agent answers.

If a contract genuinely needs terms an admin considers wrong, the route is operational: contact the
agency, who proposes; the agent answers. Nothing bypasses that.
